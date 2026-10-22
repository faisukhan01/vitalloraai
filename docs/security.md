# Security

## Implemented controls

- **Authentication**: argon2id password hashing; JWT access tokens (30 min, HS256,
  `typ`-checked); refresh tokens (7 days) rotated server-side and stored as SHA-256
  hashes with revocation; refresh delivered in an `httpOnly` cookie (`Secure` +
  `SameSite` configurable for HTTPS deployments).
- **Authorization**: role-based permission matrix (owner / org_admin / clinic_admin /
  staff / analyst) enforced **on the backend** for every sensitive route via
  `require_permission(...)`; least-privilege defaults.
- **Tenant isolation**: every tenant-owned table carries `organization_id`; every query
  filters by the organization embedded in the verified token. Covered by automated
  cross-organization tests (404 on foreign appointments).
- **Input validation**: Pydantic v2 schemas on all requests; parameterized SQL
  everywhere (no string interpolation of user data, enforced by code review + tests).
- **Booking integrity**: transactional booking (`BEGIN IMMEDIATE`) + overlap check +
  partial unique index `(provider_id, starts_at) WHERE status IN ('booked','confirmed')`;
  idempotency keys prevent duplicate appointments on retries.
- **AI containment**: the LLM cannot execute SQL or admin commands — only the nine
  narrowly scoped, validated tools; tool args are Pydantic-validated; every AI action
  writes an audit event with `actor_type='ai_receptionist'`.
- **Emergency handling**: keyword triage bypasses the LLM entirely and escalates.
- **Rate limiting**: per-IP sliding window on auth endpoints (register 5/h, login 10/min,
  refresh 30/min) and on error budgets; in-process (see limitations).
- **Error hygiene**: structured JSON logs with correlation IDs; secrets/audio redacted
  from logs by a denylist; error responses never leak stack traces or internals.
- **Transport**: libSQL and provider calls are TLS; cookies configurable to `Secure`.

## Honest limitations (do not deploy to production healthcare traffic yet)

1. **No HIPAA assessment** has been performed. No BAAs exist with AI providers. Do not
   send real patient data through the default providers.
2. **Rate limiting is per-process** — horizontal scaling requires a shared store (Redis).
3. **Email flows are not configured** (verification, password reset return honest 501s).
4. **Session revocation** covers refresh tokens; access tokens remain valid until expiry
   (≤ 30 min by design). For instant kill-switch, reduce `ACCESS_TOKEN_EXPIRE_MINUTES`.
5. **Transcripts** are stored (configurable retention `TRANSCRIPT_RETENTION_DAYS`, default
   90) — implement a scheduled deletion job before production use; audio is not retained.
6. **CORS** defaults to `*` for development — set explicit origins in production and
   `COOKIE_SECURE=true`, `COOKIE_SAMESITE=none` behind HTTPS.
7. **Secrets** live in `.env.local` (gitignored). If a credential ever leaks, rotate the
   Turso token (`turso db tokens create`) and `JWT_SECRET` (invalidates all sessions).

## Report exposure

If you discover a vulnerability, contact the repository owner. Please do not test
against the demo organization with real patient data.
