"""Callback request endpoints: list + status transitions.

Transitions (spec): open -> assigned -> completed | cancelled.
Permission matrix: read -> callbacks:read, write -> callbacks:write.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.v1._util import pagination, write_audit
from app.core.deps import Principal, require_permission
from app.core.errors import ConflictError, NotFound, ValidationFailed
from app.core.security import utc_now_iso
from app.db.client import db
from app.schemas.callbacks import (
    CallbackListResponse,
    CallbackOut,
    CallbackStatusUpdate,
)

router = APIRouter(prefix="/callbacks", tags=["callbacks"])

_STATUSES = ("open", "assigned", "completed", "cancelled")
_TRANSITIONS: dict[str, set[str]] = {
    "open": {"assigned"},
    "assigned": {"completed", "cancelled"},
}


def _to_out(row: dict) -> CallbackOut:
    return CallbackOut(
        id=row["id"],
        organization_id=row["organization_id"],
        clinic_id=row["clinic_id"],
        session_id=row["session_id"],
        patient_name=row["patient_name"],
        patient_phone=row["patient_phone"],
        reason=row["reason"],
        priority=row["priority"],
        status=row["status"],
        created_at=row["created_at"],
        completed_at=row["completed_at"],
    )


async def _get_callback_or_404(callback_id: str, org_id: str) -> dict:
    row = await db.one(
        "SELECT * FROM callback_requests WHERE id = ? AND organization_id = ?",
        (callback_id, org_id),
    )
    if row is None:
        raise NotFound("Callback request not found.")
    return row


@router.get("", response_model=CallbackListResponse)
async def list_callbacks(
    principal: Principal = Depends(require_permission("callbacks:read")),
    status_filter: str | None = Query(default=None, alias="status"),
    pg: tuple[int, int] = Depends(pagination),
) -> CallbackListResponse:
    page, page_size = pg
    conds = ["organization_id = ?"]
    params: list = [principal.organization_id]
    if status_filter:
        if status_filter not in _STATUSES:
            raise ValidationFailed(f"status must be one of: {', '.join(_STATUSES)}.")
        conds.append("status = ?")
        params.append(status_filter)
    where = " AND ".join(conds)  # static condition strings only; user data is in params
    total = await db.one(f"SELECT COUNT(*) AS n FROM callback_requests WHERE {where}", tuple(params))
    rows = await db.execute(
        f"SELECT * FROM callback_requests WHERE {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        tuple(params + [page_size, (page - 1) * page_size]),
    )
    return CallbackListResponse(
        items=[_to_out(r) for r in rows], total=total["n"] if total else 0, page=page, page_size=page_size
    )


@router.patch("/{callback_id}", response_model=CallbackOut)
async def update_callback_status(
    callback_id: str,
    payload: CallbackStatusUpdate,
    principal: Principal = Depends(require_permission("callbacks:write")),
) -> CallbackOut:
    row = await _get_callback_or_404(callback_id, principal.organization_id)
    new_status = payload.status
    if row["status"] == new_status:
        return _to_out(row)  # idempotent no-op
    allowed = _TRANSITIONS.get(row["status"], set())
    if new_status not in allowed:
        raise ConflictError(
            f"Cannot change callback status from '{row['status']}' to '{new_status}'.",
            details={"allowed_transitions": sorted(allowed)},
        )
    now_iso = utc_now_iso()
    if new_status == "completed":
        await db.write(
            "UPDATE callback_requests SET status = 'completed', completed_at = ? WHERE id = ? AND organization_id = ?",
            (now_iso, callback_id, principal.organization_id),
        )
    else:
        await db.write(
            "UPDATE callback_requests SET status = ? WHERE id = ? AND organization_id = ?",
            (new_status, callback_id, principal.organization_id),
        )
    await write_audit(
        principal,
        "callback_status_changed",
        entity_type="callback_request",
        entity_id=callback_id,
        details={"before": row["status"], "after": new_status},
    )
    merged = dict(row)
    merged.update(status=new_status)
    if new_status == "completed":
        merged["completed_at"] = now_iso
    return _to_out(merged)
