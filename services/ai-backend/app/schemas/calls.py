"""Voice conversation session read-out schemas (calls endpoints)."""

from __future__ import annotations

from pydantic import BaseModel


class CallSessionOut(BaseModel):
    id: str
    organization_id: str
    clinic_id: str
    receptionist_id: str
    receptionist_name: str | None = None
    channel: str
    language: str
    status: str
    outcome: str | None
    end_reason: str | None
    started_at: str
    ended_at: str | None
    duration_seconds: int | None
    caller_ref: str | None
    created_at: str


class CallSessionListResponse(BaseModel):
    items: list[CallSessionOut]
    total: int
    page: int
    page_size: int


class MessageOut(BaseModel):
    id: str
    session_id: str
    role: str
    content: str | None
    tool_name: str | None
    tool_payload: str | None
    latency_ms: int | None
    created_at: str


class SessionMessagesResponse(BaseModel):
    session: CallSessionOut
    messages: list[MessageOut]
