import * as React from "react";

import { cn } from "@/lib/utils";
import {
  APPOINTMENT_STATUS_LABELS,
  type AppointmentStatus,
  type KnowledgeDocStatus,
  type SessionStatus,
} from "@vitalora/shared-types";

/**
 * StatusBadge — maps status strings from the backend contract
 * (appointments, voice sessions, knowledge documents, receptionists,
 * callbacks) to consistent color tones. Unknown statuses fall back to a
 * neutral tone, so new backend values never break the UI.
 */

type Tone = "teal" | "success" | "warning" | "danger" | "neutral";

const toneClasses: Record<Tone, { chip: string; dot: string }> = {
  teal: {
    chip: "border-primary/25 bg-primary/10 text-primary",
    dot: "bg-primary",
  },
  success: {
    chip: "border-success/25 bg-success/10 text-success",
    dot: "bg-success",
  },
  warning: {
    chip: "border-warning/30 bg-warning/10 text-warning",
    dot: "bg-warning",
  },
  danger: {
    chip: "border-destructive/25 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
  neutral: {
    chip: "border-border bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
  },
};

const TONE_BY_STATUS: Record<string, Tone> = {
  // Appointment statuses
  booked: "teal",
  confirmed: "success",
  cancelled: "danger",
  completed: "neutral",
  no_show: "warning",
  rescheduled: "warning",
  // Session statuses
  active: "success",
  failed: "danger",
  escalated: "warning",
  // Knowledge document statuses
  pending: "warning",
  processing: "teal",
  indexed: "success",
  inactive: "neutral",
  // Receptionist statuses
  draft: "neutral",
  paused: "warning",
  // Callback statuses
  open: "teal",
  assigned: "warning",
  // Callback priority
  low: "neutral",
  normal: "teal",
  high: "warning",
  urgent: "danger",
  // Organization / clinic statuses
  trial: "teal",
  demo: "teal",
  error: "danger",
};

const LABEL_OVERRIDES: Record<string, string> = {
  no_show: "No-show",
};

function humanizeStatus(status: string): string {
  return (
    LABEL_OVERRIDES[status] ??
    status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ")
  );
}

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: AppointmentStatus | SessionStatus | KnowledgeDocStatus | string;
  /** Override the auto-derived tone. */
  tone?: Tone;
  /** Show the leading status dot (default true). */
  withDot?: boolean;
}

function StatusBadge({
  status,
  tone,
  withDot = true,
  className,
  ...props
}: StatusBadgeProps) {
  const resolvedTone = tone ?? TONE_BY_STATUS[status] ?? "neutral";
  const label =
    APPOINTMENT_STATUS_LABELS[status as AppointmentStatus] ??
    humanizeStatus(status);
  const classes = toneClasses[resolvedTone];

  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium",
        classes.chip,
        className
      )}
      {...props}
    >
      {withDot ? (
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", classes.dot)} />
      ) : null}
      {label}
    </span>
  );
}

export { StatusBadge };
