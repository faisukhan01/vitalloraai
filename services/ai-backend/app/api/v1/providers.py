"""Provider (clinical staff) endpoints: CRUD + time off.

Permission matrix: read -> staff:read, write -> staff:write (provider records
are the "staff" resource in app/core/permissions.py; time off is therefore
limited to org-admin-level roles, as intended by the matrix).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status

from app.api.v1._util import pagination, parse_datetime, utc_iso, write_audit
from app.core.deps import Principal, require_permission
from app.core.errors import ConflictError, NotFound, ValidationFailed
from app.core.security import new_id, utc_now_iso
from app.db.client import db
from app.schemas.providers import (
    ProviderCreate,
    ProviderListResponse,
    ProviderOut,
    ProviderUpdate,
    TimeOffCreate,
    TimeOffListResponse,
    TimeOffOut,
)

router = APIRouter(prefix="/providers", tags=["providers"])

_UPDATABLE_COLUMNS = ("name", "specialty", "email", "phone", "status")


def _to_out(row: dict) -> ProviderOut:
    return ProviderOut(
        id=row["id"],
        organization_id=row["organization_id"],
        clinic_id=row["clinic_id"],
        clinic_name=row.get("clinic_name"),
        name=row["name"],
        specialty=row["specialty"],
        email=row["email"],
        phone=row["phone"],
        status=row["status"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def _get_provider_or_404(provider_id: str, org_id: str) -> dict:
    row = await db.one(
        "SELECT * FROM providers WHERE id = ? AND organization_id = ?",
        (provider_id, org_id),
    )
    if row is None:
        raise NotFound("Provider not found.")
    return row


async def _get_clinic_or_404(clinic_id: str, org_id: str) -> dict:
    row = await db.one(
        "SELECT id FROM clinics WHERE id = ? AND organization_id = ?",
        (clinic_id, org_id),
    )
    if row is None:
        raise NotFound("Clinic not found.")
    return row


@router.get("", response_model=ProviderListResponse)
async def list_providers(
    principal: Principal = Depends(require_permission("staff:read")),
    clinic_id: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    pg: tuple[int, int] = Depends(pagination),
) -> ProviderListResponse:
    page, page_size = pg
    conds = ["p.organization_id = ?"]
    params: list = [principal.organization_id]
    if clinic_id:
        conds.append("p.clinic_id = ?")
        params.append(clinic_id)
    if status_filter:
        if status_filter not in ("active", "inactive"):
            raise ValidationFailed("status must be 'active' or 'inactive'.")
        conds.append("p.status = ?")
        params.append(status_filter)
    where = " AND ".join(conds)  # static condition strings only; user data is in params
    total = await db.one(f"SELECT COUNT(*) AS n FROM providers p WHERE {where}", tuple(params))
    rows = await db.execute(
        "SELECT p.*, c.name AS clinic_name FROM providers p JOIN clinics c ON c.id = p.clinic_id "
        f"WHERE {where} ORDER BY p.name ASC, p.id ASC LIMIT ? OFFSET ?",
        tuple(params + [page_size, (page - 1) * page_size]),
    )
    return ProviderListResponse(
        items=[_to_out(r) for r in rows], total=total["n"] if total else 0, page=page, page_size=page_size
    )


@router.post("", response_model=ProviderOut, status_code=status.HTTP_201_CREATED)
async def create_provider(
    payload: ProviderCreate,
    principal: Principal = Depends(require_permission("staff:write")),
) -> ProviderOut:
    clinic = await _get_clinic_or_404(payload.clinic_id, principal.organization_id)
    provider_id = new_id()
    now = utc_now_iso()
    await db.write(
        "INSERT INTO providers (id, organization_id, clinic_id, name, specialty, email, phone, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            provider_id,
            principal.organization_id,
            clinic["id"],
            payload.name.strip(),
            payload.specialty,
            payload.email,
            payload.phone,
            payload.status,
            now,
            now,
        ),
    )
    await write_audit(
        principal,
        "provider_created",
        entity_type="provider",
        entity_id=provider_id,
        details={"name": payload.name.strip(), "clinic_id": clinic["id"]},
    )
    return ProviderOut(
        id=provider_id,
        organization_id=principal.organization_id,
        clinic_id=clinic["id"],
        name=payload.name.strip(),
        specialty=payload.specialty,
        email=payload.email,
        phone=payload.phone,
        status=payload.status,
        created_at=now,
        updated_at=now,
    )


@router.get("/{provider_id}", response_model=ProviderOut)
async def get_provider(
    provider_id: str,
    principal: Principal = Depends(require_permission("staff:read")),
) -> ProviderOut:
    row = await db.one(
        "SELECT p.*, c.name AS clinic_name FROM providers p JOIN clinics c ON c.id = p.clinic_id "
        "WHERE p.id = ? AND p.organization_id = ?",
        (provider_id, principal.organization_id),
    )
    if row is None:
        raise NotFound("Provider not found.")
    return _to_out(row)


@router.patch("/{provider_id}", response_model=ProviderOut)
async def update_provider(
    provider_id: str,
    payload: ProviderUpdate,
    principal: Principal = Depends(require_permission("staff:write")),
) -> ProviderOut:
    row = await _get_provider_or_404(provider_id, principal.organization_id)
    provided = payload.model_dump(exclude_unset=True)
    updates: list[str] = []
    params: list = []
    for field in _UPDATABLE_COLUMNS:  # static whitelist
        if field in provided:
            value = provided[field]
            updates.append(f"{field} = ?")
            params.append(value.strip() if isinstance(value, str) else value)
    if not updates:
        return _to_out(row)
    now = utc_now_iso()
    updates.append("updated_at = ?")
    params.extend([now, provider_id, principal.organization_id])
    await db.write(
        f"UPDATE providers SET {', '.join(updates)} WHERE id = ? AND organization_id = ?",
        tuple(params),
    )
    merged = dict(row)
    merged.update(provided)
    merged["updated_at"] = now
    await write_audit(
        principal, "provider_updated", entity_type="provider", entity_id=provider_id, details=provided
    )
    return _to_out(merged)


@router.delete("/{provider_id}")
async def delete_provider(
    provider_id: str,
    principal: Principal = Depends(require_permission("staff:write")),
) -> dict:
    row = await _get_provider_or_404(provider_id, principal.organization_id)
    appt = await db.one(
        "SELECT COUNT(*) AS n FROM appointments WHERE provider_id = ? AND organization_id = ?",
        (provider_id, principal.organization_id),
    )
    if appt and appt["n"]:
        raise ConflictError(
            "This provider has appointment history. Deactivate the provider instead of deleting to preserve records."
        )
    async with db.transaction() as tx:
        await tx.execute(
            "DELETE FROM provider_time_off WHERE provider_id = ? AND organization_id = ?",
            (provider_id, principal.organization_id),
        )
        await tx.execute(
            "DELETE FROM providers WHERE id = ? AND organization_id = ?",
            (provider_id, principal.organization_id),
        )
    await write_audit(
        principal,
        "provider_deleted",
        entity_type="provider",
        entity_id=provider_id,
        details={"name": row["name"]},
    )
    return {"message": "Provider deleted."}


@router.post("/{provider_id}/time-off", response_model=TimeOffOut, status_code=status.HTTP_201_CREATED)
async def add_time_off(
    provider_id: str,
    payload: TimeOffCreate,
    principal: Principal = Depends(require_permission("staff:write")),
) -> TimeOffOut:
    await _get_provider_or_404(provider_id, principal.organization_id)
    start = parse_datetime(payload.starts_at, "starts_at")
    end = parse_datetime(payload.ends_at, "ends_at")
    if end <= start:
        raise ValidationFailed("ends_at must be after starts_at.")
    entry_id = new_id()
    await db.write(
        "INSERT INTO provider_time_off (id, organization_id, provider_id, starts_at, ends_at, reason) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            entry_id,
            principal.organization_id,
            provider_id,
            utc_iso(start),
            utc_iso(end),
            payload.reason,
        ),
    )
    await write_audit(
        principal,
        "provider_time_off_added",
        entity_type="provider",
        entity_id=provider_id,
        details={"time_off_id": entry_id, "starts_at": utc_iso(start), "ends_at": utc_iso(end)},
    )
    return TimeOffOut(id=entry_id, provider_id=provider_id, starts_at=utc_iso(start), ends_at=utc_iso(end), reason=payload.reason)


@router.get("/{provider_id}/time-off", response_model=TimeOffListResponse)
async def list_time_off(
    provider_id: str,
    principal: Principal = Depends(require_permission("staff:read")),
) -> TimeOffListResponse:
    await _get_provider_or_404(provider_id, principal.organization_id)
    rows = await db.execute(
        "SELECT id, provider_id, starts_at, ends_at, reason FROM provider_time_off "
        "WHERE provider_id = ? AND organization_id = ? ORDER BY starts_at ASC",
        (provider_id, principal.organization_id),
    )
    return TimeOffListResponse(items=[TimeOffOut(**r) for r in rows])
