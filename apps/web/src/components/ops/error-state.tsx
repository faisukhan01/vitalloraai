"use client";

import * as React from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { GlassCard } from "@/components/glass/glass-card";
import { cn } from "@/lib/utils";

export interface ErrorStateProps {
  /** Human-friendly message (usually from mapApiError). */
  message: string;
  /** Where it happened, e.g. "knowledge documents". */
  context?: string;
  onRetry?: () => void;
  /** Retry in progress — disables the button and shows a spinner. */
  retrying?: boolean;
  className?: string;
}

/**
 * ErrorState — honest failure surface for data screens. Shows the mapped
 * error message and, when the caller can act on it, a real retry button.
 * Nothing is hidden behind a fake "loading" state.
 */
export function ErrorState({
  message,
  context,
  onRetry,
  retrying,
  className,
}: ErrorStateProps) {
  return (
    <GlassCard
      variant="subtle"
      role="alert"
      className={cn("flex flex-col items-center gap-3 px-6 py-10 text-center", className)}
    >
      <span
        aria-hidden="true"
        className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"
      >
        <TriangleAlert className="size-6" />
      </span>
      <div className="space-y-1">
        <p className="font-medium text-foreground">
          {context ? `Couldn't load ${context}` : "Something went wrong"}
        </p>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">{message}</p>
      </div>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 gap-2 sm:min-h-9"
          onClick={onRetry}
          disabled={retrying}
        >
          <RotateCcw
            className={cn("size-4", retrying && "animate-spin")}
            aria-hidden="true"
          />
          Try again
        </Button>
      ) : null}
    </GlassCard>
  );
}
