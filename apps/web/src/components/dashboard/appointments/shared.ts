/**
 * Shared helpers + local contract extensions for the appointments module.
 *
 * The backend returns a few fields that shared-types does not declare yet
 * (denormalized *_name columns on AppointmentOut, and the clinic-local
 * `day` string on availability slots). We extend the shared types locally
 * here instead of editing the shared contract owned by the lead.
 */
import type {
  Appointment,
  AppointmentStatus,
  AvailabilitySlot,
  ClinicHours,
} from "@vitalora/shared-types";

/** AppointmentOut also carries clinic_name / provider_name / service_name. */
export type AppointmentRow = Appointment & {
  clinic_name?: string | null;
  provider_name?: string | null;
  service_name?: string | null;
};

/** SlotOut = AvailabilitySlot + clinic-local calendar date (YYYY-MM-DD). */
export type SlotWithDay = AvailabilitySlot & { day: string };

/**
 * Status color classes for calendar blocks (day view) — teal booked,
 * emerald confirmed, stone completed, amber rescheduled, rose cancelled /
 * no-show. No indigo/blue anywhere.
 */
export const APPOINTMENT_BLOCK_CLASSES: Record<
  AppointmentStatus,
  { block: string; dot: string }
> = {
  booked: {
    block: "border-primary/35 bg-primary/15 text-primary",
    dot: "bg-primary",
  },
  confirmed: {
    block: "border-success/35 bg-success/15 text-success",
    dot: "bg-success",
  },
  completed: {
    block: "border-border bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  rescheduled: {
    block: "border-warning/40 bg-warning/15 text-warning",
    dot: "bg-warning",
  },
  cancelled: {
    block: "border-destructive/35 bg-destructive/15 text-destructive",
    dot: "bg-destructive",
  },
  no_show: {
    block: "border-destructive/35 bg-destructive/15 text-destructive",
    dot: "bg-destructive",
  },
};

/** Which statuses still allow each action (mirrors backend rules). */
export const ACTIVE_APPOINTMENT_STATUSES: AppointmentStatus[] = ["booked", "confirmed"];

export function canTransition(
  status: AppointmentStatus,
  action: "confirm" | "complete" | "no_show" | "reschedule" | "cancel"
): boolean {
  if (!ACTIVE_APPOINTMENT_STATUSES.includes(status)) return false;
  if (action === "confirm") return status === "booked";
  return true;
}

/** Backend ClinicHours.day_of_week uses 0=Monday…6=Sunday (Python weekday()). */
export function jsDayToBackendDay(jsDay: number): number {
  return (jsDay + 6) % 7;
}

export function backendDayToJsDay(backendDay: number): number {
  return (backendDay + 1) % 7;
}

export const BACKEND_DAY_LABELS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export function findHoursForDay(
  hours: ClinicHours[] | undefined,
  backendDay: number
): ClinicHours | undefined {
  return hours?.find((h) => h.day_of_week === backendDay);
}

/** "HH:MM" → minutes since midnight. */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

/** Minutes since midnight of an ISO instant, evaluated in a named timezone. */
export function minutesInTz(iso: string, timeZone: string | undefined): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (hour % 24) * 60 + minute;
}

/** Calendar date (YYYY-MM-DD) of an ISO instant, evaluated in a named timezone. */
export function dateKeyInTz(iso: string, timeZone: string | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(d);
}

/**
 * Lane assignment for overlapping calendar blocks: returns lane index +
 * lane count per appointment so overlapping appointments split the width
 * instead of hiding each other.
 */
export function assignLanes<T extends { startsAt: number; endsAt: number }>(
  items: T[]
): { item: T; lane: number; lanes: number }[] {
  const sorted = [...items].sort((a, b) => a.startsAt - b.startsAt);
  const result: { item: T; lane: number; lanes: number }[] = [];
  let group: { item: T; lane: number }[] = [];
  let groupEnd = -1;

  const flush = () => {
    const lanes = group.reduce((max, g) => Math.max(max, g.lane + 1), 0);
    for (const g of group) result.push({ item: g.item, lane: g.lane, lanes });
    group = [];
    groupEnd = -1;
  };

  for (const item of sorted) {
    if (group.length > 0 && item.startsAt >= groupEnd) flush();
    // Lowest free lane among current overlapping group.
    const usedLanes = new Set(
      group
        .filter((g) => g.item.endsAt > item.startsAt)
        .map((g) => g.lane)
    );
    let lane = 0;
    while (usedLanes.has(lane)) lane += 1;
    group.push({ item, lane });
    groupEnd = Math.max(groupEnd, item.endsAt);
  }
  flush();
  return result;
}

/** Monday (00:00 local) of the week containing `date`. */
export function startOfWeek(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const shift = jsDayToBackendDay(d.getDay());
  d.setDate(d.getDate() - shift);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** yyyy-MM-dd in the viewer's local calendar. */
export function toIsoDate(date: Date): string {
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
