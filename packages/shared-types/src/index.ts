/**
 * VITALORA AI — shared TypeScript types (contract between web app and FastAPI backend).
 * Mirrors the Pydantic schemas in services/ai-backend/app/schemas/.
 */

export type Role = "owner" | "org_admin" | "clinic_admin" | "staff" | "analyst";

export type AppointmentStatus =
  | "booked"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show"
  | "rescheduled";

export type SessionStatus = "active" | "completed" | "failed" | "escalated";

export type SessionOutcome =
  | "appointment_booked"
  | "appointment_cancelled"
  | "appointment_rescheduled"
  | "callback_requested"
  | "transferred_to_human"
  | "info_provided"
  | "unresolved"
  | null;

export type KnowledgeDocStatus = "pending" | "processing" | "indexed" | "failed" | "inactive";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  created_at: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  organization_id: string;
  email_verified: boolean;
  created_at: string;
}

export interface MeResponse {
  user: User;
  organization: Organization;
  permissions: string[];
}

export interface AuthTokens {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface LoginResponse extends AuthTokens {
  user: User;
}

export interface RegisterOrgResponse extends LoginResponse {
  organization: Organization;
}

export interface Clinic {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  timezone: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
}

export interface ClinicHours {
  id: string;
  clinic_id: string;
  day_of_week: number; // 0=Monday .. 6=Sunday (Python weekday() convention — matches backend)
  open_time: string; // "HH:MM"
  close_time: string;
  is_closed: boolean;
}

export interface Provider {
  id: string;
  organization_id: string;
  clinic_id: string;
  /** Denormalized by the backend list JOIN (optional so older payloads stay valid). */
  clinic_name?: string | null;
  name: string;
  specialty: string | null;
  email: string | null;
  phone: string | null;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
}

export interface Service {
  id: string;
  organization_id: string;
  clinic_id: string;
  /** Denormalized by the backend list JOIN (optional so older payloads stay valid). */
  clinic_name?: string | null;
  name: string;
  description: string | null;
  duration_minutes: number;
  price_display: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Receptionist {
  id: string;
  organization_id: string;
  clinic_id: string;
  name: string;
  persona: string | null;
  status: "draft" | "active" | "paused";
  languages: string[];
  primary_language: string;
  voice_provider: string;
  voice_id: string;
  speaking_speed: number;
  greeting_message: string | null;
  system_prompt_extra: string | null;
  capabilities: {
    booking: boolean;
    knowledge_qa: boolean;
    callback_requests: boolean;
  };
  escalation: {
    transfer_message?: string;
    callback_number?: string;
    emergency_guidance?: string;
  };
  created_at: string;
  updated_at: string;
}

export interface Appointment {
  id: string;
  organization_id: string;
  clinic_id: string;
  provider_id: string;
  service_id: string;
  receptionist_id: string | null;
  patient_name: string;
  patient_phone: string | null;
  patient_email: string | null;
  patient_notes: string | null;
  starts_at: string; // ISO UTC
  ends_at: string;
  duration_minutes: number;
  status: AppointmentStatus;
  cancellation_reason: string | null;
  source: "web" | "voice" | "api";
  created_at: string;
  updated_at: string;
}

export interface AvailabilitySlot {
  starts_at: string;
  ends_at: string;
  provider_id: string;
  provider_name: string;
  service_id: string;
  duration_minutes: number;
}

export interface ConversationSession {
  id: string;
  organization_id: string;
  clinic_id: string;
  receptionist_id: string;
  channel: "browser" | "phone" | "api";
  language: string;
  /** Resolved by the backend list JOIN (optional so older payloads stay valid). */
  receptionist_name?: string | null;
  status: SessionStatus;
  outcome: SessionOutcome;
  end_reason: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  caller_ref: string | null;
}

export interface ConversationMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  tool_name: string | null;
  /** Raw tool result payload (JSON string) returned by the backend; UI uses it only for export. */
  tool_payload?: string | null;
  latency_ms: number | null;
  created_at: string;
}

export interface KnowledgeDocument {
  id: string;
  organization_id: string;
  clinic_id: string | null;
  title: string;
  source_type: "manual" | "faq" | "document" | "url";
  content_text: string;
  status: KnowledgeDocStatus;
  chunk_count: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSearchResult {
  chunk_id: string;
  document_id: string;
  document_title: string;
  content: string;
  score: number;
}

export interface CallbackRequest {
  id: string;
  organization_id: string;
  clinic_id: string | null;
  session_id: string | null;
  patient_name: string;
  patient_phone: string;
  reason: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "assigned" | "completed" | "cancelled";
  created_at: string;
  completed_at: string | null;
}

export interface AuditEvent {
  id: string;
  organization_id: string;
  actor_user_id: string | null;
  actor_type: "user" | "system" | "ai_receptionist";
  actor_display: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface DashboardOverview {
  appointments_today: number;
  appointments_upcoming: number;
  calls_last_24h: number;
  calls_last_7d: number;
  bookings_via_voice_7d: number;
  escalations_open: number;
  receptionists_active: number;
  receptionists_total: number;
  avg_session_seconds_7d: number | null;
  success_rate_7d: number | null; // share of sessions with a resolved outcome
}

export interface AnalyticsSeriesPoint {
  date: string;
  sessions: number;
  bookings: number;
  escalations: number;
}

export interface AnalyticsResponse {
  series: AnalyticsSeriesPoint[];
  outcomes: { outcome: string; count: number }[];
  languages: { language: string; count: number }[];
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> | null };
  request_id?: string;
}

export const SUPPORTED_LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "ur", label: "اردو (Urdu)" },
  { code: "hi", label: "हिन्दी (Hindi)" },
  { code: "ar", label: "العربية (Arabic)" },
];

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  booked: "Booked",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  completed: "Completed",
  no_show: "No-show",
  rescheduled: "Rescheduled",
};
