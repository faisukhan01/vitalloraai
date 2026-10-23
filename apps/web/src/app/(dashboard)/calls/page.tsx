"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Braces, Globe, Monitor, Phone, PhoneCall } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { api } from "@vitalora/api-client";
import { SUPPORTED_LANGUAGES, type ConversationSession } from "@vitalora/shared-types";

import { PageHeader } from "@/components/glass/page-header";
import { GlassCard } from "@/components/glass/glass-card";
import { EmptyState } from "@/components/glass/empty-state";
import { StatusBadge } from "@/components/glass/status-badge";
import { SkeletonGlass, SkeletonGlassLine } from "@/components/glass/skeleton-glass";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PaginationFooter } from "@/components/ops/pagination-footer";
import { ErrorState } from "@/components/ops/error-state";
import { SessionDetailSheet } from "@/components/ops/session-detail-sheet";
import { formatDuration, formatOutcome, languageLabel } from "@/components/ops/helpers";
import { formatDateTime, mapApiError } from "@/lib/utils-api";

const CHANNEL_ICONS: Record<ConversationSession["channel"], LucideIcon> = {
  browser: Monitor,
  phone: Phone,
  api: Braces,
};

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "escalated", label: "Escalated" },
];

const OUTCOME_TONES: Record<string, "success" | "teal" | "warning" | "danger" | "neutral"> = {
  appointment_booked: "success",
  appointment_rescheduled: "teal",
  appointment_cancelled: "neutral",
  callback_requested: "teal",
  transferred_to_human: "warning",
  info_provided: "teal",
  unresolved: "danger",
};

export default function CallsPage() {
  // ── Filters ────────────────────────────────────────────────────────────
  const [status, setStatus] = React.useState("all");
  const [language, setLanguage] = React.useState("all");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [page, setPage] = React.useState(1);

  React.useEffect(() => {
    setPage(1);
  }, [status, language, from, to]);

  const listQuery = useQuery({
    queryKey: ["calls", "sessions", { status, language, from, to, page }],
    queryFn: () =>
      api.listSessions({
        status: status === "all" ? undefined : status,
        language: language === "all" ? undefined : language,
        from: from || undefined,
        to: to || undefined,
        page,
        page_size: 20,
      }),
  });

  // Clinic timezones — used to render started_at in clinic-local time.
  const clinicsQuery = useQuery({
    queryKey: ["clinics"],
    queryFn: () => api.listClinics(),
    staleTime: 5 * 60_000,
  });
  const clinicTimezones = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const clinic of clinicsQuery.data?.items ?? []) {
      map[clinic.id] = clinic.timezone;
    }
    return map;
  }, [clinicsQuery.data]);

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const pageSize = listQuery.data?.page_size ?? 20;
  const isFiltered =
    status !== "all" || language !== "all" || from !== "" || to !== "";

  // ── Detail sheet ───────────────────────────────────────────────────────
  const [selected, setSelected] = React.useState<ConversationSession | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);

  function openSession(session: ConversationSession) {
    setSelected(session);
    setSheetOpen(true);
  }

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Call history"
        description="Every voice session handled by your AI receptionists — with the full transcript of what was said. Audio itself is not retained."
      />

      {/* Filters */}
      <GlassCard className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="calls-status" className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Status
          </label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="calls-status" className="min-h-11 w-full">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label htmlFor="calls-language" className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Language
          </label>
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger id="calls-language" className="min-h-11 w-full">
              <SelectValue placeholder="All languages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All languages</SelectItem>
              {SUPPORTED_LANGUAGES.map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label htmlFor="calls-from" className="mb-1.5 block text-xs font-medium text-muted-foreground">
            From date
          </label>
          <Input
            id="calls-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="min-h-11"
          />
        </div>
        <div>
          <label htmlFor="calls-to" className="mb-1.5 block text-xs font-medium text-muted-foreground">
            To date
          </label>
          <Input
            id="calls-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="min-h-11"
          />
        </div>
      </GlassCard>

      {/* Session list */}
      {listQuery.isLoading ? (
        <div aria-hidden="true" className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonGlass key={i} className="h-20 w-full p-4">
              <SkeletonGlassLine className="h-4 w-1/4" />
              <SkeletonGlassLine className="mt-3 h-3 w-2/3" />
            </SkeletonGlass>
          ))}
        </div>
      ) : listQuery.isError ? (
        <ErrorState
          context="call history"
          message={mapApiError(listQuery.error)}
          onRetry={() => listQuery.refetch()}
          retrying={listQuery.isFetching}
        />
      ) : items.length === 0 ? (
        isFiltered ? (
          <EmptyState
            icon={PhoneCall}
            title="No sessions match"
            description="No calls match the current filters. Widen the date range or clear the filters to see more."
          />
        ) : (
          <EmptyState
            icon={PhoneCall}
            title="No calls yet"
            description="When your AI receptionists answer their first calls, the sessions will appear here with full transcripts — no simulated data."
          />
        )
      ) : (
        <div className="space-y-3">
          <ul className="space-y-3" aria-label="Call sessions">
            {items.map((session) => {
              const ChannelIcon = CHANNEL_ICONS[session.channel] ?? Globe;
              const tz = clinicTimezones[session.clinic_id];
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => openSession(session)}
                    aria-label={`Open session started ${formatDateTime(session.started_at, { timeZone: tz })}`}
                    className="block w-full rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <GlassCard
                      hoverLift
                      className="p-4 motion-safe:hover:border-primary/30 sm:p-5"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-start gap-3">
                          <span
                            aria-hidden="true"
                            className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-primary"
                          >
                            <ChannelIcon className="size-5" />
                          </span>
                          <div className="min-w-0">
                            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                              <span className="truncate">
                                {session.caller_ref ?? "Unknown caller"}
                              </span>
                              <span
                                className="rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-[11px] font-medium uppercase text-muted-foreground"
                                title={languageLabel(session.language)}
                              >
                                {session.language}
                              </span>
                            </p>
                            <p className="mt-0.5 truncate text-sm text-muted-foreground">
                              {session.receptionist_name ?? "Unassigned receptionist"}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {formatDateTime(session.started_at, { timeZone: tz })}
                              {tz ? " · clinic time" : ""} ·{" "}
                              <span className="tabular-nums">
                                {formatDuration(session.duration_seconds)}
                              </span>
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2 pl-13 sm:pl-0">
                          <StatusBadge status={session.status} />
                          {session.outcome ? (
                            <StatusBadge
                              status={session.outcome}
                              tone={OUTCOME_TONES[session.outcome] ?? "neutral"}
                              withDot={false}
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {formatOutcome(null)}
                            </span>
                          )}
                        </div>
                      </div>
                    </GlassCard>
                  </button>
                </li>
              );
            })}
          </ul>

          <PaginationFooter
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            itemLabel="sessions"
          />
        </div>
      )}

      {/* Detail sheet (desktop right panel, full sheet on mobile) */}
      <SessionDetailSheet
        session={selected}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        clinicTimezones={clinicTimezones}
      />
    </>
  );
}
