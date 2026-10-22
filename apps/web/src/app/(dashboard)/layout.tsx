import { AuthGate } from "@/components/layout/auth-gate";
import { AppShell } from "@/components/layout/app-shell";
import { QueryProvider } from "@/components/providers/query-provider";

/**
 * Dashboard section layout — every authenticated route renders inside the
 * AuthGate (session bootstrap + redirect), the AppShell (glass sidebar,
 * topbar, content column) and the QueryProvider (TanStack Query cache for
 * server-state data screens).
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGate>
      <QueryProvider>
        <AppShell>{children}</AppShell>
      </QueryProvider>
    </AuthGate>
  );
}
