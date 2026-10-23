"""Structured tools for the AI receptionist (spec §13).

Every tool:
- validates its inputs with Pydantic,
- is scoped to the session's organization (never trusts caller-supplied tenant ids),
- verifies state on the backend before confirming anything to the caller,
- writes an audit event with actor_type='ai_receptionist'.

The LLM never executes SQL or administrative commands — it can only request
one of these narrowly scoped operations.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, field_validator

from app.core.errors import ConflictError, NotFound, ValidationFailed
from app.core.security import new_id, utc_now_iso
from app.db.client import db

logger = logging.getLogger(__name__)

# ── Argument models ───────────────────────────────────────────────────────

class GetClinicInformationArgs(BaseModel):
    pass


class GetServicesArgs(BaseModel):
    pass


class GetProviderAvailabilityArgs(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    service_name: str | None = None
    days: int = Field(default=1, ge=1, le=7)


class SearchAppointmentsArgs(BaseModel):
    patient_phone: str | None = None
    patient_name: str | None = None

    @field_validator("patient_name")
    @classmethod
    def _need_something(cls, v: str | None, info) -> str | None:
        return v


class CreateAppointmentArgs(BaseModel):
    patient_name: str = Field(min_length=2, max_length=120)
    patient_phone: str | None = Field(default=None, max_length=32)
    service_name: str = Field(min_length=2, max_length=160)
    provider_name: str | None = Field(default=None, max_length=160)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    time: str = Field(pattern=r"^\d{2}:\d{2}$")


class RescheduleAppointmentArgs(BaseModel):
    appointment_id: str = Field(min_length=8)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    time: str = Field(pattern=r"^\d{2}:\d{2}$")


class CancelAppointmentArgs(BaseModel):
    appointment_id: str = Field(min_length=8)
    reason: str = Field(min_length=3, max_length=500)


class TransferToHumanArgs(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class CreateStaffCallbackRequestArgs(BaseModel):
    patient_name: str = Field(min_length=2, max_length=120)
    patient_phone: str = Field(min_length=5, max_length=32)
    reason: str | None = Field(default=None, max_length=500)
    priority: Literal["low", "normal", "high", "urgent"] = "normal"


TOOL_REGISTRY: dict[str, type[BaseModel]] = {
    "get_clinic_information": GetClinicInformationArgs,
    "get_services": GetServicesArgs,
    "get_provider_availability": GetProviderAvailabilityArgs,
    "search_appointments": SearchAppointmentsArgs,
    "create_appointment": CreateAppointmentArgs,
    "reschedule_appointment": RescheduleAppointmentArgs,
    "cancel_appointment": CancelAppointmentArgs,
    "transfer_to_human": TransferToHumanArgs,
    "create_staff_callback_request": CreateStaffCallbackRequestArgs,
}

TOOL_DESCRIPTIONS = """Available tools (call at most one per response):
- get_clinic_information: address, phone, opening hours of the clinic. Use for "where are you", "when are you open".
- get_services: list of services the clinic offers with durations and prices.
- get_provider_availability {"date": "YYYY-MM-DD", "service_name"?: string, "days"?: 1-7}: free appointment slots across ALL providers in one call. ALWAYS check availability before offering any time, but call it only ONCE per turn.
- search_appointments {"patient_phone"?: string, "patient_name"?: string}: find existing appointments (needed before rescheduling or cancelling).
- create_appointment {"patient_name": string, "patient_phone"?: string, "service_name": string, "provider_name"?: string, "date": "YYYY-MM-DD", "time": "HH:MM"}: book. Only after the caller confirmed ALL details.
- reschedule_appointment {"appointment_id": string, "date": "YYYY-MM-DD", "time": "HH:MM"}: move an existing appointment.
- cancel_appointment {"appointment_id": string, "reason": string}: cancel an existing appointment.
- transfer_to_human {"reason": string}: escalate to clinic staff when you cannot help or the caller asks for a person.
- create_staff_callback_request {"patient_name": string, "patient_phone": string, "reason"?: string, "priority"?: "low"|"normal"|"high"|"urgent"}: request a staff callback.
"""


# ── Execution context ─────────────────────────────────────────────────────

class ToolContext:
    """Everything a tool needs, bound to the verified voice session."""

    def __init__(self, *, org_id: str, clinic_id: str, receptionist_id: str, session_id: str) -> None:
        self.org_id = org_id
        self.clinic_id = clinic_id
        self.receptionist_id = receptionist_id
        self.session_id = session_id

    async def audit(self, action: str, entity_type: str, entity_id: str | None, details: dict | None = None) -> None:
        await db.write(
            "INSERT INTO audit_events (id, organization_id, actor_user_id, actor_type, actor_display, "
            "action, entity_type, entity_id, details, created_at) VALUES (?, ?, NULL, 'ai_receptionist', ?, ?, ?, ?, ?, ?)",
            (
                new_id(),
                self.org_id,
                "ai_receptionist",
                action,
                entity_type,
                entity_id,
                json.dumps(details, ensure_ascii=False) if details else None,
                utc_now_iso(),
            ),
        )


async def _clinic_row(ctx: ToolContext) -> dict:
    row = await db.one(
        "SELECT * FROM clinics WHERE id = ? AND organization_id = ?", (ctx.clinic_id, ctx.org_id)
    )
    if not row:
        raise NotFound("Clinic not found.")
    return row


async def _hours_rows(clinic_id: str) -> list[dict]:
    return await db.execute(
        "SELECT day_of_week, open_time, close_time, is_closed FROM clinic_hours WHERE clinic_id = ? ORDER BY day_of_week",
        (clinic_id,),
    )


def _fmt_hours(hours: list[dict]) -> str:
    names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    parts = []
    for h in hours:
        day = names[h["day_of_week"] % 7]
        if h["is_closed"]:
            parts.append(f"{day}: closed")
        else:
            parts.append(f"{day}: {h['open_time']}-{h['close_time']}")
    return "; ".join(parts)


# ── Availability core (mirrors the REST availability semantics) ───────────

async def _compute_slots(
    ctx: ToolContext, start_date: str, days: int, service_id: str | None, service_name: str | None
) -> list[dict]:
    clinic = await _clinic_row(ctx)
    tz = ZoneInfo(clinic["timezone"] or "UTC")
    hours = {h["day_of_week"]: h for h in await _hours_rows(ctx.clinic_id)}

    service_row: dict | None = None
    if service_id:
        service_row = await db.one(
            "SELECT * FROM services WHERE id = ? AND organization_id = ? AND is_active = 1",
            (service_id, ctx.org_id),
        )
    elif service_name:
        rows = await db.execute(
            "SELECT * FROM services WHERE organization_id = ? AND clinic_id = ? AND is_active = 1 AND LOWER(name) LIKE ?",
            (ctx.org_id, ctx.clinic_id, f"%{service_name.lower()}%"),
        )
        service_row = rows[0] if rows else None
    duration = service_row["duration_minutes"] if service_row else 30

    providers = await db.execute(
        "SELECT * FROM providers WHERE clinic_id = ? AND organization_id = ? AND status = 'active'",
        (ctx.clinic_id, ctx.org_id),
    )

    slots: list[dict] = []
    base = datetime.strptime(start_date, "%Y-%m-%d").date()
    for day_offset in range(days):
        day = base + timedelta(days=day_offset)
        weekday = day.weekday()  # 0=Monday
        h = hours.get(weekday)
        if not h or h["is_closed"]:
            continue
        day_start_utc = datetime.strptime(f"{day.isoformat()}T{h['open_time']}", "%Y-%m-%dT%H:%M").replace(tzinfo=tz)
        day_end_utc = datetime.strptime(f"{day.isoformat()}T{h['close_time']}", "%Y-%m-%dT%H:%M").replace(tzinfo=tz)
        exc = await db.one(
            "SELECT * FROM schedule_exceptions WHERE clinic_id = ? AND date = ?",
            (ctx.clinic_id, day.isoformat()),
        )
        if exc and exc["is_closed"]:
            continue

        for p in providers:
            time_off = await db.execute(
                "SELECT starts_at, ends_at FROM provider_time_off WHERE provider_id = ?", (p["id"],)
            )
            busy = await db.execute(
                "SELECT starts_at, ends_at FROM appointments WHERE provider_id = ? AND status IN ('booked','confirmed') "
                "AND starts_at >= ? AND starts_at <= ?",
                (p["id"], day_start_utc.isoformat(), day_end_utc.isoformat()),
            )
            slot = day_start_utc
            while slot + timedelta(minutes=duration) <= day_end_utc:
                slot_end = slot + timedelta(minutes=duration)
                conflict = any(
                    not (slot_end <= datetime.fromisoformat(b["starts_at"]) or slot >= datetime.fromisoformat(b["ends_at"]))
                    for b in busy
                )
                off = any(
                    not (slot_end <= datetime.fromisoformat(t["starts_at"]) or slot >= datetime.fromisoformat(t["ends_at"]))
                    for t in time_off
                )
                if not conflict and not off and slot > datetime.now(UTC):
                    slots.append(
                        {
                            "date": day.isoformat(),
                            "time": slot.strftime("%H:%M"),
                            "provider_id": p["id"],
                            "provider_name": p["name"],
                            "service": service_row["name"] if service_row else None,
                            "duration_minutes": duration,
                        }
                    )
                slot += timedelta(minutes=max(15, duration // 2))
                if len(slots) >= 30:
                    return slots
    return slots


# ── Tool implementations ──────────────────────────────────────────────────

# ── Natural-language date normalization ──────────────────────────────────

_WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}

# Tools whose "date" argument the LLM may express in natural language
# ("tomorrow", "friday", "next monday", "in 3 days"). Normalized to
# YYYY-MM-DD BEFORE Pydantic validation so a spoken relative date can never
# burn tool-call iterations on a format error (voice UX rule: one shot).
_DATE_ARG_TOOLS = {"get_provider_availability", "create_appointment", "reschedule_appointment"}

_clinic_tz_cache: dict[str, tuple[str, float]] = {}


async def _clinic_timezone(ctx: ToolContext) -> ZoneInfo:
    """Clinic timezone with a 10-minute cache (timezones never change fast)."""
    import time as _time

    cached = _clinic_tz_cache.get(ctx.clinic_id)
    if cached and _time.monotonic() - cached[1] < 600:
        return ZoneInfo(cached[0])
    clinic = await _clinic_row(ctx)
    tz_name = clinic["timezone"] or "UTC"
    _clinic_tz_cache[ctx.clinic_id] = (tz_name, _time.monotonic())
    return ZoneInfo(tz_name)


def _resolve_natural_date(text: str, today: datetime) -> str | None:
    """Resolve a spoken date expression to YYYY-MM-DD; None when not natural."""
    value = text.strip().lower().replace(".", "")
    if not value or len(value) > 32:
        return None

    def fmt(d: datetime) -> str:
        return d.strftime("%Y-%m-%d")

    if value in ("today", "aaj"):
        return fmt(today)
    if value in ("tomorrow", "tomarrow", "kal"):
        return fmt(today + timedelta(days=1))
    if value in ("day after tomorrow", "parso"):
        return fmt(today + timedelta(days=2))

    if value.startswith("in ") and value.endswith("days"):
        middle = value[3:-5].strip()
        if middle.isdigit() and 0 <= int(middle) <= 60:
            return fmt(today + timedelta(days=int(middle)))

    # [next] <weekday> — the next occurrence (1-7 days ahead; "next" pushes
    # past the immediate week when the weekday is today).
    words = value.split()
    has_next = words and words[0] in ("next", "coming", "upcoming")
    target = words[-1] if words else ""
    if target in _WEEKDAYS:
        offset = (_WEEKDAYS[target] - today.weekday()) % 7
        if offset == 0:
            offset = 7
        if has_next and offset < 7:
            offset += 7 if offset <= 1 else 0
        return fmt(today + timedelta(days=offset))
    return None


async def _normalize_date_args(tool_name: str, raw_args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    if tool_name not in _DATE_ARG_TOOLS:
        return raw_args
    raw_date = raw_args.get("date")
    if not isinstance(raw_date, str):
        return raw_args
    raw_date = raw_date.strip()
    if len(raw_date) == 10 and raw_date[4] == "-" and raw_date[7] == "-":
        return raw_args  # already canonical
    try:
        tz = await _clinic_timezone(ctx)
    except Exception:  # noqa: BLE001
        tz = ZoneInfo("UTC")
    resolved = _resolve_natural_date(raw_date, datetime.now(tz))
    if resolved:
        raw_args["date"] = resolved
    return raw_args


async def execute_tool(name: str, raw_args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """Dispatch a validated tool call. Raises AppError subclasses on failure."""
    model = TOOL_REGISTRY.get(name)
    if model is None:
        raise ValidationFailed(f"Unknown tool: {name}")
    raw_args = await _normalize_date_args(name, dict(raw_args or {}), ctx)
    try:
        args = model.model_validate(raw_args)
    except Exception as exc:  # noqa: BLE001
        raise ValidationFailed(f"Invalid arguments for {name}: {exc}") from exc

    if name == "get_clinic_information":
        clinic = await _clinic_row(ctx)
        hours = await _hours_rows(ctx.clinic_id)
        return {
            "clinic_name": clinic["name"],
            "address": clinic["address"],
            "phone": clinic["phone"],
            "email": clinic["email"],
            "timezone": clinic["timezone"],
            "opening_hours": _fmt_hours(hours),
        }

    if name == "get_services":
        rows = await db.execute(
            "SELECT name, description, duration_minutes, price_display FROM services "
            "WHERE organization_id = ? AND clinic_id = ? AND is_active = 1 ORDER BY name",
            (ctx.org_id, ctx.clinic_id),
        )
        return {"services": rows}

    if name == "get_provider_availability":
        slots = await _compute_slots(ctx, args.date, args.days, None, args.service_name)
        return {
            "date": args.date,
            "slots": [
                {k: s[k] for k in ("date", "time", "provider_name", "service", "duration_minutes")}
                for s in slots[:20]
            ],
            "note": "Times shown in the clinic's local timezone. Confirm date and time with the caller before booking." if slots else "No free slots in this range.",
        }

    if name == "search_appointments":
        if not args.patient_phone and not args.patient_name:
            raise ValidationFailed("Provide a phone number or the patient's name to search.")
        conds, params = ["organization_id = ?", "clinic_id = ?", "status IN ('booked','confirmed')"], [ctx.org_id, ctx.clinic_id]
        if args.patient_phone:
            conds.append("REPLACE(REPLACE(patient_phone, '-', ''), ' ', '') LIKE ?")
            params.append(f"%{args.patient_phone.replace('-', '').replace(' ', '')}%")
        if args.patient_name:
            conds.append("LOWER(patient_name) LIKE ?")
            params.append(f"%{args.patient_name.lower()}%")
        rows = await db.execute(
            "SELECT a.id, a.patient_name, a.starts_at, a.status, p.name AS provider_name, s.name AS service_name "
            "FROM appointments a JOIN providers p ON p.id = a.provider_id JOIN services s ON s.id = a.service_id "
            f"WHERE {' AND '.join(conds)} ORDER BY a.starts_at LIMIT 10",
            tuple(params),
        )
        return {"appointments": rows}

    if name == "create_appointment":
        clinic = await _clinic_row(ctx)
        tz = ZoneInfo(clinic["timezone"] or "UTC")
        svc_rows = await db.execute(
            "SELECT * FROM services WHERE organization_id = ? AND clinic_id = ? AND is_active = 1 AND LOWER(name) LIKE ?",
            (ctx.org_id, ctx.clinic_id, f"%{args.service_name.lower()}%"),
        )
        if not svc_rows:
            raise ValidationFailed(f"No service matching '{args.service_name}'. Offer to list available services.")
        service = svc_rows[0]
        provider: dict
        if args.provider_name:
            p_rows = await db.execute(
                "SELECT * FROM providers WHERE clinic_id = ? AND organization_id = ? AND status = 'active' AND LOWER(name) LIKE ?",
                (ctx.clinic_id, ctx.org_id, f"%{args.provider_name.lower()}%"),
            )
            if not p_rows:
                raise ValidationFailed(f"No provider matching '{args.provider_name}'.")
            provider = p_rows[0]
        else:
            p_rows = await db.execute(
                "SELECT * FROM providers WHERE clinic_id = ? AND organization_id = ? AND status = 'active' ORDER BY name LIMIT 1",
                (ctx.clinic_id, ctx.org_id),
            )
            if not p_rows:
                raise ValidationFailed("The clinic has no active providers configured.")
            provider = p_rows[0]

        start_local = datetime.strptime(f"{args.date}T{args.time}", "%Y-%m-%dT%H:%M").replace(tzinfo=tz)
        end_local = start_local + timedelta(minutes=service["duration_minutes"])
        now = datetime.now(UTC)
        if start_local <= now:
            raise ValidationFailed("That time is in the past. Offer a future slot.")
        if start_local > now + timedelta(days=120):
            raise ValidationFailed("Bookings are limited to the next 120 days.")

        start_iso, end_iso = start_local.isoformat(), end_local.isoformat()
        appointment_id = new_id()
        async with db.transaction() as tx:
            clash = await tx.one(
                "SELECT id FROM appointments WHERE provider_id = ? AND status IN ('booked','confirmed') "
                "AND starts_at < ? AND ends_at > ?",
                (provider["id"], end_iso, start_iso),
            )
            if clash:
                raise ConflictError("That slot was just taken. Check availability again.")
            await tx.execute(
                "INSERT INTO appointments (id, organization_id, clinic_id, provider_id, service_id, receptionist_id, "
                "patient_name, patient_phone, starts_at, ends_at, duration_minutes, status, source, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', 'voice', ?, ?)",
                (
                    appointment_id, ctx.org_id, ctx.clinic_id, provider["id"], service["id"], ctx.receptionist_id,
                    args.patient_name, args.patient_phone, start_iso, end_iso, service["duration_minutes"],
                    utc_now_iso(), utc_now_iso(),
                ),
            )
        await ctx.audit(
            "appointment_created_via_voice", "appointment", appointment_id,
            {"patient_name": args.patient_name, "starts_at": start_iso, "provider": provider["name"], "session_id": ctx.session_id},
        )
        return {
            "booked": True,
            "appointment_id": appointment_id,
            "summary": f"{service['name']} with {provider['name']} on {args.date} at {args.time} ({clinic['timezone']})",
        }

    if name == "reschedule_appointment":
        appt = await db.one(
            "SELECT * FROM appointments WHERE id = ? AND organization_id = ? AND status IN ('booked','confirmed')",
            (args.appointment_id, ctx.org_id),
        )
        if not appt:
            raise NotFound("I could not find that appointment. Search for it first with the patient's details.")
        clinic = await _clinic_row(ctx)
        tz = ZoneInfo(clinic["timezone"] or "UTC")
        start_local = datetime.strptime(f"{args.date}T{args.time}", "%Y-%m-%dT%H:%M").replace(tzinfo=tz)
        end_local = start_local + timedelta(minutes=appt["duration_minutes"])
        old_start = appt["starts_at"]
        async with db.transaction() as tx:
            clash = await tx.one(
                "SELECT id FROM appointments WHERE provider_id = ? AND status IN ('booked','confirmed') "
                "AND id != ? AND starts_at < ? AND ends_at > ?",
                (appt["provider_id"], appt["id"], end_local.isoformat(), start_local.isoformat()),
            )
            if clash:
                raise ConflictError("That slot was just taken. Check availability again.")
            await tx.execute(
                "UPDATE appointments SET starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?",
                (start_local.isoformat(), end_local.isoformat(), utc_now_iso(), appt["id"]),
            )
        await ctx.audit(
            "appointment_rescheduled_via_voice", "appointment", appt["id"],
            {"from": old_start, "to": start_local.isoformat(), "session_id": ctx.session_id},
        )
        return {"rescheduled": True, "appointment_id": appt["id"], "new_time": f"{args.date} {args.time}"}

    if name == "cancel_appointment":
        appt = await db.one(
            "SELECT id FROM appointments WHERE id = ? AND organization_id = ? AND status IN ('booked','confirmed')",
            (args.appointment_id, ctx.org_id),
        )
        if not appt:
            raise NotFound("I could not find an active appointment with that reference.")
        await db.write(
            "UPDATE appointments SET status = 'cancelled', cancellation_reason = ?, updated_at = ? WHERE id = ?",
            (args.reason, utc_now_iso(), appt["id"]),
        )
        await ctx.audit("appointment_cancelled_via_voice", "appointment", appt["id"], {"reason": args.reason, "session_id": ctx.session_id})
        return {"cancelled": True, "appointment_id": appt["id"]}

    if name == "transfer_to_human":
        esc_id = new_id()
        await db.execute(
            "INSERT INTO escalations (id, organization_id, session_id, reason, contact_method, status, created_at) "
            "VALUES (?, ?, ?, ?, 'transfer', 'open', ?)",
            (esc_id, ctx.org_id, ctx.session_id, args.reason, utc_now_iso()),
        )
        await db.write(
            "UPDATE conversation_sessions SET status = 'escalated' WHERE id = ? AND organization_id = ?",
            (ctx.session_id, ctx.org_id),
        )
        await ctx.audit("escalation_transfer", "escalation", esc_id, {"reason": args.reason, "session_id": ctx.session_id})
        return {
            "transferred": True,
            "instruction": "Tell the caller politely that you are connecting them to clinic staff and that someone will be with them shortly. Then say goodbye.",
        }

    if name == "create_staff_callback_request":
        cb_id = new_id()
        await db.execute(
            "INSERT INTO callback_requests (id, organization_id, clinic_id, session_id, patient_name, patient_phone, reason, priority, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
            (cb_id, ctx.org_id, ctx.clinic_id, ctx.session_id, args.patient_name, args.patient_phone, args.reason, args.priority, utc_now_iso()),
        )
        await ctx.audit("callback_requested", "callback_request", cb_id, {"priority": args.priority, "session_id": ctx.session_id})
        return {
            "created": True,
            "callback_id": cb_id,
            "instruction": "Confirm to the caller that staff will call them back and thank them.",
        }

    raise ValidationFailed(f"Tool '{name}' is not implemented.")
