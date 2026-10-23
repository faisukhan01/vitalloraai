# Deployment

## Topology

Three containers (see `docker-compose.yml`): **web** (Next.js standalone),
**backend** (FastAPI + WebSockets), **ai-bridge** (Bun sidecar). Turso is external
(libsql:// over TLS). No other infrastructure is required.

## One-domain layout (recommended)

```
https://clinic.example.com      → web      (containers: 3000)
https://clinic.example.com/api  → backend  (8000)   # proxy, WebSocket-capable
(internal)                      → bridge   (8100)   # never exposed publicly
```

For this layout set in `.env.local`:

```ini
NEXT_PUBLIC_API_URL=            # empty → same-origin /api paths
NEXT_PUBLIC_API_PORT=           # empty → no gateway suffix
CORS_ORIGINS=https://clinic.example.com
COOKIE_SECURE=true
COOKIE_SAMESITE=lax             # same-origin deployment
```

And reverse-proxy `/api` (including Upgrade/Connection headers for the voice
WebSocket) to the backend container.

## Two-domain layout (e.g. Vercel + Fly.io)

```ini
NEXT_PUBLIC_API_URL=https://api.clinic.example.com
CORS_ORIGINS=https://clinic.example.com
COOKIE_SECURE=true
COOKIE_SAMESITE=none            # cross-site refresh cookie
```

## Build & deploy

```bash
docker build -f apps/web/Dockerfile -t vitalora-web .
docker build -t vitalora-backend services/ai-backend
docker build -t vitalora-bridge services/ai-bridge
```

Or a single `docker compose up --build` on a VM. Provide real credentials via the
platform's secret manager (never bake `TURSO_AUTH_TOKEN`/`JWT_SECRET` into images).

## First deployment checklist

1. `python -m app.db.migrations upgrade` (run once against the production database,
   from a trusted machine or a one-off container).
2. **Skip** `app.db.seed` in production (demo data is for development only).
3. Health checks: `/health` (liveness), `/api/v1/ready` (DB probe) — wire to your
   orchestrator; the compose file includes healthchecks.
4. Create the first owner via the registration page, then disable public registration
   if desired (rate limit already caps it; add an allowlist if required).
5. Verify the Voice Lab end-to-end on the public URL (HTTPS is required by browsers
   for microphone access).

## Future: ASP.NET Core enterprise extensions (spec §3)

The C# service slot is intentionally empty. The natural first extension is a
telephony/HL7 adapter that consumes the same REST API with a service account.
Nothing in the current architecture blocks it: the backend is a versioned REST+WS
API with machine-friendly auth (JWT bearer).

## Backups

Turso supports platform-managed backups/replicas — enable them; the schema is plain
SQL and fully reconstructible from `database/migrations/`.
