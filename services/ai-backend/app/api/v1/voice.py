"""Voice session REST endpoints.

These two endpoints create and end conversation_sessions rows for the browser
voice client. The WebSocket turn-based pipeline is implemented separately:

# WS endpoint added by lead in Phase 4b

Authentication: any authenticated principal (get_principal). Voice sessions are
org-scoped via the receptionist's clinic; no audit events are written for
session lifecycle (high-frequency, not a configuration change).
"""

from __future__ import annotations

import asyncio
import json as _json
import logging
import re
from contextlib import suppress
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, status

from app.api.v1._util import json_loads_or_none, utc_iso
from app.core.deps import Principal, get_principal, principal_from_token
from app.core.errors import AuthError, ConflictError, NotFound, ProviderError, ValidationFailed
from app.core.logging import log_extra, session_id_ctx
from app.core.security import new_caller_ref, new_id, utc_now_iso
from app.db.client import db
from app.domain.orchestrator import run_turn
from app.domain.tools import ToolContext
from app.providers.base import get_llm, get_stt, get_tts
from app.schemas.voice import (
    VoiceSessionEnd,
    VoiceSessionEndResponse,
    VoiceSessionOut,
    VoiceSessionStart,
    VoiceSessionStartResponse,
)

router = APIRouter(prefix="/voice", tags=["voice"])

# end_reason values that map directly onto the outcome enum in the schema.
_OUTCOME_REASONS = {
    "appointment_booked",
    "appointment_cancelled",
    "appointment_rescheduled",
    "callback_requested",
    "info_provided",
    "transferred_to_human",
    "unresolved",
}


def _session_out(row: dict) -> VoiceSessionOut:
    return VoiceSessionOut(
        id=row["id"],
        organization_id=row["organization_id"],
        clinic_id=row["clinic_id"],
        receptionist_id=row["receptionist_id"],
        channel=row["channel"],
        language=row["language"],
        status=row["status"],
        outcome=row["outcome"],
        end_reason=row["end_reason"],
        started_at=row["started_at"],
        ended_at=row["ended_at"],
        duration_seconds=row["duration_seconds"],
        caller_ref=row["caller_ref"],
    )


@router.post("/sessions", response_model=VoiceSessionStartResponse, status_code=status.HTTP_201_CREATED)
async def start_voice_session(
    payload: VoiceSessionStart,
    principal: Principal = Depends(get_principal),
) -> VoiceSessionStartResponse:
    org_id = principal.organization_id
    receptionist = await db.one(
        "SELECT * FROM receptionists WHERE id = ? AND organization_id = ?",
        (payload.receptionist_id, org_id),
    )
    if receptionist is None:
        raise NotFound("Receptionist not found.")
    if receptionist["status"] != "active":
        raise ConflictError("This receptionist is not active. Activate it before starting voice sessions.")

    languages = json_loads_or_none(receptionist["languages"]) or []
    language = payload.language or receptionist["primary_language"]
    if language not in languages:
        raise ValidationFailed(f"Language '{language}' is not configured for this receptionist.")

    now = utc_now_iso()
    session_id = new_id()
    caller_ref = new_caller_ref()
    await db.write(
        "INSERT INTO conversation_sessions (id, organization_id, clinic_id, receptionist_id, channel, language, "
        "status, started_at, caller_ref, created_at) VALUES (?, ?, ?, ?, 'browser', ?, 'active', ?, ?, ?)",
        (session_id, org_id, receptionist["clinic_id"], receptionist["id"], language, now, caller_ref, now),
    )
    session = VoiceSessionOut(
        id=session_id,
        organization_id=org_id,
        clinic_id=receptionist["clinic_id"],
        receptionist_id=receptionist["id"],
        channel="browser",
        language=language,
        status="active",
        started_at=now,
        caller_ref=caller_ref,
    )
    # Warm the TTS cache while the caller is still looking at the "connecting"
    # screen: the greeting (so the WS "greet" frame speaks instantly) followed
    # by the instant-ack lines and the retry phrase, so every fast path of the
    # conversation becomes a ~0ms cache hit within a few seconds.
    greeting_text = (receptionist.get("greeting_message") or "").strip()
    voice = receptionist["voice_id"]
    speed = float(receptionist["speaking_speed"] or 1.0)

    async def _warm() -> None:
        if greeting_text:
            with suppress(ProviderError, Exception):
                await get_tts().synthesize(greeting_text, voice=voice, speed=speed)
        # Warm ONLY the first ack line + the retry phrase: the provider
        # throttles bursts, and a full ack-line sweep right at session start
        # burns rate budget exactly when the caller's first turn needs it.
        # The remaining ack lines warm opportunistically via the instant-ack
        # probe (cache misses simply skip the ack).
        for line in (_ACK_LINES[0], _RETRY_SAY, _BUSY_SAY):
            with suppress(ProviderError, Exception):
                await get_tts().synthesize(line, voice=voice, speed=speed)
            await asyncio.sleep(1.2)

    _bg(_warm())
    return VoiceSessionStartResponse(session=session, greeting_text=greeting_text)


@router.post("/sessions/{session_id}/end", response_model=VoiceSessionEndResponse)
async def end_voice_session(
    session_id: str,
    payload: VoiceSessionEnd,
    principal: Principal = Depends(get_principal),
) -> VoiceSessionEndResponse:
    row = await db.one(
        "SELECT * FROM conversation_sessions WHERE id = ? AND organization_id = ?",
        (session_id, principal.organization_id),
    )
    if row is None:
        raise NotFound("Voice session not found.")
    if row["status"] != "active":
        raise ConflictError("This voice session has already ended.")

    ended = datetime.now(UTC)
    try:
        started = datetime.fromisoformat(str(row["started_at"]))  # Python 3.11+ parses the trailing 'Z' natively
    except ValueError:
        started = ended
    if started.tzinfo is None:
        started = started.replace(tzinfo=UTC)
    duration_seconds = max(0, int((ended - started).total_seconds()))

    new_status = "escalated" if payload.end_reason == "escalated" else "completed"
    outcome = payload.end_reason if payload.end_reason in _OUTCOME_REASONS else None
    ended_iso = utc_iso(ended)

    await db.write(
        "UPDATE conversation_sessions SET status = ?, outcome = ?, end_reason = ?, ended_at = ?, duration_seconds = ? "
        "WHERE id = ? AND organization_id = ?",
        (new_status, outcome, payload.end_reason, ended_iso, duration_seconds, session_id, principal.organization_id),
    )
    merged = dict(row)
    merged.update(
        status=new_status,
        outcome=outcome,
        end_reason=payload.end_reason,
        ended_at=ended_iso,
        duration_seconds=duration_seconds,
    )
    return VoiceSessionEndResponse(session=_session_out(merged))


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket turn-based voice pipeline (lead-owned, Phase 4b).
#
# Client → server (JSON text frames):
#   {"type": "audio", "data": "<base64 webm/wav utterance>"}
#   {"type": "text",  "data": "<typed utterance>"}   (keyboard fallback)
#   {"type": "end"}
# Server → client:
#   {"type": "status",   "stage": "transcribing"|"thinking"|"speaking"|"listening"}
#   {"type": "transcript", "role": "user"|"assistant", "text": "..."}
#   {"type": "tool",     "tool": "...", "arguments": {...}}        (visibility only)
#   {"type": "audio",    "format": "wav"|"mp3", "data": "<base64>"}
#   {"type": "error",    "message": "..."}
#   {"type": "ended"}
#
# Auth: the access token must be passed as ?token= (browsers cannot set
# headers on WebSocket). The session must belong to the caller's org.


ws_logger = logging.getLogger("vitalora.voice")

_RETRY_SAY = "I am sorry, I did not catch that. Could you say it again?"
_BUSY_SAY = "Sorry, our system is a little busy right now. Could you please say that again in a moment?"

# ── Instant acknowledgment backchannel ───────────────────────────────────────
# A real receptionist acknowledges instantly ("Mm-hmm", "One moment") before
# looking up the answer. We pre-synthesize short ack lines in the session's
# voice at session start; after each recognized utterance the WS loop probes
# the bridge TTS cache (~1ms) and, on a hit, speaks the ack IMMEDIATELY while
# STT→LLM→TTS for the real answer is still running. Perceived response time
# drops from ~3-4s to well under a second. Rotation keeps it human.
_ACK_LINES = (
    "Mm-hmm.",
    "One moment, please.",
    "Sure, let me check that for you.",
)
_ack_counter = 0


async def _load_turn_context(session_id: str, org_id: str) -> tuple[dict, dict, dict, ToolContext, dict, str]:
    """Load everything the WS loop needs; raise NotFound/ConflictError on mismatch."""
    session = await db.one(
        "SELECT * FROM conversation_sessions WHERE id = ? AND organization_id = ?", (session_id, org_id)
    )
    if session is None:
        raise NotFound("Voice session not found.")
    if session["status"] != "active":
        raise ConflictError("Voice session already ended.")

    receptionist = await db.one(
        "SELECT * FROM receptionists WHERE id = ? AND organization_id = ?",
        (session["receptionist_id"], org_id),
    )
    if receptionist is None:
        raise NotFound("Receptionist not found.")
    clinic = await db.one(
        "SELECT * FROM clinics WHERE id = ? AND organization_id = ?", (session["clinic_id"], org_id)
    )
    if clinic is None:
        raise NotFound("Clinic not found.")
    org = await db.one("SELECT name FROM organizations WHERE id = ?", (org_id,))
    hours_rows = await db.execute(
        "SELECT day_of_week, open_time, close_time, is_closed FROM clinic_hours WHERE clinic_id = ? ORDER BY day_of_week",
        (clinic["id"],),
    )
    day_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    hours_text = "; ".join(
        f"{day_names[h['day_of_week'] % 7]} {'closed' if h['is_closed'] else h['open_time'] + '-' + h['close_time']}"
        for h in hours_rows
    )
    receptionist = dict(receptionist)
    receptionist["_capabilities"] = _json.loads(receptionist.get("capabilities") or "{}")
    receptionist["_escalation"] = _json.loads(receptionist.get("escalation") or "{}")
    receptionist["_hours_text"] = hours_text or None

    ctx = ToolContext(
        org_id=org_id,
        clinic_id=session["clinic_id"],
        receptionist_id=receptionist["id"],
        session_id=session_id,
    )
    return session, receptionist, clinic, ctx, receptionist["_capabilities"], org["name"]


async def _persist_message(
    session_id: str, org_id: str, role: str, content: str | None, *, tool_name: str | None = None,
    tool_payload: dict | None = None, latency_ms: int | None = None,
) -> None:
    await db.write(
        "INSERT INTO conversation_messages (id, session_id, organization_id, role, content, tool_name, tool_payload, latency_ms, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            new_id(), session_id, org_id, role, content, tool_name,
            _json.dumps(tool_payload, ensure_ascii=False) if tool_payload else None,
            latency_ms, utc_now_iso(),
        ),
    )


def _bg(coro) -> None:
    """Run a non-critical coroutine without blocking the voice path.

    DB writes (transcripts, usage) must not add 2-4 Turso round-trips of latency
    to the hot turn loop. They still run to completion in the same process; the
    next turn arrives seconds later, by which time they have landed.
    """

    def _log_failure(task: asyncio.Task) -> None:
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            ws_logger.warning("background write failed: %s", exc)

    task = asyncio.create_task(coro)
    task.add_done_callback(_log_failure)


async def _record_usage(org_id: str, session_id: str, kind: str, provider: str, quantity: float) -> None:
    await db.write(
        "INSERT INTO usage_records (id, organization_id, session_id, kind, provider, quantity, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (new_id(), org_id, session_id, kind, provider, quantity, utc_now_iso()),
    )


async def _speak_and_send(ws: WebSocket, text: str, voice: str, speed: float) -> None:
    await ws.send_json({"type": "status", "stage": "speaking"})
    import time as _time

    t0 = _time.perf_counter()
    audio_b64, fmt = await get_tts().synthesize(text, voice=voice, speed=speed)
    await ws.send_json({"type": "audio", "format": fmt, "data": audio_b64})
    _bg(_record_usage(ws.state.org_id, ws.state.session_id, "tts_chars", ws.state.tts_provider, len(text)))
    log_extra(ws_logger, logging.INFO, "tts delivered", chars=len(text), ms=int((_time.perf_counter() - t0) * 1000))


async def _speak_instant_ack(ws: WebSocket, voice: str, speed: float) -> None:
    """Speak a short pre-warmed acknowledgment with ~0ms latency.

    A natural backchannel ('Mm-hmm.', 'One moment, please.') is sent while the
    real answer is still being generated, so the caller perceives an immediate
    response. Only fires when the audio is genuinely a cache hit (probed via
    /tts/check, ~1ms) — otherwise it is skipped silently rather than adding a
    2s synthesis delay to the hot path.
    """
    global _ack_counter
    _ack_counter += 1
    candidates = (_ACK_LINES[_ack_counter % len(_ACK_LINES)], *_ACK_LINES)
    tts = get_tts()
    for line in candidates:
        try:
            if not await tts.is_cached(line, voice=voice, speed=speed):
                continue
        except Exception:  # noqa: BLE001 — probe must never break the turn
            return
        try:
            audio_b64, fmt = await tts.synthesize(line, voice=voice, speed=speed)  # cache hit ≈ 0ms
        except ProviderError:
            return
        with suppress(Exception):
            await ws.send_json({"type": "status", "stage": "thinking_ack"})
            await ws.send_json({"type": "audio", "format": fmt, "data": audio_b64, "ack": True})
        log_extra(ws_logger, logging.INFO, "instant ack sent", chars=len(line))
        return


_SENTENCE_END_RE = re.compile(r"[.!?。！？](?=\s|$)")
_CLAUSE_SPLIT_RE = re.compile(r"(?<=[,;:，；：])\s+")
# Measured provider synthesis cost: ~0.7 s base + ~20 ms/char, with heavy
# tail latency for long inputs (a 144-char chunk once took 10.9 s), and ANY
# concurrency triggers 429 rate limiting. Strategy: SENTENCE-level streaming —
# each group is one sentence (~1.5-2.5 s to synthesize, 2.7-5 s to play), so
# sequential synthesis stays AHEAD of playback after the first sentence and a
# slow provider call never leaves the caller in silence.
_SINGLE_TTS_MAX = 80    # one very short phrase: a single request beats splitting
_FIRST_GROUP_MAX = 90   # first spoken group: one short sentence for fastest first audio
_REST_GROUP_MAX = 110   # later groups: small enough to synthesize in ~2-3 s
_GROUP_MAX = 700        # hard cap: only for pathological unpunctuated text


def _lead_clause(sentence: str, max_len: int) -> tuple[str, str] | None:
    """Split a long sentence into (short lead clause, remainder) for fast TTS."""
    clauses = [c for c in _CLAUSE_SPLIT_RE.split(sentence) if c]
    if len(clauses) < 2:
        return None
    lead: list[str] = []
    length = 0
    cut = 0
    for i, clause in enumerate(clauses):
        lead.append(clause)
        length += len(clause) + 1
        cut = i + 1
        if length >= 40:
            break
    if cut < len(clauses) and length <= max_len:
        return " ".join(lead), " ".join(clauses[cut:])
    return None


def _split_speech_groups(text: str) -> list[str]:
    """Split a reply into speakable groups.

    The first group is a single SHORT sentence (or leading clause) so the
    caller hears the receptionist begin answering as early as possible.
    Remaining groups are single sentences (ultra-short ones merged) — small
    synthesis requests have predictable ~1.5-2.5 s latency, and sequential
    synthesis of the next sentence overlaps playback of the previous one.
    """
    text = text.strip()
    if not text:
        return []
    matches = list(_SENTENCE_END_RE.finditer(text))
    bounds = [0] + [m.end() for m in matches] + [len(text)]
    sentences: list[str] = []
    for i in range(len(bounds) - 1):
        part = text[bounds[i]:bounds[i + 1]].strip()
        if part:
            sentences.append(part)
    if not sentences:
        return [text]

    # Short single sentence: already optimal as one request.
    if len(sentences) == 1:
        if len(sentences[0]) <= _FIRST_GROUP_MAX:
            return [text]
        split = _lead_clause(sentences[0], 130)
        return [split[0], split[1]] if split else [text]

    first = sentences[0]
    rest = sentences[1:]
    # Very long first sentence: lead with its opening clause instead.
    if len(first) > _FIRST_GROUP_MAX:
        split = _lead_clause(first, _FIRST_GROUP_MAX + 40)
        if split:
            first, rest = split[0], [split[1], *rest]

    groups = [first]
    batch: list[str] = []
    for s in rest:
        if batch and sum(len(x) for x in batch) + len(s) + 1 > _REST_GROUP_MAX:
            groups.append(" ".join(batch))
            batch = [s]
        else:
            batch.append(s)
    if batch:
        groups.append(" ".join(batch))
    # Pathological long group (no punctuation anywhere): hard-split it so no
    # single synthesis request becomes a multi-second latency bomb.
    final: list[str] = []
    for g in groups:
        if len(g) <= _GROUP_MAX:
            final.append(g)
            continue
        words = g.split(" ")
        cur: list[str] = []
        n = 0
        for w in words:
            cur.append(w)
            n += len(w) + 1
            if n >= _GROUP_MAX:
                final.append(" ".join(cur))
                cur, n = [], 0
        if cur:
            final.append(" ".join(cur))
    return final


async def _speak_stream_and_send(ws: WebSocket, text: str, voice: str, speed: float) -> None:
    """Speak a reply with fast first audio and zero provider bursts.

    Very short phrases go out as ONE synthesis request. Anything longer is
    split so a SHORT leading group (first sentence / opening clause, ~1.3-1.9 s
    to synthesize) starts playing as early as possible, while later groups are
    synthesized strictly SEQUENTIALLY — each finishes while the previous audio
    is still playing, and no concurrency means no provider 429 backoffs.
    """
    import time as _time

    if len(text.strip()) <= _SINGLE_TTS_MAX:
        await _speak_and_send(ws, text, voice, speed)
        return

    groups = _split_speech_groups(text)
    if len(groups) <= 1:
        await _speak_and_send(ws, text, voice, speed)
        return

    await ws.send_json({"type": "status", "stage": "speaking"})
    t0 = _time.perf_counter()
    total_chars = 0
    sem = asyncio.Semaphore(1)  # sequential: concurrent TTS triggers provider 429s

    async def _synth(group: str) -> tuple[str, str]:
        async with sem:
            return await get_tts().synthesize(group, voice=voice, speed=speed)

    tasks = [asyncio.ensure_future(_synth(group)) for group in groups]
    failed = False
    for i, task in enumerate(tasks):
        try:
            audio_b64, fmt = await task
        except ProviderError:
            if total_chars == 0:
                # Nothing has been spoken yet: surface the failure so the
                # caller gets the error path instead of silence.
                for pending in tasks[i + 1:]:
                    pending.cancel()
                raise
            failed = True
            log_extra(ws_logger, logging.WARNING, "tts stream group failed mid-reply", group=i, chars=len(groups[i]))
            continue
        total_chars += len(groups[i])
        await ws.send_json({"type": "audio", "format": fmt, "data": audio_b64})
    if failed and total_chars == 0:
        raise ProviderError("Voice synthesis failed.")
    _bg(_record_usage(ws.state.org_id, ws.state.session_id, "tts_chars", ws.state.tts_provider, total_chars))
    log_extra(ws_logger, logging.INFO, "tts stream delivered", chars=total_chars, groups=len(groups), ms=int((_time.perf_counter() - t0) * 1000))


@router.websocket("/ws/{session_id}")
async def voice_ws(websocket: WebSocket, session_id: str, token: str = "") -> None:
    token = token or websocket.query_params.get("token", "")
    if not token:
        await websocket.close(code=4401)
        return
    try:
        principal = principal_from_token(token)
    except AuthError:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    try:
        session, receptionist, clinic, ctx, capabilities, org_name = await _load_turn_context(
            session_id, principal.organization_id
        )
    except (NotFound, ConflictError) as exc:
        with suppress(Exception):
            await websocket.send_json({"type": "error", "message": exc.message})
        await websocket.close(code=4404)
        return

    websocket.state.org_id = principal.organization_id
    websocket.state.session_id = session_id
    session_token = session_id_ctx.set(session_id)
    language = session["language"]
    voice_id = receptionist["voice_id"]
    speed = float(receptionist["speaking_speed"] or 1.0)
    websocket.state.tts_provider = get_tts().name

    log_extra(ws_logger, logging.INFO, "voice ws connected", session_id=session_id, language=language, voice=voice_id)
    # Prewarm any pool connections that went idle since the last activity so
    # this conversation's first turn never pays a cold-session stall.
    _bg(db.prewarm_idle())

    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            try:
                frame = _json.loads(raw)
            except _json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "Malformed frame."})
                continue

            msg_type = frame.get("type")
            if msg_type == "end":
                await websocket.send_json({"type": "ended"})
                break
            if msg_type == "ping":
                # Client keepalive — reply immediately, never treat as a turn.
                await websocket.send_json({"type": "pong"})
                continue

            if msg_type == "greet":
                # Speak the configured greeting (persisted as the first assistant turn).
                greeting = (receptionist.get("greeting_message") or "").strip()
                if greeting:
                    await websocket.send_json({"type": "transcript", "role": "assistant", "text": greeting})
                    _bg(_persist_message(session_id, principal.organization_id, "assistant", greeting))
                    try:
                        await _speak_stream_and_send(websocket, greeting, voice_id, speed)
                    except ProviderError:
                        await websocket.send_json({"type": "error", "message": "Voice synthesis failed; showing text only."})
                await websocket.send_json({"type": "status", "stage": "listening"})
                continue

            audio_b64: str | None = None
            user_text: str | None = None
            if msg_type == "text":
                user_text = str(frame.get("data", "")).strip()[:4000]
                if not user_text:
                    continue
            elif msg_type == "audio":
                audio_b64 = str(frame.get("data", ""))
                if len(audio_b64) > 35_000_000:  # ~25MB decoded
                    await websocket.send_json({"type": "error", "message": "Audio too large."})
                    continue
            else:
                continue

            # ── 1) Speech recognition ────────────────────────────────────
            # The instant acknowledgment ('Mm-hmm' / 'One moment') is kicked
            # off in the BACKGROUND before transcription so it overlaps the
            # STT round-trip: the caller hears it ~0.4 s sooner, while the
            # recognizer is still working. Only fires when the ack audio is
            # already cached (probe ~1ms) — otherwise it is skipped silently.
            if audio_b64 is not None:
                _bg(_speak_instant_ack(websocket, voice_id, speed))
            if user_text is None:
                await websocket.send_json({"type": "status", "stage": "transcribing"})
                import time as _time

                t0 = _time.perf_counter()
                try:
                    user_text = await get_stt().transcribe(audio_b64, language)  # type: ignore[arg-type]
                except ProviderError:
                    await _persist_message(session_id, principal.organization_id, "system", "stt_error")
                    await websocket.send_json({"type": "error", "message": "Speech recognition failed. Please try again."})
                    continue
                if not user_text and len(audio_b64) > 20_000:
                    # Substantial audio but no transcript: transient recognizer
                    # hiccups do happen — one honest retry before giving up.
                    log_extra(ws_logger, logging.WARNING, "stt empty on real audio — retrying once", audio_b64_len=len(audio_b64))
                    with suppress(ProviderError):
                        await asyncio.sleep(0.15)
                        user_text = await get_stt().transcribe(audio_b64, language)  # type: ignore[arg-type]
                log_extra(ws_logger, logging.INFO, "stt done", chars=len(user_text), ms=int((_time.perf_counter() - t0) * 1000))
                websocket.state._t_stt_done = _time.perf_counter()
                _bg(_record_usage(principal.organization_id, session_id, "stt_seconds", get_stt().name, 3.0))

            if not user_text:
                await _persist_message(session_id, principal.organization_id, "assistant", _RETRY_SAY)
                with suppress(ProviderError):
                    await _speak_stream_and_send(websocket, _RETRY_SAY, voice_id, speed)
                await websocket.send_json({"type": "status", "stage": "listening"})
                continue

            await websocket.send_json({"type": "transcript", "role": "user", "text": user_text})
            # Background: persistence must not block the turn (and the history
            # query inside run_turn deliberately covers only PREVIOUS turns —
            # the current utterance is appended to the prompt explicitly).
            _bg(_persist_message(session_id, principal.organization_id, "user", user_text))

            # ── 2) Orchestration (safety + RAG + tools) ──────────────────
            await websocket.send_json({"type": "status", "stage": "thinking"})
            import time as _time

            t0 = _time.perf_counter()
            t_stt_done = getattr(websocket.state, "_t_stt_done", None)
            if t_stt_done is not None:
                log_extra(ws_logger, logging.INFO, "pre-llm overhead", ms=int((t0 - t_stt_done) * 1000))
            try:
                result = await run_turn(
                    ctx=ctx,
                    receptionist=receptionist,
                    clinic=clinic,
                    org_name=org_name,
                    language=language,
                    user_text=user_text,
                )
            except ProviderError:
                # Never leave the caller in dead silence: apologize in voice,
                # keep the session alive and return to listening so a simple
                # retry just works once the provider throttle window passes.
                await _persist_message(session_id, principal.organization_id, "system", "llm_error")
                await websocket.send_json({"type": "transcript", "role": "assistant", "text": _BUSY_SAY})
                _bg(_persist_message(session_id, principal.organization_id, "assistant", _BUSY_SAY))
                with suppress(ProviderError):
                    await _speak_stream_and_send(websocket, _BUSY_SAY, voice_id, speed)
                await websocket.send_json({"type": "status", "stage": "listening"})
                continue
            except Exception:  # noqa: BLE001
                ws_logger.exception("orchestrator failure")
                await websocket.send_json({"type": "error", "message": "An unexpected error occurred."})
                continue
            turn_ms = int((_time.perf_counter() - t0) * 1000)
            log_extra(ws_logger, logging.INFO, "orchestrated", turn_ms=turn_ms, say_chars=len(result.say), tools=len(result.tool_calls))

            for tc in result.tool_calls:
                await websocket.send_json({"type": "tool", "tool": tc.get("tool"), "arguments": tc.get("arguments")})
                _bg(_persist_message(
                    session_id, principal.organization_id, "tool", None,
                    tool_name=tc.get("tool"), tool_payload=tc.get("arguments"),
                ))
            if result.outcome_hint:
                _bg(db.write(
                    "UPDATE conversation_sessions SET outcome = ? WHERE id = ? AND outcome IS NULL",
                    (result.outcome_hint, session_id),
                ))

            await websocket.send_json({"type": "transcript", "role": "assistant", "text": result.say})
            _bg(_persist_message(
                session_id, principal.organization_id, "assistant", result.say, latency_ms=turn_ms
            ))
            _bg(_record_usage(principal.organization_id, session_id, "llm_requests", get_llm().name, 1))

            # ── 3) Speech synthesis (sentence-streamed for fast first audio)
            log_extra(ws_logger, logging.INFO, "speak start", post_orchestration_ms=int((_time.perf_counter() - t0) * 1000 - turn_ms))
            try:
                await _speak_stream_and_send(websocket, result.say, voice_id, speed)
            except ProviderError:
                await websocket.send_json({"type": "error", "message": "Voice synthesis failed; showing text only."})
            await websocket.send_json({"type": "status", "stage": "listening"})
            # Keep the pool warm during natural conversation pauses so the next
            # turn starts with live connections instead of stale ones.
            _bg(db.prewarm_idle())

        # Client said end / clean close: finalize session if still active.
        await db.write(
            "UPDATE conversation_sessions SET status = 'completed', ended_at = ?, end_reason = COALESCE(end_reason, 'caller_ended') "
            "WHERE id = ? AND status = 'active'",
            (utc_now_iso(), session_id),
        )
    except WebSocketDisconnect:
        await db.write(
            "UPDATE conversation_sessions SET status = 'completed', ended_at = ?, end_reason = COALESCE(end_reason, 'connection_lost') "
            "WHERE id = ? AND status = 'active'",
            (utc_now_iso(), session_id),
        )
    finally:
        session_id_ctx.reset(session_token)
        log_extra(ws_logger, logging.INFO, "voice ws disconnected", session_id=session_id)
