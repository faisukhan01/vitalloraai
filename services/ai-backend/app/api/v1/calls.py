"""Call session read-out endpoints (read-only; the voice pipeline writes sessions).

Permission matrix: read -> calls:read.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Query

from app.api.v1._util import pagination, parse_date
from app.core.deps import Principal, require_permission
from app.core.errors import NotFound, ValidationFailed
from app.db.client import db
from app.schemas.calls import (
    CallSessionListResponse,
    CallSessionOut,
    MessageOut,
    SessionMessagesResponse,
)

router = APIRouter(prefix="/calls", tags=["calls"])

_STATUSES = ("active", "completed", "failed", "escalated")


def _session_out(row: dict) -> CallSessionOut:
    return CallSessionOut(
        id=row["id"],
        organization_id=row["organization_id"],
        clinic_id=row["clinic_id"],
        receptionist_id=row["receptionist_id"],
        receptionist_name=row.get("receptionist_name"),
        channel=row["channel"],
        language=row["language"],
        status=row["status"],
        outcome=row["outcome"],
        end_reason=row["end_reason"],
        started_at=row["started_at"],
        ended_at=row["ended_at"],
        duration_seconds=row["duration_seconds"],
        caller_ref=row["caller_ref"],
        created_at=row["created_at"],
    )


@router.get("/sessions", response_model=CallSessionListResponse)
async def list_sessions(
    principal: Principal = Depends(require_permission("calls:read")),
    status_filter: str | None = Query(default=None, alias="status"),
    language: str | None = None,
    from_str: str | None = Query(default=None, alias="from"),
    to_str: str | None = Query(default=None, alias="to"),
    pg: tuple[int, int] = Depends(pagination),
) -> CallSessionListResponse:
    page, page_size = pg
    conds = ["s.organization_id = ?"]
    params: list = [principal.organization_id]
    if status_filter:
        if status_filter not in _STATUSES:
            raise ValidationFailed(f"status must be one of: {', '.join(_STATUSES)}.")
        conds.append("s.status = ?")
        params.append(status_filter)
    if language:
        conds.append("s.language = ?")
        params.append(language)
    from_date = parse_date(from_str, "from") if from_str else None
    to_date = parse_date(to_str, "to") if to_str else None
    if from_date and to_date and from_date > to_date:
        raise ValidationFailed("'from' date must not be after 'to' date.")
    if from_date:
        conds.append("s.started_at >= ?")
        params.append(from_date.isoformat())
    if to_date:
        conds.append("s.started_at < ?")
        params.append((to_date + timedelta(days=1)).isoformat())
    where = " AND ".join(conds)  # static condition strings only; user data is in params
    total = await db.one(f"SELECT COUNT(*) AS n FROM conversation_sessions s WHERE {where}", tuple(params))
    rows = await db.execute(
        "SELECT s.*, r.name AS receptionist_name FROM conversation_sessions s "
        "LEFT JOIN receptionists r ON r.id = s.receptionist_id "
        f"WHERE {where} ORDER BY s.started_at DESC LIMIT ? OFFSET ?",
        tuple(params + [page_size, (page - 1) * page_size]),
    )
    return CallSessionListResponse(
        items=[_session_out(r) for r in rows], total=total["n"] if total else 0, page=page, page_size=page_size
    )


@router.get("/sessions/{session_id}/messages", response_model=SessionMessagesResponse)
async def get_session_messages(
    session_id: str,
    principal: Principal = Depends(require_permission("calls:read")),
) -> SessionMessagesResponse:
    session = await db.one(
        "SELECT s.*, r.name AS receptionist_name FROM conversation_sessions s "
        "LEFT JOIN receptionists r ON r.id = s.receptionist_id "
        "WHERE s.id = ? AND s.organization_id = ?",
        (session_id, principal.organization_id),
    )
    if session is None:
        raise NotFound("Call session not found.")
    messages = await db.execute(
        "SELECT id, session_id, role, content, tool_name, tool_payload, latency_ms, created_at "
        "FROM conversation_messages WHERE session_id = ? AND organization_id = ? ORDER BY created_at ASC",
        (session_id, principal.organization_id),
    )
    return SessionMessagesResponse(
        session=_session_out(session),
        messages=[MessageOut(**m) for m in messages],
    )
