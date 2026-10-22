"""Analytics response schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class OverviewResponse(BaseModel):
    """Dashboard headline metrics — field names match shared-types
    DashboardOverview exactly (additive metadata: generated_at, date_basis).

    Honesty note: date-based buckets ("today", "last 24h") are computed against
    UTC calendar days; per-clinic timezone day boundaries are future work and
    intentionally not simulated here (honesty rule: claim only what is
    implemented)."""

    generated_at: str
    date_basis: Literal["utc"] = "utc"
    appointments_today: int
    appointments_upcoming: int
    calls_last_24h: int
    calls_last_7d: int
    bookings_via_voice_7d: int
    escalations_open: int
    receptionists_active: int
    receptionists_total: int
    avg_session_seconds_7d: float | None
    success_rate_7d: float | None


class DaySeries(BaseModel):
    date: str
    sessions: int = 0
    bookings: int = Field(default=0, description="Sessions that ended with outcome 'appointment_booked'")
    escalations: int = 0


class OutcomeBreakdownItem(BaseModel):
    outcome: str  # outcome value or "none" when the session had no outcome
    count: int


class LanguageBreakdownItem(BaseModel):
    language: str
    count: int


class SeriesResponse(BaseModel):
    """Field names match shared-types AnalyticsResponse (series / outcomes /
    languages); `days` is an additive echo of the requested window."""

    days: int
    series: list[DaySeries]
    outcomes: list[OutcomeBreakdownItem]
    languages: list[LanguageBreakdownItem]
