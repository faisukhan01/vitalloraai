# Architecture

## System overview

```
Browser (Next.js 16, apps/web)
  │  HTTPS: marketing, dashboard, voice lab (React 19, TanStack Query)
  │  REST  /api/v1/*  ──────────────┐
  │  WS    /api/v1/voice/ws/{id} ───┤
  ▼                                 ▼
FastAPI (services/ai-backend)   ──►  Turso (libSQL, remote)
  │  REST API v1, JWT auth, RBAC, audit, analytics
  │  AI orchestrator: safety pre-check → RAG (FTS5) → LLM tool-loop → TTS
  ▼
AI bridge sidecar (services/ai-bridge, Bun on :8100)
  │  z-ai-web-dev-sdk (Node-only SDK wrapped behind HTTP)
  ▼
ZAI LLM / ASR / TTS services
```

## Why each piece exists

- **Provider abstraction (`app/providers/base.py`)** — the orchestrator depends on
  `LLMProvider / STTProvider / TTSProvider` protocols. Default implementation calls the
  bridge sidecar because `z-ai-web-dev-sdk` is Node-only and cannot run inside FastAPI.
  Swapping to OpenAI (or any vendor) is an env-var change, not a rewrite.
- **Bridge sidecar** — one small, stateless HTTP service. In Docker it runs as a
  sidecar; at cloud scale it is an independently scalable deployment.
- **Turso/libSQL** — primary and required datastore (spec §3). SQLite semantics mean:
  single-writer transactions (`BEGIN IMMEDIATE` for bookings), no native vector search on
  this instance (verified) → retrieval uses **FTS5** with external-content tables and
  triggers. Partial unique indexes give conflict prevention and idempotent booking at the
  storage layer, not just application checks.
- **Turn-based voice over WebSocket** — utterance-level pipeline (record → STT → LLM →
  TTS → play) instead of continuous streaming. This is a deliberate first-release
  trade-off: it is fully functional, testable, and survives the sandbox gateway; true
  duplex streaming (WebRTC/PCM) is the documented next step.

## Data flow of one voice turn

1. Browser VAD detects end-of-speech → uploads webm/opus utterance over the WS.
2. Backend persists a session-bound message and calls STT provider.
3. Empty transcript → polite retry (TTS). Otherwise transcript is echoed and persisted.
4. **Safety pre-check**: emergency keyword match (EN/UR/HI patterns) → immediate
   `transfer_to_human` escalation without waiting for the LLM.
5. **RAG**: FTS5 search over the org's approved knowledge chunks (top 3, bm25 rank).
6. **LLM turn**: system prompt (identity, language lock, clinic facts, booking sequence,
   medical safety) + history + knowledge → response must be `{"say": ...}` or
   `{"tool": ..., "arguments": ...}`. Tools run through validated, org-scoped executors;
   errors are fed back to the model honestly. Max 4 tool iterations per turn.
7. **TTS** synthesizes the final reply; audio streams back; everything persists
   (messages, tool calls, usage records, outcome hints).

## Tenancy and authorization

Every table that holds tenant data carries `organization_id`; **every** repository query
filters by the organization embedded in the verified JWT — never from client input.
RBAC roles: `owner ⊃ org_admin ⊃ clinic_admin ⊃ staff ⊃ analyst` with a permission
matrix in `app/core/permissions.py`. Cross-organization access is covered by tests
(`tests/test_api.py::...cross org...`).

## Latency budget (measured, sandbox, ZAI provider)

| Stage | Typical |
|---|---|
| STT (utterance) | 0.3–0.8 s |
| LLM turn (1–2 calls) | 0.5–2.0 s |
| TTS (2–3 sentences) | 1.5–3.0 s |
| Total per turn | ~2.5–5.5 s |

Turn-based voice keeps this acceptable; streaming STT/TTS would cut perceived latency further.

## Scaling notes

- Backend is stateless (DB-backed sessions) → scale horizontally behind a load balancer;
  move rate limiting to a shared store (Redis) first.
- Bridge is stateless → scale per voice-traffic; watch provider rate limits (observed
  TTS 429s; the bridge retries with backoff and synthesizes chunks sequentially).
- Turso: embedded replicas (local read cache + remote writes) are the standard Turso
  scaling path; not enabled in this first release.
- Voice: for phone integration, connect a provider (e.g. Twilio Media Streams) to the
  same WS pipeline; the module boundary is the session WS contract.
