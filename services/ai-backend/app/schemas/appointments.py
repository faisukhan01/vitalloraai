"""Appointment request/response schemas, including availability shapes."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, EmailStr, Field

APPOINTMENT_STATUSES = ("booked", "confirmed", "cancelled", "completed", "no_show", "rescheduled")

AppointmentStatus = Literal["booked", "confirmed", "cancelled", "completed", "no_show", "rescheduled"]


class AppointmentCreate(BaseModel):
    clinic_id: str = Field(min_length=1, max_length=64)
    provider_id: str = Field(min_length=1, max_length=64)
    service_id: str = Field(min_length=1, max_length=64)
    receptionist_id: str | None = Field(default=None, max_length=64)
    patient_name: str = Field(min_length=2, max_length=120)
    patient_phone: str | None = Field(default=None, max_length=40)
    patient_email: EmailStr | None = None
    patient_notes: str | None = Field(default=None, max_length=2000)
    starts_at: str = Field(min_length=10, max_length=40, description="ISO-8601 datetime (UTC)")
    idempotency_key: str | None = Field(default=None, max_length=120)


class RescheduleRequest(BaseModel):
    starts_at: str = Field(min_length=10, max_length=40, description="New ISO-8601 datetime (UTC)")
    idempotency_key: str | None = Field(default=None, max_length=120)


class CancelRequest(BaseModel):
    reason: str = Field(min_length=2, max_length=500)


class AppointmentStatusUpdate(BaseModel):
    status: Literal["confirmed", "completed", "no_show"]


class AppointmentOut(BaseModel):
    id: str
    organization_id: str
    clinic_id: str
    clinic_name: str | None = None
    provider_id: str
    provider_name: str | None = None
    service_id: str
    service_name: str | None = None
    receptionist_id: str | None
    patient_name: str
    patient_phone: str | None
    patient_email: str | None
    patient_notes: str | None
    starts_at: str
    ends_at: str
    duration_minutes: int
    status: AppointmentStatus
    cancellation_reason: str | None
    source: str
    created_at: str
    updated_at: str


class AppointmentListResponse(BaseModel):
    items: list[AppointmentOut]
    total: int
    page: int
    page_size: int


class SlotOut(BaseModel):
    starts_at: str
    ends_at: str
    provider_id: str
    provider_name: str
    service_id: str
    duration_minutes: int
    day: str = Field(description="Local calendar date (YYYY-MM-DD) in the clinic timezone")


class DayAvailability(BaseModel):
    date: str
    day_of_week: int
    slots: list[SlotOut]


class AvailabilityResponse(BaseModel):
    """Computed open slots. `slots` is the flat list the web client consumes
    (shared-types AvailabilitySlot + local `day`); `days` keeps the per-day
    grouping for calendar UIs."""

    service_id: str
    clinic_id: str
    timezone: str
    duration_minutes: int
    days: list[DayAvailability]
    slots: list[SlotOut]
