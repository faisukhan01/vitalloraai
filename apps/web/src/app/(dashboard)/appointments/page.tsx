"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleX,
  ListFilter,
  MoreHorizontal,
  RefreshCw,
  Search,
  UserX,
} from "lucide-react";
import { isSameDay } from "date-fns";
import { toast } from "sonner";
import { api } from "@vitalora/api-client";
import {
  APPOINTMENT_STATUS_LABELS,
  type AppointmentStatus,
  type Paginated,
} from "@vitalora/shared-types";

import { cn } from "@/lib/utils";
import { formatDate, formatTime, mapApiError } from "@/lib/utils-api";
import { EmptyState } from "@/components/glass/empty-state";
import { GlassCard } from "@/components/glass/glass-card";
import { PageHeader } from "@/components/glass/page-header";
import { SkeletonGlass, SkeletonGlassLine } from "@/components/glass/skeleton-glass";
import { StatusBadge } from "@/components/glass/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BookingDialog } from "@/components/dashboard/appointments/booking-dialog";
import { CancelDialog } from "@/components/dashboard/appointments/cancel-dialog";
import { RescheduleDialog } from "@/components/dashboard/appointments/reschedule-dialog";
import {
  APPOINTMENT_BLOCK_CLASSES,
  addDays as addCalendarDays,
  assignLanes,
  backendDayToJsDay,
  canTransition,
  dateKeyInTz,
  findHoursForDay,
  hhmmToMinutes,
  jsDayToBackendDay,
  minutesInTz,
  startOfWeek,
  toIsoDate,
  type AppointmentRow,
} from "@/components/dashboard/appointments/shared";

const HOUR_PX = 68;
const PX_PER_MIN = HOUR_PX / 60;
const ALL_STATUSES: AppointmentStatus[] = [
  "booked",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
  "rescheduled",
];

function useDebouncedValue<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export default function AppointmentsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-6">
          <SkeletonGlass className="h-16 w-full" />
          <SkeletonGlass className="h-96 w-full" />
        </div>
      }
    >
      <AppointmentsInner />
    </Suspense>
  );
}

function AppointmentsInner() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const [view, setView] = React.useState<"day" | "week" | "list">("day");
  const [selectedDate, setSelectedDate] = React.useState<Date>(() => new Date());
  const [bookingOpen, setBookingOpen] = React.useState(
    () => searchParams.get("book") === "1"
  );
  const [rescheduleTarget, setRescheduleTarget] = React.useState<AppointmentRow | null>(null);
  const [cancelTarget, setCancelTarget] = React.useState<AppointmentRow | null>(null);

  // List-view filter state.
  const [searchInput, setSearchInput] = React.useState("");
  const search = useDebouncedValue(searchInput, 350);
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  const [fromDate, setFromDate] = React.useState("");
  const [toDate, setToDate] = React.useState("");
  const [page, setPage] = React.useState(1);

  // ── Clinics + hours ──────────────────────────────────────────────────────
  const clinicsQuery = useQuery({
    queryKey: ["clinics"],
    queryFn: () => api.listClinics(),
  });
  const clinics = clinicsQuery.data?.items ?? [];
  const clinicId = clinics[0]?.id ? clinics[0].id : null;
  const [explicitClinicId, setExplicitClinicId] = React.useState<string | null>(null);
  const activeClinicId = explicitClinicId ?? clinicId;
  const activeClinic = clinics.find((c) => c.id === activeClinicId) ?? null;

  const hoursQuery = useQuery({
    // Shares the Settings (clinics & hours) cache key, so hour edits made in
    // Settings invalidate this view automatically.
    queryKey: ["clinics", "hours", activeClinicId],
    queryFn: () => api.getClinicHours(activeClinicId as string),
    enabled: Boolean(activeClinicId),
  });
  const clinicHours = hoursQuery.data ?? [];

  // ── Appointments queries ─────────────────────────────────────────────────
  const dayIso = toIsoDate(selectedDate);
  const weekStart = startOfWeek(selectedDate);

  const dayQuery = useQuery({
    queryKey: ["appointments", "day", activeClinicId, dayIso],
    queryFn: () =>
      api.listAppointments({
        from: dayIso,
        to: dayIso,
        clinic_id: activeClinicId ?? undefined,
        page_size: 100,
      }),
    enabled: view === "day",
  });
  const weekQuery = useQuery({
    queryKey: ["appointments", "week", activeClinicId, toIsoDate(weekStart)],
    queryFn: () =>
      api.listAppointments({
        from: toIsoDate(weekStart),
        to: toIsoDate(addCalendarDays(weekStart, 6)),
        clinic_id: activeClinicId ?? undefined,
        page_size: 200,
      }),
    enabled: view === "week",
  });
  const listQuery = useQuery({
    queryKey: [
      "appointments",
      "list",
      activeClinicId,
      page,
      search,
      statusFilter,
      fromDate,
      toDate,
    ],
    queryFn: () =>
      api.listAppointments({
        from: fromDate || undefined,
        to: toDate || undefined,
        clinic_id: activeClinicId ?? undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
        search: search || undefined,
        page,
        page_size: 10,
      }),
    enabled: view === "list",
  });

  const invalidateAppointments = () => {
    void queryClient.invalidateQueries({ queryKey: ["appointments"] });
    void queryClient.invalidateQueries({ queryKey: ["analytics-overview"] });
  };

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "confirmed" | "completed" | "no_show" }) =>
      api.updateAppointmentStatus(id, status),
    onSuccess: (appt) => {
      toast.success(
        `${appt.patient_name} marked as ${APPOINTMENT_STATUS_LABELS[appt.status]}.`
      );
      invalidateAppointments();
    },
    onError: (error) => toast.error(mapApiError(error)),
  });

  const onStatusAction = (
    appt: AppointmentRow,
    action: "confirm" | "complete" | "no_show"
  ) => {
    if (action === "confirm") statusMutation.mutate({ id: appt.id, status: "confirmed" });
    if (action === "complete") statusMutation.mutate({ id: appt.id, status: "completed" });
    if (action === "no_show") statusMutation.mutate({ id: appt.id, status: "no_show" });
  };

  const clinicSelector =
    clinicsQuery.isPending ? (
      <SkeletonGlass className="h-11 w-40 rounded-md" />
    ) : clinics.length > 1 ? (
      <Select
        value={activeClinicId ?? undefined}
        onValueChange={(v) => setExplicitClinicId(v)}
        aria-label="Select clinic"
      >
        <SelectTrigger className="min-h-11 w-44" aria-label="Select clinic">
          <SelectValue placeholder="Clinic" />
        </SelectTrigger>
        <SelectContent>
          {clinics.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : clinics.length === 1 ? (
      <span className="hidden truncate rounded-md border bg-background/60 px-3 py-2 text-sm text-muted-foreground sm:inline-block">
        {clinics[0].name}
      </span>
    ) : null;

  return (
    <>
      <PageHeader
        eyebrow="Scheduling"
        title="Appointments"
        description="Book, confirm and manage patient appointments. Slots come from the live availability engine — clinic hours minus booked time."
        actions={
          <>
            {clinicSelector}
            <Button className="min-h-11" onClick={() => setBookingOpen(true)}>
              <CalendarPlus className="size-4" aria-hidden="true" />
              New appointment
            </Button>
          </>
        }
      />

      {clinicsQuery.isError ? (
        <EmptyState
          icon={CalendarDays}
          title="Could not load your clinics"
          description={mapApiError(clinicsQuery.error)}
          action={
            <Button variant="outline" className="min-h-11" onClick={() => void clinicsQuery.refetch()}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Retry
            </Button>
          }
        />
      ) : clinics.length === 0 && !clinicsQuery.isPending ? (
        <EmptyState
          icon={CalendarDays}
          title="No clinics yet"
          description="Appointments belong to a clinic. Create your first clinic in Settings to start booking."
        />
      ) : (
        <>
          {/* View switcher */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs
              value={view}
              onValueChange={(v) => setView(v as "day" | "week" | "list")}
              aria-label="Appointment view"
            >
              <TabsList>
                <TabsTrigger value="day" className="min-h-11 px-4">
                  Day
                </TabsTrigger>
                <TabsTrigger value="week" className="min-h-11 px-4">
                  Week
                </TabsTrigger>
                <TabsTrigger value="list" className="min-h-11 px-4">
                  List
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {view !== "list" ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-11"
                  aria-label={
                    view === "day" ? "Previous day" : "Previous week"
                  }
                  onClick={() =>
                    setSelectedDate((d) => addCalendarDays(d, view === "day" ? -1 : -7))
                  }
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => setSelectedDate(new Date())}
                >
                  Today
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-11"
                  aria-label={view === "day" ? "Next day" : "Next week"}
                  onClick={() =>
                    setSelectedDate((d) => addCalendarDays(d, view === "day" ? 1 : 7))
                  }
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ) : null}
          </div>

          {view === "day" ? (
            <DayView
              date={selectedDate}
              clinic={activeClinic}
              clinicHours={clinicHours}
              hoursPending={hoursQuery.isPending}
              hoursError={hoursQuery.error}
              appointmentsQuery={dayQuery}
              onRetryDay={() => void dayQuery.refetch()}
              onStatusAction={onStatusAction}
              onReschedule={setRescheduleTarget}
              onCancel={setCancelTarget}
            />
          ) : null}

          {view === "week" ? (
            <WeekView
              weekStart={weekStart}
              clinicTimezone={activeClinic?.timezone}
              clinicHours={clinicHours}
              appointmentsQuery={weekQuery}
              onPickDay={(d) => {
                setSelectedDate(d);
                setView("day");
              }}
            />
          ) : null}

          {view === "list" ? (
            <ListView
              listQuery={listQuery}
              searchInput={searchInput}
              onSearchInput={(v) => {
                setSearchInput(v);
                setPage(1);
              }}
              statusFilter={statusFilter}
              onStatusFilter={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
              fromDate={fromDate}
              toDate={toDate}
              onFromDate={(v) => {
                setFromDate(v);
                setPage(1);
              }}
              onToDate={(v) => {
                setToDate(v);
                setPage(1);
              }}
              clinicTimezone={activeClinic?.timezone}
              onStatusAction={onStatusAction}
              onReschedule={setRescheduleTarget}
              onCancel={setCancelTarget}
              onPageChange={setPage}
            />
          ) : null}
        </>
      )}

      <BookingDialog
        open={bookingOpen}
        onOpenChange={(open) => {
          setBookingOpen(open);
          if (!open) {
            // Drop ?book=1 so refreshing doesn't reopen the dialog.
            const url = new URL(window.location.href);
            if (url.searchParams.has("book")) {
              url.searchParams.delete("book");
              window.history.replaceState(null, "", url.toString());
            }
          }
        }}
        clinics={clinics}
        clinicId={activeClinicId}
        clinicTimezone={activeClinic?.timezone}
      />
      <RescheduleDialog
        appointment={rescheduleTarget}
        clinicTimezone={activeClinic?.timezone}
        onOpenChange={(open) => {
          if (!open) setRescheduleTarget(null);
        }}
      />
      <CancelDialog
        appointment={cancelTarget}
        clinicTimezone={activeClinic?.timezone}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
      />
    </>
  );
}

/* ── Row actions (shared by list + day view) ─────────────────────────────── */

function AppointmentActionsMenu({
  appointment,
  onStatusAction,
  onReschedule,
  onCancel,
  children,
}: {
  appointment: AppointmentRow;
  onStatusAction: (appt: AppointmentRow, action: "confirm" | "complete" | "no_show") => void;
  onReschedule: (appt: AppointmentRow) => void;
  onCancel: (appt: AppointmentRow) => void;
  children: React.ReactNode;
}) {
  const busy = false;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {appointment.patient_name} · {APPOINTMENT_STATUS_LABELS[appointment.status]}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {canTransition(appointment.status, "confirm") ? (
          <DropdownMenuItem onClick={() => onStatusAction(appointment, "confirm")} disabled={busy}>
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Confirm
          </DropdownMenuItem>
        ) : null}
        {canTransition(appointment.status, "complete") ? (
          <DropdownMenuItem onClick={() => onStatusAction(appointment, "complete")} disabled={busy}>
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Mark completed
          </DropdownMenuItem>
        ) : null}
        {canTransition(appointment.status, "no_show") ? (
          <DropdownMenuItem onClick={() => onStatusAction(appointment, "no_show")} disabled={busy}>
            <UserX className="size-4" aria-hidden="true" />
            Mark no-show
          </DropdownMenuItem>
        ) : null}
        {canTransition(appointment.status, "reschedule") ? (
          <DropdownMenuItem onClick={() => onReschedule(appointment)}>
            <CalendarDays className="size-4" aria-hidden="true" />
            Reschedule…
          </DropdownMenuItem>
        ) : null}
        {canTransition(appointment.status, "cancel") ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onCancel(appointment)}
              className="text-destructive focus:text-destructive"
            >
              <CircleX className="size-4" aria-hidden="true" />
              Cancel appointment…
            </DropdownMenuItem>
          </>
        ) : null}
        {!canTransition(appointment.status, "complete") &&
        !canTransition(appointment.status, "reschedule") ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            This appointment is in a final state ({APPOINTMENT_STATUS_LABELS[appointment.status]}).
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── Day view ────────────────────────────────────────────────────────────── */

function DayView({
  date,
  clinic,
  clinicHours,
  hoursPending,
  hoursError,
  appointmentsQuery,
  onRetryDay,
  onStatusAction,
  onReschedule,
  onCancel,
}: {
  date: Date;
  clinic: { name: string; timezone: string } | null;
  clinicHours: Awaited<ReturnType<typeof api.getClinicHours>>;
  hoursPending: boolean;
  hoursError: unknown;
  appointmentsQuery: UseQueryResult<Paginated<AppointmentRow>, Error>;
  onRetryDay: () => void;
  onStatusAction: (appt: AppointmentRow, action: "confirm" | "complete" | "no_show") => void;
  onReschedule: (appt: AppointmentRow) => void;
  onCancel: (appt: AppointmentRow) => void;
}) {
  const tz = clinic?.timezone;
  const backendDay = jsDayToBackendDay(date.getDay());
  const hours = findHoursForDay(clinicHours, backendDay);
  const closed = !hours || hours.is_closed;

  const appts = appointmentsQuery.data?.items ?? [];
  const openMin = hours ? hhmmToMinutes(hours.open_time) : 9 * 60;
  const closeMin = hours ? hhmmToMinutes(hours.close_time) : 17 * 60;
  const totalMinutes = Math.max(60, closeMin - openMin);
  const totalHeight = totalMinutes * PX_PER_MIN;
  const hourLines = Math.ceil(totalMinutes / 60);

  const nowMinutes = minutesInTz(new Date().toISOString(), tz);
  const isToday = isSameDay(date, new Date());

  const lanes = React.useMemo(() => {
    const items = appts.map((a) => {
      const start = minutesInTz(a.starts_at, tz);
      const end = Math.max(start + 15, minutesInTz(a.ends_at, tz));
      return { appt: a, startsAt: start, endsAt: end };
    });
    return assignLanes(items);
  }, [appts, tz]);

  return (
    <GlassCard className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{formatDate(date)}</h2>
        <p className="text-sm text-muted-foreground">
          {clinic?.name}
          {closed
            ? " · closed"
            : hours
              ? ` · ${hours.open_time}–${hours.close_time}`
              : ""}
        </p>
      </div>

      {hoursError ? (
        <EmptyState
          icon={CalendarDays}
          title="Could not load clinic hours"
          description={mapApiError(hoursError)}
          action={
            <Button variant="outline" className="min-h-11" onClick={onRetryDay}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Retry
            </Button>
          }
        />
      ) : closed && !hoursPending ? (
        <EmptyState
          icon={CalendarDays}
          title="Clinic closed on this day"
          description={`No weekly opening hours are configured for ${formatDate(date)}. Appointments cannot start on a closed day — check Settings → clinic hours.`}
        />
      ) : hoursPending || appointmentsQuery.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-live="polite">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonGlass key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : appointmentsQuery.isError ? (
        <EmptyState
          icon={CalendarDays}
          title="Could not load appointments"
          description={mapApiError(appointmentsQuery.error)}
          action={
            <Button variant="outline" className="min-h-11" onClick={onRetryDay}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Retry
            </Button>
          }
        />
      ) : (
        <div className="relative flex" role="table" aria-label={`Appointments on ${formatDate(date)}`}>
          {/* Hour gutter */}
          <div className="w-14 shrink-0 sm:w-16" aria-hidden="true">
            {Array.from({ length: hourLines }).map((_, i) => {
              const minutes = openMin + i * 60;
              const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
              const mm = String(minutes % 60).padStart(2, "0");
              return (
                <div key={i} className="relative" style={{ height: HOUR_PX }}>
                  <span className="absolute -top-2 right-2 text-xs tabular-nums text-muted-foreground">
                    {hh}:{mm}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Grid + blocks */}
          <div className="relative flex-1" style={{ height: totalHeight }}>
            {Array.from({ length: hourLines }).map((_, i) => (
              <div
                key={i}
                aria-hidden="true"
                className="absolute inset-x-0 border-t border-border/60"
                style={{ top: i * HOUR_PX }}
              />
            ))}
            {isToday && nowMinutes >= openMin && nowMinutes <= closeMin ? (
              <div
                aria-hidden="true"
                className="absolute inset-x-0 z-10 flex items-center"
                style={{ top: (nowMinutes - openMin) * PX_PER_MIN }}
              >
                <span className="size-2 rounded-full bg-destructive" />
                <span className="h-px flex-1 bg-destructive/70" />
              </div>
            ) : null}

            {lanes.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-sm text-muted-foreground">
                  No appointments on this day.
                </p>
              </div>
            ) : null}

            {lanes.map(({ item, lane, lanes: laneCount }) => {
              const appt = item.appt;
              const startsAt = item.startsAt;
              const endsAt = item.endsAt;
              const colors = APPOINTMENT_BLOCK_CLASSES[appt.status];
              const width = 100 / laneCount;
              const top = Math.max(0, (startsAt - openMin) * PX_PER_MIN);
              const height = Math.max(30, (endsAt - startsAt) * PX_PER_MIN - 2);
              return (
                <AppointmentActionsMenu
                  key={appt.id}
                  appointment={appt}
                  onStatusAction={onStatusAction}
                  onReschedule={onReschedule}
                  onCancel={onCancel}
                >
                  <button
                    type="button"
                    className={cn(
                      "absolute z-[5] flex flex-col justify-start overflow-hidden rounded-md border px-2 py-1 text-left transition-shadow",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      colors.block
                    )}
                    style={{
                      top,
                      height,
                      left: `calc(${lane * width}% + 2px)`,
                      width: `calc(${width}% - 4px)`,
                    }}
                    aria-label={`${appt.patient_name}, ${formatTime(appt.starts_at, { timeZone: tz })}, ${APPOINTMENT_STATUS_LABELS[appt.status]}. Open actions`}
                  >
                    <span className="truncate text-xs font-semibold leading-4">
                      {formatTime(appt.starts_at, { timeZone: tz })} · {appt.patient_name}
                    </span>
                    {height >= 48 ? (
                      <span className="truncate text-xs opacity-80">
                        {appt.service_name ?? "Appointment"} · {appt.provider_name ?? ""}
                      </span>
                    ) : null}
                  </button>
                </AppointmentActionsMenu>
              );
            })}
          </div>
        </div>
      )}
    </GlassCard>
  );
}

/* ── Week view ───────────────────────────────────────────────────────────── */

function WeekView({
  weekStart,
  clinicTimezone,
  clinicHours,
  appointmentsQuery,
  onPickDay,
}: {
  weekStart: Date;
  clinicTimezone: string | undefined;
  clinicHours: Awaited<ReturnType<typeof api.getClinicHours>>;
  appointmentsQuery: UseQueryResult<Paginated<AppointmentRow>, Error>;
  onPickDay: (date: Date) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addCalendarDays(weekStart, i));
  const byDay = new Map<string, AppointmentRow[]>();
  for (const appt of appointmentsQuery.data?.items ?? []) {
    const key = dateKeyInTz(appt.starts_at, clinicTimezone);
    const list = byDay.get(key) ?? [];
    list.push(appt);
    byDay.set(key, list);
  }

  return (
    <GlassCard className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">
          {formatDate(weekStart)} — {formatDate(addCalendarDays(weekStart, 6))}
        </h2>
        <p className="text-sm text-muted-foreground">
          Week overview · pick a day to open it
        </p>
      </div>

      {appointmentsQuery.isPending ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7" aria-busy="true" aria-live="polite">
          {days.map((d, i) => (
            <SkeletonGlass key={i} className="h-40">
              <div className="space-y-2 p-3">
                <SkeletonGlassLine className="h-4 w-16" />
                <SkeletonGlassLine className="h-8 w-full" />
                <SkeletonGlassLine className="h-8 w-full" />
              </div>
            </SkeletonGlass>
          ))}
        </div>
      ) : appointmentsQuery.isError ? (
        <EmptyState
          icon={CalendarDays}
          title="Could not load the week"
          description={mapApiError(appointmentsQuery.error)}
          action={
            <Button variant="outline" className="min-h-11" onClick={() => void appointmentsQuery.refetch()}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Retry
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {days.map((day) => {
            const key = toIsoDate(day);
            const appts = byDay.get(key) ?? [];
            const backendDay = jsDayToBackendDay(day.getDay());
            const hours = findHoursForDay(clinicHours, backendDay);
            const closed = !hours || hours.is_closed;
            const counts = new Map<AppointmentStatus, number>();
            for (const a of appts) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
            const isToday = isSameDay(day, new Date());
            return (
              <button
                key={key}
                type="button"
                onClick={() => onPickDay(day)}
                className={cn(
                  "flex min-h-11 flex-col rounded-lg border p-3 text-left transition-colors",
                  "hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  isToday && "border-primary/50 bg-primary/5"
                )}
                aria-label={`${formatDate(day)} — ${
                  closed ? "clinic closed" : `${appts.length} appointment${appts.length === 1 ? "" : "s"}`
                }. Open day view`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{formatDate(day).split(",")[0]}</span>
                  <span
                    className={cn(
                      "text-lg font-semibold tabular-nums",
                      isToday ? "text-primary" : "text-foreground"
                    )}
                  >
                    {day.getDate()}
                  </span>
                </div>
                {closed ? (
                  <span className="mt-2 inline-flex w-fit items-center rounded-full border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    Closed
                  </span>
                ) : appts.length === 0 ? (
                  <span className="mt-2 text-xs text-muted-foreground">No appointments</span>
                ) : (
                  <div className="mt-2 space-y-1">
                    <span className="text-xs font-medium text-foreground">
                      {appts.length} appointment{appts.length === 1 ? "" : "s"}
                    </span>
                    {[...counts.entries()].map(([status, count]) => (
                      <div key={status} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          aria-hidden="true"
                          className={cn("size-1.5 rounded-full", APPOINTMENT_BLOCK_CLASSES[status].dot)}
                        />
                        {count} {APPOINTMENT_STATUS_LABELS[status].toLowerCase()}
                      </div>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </GlassCard>
  );
}

/* ── List view ───────────────────────────────────────────────────────────── */

function ListView({
  listQuery,
  searchInput,
  onSearchInput,
  statusFilter,
  onStatusFilter,
  fromDate,
  toDate,
  onFromDate,
  onToDate,
  clinicTimezone,
  onStatusAction,
  onReschedule,
  onCancel,
  onPageChange,
}: {
  listQuery: UseQueryResult<Paginated<AppointmentRow>, Error>;
  searchInput: string;
  onSearchInput: (v: string) => void;
  statusFilter: string;
  onStatusFilter: (v: string) => void;
  fromDate: string;
  toDate: string;
  onFromDate: (v: string) => void;
  onToDate: (v: string) => void;
  clinicTimezone: string | undefined;
  onStatusAction: (appt: AppointmentRow, action: "confirm" | "complete" | "no_show") => void;
  onReschedule: (appt: AppointmentRow) => void;
  onCancel: (appt: AppointmentRow) => void;
  onPageChange: (page: number) => void;
}) {
  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const pageSize = listQuery.data?.page_size ?? 10;
  const page = listQuery.data?.page ?? 1;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <GlassCard className="p-4 sm:p-6">
      {/* Filters */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={searchInput}
            onChange={(e) => onSearchInput(e.target.value)}
            placeholder="Search patient name or phone…"
            aria-label="Search appointments by patient name or phone"
            className="min-h-11 pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={onStatusFilter}>
          <SelectTrigger className="min-h-11" aria-label="Filter by status">
            <ListFilter className="size-4 text-muted-foreground" aria-hidden="true" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {ALL_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {APPOINTMENT_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          value={fromDate}
          max={toDate || undefined}
          onChange={(e) => onFromDate(e.target.value)}
          aria-label="From date"
          className="min-h-11"
        />
        <Input
          type="date"
          value={toDate}
          min={fromDate || undefined}
          onChange={(e) => onToDate(e.target.value)}
          aria-label="To date"
          className="min-h-11"
        />
      </div>

      {listQuery.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-live="polite">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonGlass key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : listQuery.isError ? (
        <EmptyState
          icon={CalendarDays}
          title="Could not load appointments"
          description={mapApiError(listQuery.error)}
          action={
            <Button variant="outline" className="min-h-11" onClick={() => void listQuery.refetch()}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Retry
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No appointments in this range"
          description={
            searchInput || statusFilter !== "all" || fromDate || toDate
              ? "Nothing matches the current filters. Try widening the date range or clearing the search."
              : "Book the first appointment with the button above."
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Patient</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((appt) => (
                  <TableRow key={appt.id}>
                    <TableCell>
                      <div className="font-medium">{appt.patient_name}</div>
                      {appt.patient_phone ? (
                        <div className="text-xs text-muted-foreground">{appt.patient_phone}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{appt.service_name ?? "—"}</TableCell>
                    <TableCell className="text-sm">{appt.provider_name ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm tabular-nums">
                      {formatDate(appt.starts_at)}
                      <br />
                      <span className="text-muted-foreground">
                        {formatTime(appt.starts_at, { timeZone: clinicTimezone })}–
                        {formatTime(appt.ends_at, { timeZone: clinicTimezone })}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={appt.status} />
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground capitalize">{appt.source}</span>
                    </TableCell>
                    <TableCell>
                      <AppointmentActionsMenu
                        appointment={appt}
                        onStatusAction={onStatusAction}
                        onReschedule={onReschedule}
                        onCancel={onCancel}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-11"
                          aria-label={`Actions for ${appt.patient_name} on ${formatDate(appt.starts_at)}`}
                        >
                          <MoreHorizontal className="size-4" aria-hidden="true" />
                        </Button>
                      </AppointmentActionsMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
              Showing {from}–{to} of {total}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="min-h-11"
                disabled={page <= 1 || listQuery.isFetching}
                onClick={() => onPageChange(page - 1)}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
                Previous
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={to >= total || listQuery.isFetching}
                onClick={() => onPageChange(page + 1)}
              >
                Next
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </>
      )}
    </GlassCard>
  );
}
