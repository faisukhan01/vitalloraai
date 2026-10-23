"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  Braces,
  Download,
  Globe,
  MessageSquareOff,
  Monitor,
  Phone,
  User,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { api } from "@vitalora/api-client";
import type { ConversationMessage, ConversationSession } from "@vitalora/shared-types";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/glass/status-badge";
import { SkeletonGlass, SkeletonGlassLine } from "@/components/glass/skeleton-glass";
import { EmptyState } from "@/components/glass/empty-state";
import { ErrorState } from "@/components/ops/error-state";
import {
  formatDuration,
  languageLabel,
} from "@/components/ops/helpers";
import { formatDateTime, formatTime, mapApiError } from "@/lib/utils-api";

const CHANNEL_ICONS: Record<ConversationSession["channel"], LucideIcon> = {
  browser: Monitor,
  phone: Phone,
  api: Braces,
};

const OUTCOME_TONES: Record<string, "success" | "teal" | "warning" | "danger" | "neutral"> = {
  appointment_booked: "success",
  appointment_rescheduled: "teal",
  appointment_cancelled: "neutral",
  callback_requested: "teal",
  transferred_to_human: "warning",
  info_provided: "teal",
  unresolved: "danger",
};

export interface SessionDetailSheetProps {
  session: ConversationSession | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** clinic_id → IANA timezone, used to render times in clinic-local time. */
  clinicTimezones: Record<string, string>;
}

/**
 * SessionDetailSheet — session metadata + full transcript in a right-side
 * sheet (full-width on mobile). Includes an honest JSON export of exactly
 * what the backend returned, and an explicit "audio is not retained" note.
 */
export function SessionDetailSheet({
  session,
  open,
  onOpenChange,
  clinicTimezones,
}: SessionDetailSheetProps) {
  const messagesQuery = useQuery({
    queryKey: ["calls", "messages", session?.id],
    queryFn: () => api.getSessionMessages(session?.id as string),
    enabled: open && session !== null,
  });

  const tz = session ? clinicTimezones[session.clinic_id] : undefined;
  const ChannelIcon = session ? (CHANNEL_ICONS[session.channel] ?? Globe) : Globe;

  function exportJson() {
    if (!session) return;
    const payload = {
      exported_at: new Date().toISOString(),
      exported_by: "VITALORA AI console",
      session,
      messages: messagesQuery.data?.messages ?? [],
      note: "Audio is not retained by VITALORA AI; this transcript is the complete record of the session.",
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const startedDay = session.started_at.slice(0, 10) || "unknown-date";
    const a = document.createElement("a");
    a.href = url;
    a.download = `vitalora-call-${session.id.slice(0, 8)}-${startedDay}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const messages = messagesQuery.data?.messages;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
      >
        {session ? (
          <>
            <SheetHeader className="border-b border-border/60 px-5 py-4 pr-14">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={session.status} />
                {session.outcome ? (
                  <StatusBadge
                    status={session.outcome}
                    tone={OUTCOME_TONES[session.outcome] ?? "neutral"}
                    withDot={false}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No outcome recorded
                  </span>
                )}
              </div>
              <SheetTitle className="mt-1 text-base">
                Call session{" "}
                <span className="font-mono text-sm font-normal text-muted-foreground">
                  #{session.id.slice(0, 8)}
                </span>
              </SheetTitle>
              <SheetDescription>
                Full transcript and metadata for this conversation.
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {/* Metadata */}
              <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                <MetaItem
                  label="Caller"
                  value={session.caller_ref ?? "Unknown caller"}
                />
                <MetaItem
                  label="Receptionist"
                  value={session.receptionist_name ?? "Unassigned"}
                />
                <MetaItem
                  label="Language"
                  value={`${languageLabel(session.language)} (${session.language})`}
                />
                <MetaItem
                  label="Channel"
                  value={
                    <>
                      <ChannelIcon
                        className="mr-1.5 inline size-3.5 align-[-2px]"
                        aria-hidden="true"
                      />
                      {session.channel}
                    </>
                  }
                />
                <MetaItem
                  label="Started"
                  value={formatDateTime(session.started_at, { timeZone: tz })}
                  hint={tz ? `Clinic time (${tz})` : undefined}
                />
                <MetaItem
                  label="Duration"
                  value={formatDuration(session.duration_seconds)}
                />
                {session.end_reason ? (
                  <MetaItem label="End reason" value={session.end_reason} />
                ) : null}
                {session.ended_at ? (
                  <MetaItem
                    label="Ended"
                    value={formatDateTime(session.ended_at, { timeZone: tz })}
                  />
                ) : null}
              </dl>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 gap-1.5 sm:min-h-9"
                  onClick={exportJson}
                  disabled={messagesQuery.isFetching}
                  aria-label="Export session transcript as JSON"
                >
                  <Download className="size-4" aria-hidden="true" />
                  Export JSON
                </Button>
                <p className="text-xs text-muted-foreground">
                  Exports exactly what the backend returned for this session.
                </p>
              </div>

              <p className="mt-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-foreground">
                Audio is not retained by VITALORA AI. This transcript is the only
                record of the call — there is no playback available.
              </p>

              <Separator className="my-5" />

              {/* Transcript */}
              <h3 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
                Transcript
              </h3>
              {messagesQuery.isLoading || messagesQuery.isFetching ? (
                <div aria-hidden="true" className="space-y-3">
                  <SkeletonGlass className="h-16 w-2/3" />
                  <SkeletonGlass className="ml-auto h-12 w-1/2" />
                  <SkeletonGlass className="h-20 w-3/4" />
                  <SkeletonGlassLine className="h-3 w-1/4" />
                </div>
              ) : messagesQuery.isError ? (
                <ErrorState
                  context="the transcript"
                  message={mapApiError(messagesQuery.error)}
                  onRetry={() => messagesQuery.refetch()}
                  retrying={messagesQuery.isFetching}
                />
              ) : !messages || messages.length === 0 ? (
                <EmptyState
                  icon={MessageSquareOff}
                  title="No messages recorded"
                  description="This session has no stored messages — it may have ended before any conversation happened. Nothing is simulated here."
                />
              ) : (
                <ol className="space-y-3" aria-label="Conversation transcript">
                  {messages.map((msg) => (
                    <TranscriptBubble
                      key={msg.id}
                      message={msg}
                      timeZone={tz}
                    />
                  ))}
                </ol>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            Select a session to view its transcript.
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function MetaItem({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 break-words font-medium text-foreground">
        {value}
        {hint ? (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            ({hint})
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function TranscriptBubble({
  message,
  timeZone,
}: {
  message: ConversationMessage;
  timeZone?: string;
}) {
  if (message.role === "tool") {
    return (
      <li className="flex justify-center">
        <span
          className="max-w-full truncate rounded-full border border-border bg-muted px-3 py-1 font-mono text-xs text-muted-foreground"
          title={message.tool_payload ?? undefined}
        >
          tool · {message.tool_name ?? "unknown"}
        </span>
      </li>
    );
  }

  if (message.role === "system") {
    return (
      <li className="text-center text-xs text-muted-foreground">
        {message.content}
      </li>
    );
  }

  const isUser = message.role === "user";
  return (
    <li className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-2xl rounded-br-md border border-primary/25 bg-primary/10 px-4 py-2.5 text-sm leading-relaxed text-foreground sm:max-w-[75%]"
            : "glass max-w-[85%] rounded-2xl rounded-bl-md px-4 py-2.5 text-sm leading-relaxed text-foreground sm:max-w-[75%]"
        }
      >
        <p className="sr-only">{isUser ? "Caller said" : "Receptionist said"}</p>
        <p className="whitespace-pre-wrap break-words">
          {message.content ?? (isUser ? "(no speech captured)" : "(no reply text)")}
        </p>
        <p className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground/80">
          <span aria-hidden="true">
            {isUser ? <User className="inline size-3 align-[-2px]" /> : <Bot className="inline size-3 align-[-2px]" />}
          </span>
          <time dateTime={message.created_at}>
            {formatTime(message.created_at, { timeZone })}
          </time>
          {!isUser && message.latency_ms !== null ? (
            <span className="tabular-nums" title="Time to generate this reply">
              · {message.latency_ms} ms
            </span>
          ) : null}
        </p>
      </div>
    </li>
  );
}
