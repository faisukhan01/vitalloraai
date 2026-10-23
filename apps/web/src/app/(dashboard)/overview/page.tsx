"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  Bot,
  BookPlus,
  CalendarCheck,
  CalendarClock,
  ChevronRight,
  Mic,
  Phone,
  PhoneCall,
  RefreshCw,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { api } from "@vitalora/api-client";
import { SUPPORTED_LANGUAGES } from "@vitalora/shared-types";

import { cn } from "@/lib/utils";
import { formatRelative, mapApiError } from "@/lib/utils-api";
import { EmptyState } from "@/components/glass/empty-state";
import { GlassCard } from "@/components/glass/glass-card";
import { GlassPanel } from "@/components/glass/glass-panel";
import { PageHeader } from "@/components/glass/page-header";
import { SkeletonGlass, SkeletonGlassLine } from "@/components/glass/skeleton-glass";
import { StatTile } from "@/components/glass/stat-tile";
import { StatusBadge } from "@/components/glass/status-badge";
import { Button } from "@/components/ui/button";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Dashboard — the live operational overview. Every number on this page comes
 * from the real API (overview + analytics series + recent sessions); there is
 * no mock data. When the backend is unreachable the page shows honest error
 * states with a retry — never fabricated numbers.
 */

const chartConfig = {
  sessions: { label: "Sessions", color: "var(--primary)" },
  bookings: { label: "Bookings", color: "var(--success)" },
} satisfies ChartConfig;

const OUTCOME_LABELS: Record<string, string> = {
  appointment_booked: "Appointment booked",
  appointment_cancelled: "Appointment cancelled",
  appointment_rescheduled: "Appointment rescheduled",
  callback_requested: "Callback requested",
  transferred_to_human: "Transferred to human",
  info_provided: "Info provided",
  unresolved: "Unresolved",
};

const OUTCOME_BAR_TONES: Record<string, string> = {
  appointment_booked: "bg-success",
  appointment_cancelled: "bg-destructive/80",
  appointment_rescheduled: "bg-warning",
  callback_requested: "bg-primary",
  transferred_to_human: "bg-warning/80",
  info_provided: "bg-primary/70",
  unresolved: "bg-muted-foreground/50",
};

function humanizeOutcome(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome.replace(/_/g, " ");
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m === 0) return `${rem}s`;
  return `${m}m ${String(rem).padStart(2, "0")}s`;
}

/** Subtle fade-in that degrades to static under prefers-reduced-motion. */
function FadeIn({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduceMotion = useReducedMotion();
  if (reduceMotion) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut", delay }}
    >
      {children}
    </motion.div>
  );
}

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const organization = useAuthStore((s) => s.organization);

  const overviewQuery = useQuery({
    queryKey: ["analytics-overview"],
    queryFn: () => api.getDashboardOverview(),
  });
  const seriesQuery = useQuery({
    queryKey: ["analytics-series", 14],
    queryFn: () => api.getAnalytics(14),
  });
  const sessionsQuery = useQuery({
    queryKey: ["sessions", "recent", 5],
    queryFn: () => api.listSessions({ page_size: 5 }),
  });

  const overview = overviewQuery.data;

  // Greeting is computed after mount — the server's clock/tz differs from
  // the visitor's, and a mismatch here would be a hydration error.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const hour = new Date().getHours();
  const dayPart = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = user?.name?.trim().split(/\s+/)[0] ?? "there";
  const plan = organization?.plan ?? "";

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title={mounted ? `${dayPart}, ${firstName}` : `Welcome, ${firstName}`}
        description={
          organization
            ? `Here is what is happening at ${organization.name} right now.`
            : "Here is your live operational overview."
        }
        actions={<PlanBadge plan={plan} />}
      />

      {/* KPI row */}
      <section aria-label="Key metrics">
        {overviewQuery.isPending ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4" aria-busy="true" aria-live="polite">
            {Array.from({ length: 7 }).map((_, i) => (
              <SkeletonGlass key={i} className="h-32 w-full" />
            ))}
          </div>
        ) : overviewQuery.isError ? (
          <EmptyState
            icon={AlertTriangle}
            title="Could not load your metrics"
            description={mapApiError(overviewQuery.error)}
            action={
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => void overviewQuery.refetch()}
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                Retry
              </Button>
            }
          />
        ) : overview ? (
          <FadeIn className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
            <StatTile
              label="Appointments today"
              value={overview.appointments_today}
              icon={CalendarCheck}
              hint="scheduled for today"
            />
            <StatTile
              label="Upcoming appointments"
              value={overview.appointments_upcoming}
              icon={CalendarClock}
              hint="from this moment on"
            />
            <StatTile
              label="Calls · 24 hours"
              value={overview.calls_last_24h}
              icon={PhoneCall}
              hint="voice sessions started"
            />
            <StatTile
              label="Calls · 7 days"
              value={overview.calls_last_7d}
              icon={Phone}
              hint={
                overview.avg_session_seconds_7d != null
                  ? `avg call ${formatDuration(overview.avg_session_seconds_7d)}${
                      overview.success_rate_7d != null
                        ? ` · ${Math.round(overview.success_rate_7d * 100)}% resolved`
                        : ""
                    }`
                  : "voice sessions started"
              }
            />
            <StatTile
              label="Voice bookings · 7 days"
              value={overview.bookings_via_voice_7d}
              icon={Mic}
              hint="appointments made by AI"
            />
            <StatTile
              label="Open escalations"
              value={overview.escalations_open}
              icon={AlertTriangle}
              hint="awaiting a human"
            />
            <StatTile
              label="Active receptionists"
              value={`${overview.receptionists_active}/${overview.receptionists_total}`}
              icon={Bot}
              hint="taking calls now"
            />
          </FadeIn>
        ) : null}
      </section>

      {/* Chart + breakdowns */}
      <section aria-label="Trends" className="grid gap-4 lg:grid-cols-3">
        <GlassCard className="p-4 sm:p-6 lg:col-span-2">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold tracking-tight">
              Sessions & bookings — last 14 days
            </h2>
            <p className="text-sm text-muted-foreground">voice sessions / appointments made</p>
          </div>
          {seriesQuery.isPending ? (
            <div className="space-y-3" aria-busy="true" aria-live="polite">
              <SkeletonGlassLine className="h-64 w-full" />
            </div>
          ) : seriesQuery.isError ? (
            <EmptyState
              icon={AlertTriangle}
              title="Could not load the trend chart"
              description={mapApiError(seriesQuery.error)}
              action={
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => void seriesQuery.refetch()}
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  Retry
                </Button>
              }
            />
          ) : (
            <ChartContainer config={chartConfig} className="h-64 w-full">
              <AreaChart
                data={seriesQuery.data.series.map((point) => ({
                  date: format(parseISO(point.date), "d MMM"),
                  sessions: point.sessions,
                  bookings: point.bookings,
                }))}
                margin={{ left: 4, right: 8 }}
              >
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={20}
                  tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                />
                <YAxis
                  allowDecimals={false}
                  width={28}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  dataKey="sessions"
                  type="monotone"
                  stroke="var(--color-sessions)"
                  fill="var(--color-sessions)"
                  fillOpacity={0.16}
                  strokeWidth={2}
                />
                <Area
                  dataKey="bookings"
                  type="monotone"
                  stroke="var(--color-bookings)"
                  fill="var(--color-bookings)"
                  fillOpacity={0.16}
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          )}
        </GlassCard>

        <GlassCard className="p-4 sm:p-6">
          <h2 className="text-lg font-semibold tracking-tight">Last 14 days by outcome</h2>
          {seriesQuery.isPending ? (
            <div className="mt-4 space-y-3" aria-busy="true">
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonGlassLine key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : seriesQuery.isError ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {mapApiError(seriesQuery.error)}
            </p>
          ) : (
            <BreakdownBars
              entries={(seriesQuery.data.outcomes ?? []).map((o) => ({
                key: o.outcome,
                label: humanizeOutcome(o.outcome),
                count: o.count,
                barClass: OUTCOME_BAR_TONES[o.outcome] ?? "bg-primary",
              }))}
            />
          )}

          <h2 className="mt-6 text-lg font-semibold tracking-tight">Languages heard</h2>
          {seriesQuery.isPending ? (
            <div className="mt-4 space-y-3" aria-busy="true">
              {Array.from({ length: 3 }).map((_, i) => (
                <SkeletonGlassLine key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : seriesQuery.isError ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {mapApiError(seriesQuery.error)}
            </p>
          ) : (
            <BreakdownBars
              entries={(seriesQuery.data.languages ?? []).map((l) => ({
                key: l.language,
                label: SUPPORTED_LANGUAGES.find((s) => s.code === l.language)?.label ?? l.language,
                count: l.count,
                barClass: "bg-primary",
              }))}
            />
          )}
        </GlassCard>
      </section>

      {/* Recent activity + quick actions */}
      <section aria-label="Recent activity and quick actions" className="grid gap-4 lg:grid-cols-3">
        <GlassCard className="p-4 sm:p-6 lg:col-span-2">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold tracking-tight">Recent calls</h2>
            <Link
              href="/calls"
              className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              View all in Calls
              <ChevronRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
          {sessionsQuery.isPending ? (
            <div className="space-y-2" aria-busy="true" aria-live="polite">
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonGlass key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : sessionsQuery.isError ? (
            <EmptyState
              icon={AlertTriangle}
              title="Could not load recent calls"
              description={mapApiError(sessionsQuery.error)}
              action={
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => void sessionsQuery.refetch()}
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  Retry
                </Button>
              }
            />
          ) : sessionsQuery.data.items.length === 0 ? (
            <EmptyState
              icon={PhoneCall}
              title="No calls yet"
              description="Voice sessions will appear here as soon as a receptionist takes its first call. Try one in the Voice Lab."
            />
          ) : (
            <ul className="divide-y divide-border/70">
              {sessionsQuery.data.items.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {s.caller_ref ?? "Anonymous caller"}{" "}
                      <span className="font-normal text-muted-foreground">
                        · {s.language.toUpperCase()}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatRelative(s.started_at)}
                      {s.duration_seconds != null ? ` · ${formatDuration(s.duration_seconds)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {s.outcome ? (
                      <StatusBadge status={s.outcome} />
                    ) : null}
                    <StatusBadge status={s.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </GlassCard>

        <GlassPanel className="p-4 sm:p-6">
          <h2 className="text-lg font-semibold tracking-tight">Quick actions</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Jump straight into the workflows front desks use most.
          </p>
          <div className="mt-4 space-y-2.5">
            <Button asChild variant="outline" className="min-h-11 w-full justify-start">
              <Link href="/appointments?book=1">
                <CalendarCheck className="size-4 text-primary" aria-hidden="true" />
                New appointment
                <ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" className="min-h-11 w-full justify-start">
              <Link href="/voice-lab">
                <Mic className="size-4 text-primary" aria-hidden="true" />
                Open Voice Lab
                <ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" className="min-h-11 w-full justify-start">
              <Link href="/knowledge?new=1">
                <BookPlus className="size-4 text-primary" aria-hidden="true" />
                Add knowledge
                <ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </GlassPanel>
      </section>
    </>
  );
}

function PlanBadge({ plan }: { plan: string }) {
  if (!plan) return null;
  if (plan === "demo") {
    return (
      <span className="inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border border-warning/30 bg-warning/10 px-2.5 py-0.5 text-xs font-medium text-warning">
        Demo data
      </span>
    );
  }
  if (plan === "trial") {
    return (
      <span className="inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border border-primary/25 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
        Trial
      </span>
    );
  }
  return (
    <span className="inline-flex w-fit items-center whitespace-nowrap rounded-full border bg-muted px-2.5 py-0.5 text-xs font-medium capitalize text-muted-foreground">
      {plan}
    </span>
  );
}

/** Horizontal breakdown rows — real counts only, widths relative to the max. */
function BreakdownBars({
  entries,
}: {
  entries: { key: string; label: string; count: number; barClass: string }[];
}) {
  const max = entries.reduce((m, e) => Math.max(m, e.count), 0);
  if (entries.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground" role="status">
        Nothing recorded in this window yet.
      </p>
    );
  }
  return (
    <ul className="mt-3 space-y-2.5">
      {entries.map((e) => (
        <li key={e.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{e.label}</span>
            <span className="shrink-0 font-semibold tabular-nums">{e.count}</span>
          </div>
          <div
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`${e.label}: ${e.count}`}
          >
            <div
              className={cn("h-full rounded-full", e.barClass)}
              style={{ width: `${max > 0 ? Math.max(4, (e.count / max) * 100) : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
