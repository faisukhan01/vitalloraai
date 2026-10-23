"""Audit trail endpoint (paginated, filterable).

Permission matrix: read -> audit:read.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Query

from app.api.v1._util import json_loads_or_none, pagination, parse_date
from app.core.deps import Principal, require_permission
from app.core.errors import ValidationFailed
from app.db.client import db
from app.schemas.audit import AuditEventOut, AuditListResponse

router = APIRouter(prefix="/audit", tags=["audit"])


def _to_out(row: dict) -> AuditEventOut:
    return AuditEventOut(
        id=row["id"],
        organization_id=row["organization_id"],
        actor_user_id=row["actor_user_id"],
        actor_type=row["actor_type"],
        actor_display=row["actor_display"],
        action=row["action"],
        entity_type=row["entity_type"],
        entity_id=row["entity_id"],
        details=json_loads_or_none(row["details"]) if isinstance(row["details"], str) else row["details"],
        created_at=row["created_at"],
    )


@router.get("", response_model=AuditListResponse)
async def list_audit_events(
    principal: Principal = Depends(require_permission("audit:read")),
    action: str | None = Query(default=None, max_length=100),
    from_str: str | None = Query(default=None, alias="from"),
    to_str: str | None = Query(default=None, alias="to"),
    pg: tuple[int, int] = Depends(pagination),
) -> AuditListResponse:
    page, page_size = pg
    conds = ["organization_id = ?"]
    params: list = [principal.organization_id]
    if action:
        conds.append("action = ?")
        params.append(action)
    from_date = parse_date(from_str, "from") if from_str else None
    to_date = parse_date(to_str, "to") if to_str else None
    if from_date and to_date and from_date > to_date:
        raise ValidationFailed("'from' date must not be after 'to' date.")
    if from_date:
        conds.append("created_at >= ?")
        params.append(from_date.isoformat())
    if to_date:
        conds.append("created_at < ?")
        params.append((to_date + timedelta(days=1)).isoformat())

    where = " AND ".join(conds)  # static condition strings only; user data is in params
    total = await db.one(f"SELECT COUNT(*) AS n FROM audit_events WHERE {where}", tuple(params))
    rows = await db.execute(
        f"SELECT * FROM audit_events WHERE {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        tuple(params + [page_size, (page - 1) * page_size]),
    )
    return AuditListResponse(
        items=[_to_out(r) for r in rows], total=total["n"] if total else 0, page=page, page_size=page_size
    )
