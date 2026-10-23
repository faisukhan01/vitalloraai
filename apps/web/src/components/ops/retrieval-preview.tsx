"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ScanSearch } from "lucide-react";

import { api } from "@vitalora/api-client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GlassCard } from "@/components/glass/glass-card";
import { SkeletonGlassLine } from "@/components/glass/skeleton-glass";
import { ErrorState } from "@/components/ops/error-state";
import { excerptAround, formatScore } from "@/components/ops/helpers";
import { mapApiError } from "@/lib/utils-api";

/**
 * RetrievalPreview — proves the knowledge base actually retrieves. Sends the
 * question to the real FTS5 search endpoint and shows the exact chunks the AI
 * receptionist would ground its answer on, with bm25 scores.
 */
export function RetrievalPreview() {
  const [question, setQuestion] = React.useState("");
  const [submittedQ, setSubmittedQ] = React.useState<string | null>(null);

  const searchQuery = useQuery({
    queryKey: ["knowledge", "search", submittedQ],
    queryFn: () => api.searchKnowledge(submittedQ as string, 5),
    enabled: submittedQ !== null && submittedQ.trim().length > 0,
  });

  function runSearch(event: React.FormEvent) {
    event.preventDefault();
    const q = question.trim();
    if (!q) return;
    setSubmittedQ(q);
  }

  const busy = searchQuery.isFetching;

  return (
    <GlassCard className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-primary"
        >
          <ScanSearch className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold tracking-tight text-foreground">
            Retrieval preview
          </h2>
          <p className="text-sm text-muted-foreground">
            What the AI receptionist can see — the top chunks returned for a
            caller&apos;s question, exactly as retrieval serves them.
          </p>
        </div>
      </div>

      <form onSubmit={runSearch} className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="retrieval-question" className="sr-only">
          Test question
        </label>
        <Input
          id="retrieval-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask as a patient would, e.g. “Do you charge for missed appointments?”"
          className="min-h-11 flex-1"
          maxLength={300}
          autoComplete="off"
        />
        <Button
          type="submit"
          className="min-h-11 shadow-[var(--shadow-glow-value)]"
          disabled={busy || question.trim().length === 0}
        >
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Searching…
            </>
          ) : (
            "Test retrieval"
          )}
        </Button>
      </form>

      {submittedQ ? (
        <div className="mt-5 space-y-3">
          {searchQuery.isError ? (
            <ErrorState
              context="retrieval results"
              message={mapApiError(searchQuery.error)}
              onRetry={() => searchQuery.refetch()}
              retrying={searchQuery.isFetching}
            />
          ) : searchQuery.isLoading || busy ? (
            <div aria-hidden="true" className="space-y-2">
              <SkeletonGlassLine className="h-4 w-3/4" />
              <SkeletonGlassLine className="h-4 w-full" />
              <SkeletonGlassLine className="h-4 w-5/6" />
            </div>
          ) : (searchQuery.data?.results.length ?? 0) === 0 ? (
            <p className="rounded-lg border border-dashed border-warning/40 bg-warning/5 px-4 py-3 text-sm text-foreground">
              No chunks matched. The receptionist would not find approved
              information for this question — add or edit a document to cover it.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Top {searchQuery.data?.results.length} chunk
                {(searchQuery.data?.results.length ?? 0) === 1 ? "" : "s"} for
                &ldquo;{submittedQ}&rdquo; — lower bm25 score = stronger match.
              </p>
              <ol className="space-y-3">
                {searchQuery.data?.results.map((hit, index) => (
                  <li
                    key={hit.chunk_id}
                    className="glass-subtle rounded-xl p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                        <span
                          aria-hidden="true"
                          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary"
                        >
                          {index + 1}
                        </span>
                        <span className="truncate">{hit.document_title}</span>
                      </p>
                      <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs font-medium tabular-nums text-primary">
                        score {formatScore(hit.score)}
                      </span>
                    </div>
                    <blockquote className="mt-2 border-l-2 border-primary/30 pl-3 text-sm leading-relaxed text-muted-foreground">
                      {excerptAround(hit.content, submittedQ)}
                    </blockquote>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      ) : null}
    </GlassCard>
  );
}
