"""Conversation orchestration for the AI receptionist (spec §7/§8).

Pipeline per user turn:
  1. Safety pre-check (emergency keywords -> immediate escalation, no LLM).
  2. RAG: retrieve approved clinic knowledge (FTS5) to ground answers.
  3. LLM with an explicit system prompt + structured tool protocol
     ({"tool": name, "arguments": {...}} or {"say": text}).
  4. Execute at most MAX_TOOL_ITERATIONS validated tools, then take the
     final spoken text.

Design rules honored here:
- The receptionist always identifies itself as an AI.
- Medical safety: never diagnose, never prescribe, emergencies escalate.
- The LLM cannot execute SQL or admin commands - only the validated tools.
- Grounded answers: healthcare facts come from the clinic's approved
  knowledge base; anything else is general conversation the configured
  LLM is capable of, and the prompt forbids inventing clinic facts.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from app.core.errors import AppError, ProviderError
from app.db.client import db
from app.domain.tools import TOOL_DESCRIPTIONS, ToolContext, execute_tool
from app.providers.base import get_llm

logger = logging.getLogger(__name__)

MAX_TOOL_ITERATIONS = 4
MAX_HISTORY_MESSAGES = 12
# Voice latency: short spoken replies synthesize faster (TTS cost is roughly
# linear in characters), need fewer synthesis requests, and sound natural on
# a phone call. 220 tokens comfortably covers 2 short sentences.
VOICE_MAX_TOKENS = 220

LANGUAGE_NAMES = {"en": "English", "ur": "Urdu (اردو)", "hi": "Hindi (हिन्दी)", "ar": "Arabic (العربية)"}

# Emergency triage keywords (English + Urdu/Hindi transliterations).
# Checked BEFORE the LLM so urgent situations are never delayed by a
# routine booking attempt (spec §8: never delay emergency care).
EMERGENCY_PATTERNS = [
    "heart attack", "stroke", "unconscious", "not breathing", "can't breathe", "cannot breathe",
    "severe bleeding", "bleeding heavily", "suicide", "kill myself", "overdose", "chest pain",
    "seizure", "convulsion", "drowning", "emergency",
    "دل کا دورا", "سانس نہیں", "خون", "خودکشی", "ایمرجنسی",
    "दिल का दौरा", "सांस नहीं", "खून", "आत्महत्या", "इमरजेंसी",
]


def detect_emergency(text: str) -> bool:
    lowered = text.lower()
    return any(p in lowered for p in EMERGENCY_PATTERNS)


async def search_knowledge(org_id: str, query: str, limit: int = 3) -> list[dict]:
    """FTS5 retrieval over approved clinic knowledge (org-scoped)."""
    sanitized = re.sub(r"[\"'^*():\-]", " ", query).strip()
    if not sanitized:
        return []
    try:
        rows = await db.execute(
            "SELECT c.id AS chunk_id, c.document_id, d.title, c.content, "
            "bm25(knowledge_chunks_fts) AS score "
            "FROM knowledge_chunks_fts f "
            "JOIN knowledge_chunks c ON c.rowid = f.rowid "
            "JOIN knowledge_documents d ON d.id = c.document_id AND d.organization_id = ? AND d.status = 'indexed' "
            "WHERE knowledge_chunks_fts MATCH ? "
            "ORDER BY score LIMIT ?",
            (org_id, sanitized, limit),
        )
    except Exception:  # noqa: BLE001 - malformed query falls back to LIKE
        like = f"%{sanitized[:60]}%"
        rows = await db.execute(
            "SELECT c.id AS chunk_id, c.document_id, d.title, c.content, 0 AS score "
            "FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id "
            "WHERE c.organization_id = ? AND d.status = 'indexed' AND c.content LIKE ? LIMIT ?",
            (org_id, like, limit),
        )
    return rows


def build_system_prompt(
    *,
    receptionist: dict,
    clinic: dict,
    org_name: str,
    language: str,
    capabilities: dict,
    knowledge_blocks: list[dict],
) -> str:
    lang_name = LANGUAGE_NAMES.get(language, "English")
    clinic_hours = receptionist.get("_hours_text") or "Contact the clinic for hours."
    now_local = datetime.now(ZoneInfo(clinic.get("timezone") or "UTC"))

    capabilities_text = []
    if capabilities.get("booking", True):
        capabilities_text.append("- Booking, rescheduling and cancelling appointments (using tools; always check availability first)")
    if capabilities.get("knowledge_qa", True):
        capabilities_text.append("- Answering questions about the clinic using ONLY the approved knowledge provided to you")
    if capabilities.get("callback_requests", True):
        capabilities_text.append("- Requesting a staff callback when the caller prefers one")

    knowledge_text = ""
    if knowledge_blocks:
        joined = "\n\n".join(f"[{k['title']}] {k['content']}" for k in knowledge_blocks)
        knowledge_text = f"""
APPROVED CLINIC KNOWLEDGE (the only source for clinic facts - never invent or contradict it):
{joined}
"""

    return f"""You are "{receptionist['name']}", the AI voice receptionist of {clinic['name']} (organization: {org_name}).

IDENTITY AND HONESTY (non-negotiable):
- You are an AI receptionist. If asked, you say so clearly. Never claim to be a human.
- Never invent appointments, opening hours, providers, prices, or policies. Use tools for live data.
- Never claim to have accessed medical records. You cannot see any patient records.
- Current local date/time at the clinic: {now_local.strftime('%A, %Y-%m-%d %H:%M')} ({clinic.get('timezone', 'UTC')}).

LANGUAGE:
- Respond ONLY in {lang_name}, no matter which language the caller uses.
- Keep spoken answers SHORT: at most 2 short sentences (under 40 words). This is a phone conversation.

YOUR CAPABILITIES:
{chr(10).join(capabilities_text) if capabilities_text else "- General conversation only."}

CLINIC FACTS:
- Clinic: {clinic['name']}
- Address: {clinic.get('address') or 'not provided'}
- Phone: {clinic.get('phone') or 'not provided'}
- Opening hours: {clinic_hours}
{knowledge_text}
BOOKING RULES (each extra tool call adds seconds of silence for the caller - minimize them):
1. Identify the service and preferred date from what the caller said.
2. Call get_provider_availability ONCE - a single call already covers every provider for that date. NEVER repeat a tool call with the same arguments in the same turn.
3. In ONE reply, offer 1-3 concrete options and collect the caller's full name (and phone if given).
4. Repeat ALL details back and get explicit confirmation ("yes").
5. Call create_appointment. Only after the tool returns booked:true, confirm to the caller - never before.

MEDICAL SAFETY (non-negotiable):
- You are NOT a diagnostic system. Do not interpret symptoms, do not prescribe medication, do not give treatment advice.
- If a caller describes a medical emergency (chest pain, severe bleeding, trouble breathing, unconsciousness, etc.), stop everything: tell them to call emergency services (1122 in Pakistan or their local number) immediately, and use transfer_to_human.
- If a caller asks medical questions beyond clinic administration, gently redirect: offer an appointment with a doctor instead.

TOOL PROTOCOL:
{TOOL_DESCRIPTIONS}
Call at most ONE tool per response, and only when live data is genuinely needed. For small talk, thanks, goodbyes and follow-ups that need no live data, reply {{"say": ...}} immediately - never call tools for general conversation.
To call a tool, respond with ONLY a JSON object: {{"tool": "<name>", "arguments": {{...}}}}
After a tool result comes back (a message starting with TOOL_RESULT), continue: either call another tool or reply with ONLY {{"say": "<what you will speak>"}}.
Every non-tool response must be exactly {{"say": "..."}}. Plain text without JSON is not acceptable.
Never mention tool names, JSON, or internal details to the caller. Speak naturally.

CONVERSATION STYLE:
- Warm, professional, concise. One question at a time.
- Do not repeat your introduction. Do not say "How can I help you" after every answer.
- If you cannot help, offer a callback or use transfer_to_human.
"""


def _plain_text_say(raw: str) -> str:
    """Best-effort spoken reply from a protocol-breaking LLM response.

    glm-4-plus occasionally answers in plain prose instead of the JSON tool
    protocol. The old behaviour was a corrective second LLM round-trip —
    ~0.6-0.9 s of dead air mid-call on a nontrivial share of turns. Instead,
    salvage the text directly: strip code fences, a leading 'say:' label and
    wrapping quotes. Only a truly EMPTY response justifies the retry.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.DOTALL).strip()
    text = re.sub(r'^"?say"?\s*:\s*', "", text, flags=re.IGNORECASE).strip()
    return text.strip('"').strip()


def _extract_json(text: str) -> dict[str, Any] | None:
    """Extract the first JSON object from an LLM response (handles fences/prose)."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.DOTALL).strip()
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        try:
            obj = json.loads(match.group(0))
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            return None
    return None


class OrchestratorResult:
    def __init__(
        self,
        *,
        say: str,
        tool_calls: list[dict[str, Any]] | None = None,
        escalated: bool = False,
        outcome_hint: str | None = None,
    ) -> None:
        self.say = say
        self.tool_calls = tool_calls or []
        self.escalated = escalated
        self.outcome_hint = outcome_hint


async def run_turn(
    *,
    ctx: ToolContext,
    receptionist: dict,
    clinic: dict,
    org_name: str,
    language: str,
    user_text: str,
) -> OrchestratorResult:
    """Process one user utterance and return what the receptionist should say."""
    capabilities = receptionist.get("_capabilities") or {}

    # 1) Emergency pre-check: bypass the LLM entirely.
    if detect_emergency(user_text):
        await execute_tool(
            "transfer_to_human",
            {"reason": "Possible medical emergency detected in caller speech."},
            ctx,
        )
        guidance = (receptionist.get("_escalation") or {}).get(
            "emergency_guidance",
            "If this is a medical emergency, please hang up and call your local emergency number now.",
        )
        return OrchestratorResult(
            say=f"{guidance} I am connecting you to our staff immediately.",
            tool_calls=[{"tool": "transfer_to_human", "arguments": {"reason": "emergency detected"}}],
            escalated=True,
            outcome_hint="transferred_to_human",
        )

    # 2) Grounded knowledge + conversation history — independent reads, run in
    #    parallel to shave a Turso round-trip off every turn.
    history_rows: list = []
    knowledge_blocks: list[dict] = []
    if capabilities.get("knowledge_qa", True):
        try:
            knowledge_task = search_knowledge(ctx.org_id, user_text, limit=3)
        except Exception:  # noqa: BLE001
            knowledge_task = None
    else:
        knowledge_task = None

    import asyncio as _asyncio

    history_task = db.execute(
        "SELECT role, content FROM conversation_messages WHERE session_id = ? AND role IN ('user','assistant') "
        "ORDER BY created_at DESC LIMIT ?",
        (ctx.session_id, MAX_HISTORY_MESSAGES),
    )
    gathered = await _asyncio.gather(
        knowledge_task if knowledge_task is not None else _asyncio.sleep(0, result=[]),
        history_task,
        return_exceptions=True,
    )
    kb_result, hist_result = gathered[0], gathered[1]
    if isinstance(kb_result, list):
        knowledge_blocks = kb_result
    else:
        logger.warning("knowledge retrieval failed; continuing ungrounded")
    history_rows = hist_result if isinstance(hist_result, list) else []
    history = [{"role": r["role"], "content": r["content"] or ""} for r in reversed(history_rows)]

    import time as _time

    _t_ctx = _time.perf_counter()
    logger.info("context loaded", extra={"timing_ms": int((_t_ctx - _t_turn_start) * 1000)} if (_t_turn_start := getattr(ctx, "_t_start", None)) else {})

    system_prompt = build_system_prompt(
        receptionist=receptionist,
        clinic=clinic,
        org_name=org_name,
        language=language,
        capabilities=capabilities,
        knowledge_blocks=knowledge_blocks,
    )

    llm = get_llm()
    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}, *history]
    messages.append({"role": "user", "content": user_text})

    tool_calls_made: list[dict[str, Any]] = []
    outcome_hint: str | None = None

    for iteration in range(MAX_TOOL_ITERATIONS + 1):
        raw = await llm.chat(messages, temperature=0.4, max_tokens=VOICE_MAX_TOKENS)
        parsed = _extract_json(raw)
        if parsed is None:
            # Protocol miss. Salvage plain prose as the spoken reply instead of
            # paying a corrective LLM round-trip (~0.7 s of silence per turn).
            salvage = _plain_text_say(raw)
            if salvage:
                return OrchestratorResult(say=salvage, tool_calls=tool_calls_made, outcome_hint=outcome_hint)
            # Empty response: one corrective retry with a strict reminder.
            messages.append({"role": "assistant", "content": raw[:500]})
            messages.append({"role": "user", "content": 'Respond with valid JSON only: {"tool": ...} or {"say": "..."}'})
            raw = await llm.chat(messages, temperature=0.2, max_tokens=VOICE_MAX_TOKENS)
            parsed = _extract_json(raw)
            if parsed is None:
                salvage = _plain_text_say(raw)
                if salvage:
                    return OrchestratorResult(say=salvage, tool_calls=tool_calls_made, outcome_hint=outcome_hint)
                raise ProviderError("The AI receptionist could not produce a valid response.")

        if "tool" in parsed:
            tool_name = str(parsed.get("tool", ""))
            tool_args = parsed.get("arguments") or {}
            try:
                result = await execute_tool(tool_name, tool_args, ctx)
            except AppError as exc:
                # Honest feedback to the model; it must recover gracefully.
                result = {"error": True, "message": exc.message}
            except Exception:  # noqa: BLE001
                logger.exception("tool execution failed")
                result = {"error": True, "message": "The action failed on the server."}
            tool_calls_made.append({"tool": tool_name, "arguments": tool_args})
            if tool_name == "transfer_to_human" and not result.get("error"):
                outcome_hint = "transferred_to_human"
            if tool_name == "create_appointment" and not result.get("error"):
                outcome_hint = "appointment_booked"
            if tool_name == "cancel_appointment" and not result.get("error"):
                outcome_hint = "appointment_cancelled"
            if tool_name == "reschedule_appointment" and not result.get("error"):
                outcome_hint = "appointment_rescheduled"
            if tool_name == "create_staff_callback_request" and not result.get("error"):
                outcome_hint = outcome_hint or "callback_requested"
            messages.append({"role": "assistant", "content": json.dumps(parsed, ensure_ascii=False)})
            messages.append({"role": "user", "content": f"TOOL_RESULT: {json.dumps(result, ensure_ascii=False, default=str)}"})
            continue

        say = str(parsed.get("say", "")).strip()
        if not say:
            messages.append({"role": "assistant", "content": json.dumps(parsed, ensure_ascii=False)})
            messages.append({"role": "user", "content": 'Your "say" field was empty. Reply with {"say": "<short spoken reply>"}.'})
            continue
        return OrchestratorResult(say=say, tool_calls=tool_calls_made, outcome_hint=outcome_hint)

    # Tool budget exhausted without a final say.
    return OrchestratorResult(
        say="I am sorry, I could not complete that request right now. Would you like me to ask a staff member to call you back?",
        tool_calls=tool_calls_made,
        outcome_hint=outcome_hint,
    )
