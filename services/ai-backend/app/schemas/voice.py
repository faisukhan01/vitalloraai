"""Voice session (REST portion) request/response schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

EndReason = Literal[
    "appointment_booked",
    "appointment_cancelled",
    "appointment_rescheduled",
    "callback_requested",
    "info_provided",
    "transferred_to_human",
    "unresolved",
    "escalated",
    "caller_ended",
]


class VoiceSessionStart(BaseModel):
    receptionist_id: str = Field(min_length=1, max_length=64)
    language: str | None = Field(default=None, min_length=2, max_length=12)


class VoiceSessionEnd(BaseModel):
    end_reason: EndReason


class VoiceSessionOut(BaseModel):
    """Matches shared-types ConversationSession."""

    id: str
    organization_id: str
    clinic_id: str
    receptionist_id: str
    channel: str
    language: str
    status: str
    outcome: str | None = None
    end_reason: str | None = None
    started_at: str
    ended_at: str | None = None
    duration_seconds: int | None = None
    caller_ref: str | None = None


class VoiceSessionStartResponse(BaseModel):
    session: VoiceSessionOut
    greeting_text: str | None = Field(
        description="Configured greeting message of the receptionist (None when unset)."
    )


class VoiceSessionEndResponse(BaseModel):
    session: VoiceSessionOut
