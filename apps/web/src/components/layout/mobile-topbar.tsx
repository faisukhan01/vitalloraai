"use client";

import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { useAuthStore } from "@/stores/auth-store";

/**
 * MobileTopbar — sticky glass bar above the workspace content. The trigger
 * opens the sidebar as a Sheet on mobile and collapses it to the rail on
 * desktop; the organization name anchors context while scrolling.
 */
export function MobileTopbar() {
  const organization = useAuthStore((s) => s.organization);

  return (
    <header className="glass sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3 sm:px-4">
      <SidebarTrigger aria-label="Toggle sidebar" className="size-9" />
      <Separator orientation="vertical" className="!h-5" />
      <span className="truncate text-sm font-medium text-foreground">
        {organization?.name ?? "Workspace"}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
      </div>
    </header>
  );
}
