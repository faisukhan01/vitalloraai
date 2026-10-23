"""Clinic request/response schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

_TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"


class ClinicHoursDay(BaseModel):
    day_of_week: int = Field(ge=0, le=6, description="0 = Monday … 6 = Sunday")
    open_time: str = Field(default="09:00", pattern=_TIME_PATTERN)
    close_time: str = Field(default="17:00", pattern=_TIME_PATTERN)
    is_closed: bool = False

    @model_validator(mode="after")
    def _open_before_close(self) -> ClinicHoursDay:
        if not self.is_closed and self.open_time >= self.close_time:
            raise ValueError("open_time must be before close_time on an open day.")
        return self


class ClinicCreate(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    timezone: str = Field(default="UTC", max_length=64)
    address: str | None = Field(default=None, max_length=300)
    phone: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=160)
    status: Literal["active", "inactive"] = "active"
    slug: str | None = Field(default=None, max_length=80)


class ClinicUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    timezone: str | None = Field(default=None, max_length=64)
    address: str | None = Field(default=None, max_length=300)
    phone: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=160)
    status: Literal["active", "inactive"] | None = None


class ClinicOut(BaseModel):
    id: str
    organization_id: str
    name: str
    slug: str
    timezone: str
    address: str | None
    phone: str | None
    email: str | None
    status: str
    created_at: str
    updated_at: str


class ClinicListResponse(BaseModel):
    items: list[ClinicOut]
    total: int
    page: int
    page_size: int


class ClinicHoursUpdate(BaseModel):
    days: list[ClinicHoursDay] = Field(min_length=1, max_length=7)


class ClinicHoursOut(BaseModel):
    """One stored weekly-hours row (matches shared-types ClinicHours)."""

    id: str
    organization_id: str
    clinic_id: str
    day_of_week: int = Field(description="0 = Monday … 6 = Sunday (Python weekday() convention)")
    open_time: str
    close_time: str
    is_closed: bool
