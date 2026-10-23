"""Voice session REST endpoints.

These two endpoints create and end conversation_sessions rows for the browser
voice client. The WebSocket turn-based pipeline is implemented separately:

# WS endpoint added by lead in Phase 4b

Authentication: any authenticated principal (get_principal). Voice sessions are
org-scoped via the receptionist's clinic; no audit events are written for
session lifecycle (high-frequency, not a configuration change).
"""

from __future__ import annotations

import json as _json
import logging
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
    return VoiceSessionStartResponse(session=session, greeting_text=receptionist["greeting_message"])


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
    await _record_usage(ws.state.org_id, ws.state.session_id, "tts_chars", ws.state.tts_provider, len(text))
    log_extra(ws_logger, logging.INFO, "tts delivered", chars=len(text), ms=int((_time.perf_counter() - t0) * 1000))


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

            if msg_type == "greet":
                # Speak the configured greeting (persisted as the first assistant turn).
                greeting = (receptionist.get("greeting_message") or "").strip()
                if greeting:
                    await websocket.send_json({"type": "transcript", "role": "assistant", "text": greeting})
                    await _persist_message(session_id, principal.organization_id, "assistant", greeting)
                    try:
                        await _speak_and_send(websocket, greeting, voice_id, speed)
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
                log_extra(ws_logger, logging.INFO, "stt done", chars=len(user_text), ms=int((_time.perf_counter() - t0) * 1000))
                await _record_usage(principal.organization_id, session_id, "stt_seconds", get_stt().name, 3.0)

            if not user_text:
                await _persist_message(session_id, principal.organization_id, "assistant", _RETRY_SAY)
                with suppress(ProviderError):
                    await _speak_and_send(websocket, _RETRY_SAY, voice_id, speed)
                await websocket.send_json({"type": "status", "stage": "listening"})
                continue

            await websocket.send_json({"type": "transcript", "role": "user", "text": user_text})
            await _persist_message(session_id, principal.organization_id, "user", user_text)

            # ── 2) Orchestration (safety + RAG + tools) ──────────────────
            await websocket.send_json({"type": "status", "stage": "thinking"})
            import time as _time

            t0 = _time.perf_counter()
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
                await websocket.send_json({"type": "error", "message": "The AI service is unavailable right now."})
                await _persist_message(session_id, principal.organization_id, "system", "llm_error")
                continue
            except Exception:  # noqa: BLE001
                ws_logger.exception("orchestrator failure")
                await websocket.send_json({"type": "error", "message": "An unexpected error occurred."})
                continue
            turn_ms = int((_time.perf_counter() - t0) * 1000)

            for tc in result.tool_calls:
                await websocket.send_json({"type": "tool", "tool": tc.get("tool"), "arguments": tc.get("arguments")})
                await _persist_message(
                    session_id, principal.organization_id, "tool", None,
                    tool_name=tc.get("tool"), tool_payload=tc.get("arguments"),
                )
            if result.outcome_hint:
                await db.write(
                    "UPDATE conversation_sessions SET outcome = ? WHERE id = ? AND outcome IS NULL",
                    (result.outcome_hint, session_id),
                )

            await websocket.send_json({"type": "transcript", "role": "assistant", "text": result.say})
            await _persist_message(
                session_id, principal.organization_id, "assistant", result.say, latency_ms=turn_ms
            )
            await _record_usage(principal.organization_id, session_id, "llm_requests", get_llm().name, 1)

            # ── 3) Speech synthesis ──────────────────────────────────────
            try:
                await _speak_and_send(websocket, result.say, voice_id, speed)
            except ProviderError:
                await websocket.send_json({"type": "error", "message": "Voice synthesis failed; showing text only."})
            await websocket.send_json({"type": "status", "stage": "listening"})

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
