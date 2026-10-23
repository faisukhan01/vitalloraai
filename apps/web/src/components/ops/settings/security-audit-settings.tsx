"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronDown, Cog, ShieldCheck, User } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { api } from "@vitalora/api-client";
import type { AuditEvent } from "@vitalora/shared-types";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GlassCard } from "@/components/glass/glass-card";
import { GlassPanel } from "@/components/glass/glass-panel";
import { EmptyState } from "@/components/glass/empty-state";
import { SkeletonGlass } from "@/components/glass/skeleton-glass";
import { PaginationFooter } from "@/components/ops/pagination-footer";
import { ErrorState } from "@/components/ops/error-state";
import { truncate } from "@/components/ops/helpers";
import { formatDateTime, mapApiError } from "@/lib/utils-api";
import { useDebouncedValue } from "@/hooks/use-debounced-value";

const ACTOR_ICONS: Record<AuditEvent["actor_type"], LucideIcon> = {
  user: User,
  system: Cog,
  ai_receptionist: Bot,
};

const ACTOR_LABELS: Record<AuditEvent["actor_type"], string> = {
  user: "User",
  system: "System",
  ai_receptionist: "AI receptionist",
};

/**
 * SecurityAuditSettings — the real audit trail (action filter + pagination)
 * plus an honest, static security-posture statement (what is implemented and
 * what is not — spec §10/§11).
 */
export function SecurityAuditSettings() {
  const [actionInput, setActionInput] = React.useState("");
  const action = useDebouncedValue(actionInput.trim());
  const [page, setPage] = React.useState(1);

  React.useEffect(() => {
    setPage(1);
  }, [action]);

  const auditQuery = useQuery({
    queryKey: ["audit", { action, page }],
    queryFn: () => api.listAuditEvents({ action: action || undefined, page }),
  });

  const items = auditQuery.data?.items ?? [];
  const total = auditQuery.data?.total ?? 0;
  const pageSize = auditQuery.data?.page_size ?? 25;

  return (
    <div className="space-y-6">
      {/* Security posture — static, honest statement */}
      <GlassCard className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-primary"
          >
            <ShieldCheck className="size-5" />
          </span>
          <div>
            <h2 className="font-semibold tracking-tight text-foreground">
              Security posture
            </h2>
            <p className="text-sm text-muted-foreground">
              What VITALORA AI implements today — stated plainly, including what
              is not done yet.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium text-foreground">In place</h3>
            <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              <li className="flex gap-2">
                <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-success" />
                JWT access tokens (30 min) with rotating refresh tokens (7 days,
                httpOnly cookie).
              </li>
              <li className="flex gap-2">
                <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-success" />
                argon2id password hashing.
              </li>
              <li className="flex gap-2">
                <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-success" />
                Per-request organization isolation — every query is scoped to the
                authenticated principal&apos;s organization.
              </li>
              <li className="flex gap-2">
                <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-success" />
                Audit trail of sensitive actions, viewable below.
              </li>
              <li className="flex gap-2">
                <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-success" />
                Rate limiting on authentication and write endpoints.
              </li>
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-medium text-foreground">
              Known limitations
            </h3>
            <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              <li className="flex gap-2">
                <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />
                The rate limiter is in-process — it does not share counters across
                multiple server instances.
              </li>
              <li className="flex gap-2">
                <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />
                Email flows (verification, password reset) are not configured yet;
                reset requests return an honest &ldquo;not available&rdquo; response.
              </li>
              <li className="flex gap-2">
                <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />
                No HIPAA assessment has been performed — VITALORA AI is not
                claimed to be HIPAA-compliant.
              </li>
            </ul>
          </div>
        </div>
      </GlassCard>

      {/* Audit trail */}
      <GlassPanel className="p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="font-semibold tracking-tight text-foreground">
              Audit trail
            </h2>
            <p className="text-sm text-muted-foreground">
              Every sensitive action recorded by the backend — users, system
              jobs and AI receptionists.
            </p>
          </div>
          <div className="w-full sm:w-64">
            <label htmlFor="audit-action" className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Filter by action
            </label>
            <Input
              id="audit-action"
              value={actionInput}
              onChange={(e) => setActionInput(e.target.value)}
              placeholder="e.g. clinic_created"
              className="min-h-11 font-mono text-sm"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="mt-5">
          {auditQuery.isLoading ? (
            <div aria-hidden="true" className="space-y-2">
              <SkeletonGlass className="h-12 w-full" />
              <SkeletonGlass className="h-12 w-full" />
              <SkeletonGlass className="h-12 w-full" />
            </div>
          ) : auditQuery.isError ? (
            <ErrorState
              context="audit events"
              message={mapApiError(auditQuery.error)}
              onRetry={() => auditQuery.refetch()}
              retrying={auditQuery.isFetching}
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No audit events"
              description={
                action
                  ? `No events match the action “${action}”. Clear the filter to see the full trail.`
                  : "Sensitive actions (logins, clinic and knowledge changes, bookings) will appear here as they happen."
              }
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Entity</TableHead>
                      <TableHead>Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((event) => (
                      <AuditRow key={event.id} event={event} />
                    ))}
                  </TableBody>
                </Table>
              </div>
              <PaginationFooter
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                itemLabel="events"
                className="mt-4"
              />
            </>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}

function AuditRow({ event }: { event: AuditEvent }) {
  const ActorIcon = ACTOR_ICONS[event.actor_type] ?? User;
  const details =
    event.details && Object.keys(event.details).length > 0
      ? JSON.stringify(event.details, null, 2)
      : null;

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {formatDateTime(event.created_at)}
      </TableCell>
      <TableCell>
        <span
          className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-foreground"
          title={ACTOR_LABELS[event.actor_type] ?? event.actor_type}
        >
          <ActorIcon
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="max-w-40 truncate">
            {event.actor_display ?? ACTOR_LABELS[event.actor_type] ?? event.actor_type}
          </span>
        </span>
      </TableCell>
      <TableCell>
        <span className="inline-block whitespace-nowrap rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 font-mono text-xs font-medium text-primary">
          {event.action}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {event.entity_type ? (
          <span className="whitespace-nowrap">
            {event.entity_type}
            {event.entity_id ? (
              <span className="ml-1 font-mono text-xs">
                {truncate(event.entity_id, 10)}
              </span>
            ) : null}
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell>
        {details ? (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 gap-1 px-2 text-xs text-muted-foreground sm:min-h-9"
                aria-label="Toggle event details"
              >
                View JSON
                <ChevronDown className="size-3.5 transition-transform aria-expanded:rotate-180" aria-hidden="true" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-w-md overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 text-xs leading-relaxed text-foreground">
                {details}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}
