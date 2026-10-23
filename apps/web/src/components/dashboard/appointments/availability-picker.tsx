"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Clock, RefreshCw } from "lucide-react";
import { parseISO } from "date-fns";
import { api } from "@vitalora/api-client";

import { cn } from "@/lib/utils";
import { formatDate, formatTime, mapApiError } from "@/lib/utils-api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { SlotWithDay } from "@/components/dashboard/appointments/shared";

/**
 * AvailabilityPicker — shared slot browser used by the booking and
 * reschedule dialogs. Calls the real availability engine
 * (GET /appointments/availability) and groups the returned flat slots by
 * their clinic-local calendar day.
 */

export const AVAILABILITY_ERROR_SLOT_TAKEN =
  "That slot was just taken — pick another time.";

interface AvailabilityPickerProps {
  serviceId: string;
  date: string; // yyyy-MM-dd — first day of the availability window
  providerId?: string | null;
  clinicTimezone?: string | null;
  /** ISO datetime of the currently chosen slot (highlights the button). */
  selectedStartsAt?: string | null;
  onSelect: (slot: SlotWithDay) => void;
}

export function useAvailabilityQuery(
  enabled: boolean,
  serviceId: string,
  date: string,
  providerId?: string | null
) {
  return useQuery({
    queryKey: ["availability", serviceId, date, providerId ?? "any"],
    queryFn: async () => {
      const res = await api.getAvailability({
        service_id: serviceId,
        date,
        provider_id: providerId ?? undefined,
        days: 7,
      });
      // Backend SlotOut extends the shared type with a clinic-local `day`.
      return res.slots as SlotWithDay[];
    },
    enabled: enabled && Boolean(serviceId) && Boolean(date),
  });
}

export function AvailabilityPicker({
  serviceId,
  date,
  providerId,
  clinicTimezone,
  selectedStartsAt,
  onSelect,
}: AvailabilityPickerProps) {
  const queryClient = useQueryClient();
  const query = useAvailabilityQuery(true, serviceId, date, providerId);

  const grouped = React.useMemo(() => {
    const byDay = new Map<string, SlotWithDay[]>();
    for (const slot of query.data ?? []) {
      const list = byDay.get(slot.day) ?? [];
      list.push(slot);
      byDay.set(slot.day, list);
    }
    for (const list of byDay.values()) {
      list.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [query.data]);

  if (query.isPending) {
    return (
      <div className="space-y-3" aria-live="polite" aria-busy="true">
        <Skeleton className="h-4 w-40" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-28 rounded-md" />
          ))}
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
      >
        <p className="font-medium">Could not load available times.</p>
        <p className="mt-0.5 text-destructive/90">{mapApiError(query.error)}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 min-h-11"
          onClick={() => void query.refetch()}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Try again
        </Button>
      </div>
    );
  }

  if (grouped.length === 0) {
    return (
      <div
        role="status"
        className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground"
      >
        <CalendarDays className="mx-auto mb-2 size-6 text-muted-foreground/70" aria-hidden="true" />
        No open slots in the 7 days from{" "}
        <span className="font-medium text-foreground">{formatDate(date)}</span>.
        The clinic may be closed, the provider off, or existing appointments
        fill the schedule — try another date.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Open slots for the next 7 days (clinic time
          {clinicTimezone ? ` · ${clinicTimezone}` : ""}).
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11 gap-1.5"
          onClick={() => void query.refetch()}
          aria-label="Refresh available time slots"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Refresh
        </Button>
      </div>
      <div className="max-h-64 space-y-4 overflow-y-auto pr-1" role="listbox" aria-label="Available appointment slots">
        {grouped.map(([day, slots]) => (
          <div key={day}>
            <p className="text-eyebrow mb-1.5 font-semibold uppercase text-primary">
              {formatDate(parseISO(day))}
            </p>
            <div className="flex flex-wrap gap-2">
              {slots.map((slot) => {
                const selected = slot.starts_at === selectedStartsAt;
                return (
                  <button
                    key={`${slot.starts_at}-${slot.provider_id}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => onSelect(slot)}
                    className={cn(
                      "inline-flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background/60 hover:border-primary/50 hover:bg-primary/5"
                    )}
                  >
                    <Clock className="size-3.5" aria-hidden="true" />
                    {formatTime(slot.starts_at, { timeZone: clinicTimezone ?? undefined })}
                    <span
                      className={cn(
                        "text-xs",
                        selected ? "text-primary-foreground/80" : "text-muted-foreground"
                      )}
                    >
                      · {slot.provider_name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Invalidate the availability cache after a 409 conflict so slots refresh. */
export function invalidateAvailability(
  queryClient: ReturnType<typeof useQueryClient>,
  serviceId: string,
  date: string,
  providerId?: string | null
) {
  void queryClient.invalidateQueries({
    queryKey: ["availability", serviceId, date, providerId ?? "any"],
  });
}
