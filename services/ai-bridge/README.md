# ai-bridge — ZAI provider sidecar (Bun)

Part of VITALORA AI. This is the **default "zai" provider adapter**: a small Bun HTTP
sidecar that wraps the `z-ai-web-dev-sdk` (a Node/Bun-only SDK) so the Python FastAPI
backend (`services/ai-backend/app/providers/*`) can use LLM / STT / TTS through one
stable, provider-independent contract.

- **Runtime**: Bun ≥ 1.3 (`bun index.ts`)
- **Port**: `8100` (default; override with `AI_BRIDGE_PORT`)
- **Caller**: FastAPI backend at `http://127.0.0.1:8100` — server-side only.
  **NEVER import this module or call it from frontend code.**
- **Credentials**: the SDK discovers `.z-ai-config` (cwd → `$HOME` → `/etc`); this
  service never reads, logs, or echoes credentials. Config-absent failures surface
  as honest `502 provider_error`.

## Endpoints

### `GET /health`
```json
{"status":"ok","service":"ai-bridge","providers":{"llm":"zai","stt":"zai","tts":"zai"}}
```

### `POST /llm/chat`
```json
{"messages":[{"role":"user","content":"..."}], "temperature":0.4, "max_tokens":512}
```
- `messages`: 1–40 items, each `{role: system|user|assistant, content: string}` with
  content ≤ 32 000 chars. `temperature` 0–2 (default 0.4). `max_tokens` optional
  positive integer.
- `thinking` is **always `{type:"disabled"}`** (voice latency).
- Response: `{"content": string, "model": string}` (model reported by provider,
  e.g. `glm-4-plus`).

### `POST /stt`
```json
{"file_base64": "<base64 audio>", "language": "en"}
```
- Accepts a data-URI prefix (`data:audio/...;base64,`) and whitespace; decodes to
  ≤ 25 MB. `language` is accepted for forward-compat — ZAI ASR auto-detects.
- Empty transcription is still `200 {"text": ""}` (the caller decides it's silence).

### `POST /tts`
```json
{"text":"...", "voice":"tongtong", "speed":1.0, "format":"wav"}
```
- Response: `{"audio_base64": string, "format": "wav", "duration_hint_ms": null}`.
  `duration_hint_ms` is always `null` (we don't guess; decode the WAV if needed).
- **Constraints**
  - Provider hard limit: **1024 chars per TTS request**. Longer input is split into
    ≤ 950-char chunks on sentence boundaries (`[.!?。！？]`, fallback: word/space,
    final fallback: hard cut) and synthesized sequentially.
  - **format**: only `"wav"` is produced. Requesting `"mp3"` returns an honest
    `400 unsupported_format` — the ZAI TTS endpoint rejects `response_format: "mp3"`
    with error 1214 (probed), and we will not mislabel audio.
  - **Multi-chunk WAV merge**: each chunk's WAV is RIFF-parsed (the provider emits a
    non-standard `AIGC` chunk before `data`, so headers must not be assumed 44-byte),
    fmt parameters are verified identical across chunks, and raw PCM is concatenated
    under one canonical 44-byte header (observed: 24 000 Hz / 16-bit / mono).

### `POST /embeddings`
Honest stub → `501 {"error":{"code":"not_implemented","message":"Embedding provider
not configured; retrieval uses FTS5"}}`. Knowledge retrieval uses SQLite FTS5;
vector search is future work.

## Errors
All errors are `{"error":{"code":..., "message":...}}`:
`invalid_json/invalid_body/invalid_messages/invalid_request/invalid_base64` (400),
`payload_too_large` (413, body > ~40 MB or decoded audio > 25 MB),
`not_implemented` (501), `provider_error` (502 — SDK/provider failure, message
sanitized + truncated, credentials never included), `timeout` (504 — provider call
exceeds 60 s). Transient provider `429/500/502/503` are retried twice
(1.2 s / 3.0 s backoff) before surfacing honestly.

## Operational notes
- Body limit ~40 MB (STT audio arrives base64); parse errors → 400.
- Structured log lines only — `{ts, level, route, duration_ms, status, meta:{chars,
  audio_bytes, ...}}`; no payloads, no credentials. Text/audio content is never logged.
- CORS: `*` for local dev (the voice lab may call it directly as a fallback); the
  production caller is FastAPI. `OPTIONS` preflight → 204.
- Concurrency: the `zai` client is a lazily-created singleton (creation retried on
  failure) and the SDK is trusted to be async-safe — no artificial serialization.
- TTS chunk synthesis is **sequential** because the provider rate-limits (`429`) even
  small bursts of concurrent TTS calls; chunk calls carry 429-backoff retries.
- Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting connections, drain
  in-flight requests, force-exit after 8 s.

## Development
```bash
bun install        # inside this directory (self-contained node_modules)
bun index.ts       # serve on :8100
bunx tsc --noEmit  # strict typecheck
bash test-bridge.sh  # real end-to-end test incl. live provider calls
```

`test-bridge.sh` starts the service, exercises health / llm / tts (single +
multi-chunk) / stt-invalid / embeddings, asserts responses, prints latency, and
shuts the service down. It makes **real** provider calls.
