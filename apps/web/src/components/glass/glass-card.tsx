import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * GlassCard — the core glassmorphism surface of the VITALORA design system.
 *
 * Variants:
 *  - default: standard glass panel (cards, content blocks)
 *  - strong:  denser glass for hero/primary surfaces
 *  - subtle:  lightest glass for nested or quiet containers
 *
 * `hoverLift` adds a gentle translate + shadow raise on hover. It is applied
 * only via `motion-safe` utilities so it respects prefers-reduced-motion.
 */
const glassCardVariants = cva("", {
  variants: {
    variant: {
      default: "glass",
      strong: "glass-strong",
      subtle: "glass-subtle",
    },
    lift: {
      true: "motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-out motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-[var(--shadow-lift-value)]",
      false: "",
    },
  },
  defaultVariants: {
    variant: "default",
    lift: false,
  },
});

export interface GlassCardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof glassCardVariants> {
  /** Adds a subtle hover lift (respects prefers-reduced-motion). */
  hoverLift?: boolean;
}

function GlassCard({ className, variant, hoverLift, ...props }: GlassCardProps) {
  return (
    <div
      data-slot="glass-card"
      className={cn(
        "rounded-xl",
        glassCardVariants({ variant, lift: hoverLift }),
        className
      )}
      {...props}
    />
  );
}

export { GlassCard, glassCardVariants };
