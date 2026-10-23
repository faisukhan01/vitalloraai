"""Shared helpers for the v1 API routers.

Local to the API layer on purpose: `app/core/*` and `app/db/client.py` are
lead-owned (Task 2) and this agent must not modify them. Everything here is
additive. All SQL is parameterized; user data never reaches the SQL string.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import Query

from app.core.deps import Principal
from app.core.errors import NotFound, ValidationFailed
from app.core.security import new_id, utc_now_iso
from app.db.client import db

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def utc_iso(dt: datetime) -> str:
    """Canonical DB timestamp format: ISO-8601 UTC, millisecond precision, Z."""
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_datetime(value: str, field_name: str) -> datetime:
    """Parse an ISO-8601 datetime; naive values are treated as UTC."""
    try:
        dt = datetime.fromisoformat(value.strip())  # Python 3.11+ parses the trailing 'Z' natively
    except ValueError as exc:
        raise ValidationFailed(
            f"{field_name} must be an ISO-8601 datetime (e.g. 2026-01-15T09:00:00Z)."
        ) from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def parse_date(value: str, field_name: str) -> date:
    try:
        return date.fromisoformat(value.strip())
    except ValueError as exc:
        raise ValidationFailed(f"{field_name} must be an ISO date (YYYY-MM-DD).") from exc


def parse_hhmm(value: str, field_name: str) -> time:
    if not _TIME_RE.match(value.strip()):
        raise ValidationFailed(f"{field_name} must be a 24-hour time in HH:MM format.")
    return time.fromisoformat(value.strip())


def resolve_timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except Exception as exc:  # ZoneInfo errors vary by platform; message is user-safe either way.
        raise ValidationFailed(
            f"Unknown timezone '{name}'. Use an IANA zone name such as Asia/Karachi or UTC."
        ) from exc


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:80] or "item"


def json_loads_or_none(text: Any) -> Any:
    if text is None or text == "":
        return None
    if isinstance(text, (dict, list)):
        return text
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


async def write_audit(
    principal: Principal,
    action: str,
    *,
    entity_type: str | None = None,
    entity_id: str | None = None,
    details: dict | None = None,
    tx: Any = None,  # a _TransactionView from db.transaction(); typed loosely (lead-owned module)
) -> None:
    """Record an audit event attributed to the authenticated user.

    Pass `tx` to include the event in an open transaction (atomic with the
    change it describes); otherwise the event is written on its own.
    """
    sql = (
        "INSERT INTO audit_events (id, organization_id, actor_user_id, actor_type, actor_display, "
        "action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)"
    )
    params = (
        new_id(),
        principal.organization_id,
        principal.user_id,
        principal.email or principal.name or "user",
        action,
        entity_type,
        entity_id,
        json.dumps(details, ensure_ascii=False) if details else None,
        utc_now_iso(),
    )
    if tx is not None:
        await tx.execute(sql, params)
    else:
        await db.write(sql, params)


def pagination(
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
) -> tuple[int, int]:
    """Dependency returning (page, page_size)."""
    return page, page_size


def not_found(message: str) -> NotFound:
    return NotFound(message)
