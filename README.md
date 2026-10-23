# VITALORA AI

**Enterprise-grade multilingual healthcare AI voice receptionist platform.**

VITALORA AI lets healthcare organizations configure AI receptionists that hold real
voice conversations with patients: answering clinic questions from approved knowledge,
checking true availability, booking/rescheduling/cancelling appointments with
backend-validated conflict prevention, requesting staff callbacks, and escalating
to humans — including an instant emergency bypass.

> **Honesty notice:** This is a working foundation, not a certified production system.
> The AI receptionist always identifies itself as AI. No HIPAA compliance is claimed.
> See [docs/security.md](docs/security.md) for the current posture and limitations.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, TypeScript (strict), Tailwind CSS 4, shadcn/ui, Framer Motion |
| Backend | Python 3.12, FastAPI, Pydantic v2, WebSockets, JWT (PyJWT) + argon2id |
| AI & voice | Provider-independent abstraction → ZAI bridge sidecar (Bun + z-ai-web-dev-sdk) or OpenAI; STT + LLM + TTS; turn-based voice over WebSocket |
| Database | **Turso (libSQL/SQLite)** — primary and required; FTS5 for RAG retrieval |
| Infra | Docker + Docker Compose, GitHub Actions CI, structured JSON logs, health/readiness probes |

## Repository layout

```
apps/web/                Next.js application (marketing, auth, dashboard, voice lab)
services/ai-backend/     FastAPI API + AI orchestrator + voice WebSocket
services/ai-bridge/      Bun sidecar exposing LLM/STT/TTS (z-ai-web-dev-sdk)
packages/shared-types/   TypeScript contract types
packages/api-client/     Typed API client with token refresh handling
database/migrations/     Versioned SQL migrations (applied by the backend runner)
database/seeds/          (seed logic lives in services/ai-backend/app/db/seed.py)
docs/                    architecture, setup, security, testing, deployment, api
tests/                   reserved for cross-service e2e additions
scripts/                 dev helper scripts
.github/workflows/       CI (ruff, pytest, tsc, eslint, next build, tsc bridge)
```

## Quickstart (local, no Docker)

Prerequisites: Python 3.12+, Bun 1.3+, a Turso database.

```bash
# 1) Configure
cp .env.example .env.local            # then fill in real values (never committed)

# 2) Database schema
cd services/ai-backend
python -m pip install -r requirements.txt
python -m app.db.migrations upgrade   # creates all tables on Turso
python -m app.db.seed                 # optional demo organization (synthetic data)
cd ../..

# 3) Run the three services (separate terminals)
bun install
bun run dev:bridge                    # AI bridge  -> http://localhost:8100
bun run dev:backend                   # FastAPI    -> http://localhost:8000
bun run dev                           # Web        -> http://localhost:3000
```

Open http://localhost:3000 — sign in with the seeded demo org
(`admin@demo.vitalora.ai`, password from `SEED_ADMIN_PASSWORD`, default `Vitalora#Demo2024`)
or register your own organization. Then open **Voice Lab** and talk to "Amara".

## Docker Compose

```bash
cp .env.example .env.local            # fill in real values
docker compose up --build             # web :3000, backend :8000, bridge :8100
```

## Environment variables

See [.env.example](.env.example) for the full annotated reference. Key variables:

| Variable | Purpose |
|---|---|
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Turso credentials (**required**) |
| `JWT_SECRET` | Token signing key (**required**, 64-char hex) |
| `AI_BRIDGE_URL` | Bridge sidecar URL (default `http://127.0.0.1:8100`) |
| `LLM_PROVIDER` / `STT_PROVIDER` / `TTS_PROVIDER` | `zai` (bridge) or `openai` (+ `OPENAI_API_KEY`) |
| `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_API_PORT` | How the browser reaches the API (see docs/api.md) |
| `CORS_ORIGINS`, `COOKIE_SECURE`, `COOKIE_SAMESITE` | Browser security configuration |
| `SEED_ADMIN_PASSWORD` | Password for the dev-only demo seed |

## Feature map

- **Marketing site** — premium glass design, honest copy, no fabricated claims.
- **Auth & onboarding** — organization self-registration, JWT access tokens,
  rotating refresh tokens in httpOnly cookies, RBAC (owner/org_admin/clinic_admin/staff/analyst).
- **Dashboard** — real SQL aggregates: appointments, call activity, escalations, analytics series.
- **AI receptionists** — full configuration: persona, languages, voice, speed, greeting,
  capabilities, escalation policy, safety guidance.
- **Appointments** — day/week/list calendar, availability engine (clinic hours, exceptions,
  provider time-off, timezone-aware), transactional booking with conflict prevention and
  idempotent retries, reschedule/cancel with audit history.
- **Knowledge base** — approved clinic documents, automatic chunking, FTS5 retrieval,
  "retrieval preview" showing exactly what the AI can see.
- **Voice Laboratory** — genuine two-way browser voice: mic capture with VAD, live
  transcript, tool-call visibility, barge-in, keyboard fallback.
- **Call history & analytics** — transcripts, outcomes, durations, languages, export.
- **Organization settings** — profile, clinics & weekly hours, providers, services,
  security posture and full audit trail.

## Multilingual support (honest scope)

Configured languages: English, Urdu, Hindi, Arabic. Language locking, per-receptionist
language configuration and voice selection are implemented. Speech recognition and
synthesis quality per language depends on the selected provider — verify with real
recordings before advertising any language (the voice lab exists exactly for this).

## Known limitations (spec §20/§21 — stated plainly)

- Telephone integration (Twilio etc.) is **not** implemented; the architecture reserves
  a modular place for it. Browser testing only.
- Vector similarity search is not available on the current Turso instance; retrieval
  uses FTS5 (verified). A dedicated vector service is the documented upgrade path.
- Rate limiting is in-process (single instance). Use a shared store for horizontal scale.
- Email flows (verification, password reset) return honest 501s until an SMTP provider
  is configured.
- No HIPAA assessment has been performed. Use synthetic data only in demo environments.

## License / ownership

Delivered to the repository owner. All patient data in seeds and tests is synthetic.
