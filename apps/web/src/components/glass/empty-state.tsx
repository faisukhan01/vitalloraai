import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Primary call-to-action (usually a Button). */
  action?: React.ReactNode;
}

/**
 * EmptyState — honest placeholder for lists with no data yet.
 * Never invents content; describes what will appear here.
 */
function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        "glass-subtle flex flex-col items-center justify-center gap-3 rounded-xl border-dashed px-6 py-12 text-center",
        className
      )}
      {...props}
    >
      {Icon ? (
        <span
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-full bg-brand-soft text-primary"
        >
          <Icon className="size-6" />
        </span>
      ) : null}
      <div className="space-y-1">
        <p className="font-medium text-foreground">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export { EmptyState };
