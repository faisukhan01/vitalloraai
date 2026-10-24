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

MAX_TOOL_ITERATIONS = 5
MAX_HISTORY_MESSAGES = 12
# Voice latency vs. substance: short spoken replies synthesize fast (TTS cost
# is roughly linear in characters). 300 tokens covers 3 short sentences —
# enough to actually ANSWER a general question (the old 220-token cap made
# the model cut answers off and refuse anything nontrivial) while staying
# phone-call short.
VOICE_MAX_TOKENS = 300

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
    capabilities_text.append("- General conversation: you can discuss anything a smart assistant can — general knowledge, explanations, everyday questions — and you can search the live web with the web_search tool for anything current or uncertain")

    knowledge_text = ""
    if knowledge_blocks:
        joined = "\n\n".join(f"[{k['title']}] {k['content']}" for k in knowledge_blocks)
        knowledge_text = f"""
APPROVED CLINIC KNOWLEDGE (the only source for clinic-internal facts - never invent or contradict it):
{joined}
"""

    return f"""You are "{receptionist['name']}", the AI voice receptionist of {clinic['name']} (organization: {org_name}).

IDENTITY AND HONESTY (non-negotiable):
- You are an AI receptionist. If asked, you say so clearly. Never claim to be a human.
- If asked who built or created you, answer honestly: you are VitalLoraAI, an AI receptionist platform built and operated by the {org_name} team; the AI behind you is GLM, trained by Z.ai. Never invent a personal name or biography for yourself.
- Clinic-internal facts (hours, prices, providers, policies, ownership details): ONLY from tools or the approved knowledge. If the caller wants a fact you truly cannot know, say so honestly and offer a callback.
- Never claim to have accessed medical records. You cannot see any patient records.
- Current local date/time at the clinic: {now_local.strftime('%A, %Y-%m-%d %H:%M')} ({clinic.get('timezone', 'UTC')}).

LANGUAGE:
- Respond ONLY in {lang_name}, no matter which language the caller uses.
- Keep spoken answers conversational: actually answer first, then stay brief — 1-4 short sentences for simple questions (under 60 words). This is a voice conversation — never refuse to answer just to stay brief.

YOUR CAPABILITIES:
{chr(10).join(capabilities_text) if capabilities_text else "- General conversation only."}

CLINIC FACTS:
- Clinic: {clinic['name']}
- Address: {clinic.get('address') or 'not provided'}
- Phone: {clinic.get('phone') or 'not provided'}
- Opening hours: {clinic_hours}
{knowledge_text}
GENERAL KNOWLEDGE (act like a smart assistant, not a locked FAQ):
- You can talk about ANYTHING a smart assistant can: general knowledge, explanations, how things work, history, science, tech, sports, movies, math, dates, advice, small talk, jokes — answer directly from your own knowledge, exactly like ChatGPT would.
- NEVER say "I don't have that data", "I can only help with appointments", or redirect to clinic matters for questions you plainly know the answer to. You are a full general-purpose assistant who also happens to run the front desk.
- For anything current, specific, or uncertain (news, weather, latest versions, prices outside the clinic, recent events), use the web_search tool once, then answer from the results.
- Plain text answers are spoken aloud, so write naturally for the ear: no markdown, no symbols (#, *, -), no lists, no URLs.

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
Call at most ONE tool per response, and only when live data is genuinely needed. For small talk, thanks, goodbyes, general knowledge and follow-ups that need no live data, reply {{"say": ...}} immediately - never call tools for things you already know.
To call a tool, respond with ONLY a JSON object: {{"tool": "<name>", "arguments": {{...}}}}
After a tool result comes back (a message starting with TOOL_RESULT), continue: either call another tool or reply with ONLY {{"say": "<what you will speak>"}}.
Every non-tool response must be exactly {{"say": "..."}}. Plain text without JSON is not acceptable.
Never mention tool names, JSON, or internal details to the caller. Speak naturally.

CONVERSATION STYLE (talk like ChatGPT's voice mode — a brilliant, easygoing friend — NOT a scripted call-center agent):
- Sound like a real person talking: warm, relaxed, curious. Use contractions (I'm, that's, you'll), everyday words and natural fillers sparingly ("Oh nice!", "Got it", "Hmm, good question", "Alright").
- VARY your openers and reactions — never repeat the same phrase twice in a row, never start every reply with "Sure" or "I'd be happy to". React to the CONTENT first ("Oh really?", "That's a great one") then answer.
- Actually answer the question fully first — never dodge, never give a hollow acknowledgment instead of substance. Then keep it conversational: 1-4 short spoken sentences for simple things; for bigger questions a few more short sentences are fine, but always in flowing spoken prose, never a recited list.
- Match the caller's energy and mood: keep it light when they're light, be extra warm if they seem confused or upset, be efficient if they're in a hurry.
- It's natural to ask a short follow-up question when it helps ("Do you want me to book that for you?", "Which day works better?") — but only one at a time.
- Do not repeat your introduction. Do not say "How can I help you" after every answer. Do not over-apologize.
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
        say: str | None,
        tool_calls: list[dict[str, Any]] | None = None,
        escalated: bool = False,
        outcome_hint: str | None = None,
        _streamed: bool = False,
    ) -> None:
        # say=None + _streamed=True: the spoken text was delivered to the
        # caller incrementally via "say_delta" events before this result.
        self.say = say
        self.tool_calls = tool_calls or []
        self.escalated = escalated
        self.outcome_hint = outcome_hint
        self.streamed = _streamed


async def run_turn(
    *,
    ctx: ToolContext,
    receptionist: dict,
    clinic: dict,
    org_name: str,
    language: str,
    user_text: str,
    _messages: list[dict[str, str]] | None = None,
    _tool_calls_made: list[dict[str, Any]] | None = None,
    _outcome_hint: str | None = None,
) -> OrchestratorResult:
    """Process one user utterance and return what the receptionist should say.

    The _messages/_tool_calls_made/_outcome_hint parameters continue an
    in-flight turn (used when the streaming variant fails mid-call); tools
    already executed are NOT re-run.
    """
    capabilities = receptionist.get("_capabilities") or {}

    if _messages is not None:
        # Continuation: skip setup, jump straight into the LLM loop with the
        # conversation state streamed so far (including any TOOL_RESULT turns).
        messages = _messages
        tool_calls_made: list[dict[str, Any]] = _tool_calls_made or []
        outcome_hint: str | None = _outcome_hint
        llm = get_llm()
        for _iteration in range(MAX_TOOL_ITERATIONS + 1):
            raw = await llm.chat(messages, temperature=0.7, max_tokens=VOICE_MAX_TOKENS)
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
                    result = {"error": True, "message": exc.message}
                except Exception:  # noqa: BLE001
                    logger.exception("tool execution failed")
                    result = {"error": True, "message": "The action failed on the server."}
                tool_calls_made.append({"tool": tool_name, "arguments": tool_args})
                messages.append({"role": "assistant", "content": json.dumps(parsed, ensure_ascii=False)})
                messages.append({"role": "user", "content": f"TOOL_RESULT: {json.dumps(result, ensure_ascii=False, default=str)}"})
                continue
            say = str(parsed.get("say", "")).strip()
            if not say:
                raise ProviderError("The AI receptionist could not produce a valid response.")
            return OrchestratorResult(say=say, tool_calls=tool_calls_made, outcome_hint=outcome_hint)
        return OrchestratorResult(
            say="I am sorry, I could not complete that request right now. Would you like me to ask a staff member to call you back?",
            tool_calls=tool_calls_made,
            outcome_hint=outcome_hint,
        )

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
        raw = await llm.chat(messages, temperature=0.7, max_tokens=VOICE_MAX_TOKENS)
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


# ─────────────────────────────────────────────────────────────────────────────
# Streaming turn: yields say-text fragments while the LLM is still generating
# so the first sentence can be synthesized (and spoken) ~0.5-1s earlier.
# ─────────────────────────────────────────────────────────────────────────────


class _SayStreamExtractor:
    """Incrementally extract the string value of {"say": "<...>"} from deltas.

    The LLM replies with exactly {"say": "..."} (or {"tool": ...}). While the
    say-value streams in, this extractor hands unescaped fragments to the
    caller so TTS can start on the first completed sentence — before the model
    has even finished the reply. Non-say responses (tools, garbage) yield
    nothing and are parsed conventionally at stream end.
    """

    IDLE = 0        # still looking for the "say" key
    SEEN_KEY = 1    # matched "say" (or 'say'), waiting for ':' and opening '"'
    IN_STRING = 2   # inside the say string value
    DONE = 3        # closing quote seen; everything after is ignored

    def __init__(self) -> None:
        self.state = self.IDLE
        self._pending = ""   # lookahead buffer while IDLE/SEEN_KEY
        self._escape = False
        self._unicode = ""   # partial \uXXXX sequence

    def feed(self, delta: str) -> list[str]:
        """Consume a delta; return unescaped say-text fragments (possibly [])."""
        if self.state == self.DONE:
            return []
        self._pending += delta
        out: list[str] = []

        if self.state == self.IDLE:
            # Match '"say"' (double or single quoted) as a JSON key.
            m = re.search(r"[\"']say[\"']\s*:\s*", self._pending)
            if m:
                self._pending = self._pending[m.end():]
                self.state = self.SEEN_KEY
            else:
                # Keep a small tail in case a key is split across deltas.
                if len(self._pending) > 32:
                    # Give up on say-key detection if the response is clearly
                    # something else (plain prose / {"tool"...}) — but only
                    # AFTER we've seen enough to be sure '"say"' isn't forming.
                    if '"say"' not in self._pending and "'say'" not in self._pending:
                        self.state = self.DONE
                    self._pending = self._pending[-16:]
                return out

        if self.state == self.SEEN_KEY:
            # Skip optional whitespace and expect the opening quote.
            m = re.match(r"\s*[\"']", self._pending)
            if m:
                self._pending = self._pending[m.end():]
                self.state = self.IN_STRING
            else:
                if len(self._pending) > 8:  # 'null', '{', etc. — not a string
                    self.state = self.DONE
                return out

        # IN_STRING: emit chars, honoring escapes and partial \uXXXX.
        i = 0
        buf = self._pending
        while i < len(buf):
            ch = buf[i]
            if self._unicode:
                self._unicode += ch
                if len(self._unicode) == 4:
                    try:
                        out.append(chr(int(self._unicode, 16)))
                    except ValueError:
                        out.append(self._unicode)  # malformed — surface raw
                    self._unicode = ""
                i += 1
                continue
            if self._escape:
                self._escape = False
                if ch == "u":
                    self._unicode = ""
                elif ch == "n":
                    out.append("\n")
                elif ch == "t":
                    out.append("\t")
                elif ch == "r":
                    out.append("\r")
                else:
                    out.append(ch)  # \" \\ \/ etc.
                i += 1
                continue
            if ch == "\\":
                self._escape = True
                i += 1
                continue
            if ch == '"':
                self.state = self.DONE
                self._pending = ""
                return out
            out.append(ch)
            i += 1
        self._pending = ""
        return out

    @property
    def active(self) -> bool:
        """True while a say-string is being streamed (IN_STRING)."""
        return self.state == self.IN_STRING


async def stream_turn(
    *,
    ctx: ToolContext,
    receptionist: dict,
    clinic: dict,
    org_name: str,
    language: str,
    user_text: str,
):
    """Async generator version of run_turn.

    Yields:
      ("tool", {"tool": ..., "arguments": ...})  — a tool call was made
      ("say_delta", str)                          — spoken-text fragment
      ("final", OrchestratorResult)               — always last

    Tool-decision rounds are short, so they are buffered normally; only the
    say-value streams. Falls back to run_turn() semantics on any failure so a
    streaming hiccup can never break a call.
    """
    llm = get_llm()
    if not hasattr(llm, "chat_stream"):
        result = await run_turn(
            ctx=ctx, receptionist=receptionist, clinic=clinic,
            org_name=org_name, language=language, user_text=user_text,
        )
        yield ("final", result)
        return

    capabilities = receptionist.get("_capabilities") or {}

    if detect_emergency(user_text):
        await execute_tool(
            "transfer_to_human", {"reason": "Possible medical emergency detected in caller speech."}, ctx
        )
        guidance = (receptionist.get("_escalation") or {}).get(
            "emergency_guidance",
            "If this is a medical emergency, please hang up and call your local emergency number now.",
        )
        yield ("final", OrchestratorResult(
            say=f"{guidance} I am connecting you to our staff immediately.",
            tool_calls=[{"tool": "transfer_to_human", "arguments": {"reason": "emergency detected"}}],
            escalated=True,
            outcome_hint="transferred_to_human",
        ))
        return

    # Context (history + knowledge) — same as run_turn, parallel reads.
    import asyncio as _asyncio

    knowledge_task = None
    if capabilities.get("knowledge_qa", True):
        knowledge_task = search_knowledge(ctx.org_id, user_text, limit=3)
    history_task = db.execute(
        "SELECT role, content FROM conversation_messages WHERE session_id = ? AND role IN ('user','assistant') "
        "ORDER BY created_at DESC LIMIT ?",
        (ctx.session_id, MAX_HISTORY_MESSAGES),
    )
    kb_result, hist_result = await _asyncio.gather(
        knowledge_task if knowledge_task is not None else _asyncio.sleep(0, result=[]),
        history_task,
        return_exceptions=True,
    )
    knowledge_blocks: list[dict] = kb_result if isinstance(kb_result, list) else []
    if not isinstance(kb_result, list) and knowledge_task is not None:
        logger.warning("knowledge retrieval failed; continuing ungrounded")
    history_rows = hist_result if isinstance(hist_result, list) else []
    history = [{"role": r["role"], "content": r["content"] or ""} for r in reversed(history_rows)]

    system_prompt = build_system_prompt(
        receptionist=receptionist,
        clinic=clinic,
        org_name=org_name,
        language=language,
        capabilities=capabilities,
        knowledge_blocks=knowledge_blocks,
    )

    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}, *history]
    messages.append({"role": "user", "content": user_text})

    tool_calls_made: list[dict[str, Any]] = []
    outcome_hint: str | None = None

    for _iteration in range(MAX_TOOL_ITERATIONS + 1):
        raw_parts: list[str] = []
        extractor = _SayStreamExtractor()
        say_streamed = False
        try:
            async for delta in llm.chat_stream(messages, temperature=0.7, max_tokens=VOICE_MAX_TOKENS):
                raw_parts.append(delta)
                for frag in extractor.feed(delta):
                    if not say_streamed and not frag.strip():
                        continue  # skip leading whitespace before the first fragment
                    say_streamed = True
                    yield ("say_delta", frag)
        except ProviderError:
            if not say_streamed:
                # Nothing spoken yet: fall back to the battle-tested
                # non-streaming turn (tools already executed are NOT re-run).
                logger.warning("llm stream failed; falling back to non-streaming turn")
                result = await run_turn(
                    ctx=ctx, receptionist=receptionist, clinic=clinic,
                    org_name=org_name, language=language, user_text=user_text,
                    _messages=messages, _tool_calls_made=tool_calls_made, _outcome_hint=outcome_hint,
                )
                yield ("final", result)
                return
            # Partial say already streamed/dispatched: falling back would
            # duplicate the spoken prefix. End the turn with what was said.
            logger.warning("llm stream failed after partial say; ending turn with partial reply")
            yield ("final", OrchestratorResult(
                say=None, tool_calls=tool_calls_made, outcome_hint=outcome_hint, _streamed=True,
            ))
            return

        raw = "".join(raw_parts).strip()
        # Fence strip (defensive — model rarely fences with stream off behavior).
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.DOTALL).strip()

        if extractor.active or extractor.state == _SayStreamExtractor.DONE:
            # Say-value streamed successfully; the full text is what we emitted.
            if say_streamed:
                # Wait for stream end already happened; nothing more to parse.
                yield ("final", OrchestratorResult(
                    say=None,  # sentinel: caller assembles from say_delta events
                    tool_calls=tool_calls_made,
                    outcome_hint=outcome_hint,
                    _streamed=True,
                ))
                return
            # Key seen but empty string → treat as empty say below.

        parsed = _extract_json(raw)
        if parsed is None:
            salvage = _plain_text_say(raw)
            if salvage and not say_streamed:
                yield ("say_delta", salvage)
                yield ("final", OrchestratorResult(
                    say=None, tool_calls=tool_calls_made, outcome_hint=outcome_hint, _streamed=True,
                ))
                return
            if salvage:
                yield ("final", OrchestratorResult(
                    say=None, tool_calls=tool_calls_made, outcome_hint=outcome_hint, _streamed=True,
                ))
                return
            # Empty response: one corrective retry (non-streaming, rare path).
            messages.append({"role": "assistant", "content": raw[:500]})
            messages.append({"role": "user", "content": 'Respond with valid JSON only: {"tool": ...} or {"say": "..."}'})
            retry_raw = await llm.chat(messages, temperature=0.2, max_tokens=VOICE_MAX_TOKENS)
            parsed = _extract_json(retry_raw)
            if parsed is None:
                salvage = _plain_text_say(retry_raw)
                if salvage:
                    yield ("say_delta", salvage)
                    yield ("final", OrchestratorResult(
                        say=None, tool_calls=tool_calls_made, outcome_hint=outcome_hint, _streamed=True,
                    ))
                    return
                raise ProviderError("The AI receptionist could not produce a valid response.")

        if "tool" in parsed:
            tool_name = str(parsed.get("tool", ""))
            tool_args = parsed.get("arguments") or {}
            yield ("tool", {"tool": tool_name, "arguments": tool_args})
            try:
                result = await execute_tool(tool_name, tool_args, ctx)
            except AppError as exc:
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
        if not say_streamed:
            yield ("say_delta", say)
        yield ("final", OrchestratorResult(
            say=None, tool_calls=tool_calls_made, outcome_hint=outcome_hint, _streamed=True,
        ))
        return

    # Tool budget exhausted without a final say.
    yield ("say_delta", "I am sorry, I could not complete that request right now. Would you like me to ask a staff member to call you back?")
    yield ("final", OrchestratorResult(
        say=None, tool_calls=tool_calls_made, outcome_hint=outcome_hint, _streamed=True,
    ))
