"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  Clock,
  Loader2,
  MapPin,
  Plus,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { api } from "@vitalora/api-client";
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
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { GlassCard } from "@/components/glass/glass-card";
import { GlassPanel } from "@/components/glass/glass-panel";
import { EmptyState } from "@/components/glass/empty-state";
import { StatusBadge } from "@/components/glass/status-badge";
import { SkeletonGlass, SkeletonGlassLine } from "@/components/glass/skeleton-glass";
import { ErrorState } from "@/components/ops/error-state";
import { DAY_LABELS, TIME_OPTIONS } from "@/components/ops/helpers";
import { mapApiError } from "@/lib/utils-api";
import { useAuthStore } from "@/stores/auth-store";

const clinicSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(160, "Keep the name under 160 characters"),
  timezone: z.string().min(1, "Timezone is required").max(64),
  address: z.string().trim().max(300, "Keep the address under 300 characters").optional(),
  phone: z.string().trim().max(40, "Keep the phone under 40 characters").optional(),
  email: z
    .string()
    .trim()
    .max(160)
    .refine((v) => v === "" || z.string().email().safeParse(v).success, {
      message: "Enter a valid email address",
    })
    .optional(),
});

type ClinicValues = z.infer<typeof clinicSchema>;

interface HoursRow {
  day_of_week: number;
  open_time: string;
  close_time: string;
  is_closed: boolean;
}

/**
 * ClinicsSettings — clinic list + create dialog, and a weekly hours editor
 * (0=Monday … 6=Sunday, matching the backend) saved via PUT /clinics/{id}/hours.
 */
export function ClinicsSettings() {
  const permissions = useAuthStore((s) => s.permissions);
  const canWrite = permissions.includes("clinics:write");
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [selectedClinicId, setSelectedClinicId] = React.useState<string | null>(null);

  const clinicsQuery = useQuery({
    queryKey: ["clinics"],
    queryFn: () => api.listClinics(),
  });

  const clinics = clinicsQuery.data?.items ?? [];

  // Keep the selection valid when the list changes.
  React.useEffect(() => {
    if (selectedClinicId && !clinics.some((c) => c.id === selectedClinicId)) {
      setSelectedClinicId(null);
    }
  }, [clinics, selectedClinicId]);

  const selectedClinic = clinics.find((c) => c.id === selectedClinicId) ?? null;

  return (
    <div className="space-y-6">
      {/* Clinic list */}
      <GlassPanel className="p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="font-semibold tracking-tight text-foreground">Clinics</h2>
            <p className="text-sm text-muted-foreground">
              Locations your receptionists operate for. Select a clinic to edit
              its weekly opening hours.
            </p>
          </div>
          {canWrite ? (
            <Button
              className="min-h-11 shadow-[var(--shadow-glow-value)]"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="size-4" aria-hidden="true" />
              New clinic
            </Button>
          ) : null}
        </div>

        <div className="mt-5">
          {clinicsQuery.isLoading ? (
            <div aria-hidden="true" className="space-y-3">
              <SkeletonGlass className="h-20 w-full p-4">
                <SkeletonGlassLine className="h-4 w-1/3" />
                <SkeletonGlassLine className="mt-3 h-3 w-1/2" />
              </SkeletonGlass>
            </div>
          ) : clinicsQuery.isError ? (
            <ErrorState
              context="clinics"
              message={mapApiError(clinicsQuery.error)}
              onRetry={() => clinicsQuery.refetch()}
              retrying={clinicsQuery.isFetching}
            />
          ) : clinics.length === 0 ? (
            <EmptyState
              icon={MapPin}
              title="No clinics yet"
              description="Add your first clinic so receptionists can book against its location, timezone and opening hours."
              action={
                canWrite ? (
                  <Button className="min-h-11" onClick={() => setCreateOpen(true)}>
                    <Plus className="size-4" aria-hidden="true" />
                    Add clinic
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="space-y-3" aria-label="Clinics">
              {clinics.map((clinic) => (
                <li key={clinic.id}>
                  <GlassCard
                    variant={selectedClinicId === clinic.id ? "default" : "subtle"}
                    className={
                      "p-4 " +
                      (selectedClinicId === clinic.id
                        ? "ring-1 ring-primary/40"
                        : "")
                    }
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate font-semibold text-foreground">
                            {clinic.name}
                          </h3>
                          <StatusBadge status={clinic.status} />
                        </div>
                        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span className="font-mono">{clinic.slug}</span>
                          <span className="tabular-nums">{clinic.timezone}</span>
                          {clinic.phone ? <span>{clinic.phone}</span> : null}
                          {clinic.email ? <span>{clinic.email}</span> : null}
                          {clinic.address ? <span>{clinic.address}</span> : null}
                        </p>
                      </div>
                      <Button
                        variant={selectedClinicId === clinic.id ? "secondary" : "outline"}
                        size="sm"
                        className="min-h-11 gap-1.5 sm:min-h-9"
                        onClick={() =>
                          setSelectedClinicId(
                            selectedClinicId === clinic.id ? null : clinic.id
                          )
                        }
                        aria-pressed={selectedClinicId === clinic.id}
                      >
                        <Clock className="size-4" aria-hidden="true" />
                        {selectedClinicId === clinic.id ? "Hide hours" : "Set hours"}
                      </Button>
                    </div>
                  </GlassCard>
                </li>
              ))}
            </ul>
          )}
        </div>
      </GlassPanel>

      {/* Weekly hours editor */}
      {selectedClinic ? (
        <WeeklyHoursEditor clinic={selectedClinic} canWrite={canWrite} />
      ) : null}

      <CreateClinicDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function WeeklyHoursEditor({
  clinic,
  canWrite,
}: {
  clinic: Clinic;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const hoursQuery = useQuery({
    queryKey: ["clinics", "hours", clinic.id],
    queryFn: () => api.getClinicHours(clinic.id),
  });

  const [rows, setRows] = React.useState<HoursRow[] | null>(null);
  const [validationError, setValidationError] = React.useState<string | null>(null);

  // Seed local edit state whenever fresh server data arrives.
  React.useEffect(() => {
    if (hoursQuery.data) {
      setRows(
        hoursQuery.data
          .slice()
          .sort((a, b) => a.day_of_week - b.day_of_week)
          .map((h) => ({
            day_of_week: h.day_of_week,
            open_time: h.open_time,
            close_time: h.close_time,
            is_closed: h.is_closed,
          }))
      );
      setValidationError(null);
    }
  }, [hoursQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (payload: HoursRow[]) =>
      api.updateClinicHours(
        clinic.id,
        payload.map((r) => ({
          id: "", // server re-assigns ids (hours rows are replaced wholesale)
          clinic_id: clinic.id,
          day_of_week: r.day_of_week,
          open_time: r.open_time,
          close_time: r.close_time,
          is_closed: r.is_closed,
        }))
      ),
    onSuccess: () => {
      toast.success(`Opening hours for “${clinic.name}” saved.`);
      void queryClient.invalidateQueries({ queryKey: ["clinics", "hours", clinic.id] });
    },
    onError: (err) => toast.error(mapApiError(err)),
  });

  function updateRow(day: number, patch: Partial<HoursRow>) {
    setRows(
      (prev) =>
        prev?.map((r) => {
          if (r.day_of_week !== day) return r;
          const next = { ...r, ...patch };
          // Opening a closed day: seed a valid window instead of inheriting
          // 00:00 → 00:00 (which the backend would reject as open ≥ close).
          if (patch.is_closed === false && next.open_time >= next.close_time) {
            next.open_time = "09:00";
            next.close_time = "17:00";
          }
          return next;
        }) ?? null
    );
    setValidationError(null);
  }

  function save() {
    if (!rows) return;
    for (const row of rows) {
      if (row.is_closed) continue;
      if (row.open_time >= row.close_time) {
        setValidationError(
          `${DAY_LABELS[row.day_of_week]}: opening time must be before closing time.`
        );
        return;
      }
    }
    saveMutation.mutate(rows);
  }

  const loading = hoursQuery.isLoading || (hoursQuery.isFetching && rows === null);
  const dirty =
    rows !== null &&
    hoursQuery.data !== undefined &&
    (rows.length !== hoursQuery.data.length ||
      rows.some((r) => {
        const server = hoursQuery.data.find((h) => h.day_of_week === r.day_of_week);
        return (
          !server ||
          server.open_time !== r.open_time ||
          server.close_time !== r.close_time ||
          server.is_closed !== r.is_closed
        );
      }));

  return (
    <GlassPanel className="p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold tracking-tight text-foreground">
            Weekly hours — {clinic.name}
          </h2>
          <p className="text-sm text-muted-foreground">
            Availability engines and receptionists book only inside these hours
            (clinic time, {clinic.timezone}).
          </p>
        </div>
        {canWrite && rows ? (
          <Button
            className="min-h-11 gap-1.5 shadow-[var(--shadow-glow-value)]"
            onClick={save}
            disabled={saveMutation.isPending || loading}
          >
            {saveMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="size-4" aria-hidden="true" />
            )}
            {saveMutation.isPending ? "Saving…" : "Save hours"}
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div aria-hidden="true" className="mt-5 space-y-2">
          {DAY_LABELS.map((day) => (
            <SkeletonGlass key={day} className="h-12 w-full" />
          ))}
        </div>
      ) : hoursQuery.isError ? (
        <div className="mt-5">
          <ErrorState
            context="opening hours"
            message={mapApiError(hoursQuery.error)}
            onRetry={() => hoursQuery.refetch()}
            retrying={hoursQuery.isFetching}
          />
        </div>
      ) : rows ? (
        <>
          <ul className="mt-5 space-y-2" aria-label="Weekly opening hours">
            {rows.map((row) => (
              <li
                key={row.day_of_week}
                className="glass-subtle flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5 sm:flex-nowrap"
              >
                <span className="w-24 shrink-0 text-sm font-medium text-foreground">
                  {DAY_LABELS[row.day_of_week]}
                </span>
                <Switch
                  checked={!row.is_closed}
                  disabled={!canWrite}
                  onCheckedChange={(open) =>
                    updateRow(row.day_of_week, { is_closed: !open })
                  }
                  aria-label={`${DAY_LABELS[row.day_of_week]} open`}
                />
                {row.is_closed ? (
                  <span className="text-sm text-muted-foreground">Closed</span>
                ) : (
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    <Select
                      value={row.open_time}
                      onValueChange={(v) => updateRow(row.day_of_week, { open_time: v })}
                      disabled={!canWrite}
                    >
                      <SelectTrigger
                        className="min-h-10 w-28 font-mono text-sm"
                        aria-label={`${DAY_LABELS[row.day_of_week]} opening time`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        {TIME_OPTIONS.map((t) => (
                          <SelectItem key={t} value={t} className="font-mono">
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span aria-hidden="true" className="text-sm text-muted-foreground">
                      →
                    </span>
                    <Select
                      value={row.close_time}
                      onValueChange={(v) => updateRow(row.day_of_week, { close_time: v })}
                      disabled={!canWrite}
                    >
                      <SelectTrigger
                        className="min-h-10 w-28 font-mono text-sm"
                        aria-label={`${DAY_LABELS[row.day_of_week]} closing time`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        {TIME_OPTIONS.map((t) => (
                          <SelectItem key={t} value={t} className="font-mono">
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {validationError ? (
            <p role="alert" className="mt-3 text-sm font-medium text-destructive">
              {validationError}
            </p>
          ) : null}
          {!canWrite ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Your role can view but not edit opening hours.
            </p>
          ) : (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="size-3.5" aria-hidden="true" />
              {dirty
                ? "You have unsaved changes — press “Save hours” to apply them."
                : "Saved state — hours take effect immediately once saved."}
            </p>
          )}
        </>
      ) : null}
    </GlassPanel>
  );
}

function CreateClinicDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const form = useForm<ClinicValues>({
    resolver: zodResolver(clinicSchema),
    defaultValues: {
      name: "",
      timezone: "Asia/Karachi",
      address: "",
      phone: "",
      email: "",
    },
  });

  React.useEffect(() => {
    if (open) {
      form.reset({
        name: "",
        timezone: "Asia/Karachi",
        address: "",
        phone: "",
        email: "",
      });
      setSubmitError(null);
    }
  }, [open, form]);

  async function onSubmit(values: ClinicValues) {
    setSubmitError(null);
    try {
      const clinic = await api.createClinic({
        name: values.name,
        timezone: values.timezone,
        address: values.address || null,
        phone: values.phone || null,
        email: values.email || null,
      });
      toast.success(`Clinic “${clinic.name}” created with default hours.`);
      void queryClient.invalidateQueries({ queryKey: ["clinics"] });
      onOpenChange(false);
    } catch (err) {
      setSubmitError(mapApiError(err));
    }
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New clinic</DialogTitle>
          <DialogDescription>
            The clinic starts with default hours (Mon–Fri 09:00–17:00, Sat
            10:00–14:00, Sun closed) — adjust them right after creating.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Clinic name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Sunrise Dental — Gulberg"
                      className="min-h-11"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="timezone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Timezone</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="min-h-11 w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="Asia/Karachi">Asia/Karachi (PKT)</SelectItem>
                      <SelectItem value="Asia/Dubai">Asia/Dubai (GST)</SelectItem>
                      <SelectItem value="Asia/Kolkata">Asia/Kolkata (IST)</SelectItem>
                      <SelectItem value="Europe/London">Europe/London (GMT/BST)</SelectItem>
                      <SelectItem value="America/New_York">America/New_York (ET)</SelectItem>
                      <SelectItem value="UTC">UTC</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    IANA zone name — opening hours and bookings use it.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Address <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Street, area, city"
                      className="min-h-11"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Phone <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="tel"
                        placeholder="+92 300 0000000"
                        className="min-h-11"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Email <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder="reception@clinic.com"
                        className="min-h-11"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {submitError ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {submitError}
              </p>
            ) : null}

            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11 shadow-[var(--shadow-glow-value)]"
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Creating…
                  </>
                ) : (
                  "Create clinic"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
