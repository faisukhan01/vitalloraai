"""Unit tests for the AI orchestrator (no live LLM required).

Covers: emergency detection, JSON extraction from LLM responses, system
prompt construction rules (identity, language lock, safety), and tool
argument validation. Live-model behavior is covered by the manual E2E
verification recorded in worklog.md and the integration tests in test_api.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.domain.orchestrator import _extract_json, build_system_prompt, detect_emergency  # noqa: E402
from app.domain.tools import TOOL_REGISTRY  # noqa: E402

# ── Emergency detection ───────────────────────────────────────────────────

def test_detects_english_emergencies():
    assert detect_emergency("I have severe chest pain right now")
    assert detect_emergency("my son is unconscious")
    assert detect_emergency("there is severe bleeding")


def test_detects_urdu_emergencies():
    assert detect_emergency("میرے دل کا دورا پڑ رہا ہے")


def test_normal_questions_are_not_emergencies():
    assert not detect_emergency("What time do you open on Saturday?")
    assert not detect_emergency("I want to book a dental checkup")
    assert not detect_emergency("How much does a consultation cost?")


# ── JSON extraction from LLM output ───────────────────────────────────────

def test_extracts_plain_say_json():
    assert _extract_json('{"say": "Hello there"}') == {"say": "Hello there"}


def test_extracts_json_inside_code_fence():
    text = '```json\n{"tool": "get_services", "arguments": {}}\n```'
    assert _extract_json(text) == {"tool": "get_services", "arguments": {}}


def test_extracts_json_with_surrounding_prose():
    text = 'Here is my response: {"say": "One moment please"} — hope that helps!'
    assert _extract_json(text) == {"say": "One moment please"}


def test_returns_none_for_garbage():
    assert _extract_json("I will book that for you right away.") is None


# ── System prompt rules ───────────────────────────────────────────────────

RECEPTIONIST = {
    "name": "Amara",
    "_hours_text": "Mon 09:00-17:00",
    "_capabilities": {"booking": True, "knowledge_qa": True, "callback_requests": True},
    "_escalation": {},
}
CLINIC = {"name": "Vitalora Demo Clinic", "timezone": "Asia/Karachi", "address": "12-A Jinnah Avenue", "phone": "+92-51-555-0100"}


def _prompt_for(language: str) -> str:
    return build_system_prompt(
        receptionist=RECEPTIONIST,
        clinic=CLINIC,
        org_name="Vitalora Demo Clinic",
        language=language,
        capabilities=RECEPTIONIST["_capabilities"],
        knowledge_blocks=[{"title": "Hours", "content": "Open Saturday 10:00-14:00."}],
    )


def test_prompt_locks_language():
    prompt = _prompt_for("ur")
    assert "Urdu" in prompt
    assert "Respond ONLY in Urdu" in prompt


def test_prompt_declares_ai_identity_and_safety():
    prompt = _prompt_for("en")
    assert "You are an AI receptionist" in prompt
    assert "NOT a diagnostic system" in prompt
    assert "1122" in prompt or "emergency number" in prompt


def test_prompt_contains_approved_knowledge():
    prompt = _prompt_for("en")
    assert "[Hours] Open Saturday 10:00-14:00." in prompt


def test_prompt_hides_disabled_capabilities():
    rec = {**RECEPTIONIST, "_capabilities": {"booking": False, "knowledge_qa": False, "callback_requests": False}}
    prompt = build_system_prompt(
        receptionist=rec,
        clinic=CLINIC,
        org_name="X",
        language="en",
        capabilities=rec["_capabilities"],
        knowledge_blocks=[],
    )
    assert "create_appointment" not in prompt.split("TOOL PROTOCOL")[1] or "General conversation only" in prompt


# ── Tool registry shape (spec §13) ────────────────────────────────────────

def test_all_spec_tools_registered():
    expected = {
        "get_clinic_information",
        "get_services",
        "get_provider_availability",
        "search_appointments",
        "create_appointment",
        "reschedule_appointment",
        "cancel_appointment",
        "transfer_to_human",
        "create_staff_callback_request",
    }
    assert expected == set(TOOL_REGISTRY.keys())


def test_create_appointment_rejects_bad_time():
    args = TOOL_REGISTRY["create_appointment"]
    raised = False
    try:
        args.model_validate({"patient_name": "Test Patient", "service_name": "General", "date": "2030-01-01", "time": "9am"})
    except ValueError:
        raised = True
    assert raised, "invalid time format must be rejected"
