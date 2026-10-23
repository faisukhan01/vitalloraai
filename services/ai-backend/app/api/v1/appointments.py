"""Appointment endpoints: list, availability, booking, reschedule, cancel, status.

Concurrency: booking and reschedule run inside `db.transaction()` (BEGIN
IMMEDIATE) and rely on both an explicit overlap check and the partial unique
index `uq_appointments_provider_slot`. Conflicts surface as HTTP 409 with a
clear, honest message — never a silent double-booking.
"""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query, Response, status

from app.api.v1._util import (
    pagination,
    parse_date,
    parse_datetime,
    parse_hhmm,
    resolve_timezone,
    utc_iso,
    write_audit,
)
from app.core.deps import Principal, require_permission
from app.core.errors import ConflictError, NotFound, ValidationFailed
from app.core.security import new_id, utc_now_iso
from app.db.client import db
from app.schemas.appointments import (
    APPOINTMENT_STATUSES,
    AppointmentCreate,
    AppointmentListResponse,
    AppointmentOut,
    AppointmentStatusUpdate,
    AvailabilityResponse,
    CancelRequest,
    DayAvailability,
    RescheduleRequest,
    SlotOut,
)

router = APIRouter(prefix="/appointments", tags=["appointments"])

# Legal status transitions via PATCH (cancel and reschedule have their own endpoints).
_STATUS_TRANSITIONS: dict[str, set[str]] = {
    "booked": {"confirmed", "completed", "no_show"},
    "confirmed": {"completed", "no_show"},
}

_JOIN = (
    "SELECT a.*, c.name AS clinic_name, p.name AS provider_name, s.name AS service_name "
    "FROM appointments a "
    "JOIN clinics c ON c.id = a.clinic_id "
    "JOIN providers p ON p.id = a.provider_id "
    "JOIN services s ON s.id = a.service_id "
)


def _to_out(row: dict) -> AppointmentOut:
    return AppointmentOut(
        id=row["id"],
        organization_id=row["organization_id"],
        clinic_id=row["clinic_id"],
        clinic_name=row.get("clinic_name"),
        provider_id=row["provider_id"],
        provider_name=row.get("provider_name"),
        service_id=row["service_id"],
        service_name=row.get("service_name"),
        receptionist_id=row["receptionist_id"],
        patient_name=row["patient_name"],
        patient_phone=row["patient_phone"],
        patient_email=row["patient_email"],
        patient_notes=row["patient_notes"],
        starts_at=row["starts_at"],
        ends_at=row["ends_at"],
        duration_minutes=row["duration_minutes"],
        status=row["status"],
        cancellation_reason=row["cancellation_reason"],
        source=row["source"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def _fetch_appointment_or_404(appointment_id: str, org_id: str) -> dict:
    row = await db.one(_JOIN + "WHERE a.id = ? AND a.organization_id = ?", (appointment_id, org_id))
    if row is None:
        raise NotFound("Appointment not found.")
    return row


def _booking_fingerprint(payload: AppointmentCreate, start_iso: str) -> tuple:
    return (
        payload.clinic_id,
        payload.provider_id,
        payload.service_id,
        payload.receptionist_id,
        payload.patient_name.strip().lower(),
        (payload.patient_phone or "").strip(),
        str(payload.patient_email).lower() if payload.patient_email else "",
        payload.patient_notes or "",
        start_iso,
    )


def _row_fingerprint(row: dict, start_iso: str) -> tuple:
    return (
        row["clinic_id"],
        row["provider_id"],
        row["service_id"],
        row["receptionist_id"],
        (row["patient_name"] or "").strip().lower(),
        (row["patient_phone"] or "").strip(),
        (row["patient_email"] or "").lower(),
        row["patient_notes"] or "",
        start_iso,
    )


def _overlaps(busy_start: str, busy_end: str, slot_start: datetime, slot_end: datetime) -> bool:
    """Interval overlap for stored ISO strings vs slot datetimes (fail closed)."""
    try:
        bs = datetime.fromisoformat(busy_start)  # Python 3.11+ parses the trailing 'Z' natively
        be = datetime.fromisoformat(busy_end)
    except (ValueError, AttributeError):
        return True  # unparseable interval: treat the slot as busy (conservative)
    if bs.tzinfo is None:
        bs = bs.replace(tzinfo=UTC)
    if be.tzinfo is None:
        be = be.replace(tzinfo=UTC)
    return bs < slot_end and be > slot_start


def _slot_conflict_error() -> ConflictError:
    return ConflictError(
        "That time slot is no longer available for this provider. Please choose another time."
    )


# ── List ──────────────────────────────────────────────────────────────────────


@router.get("", response_model=AppointmentListResponse)
async def list_appointments(
    principal: Principal = Depends(require_permission("appointments:read")),
    from_str: str | None = Query(default=None, alias="from"),
    to_str: str | None = Query(default=None, alias="to"),
    clinic_id: str | None = None,
    provider_id: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    search: str | None = Query(default=None, max_length=120),
    pg: tuple[int, int] = Depends(pagination),
) -> AppointmentListResponse:
    page, page_size = pg
    from_date = parse_date(from_str, "from") if from_str else None
    to_date = parse_date(to_str, "to") if to_str else None
    if from_date and to_date and from_date > to_date:
        raise ValidationFailed("'from' date must not be after 'to' date.")

    conds = ["a.organization_id = ?"]
    params: list = [principal.organization_id]
    if from_date:
        conds.append("a.starts_at >= ?")
        params.append(from_date.isoformat())
    if to_date:
        conds.append("a.starts_at < ?")
        params.append((to_date + timedelta(days=1)).isoformat())
    if clinic_id:
        conds.append("a.clinic_id = ?")
        params.append(clinic_id)
    if provider_id:
        conds.append("a.provider_id = ?")
        params.append(provider_id)
    if status_filter:
        if status_filter not in APPOINTMENT_STATUSES:
            raise ValidationFailed(f"status must be one of: {', '.join(APPOINTMENT_STATUSES)}.")
        conds.append("a.status = ?")
        params.append(status_filter)
    if search:
        needle = f"%{search.strip()}%"
        conds.append("(a.patient_name LIKE ? OR IFNULL(a.patient_phone, '') LIKE ?)")
        params.extend([needle, needle])

    where = " AND ".join(conds)  # static condition strings only; user data is in params
    total = await db.one(f"SELECT COUNT(*) AS n FROM appointments a WHERE {where}", tuple(params))
    rows = await db.execute(
        _JOIN + f"WHERE {where} ORDER BY a.starts_at ASC, a.id ASC LIMIT ? OFFSET ?",
        tuple(params + [page_size, (page - 1) * page_size]),
    )
    return AppointmentListResponse(
        items=[_to_out(r) for r in rows], total=total["n"] if total else 0, page=page, page_size=page_size
    )


# ── Availability ─────────────────────────────────────────────────────────────


@router.get("/availability", response_model=AvailabilityResponse)
async def get_availability(
    principal: Principal = Depends(require_permission("appointments:read")),
    service_id: str = Query(...),
    date_str: str = Query(..., alias="date"),
    provider_id: str | None = Query(default=None),
    days: int = Query(default=7, ge=1, le=14),
) -> AvailabilityResponse:
    org_id = principal.organization_id
    svc = await db.one(
        "SELECT s.id, s.clinic_id, s.name, s.duration_minutes, s.is_active, "
        "c.timezone AS clinic_timezone, c.status AS clinic_status "
        "FROM services s JOIN clinics c ON c.id = s.clinic_id WHERE s.id = ? AND s.organization_id = ?",
        (service_id, org_id),
    )
    if svc is None:
        raise NotFound("Service not found.")
    if not svc["is_active"]:
        raise ValidationFailed("This service is not active for booking.")
    if svc["clinic_status"] != "active":
        raise ConflictError("This clinic is not accepting bookings.")

    tz = resolve_timezone(svc["clinic_timezone"])
    start_date = parse_date(date_str, "date")

    if provider_id:
        prov = await db.one(
            "SELECT id, name, clinic_id, status FROM providers WHERE id = ? AND organization_id = ?",
            (provider_id, org_id),
        )
        if prov is None:
            raise NotFound("Provider not found.")
        if prov["clinic_id"] != svc["clinic_id"]:
            raise ValidationFailed("The requested provider does not belong to this service's clinic.")
        if prov["status"] != "active":
            raise ValidationFailed("The requested provider is not currently active.")
        providers = [{"id": prov["id"], "name": prov["name"]}]
    else:
        providers = await db.execute(
            "SELECT id, name FROM providers WHERE clinic_id = ? AND organization_id = ? AND status = 'active' "
            "ORDER BY name ASC",
            (svc["clinic_id"], org_id),
        )
    if not providers:
        raise ValidationFailed("There are no active providers at this clinic.")

    window_start = datetime.combine(start_date, time(0, 0), tzinfo=tz).astimezone(UTC)
    window_end = datetime.combine(start_date + timedelta(days=days), time(0, 0), tzinfo=tz).astimezone(UTC)
    window_start_iso, window_end_iso = utc_iso(window_start), utc_iso(window_end)

    busy_appointments = await db.execute(
        "SELECT provider_id, starts_at, ends_at FROM appointments "
        "WHERE organization_id = ? AND clinic_id = ? AND status IN ('booked','confirmed') "
        "AND starts_at < ? AND ends_at > ?",
        (org_id, svc["clinic_id"], window_end_iso, window_start_iso),
    )
    busy_time_off = await db.execute(
        "SELECT provider_id, starts_at, ends_at FROM provider_time_off "
        "WHERE organization_id = ? AND starts_at < ? AND ends_at > ?",
        (org_id, window_end_iso, window_start_iso),
    )
    provider_ids = {p["id"] for p in providers}
    busy = [
        b
        for b in (busy_appointments + busy_time_off)
        if b["provider_id"] in provider_ids
    ]

    hours_rows = await db.execute(
        "SELECT * FROM clinic_hours WHERE clinic_id = ? AND organization_id = ?",
        (svc["clinic_id"], org_id),
    )
    hours_by_day = {r["day_of_week"]: r for r in hours_rows}
    exception_rows = await db.execute(
        "SELECT * FROM schedule_exceptions WHERE clinic_id = ? AND organization_id = ? AND date >= ? AND date < ?",
        (svc["clinic_id"], org_id, start_date.isoformat(), (start_date + timedelta(days=days)).isoformat()),
    )
    exceptions_by_date = {r["date"]: r for r in exception_rows}

    duration = svc["duration_minutes"]
    now_utc = datetime.now(UTC)
    result_days: list[DayAvailability] = []

    for offset_day in range(days):
        day = start_date + timedelta(days=offset_day)
        slots: list[SlotOut] = []

        exc = exceptions_by_date.get(day.isoformat())
        open_t = close_t = None
        if exc is not None:
            if exc["is_closed"]:
                result_days.append(DayAvailability(date=day.isoformat(), day_of_week=day.weekday(), slots=[]))
                continue
            if exc["open_time"] and exc["close_time"]:
                open_t, close_t = exc["open_time"], exc["close_time"]
        if open_t is None:
            hours = hours_by_day.get(day.weekday())
            if hours is None or hours["is_closed"]:
                result_days.append(DayAvailability(date=day.isoformat(), day_of_week=day.weekday(), slots=[]))
                continue
            open_t, close_t = hours["open_time"], hours["close_time"]

        open_time = parse_hhmm(open_t, "open_time")
        close_time = parse_hhmm(close_t, "close_time")
        open_min = open_time.hour * 60 + open_time.minute
        close_min = close_time.hour * 60 + close_time.minute
        if close_min - open_min < duration:
            result_days.append(DayAvailability(date=day.isoformat(), day_of_week=day.weekday(), slots=[]))
            continue

        for minute_offset in range(0, close_min - open_min - duration + 1, duration):
            slot_start_local = datetime.combine(day, open_time, tzinfo=tz) + timedelta(minutes=minute_offset)
            slot_start_utc = slot_start_local.astimezone(UTC)
            slot_end_utc = slot_start_utc + timedelta(minutes=duration)
            if slot_start_utc <= now_utc:
                continue  # never offer past slots
            s_iso, e_iso = utc_iso(slot_start_utc), utc_iso(slot_end_utc)
            for p in providers:
                if any(
                    b["provider_id"] == p["id"] and _overlaps(b["starts_at"], b["ends_at"], slot_start_utc, slot_end_utc)
                    for b in busy
                ):
                    continue
                slots.append(
                    SlotOut(
                        starts_at=s_iso,
                        ends_at=e_iso,
                        provider_id=p["id"],
                        provider_name=p["name"],
                        service_id=svc["id"],
                        duration_minutes=duration,
                        day=day.isoformat(),
                    )
                )
        result_days.append(DayAvailability(date=day.isoformat(), day_of_week=day.weekday(), slots=slots))

    return AvailabilityResponse(
        service_id=svc["id"],
        clinic_id=svc["clinic_id"],
        timezone=svc["clinic_timezone"],
        duration_minutes=duration,
        days=result_days,
        slots=[slot for day in result_days for slot in day.slots],
    )


# ── Single appointment ───────────────────────────────────────────────────────


@router.get("/{appointment_id}", response_model=AppointmentOut)
async def get_appointment(
    appointment_id: str,
    principal: Principal = Depends(require_permission("appointments:read")),
) -> AppointmentOut:
    return _to_out(await _fetch_appointment_or_404(appointment_id, principal.organization_id))


# ── Booking ──────────────────────────────────────────────────────────────────


@router.post("", response_model=AppointmentOut, status_code=status.HTTP_201_CREATED)
async def create_appointment(
    payload: AppointmentCreate,
    response: Response,
    principal: Principal = Depends(require_permission("appointments:write")),
) -> AppointmentOut:
    org_id = principal.organization_id
    now = datetime.now(UTC)

    svc = await db.one(
        "SELECT s.id, s.clinic_id, s.name AS service_name, s.duration_minutes, s.is_active, c.status AS clinic_status "
        "FROM services s JOIN clinics c ON c.id = s.clinic_id WHERE s.id = ? AND s.organization_id = ?",
        (payload.service_id, org_id),
    )
    if svc is None:
        raise NotFound("Service not found.")
    if payload.clinic_id != svc["clinic_id"]:
        raise ValidationFailed("The selected service does not belong to the selected clinic.")
    if not svc["is_active"]:
        raise ValidationFailed("This service is not active for booking.")
    if svc["clinic_status"] != "active":
        raise ConflictError("This clinic is not accepting bookings.")

    prov = await db.one(
        "SELECT id, name, clinic_id, status FROM providers WHERE id = ? AND organization_id = ?",
        (payload.provider_id, org_id),
    )
    if prov is None:
        raise NotFound("Provider not found.")
    if prov["clinic_id"] != payload.clinic_id:
        raise ValidationFailed("The selected provider does not belong to the selected clinic.")
    if prov["status"] != "active":
        raise ValidationFailed("This provider is not currently accepting appointments.")

    if payload.receptionist_id:
        rec = await db.one(
            "SELECT id FROM receptionists WHERE id = ? AND organization_id = ?",
            (payload.receptionist_id, org_id),
        )
        if rec is None:
            raise NotFound("Receptionist not found.")

    start_dt = parse_datetime(payload.starts_at, "starts_at")
    if start_dt <= now:
        raise ValidationFailed("Appointment time must be in the future.")
    end_dt = start_dt + timedelta(minutes=svc["duration_minutes"])
    start_iso, end_iso = utc_iso(start_dt), utc_iso(end_dt)

    fingerprint = _booking_fingerprint(payload, start_iso)

    if payload.idempotency_key:
        existing = await db.one(
            "SELECT * FROM appointments WHERE organization_id = ? AND idempotency_key = ?",
            (org_id, payload.idempotency_key),
        )
        if existing is not None:
            if _row_fingerprint(existing, existing["starts_at"]) == fingerprint:
                response.status_code = status.HTTP_200_OK
                return _to_out(await _fetch_appointment_or_404(existing["id"], org_id))
            raise ConflictError(
                "This idempotency key was already used with different booking details."
            )

    appointment_id = new_id()
    try:
        async with db.transaction() as tx:
            clash = await tx.one(
                "SELECT id FROM appointments WHERE organization_id = ? AND provider_id = ? "
                "AND status IN ('booked','confirmed') AND starts_at < ? AND ends_at > ?",
                (org_id, payload.provider_id, end_iso, start_iso),
            )
            if clash:
                raise _slot_conflict_error()
            await tx.execute(
                "INSERT INTO appointments (id, organization_id, clinic_id, provider_id, service_id, receptionist_id, "
                "patient_name, patient_phone, patient_email, patient_notes, starts_at, ends_at, duration_minutes, "
                "status, source, idempotency_key, created_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', 'web', ?, ?, ?, ?)",
                (
                    appointment_id,
                    org_id,
                    payload.clinic_id,
                    payload.provider_id,
                    payload.service_id,
                    payload.receptionist_id,
                    payload.patient_name.strip(),
                    payload.patient_phone,
                    str(payload.patient_email) if payload.patient_email else None,
                    payload.patient_notes,
                    start_iso,
                    end_iso,
                    svc["duration_minutes"],
                    payload.idempotency_key,
                    principal.user_id,
                    utc_now_iso(),
                    utc_now_iso(),
                ),
            )
            await write_audit(
                principal,
                "appointment_created",
                entity_type="appointment",
                entity_id=appointment_id,
                details={
                    "starts_at": start_iso,
                    "provider_id": payload.provider_id,
                    "service_id": payload.service_id,
                    "patient_name": payload.patient_name.strip(),
                },
                tx=tx,
            )
    except ConflictError:
        raise
    except Exception as exc:
        if "UNIQUE constraint failed" in str(exc):
            if "idempotency_key" in str(exc) and payload.idempotency_key:
                existing = await db.one(
                    "SELECT * FROM appointments WHERE organization_id = ? AND idempotency_key = ?",
                    (org_id, payload.idempotency_key),
                )
                if existing is not None and _row_fingerprint(existing, existing["starts_at"]) == fingerprint:
                    response.status_code = status.HTTP_200_OK
                    return _to_out(await _fetch_appointment_or_404(existing["id"], org_id))
            raise _slot_conflict_error() from exc
        raise

    return AppointmentOut(
        id=appointment_id,
        organization_id=org_id,
        clinic_id=payload.clinic_id,
        provider_id=payload.provider_id,
        provider_name=prov["name"],
        service_id=payload.service_id,
        service_name=svc["service_name"],
        receptionist_id=payload.receptionist_id,
        patient_name=payload.patient_name.strip(),
        patient_phone=payload.patient_phone,
        patient_email=str(payload.patient_email) if payload.patient_email else None,
        patient_notes=payload.patient_notes,
        starts_at=start_iso,
        ends_at=end_iso,
        duration_minutes=svc["duration_minutes"],
        status="booked",
        cancellation_reason=None,
        source="web",
        created_at=utc_now_iso(),
        updated_at=utc_now_iso(),
    )


# ── Reschedule (update in place, audit keeps before/after) ───────────────────


@router.post("/{appointment_id}/reschedule", response_model=AppointmentOut)
async def reschedule_appointment(
    appointment_id: str,
    payload: RescheduleRequest,
    principal: Principal = Depends(require_permission("appointments:write")),
) -> AppointmentOut:
    org_id = principal.organization_id
    row = await _fetch_appointment_or_404(appointment_id, org_id)
    if row["status"] not in ("booked", "confirmed"):
        raise ConflictError(
            f"Appointments with status '{row['status']}' cannot be rescheduled. Only booked or confirmed ones can."
        )

    new_start_dt = parse_datetime(payload.starts_at, "starts_at")
    if new_start_dt <= datetime.now(UTC):
        raise ValidationFailed("New appointment time must be in the future.")
    new_end_dt = new_start_dt + timedelta(minutes=row["duration_minutes"])
    new_start_iso, new_end_iso = utc_iso(new_start_dt), utc_iso(new_end_dt)

    key = payload.idempotency_key
    if key:
        if row["idempotency_key"] == key:
            if row["starts_at"] == new_start_iso:
                return _to_out(row)  # idempotent retry: nothing to do
            raise ConflictError("This idempotency key was already used for a different reschedule.")
        other = await db.one(
            "SELECT id FROM appointments WHERE organization_id = ? AND idempotency_key = ? AND id != ?",
            (org_id, key, appointment_id),
        )
        if other:
            raise ConflictError("This idempotency key was already used for a different appointment change.")

    prov = await db.one(
        "SELECT clinic_id, status FROM providers WHERE id = ? AND organization_id = ?",
        (row["provider_id"], org_id),
    )
    if prov is None:
        raise NotFound("Provider not found.")
    if prov["status"] != "active":
        raise ValidationFailed("This provider is not currently accepting appointments.")
    if prov["clinic_id"] != row["clinic_id"]:
        raise ConflictError("Provider no longer belongs to this appointment's clinic.")

    now_iso = utc_now_iso()
    try:
        async with db.transaction() as tx:
            clash = await tx.one(
                "SELECT id FROM appointments WHERE organization_id = ? AND provider_id = ? AND id != ? "
                "AND status IN ('booked','confirmed') AND starts_at < ? AND ends_at > ?",
                (org_id, row["provider_id"], appointment_id, new_end_iso, new_start_iso),
            )
            if clash:
                raise _slot_conflict_error()
            await tx.execute(
                "UPDATE appointments SET starts_at = ?, ends_at = ?, idempotency_key = COALESCE(?, idempotency_key), "
                "updated_at = ? WHERE id = ? AND organization_id = ?",
                (new_start_iso, new_end_iso, key, now_iso, appointment_id, org_id),
            )
            await write_audit(
                principal,
                "appointment_rescheduled",
                entity_type="appointment",
                entity_id=appointment_id,
                details={
                    "before": {"starts_at": row["starts_at"], "ends_at": row["ends_at"]},
                    "after": {"starts_at": new_start_iso, "ends_at": new_end_iso},
                },
                tx=tx,
            )
    except ConflictError:
        raise
    except Exception as exc:
        if "UNIQUE constraint failed" in str(exc):
            raise _slot_conflict_error() from exc
        raise

    merged = dict(row)
    merged.update(
        starts_at=new_start_iso,
        ends_at=new_end_iso,
        idempotency_key=key or row["idempotency_key"],
        updated_at=now_iso,
    )
    return _to_out(merged)


# ── Cancel ───────────────────────────────────────────────────────────────────


@router.post("/{appointment_id}/cancel", response_model=AppointmentOut)
async def cancel_appointment(
    appointment_id: str,
    payload: CancelRequest,
    principal: Principal = Depends(require_permission("appointments:write")),
) -> AppointmentOut:
    org_id = principal.organization_id
    row = await _fetch_appointment_or_404(appointment_id, org_id)
    if row["status"] not in ("booked", "confirmed"):
        raise ConflictError(
            f"Appointments with status '{row['status']}' cannot be cancelled. Only booked or confirmed ones can."
        )
    reason = payload.reason.strip()
    now_iso = utc_now_iso()
    await db.write(
        "UPDATE appointments SET status = 'cancelled', cancellation_reason = ?, updated_at = ? "
        "WHERE id = ? AND organization_id = ?",
        (reason, now_iso, appointment_id, org_id),
    )
    await write_audit(
        principal,
        "appointment_cancelled",
        entity_type="appointment",
        entity_id=appointment_id,
        details={"reason": reason, "starts_at": row["starts_at"]},
    )
    merged = dict(row)
    merged.update(status="cancelled", cancellation_reason=reason, updated_at=now_iso)
    return _to_out(merged)


# ── Status transitions ───────────────────────────────────────────────────────


@router.patch("/{appointment_id}", response_model=AppointmentOut)
async def update_appointment_status(
    appointment_id: str,
    payload: AppointmentStatusUpdate,
    principal: Principal = Depends(require_permission("appointments:write")),
) -> AppointmentOut:
    org_id = principal.organization_id
    row = await _fetch_appointment_or_404(appointment_id, org_id)
    new_status: str = payload.status
    if row["status"] == new_status:
        return _to_out(row)  # idempotent no-op
    allowed = _STATUS_TRANSITIONS.get(row["status"], set())
    if new_status not in allowed:
        raise ConflictError(
            f"Cannot change appointment status from '{row['status']}' to '{new_status}'.",
            details={"allowed_transitions": sorted(allowed)},
        )
    now_iso = utc_now_iso()
    await db.write(
        "UPDATE appointments SET status = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
        (new_status, now_iso, appointment_id, org_id),
    )
    await write_audit(
        principal,
        "appointment_status_changed",
        entity_type="appointment",
        entity_id=appointment_id,
        details={"before": row["status"], "after": new_status},
    )
    merged: dict[str, Any] = dict(row)
    merged.update(status=new_status, updated_at=now_iso)
    return _to_out(merged)
