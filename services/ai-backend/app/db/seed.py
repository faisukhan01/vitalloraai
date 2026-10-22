"""Idempotent development seed data.

Creates a demo organization with realistic sample data. All patient names,
phone numbers and notes are SYNTHETIC (spec §11: never use real patient data).
Seeded conversations/appointments belong to an org whose plan is 'demo', so
the UI can label them as demo data (spec §6C).

Usage: python -m app.db.seed [--reset-demo]
"""

from __future__ import annotations

import asyncio
import sys
from datetime import UTC, datetime, timedelta

from app.core.config import settings
from app.core.security import hash_password, new_id, utc_now_iso
from app.db.client import db

DEMO_SLUG = "demo"


async def seed(reset_demo: bool = False) -> None:
    existing = await db.one("SELECT id FROM organizations WHERE slug = ?", (DEMO_SLUG,))
    if existing and not reset_demo:
        print("Demo organization already seeded. Use --reset-demo to recreate.")
        return
    if existing and reset_demo:
        await db.write("DELETE FROM organizations WHERE slug = ?", (DEMO_SLUG,))
        print("Previous demo data removed (cascade).")

    password = settings.seed_admin_password or "Vitalora#Demo2024"
    now = utc_now_iso()
    org_id, user_id, clinic_id = new_id(), new_id(), new_id()

    async with db.transaction() as tx:
        await tx.execute(
            "INSERT INTO organizations (id, name, slug, plan, status, created_at, updated_at) VALUES (?, ?, ?, 'demo', 'active', ?, ?)",
            (org_id, "Vitalora Demo Clinic", DEMO_SLUG, now, now),
        )
        await tx.execute(
            "INSERT INTO users (id, organization_id, email, password_hash, name, role, status, email_verified, created_at, updated_at) "
            "VALUES (?, ?, 'admin@demo.vitalora.ai', ?, 'Demo Administrator', 'owner', 'active', 1, ?, ?)",
            (user_id, org_id, hash_password(password), now, now),
        )
        await tx.execute(
            "INSERT INTO clinics (id, organization_id, name, slug, timezone, address, phone, email, status, created_at, updated_at) "
            "VALUES (?, ?, 'Vitalora Family Health Center', 'main', 'Asia/Karachi', '12-A Jinnah Avenue, Islamabad', '+92-51-555-0100', 'frontdesk@demo.vitalora.ai', 'active', ?, ?)",
            (clinic_id, org_id, now, now),
        )
        # Hours: Mon-Fri 09:00-17:00, Sat 10:00-14:00, Sun closed
        for day, open_t, close_t, closed in [
            (0, "09:00", "17:00", 0), (1, "09:00", "17:00", 0), (2, "09:00", "17:00", 0),
            (3, "09:00", "17:00", 0), (4, "09:00", "17:00", 0), (5, "10:00", "14:00", 0),
            (6, "00:00", "00:00", 1),
        ]:
            await tx.execute(
                "INSERT INTO clinic_hours (id, organization_id, clinic_id, day_of_week, open_time, close_time, is_closed) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (new_id(), org_id, clinic_id, day, open_t, close_t, closed),
            )

        services = [
            ("General Consultation", "General practice consultation with a physician.", 30, "PKR 2,000"),
            ("Dental Checkup", "Routine dental examination and cleaning.", 45, "PKR 3,500"),
            ("Pediatric Visit", "Child health checkup and growth assessment.", 30, "PKR 2,500"),
            ("Cardiology Consultation", "Specialist heart health consultation.", 45, "PKR 5,000"),
        ]
        service_ids: dict[str, str] = {}
        for name, desc, dur, price in services:
            sid = new_id()
            service_ids[name] = sid
            await tx.execute(
                "INSERT INTO services (id, organization_id, clinic_id, name, description, duration_minutes, price_display, is_active, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
                (sid, org_id, clinic_id, name, desc, dur, price, now, now),
            )

        providers = [
            ("Dr. Ayesha Malik", "General Physician", "ayesha.malik@demo.vitalora.ai"),
            ("Dr. Bilal Raza", "Dentist", "bilal.raza@demo.vitalora.ai"),
            ("Dr. Sara Ahmed", "Pediatrician", "sara.ahmed@demo.vitalora.ai"),
        ]
        provider_ids: list[str] = []
        for name, specialty, email in providers:
            pid = new_id()
            provider_ids.append(pid)
            await tx.execute(
                "INSERT INTO providers (id, organization_id, clinic_id, name, specialty, email, status, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)",
                (pid, org_id, clinic_id, name, specialty, email, now, now),
            )

        receptionist_id = new_id()
        await tx.execute(
            "INSERT INTO receptionists (id, organization_id, clinic_id, name, persona, status, languages, primary_language, "
            "voice_provider, voice_id, speaking_speed, greeting_message, system_prompt_extra, capabilities, escalation, created_by, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                receptionist_id, org_id, clinic_id, "Amara",
                "Warm, professional front-desk assistant for a family health clinic.",
                "active", '["en","ur","hi","ar"]', "en", "zai", "tongtong", 1.0,
                "Hello! Welcome to Vitalora Family Health Center. I am Amara, the clinic's AI receptionist. How may I help you today?",
                "Keep answers short (2-3 spoken sentences). Confirm details before any booking action.",
                '{"booking":true,"knowledge_qa":true,"callback_requests":true}',
                '{"transfer_message":"I will connect you with our front-desk staff.","callback_number":"+92-51-555-0100","emergency_guidance":"For medical emergencies, hang up and call 1122 immediately."}',
                user_id, now, now,
            ),
        )

        # Synthetic future appointments (clearly demo data)
        base = datetime.now(UTC).replace(minute=0, second=0, microsecond=0) + timedelta(days=1)
        appts = [
            ("Hamza Iqbal", "+92-300-555-0101", "General Consultation", 0, 0, "booked"),
            ("Fatima Noor", "+92-300-555-0102", "Dental Checkup", 1, 1, "booked"),
            ("Ali Raza", "+92-300-555-0103", "Pediatric Visit", 2, 2, "confirmed"),
        ]
        for patient, phone, svc_name, p_idx, hour_offset, status in appts:
            start = base + timedelta(hours=9 + hour_offset)
            duration = 30 if svc_name != "Dental Checkup" else 45
            end = start + timedelta(minutes=duration)
            await tx.execute(
                "INSERT INTO appointments (id, organization_id, clinic_id, provider_id, service_id, receptionist_id, patient_name, patient_phone, "
                "patient_notes, starts_at, ends_at, duration_minutes, status, source, created_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, ?, ?)",
                (
                    new_id(), org_id, clinic_id, provider_ids[p_idx], service_ids[svc_name], receptionist_id,
                    patient, phone, "Demo data - synthetic patient record.",
                    start.isoformat(), end.isoformat(), duration, status, user_id, now, now,
                ),
            )

        # A completed demo conversation
        session_id = new_id()
        started = (datetime.now(UTC) - timedelta(hours=5)).isoformat()
        await tx.execute(
            "INSERT INTO conversation_sessions (id, organization_id, clinic_id, receptionist_id, channel, language, status, outcome, "
            "end_reason, started_at, ended_at, duration_seconds, caller_ref, created_at) "
            "VALUES (?, ?, ?, ?, 'browser', 'en', 'completed', 'info_provided', 'caller_ended', ?, ?, 96, ?, ?)",
            (session_id, org_id, clinic_id, receptionist_id, started, (datetime.now(UTC) - timedelta(hours=5, minutes=-96)).isoformat(), "caller_8f3a21c4", now),
        )
        msgs = [
            ("assistant", "Hello! Welcome to Vitalora Family Health Center. I am Amara, the clinic's AI receptionist. How may I help you today?", None),
            ("user", "What time do you open on Saturday?", None),
            ("assistant", "We are open on Saturday from 10:00 AM to 2:00 PM. Would you like to book a visit?", None),
        ]
        for role, content, tool in msgs:
            await tx.execute(
                "INSERT INTO conversation_messages (id, session_id, organization_id, role, content, tool_name, tool_payload, latency_ms, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (new_id(), session_id, org_id, role, content, tool, None, 640 if role == "assistant" else None, started),
            )

        # Knowledge documents (indexed)
        docs = [
            ("Clinic operating hours", "faq",
             "Vitalora Family Health Center is open Monday to Friday from 9:00 AM to 5:00 PM. "
             "On Saturday we are open from 10:00 AM to 2:00 PM. The clinic is closed on Sunday. "
             "For medical emergencies call 1122 (Pakistan emergency services)."),
            ("Services and pricing", "faq",
             "We offer General Consultation (30 minutes, PKR 2,000), Dental Checkup (45 minutes, PKR 3,500), "
             "Pediatric Visit (30 minutes, PKR 2,500) and Cardiology Consultation (45 minutes, PKR 5,000). "
             "Prices are displayed for guidance and may change; the front desk confirms the final amount."),
            ("Location and directions", "manual",
             "The clinic is located at 12-A Jinnah Avenue, Islamabad, on the 2nd floor of the Crescent Building. "
             "Free parking is available in basement B1. The nearest landmark is the Jinnah Convention Center."),
        ]
        for title, stype, body in docs:
            doc_id = new_id()
            await tx.execute(
                "INSERT INTO knowledge_documents (id, organization_id, clinic_id, title, source_type, content_text, status, chunk_count, uploaded_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, 'indexed', 1, ?, ?, ?)",
                (doc_id, org_id, clinic_id, title, stype, body, user_id, now, now),
            )
            await tx.execute(
                "INSERT INTO knowledge_chunks (id, organization_id, document_id, chunk_index, content, created_at) VALUES (?, ?, ?, 0, ?, ?)",
                (new_id(), org_id, doc_id, body, now),
            )

        await tx.execute(
            "INSERT INTO audit_events (id, organization_id, actor_user_id, actor_type, actor_display, action, details, created_at) "
            "VALUES (?, ?, ?, 'system', 'seed', 'demo_data_seeded', '{\"note\":\"synthetic development data\"}', ?)",
            (new_id(), org_id, user_id, now),
        )

    print("Demo organization seeded:")
    print("  login: admin@demo.vitalora.ai")
    print(f"  password: {password}  (development only, from SEED_ADMIN_PASSWORD)")
    print(f"  org slug: {DEMO_SLUG}")


def main() -> None:
    reset = "--reset-demo" in sys.argv
    asyncio.run(seed(reset_demo=reset))


if __name__ == "__main__":
    main()
