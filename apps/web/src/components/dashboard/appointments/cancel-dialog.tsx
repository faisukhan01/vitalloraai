"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@vitalora/api-client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AppointmentRow } from "@/components/dashboard/appointments/shared";
import { formatDate, formatTime, mapApiError } from "@/lib/utils-api";

/**
 * CancelDialog — the backend REQUIRES a non-empty cancellation reason
 * (POST /appointments/{id}/cancel, reason min length 2). The UI enforces at
 * least 3 characters so a meaningful reason always reaches the audit trail.
 */
export function CancelDialog({
  appointment,
  clinicTimezone,
  onOpenChange,
}: {
  appointment: AppointmentRow | null;
  clinicTimezone?: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);

  React.useEffect(() => {
    if (appointment) {
      setReason("");
      setTouched(false);
    }
  }, [appointment]);

  const trimmed = reason.trim();
  const reasonError =
    touched && trimmed.length < 3
      ? "Please give a short reason (at least 3 characters) — it is stored with the appointment."
      : null;

  const mutation = useMutation({
    mutationFn: () => {
      if (!appointment) throw new Error("No appointment selected.");
      return api.cancelAppointment(appointment.id, trimmed);
    },
    onSuccess: (cancelled) => {
      toast.success(
        `Appointment cancelled — ${cancelled.patient_name}, ${formatDate(cancelled.starts_at)} at ${formatTime(cancelled.starts_at, { timeZone: clinicTimezone ?? undefined })}.`
      );
      void queryClient.invalidateQueries({ queryKey: ["appointments"] });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(mapApiError(error));
    },
  });

  return (
    <Dialog open={Boolean(appointment)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <XCircle className="size-5 text-destructive" aria-hidden="true" />
            Cancel appointment
          </DialogTitle>
          <DialogDescription>
            {appointment
              ? `This cancels ${appointment.patient_name}'s appointment on ${formatDate(appointment.starts_at)} at ${formatTime(appointment.starts_at, { timeZone: clinicTimezone ?? undefined })}. A reason is required and kept on record.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="cancel-reason">Cancellation reason *</Label>
          <Textarea
            id="cancel-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={Boolean(reasonError)}
            aria-describedby={reasonError ? "cancel-reason-error" : undefined}
            placeholder="e.g. Patient requested to reschedule to next week."
            maxLength={500}
          />
          {reasonError ? (
            <p id="cancel-reason-error" role="alert" className="text-sm text-destructive">
              {reasonError}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Required — minimum 3 characters, maximum 500.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Keep appointment
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11"
            disabled={trimmed.length < 3 || mutation.isPending}
            onClick={() => {
              setTouched(true);
              if (trimmed.length >= 3) mutation.mutate();
            }}
          >
            {mutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <XCircle className="size-4" aria-hidden="true" />
            )}
            Cancel appointment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
