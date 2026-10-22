"""VITALORA AI — backend API integration tests (Task 3-e).

Runs the real FastAPI app via httpx ASGITransport against the REAL (dev) Turso
database. Each run creates its own throwaway organizations (uuid slugs) and
deletes them at the end (FK cascade verified on this instance). The demo/seed
organization is never touched.

Note on the event loop: the shared `db` pool binds asyncio.Lock objects to the
first event loop that uses them (asyncio primitives are loop-bound in 3.12), so
all tests run on ONE persistent loop via `_run()` instead of fresh asyncio.run
loops per test.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.core.security import create_access_token, new_id, utc_now_iso
from app.db.client import db
from app.main import app

API = "/api/v1"

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


def _client(token: str | None = None) -> httpx.AsyncClient:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers=headers,
        timeout=None,  # DB round trips are slow in this environment
    )


async def _register_org(tag: str) -> dict:
    slug = f"t3e-{tag}-{uuid.uuid4().hex[:8]}"
    async with _client() as c:
        r = await c.post(
            f"{API}/auth/register-org",
            json={
                "organization": {"name": f"Test Org {slug}", "slug": slug},
                "admin": {"name": "Test Admin", "email": f"admin-{slug}@test.example", "password": "Testing12345"},
            },
        )
    assert r.status_code == 201, r.text
    body = r.json()
    return {"org_id": body["organization"]["id"], "token": body["access_token"], "slug": slug}


async def _setup() -> dict:
    org_a = await _register_org("a")
    org_b = await _register_org("b")
    st: dict = {"org_a": org_a, "org_b": org_b}

    async with _client(org_a["token"]) as c:
        r = await c.post(f"{API}/clinics", json={"name": "Test Clinic", "timezone": "UTC"})
        assert r.status_code == 201, r.text
        st["clinic"] = r.json()

        r = await c.post(
            f"{API}/services",
            json={
                "clinic_id": st["clinic"]["id"],
                "name": "Consultation",
                "duration_minutes": 30,
                "price_display": "PKR 1,000",
            },
        )
        assert r.status_code == 201, r.text
        st["service"] = r.json()

        r = await c.post(
            f"{API}/providers",
            json={"clinic_id": st["clinic"]["id"], "name": "Dr. Test", "specialty": "General"},
        )
        assert r.status_code == 201, r.text
        st["provider"] = r.json()

        r = await c.post(
            f"{API}/receptionists",
            json={
                "clinic_id": st["clinic"]["id"],
                "name": "Aria",
                "languages": ["en"],
                "primary_language": "en",
                "status": "active",
                "greeting_message": "Hello!",
            },
        )
        assert r.status_code == 201, r.text
        st["receptionist"] = r.json()

        marker = f"magnesium-therapy-{uuid.uuid4().hex[:6]}"
        r = await c.post(
            f"{API}/knowledge/documents",
            json={
                "title": "Therapies",
                "source_type": "faq",
                "content_text": (
                    f"Our clinic offers {marker} sessions.\n\n"
                    "Magnesium therapy helps with muscle recovery and sleep quality. "
                    "Sessions last forty minutes and need a booking in advance."
                ),
            },
        )
        assert r.status_code == 201, r.text
        st["knowledge_marker"] = marker

        # Claims-only principal for permission tests (no DB user row needed).
        st["analyst_token"] = create_access_token(user_id=new_id(), org_id=org_a["org_id"], role="analyst")
    return st


async def _teardown(st: dict) -> None:
    for org in (st["org_a"], st["org_b"]):
        await db.write("DELETE FROM organizations WHERE id = ?", (org["org_id"],))
        leftover = await db.one("SELECT COUNT(*) AS n FROM clinics WHERE organization_id = ?", (org["org_id"],))
        assert leftover["n"] == 0, "FK cascade cleanup failed for test org"


@pytest.fixture(scope="module")
def state():
    st = _run(_setup())
    yield st
    _run(_teardown(st))


# ── Clinics ───────────────────────────────────────────────────────────────────


def test_clinic_create_list_hours_and_duplicate_slug(state):
    async def go():
        async with _client(state["org_a"]["token"]) as c:
            r = await c.get(f"{API}/clinics")
            assert r.status_code == 200, r.text
            ids = [item["id"] for item in r.json()["items"]]
            assert state["clinic"]["id"] in ids
            assert state["clinic"]["slug"] == "test-clinic"  # auto-slug from name

            # Weekly hours: plain array per shared-types ClinicHours[].
            r = await c.get(f"{API}/clinics/{state['clinic']['id']}/hours")
            assert r.status_code == 200, r.text
            days = r.json()
            assert isinstance(days, list) and len(days) == 7
            assert all(d["clinic_id"] == state["clinic"]["id"] for d in days)
            assert all(d["organization_id"] == state["org_a"]["org_id"] for d in days)
            assert sum(1 for d in days if not d["is_closed"]) == 6

            r = await c.post(f"{API}/clinics", json={"name": "Test Clinic"})
            assert r.status_code == 409, r.text  # duplicate slug within org

    _run(go())


# ── Receptionists ────────────────────────────────────────────────────────────


def test_receptionist_invalid_language_422_and_list_with_clinic_name(state):
    async def go():
        async with _client(state["org_a"]["token"]) as c:
            r = await c.post(
                f"{API}/receptionists",
                json={
                    "clinic_id": state["clinic"]["id"],
                    "name": "Bad Lang",
                    "languages": ["xx"],
                    "primary_language": "xx",
                },
            )
            assert r.status_code == 422, r.text

            r = await c.get(f"{API}/receptionists")
            assert r.status_code == 200, r.text
            items = r.json()["items"]
            assert "Aria" in [i["name"] for i in items]
            assert all(i["clinic_name"] for i in items), "list must include clinic name via JOIN"

    _run(go())


# ── Appointments: availability, booking, conflict, idempotency, cancel ──────


def test_availability_booking_conflict_idempotency_cancel(state):
    async def go():
        org_a, org_b = state["org_a"], state["org_b"]
        service, provider, clinic = state["service"], state["provider"], state["clinic"]

        async with _client(org_a["token"]) as c:
            start_date = (datetime.now(UTC).date() + timedelta(days=3)).isoformat()
            r = await c.get(
                f"{API}/appointments/availability",
                params={"service_id": service["id"], "date": start_date, "days": 14},
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["service_id"] == service["id"]
            # Flat slot list (shared-types {slots: AvailabilitySlot[]} contract).
            slots = body["slots"]
            assert len(slots) >= 3, "expected several available slots over the window"
            assert all(s["day"] for s in slots), "each slot carries its local calendar day"
            state["free_slot"] = slots[2]

            payload = {
                "clinic_id": clinic["id"],
                "provider_id": provider["id"],
                "service_id": service["id"],
                "patient_name": "Test Patient",
                "patient_phone": "+92-300-000-0001",
                "starts_at": slots[0]["starts_at"],
            }
            r = await c.post(f"{API}/appointments", json=payload)
            assert r.status_code == 201, r.text
            appt = r.json()
            assert appt["status"] == "booked"
            assert appt["provider_name"] == provider["name"]
            assert appt["service_name"] == service["name"]

            # Same provider + slot again → 409 conflict (no double booking).
            r2 = await c.post(f"{API}/appointments", json={**payload, "patient_name": "Other Patient"})
            assert r2.status_code == 409, r2.text

            # Idempotent retry: same key + same payload → same appointment, no duplicate.
            idem = {
                "clinic_id": clinic["id"],
                "provider_id": provider["id"],
                "service_id": service["id"],
                "patient_name": "Idem Patient",
                "starts_at": slots[1]["starts_at"],
                "idempotency_key": "key-123",
            }
            r3 = await c.post(f"{API}/appointments", json=idem)
            assert r3.status_code == 201, r3.text
            r4 = await c.post(f"{API}/appointments", json=idem)
            assert r4.status_code == 200, r4.text
            assert r4.json()["id"] == r3.json()["id"]
            state["idem_appt"] = r3.json()

            # Same key with different payload → 409.
            r5 = await c.post(f"{API}/appointments", json={**idem, "patient_name": "Different Patient"})
            assert r5.status_code == 409, r5.text

            # Second active appointment for the reschedule-conflict test.
            r_b = await c.post(f"{API}/appointments", json={**payload, "patient_name": "Second Patient", "starts_at": slots[3]["starts_at"]})
            assert r_b.status_code == 201, r_b.text
            state["appt_b"] = r_b.json()

            # Cancel with reason.
            r6 = await c.post(f"{API}/appointments/{appt['id']}/cancel", json={"reason": "Patient called to cancel."})
            assert r6.status_code == 200, r6.text
            assert r6.json()["status"] == "cancelled"
            assert r6.json()["cancellation_reason"] == "Patient called to cancel."

            # Cancel again → 409 (terminal state).
            r7 = await c.post(f"{API}/appointments/{appt['id']}/cancel", json={"reason": "Again"})
            assert r7.status_code == 409, r7.text

            # Filtered list finds the cancelled appointment.
            r8 = await c.get(f"{API}/appointments", params={"status": "cancelled"})
            assert r8.status_code == 200
            assert any(a["id"] == appt["id"] for a in r8.json()["items"])

        # Cross-org access must not leak: org B cannot see org A's appointment.
        async with _client(org_b["token"]) as c:
            r = await c.get(f"{API}/appointments/{appt['id']}")
            assert r.status_code == 404, r.text

    _run(go())


def test_reschedule_updates_slot_audits_and_conflicts(state):
    async def go():
        appt, free_slot = state["idem_appt"], state["free_slot"]
        async with _client(state["org_a"]["token"]) as c:
            r = await c.post(
                f"{API}/appointments/{appt['id']}/reschedule",
                json={"starts_at": free_slot["starts_at"], "idempotency_key": "resched-1"},
            )
            assert r.status_code == 200, r.text
            assert r.json()["starts_at"] == free_slot["starts_at"]

            # Idempotent retry with same key + same target time.
            r2 = await c.post(
                f"{API}/appointments/{appt['id']}/reschedule",
                json={"starts_at": free_slot["starts_at"], "idempotency_key": "resched-1"},
            )
            assert r2.status_code == 200, r2.text

            # Conflict: move the other appointment onto the now-occupied slot.
            r3 = await c.post(
                f"{API}/appointments/{state['appt_b']['id']}/reschedule",
                json={"starts_at": free_slot["starts_at"]},
            )
            assert r3.status_code == 409, r3.text

            # Audit trail captured the reschedule with before/after.
            r4 = await c.get(f"{API}/audit", params={"action": "appointment_rescheduled"})
            assert r4.status_code == 200
            assert r4.json()["total"] >= 1
            details = r4.json()["items"][0]["details"]
            assert "before" in details and "after" in details

    _run(go())


def test_appointment_status_transitions(state):
    async def go():
        appt = state["appt_b"]
        async with _client(state["org_a"]["token"]) as c:
            r = await c.patch(f"{API}/appointments/{appt['id']}", json={"status": "confirmed"})
            assert r.status_code == 200, r.text
            assert r.json()["status"] == "confirmed"

            r = await c.patch(f"{API}/appointments/{appt['id']}", json={"status": "completed"})
            assert r.status_code == 200, r.text
            assert r.json()["status"] == "completed"

            # completed is terminal for PATCH transitions.
            r = await c.patch(f"{API}/appointments/{appt['id']}", json={"status": "confirmed"})
            assert r.status_code == 409, r.text

    _run(go())


# ── Knowledge base ───────────────────────────────────────────────────────────


def test_knowledge_fts_search_reindex_and_bad_syntax(state):
    async def go():
        async with _client(state["org_a"]["token"]) as c:
            r = await c.get(f"{API}/knowledge/search", params={"q": "magnesium therapy"})
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["mode"] == "fts"
            assert "Therapies" in [h["document_title"] for h in body["results"]]

            docs = await c.get(f"{API}/knowledge/documents")
            assert docs.status_code == 200
            doc = next(d for d in docs.json()["items"] if d["title"] == "Therapies")
            assert doc["chunk_count"] >= 1

            r = await c.post(f"{API}/knowledge/documents/{doc['id']}/reindex")
            assert r.status_code == 200, r.text
            assert r.json()["chunk_count"] >= 1
            assert r.json()["status"] == "indexed"

            # FTS operator soup must not 500 (sanitized, or LIKE fallback).
            r = await c.get(
                f"{API}/knowledge/search",
                params={"q": 'magnesium AND (sleep OR "recovery" NEAR'},
            )
            assert r.status_code == 200, r.text
            assert "Therapies" in [h["document_title"] for h in r.json()["results"]]

    _run(go())


# ── Analytics ────────────────────────────────────────────────────────────────


def test_analytics_overview_and_series(state):
    async def go():
        async with _client(state["org_a"]["token"]) as c:
            r = await c.get(f"{API}/analytics/overview")
            assert r.status_code == 200, r.text
            body = r.json()
            # DashboardOverview contract fields, all real numbers.
            for field in (
                "appointments_today",
                "appointments_upcoming",
                "calls_last_24h",
                "calls_last_7d",
                "bookings_via_voice_7d",
                "escalations_open",
                "receptionists_active",
                "receptionists_total",
            ):
                assert isinstance(body[field], int), field
            assert body["receptionists_total"] >= 1
            assert body["date_basis"] == "utc"

            r = await c.get(f"{API}/analytics/series", params={"days": 7})
            assert r.status_code == 200, r.text
            body = r.json()
            assert len(body["series"]) == 7
            assert isinstance(body["outcomes"], list)
            assert isinstance(body["languages"], list)

    _run(go())


# ── Audit & permissions ──────────────────────────────────────────────────────


def test_audit_log_and_role_permissions(state):
    async def go():
        async with _client(state["org_a"]["token"]) as c:
            r = await c.get(f"{API}/audit", params={"action": "appointment_created"})
            assert r.status_code == 200, r.text
            assert r.json()["total"] >= 1

        # Analyst (read-only role): may read clinics/audit, may not write.
        async with _client(state["analyst_token"]) as c:
            r = await c.post(f"{API}/clinics", json={"name": "Nope Clinic"})
            assert r.status_code == 403, r.text

            r = await c.get(f"{API}/audit")
            assert r.status_code == 200, r.text

            r = await c.post(f"{API}/knowledge/documents", json={"title": "Nope Doc"})
            assert r.status_code == 403, r.text

    _run(go())


# ── Voice sessions + calls read-out + callbacks ──────────────────────────────


def test_voice_session_lifecycle_calls_and_callbacks(state):
    async def go():
        async with _client(state["org_a"]["token"]) as c:
            r = await c.post(
                f"{API}/voice/sessions",
                json={"receptionist_id": state["receptionist"]["id"], "language": "en"},
            )
            assert r.status_code == 201, r.text
            body = r.json()
            assert body["session"]["status"] == "active"
            assert body["session"]["caller_ref"].startswith("caller_")
            assert body["greeting_text"] == "Hello!"
            session_id = body["session"]["id"]

            r = await c.post(f"{API}/voice/sessions/{session_id}/end", json={"end_reason": "info_provided"})
            assert r.status_code == 200, r.text
            ended = r.json()
            assert ended["session"]["status"] == "completed"
            assert ended["session"]["outcome"] == "info_provided"
            assert ended["session"]["duration_seconds"] >= 0

            # Ending again → 409.
            r = await c.post(f"{API}/voice/sessions/{session_id}/end", json={"end_reason": "caller_ended"})
            assert r.status_code == 409, r.text

            # Calls read-out shows the session.
            r = await c.get(f"{API}/calls/sessions")
            assert r.status_code == 200, r.text
            assert any(s["id"] == session_id for s in r.json()["items"])

            r = await c.get(f"{API}/calls/sessions/{session_id}/messages")
            assert r.status_code == 200, r.text
            assert r.json()["messages"] == []

        # Callbacks are created by the voice pipeline; seed one directly to test
        # the staff-facing transitions.
        callback_id = new_id()
        await db.write(
            "INSERT INTO callback_requests (id, organization_id, clinic_id, patient_name, patient_phone, reason, "
            "priority, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'normal', 'open', ?)",
            (
                callback_id,
                state["org_a"]["org_id"],
                state["clinic"]["id"],
                "Callback Tester",
                "+92-300-000-9999",
                "Wrong number left",
                utc_now_iso(),
            ),
        )
        async with _client(state["org_a"]["token"]) as c:
            r = await c.get(f"{API}/callbacks")
            assert r.status_code == 200
            assert any(cb["id"] == callback_id for cb in r.json()["items"])

            r = await c.patch(f"{API}/callbacks/{callback_id}", json={"status": "assigned"})
            assert r.status_code == 200, r.text

            r = await c.patch(f"{API}/callbacks/{callback_id}", json={"status": "completed"})
            assert r.status_code == 200, r.text
            assert r.json()["completed_at"] is not None

            # completed is terminal.
            r = await c.patch(f"{API}/callbacks/{callback_id}", json={"status": "cancelled"})
            assert r.status_code == 409, r.text

    _run(go())
