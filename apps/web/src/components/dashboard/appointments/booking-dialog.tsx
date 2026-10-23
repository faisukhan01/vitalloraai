"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, CalendarPlus, Check, Loader2, TriangleAlert } from "lucide-react";
import { api, ApiError } from "@vitalora/api-client";
import type { Clinic } from "@vitalora/shared-types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDate, formatTime, mapApiError, toDateInputValue } from "@/lib/utils-api";
import {
  AVAILABILITY_ERROR_SLOT_TAKEN,
  AvailabilityPicker,
  invalidateAvailability,
} from "@/components/dashboard/appointments/availability-picker";
import type { AppointmentRow, SlotWithDay } from "@/components/dashboard/appointments/shared";

/**
 * BookingDialog — 3-step appointment booking against the real backend.
 *
 * Idempotency: a single `idempotency_key` (crypto.randomUUID) is generated
 * once per dialog session and reused for every submit attempt of that
 * session, so a network retry or double-click cannot create duplicates.
 * A 409 (slot taken between fetch and submit) surfaces the honest message
 * and refreshes the slot list.
 */

const bookingSchema = z.object({
  patient_name: z
    .string()
    .trim()
    .min(2, "Patient name must be at least 2 characters.")
    .max(120, "Patient name must be at most 120 characters."),
  patient_phone: z
    .string()
    .trim()
    .max(40)
    .refine(
      (v) => v === "" || /^\+?[0-9()\-\s]{5,20}$/.test(v),
      "Use digits, spaces, ( ) + - only — 5 to 20 characters, or leave empty."
    )
    .optional(),
  patient_notes: z.string().trim().max(2000, "Notes must be at most 2000 characters.").optional(),
  service_id: z.string().min(1, "Choose a service."),
  provider_id: z.string().min(1, "Choose a provider."),
  date: z.string().min(1, "Choose a date."),
  starts_at: z.string().min(1, "Pick a time slot."),
});

type BookingValues = z.infer<typeof bookingSchema>;

const STEP_FIELDS: (keyof BookingValues)[][] = [
  ["patient_name", "patient_phone", "patient_notes"],
  ["service_id", "provider_id", "date"],
  ["starts_at"],
];

const STEP_TITLES = ["Patient details", "Service, provider & date", "Pick a time slot"];

interface BookingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clinics: Clinic[];
  clinicId: string | null;
  clinicTimezone?: string | null;
  onBooked?: (appointment: AppointmentRow) => void;
}

export function BookingDialog({
  open,
  onOpenChange,
  clinics,
  clinicId,
  clinicTimezone,
  onBooked,
}: BookingDialogProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = React.useState(1);
  const [conflictMessage, setConflictMessage] = React.useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = React.useState<SlotWithDay | null>(null);

  // Generated ONCE per dialog session — retries reuse the same key.
  const idempotencyKeyRef = React.useRef<string>("");
  const getIdempotencyKey = React.useCallback(() => {
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return idempotencyKeyRef.current;
  }, []);

  const form = useForm<BookingValues>({
    resolver: zodResolver(bookingSchema),
    defaultValues: {
      patient_name: "",
      patient_phone: "",
      patient_notes: "",
      service_id: "",
      provider_id: "",
      date: "",
      starts_at: "",
    },
  });

  // Reset the whole dialog (steps, form, key) whenever it opens fresh.
  React.useEffect(() => {
    if (open) {
      setStep(1);
      setConflictMessage(null);
      setSelectedSlot(null);
      idempotencyKeyRef.current = "";
      form.reset({
        patient_name: "",
        patient_phone: "",
        patient_notes: "",
        service_id: "",
        provider_id: "",
        date: "",
        starts_at: "",
      });
    }
  }, [open, form]);

  const servicesQuery = useQuery({
    queryKey: ["services", clinicId],
    queryFn: () => api.listServices(clinicId ?? undefined),
    enabled: open && Boolean(clinicId),
  });
  const providersQuery = useQuery({
    queryKey: ["providers", clinicId],
    queryFn: () => api.listProviders(clinicId ?? undefined),
    enabled: open && Boolean(clinicId),
  });

  const services = (servicesQuery.data?.items ?? []).filter((s) => s.is_active);
  const providers = providersQuery.data?.items ?? [];
  const clinicName = clinics.find((c) => c.id === clinicId)?.name ?? "the clinic";

  const createMutation = useMutation({
    mutationFn: async (values: BookingValues) => {
      if (!clinicId) throw new Error("No clinic selected.");
      return api.createAppointment({
        clinic_id: clinicId,
        provider_id: values.provider_id,
        service_id: values.service_id,
        patient_name: values.patient_name,
        patient_phone: values.patient_phone || undefined,
        patient_notes: values.patient_notes || undefined,
        starts_at: values.starts_at,
        idempotency_key: getIdempotencyKey(),
      });
    },
    onSuccess: (appointment) => {
      toast.success(
        `Appointment booked — ${appointment.patient_name}, ${formatDate(appointment.starts_at)} at ${formatTime(appointment.starts_at, { timeZone: clinicTimezone ?? undefined })}.`
      );
      void queryClient.invalidateQueries({ queryKey: ["appointments"] });
      form.reset();
      onOpenChange(false);
      onBooked?.(appointment as AppointmentRow);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        // Slot raced: honest message + refresh availability, stay on step 3.
        setConflictMessage(AVAILABILITY_ERROR_SLOT_TAKEN);
        setSelectedSlot(null);
        form.setValue("starts_at", "");
        const { service_id, date, provider_id } = form.getValues();
        invalidateAvailability(queryClient, service_id, date, provider_id);
      } else {
        toast.error(mapApiError(error));
      }
    },
  });

  const goNext = async () => {
    const fields = STEP_FIELDS[step - 1] ?? [];
    const ok = await form.trigger(fields);
    if (ok) {
      setConflictMessage(null);
      setStep((s) => Math.min(3, s + 1));
    }
  };

  const values = form.watch();
  const selectedService = services.find((s) => s.id === values.service_id);
  const selectedProvider = providers.find((p) => p.id === values.provider_id);

  const submit = form.handleSubmit((vals) => {
    setConflictMessage(null);
    createMutation.mutate(vals);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="size-5 text-primary" aria-hidden="true" />
            New appointment
          </DialogTitle>
          <DialogDescription>
            Book at {clinicName} · Step {step} of 3 — {STEP_TITLES[step - 1]}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4" noValidate>
          {step === 1 ? (
            <>
              <FormField
                control={form.control}
                name="patient_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Patient name *</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. Ayesha Khan"
                        autoComplete="off"
                        minLength={2}
                        {...field}
                        value={field.value ?? ""}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="patient_phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone (optional)</FormLabel>
                    <FormControl>
                      <Input
                        type="tel"
                        inputMode="tel"
                        placeholder="+92 300 1234567"
                        autoComplete="off"
                        {...field}
                        value={field.value ?? ""}
                      />
                    </FormControl>
                    <FormDescription>
                      Used for reminders. Leave empty if the patient has none.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="patient_notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes (optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        placeholder="Anything the provider should know…"
                        {...field}
                        value={field.value ?? ""}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          ) : null}

          {step === 2 ? (
            <>
              <FormField
                control={form.control}
                name="service_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Service *</FormLabel>
                    {servicesQuery.isPending ? (
                      <Skeleton className="h-11 w-full rounded-md" />
                    ) : servicesQuery.isError ? (
                      <p role="alert" className="text-sm text-destructive">
                        {mapApiError(servicesQuery.error)}
                      </p>
                    ) : services.length === 0 ? (
                      <p role="status" className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                        No active services exist for this clinic yet. Create one in Settings first.
                      </p>
                    ) : (
                      <Select
                        value={field.value || undefined}
                        onValueChange={(v) => {
                          field.onChange(v);
                          form.setValue("starts_at", "");
                          setSelectedSlot(null);
                        }}
                      >
                        <FormControl>
                          <SelectTrigger className="min-h-11 w-full">
                            <SelectValue placeholder="Select a service" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {services.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name} · {s.duration_minutes} min
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="provider_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Provider *</FormLabel>
                    {providersQuery.isPending ? (
                      <Skeleton className="h-11 w-full rounded-md" />
                    ) : providersQuery.isError ? (
                      <p role="alert" className="text-sm text-destructive">
                        {mapApiError(providersQuery.error)}
                      </p>
                    ) : providers.length === 0 ? (
                      <p role="status" className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                        No providers are registered for this clinic yet.
                      </p>
                    ) : (
                      <Select
                        value={field.value || undefined}
                        onValueChange={(v) => {
                          field.onChange(v);
                          form.setValue("starts_at", "");
                          setSelectedSlot(null);
                        }}
                      >
                        <FormControl>
                          <SelectTrigger className="min-h-11 w-full">
                            <SelectValue placeholder="Select a provider" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {providers.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                              {p.specialty ? ` · ${p.specialty}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date *</FormLabel>
                    <Popover modal>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            type="button"
                            variant="outline"
                            className={cn(
                              "min-h-11 w-full justify-start font-normal",
                              !field.value && "text-muted-foreground"
                            )}
                          >
                            {field.value ? formatDate(field.value) : "Pick a date"}
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-auto p-0">
                        <Calendar
                          mode="single"
                          selected={field.value ? new Date(`${field.value}T00:00:00`) : undefined}
                          onSelect={(d) => {
                            field.onChange(d ? toDateInputValue(d) : "");
                            form.setValue("starts_at", "");
                            setSelectedSlot(null);
                          }}
                          disabled={{ before: new Date(new Date().setHours(0, 0, 0, 0)) }}
                        />
                      </PopoverContent>
                    </Popover>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          ) : null}

          {step === 3 ? (
            <>
              {conflictMessage ? (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning"
                >
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>{conflictMessage}</span>
                </div>
              ) : null}
              <AvailabilityPicker
                serviceId={values.service_id}
                date={values.date}
                providerId={values.provider_id}
                clinicTimezone={clinicTimezone}
                selectedStartsAt={values.starts_at || null}
                onSelect={(slot) => {
                  setConflictMessage(null);
                  setSelectedSlot(slot);
                  form.setValue("starts_at", slot.starts_at, { shouldValidate: true });
                }}
              />
              {selectedSlot ? (
                <div className="rounded-lg border bg-background/60 px-4 py-3 text-sm">
                  <p className="text-eyebrow font-semibold uppercase text-primary">Confirm booking</p>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <dt className="text-muted-foreground">Patient</dt>
                    <dd className="font-medium">{values.patient_name}</dd>
                    <dt className="text-muted-foreground">Service</dt>
                    <dd className="font-medium">
                      {selectedService?.name ?? "—"} ({selectedSlot.duration_minutes} min)
                    </dd>
                    <dt className="text-muted-foreground">Provider</dt>
                    <dd className="font-medium">{selectedSlot.provider_name}</dd>
                    <dt className="text-muted-foreground">When</dt>
                    <dd className="font-medium">
                      {formatDate(selectedSlot.starts_at)} ·{" "}
                      {formatTime(selectedSlot.starts_at, { timeZone: clinicTimezone ?? undefined })}–
                      {formatTime(selectedSlot.ends_at, { timeZone: clinicTimezone ?? undefined })}
                    </dd>
                  </dl>
                </div>
              ) : null}
            </>
          ) : null}

          <DialogFooter className="gap-2 sm:justify-between">
            {step > 1 ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setStep((s) => s - 1)}
                disabled={createMutation.isPending}
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
                Back
              </Button>
            ) : (
              <span aria-hidden="true" />
            )}
            {step < 3 ? (
              <Button type="button" className="min-h-11" onClick={() => void goNext()}>
                Next
                <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button
                type="submit"
                className="min-h-11"
                disabled={!values.starts_at || createMutation.isPending}
              >
                {createMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Check className="size-4" aria-hidden="true" />
                )}
                Confirm booking
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
