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
from app.domain.orchestrator import run_turn, stream_turn
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
        # One provider call every ~1.2s — never a burst. The greeting's FIRST
        # SPEECH GROUP goes first because the WS "greet" frame lands within a
        # second of session creation and dispatches exactly this group key
        # (_speak_stream_and_send → _split_speech_groups): the greet either
        # cache-hits (~0ms) or joins the in-flight synthesis via the bridge
        # dedupe. Warming the FULL greeting text measured 6.7s before the
        # caller heard anything — the first group is what first audio needs.
        if greeting_text:
            greeting_groups = _split_speech_groups(greeting_text)
            if greeting_groups:
                with suppress(ProviderError, Exception):
                    await get_tts().synthesize(greeting_groups[0], voice=voice, speed=speed)
        # Warm ONLY the first ack line + the retry/busy phrases: the provider
        # throttles bursts, and a full ack-line sweep right at session start
        # burns rate budget exactly when the caller's first turn needs it.
        # The remaining ack lines warm opportunistically via the instant-ack
        # probe (cache misses simply skip the ack).
        for line in (_ACK_LINES[0], _RETRY_SAY, _BUSY_SAY):
            await asyncio.sleep(1.2)
            with suppress(ProviderError, Exception):
                await get_tts().synthesize(line, voice=voice, speed=speed)

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

# A transcript must contain at least one REAL character (letter or digit) in
# any script we support — Latin, Cyrillic, Greek, Arabic, Devanagari, CJK,
# kana. The ASR occasionally "recognizes" pure breath/noise as symbol-only
# strings (measured live: a '#' transcript from silence) which previously
# reached the caller's text field and confused the LLM. Symbol-only output is
# treated exactly like empty output: no transcript, no LLM turn.
_TRANSCRIPT_HAS_TEXT_RE = re.compile(
    r"[0-9A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\u3040-\u30FF]"
)

# Spoken replies must never carry written-language markup: the LLM sometimes
# emits markdown (headers '#', bold '**', bullets '-', code ticks) and the TTS
# then reads it aloud ('hash hash hash') or the text field shows raw symbols —
# the exact '#' complaint. Stripped at BOTH sinks: every synthesis group and
# the final transcript.
_MARKUP_PATTERNS = re.compile(
    r"```+|`+|^#{1,6}\s*|\s#{1,6}\s|\*\*|__|\*|\n+"  # fences, ticks, headers, bold/italics
)


def _strip_spoken_markup(text: str) -> str:
    """Make LLM output safe to SPEAK and show: no markdown, no symbols noise."""
    if not text:
        return text
    out = _MARKUP_PATTERNS.sub(" ", text)
    out = re.sub(r"\s{2,}", " ", out).strip(" \t#*_`~-\u2013\u2014")
    # Collapse fragments like "- " bullets left at word boundaries.
    out = re.sub(r"(?:^|\s)[-•·]\s+", " ", out)
    return re.sub(r"\s{2,}", " ", out).strip()

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
# Streaming: dispatch a sentence for synthesis as soon as it completes in the
# LLM stream. Very short leads ("Yes.") wait for the next sentence to keep
# every synthesis request speakable.
_FIRST_SENTENCE_MIN = 12
# Measured provider synthesis cost (2026-10 probe): a 32-char request takes
# ~1.4 s while a 68-char request jumps to ~3.8 s — cost explodes with length,
# so the FIRST spoken group must stay tiny (~25-45 chars) for fast first
# audio. Later groups synthesize sequentially while earlier audio plays.
_SINGLE_TTS_MAX = 55    # one very short phrase: a single request beats splitting
_FIRST_GROUP_MAX = 45   # first spoken group: one short sentence for fastest first audio
_REST_GROUP_MAX = 85    # later groups: small enough to synthesize in ~2-3 s
_HARD_FIRST_MAX = 90    # no-clause single sentences: hard word-split above this
_GROUP_MAX = 700        # hard cap: only for pathological unpunctuated text
# Periods that do NOT end a sentence (abbreviations, time formats).
_ABBREV_END_RE = re.compile(
    r"\b(?:dr|mr|mrs|ms|prof|sr|jr|st|vs|etc|approx|dept|est|min|max|inc|ltd|a\.m|p\.m|e\.g|i\.e|no)\.$",
    re.IGNORECASE,
)


def _hard_word_split(text: str, target: int) -> tuple[str, str]:
    """Split long unpunctuated text at the last word boundary before target."""
    cut = text.rfind(" ", 0, target)
    if cut < 20:
        cut = target
    return text[:cut].rstrip(), text[cut:].lstrip()


def _lead_clause(sentence: str, max_len: int) -> tuple[str, str] | None:
    """Split a long sentence into (short lead clause, remainder) for fast TTS.

    The lead accumulates clauses only until it reaches a MINIMUM speakable
    length (~16 chars) — a tiny, fast first synthesis request — and never
    exceeds max_len.
    """
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
        if length >= 16:
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
    sentences: list[str] = []
    start = 0
    for m in matches:
        seg = text[start:m.end()]
        # Abbreviation period (Dr., a.m., etc.) — not a sentence boundary.
        if _ABBREV_END_RE.search(seg.rstrip()):
            continue
        part = seg.strip()
        if part:
            sentences.append(part)
        start = m.end()
    tail = text[start:].strip()
    if tail:
        sentences.append(tail)
    if not sentences:
        return [text]

    # Short single sentence: already optimal as one request.
    if len(sentences) == 1:
        if len(sentences[0]) <= _FIRST_GROUP_MAX:
            return [text]
        split = _lead_clause(sentences[0], _FIRST_GROUP_MAX + 40)
        if split:
            return [split[0], split[1]]
        # No clause boundary anywhere: avoid a multi-second synthesis bomb.
        if len(sentences[0]) > _HARD_FIRST_MAX:
            a, b = _hard_word_split(sentences[0], 60)
            return [a, b] if b else [text]
        return [text]

    first = sentences[0]
    rest = sentences[1:]
    # Ultra-short leading fragment (e.g. a stray 'Dr.' / 'Yes.'): merging with
    # the next sentence avoids synthesizing a near-empty first group.
    if len(first) < 16 and rest:
        first = f"{first} {rest.pop(0)}"
    # Very long first sentence: lead with its opening clause instead.
    if len(first) > _FIRST_GROUP_MAX:
        split = _lead_clause(first, _FIRST_GROUP_MAX + 40)
        if split:
            first, rest = split[0], [split[1], *rest]
        elif len(first) > _HARD_FIRST_MAX:
            a, b = _hard_word_split(first, 60)
            first, rest = a, [b, *rest] if b else rest

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


class _Speaker:
    """Sequential per-connection reply speaker fed by streaming say-deltas.

    Sentences are dispatched for synthesis the moment they complete in the
    LLM stream; if the first sentence runs long with no period in sight, its
    opening CLAUSE is dispatched instead (measured: a 24-char synthesis is
    ~1.3 s vs ~2.2 s for 32+, and 3.8 s for 68+). A FIFO task list plus a
    semaphore keeps provider calls strictly sequential (concurrency trips 429
    throttling) while each synthesis overlaps playback of the previous chunk.
    """

    def __init__(self, ws: WebSocket, voice: str, speed: float) -> None:
        self._ws = ws
        self._voice = voice
        self._speed = speed
        self._sem = asyncio.Semaphore(1)
        self._tasks: list[asyncio.Task] = []
        self._buffer = ""
        self._sent_any = False
        self._first_error: ProviderError | None = None

    # ── group extraction ──────────────────────────────────────────────────
    def _start(self, text: str) -> None:
        """Schedule a group; lead-split long first groups for fast first audio."""
        text = text.strip()
        if not text:
            return
        if not self._tasks and len(text) > _FIRST_GROUP_MAX:
            split = _lead_clause(text, _FIRST_GROUP_MAX + 40)
            if split:
                log_extra(ws_logger, logging.INFO, "lead clause split", lead=len(split[0]), rest=len(split[1]))
                self._tasks.append(asyncio.ensure_future(self._speak_one(split[0])))
                rest = split[1].strip()
                if rest:
                    self._tasks.append(asyncio.ensure_future(self._speak_one(rest)))
                return
            # No comma/clause boundary anywhere: hard word-split so the first
            # synthesis stays ~2s. A 68+ char request measures ~3.8s — a
            # multi-second latency bomb for first audio.
            if len(text) > _HARD_FIRST_MAX:
                a, b = _hard_word_split(text, _FIRST_GROUP_MAX + 15)
                log_extra(ws_logger, logging.INFO, "hard first split", lead=len(a), rest=len(b))
                self._tasks.append(asyncio.ensure_future(self._speak_one(a)))
                rest = b.strip()
                if rest:
                    self._tasks.append(asyncio.ensure_future(self._speak_one(rest)))
                return
        self._tasks.append(asyncio.ensure_future(self._speak_one(text)))

    def _last_sentence_boundary(self) -> re.Match | None:
        boundary = None
        for m in _SENTENCE_END_RE.finditer(self._buffer):
            boundary = m
        return boundary

    def feed_delta(self, delta: str) -> None:
        """Accumulate streamed text; dispatch every speakable group.

        Measured reality: the z-ai SDK delivers the whole completion as ONE
        end-of-generation burst, so a multi-sentence reply usually arrives as
        a single delta. Dispatching at the LAST boundary (the old logic) then
        collapsed the entire reply into one huge synthesis request (~4-8s of
        dead air). Cutting at the FIRST sentence boundary — merging any
        too-short leading fragment like "Yes." into the first group — turns
        the burst into several SHORT sequential requests: first audio plays
        ~2s after the burst instead of after the whole reply.
        """
        self._buffer += delta
        while True:
            if not self._tasks and len(self._buffer) > _FIRST_GROUP_MAX:
                boundary = self._last_sentence_boundary()
                if boundary is None or boundary.end() < _FIRST_SENTENCE_MIN:
                    # No sentence end in sight: dispatch the opening clause now.
                    clause = None
                    for m in _CLAUSE_SPLIT_RE.finditer(self._buffer):
                        if m.start() >= _FIRST_SENTENCE_MIN:
                            clause = m
                            break
                    if clause is not None:
                        lead, self._buffer = self._buffer[: clause.start()], self._buffer[clause.start():]
                        self._start(lead)
                        continue
            first: re.Match | None = None
            for cand in _SENTENCE_END_RE.finditer(self._buffer):
                first = cand
                if cand.end() >= _FIRST_SENTENCE_MIN:
                    break
            if first is None or first.end() < _FIRST_SENTENCE_MIN:
                return
            sentence, self._buffer = self._buffer[: first.end()].strip(), self._buffer[first.end():]
            if sentence:
                self._start(sentence)

    def flush(self) -> None:
        """Dispatch whatever remains after the stream ends."""
        tail = self._buffer.strip()
        self._buffer = ""
        if tail:
            self._start(tail)

    # Public alias for the non-streaming fallback path (final result).
    def dispatch(self, text: str) -> None:
        self._start(text)

    async def _speak_one(self, text: str) -> None:
        text = _strip_spoken_markup(text)  # TTS must never read markdown symbols
        if not text:
            return
        async with self._sem:
            if self._first_error is not None:
                return
            try:
                audio_b64, fmt = await get_tts().synthesize(text, voice=self._voice, speed=self._speed)
            except ProviderError as exc:
                if not self._sent_any:
                    self._first_error = exc
                log_extra(ws_logger, logging.WARNING, "tts group failed", chars=len(text), sent_any=self._sent_any)
                return
            if not self._sent_any:
                self._sent_any = True
                with suppress(Exception):
                    await self._ws.send_json({"type": "status", "stage": "speaking"})
            with suppress(Exception):
                await self._ws.send_json({"type": "audio", "format": fmt, "data": audio_b64})

    async def wait_done(self) -> None:
        """Await all synthesis/sends; surface the failure if NOTHING was sent."""
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
            self._tasks = []
        if self._first_error is not None and not self._sent_any:
            raise self._first_error


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
                        # The session-start warmer synthesizes the FIRST SPEECH
                        # GROUP of the greeting (same _split_speech_groups key
                        # the greet dispatch below uses), so group 1 is a
                        # ~0ms cache hit or an in-flight dedupe join, and the
                        # caller hears the receptionist within ~1-2s. Full-text
                        # warming measured 6.7s of dead air before the greeting
                        # started, and splitting would MISS a full-text warm
                        # key — so the warm key IS the first group.
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
                elif user_text and not _TRANSCRIPT_HAS_TEXT_RE.search(user_text):
                    # Symbol-only "transcript" (e.g. '#' from breath noise):
                    # the recognizer found no speech — retry once, then fall
                    # through to the did-not-catch path. Never shown, never
                    # forwarded to the LLM.
                    log_extra(ws_logger, logging.WARNING, "stt symbol-only output — treating as no speech", raw_chars=len(user_text))
                    user_text = ""
                    if len(audio_b64) > 20_000:
                        with suppress(ProviderError):
                            await asyncio.sleep(0.15)
                            retried = await get_stt().transcribe(audio_b64, language)  # type: ignore[arg-type]
                            if retried and _TRANSCRIPT_HAS_TEXT_RE.search(retried):
                                user_text = retried
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

            # ── 2) Orchestration (safety + RAG + tools), STREAMING ────────
            # The reply streams sentence-by-sentence: each completed sentence
            # is dispatched for TTS while the LLM is still generating the rest,
            # cutting first-audio latency by ~0.5-1s versus wait-for-everything.
            await websocket.send_json({"type": "status", "stage": "thinking"})
            import time as _time

            t0 = _time.perf_counter()
            t_stt_done = getattr(websocket.state, "_t_stt_done", None)
            if t_stt_done is not None:
                log_extra(ws_logger, logging.INFO, "pre-llm overhead", ms=int((t0 - t_stt_done) * 1000))

            speaker = _Speaker(websocket, voice_id, speed)
            say_parts: list[str] = []
            stream_error: Exception | None = None
            try:
                async for ev_kind, ev_payload in stream_turn(
                    ctx=ctx,
                    receptionist=receptionist,
                    clinic=clinic,
                    org_name=org_name,
                    language=language,
                    user_text=user_text,
                ):
                    if ev_kind == "say_delta":
                        say_parts.append(ev_payload)
                        speaker.feed_delta(ev_payload)
                    elif ev_kind == "tool":
                        await websocket.send_json({"type": "tool", "tool": ev_payload.get("tool"), "arguments": ev_payload.get("arguments")})
                        _bg(_persist_message(
                            session_id, principal.organization_id, "tool", None,
                            tool_name=ev_payload.get("tool"), tool_payload=ev_payload.get("arguments"),
                        ))
                    elif ev_kind == "final":
                        if not getattr(ev_payload, "streamed", False) and ev_payload.say:
                            # Non-streaming fallback result — speak it the same way.
                            say_parts.append(ev_payload.say)
                            speaker.dispatch(ev_payload.say)
                        if ev_payload.outcome_hint:
                            hint = ev_payload.outcome_hint
                            _bg(db.write(
                                "UPDATE conversation_sessions SET outcome = ? WHERE id = ? AND outcome IS NULL",
                                (hint, session_id),
                            ))
                        if not getattr(ev_payload, "streamed", False):
                            # Fallback path: tool calls were NOT yielded as
                            # events — emit them here. (Streamed results already
                            # emitted each tool as it happened.)
                            for tc in ev_payload.tool_calls:
                                await websocket.send_json({"type": "tool", "tool": tc.get("tool"), "arguments": tc.get("arguments")})
                                _bg(_persist_message(
                                    session_id, principal.organization_id, "tool", None,
                                    tool_name=tc.get("tool"), tool_payload=tc.get("arguments"),
                                ))
            except ProviderError as exc:
                stream_error = exc
            except Exception:  # noqa: BLE001
                ws_logger.exception("orchestrator failure")
                stream_error = Exception("unexpected")

            turn_ms = int((_time.perf_counter() - t0) * 1000)
            say_text = _strip_spoken_markup("".join(say_parts).strip())

            if stream_error is not None and not say_text:
                # Nothing could be produced (LLM/provider failure): apologize in
                # voice, keep the session alive so a retry just works.
                await _persist_message(session_id, principal.organization_id, "system", "llm_error")
                await websocket.send_json({"type": "transcript", "role": "assistant", "text": _BUSY_SAY})
                _bg(_persist_message(session_id, principal.organization_id, "assistant", _BUSY_SAY))
                with suppress(ProviderError):
                    await _speak_stream_and_send(websocket, _BUSY_SAY, voice_id, speed)
                await websocket.send_json({"type": "status", "stage": "listening"})
                continue

            log_extra(ws_logger, logging.INFO, "orchestrated", turn_ms=turn_ms, say_chars=len(say_text), streamed=not stream_error)

            await websocket.send_json({"type": "transcript", "role": "assistant", "text": say_text or _BUSY_SAY})
            _bg(_persist_message(
                session_id, principal.organization_id, "assistant", say_text or _BUSY_SAY, latency_ms=turn_ms
            ))
            _bg(_record_usage(principal.organization_id, session_id, "llm_requests", get_llm().name, 1))

            # ── 3) Finish synthesis of any tail and wait for all audio ────
            speaker.flush()
            try:
                await speaker.wait_done()
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
