# Testing

## What exists

| Suite | Location | Runner | Scope |
|---|---|---|---|
| Backend integration | `services/ai-backend/tests/test_api.py` | `pytest` | **Real Turso**: auth (valid/invalid/multi-org), tenant isolation (cross-org → 404), clinics + hours, receptionist validation, availability engine, booking + duplicate-slot 409 + idempotent retry + key-reuse 409, reschedule conflicts, cancel (reason required), status transitions, knowledge CRUD + FTS search, analytics aggregates, audit, role gating (analyst 403), voice session lifecycle, callbacks |
| Orchestrator units | `services/ai-backend/tests/test_orchestrator.py` | `pytest` | Emergency detection (EN/UR), JSON extraction from LLM output (plain/fenced/prose/garbage), system-prompt rules (AI identity, language lock, knowledge injection, disabled capabilities), full tool registry shape, argument validation |
| Bridge script | `services/ai-bridge/test-bridge.sh` | bash | Real LLM/TTS calls, multi-chunk TTS, honest failure on bad audio |
| Frontend static | — | `tsc --noEmit`, `eslint` | Strict types, lint rules |
| Frontend build | — | `next build` | Production compile |

Latest local runs (recorded honestly): **22/22 backend tests passed**; bridge script
**7/7**; `tsc` and `eslint` clean; `next build` and dev-server smoke checks green.

## Running

```bash
# Backend (unit tests need no credentials; integration tests hit real Turso)
cd services/ai-backend
python -m pip install -r requirements.txt
python -m pytest tests/ -q -p no:cacheprovider

# Web
cd apps/web && bunx tsc --noEmit && bun run lint

# Bridge
cd services/ai-bridge && bash test-bridge.sh
```

## CI

`.github/workflows/ci.yml` runs on push/PR:
- **backend**: ruff + orchestrator units always; integration tests **only when**
  `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` repository secrets are configured (explicit
  skip message otherwise — never silently pretending tests ran).
- **web**: tsc + eslint + `next build`.
- **bridge**: tsc.

To enable the integration job: add the two Turso secrets to the GitHub repository
(Settings → Secrets and variables → Actions). CI uses a dedicated test database/token
with minimal privileges; it must NOT be the production database.

## Manual voice verification checklist (no automation substitutes a human ear yet)

1. Start a call in the Voice Lab → greeting is spoken.
2. Ask opening hours → answer matches the Knowledge Base (tool/RAG used; chip visible).
3. Book an appointment by voice → confirm details → success message; verify in Appointments.
4. Try to book the same slot twice → second attempt is rejected honestly.
5. Say "I have severe chest pain" → immediate escalation, no booking attempt.
6. Speak while the receptionist is talking → playback interrupts (barge-in).
7. Deny microphone → keyboard mode still completes a full turn.

## Not yet automated (documented, per spec §15 honesty)

- Playwright end-to-end browser flows (framework reserved in `tests/e2e/`).
- Multilingual STT/TTS quality scoring (requires human review of recordings).
- Load testing.
