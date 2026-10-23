"""Provider abstractions for LLM, STT and TTS (spec §7: provider-independent).

Default provider is "zai" via the ai-bridge sidecar (services/ai-bridge on :8100,
Bun + z-ai-web-dev-sdk — the SDK is Node-only so it cannot run inside FastAPI).
An "openai" provider is included for teams with an OPENAI_API_KEY.

Contract (shared by all providers):
- LLM:   chat(messages, temperature) -> str
- STT:   transcribe(audio_base64, language) -> str   ("" means no speech detected)
- TTS:   synthesize(text, voice, speed) -> (audio_base64, format)
"""

from __future__ import annotations

import logging
from typing import Any, Protocol

import httpx

from app.core.config import settings
from app.core.errors import ProviderError
from app.core.logging import log_extra

logger = logging.getLogger(__name__)

LLM_TIMEOUT = 60.0
STT_TIMEOUT = 60.0
TTS_TIMEOUT = 120.0  # multi-chunk synthesis with provider rate-limit backoff


class LLMProvider(Protocol):
    name: str

    async def chat(self, messages: list[dict[str, str]], temperature: float = 0.4) -> str: ...


class STTProvider(Protocol):
    name: str

    async def transcribe(self, audio_base64: str, language: str | None = None) -> str: ...


class TTSProvider(Protocol):
    name: str

    async def synthesize(self, text: str, voice: str, speed: float = 1.0) -> tuple[str, str]: ...


class ZAIBridgeProvider:
    """Calls the ai-bridge sidecar. One provider class implements all three roles."""

    name = "zai"

    def __init__(self) -> None:
        # Defensive pool config: keepalive connections expire after 1s idle so a
        # half-dead Bun-side socket is never reused (reuse-on-stale manifests as
        # multi-second silent hangs before the request even reaches the bridge),
        # and pool waits raise after 5s instead of blocking indefinitely.
        self._client = httpx.AsyncClient(
            base_url=settings.ai_bridge_url,
            timeout=TTS_TIMEOUT,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=5, keepalive_expiry=1.0),
        )

    async def _post(self, path: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        import time as _time

        t0 = _time.perf_counter()
        timed = httpx.Timeout(timeout, connect=5.0, pool=5.0)
        try:
            resp = await self._client.post(path, json=payload, timeout=timed)
        except httpx.TimeoutException as exc:
            raise ProviderError("The AI service took too long to respond.") from exc
        except httpx.HTTPError as exc:
            raise ProviderError("The AI service is unreachable. Is the ai-bridge sidecar running?") from exc
        logger.info(
            "bridge call done",
            extra={"route": path, "ms": int((_time.perf_counter() - t0) * 1000)},
        )
        if resp.status_code != 200:
            try:
                detail = resp.json().get("error", {}).get("message", "")
            except Exception:  # noqa: BLE001
                detail = resp.text[:200]
            raise ProviderError(f"AI provider error ({resp.status_code}). {detail}".strip())
        return resp.json()

    async def chat(self, messages: list[dict[str, str]], temperature: float = 0.4) -> str:
        data = await self._post(
            "/llm/chat",
            {"messages": messages, "temperature": temperature},
            timeout=LLM_TIMEOUT,
        )
        content = str(data.get("content", "")).strip()
        if not content:
            raise ProviderError("The AI model returned an empty response.")
        log_extra(logger, logging.DEBUG, "llm call", chars=len(content))
        return content

    async def transcribe(self, audio_base64: str, language: str | None = None) -> str:
        data = await self._post("/stt", {"file_base64": audio_base64, "language": language}, timeout=STT_TIMEOUT)
        return str(data.get("text", "")).strip()

    async def synthesize(self, text: str, voice: str, speed: float = 1.0) -> tuple[str, str]:
        data = await self._post("/tts", {"text": text, "voice": voice, "speed": speed, "format": "wav"}, timeout=TTS_TIMEOUT)
        audio = data.get("audio_base64")
        fmt = data.get("format", "wav")
        if not audio:
            raise ProviderError("Voice synthesis returned no audio.")
        return str(audio), str(fmt)


class OpenAIProvider:
    """Direct OpenAI API provider (requires OPENAI_API_KEY)."""

    name = "openai"

    def __init__(self) -> None:
        if not settings.openai_api_key:
            raise ProviderError("OPENAI_API_KEY is not configured.")
        self._client = httpx.AsyncClient(
            base_url="https://api.openai.com/v1",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            timeout=LLM_TIMEOUT,
        )
        self.tts_voice_map = {"tongtong": "alloy", "xiaochen": "echo", "jam": "onyx"}

    async def chat(self, messages: list[dict[str, str]], temperature: float = 0.4) -> str:
        try:
            resp = await self._client.post(
                "/chat/completions",
                json={"model": settings.openai_llm_model, "messages": messages, "temperature": temperature},
            )
        except httpx.HTTPError as exc:
            raise ProviderError("OpenAI API is unreachable.") from exc
        if resp.status_code != 200:
            raise ProviderError(f"OpenAI error ({resp.status_code}).")
        content = resp.json()["choices"][0]["message"]["content"]
        if not content or not content.strip():
            raise ProviderError("The AI model returned an empty response.")
        return content.strip()

    async def transcribe(self, audio_base64: str, language: str | None = None) -> str:
        import base64

        audio_bytes = base64.b64decode(audio_base64)
        files = {"file": ("audio.webm", audio_bytes, "audio/webm")}
        data: dict[str, Any] = {"model": "whisper-1", "response_format": "json"}
        if language and language != "auto":
            data["language"] = language
        try:
            resp = await self._client.post("/audio/transcriptions", files=files, data=data, timeout=STT_TIMEOUT)
        except httpx.HTTPError as exc:
            raise ProviderError("OpenAI transcription is unreachable.") from exc
        if resp.status_code != 200:
            raise ProviderError(f"OpenAI transcription error ({resp.status_code}).")
        return str(resp.json().get("text", "")).strip()

    async def synthesize(self, text: str, voice: str, speed: float = 1.0) -> tuple[str, str]:
        import base64

        mapped = self.tts_voice_map.get(voice, "alloy")
        try:
            resp = await self._client.post(
                "/audio/speech",
                json={"model": "tts-1", "input": text[:4000], "voice": mapped, "speed": speed, "response_format": "mp3"},
                timeout=TTS_TIMEOUT,
            )
        except httpx.HTTPError as exc:
            raise ProviderError("OpenAI speech synthesis is unreachable.") from exc
        if resp.status_code != 200:
            raise ProviderError(f"OpenAI TTS error ({resp.status_code}).")
        return base64.b64encode(resp.content).decode("ascii"), "mp3"


_llm: LLMProvider | None = None
_stt: STTProvider | None = None
_tts: TTSProvider | None = None


def get_llm() -> LLMProvider:
    global _llm
    if _llm is None:
        _llm = OpenAIProvider() if settings.llm_provider == "openai" else ZAIBridgeProvider()
    return _llm


def get_stt() -> STTProvider:
    global _stt
    if _stt is None:
        _stt = OpenAIProvider() if settings.stt_provider == "openai" else ZAIBridgeProvider()
    return _stt


def get_tts() -> TTSProvider:
    global _tts
    if _tts is None:
        _tts = OpenAIProvider() if settings.tts_provider == "openai" else ZAIBridgeProvider()
    return _tts
