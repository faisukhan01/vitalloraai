"""Dashboard analytics endpoints computed from real SQL aggregates.

Honesty note: "today" and "last 24h" buckets are UTC calendar windows
(documented limitation — per-clinic timezone day boundaries are future work).
Success rate counts a session as successful when it ended with a resolved
outcome (anything except 'unresolved' or no outcome). Voice bookings are
counted from conversation_sessions by outcome = 'appointment_booked'.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends, Query

from app.api.v1._util import utc_iso
from app.core.deps import Principal, require_permission
from app.core.security import utc_now_iso
from app.db.client import db
from app.schemas.analytics import (
    DaySeries,
    LanguageBreakdownItem,
    OutcomeBreakdownItem,
    OverviewResponse,
    SeriesResponse,
)

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/overview", response_model=OverviewResponse)
async def analytics_overview(
    principal: Principal = Depends(require_permission("analytics:read")),
) -> OverviewResponse:
    org_id = principal.organization_id
    now = datetime.now(UTC)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow_start = today_start + timedelta(days=1)
    day_ago = now - timedelta(hours=24)
    week_ago = now - timedelta(days=7)

    row = await db.one(
        "SELECT "
        "(SELECT COUNT(*) FROM appointments WHERE organization_id = ?1 AND status IN ('booked','confirmed') "
        "  AND starts_at >= ?2 AND starts_at < ?3) AS appointments_today, "
        "(SELECT COUNT(*) FROM appointments WHERE organization_id = ?1 AND status IN ('booked','confirmed') "
        "  AND starts_at >= ?4) AS appointments_upcoming, "
        "(SELECT COUNT(*) FROM conversation_sessions WHERE organization_id = ?1 "
        "  AND started_at >= ?5) AS calls_last_24h, "
        "(SELECT COUNT(*) FROM conversation_sessions WHERE organization_id = ?1 "
        "  AND started_at >= ?6) AS calls_last_7d, "
        "(SELECT COUNT(*) FROM conversation_sessions WHERE organization_id = ?1 "
        "  AND started_at >= ?6 AND outcome = 'appointment_booked') AS bookings_via_voice_7d, "
        "(SELECT COUNT(*) FROM escalations WHERE organization_id = ?1 AND status = 'open') AS escalations_open, "
        "(SELECT COUNT(*) FROM receptionists WHERE organization_id = ?1 AND status = 'active') AS receptionists_active, "
        "(SELECT COUNT(*) FROM receptionists WHERE organization_id = ?1) AS receptionists_total, "
        "(SELECT AVG(duration_seconds) FROM conversation_sessions WHERE organization_id = ?1 "
        "  AND started_at >= ?6 AND duration_seconds IS NOT NULL) AS avg_session_seconds_7d, "
        "(SELECT AVG(CASE WHEN outcome IS NOT NULL AND outcome <> 'unresolved' THEN 1.0 ELSE 0.0 END) "
        "  FROM conversation_sessions WHERE organization_id = ?1 AND started_at >= ?6 AND status <> 'active') "
        "  AS success_rate_7d",
        (
            org_id,
            utc_iso(today_start),
            utc_iso(tomorrow_start),
            utc_iso(now),
            utc_iso(day_ago),
            utc_iso(week_ago),
        ),
    )
    return OverviewResponse(
        generated_at=utc_now_iso(),
        appointments_today=row["appointments_today"] if row else 0,
        appointments_upcoming=row["appointments_upcoming"] if row else 0,
        calls_last_24h=row["calls_last_24h"] if row else 0,
        calls_last_7d=row["calls_last_7d"] if row else 0,
        bookings_via_voice_7d=row["bookings_via_voice_7d"] if row else 0,
        escalations_open=row["escalations_open"] if row else 0,
        receptionists_active=row["receptionists_active"] if row else 0,
        receptionists_total=row["receptionists_total"] if row else 0,
        avg_session_seconds_7d=row["avg_session_seconds_7d"] if row else None,
        success_rate_7d=row["success_rate_7d"] if row else None,
    )


@router.get("/series", response_model=SeriesResponse)
async def analytics_series(
    principal: Principal = Depends(require_permission("analytics:read")),
    days: int = Query(default=7, ge=1, le=90),
) -> SeriesResponse:
    org_id = principal.organization_id
    today = datetime.now(UTC).date()
    start_day: date = today - timedelta(days=days - 1)
    since = start_day.isoformat()  # ISO strings compare lexicographically with stored timestamps

    sessions_rows = await db.execute(
        "SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS n FROM conversation_sessions "
        "WHERE organization_id = ? AND started_at >= ? GROUP BY day",
        (org_id, since),
    )
    bookings_rows = await db.execute(
        "SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS n FROM conversation_sessions "
        "WHERE organization_id = ? AND started_at >= ? AND outcome = 'appointment_booked' GROUP BY day",
        (org_id, since),
    )
    escalations_rows = await db.execute(
        "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM escalations "
        "WHERE organization_id = ? AND created_at >= ? GROUP BY day",
        (org_id, since),
    )
    outcome_rows = await db.execute(
        "SELECT IFNULL(outcome, 'none') AS outcome, COUNT(*) AS n FROM conversation_sessions "
        "WHERE organization_id = ? AND started_at >= ? GROUP BY outcome",
        (org_id, since),
    )
    language_rows = await db.execute(
        "SELECT language, COUNT(*) AS n FROM conversation_sessions "
        "WHERE organization_id = ? AND started_at >= ? GROUP BY language ORDER BY n DESC",
        (org_id, since),
    )

    sessions_by_day = {r["day"]: r["n"] for r in sessions_rows}
    bookings_by_day = {r["day"]: r["n"] for r in bookings_rows}
    escalations_by_day = {r["day"]: r["n"] for r in escalations_rows}

    series = [
        DaySeries(
            date=(start_day + timedelta(days=i)).isoformat(),
            sessions=sessions_by_day.get((start_day + timedelta(days=i)).isoformat(), 0),
            bookings=bookings_by_day.get((start_day + timedelta(days=i)).isoformat(), 0),
            escalations=escalations_by_day.get((start_day + timedelta(days=i)).isoformat(), 0),
        )
        for i in range(days)
    ]
    return SeriesResponse(
        days=days,
        series=series,
        outcomes=[OutcomeBreakdownItem(outcome=r["outcome"], count=r["n"]) for r in outcome_rows],
        languages=[LanguageBreakdownItem(language=r["language"], count=r["n"]) for r in language_rows],
    )
