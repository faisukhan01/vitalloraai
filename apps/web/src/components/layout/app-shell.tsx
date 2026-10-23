"use client";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { MobileTopbar } from "@/components/layout/mobile-topbar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

/**
 * AppShell — the authenticated workspace frame:
 * glass sidebar (Sheet on mobile) + sticky topbar + content column.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <MobileTopbar />
        <div className="flex-1 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
          <div className="mx-auto w-full max-w-6xl space-y-6">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
