"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, TriangleAlert, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@vitalora/api-client";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { dateKeyInTz, type AppointmentRow, type SlotWithDay } from "@/components/dashboard/appointments/shared";
import {
  AVAILABILITY_ERROR_SLOT_TAKEN,
  AvailabilityPicker,
  invalidateAvailability,
} from "@/components/dashboard/appointments/availability-picker";
import { formatDate, formatTime, mapApiError } from "@/lib/utils-api";

/**
 * RescheduleDialog — pick a service (defaults to the appointment's current
 * service), a start date, then a fresh slot from the real availability
 * engine. Conflicts (409) are surfaced honestly and the slot list refreshes.
 */
export function RescheduleDialog({
  appointment,
  clinicTimezone,
  onOpenChange,
}: {
  appointment: AppointmentRow | null;
  clinicTimezone?: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [serviceId, setServiceId] = React.useState("");
  const [date, setDate] = React.useState("");
  const [slot, setSlot] = React.useState<SlotWithDay | null>(null);
  const [conflictMessage, setConflictMessage] = React.useState<string | null>(null);

  // Re-seed the dialog each time a different appointment is targeted.
  React.useEffect(() => {
    if (appointment) {
      setServiceId(appointment.service_id);
      setDate(dateKeyInTz(appointment.starts_at, clinicTimezone ?? undefined) || appointment.starts_at.slice(0, 10));
      setSlot(null);
      setConflictMessage(null);
    }
  }, [appointment, clinicTimezone]);

  const servicesQuery = useQuery({
    queryKey: ["services", appointment?.clinic_id],
    queryFn: () => api.listServices(appointment?.clinic_id),
    enabled: Boolean(appointment),
  });
  const services = servicesQuery.data?.items ?? [];

  const mutation = useMutation({
    mutationFn: () => {
      if (!appointment || !slot) throw new Error("Pick a new time slot first.");
      return api.rescheduleAppointment(appointment.id, slot.starts_at);
    },
    onSuccess: (updated) => {
      toast.success(
        `Rescheduled — ${updated.patient_name} moved to ${formatDate(updated.starts_at)} at ${formatTime(updated.starts_at, { timeZone: clinicTimezone ?? undefined })}.`
      );
      void queryClient.invalidateQueries({ queryKey: ["appointments"] });
      onOpenChange(false);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setConflictMessage(AVAILABILITY_ERROR_SLOT_TAKEN);
        setSlot(null);
        invalidateAvailability(queryClient, serviceId, date, appointment?.provider_id);
      } else {
        toast.error(mapApiError(error));
      }
    },
  });

  return (
    <Dialog open={Boolean(appointment)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="size-5 text-primary" aria-hidden="true" />
            Reschedule appointment
          </DialogTitle>
          <DialogDescription>
            {appointment
              ? `Currently ${formatDate(appointment.starts_at)} at ${formatTime(appointment.starts_at, { timeZone: clinicTimezone ?? undefined })} for ${appointment.patient_name}.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {appointment ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="reschedule-service">Service</Label>
              {servicesQuery.isPending ? (
                <Skeleton className="h-11 w-full rounded-md" />
              ) : (
                <Select
                  value={serviceId || undefined}
                  onValueChange={(v) => {
                    setServiceId(v);
                    setSlot(null);
                    setConflictMessage(null);
                  }}
                >
                  <SelectTrigger id="reschedule-service" className="min-h-11 w-full">
                    <SelectValue placeholder="Select a service" />
                  </SelectTrigger>
                  <SelectContent>
                    {services.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} · {s.duration_minutes} min
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reschedule-date">First day of the search window</Label>
              <Input
                id="reschedule-date"
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setSlot(null);
                  setConflictMessage(null);
                }}
                className="min-h-11"
              />
              <p className="text-xs text-muted-foreground">
                Shows open slots for the 7 days from this date.
              </p>
            </div>

            {conflictMessage ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{conflictMessage}</span>
              </div>
            ) : null}

            {serviceId && date ? (
              <AvailabilityPicker
                serviceId={serviceId}
                date={date}
                providerId={appointment.provider_id}
                clinicTimezone={clinicTimezone}
                selectedStartsAt={slot?.starts_at ?? null}
                onSelect={(s) => {
                  setConflictMessage(null);
                  setSlot(s);
                }}
              />
            ) : null}

            {slot ? (
              <p className="rounded-lg border bg-background/60 px-4 py-3 text-sm">
                New time:{" "}
                <span className="font-medium">
                  {formatDate(slot.starts_at)} ·{" "}
                  {formatTime(slot.starts_at, { timeZone: clinicTimezone ?? undefined })}–
                  {formatTime(slot.ends_at, { timeZone: clinicTimezone ?? undefined })}
                </span>{" "}
                with {slot.provider_name}.
              </p>
            ) : null}

            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => onOpenChange(false)}
                disabled={mutation.isPending}
              >
                Keep current time
              </Button>
              <Button
                type="button"
                className="min-h-11"
                disabled={!slot || mutation.isPending}
                onClick={() => mutation.mutate()}
              >
                {mutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="size-4" aria-hidden="true" />
                )}
                Confirm reschedule
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
