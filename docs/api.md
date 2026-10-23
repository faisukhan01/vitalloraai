# API Reference (v1)

Base URL: `/api/v1` · Interactive docs: `/api/docs` (Swagger UI) · OpenAPI: `/api/openapi.json`

Auth: `Authorization: Bearer <access_token>` on protected routes. Tokens come from
`POST /auth/login` / `POST /auth/register-org`; refresh rotation via
`POST /auth/refresh` (httpOnly cookie or body token). Errors use
`{"error": {"code", "message", "details?}, "request_id"}` with appropriate HTTP status.

## Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register-org` | Create org + owner. Body: `{organization:{name,slug?}, admin:{name,email,password}}` |
| POST | `/auth/login` | `{email,password,org_slug?}` — 409 with `details.organizations` when the email exists in multiple orgs |
| POST | `/auth/refresh` | Rotates refresh token, returns new access token |
| POST | `/auth/logout` | Revokes the presented session |
| GET | `/auth/me` | Profile + organization + permission list |
| POST | `/auth/change-password` | Revokes all sessions |

## Organization resources (org-scoped, RBAC-gated)
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/clinics` | List/create; auto-slug; dup slug → 409 |
| GET/PATCH/DELETE | `/clinics/{id}` | |
| GET/PUT | `/clinics/{id}/hours` | Weekly hours (0=Monday … 6=Sunday) |
| GET/POST | `/providers` · `/providers/{id}` (+ `/{id}/time-off`) | Clinical staff |
| GET/POST | `/services` · `/services/{id}` | duration_minutes 5–480 |
| GET/POST | `/receptionists` · GET/PATCH/DELETE `/{id}` | Full voice/persona/capabilities/escalation config; DELETE only in `draft` |

## Appointments
| Method | Path | Notes |
|---|---|---|
| GET | `/appointments` | Filters: `from,to,clinic_id,provider_id,status,search,page,page_size` |
| GET | `/appointments/availability` | `service_id,date,provider_id?,days?` → `{slots:[{starts_at,ends_at,provider_id,provider_name,service_id,duration_minutes,day}]}` |
| POST | `/appointments` | Transactional booking; `idempotency_key` supported; conflicts → 409 |
| POST | `/appointments/{id}/reschedule` | Re-validates availability |
| POST | `/appointments/{id}/cancel` | `reason` required |
| PATCH | `/appointments/{id}` | Status transitions (confirmed/completed/no_show) |

## Knowledge (RAG)
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/knowledge/documents` | Create → auto-chunk + FTS index |
| GET/PATCH/DELETE | `/knowledge/documents/{id}` | PATCH re-indexes |
| POST | `/knowledge/documents/{id}/reindex` | Force re-chunk |
| GET | `/knowledge/search?q=&limit=` | FTS5 bm25-ranked, org-scoped |

## Voice & calls
| Method | Path | Notes |
|---|---|---|
| POST | `/voice/sessions` | `{receptionist_id, language}` → session + greeting (receptionist must be `active`) |
| POST | `/voice/sessions/{id}/end` | `{end_reason}` → finalizes duration/outcome |
| WS | `/voice/ws/{session_id}?token=<access>` | Turn pipeline. Client→`{"type":"audio"|"text"|"greet"|"end"}`; Server→`status/transcript/tool/audio/error/ended` |
| GET | `/calls/sessions` · `/calls/sessions/{id}/messages` | History + transcript explorer |

## Analytics, audit, callbacks, ops
| Method | Path | Notes |
|---|---|---|
| GET | `/analytics/overview` | Real aggregates for the dashboard |
| GET | `/analytics/series?days=` | Daily series + outcome/language breakdown |
| GET | `/audit` | Audit trail (`audit:read`) |
| GET/PATCH | `/callbacks` · `/callbacks/{id}` | Staff callback requests |
| GET | `/health` (root) · `/api/v1/ready` | Liveness / readiness (DB probe) |

## Sandbox gateway note
Inside the Z.ai sandbox the browser reaches the backend through the Caddy gateway:
same-origin paths with `?XTransformPort=8000` (handled by `packages/api-client`).
Production deployments use `NEXT_PUBLIC_API_URL` instead — see docs/deployment.md.
