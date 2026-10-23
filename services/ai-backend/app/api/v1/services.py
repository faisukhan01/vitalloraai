"""Bookable service endpoints.

Permission matrix: read -> clinics:read, write -> clinics:write (the RBAC
matrix has no dedicated services permission; services are clinic resources).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status

from app.api.v1._util import pagination, write_audit
from app.core.deps import Principal, require_permission
from app.core.errors import ConflictError, NotFound
from app.core.security import new_id, utc_now_iso
from app.db.client import db
from app.schemas.services import (
    ServiceCreate,
    ServiceListResponse,
    ServiceOut,
    ServiceUpdate,
)

router = APIRouter(prefix="/services", tags=["services"])

_UPDATABLE_COLUMNS = ("name", "description", "duration_minutes", "price_display", "is_active")


def _to_out(row: dict) -> ServiceOut:
    return ServiceOut(
        id=row["id"],
        organization_id=row["organization_id"],
        clinic_id=row["clinic_id"],
        clinic_name=row.get("clinic_name"),
        name=row["name"],
        description=row["description"],
        duration_minutes=row["duration_minutes"],
        price_display=row["price_display"],
        is_active=bool(row["is_active"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def _get_service_or_404(service_id: str, org_id: str) -> dict:
    row = await db.one(
        "SELECT * FROM services WHERE id = ? AND organization_id = ?",
        (service_id, org_id),
    )
    if row is None:
        raise NotFound("Service not found.")
    return row


async def _get_clinic_or_404(clinic_id: str, org_id: str) -> dict:
    row = await db.one(
        "SELECT id FROM clinics WHERE id = ? AND organization_id = ?",
        (clinic_id, org_id),
    )
    if row is None:
        raise NotFound("Clinic not found.")
    return row


@router.get("", response_model=ServiceListResponse)
async def list_services(
    principal: Principal = Depends(require_permission("clinics:read")),
    clinic_id: str | None = None,
    active: bool | None = Query(default=None),
    pg: tuple[int, int] = Depends(pagination),
) -> ServiceListResponse:
    page, page_size = pg
    conds = ["s.organization_id = ?"]
    params: list = [principal.organization_id]
    if clinic_id:
        conds.append("s.clinic_id = ?")
        params.append(clinic_id)
    if active is not None:
        conds.append("s.is_active = ?")
        params.append(1 if active else 0)
    where = " AND ".join(conds)  # static condition strings only; user data is in params
    total = await db.one(f"SELECT COUNT(*) AS n FROM services s WHERE {where}", tuple(params))
    rows = await db.execute(
        "SELECT s.*, c.name AS clinic_name FROM services s JOIN clinics c ON c.id = s.clinic_id "
        f"WHERE {where} ORDER BY s.created_at ASC, s.id ASC LIMIT ? OFFSET ?",
        tuple(params + [page_size, (page - 1) * page_size]),
    )
    return ServiceListResponse(
        items=[_to_out(r) for r in rows], total=total["n"] if total else 0, page=page, page_size=page_size
    )


@router.post("", response_model=ServiceOut, status_code=status.HTTP_201_CREATED)
async def create_service(
    payload: ServiceCreate,
    principal: Principal = Depends(require_permission("clinics:write")),
) -> ServiceOut:
    clinic = await _get_clinic_or_404(payload.clinic_id, principal.organization_id)
    service_id = new_id()
    now = utc_now_iso()
    await db.write(
        "INSERT INTO services (id, organization_id, clinic_id, name, description, duration_minutes, price_display, is_active, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            service_id,
            principal.organization_id,
            clinic["id"],
            payload.name.strip(),
            payload.description,
            payload.duration_minutes,
            payload.price_display,
            1 if payload.is_active else 0,
            now,
            now,
        ),
    )
    await write_audit(
        principal,
        "service_created",
        entity_type="service",
        entity_id=service_id,
        details={"name": payload.name.strip(), "clinic_id": clinic["id"]},
    )
    return ServiceOut(
        id=service_id,
        organization_id=principal.organization_id,
        clinic_id=clinic["id"],
        name=payload.name.strip(),
        description=payload.description,
        duration_minutes=payload.duration_minutes,
        price_display=payload.price_display,
        is_active=payload.is_active,
        created_at=now,
        updated_at=now,
    )


@router.get("/{service_id}", response_model=ServiceOut)
async def get_service(
    service_id: str,
    principal: Principal = Depends(require_permission("clinics:read")),
) -> ServiceOut:
    row = await db.one(
        "SELECT s.*, c.name AS clinic_name FROM services s JOIN clinics c ON c.id = s.clinic_id "
        "WHERE s.id = ? AND s.organization_id = ?",
        (service_id, principal.organization_id),
    )
    if row is None:
        raise NotFound("Service not found.")
    return _to_out(row)


@router.patch("/{service_id}", response_model=ServiceOut)
async def update_service(
    service_id: str,
    payload: ServiceUpdate,
    principal: Principal = Depends(require_permission("clinics:write")),
) -> ServiceOut:
    row = await _get_service_or_404(service_id, principal.organization_id)
    provided = payload.model_dump(exclude_unset=True)
    updates: list[str] = []
    params: list = []
    for field in _UPDATABLE_COLUMNS:  # static whitelist
        if field in provided:
            value = provided[field]
            updates.append(f"{field} = ?")
            params.append((value.strip() if isinstance(value, str) else value) if field != "is_active" else (1 if value else 0))
    if not updates:
        return _to_out(row)
    now = utc_now_iso()
    updates.append("updated_at = ?")
    params.extend([now, service_id, principal.organization_id])
    await db.write(
        f"UPDATE services SET {', '.join(updates)} WHERE id = ? AND organization_id = ?",
        tuple(params),
    )
    merged = dict(row)
    merged.update(provided)
    merged["updated_at"] = now
    await write_audit(
        principal, "service_updated", entity_type="service", entity_id=service_id, details=provided
    )
    return _to_out(merged)


@router.delete("/{service_id}")
async def delete_service(
    service_id: str,
    principal: Principal = Depends(require_permission("clinics:write")),
) -> dict:
    row = await _get_service_or_404(service_id, principal.organization_id)
    appt = await db.one(
        "SELECT COUNT(*) AS n FROM appointments WHERE service_id = ? AND organization_id = ?",
        (service_id, principal.organization_id),
    )
    if appt and appt["n"]:
        raise ConflictError(
            "This service has appointment history. Set it inactive instead of deleting to preserve records."
        )
    await db.write(
        "DELETE FROM services WHERE id = ? AND organization_id = ?",
        (service_id, principal.organization_id),
    )
    await write_audit(
        principal,
        "service_deleted",
        entity_type="service",
        entity_id=service_id,
        details={"name": row["name"]},
    )
    return {"message": "Service deleted."}
