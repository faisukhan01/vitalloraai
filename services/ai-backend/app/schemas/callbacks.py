"""Callback request schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class CallbackStatusUpdate(BaseModel):
    status: Literal["assigned", "completed", "cancelled"]


class CallbackOut(BaseModel):
    id: str
    organization_id: str
    clinic_id: str | None
    session_id: str | None
    patient_name: str
    patient_phone: str
    reason: str | None
    priority: str
    status: str
    created_at: str
    completed_at: str | None


class CallbackListResponse(BaseModel):
    items: list[CallbackOut]
    total: int
    page: int
    page_size: int
