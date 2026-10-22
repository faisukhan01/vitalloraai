import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * SkeletonGlass — loading placeholder on a glass surface. Compose several
 * with varying widths to suggest the content that is loading. Uses the
 * shared pulse animation and stays visible for reduced-motion users
 * (opacity-based, not movement-based).
 */
function SkeletonGlass({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "glass animate-pulse rounded-xl",
        className
      )}
      {...props}
    />
  );
}

/** A single skeleton line sized for text placeholders. */
function SkeletonGlassLine({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-md bg-foreground/10",
        className
      )}
      {...props}
    />
  );
}

export { SkeletonGlass, SkeletonGlassLine };
