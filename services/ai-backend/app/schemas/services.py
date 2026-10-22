"""Service (bookable clinic service) request/response schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ServiceCreate(BaseModel):
    clinic_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=2, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    duration_minutes: int = Field(default=30, ge=5, le=480)
    price_display: str | None = Field(default=None, max_length=60)
    is_active: bool = True


class ServiceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    duration_minutes: int | None = Field(default=None, ge=5, le=480)
    price_display: str | None = Field(default=None, max_length=60)
    is_active: bool | None = None


class ServiceOut(BaseModel):
    id: str
    organization_id: str
    clinic_id: str
    clinic_name: str | None = None
    name: str
    description: str | None
    duration_minutes: int
    price_display: str | None
    is_active: bool
    created_at: str
    updated_at: str


class ServiceListResponse(BaseModel):
    items: list[ServiceOut]
    total: int
    page: int
    page_size: int
