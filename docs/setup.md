# Setup Guide

## Prerequisites

- Python 3.12+
- Bun 1.3+ (https://bun.sh)
- A Turso database (free tier works): `turso db create` → `turso db tokens create`
- Optional: Docker + Docker Compose for containerized runs

## 1. Environment configuration

```bash
cp .env.example .env.local
```

Fill in at minimum:

```ini
TURSO_DATABASE_URL=libsql://your-db-your-org.turso.io
TURSO_AUTH_TOKEN=your-token
JWT_SECRET=<python -c "import secrets; print(secrets.token_hex(32))">
```

Secrets live ONLY in `.env.local` (gitignored). Never commit credentials.

## 2. Install and initialize

```bash
bun install                                  # web + bridge workspaces

cd services/ai-backend
python -m pip install -r requirements.txt
python -m app.db.migrations upgrade          # applies database/migrations/*.sql to Turso
python -m app.db.migrations status           # verify
python -m app.db.seed                        # OPTIONAL demo org (synthetic data only)
cd ../..
```

Seeded demo login: `admin@demo.vitalora.ai` / value of `SEED_ADMIN_PASSWORD`
(default `Vitalora#Demo2024`) — development convenience only, plan badge shows "Demo data".

## 3. Run (three processes, three terminals)

```bash
bun run dev:bridge     # AI bridge sidecar  → http://localhost:8100  (GET /health)
bun run dev:backend    # FastAPI + WS       → http://localhost:8000  (GET /api/v1/ready)
bun run dev            # Next.js web        → http://localhost:3000
```

Verify: `curl localhost:8000/api/v1/ready` → `{"status":"ready","database":"connected"}`.

## 4. First-run walkthrough

1. Open http://localhost:3000 → **Get started** → register an organization.
2. **AI Receptionists** → create one (name, clinic, languages, voice) → **Activate**.
3. **Knowledge Base** → add a "Clinic operating hours" FAQ → watch it index.
4. **Appointments** → pick a slot → book (backend re-validates availability).
5. **Voice Lab** → select the receptionist → **Start Call** → ask
   "What are your opening hours?" or "Book me a general consultation tomorrow morning."
   Allow microphone access when prompted (or use the keyboard input — same pipeline).

## 5. Docker Compose

```bash
cp .env.example .env.local    # fill real values
docker compose up --build
```

- web → :3000, backend → :8000, bridge → :8100
- In compose, the backend reaches the bridge at `http://ai-bridge:8100` (already set).
- The browser reaches the backend at `http://localhost:8000` (set as build arg). For a
  public deployment behind one domain, see docs/deployment.md.

## 6. Switching AI providers

Default (`zai`): no extra keys — uses the bundled bridge.
OpenAI: set `LLM_PROVIDER=openai STT_PROVIDER=openai TTS_PROVIDER=openai OPENAI_API_KEY=sk-...`
in `.env.local`; the bridge is then unused by the backend.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Backend exits at startup with "Missing required environment configuration" | `.env.local` missing/empty next to required vars — copy `.env.example` |
| `/api/v1/ready` says `database: unavailable` | Wrong Turso URL/token, or network egress blocked |
| Voice lab: "The AI service is unreachable" | Bridge not running — `bun run dev:bridge`, check `curl :8100/health` |
| WS 403/4401 | Access token expired → sign in again; the client refreshes automatically |
| TTS "provider_error ... 429" | Provider rate limit; bridge retries with backoff — retry after a pause |
| No audio plays | Browser autoplay policy — interact with the page, then start the call |
