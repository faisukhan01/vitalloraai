"""AI receptionist request/response schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

VoiceId = Literal["tongtong", "chuichui", "xiaochen", "jam", "kazi", "douji", "luodo"]


class Capabilities(BaseModel):
    booking: bool = True
    knowledge_qa: bool = True
    callback_requests: bool = True


class EscalationConfig(BaseModel):
    """Escalation settings (JSON column). Field names match shared-types
    Receptionist['escalation']: transfer_message / callback_number /
    emergency_guidance; enabled + contact_method are backend scheduling hints."""

    enabled: bool = False
    contact_method: Literal["transfer", "callback"] = "callback"
    transfer_message: str | None = Field(default=None, max_length=500)
    callback_number: str | None = Field(default=None, max_length=40)
    emergency_guidance: str | None = Field(default=None, max_length=500)


class ReceptionistCreate(BaseModel):
    clinic_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=2, max_length=120)
    persona: str | None = Field(default=None, max_length=2000)
    status: Literal["draft", "active", "paused"] = "draft"
    languages: list[str] = Field(default_factory=lambda: ["en"], min_length=1, max_length=8)
    primary_language: str = Field(default="en", min_length=2, max_length=12)
    voice_provider: Literal["zai"] = "zai"
    voice_id: VoiceId = "tongtong"
    speaking_speed: float = Field(default=1.0, ge=0.5, le=2.0)
    greeting_message: str | None = Field(default=None, max_length=1000)
    system_prompt_extra: str | None = Field(default=None, max_length=4000)
    capabilities: Capabilities = Field(default_factory=Capabilities)
    escalation: EscalationConfig = Field(default_factory=EscalationConfig)


class ReceptionistUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    persona: str | None = Field(default=None, max_length=2000)
    status: Literal["draft", "active", "paused"] | None = None
    languages: list[str] | None = Field(default=None, min_length=1, max_length=8)
    primary_language: str | None = Field(default=None, min_length=2, max_length=12)
    voice_provider: Literal["zai"] | None = None
    voice_id: VoiceId | None = None
    speaking_speed: float | None = Field(default=None, ge=0.5, le=2.0)
    greeting_message: str | None = Field(default=None, max_length=1000)
    system_prompt_extra: str | None = Field(default=None, max_length=4000)
    capabilities: Capabilities | None = None
    escalation: EscalationConfig | None = None


class ReceptionistOut(BaseModel):
    id: str
    organization_id: str
    clinic_id: str
    clinic_name: str | None = None
    name: str
    persona: str | None
    status: str
    languages: list[str]
    primary_language: str
    voice_provider: str
    voice_id: str
    speaking_speed: float
    greeting_message: str | None
    system_prompt_extra: str | None
    capabilities: Capabilities
    escalation: EscalationConfig
    created_at: str
    updated_at: str


class ReceptionistListResponse(BaseModel):
    items: list[ReceptionistOut]
    total: int
    page: int
    page_size: int
