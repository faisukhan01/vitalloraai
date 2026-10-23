import { HeartPulse } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * BrandMark — the VITALORA AI logo lockup (teal gradient tile + wordmark).
 * Pure server component; reused by the navbar, footer, sidebar and auth pages.
 */
export function BrandMark({
  className,
  iconClassName,
  wordmarkClassName,
  size = "md",
}: {
  className?: string;
  iconClassName?: string;
  wordmarkClassName?: string;
  size?: "sm" | "md" | "lg";
}) {
  const tile = size === "lg" ? "size-10 rounded-xl" : size === "sm" ? "size-7 rounded-md" : "size-8 rounded-lg";
  const icon = size === "lg" ? "size-6" : size === "sm" ? "size-4" : "size-5";
  const word = size === "lg" ? "text-lg" : size === "sm" ? "text-sm" : "text-base";

  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        aria-hidden="true"
        className={cn(
          "flex shrink-0 items-center justify-center bg-gradient-to-br from-teal-500 to-teal-700 text-white shadow-[var(--shadow-glow-value)]",
          tile
        )}
      >
        <HeartPulse className={icon} />
      </span>
      <span
        className={cn("font-semibold tracking-tight text-foreground", word, wordmarkClassName)}
      >
        Vitalora AI
      </span>
    </span>
  );
}
