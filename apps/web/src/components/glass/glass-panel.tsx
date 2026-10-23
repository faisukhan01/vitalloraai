import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * GlassPanel — a section-level glass container for grouping content
 * (form shells, settings sections, dashboard blocks). Less decorative than
 * GlassCard; use it as the structural wrapper, GlassCard inside it.
 */
function GlassPanel({
  className,
  as: Comp = "section",
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: "section" | "div" | "aside" }) {
  return (
    <Comp
      data-slot="glass-panel"
      className={cn("glass glass-sheen rounded-2xl", className)}
      {...props}
    />
  );
}

export { GlassPanel };
