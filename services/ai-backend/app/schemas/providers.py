"""Provider (clinical staff) request/response schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.api.v1._util import parse_datetime


class ProviderCreate(BaseModel):
    clinic_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=2, max_length=120)
    specialty: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=160)
    phone: str | None = Field(default=None, max_length=40)
    status: Literal["active", "inactive"] = "active"


class ProviderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    specialty: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=160)
    phone: str | None = Field(default=None, max_length=40)
    status: Literal["active", "inactive"] | None = None


class ProviderOut(BaseModel):
    id: str
    organization_id: str
    clinic_id: str
    clinic_name: str | None = None
    name: str
    specialty: str | None
    email: str | None
    phone: str | None
    status: str
    created_at: str
    updated_at: str


class ProviderListResponse(BaseModel):
    items: list[ProviderOut]
    total: int
    page: int
    page_size: int


class TimeOffCreate(BaseModel):
    starts_at: str = Field(min_length=10, max_length=40)
    ends_at: str = Field(min_length=10, max_length=40)
    reason: str | None = Field(default=None, max_length=300)

    @model_validator(mode="after")
    def _end_after_start(self) -> TimeOffCreate:
        start = parse_datetime(self.starts_at, "starts_at")
        end = parse_datetime(self.ends_at, "ends_at")
        if end <= start:
            raise ValueError("ends_at must be after starts_at.")
        return self


class TimeOffOut(BaseModel):
    id: str
    provider_id: str
    starts_at: str
    ends_at: str
    reason: str | None


class TimeOffListResponse(BaseModel):
    items: list[TimeOffOut]
