"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  Link2,
  MessageCircleQuestion,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import type { LucideIcon } from "lucide-react";

import { api } from "@vitalora/api-client";
import type { KnowledgeDocument } from "@vitalora/shared-types";

import { PageHeader } from "@/components/glass/page-header";
import { GlassCard } from "@/components/glass/glass-card";
import { EmptyState } from "@/components/glass/empty-state";
import { StatusBadge } from "@/components/glass/status-badge";
import { SkeletonGlass, SkeletonGlassLine } from "@/components/glass/skeleton-glass";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { PaginationFooter } from "@/components/ops/pagination-footer";
import { ErrorState } from "@/components/ops/error-state";
import { KnowledgeDocumentDialog } from "@/components/ops/knowledge-document-dialog";
import { RetrievalPreview } from "@/components/ops/retrieval-preview";
import { truncate } from "@/components/ops/helpers";
import { formatDate, mapApiError } from "@/lib/utils-api";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useAuthStore } from "@/stores/auth-store";

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "indexed", label: "Indexed" },
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "failed", label: "Failed" },
  { value: "inactive", label: "Inactive" },
];

const SOURCE_TYPE_ICONS: Record<KnowledgeDocument["source_type"], LucideIcon> = {
  manual: NotebookPen,
  faq: MessageCircleQuestion,
  document: FileText,
  url: Link2,
};

export default function KnowledgePage() {
  const permissions = useAuthStore((s) => s.permissions);
  const canWrite = permissions.includes("knowledge:write");
  const queryClient = useQueryClient();

  // ── Filters ────────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = React.useState("");
  const search = useDebouncedValue(searchInput.trim());
  const [status, setStatus] = React.useState("all");
  const [page, setPage] = React.useState(1);

  React.useEffect(() => {
    setPage(1);
  }, [search, status]);

  // ── List query ─────────────────────────────────────────────────────────
  const listQuery = useQuery({
    queryKey: ["knowledge", "documents", { search, status, page }],
    queryFn: () =>
      api.listKnowledgeDocuments({
        search: search || undefined,
        status: status === "all" ? undefined : status,
        page,
      }),
  });

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const pageSize = listQuery.data?.page_size ?? 25;
  const isFiltered = search.length > 0 || status !== "all";

  function invalidateKnowledge() {
    void queryClient.invalidateQueries({ queryKey: ["knowledge", "documents"] });
    void queryClient.invalidateQueries({ queryKey: ["knowledge", "search"] });
  }

  // ── Row mutations ──────────────────────────────────────────────────────
  const reindexMutation = useMutation({
    mutationFn: (id: string) => api.reindexKnowledgeDocument(id),
    onSuccess: (doc) => {
      toast.success(`Reindexed “${doc.title}” into ${doc.chunk_count} chunks.`);
      invalidateKnowledge();
    },
    onError: (err) => toast.error(mapApiError(err)),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.updateKnowledgeDocument(id, { status: active ? "indexed" : "inactive" }),
    onSuccess: (doc) => {
      toast.success(
        doc.status === "inactive"
          ? `“${doc.title}” deactivated — the receptionist can no longer use it.`
          : `“${doc.title}” reactivated and available for retrieval.`
      );
      invalidateKnowledge();
    },
    onError: (err) => toast.error(mapApiError(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteKnowledgeDocument(id),
    onSuccess: () => {
      toast.success("Knowledge document deleted.");
      setDeleteTarget(null);
      invalidateKnowledge();
      // Step back if we removed the last row of a later page.
      if (items.length === 1 && page > 1) setPage((p) => p - 1);
    },
    onError: (err) => toast.error(mapApiError(err)),
  });

  // ── Dialog state ───────────────────────────────────────────────────────
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<KnowledgeDocument | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<KnowledgeDocument | null>(null);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(doc: KnowledgeDocument) {
    setEditing(doc);
    setDialogOpen(true);
  }

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Knowledge base"
        description="The approved source of truth for the AI receptionist. Callers are answered only from the documents indexed here."
        actions={
          canWrite ? (
            <Button
              onClick={openCreate}
              className="min-h-11 shadow-[var(--shadow-glow-value)]"
            >
              <Plus className="size-4" aria-hidden="true" />
              Add knowledge
            </Button>
          ) : null
        }
      />

      {/* Filters */}
      <GlassCard className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <label htmlFor="knowledge-search" className="sr-only">
            Search documents by title
          </label>
          <Input
            id="knowledge-search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by title…"
            className="min-h-11 pl-9"
            autoComplete="off"
          />
        </div>
        <div className="sm:w-52">
          <label htmlFor="knowledge-status" className="sr-only">
            Filter by status
          </label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="knowledge-status" className="min-h-11 w-full">
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
      </GlassCard>

      {/* Document list */}
      {listQuery.isLoading ? (
        <div aria-hidden="true" className="space-y-3">
          {[0, 1, 2].map((i) => (
            <SkeletonGlass key={i} className="h-24 w-full p-4">
              <SkeletonGlassLine className="h-4 w-1/3" />
              <SkeletonGlassLine className="mt-3 h-3 w-1/2" />
            </SkeletonGlass>
          ))}
        </div>
      ) : listQuery.isError ? (
        <ErrorState
          context="knowledge documents"
          message={mapApiError(listQuery.error)}
          onRetry={() => listQuery.refetch()}
          retrying={listQuery.isFetching}
        />
      ) : items.length === 0 ? (
        isFiltered ? (
          <EmptyState
            icon={Search}
            title="No documents match"
            description="No knowledge documents match the current search and status filters. Adjust or clear them to see more."
            action={
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  setSearchInput("");
                  setStatus("all");
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={FileText}
            title="Your knowledge base is empty"
            description="The AI receptionist answers only from what you approve here. Add FAQs, policies and clinic information — every caller question is matched against these documents, and nothing outside them is used."
            action={
              canWrite ? (
                <Button className="min-h-11" onClick={openCreate}>
                  <Plus className="size-4" aria-hidden="true" />
                  Add your first document
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <div className="space-y-3">
          <ul className="space-y-3" aria-label="Knowledge documents">
            {items.map((doc) => {
              const SourceIcon = SOURCE_TYPE_ICONS[doc.source_type] ?? FileText;
              const reindexing =
                reindexMutation.isPending && reindexMutation.variables === doc.id;
              const toggling =
                toggleMutation.isPending && toggleMutation.variables?.id === doc.id;
              const deleting =
                deleteMutation.isPending && deleteMutation.variables === doc.id;
              const isInactive = doc.status === "inactive";

              return (
                <li key={doc.id}>
                  <GlassCard
                    variant={isInactive ? "subtle" : "default"}
                    className="p-4 sm:p-5"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            <SourceIcon className="size-3.5" aria-hidden="true" />
                            {doc.source_type}
                          </span>
                          <StatusBadge status={doc.status} />
                        </div>
                        <h3
                          className={
                            "mt-2 truncate font-semibold tracking-tight " +
                            (isInactive ? "text-muted-foreground" : "text-foreground")
                          }
                        >
                          {doc.title}
                        </h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {truncate(doc.content_text, 140) || "No content"}
                        </p>
                        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span className="tabular-nums">
                            {doc.chunk_count} chunk{doc.chunk_count === 1 ? "" : "s"}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>Updated {formatDate(doc.updated_at)}</span>
                          {doc.error ? (
                            <span className="text-destructive">
                              Last error: {truncate(doc.error, 80)}
                            </span>
                          ) : null}
                        </p>
                      </div>

                      {canWrite ? (
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="min-h-11 gap-1.5 sm:min-h-9"
                            onClick={() => reindexMutation.mutate(doc.id)}
                            disabled={reindexing || deleting}
                            aria-label={`Reindex ${doc.title}`}
                          >
                            <RefreshCw
                              className={
                                "size-4 " + (reindexing ? "animate-spin" : "")
                              }
                              aria-hidden="true"
                            />
                            Reindex
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="outline"
                                size="icon"
                                className="size-11 sm:size-9"
                                aria-label={`Actions for ${doc.title}`}
                                disabled={reindexing || deleting || toggling}
                              >
                                <MoreHorizontal className="size-4" aria-hidden="true" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              <DropdownMenuItem onSelect={() => openEdit(doc)}>
                                <Pencil className="size-4" aria-hidden="true" />
                                View / Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() =>
                                  toggleMutation.mutate({
                                    id: doc.id,
                                    active: isInactive,
                                  })
                                }
                              >
                                <XCircle className="size-4" aria-hidden="true" />
                                {isInactive ? "Activate" : "Deactivate"}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setDeleteTarget(doc)}
                              >
                                <Trash2 className="size-4" aria-hidden="true" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      ) : null}
                    </div>
                  </GlassCard>
                </li>
              );
            })}
          </ul>

          <PaginationFooter
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            itemLabel="documents"
          />
        </div>
      )}

      {/* Retrieval preview — proves what the receptionist can retrieve */}
      <RetrievalPreview />

      {/* Create / edit dialog */}
      <KnowledgeDocumentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        document={editing}
        onSaved={(saved, mode) => {
          if (mode === "create") {
            toast.success(
              `“${saved.title}” indexed into ${saved.chunk_count} chunks.`
            );
          } else {
            // Content changes are re-chunked and re-indexed by the backend.
            toast.success(`“${saved.title}” saved.`);
          }
          invalidateKnowledge();
        }}
      />

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.title}” and its {deleteTarget?.chunk_count} chunk
              {deleteTarget?.chunk_count === 1 ? "" : "s"} will be permanently
              removed. The receptionist will no longer be able to answer from
              this content. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">
              Keep document
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 bg-destructive text-white hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
              }}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
