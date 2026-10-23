"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface PaginationFooterProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Name of the listed entity, e.g. "documents". */
  itemLabel?: string;
  className?: string;
}

/**
 * PaginationFooter — "Showing X–Y of Z" + Prev/Next with 44px touch targets.
 * Purely derived from the backend's Paginated response; no invented state.
 */
export function PaginationFooter({
  page,
  pageSize,
  total,
  onPageChange,
  itemLabel = "items",
  className,
}: PaginationFooterProps) {
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <nav
      aria-label={`Pagination for ${itemLabel}`}
      className={cn(
        "flex flex-col-reverse items-center justify-between gap-3 sm:flex-row",
        className
      )}
    >
      <p
        aria-live="polite"
        className="text-sm text-muted-foreground tabular-nums"
      >
        {total === 0
          ? `No ${itemLabel} to show`
          : `Showing ${from}–${to} of ${total} ${itemLabel}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 gap-1 sm:min-h-9"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Prev
        </Button>
        <span className="min-w-16 text-center text-sm text-muted-foreground tabular-nums">
          Page {page} / {pageCount}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 gap-1 sm:min-h-9"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
        >
          Next
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
