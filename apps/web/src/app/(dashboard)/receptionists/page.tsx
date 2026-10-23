"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  FlaskConical,
  Loader2,
  MoreHorizontal,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plus,
  RefreshCw,
  Trash2,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@vitalora/api-client";
import type { Receptionist } from "@vitalora/shared-types";
import { SUPPORTED_LANGUAGES } from "@vitalora/shared-types";

import { cn } from "@/lib/utils";
import { initials, mapApiError } from "@/lib/utils-api";
import { EmptyState } from "@/components/glass/empty-state";
import { GlassCard } from "@/components/glass/glass-card";
import { PageHeader } from "@/components/glass/page-header";
import { SkeletonGlass } from "@/components/glass/skeleton-glass";
import { StatusBadge } from "@/components/glass/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ReceptionistDialog } from "@/components/dashboard/receptionist-dialog";

/** Backend list JOINs the clinic name into the response. */
type ReceptionistRow = Receptionist & { clinic_name?: string | null };

export default function ReceptionistsPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<ReceptionistRow | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<ReceptionistRow | null>(null);

  const receptionistsQuery = useQuery({
    queryKey: ["receptionists"],
    queryFn: () => api.listReceptionists(),
  });
  const receptionists = (receptionistsQuery.data?.items ?? []) as ReceptionistRow[];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["receptionists"] });
    void queryClient.invalidateQueries({ queryKey: ["analytics-overview"] });
  };

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "paused" }) =>
      api.updateReceptionist(id, { status }),
    onSuccess: (r) => {
      toast.success(
        r.status === "active"
          ? `“${r.name}” is now active and can take calls.`
          : `“${r.name}” paused — it will no longer take calls.`
      );
      invalidate();
    },
    onError: (error) => toast.error(mapApiError(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteReceptionist(id),
    onSuccess: () => {
      const name = deleteTarget?.name ?? "Receptionist";
      toast.success(`“${name}” deleted.`);
      setDeleteTarget(null);
      invalidate();
    },
    onError: (error) => {
      // Honest 409 handling: the backend only allows deleting drafts.
      if (error instanceof ApiError && error.status === 409) {
        toast.error("Active receptionists cannot be deleted — pause it instead.");
      } else {
        toast.error(mapApiError(error));
      }
      setDeleteTarget(null);
    },
  });

  const openCreate = () => {
    setEditTarget(null);
    setDialogOpen(true);
  };
  const openEdit = (r: ReceptionistRow) => {
    setEditTarget(r);
    setDialogOpen(true);
  };

  return (
    <>
      <PageHeader
        eyebrow="Workforce"
        title="AI receptionists"
        description="Your always-on multilingual front desk. Drafts are invisible to callers; activate a receptionist to let it answer for its clinic."
        actions={
          <Button className="min-h-11" onClick={openCreate}>
            <Plus className="size-4" aria-hidden="true" />
            New receptionist
          </Button>
        }
      />

      {receptionistsQuery.isPending ? (
        <div
          className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
          aria-busy="true"
          aria-live="polite"
        >
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonGlass key={i} className="h-48 w-full" />
          ))}
        </div>
      ) : receptionistsQuery.isError ? (
        <EmptyState
          icon={Bot}
          title="Could not load your receptionists"
          description={mapApiError(receptionistsQuery.error)}
          action={
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => void receptionistsQuery.refetch()}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              Retry
            </Button>
          }
        />
      ) : receptionists.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No AI receptionists yet"
          description="Create your first receptionist — pick a clinic, languages, a voice and the skills it should handle. It starts as a draft until you activate it."
          action={
            <Button className="min-h-11" onClick={openCreate}>
              <Plus className="size-4" aria-hidden="true" />
              Create receptionist
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {receptionists.map((r) => (
            <ReceptionistCard
              key={r.id}
              receptionist={r}
              statusPending={
                statusMutation.isPending &&
                statusMutation.variables?.id === r.id
              }
              onActivate={() => statusMutation.mutate({ id: r.id, status: "active" })}
              onPause={() => statusMutation.mutate({ id: r.id, status: "paused" })}
              onEdit={() => openEdit(r)}
              onDelete={() => setDeleteTarget(r)}
            />
          ))}
        </div>
      )}

      <ReceptionistDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditTarget(null);
        }}
        receptionist={editTarget}
      />

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Only draft receptionists can be deleted. This permanently removes the
              draft and its configuration — it cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 bg-destructive text-white hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
              }}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
              Delete draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ReceptionistCard({
  receptionist: r,
  statusPending,
  onActivate,
  onPause,
  onEdit,
  onDelete,
}: {
  receptionist: ReceptionistRow;
  statusPending: boolean;
  onActivate: () => void;
  onPause: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const langLabels = r.languages
    .map((code) => SUPPORTED_LANGUAGES.find((l) => l.code === code))
    .filter((l): l is (typeof SUPPORTED_LANGUAGES)[number] => Boolean(l));

  return (
    <GlassCard hoverLift className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-soft text-base font-semibold text-primary"
          >
            {initials(r.name)}
          </span>
          <div className="min-w-0">
            <p className="truncate font-semibold tracking-tight">{r.name}</p>
            <p className="truncate text-sm text-muted-foreground">
              {r.clinic_name ?? "Unassigned clinic"}
            </p>
          </div>
        </div>
        <StatusBadge status={r.status} />
      </div>

      <div className="mt-4 space-y-2.5 text-sm">
        <div className="flex flex-wrap gap-1.5">
          {langLabels.length > 0 ? (
            langLabels.map((l) => (
              <span
                key={l.code}
                title={l.label}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs",
                  l.code === r.primary_language
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border bg-muted text-muted-foreground"
                )}
              >
                {l.code.toUpperCase()}
                {l.code === r.primary_language ? " · primary" : ""}
              </span>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">No languages configured</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground" title={`Voice provider: ${r.voice_provider}`}>
          <Volume2 className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">
            voice <span className="font-medium text-foreground">{r.voice_id}</span> ·{" "}
            {r.speaking_speed.toFixed(1)}× speed
          </span>
        </div>
      </div>

      <div className="mt-auto flex items-center gap-2 pt-4">
        {r.status === "active" ? (
          <Button
            variant="outline"
            className="min-h-11 flex-1"
            onClick={onPause}
            disabled={statusPending}
          >
            {statusPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <PauseCircle className="size-4" aria-hidden="true" />
            )}
            Pause
          </Button>
        ) : (
          <Button className="min-h-11 flex-1" onClick={onActivate} disabled={statusPending}>
            {statusPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <PlayCircle className="size-4" aria-hidden="true" />
            )}
            {r.status === "paused" ? "Resume" : "Activate"}
          </Button>
        )}
        <Button variant="outline" className="min-h-11" onClick={onEdit} aria-label={`Edit ${r.name}`}>
          <Pencil className="size-4" aria-hidden="true" />
          Edit
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label={`More actions for ${r.name}`}
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem asChild>
              <Link href={`/voice-lab?receptionist=${r.id}`}>
                <FlaskConical className="size-4" aria-hidden="true" />
                Test in Voice Lab
              </Link>
            </DropdownMenuItem>
            {r.status === "draft" ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={onDelete}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete draft…
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </GlassCard>
  );
}
