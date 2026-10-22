"""Clinic management endpoints (CRUD + weekly hours).

Permission matrix: read -> clinics:read, write -> clinics:write.
Every query is org-scoped by the authenticated principal's organization_id.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status

from app.api.v1._util import (
    pagination,
    parse_hhmm,
    resolve_timezone,
    slugify,
    write_audit,
)
from app.core.deps import Principal, require_permission
from app.core.errors import ConflictError, NotFound, ValidationFailed
from app.core.security import new_id, utc_now_iso
from app.db.client import db
from app.schemas.clinics import (
    ClinicCreate,
    ClinicHoursOut,
    ClinicHoursUpdate,
    ClinicListResponse,
    ClinicOut,
    ClinicUpdate,
)

router = APIRouter(prefix="/clinics", tags=["clinics"])

# Same defaults as the demo seed: Mon-Fri 09:00-17:00, Sat 10:00-14:00, Sun closed.
DEFAULT_HOURS: tuple[tuple[int, str, str, int], ...] = (
    (0, "09:00", "17:00", 0),
    (1, "09:00", "17:00", 0),
    (2, "09:00", "17:00", 0),
    (3, "09:00", "17:00", 0),
    (4, "09:00", "17:00", 0),
    (5, "10:00", "14:00", 0),
    (6, "00:00", "00:00", 1),
)

_UPDATABLE_COLUMNS = ("name", "timezone", "address", "phone", "email", "status")


def _to_out(row: dict) -> ClinicOut:
    return ClinicOut(
        id=row["id"],
        organization_id=row["organization_id"],
        name=row["name"],
        slug=row["slug"],
        timezone=row["timezone"],
        address=row["address"],
        phone=row["phone"],
        email=row["email"],
        status=row["status"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _hours_rows_out(rows: list[dict]) -> list[ClinicHoursOut]:
    return [
        ClinicHoursOut(
            id=r["id"],
            organization_id=r["organization_id"],
            clinic_id=r["clinic_id"],
            day_of_week=r["day_of_week"],
            open_time=r["open_time"],
            close_time=r["close_time"],
            is_closed=bool(r["is_closed"]),
        )
        for r in rows
    ]


async def _get_clinic_or_404(clinic_id: str, org_id: str) -> dict:
    row = await db.one(
        "SELECT * FROM clinics WHERE id = ? AND organization_id = ?",
        (clinic_id, org_id),
    )
    if row is None:
        raise NotFound("Clinic not found.")
    return row


@router.get("", response_model=ClinicListResponse)
async def list_clinics(
    principal: Principal = Depends(require_permission("clinics:read")),
    pg: tuple[int, int] = Depends(pagination),
) -> ClinicListResponse:
    page, page_size = pg
    total = await db.one(
        "SELECT COUNT(*) AS n FROM clinics WHERE organization_id = ?",
        (principal.organization_id,),
    )
    rows = await db.execute(
        "SELECT * FROM clinics WHERE organization_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
        (principal.organization_id, page_size, (page - 1) * page_size),
    )
    return ClinicListResponse(
        items=[_to_out(r) for r in rows], total=total["n"] if total else 0, page=page, page_size=page_size
    )


@router.post("", response_model=ClinicOut, status_code=status.HTTP_201_CREATED)
async def create_clinic(
    payload: ClinicCreate,
    principal: Principal = Depends(require_permission("clinics:write")),
) -> ClinicOut:
    resolve_timezone(payload.timezone)
    slug = slugify(payload.slug or payload.name)
    existing = await db.one(
        "SELECT id FROM clinics WHERE organization_id = ? AND slug = ?",
        (principal.organization_id, slug),
    )
    if existing:
        raise ConflictError("A clinic with this identifier already exists in your organization.")

    clinic_id = new_id()
    now = utc_now_iso()
    try:
        async with db.transaction() as tx:
            await tx.execute(
                "INSERT INTO clinics (id, organization_id, name, slug, timezone, address, phone, email, status, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    clinic_id,
                    principal.organization_id,
                    payload.name.strip(),
                    slug,
                    payload.timezone,
                    payload.address,
                    payload.phone,
                    payload.email,
                    payload.status,
                    now,
                    now,
                ),
            )
            for day, open_t, close_t, closed in DEFAULT_HOURS:
                await tx.execute(
                    "INSERT INTO clinic_hours (id, organization_id, clinic_id, day_of_week, open_time, close_time, is_closed) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (new_id(), principal.organization_id, clinic_id, day, open_t, close_t, closed),
                )
    except Exception as exc:
        if "UNIQUE constraint failed" in str(exc):
            raise ConflictError("A clinic with this identifier already exists in your organization.") from exc
        raise
    await write_audit(
        principal,
        "clinic_created",
        entity_type="clinic",
        entity_id=clinic_id,
        details={"name": payload.name.strip(), "slug": slug, "timezone": payload.timezone},
    )
    return ClinicOut(
        id=clinic_id,
        organization_id=principal.organization_id,
        name=payload.name.strip(),
        slug=slug,
        timezone=payload.timezone,
        address=payload.address,
        phone=payload.phone,
        email=payload.email,
        status=payload.status,
        created_at=now,
        updated_at=now,
    )


@router.get("/{clinic_id}", response_model=ClinicOut)
async def get_clinic(
    clinic_id: str,
    principal: Principal = Depends(require_permission("clinics:read")),
) -> ClinicOut:
    return _to_out(await _get_clinic_or_404(clinic_id, principal.organization_id))


@router.patch("/{clinic_id}", response_model=ClinicOut)
async def update_clinic(
    clinic_id: str,
    payload: ClinicUpdate,
    principal: Principal = Depends(require_permission("clinics:write")),
) -> ClinicOut:
    row = await _get_clinic_or_404(clinic_id, principal.organization_id)
    if payload.timezone is not None:
        resolve_timezone(payload.timezone)
    provided = payload.model_dump(exclude_unset=True)
    updates: list[str] = []
    params: list = []
    for field in _UPDATABLE_COLUMNS:  # column names come from this static whitelist only
        if field in provided:
            value = provided[field]
            updates.append(f"{field} = ?")
            params.append(value.strip() if isinstance(value, str) else value)
    if not updates:
        return _to_out(row)
    now = utc_now_iso()
    updates.append("updated_at = ?")
    params.extend([now, clinic_id, principal.organization_id])
    await db.write(
        f"UPDATE clinics SET {', '.join(updates)} WHERE id = ? AND organization_id = ?",
        tuple(params),
    )
    merged = dict(row)
    merged.update(provided)
    merged["updated_at"] = now
    await write_audit(
        principal,
        "clinic_updated",
        entity_type="clinic",
        entity_id=clinic_id,
        details=provided,
    )
    return _to_out(merged)


@router.delete("/{clinic_id}")
async def delete_clinic(
    clinic_id: str,
    principal: Principal = Depends(require_permission("clinics:write")),
) -> dict:
    row = await _get_clinic_or_404(clinic_id, principal.organization_id)
    org_id = principal.organization_id
    counts = await db.one(
        "SELECT "
        "(SELECT COUNT(*) FROM providers WHERE clinic_id = ? AND organization_id = ?) AS providers, "
        "(SELECT COUNT(*) FROM services WHERE clinic_id = ? AND organization_id = ?) AS services, "
        "(SELECT COUNT(*) FROM receptionists WHERE clinic_id = ? AND organization_id = ?) AS receptionists, "
        "(SELECT COUNT(*) FROM appointments WHERE clinic_id = ? AND organization_id = ?) AS appointments",
        (clinic_id, org_id, clinic_id, org_id, clinic_id, org_id, clinic_id, org_id),
    )
    if counts and any(counts[k] for k in ("providers", "services", "receptionists", "appointments")):
        raise ConflictError(
            "This clinic still has providers, services, receptionists or appointments. "
            "Remove or reassign them before deleting the clinic."
        )
    async with db.transaction() as tx:
        await tx.execute(
            "DELETE FROM clinic_hours WHERE clinic_id = ? AND organization_id = ?",
            (clinic_id, org_id),
        )
        await tx.execute(
            "DELETE FROM schedule_exceptions WHERE clinic_id = ? AND organization_id = ?",
            (clinic_id, org_id),
        )
        await tx.execute(
            "DELETE FROM clinics WHERE id = ? AND organization_id = ?",
            (clinic_id, org_id),
        )
    await write_audit(
        principal, "clinic_deleted", entity_type="clinic", entity_id=clinic_id, details={"name": row["name"]}
    )
    return {"message": "Clinic deleted."}


@router.get("/{clinic_id}/hours", response_model=list[ClinicHoursOut])
async def get_clinic_hours(
    clinic_id: str,
    principal: Principal = Depends(require_permission("clinics:read")),
) -> list[ClinicHoursOut]:
    """Weekly hours as a plain array (shared-types ClinicHours[] contract)."""
    await _get_clinic_or_404(clinic_id, principal.organization_id)
    rows = await db.execute(
        "SELECT * FROM clinic_hours WHERE clinic_id = ? AND organization_id = ? ORDER BY day_of_week ASC",
        (clinic_id, principal.organization_id),
    )
    return _hours_rows_out(rows)


@router.put("/{clinic_id}/hours", response_model=list[ClinicHoursOut])
async def set_clinic_hours(
    clinic_id: str,
    payload: ClinicHoursUpdate,
    principal: Principal = Depends(require_permission("clinics:write")),
) -> list[ClinicHoursOut]:
    await _get_clinic_or_404(clinic_id, principal.organization_id)
    seen_days: set[int] = set()
    for day in payload.days:
        if day.day_of_week in seen_days:
            raise ValidationFailed(f"Duplicate entry for day_of_week {day.day_of_week}.")
        seen_days.add(day.day_of_week)
        if not day.is_closed:
            parse_hhmm(day.open_time, "open_time")
            parse_hhmm(day.close_time, "close_time")
    async with db.transaction() as tx:
        await tx.execute(
            "DELETE FROM clinic_hours WHERE clinic_id = ? AND organization_id = ?",
            (clinic_id, principal.organization_id),
        )
        for day in payload.days:
            await tx.execute(
                "INSERT INTO clinic_hours (id, organization_id, clinic_id, day_of_week, open_time, close_time, is_closed) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    new_id(),
                    principal.organization_id,
                    clinic_id,
                    day.day_of_week,
                    day.open_time,
                    day.close_time,
                    1 if day.is_closed else 0,
                ),
            )
    await write_audit(principal, "clinic_hours_updated", entity_type="clinic", entity_id=clinic_id)
    rows = await db.execute(
        "SELECT * FROM clinic_hours WHERE clinic_id = ? AND organization_id = ? ORDER BY day_of_week ASC",
        (clinic_id, principal.organization_id),
    )
    return _hours_rows_out(rows)
