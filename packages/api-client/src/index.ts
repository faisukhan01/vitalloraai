/**
 * VITALORA AI — typed API client used by the web app.
 *
 * URL modes:
 *  - Sandbox gateway (default): NEXT_PUBLIC_API_URL empty + NEXT_PUBLIC_API_PORT=8000
 *    → requests go same-origin with ?XTransformPort=8000 (Caddy reverse proxy).
 *  - Production: NEXT_PUBLIC_API_URL=https://api.example.com, port empty
 *    → requests go to the absolute API base (CORS credentials apply).
 *
 * Auth: access token in memory; refresh token in an httpOnly cookie set by the
 * backend. On a 401 the client retries once after /auth/refresh.
 */

import type {
  AnalyticsResponse,
  ApiErrorBody,
  Appointment,
  AuditEvent,
  AuthTokens,
  AvailabilitySlot,
  CallbackRequest,
  Clinic,
  ClinicHours,
  ConversationMessage,
  ConversationSession,
  DashboardOverview,
  KnowledgeDocument,
  KnowledgeSearchResult,
  LoginResponse,
  MeResponse,
  Paginated,
  Provider,
  Receptionist,
  RegisterOrgResponse,
  Service,
} from "@vitalora/shared-types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const API_PORT = process.env.NEXT_PUBLIC_API_PORT ?? "";

function buildUrl(path: string): string {
  const base = API_URL || "";
  // All REST paths are relative to the versioned API root unless they already
  // carry it (defensive for callers passing "/api/v1/...").
  const prefixed = path.startsWith("/api/") ? path : `/api/v1${path}`;
  const full = `${base}${prefixed}`;
  if (!API_URL && API_PORT) {
    const sep = full.includes("?") ? "&" : "?";
    return `${full}${sep}XTransformPort=${API_PORT}`;
  }
  return full;
}

export function voiceWebSocketUrl(sessionId: string, token: string): string {
  const path = `/api/v1/voice/ws/${sessionId}`;
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  if (!API_URL && API_PORT) {
    return `${proto}//${host}${path}?XTransformPort=${API_PORT}&token=${encodeURIComponent(token)}`;
  }
  const apiHost = API_URL ? new URL(API_URL).host : host;
  return `${proto}//${apiHost}${path}?token=${encodeURIComponent(token)}`;
}

export class ApiError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown> | null;
  requestId?: string;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? `Request failed with status ${status}`);
    this.status = status;
    this.code = body.error?.code ?? "unknown";
    this.details = body.error?.details ?? null;
    this.requestId = body.request_id;
  }
}

type Listener = () => void;

/**
 * sessionStorage key for the short-lived access token.
 *
 * Purpose: preview panels (and privacy-restricted browsers) may block the
 * httpOnly refresh cookie, so a page reload would otherwise sign the user
 * out right after signing in. We mirror the 30-minute access token into
 * sessionStorage — per-tab, cleared when the tab closes — as a bootstrap
 * fallback. The long-lived refresh token itself is NEVER stored here.
 */
const SESSION_TOKEN_KEY = "vitalora_at";

export class ApiClient {
  private accessToken: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private unauthorizedListeners: Listener[] = [];

  setToken(token: string | null) {
    this.accessToken = token;
    if (typeof window === "undefined") return;
    try {
      if (token) window.sessionStorage.setItem(SESSION_TOKEN_KEY, token);
      else window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
    } catch {
      // Storage unavailable (private mode) — in-memory token still works.
    }
  }

  getToken() {
    return this.accessToken;
  }

  private readStoredToken(): string | null {
    if (typeof window === "undefined") return null;
    try {
      return window.sessionStorage.getItem(SESSION_TOKEN_KEY);
    } catch {
      return null;
    }
  }

  onUnauthorized(listener: Listener) {
    this.unauthorizedListeners.push(listener);
    return () => {
      this.unauthorizedListeners = this.unauthorizedListeners.filter((l) => l !== listener);
    };
  }

  private async rawRequest<T>(
    method: string,
    path: string,
    opts: { json?: unknown; query?: Record<string, string | number | boolean | undefined | null>; auth?: boolean; retryOn401?: boolean } = {},
  ): Promise<T> {
    const url = new URL(buildUrl(path), typeof window !== "undefined" ? window.location.origin : "http://localhost");
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {};
    if (opts.json !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth !== false && this.accessToken) headers["Authorization"] = `Bearer ${this.accessToken}`;

    const res = await fetch(url.toString(), {
      method,
      headers,
      credentials: "include",
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
    });

    if (res.status === 401 && opts.auth !== false && opts.retryOn401 !== false && path !== "/auth/refresh") {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        return this.rawRequest<T>(method, path, { ...opts, retryOn401: false });
      }
      // Session is definitively gone — drop any persisted fallback token.
      this.setToken(null);
      this.unauthorizedListeners.forEach((l) => l());
    }

    if (!res.ok) {
      let body: ApiErrorBody;
      try {
        body = await res.json();
      } catch {
        body = { error: { code: "http_error", message: `Request failed (${res.status})` } };
      }
      throw new ApiError(res.status, body);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async tryRefresh(): Promise<boolean> {
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        try {
          const tokens = await this.rawRequest<AuthTokens>("POST", "/auth/refresh", { auth: false, retryOn401: false });
          this.accessToken = tokens.access_token;
          this.setToken(tokens.access_token);
          return true;
        } catch {
          return false;
        } finally {
          this.refreshPromise = null;
        }
      })();
    }
    return this.refreshPromise;
  }

  // ── Auth ────────────────────────────────────────────────────────────────
  async login(email: string, password: string, orgSlug?: string): Promise<LoginResponse> {
    const res = await this.rawRequest<LoginResponse>("POST", "/auth/login", {
      json: { email, password, org_slug: orgSlug || null },
      auth: false,
    });
    this.setToken(res.access_token);
    return res;
  }

  async registerOrganization(payload: {
    organization: { name: string; slug?: string };
    admin: { name: string; email: string; password: string };
  }): Promise<RegisterOrgResponse> {
    const res = await this.rawRequest<RegisterOrgResponse>("POST", "/auth/register-org", { json: payload, auth: false });
    this.setToken(res.access_token);
    return res;
  }

  async me(): Promise<MeResponse> {
    return this.rawRequest<MeResponse>("GET", "/auth/me");
  }

  async logout(): Promise<void> {
    try {
      await this.rawRequest("POST", "/auth/logout", { auth: false });
    } finally {
      this.accessToken = null;
    }
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<{ message: string }> {
    const res = await this.rawRequest<{ message: string }>("POST", "/auth/change-password", {
      json: { current_password: currentPassword, new_password: newPassword },
    });
    this.setToken(null);
    return res;
  }

  async bootstrapSession(): Promise<MeResponse | null> {
    // Refresh-cookie bootstrap: returns profile if a valid session cookie exists.
    const ok = await this.tryRefresh();
    if (ok) {
      try {
        return await this.me();
      } catch {
        return null;
      }
    }
    // Cookie blocked or expired (e.g. preview iframe / strict privacy mode):
    // fall back to the per-tab access token captured at sign-in.
    const stored = this.readStoredToken();
    if (!stored) return null;
    this.accessToken = stored;
    try {
      return await this.me();
    } catch {
      this.setToken(null);
      return null;
    }
  }

  // ── Clinics / providers / services ─────────────────────────────────────
  listClinics() {
    return this.rawRequest<Paginated<Clinic>>("GET", "/clinics");
  }
  createClinic(payload: Partial<Clinic> & { name: string }) {
    return this.rawRequest<Clinic>("POST", "/clinics", { json: payload });
  }
  listProviders(clinicId?: string) {
    return this.rawRequest<Paginated<Provider>>("GET", "/providers", { query: { clinic_id: clinicId } });
  }
  createProvider(payload: Partial<Provider> & { name: string; clinic_id: string }) {
    return this.rawRequest<Provider>("POST", "/providers", { json: payload });
  }
  listServices(clinicId?: string) {
    return this.rawRequest<Paginated<Service>>("GET", "/services", { query: { clinic_id: clinicId } });
  }
  createService(payload: Partial<Service> & { name: string; clinic_id: string }) {
    return this.rawRequest<Service>("POST", "/services", { json: payload });
  }
  getClinicHours(clinicId: string) {
    return this.rawRequest<ClinicHours[]>("GET", `/clinics/${clinicId}/hours`);
  }
  /**
   * Replace the whole weekly hours table for a clinic.
   * Backend request schema (services/ai-backend app/api/v1/clinics.py PUT
   * /clinics/{id}/hours): { days: [{ day_of_week, open_time, close_time,
   * is_closed }] } — day_of_week uses the Python weekday() convention
   * 0=Monday .. 6=Sunday. Sends only the fields the backend accepts.
   */
  updateClinicHours(clinicId: string, hours: ClinicHours[]) {
    return this.rawRequest<ClinicHours[]>("PUT", `/clinics/${clinicId}/hours`, {
      json: {
        days: hours.map((h) => ({
          day_of_week: h.day_of_week,
          open_time: h.open_time,
          close_time: h.close_time,
          is_closed: h.is_closed,
        })),
      },
    });
  }

  // ── Receptionists ───────────────────────────────────────────────────────
  listReceptionists(status?: string) {
    return this.rawRequest<Paginated<Receptionist>>("GET", "/receptionists", { query: { status } });
  }
  getReceptionist(id: string) {
    return this.rawRequest<Receptionist>("GET", `/receptionists/${id}`);
  }
  createReceptionist(payload: Partial<Receptionist> & { name: string; clinic_id: string }) {
    return this.rawRequest<Receptionist>("POST", "/receptionists", { json: payload });
  }
  updateReceptionist(id: string, payload: Partial<Receptionist>) {
    return this.rawRequest<Receptionist>("PATCH", `/receptionists/${id}`, { json: payload });
  }
  deleteReceptionist(id: string) {
    return this.rawRequest<{ message: string }>("DELETE", `/receptionists/${id}`);
  }

  // ── Appointments ────────────────────────────────────────────────────────
  listAppointments(query: { from?: string; to?: string; clinic_id?: string; provider_id?: string; status?: string; search?: string; page?: number; page_size?: number }) {
    return this.rawRequest<Paginated<Appointment>>("GET", "/appointments", { query });
  }
  getAvailability(query: { service_id: string; date: string; provider_id?: string; days?: number }) {
    return this.rawRequest<{ slots: AvailabilitySlot[] }>("GET", "/appointments/availability", { query });
  }
  createAppointment(payload: {
    clinic_id: string;
    provider_id: string;
    service_id: string;
    patient_name: string;
    patient_phone?: string;
    patient_email?: string;
    patient_notes?: string;
    starts_at: string;
    idempotency_key?: string;
  }) {
    return this.rawRequest<Appointment>("POST", "/appointments", { json: payload });
  }
  rescheduleAppointment(id: string, starts_at: string) {
    return this.rawRequest<Appointment>("POST", `/appointments/${id}/reschedule`, { json: { starts_at } });
  }
  cancelAppointment(id: string, reason?: string) {
    return this.rawRequest<Appointment>("POST", `/appointments/${id}/cancel`, { json: { reason: reason ?? null } });
  }
  updateAppointmentStatus(id: string, status: Appointment["status"]) {
    return this.rawRequest<Appointment>("PATCH", `/appointments/${id}`, { json: { status } });
  }

  // ── Knowledge ───────────────────────────────────────────────────────────
  listKnowledgeDocuments(query?: { status?: string; search?: string; page?: number }) {
    return this.rawRequest<Paginated<KnowledgeDocument>>("GET", "/knowledge/documents", { query });
  }
  createKnowledgeDocument(payload: { title: string; source_type: KnowledgeDocument["source_type"]; content_text: string; clinic_id?: string }) {
    return this.rawRequest<KnowledgeDocument>("POST", "/knowledge/documents", { json: payload });
  }
  updateKnowledgeDocument(id: string, payload: { title?: string; content_text?: string; status?: KnowledgeDocument["status"] }) {
    return this.rawRequest<KnowledgeDocument>("PATCH", `/knowledge/documents/${id}`, { json: payload });
  }
  deleteKnowledgeDocument(id: string) {
    return this.rawRequest<{ message: string }>("DELETE", `/knowledge/documents/${id}`);
  }
  reindexKnowledgeDocument(id: string) {
    return this.rawRequest<KnowledgeDocument>("POST", `/knowledge/documents/${id}/reindex`);
  }
  searchKnowledge(query: string, limit = 5) {
    return this.rawRequest<{ results: KnowledgeSearchResult[] }>("GET", "/knowledge/search", { query: { q: query, limit } });
  }

  // ── Calls / sessions ────────────────────────────────────────────────────
  listSessions(query?: { status?: string; language?: string; from?: string; to?: string; page?: number; page_size?: number }) {
    return this.rawRequest<Paginated<ConversationSession>>("GET", "/calls/sessions", { query });
  }
  getSessionMessages(sessionId: string) {
    return this.rawRequest<{ session: ConversationSession; messages: ConversationMessage[] }>("GET", `/calls/sessions/${sessionId}/messages`);
  }
  createVoiceSession(payload: { receptionist_id: string; language: string }) {
    return this.rawRequest<{ session: ConversationSession; greeting_text: string | null }>("POST", "/voice/sessions", { json: payload });
  }
  endVoiceSession(sessionId: string, endReason: string) {
    return this.rawRequest<{ session: ConversationSession }>("POST", `/voice/sessions/${sessionId}/end`, { json: { end_reason: endReason } });
  }

  // ── Analytics / audit / callbacks ───────────────────────────────────────
  getDashboardOverview() {
    return this.rawRequest<DashboardOverview>("GET", "/analytics/overview");
  }
  getAnalytics(days = 14) {
    return this.rawRequest<AnalyticsResponse>("GET", "/analytics/series", { query: { days } });
  }
  listAuditEvents(query?: { page?: number; action?: string }) {
    return this.rawRequest<Paginated<AuditEvent>>("GET", "/audit", { query });
  }
  listCallbacks(query?: { status?: string }) {
    return this.rawRequest<Paginated<CallbackRequest>>("GET", "/callbacks", { query });
  }
  updateCallbackStatus(id: string, status: CallbackRequest["status"]) {
    return this.rawRequest<CallbackRequest>("PATCH", `/callbacks/${id}`, { json: { status } });
  }
}

export const api = new ApiClient();
