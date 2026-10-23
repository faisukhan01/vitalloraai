/**
 * Shared helpers for the operations screens (knowledge / calls / settings).
 * Pure functions only — everything that talks to the API lives in the pages
 * and api-client; everything visual lives in the components.
 */

import type { SessionOutcome } from "@vitalora/shared-types";

/** Weekday labels in backend day_of_week order (0=Monday … 6=Sunday). */
export const DAY_LABELS: readonly string[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/** Half-hour time options 00:00–23:30 for opening-hours selects. */
export const TIME_OPTIONS: readonly string[] = Array.from(
  { length: 48 },
  (_, i) => {
    const h = Math.floor(i / 2);
    const m = i % 2 === 0 ? "00" : "30";
    return `${String(h).padStart(2, "0")}:${m}`;
  }
);

/** Human label for a session outcome (or null → "No outcome yet"). */
export function formatOutcome(outcome: SessionOutcome): string {
  if (!outcome) return "No outcome";
  return outcome
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Seconds → "mm:ss" (hours roll into minutes, e.g. 75:00). */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "—";
  }
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Truncate long text for excerpts (append an ellipsis when cut). */
export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** bm25 scores from FTS5 are negative (lower = better). Render honestly. */
export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "—";
  return score.toFixed(2);
}

/**
 * Cut a chunk excerpt around the first occurrence of a query term so the
 * matching part is visible (case-insensitive, plain substring).
 */
export function excerptAround(content: string, query: string, max = 260): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const needle = query.trim().split(/\s+/)[0];
  if (!needle) return truncate(clean, max);
  const idx = clean.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return truncate(clean, max);
  const start = Math.max(0, idx - Math.floor(max / 3));
  const slice = clean.slice(start, start + max);
  return `${start > 0 ? "…" : ""}${slice.trim()}${start + max < clean.length ? "…" : ""}`;
}

/** Language code → readable label (falls back to the raw code). */
export function languageLabel(code: string): string {
  switch (code) {
    case "en":
      return "English";
    case "ur":
      return "Urdu";
    case "hi":
      return "Hindi";
    case "ar":
      return "Arabic";
    default:
      return code;
  }
}
