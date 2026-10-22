"""Audit trail schemas."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class AuditEventOut(BaseModel):
    id: str
    organization_id: str
    actor_user_id: str | None
    actor_type: str
    actor_display: str | None
    action: str
    entity_type: str | None
    entity_id: str | None
    details: dict[str, Any] | None
    created_at: str


class AuditListResponse(BaseModel):
    items: list[AuditEventOut]
    total: int
    page: int
    page_size: int
