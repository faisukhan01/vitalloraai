import { format, formatDistanceToNowStrict, isValid } from "date-fns";
import { ApiError } from "@vitalora/api-client";

/**
 * Small API/UX helpers shared across the app:
 *  - mapApiError: converts thrown values (ApiError, network TypeError, …)
 *    into a human-friendly message for inline alerts and toasts.
 *  - formatDate / formatTime / formatDateTime: timezone-aware display.
 *    Pass `timeZone` (the clinic's IANA tz, e.g. from Clinic.timezone) to
 *    render in clinic-local time; omit it to use the viewer's timezone.
 *  - formatRelative: "3 minutes ago" style strings (date-fns).
 *  - initials: avatar fallback.
 */

/** Error codes produced by the backend error taxonomy (safe messages). */
const CODE_MESSAGES: Record<string, string> = {
  org_required:
    "This email is used in more than one organization. Choose your organization and try again.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  validation_error: "Please check the highlighted fields and try again.",
  unauthorized: "Please sign in to continue.",
  forbidden: "Your role doesn't allow this action.",
  not_found: "That record no longer exists.",
  conflict: "That change conflicts with the current state. Refresh and try again.",
};

const STATUS_MESSAGES: Record<number, string> = {
  401: "Please sign in to continue.",
  403: "Your role doesn't allow this action.",
  404: "That record no longer exists.",
  409: "That change conflicts with the current state. Refresh and try again.",
  422: "Please check the highlighted fields and try again.",
  429: "Too many attempts. Please wait a moment and try again.",
  500: "Something went wrong on our side. Please try again.",
  502: "The service is temporarily unavailable. Please try again shortly.",
  503: "The service is temporarily unavailable. Please try again shortly.",
};

export function mapApiError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code && CODE_MESSAGES[err.code]) return CODE_MESSAGES[err.code];
    if (err.status && STATUS_MESSAGES[err.status]) return STATUS_MESSAGES[err.status];
    // The backend's error.message is written to be user-facing and safe.
    return err.message || "Something went wrong. Please try again.";
  }
  if (err instanceof TypeError) {
    // fetch() network failure (offline, backend down, gateway error)
    return "Cannot reach the VITALORA server. Check your connection and try again.";
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return "Something went wrong. Please try again.";
}

type DateInput = string | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isValid(d) ? d : null;
}

export interface FormatOptions {
  /** IANA timezone (e.g. the clinic's `Clinic.timezone`). Defaults to viewer tz. */
  timeZone?: string;
}

/** e.g. "Mon, 12 May 2025" */
export function formatDate(value: DateInput, opts: FormatOptions = {}): string {
  const d = toDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: opts.timeZone,
  }).format(d);
}

/** e.g. "14:05" (24-hour, clinic timezone when provided) */
export function formatTime(value: DateInput, opts: FormatOptions = {}): string {
  const d = toDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: opts.timeZone,
  }).format(d);
}

/** e.g. "Mon, 12 May 2025, 14:05" */
export function formatDateTime(value: DateInput, opts: FormatOptions = {}): string {
  const d = toDate(value);
  if (!d) return "—";
  return `${formatDate(d, opts)}, ${formatTime(d, opts)}`;
}

/** Machine-friendly local input value (yyyy-MM-dd) for date pickers. */
export function toDateInputValue(value: DateInput): string {
  const d = toDate(value);
  return d ? format(d, "yyyy-MM-dd") : "";
}

/** "just now" / "5 minutes ago" / "2 days ago" */
export function formatRelative(value: DateInput): string {
  const d = toDate(value);
  if (!d) return "—";
  return formatDistanceToNowStrict(d, { addSuffix: true });
}

/** First letters of the first two words, e.g. "Ayesha Khan" → "AK". */
export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0].charAt(0) ?? "";
  const second = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + second).toUpperCase() || "?";
}

/**
 * Build an organization slug from a name, mirroring the backend's
 * `_slugify` (lowercase, non-alphanumerics → hyphen, max 80 chars).
 */
export function slugifyOrgName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "org";
}
