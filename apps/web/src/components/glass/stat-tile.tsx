import * as React from "react";
import { TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { GlassCard } from "@/components/glass/glass-card";

type DeltaTone = "up" | "down" | "neutral";

export interface StatTileProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  /** Pre-formatted value (string or node) — the caller owns number formatting. */
  value: React.ReactNode;
  /** Optional change indicator, e.g. "+12%" — must come from real data. */
  delta?: string;
  /** Direction affects only the arrow/color, never the meaning. */
  deltaTone?: DeltaTone;
  icon?: LucideIcon;
  /** Small helper line under the label (e.g. "last 7 days"). */
  hint?: string;
}

const deltaToneClasses: Record<DeltaTone, string> = {
  up: "text-success",
  down: "text-destructive",
  neutral: "text-muted-foreground",
};

/**
 * StatTile — compact KPI surface for dashboard overviews. Glass background,
 * soft icon chip, tabular numerals. Displays only what callers pass in;
 * no fabricated values.
 */
function StatTile({
  label,
  value,
  delta,
  deltaTone = "neutral",
  icon: Icon,
  hint,
  className,
  ...props
}: StatTileProps) {
  const DeltaIcon = deltaTone === "down" ? TrendingDown : TrendingUp;
  return (
    <GlassCard hoverLift className={cn("p-4 sm:p-5", className)} {...props}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <div className="mt-1 truncate text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">
            {value}
          </div>
          {hint ? (
            <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
          ) : null}
        </div>
        {Icon ? (
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-primary"
          >
            <Icon className="size-5" />
          </span>
        ) : null}
      </div>
      {delta ? (
        <p
          className={cn(
            "mt-3 flex items-center gap-1 text-xs font-medium tabular-nums",
            deltaToneClasses[deltaTone]
          )}
        >
          {deltaTone !== "neutral" ? (
            <DeltaIcon className="size-3.5" aria-hidden="true" />
          ) : null}
          <span>{delta}</span>
        </p>
      ) : null}
    </GlassCard>
  );
}

export { StatTile };
