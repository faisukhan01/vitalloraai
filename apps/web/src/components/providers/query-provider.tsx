"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * QueryProvider — mounts TanStack Query for the dashboard area.
 *
 * The client is created in `useState` so server renders and client renders
 * build their own instance (no cross-request state leakage), with conservative
 * defaults: operational data is stale after 30s, refetching happens on
 * mount/remount and filters, and failed queries retry once so honest error
 * states appear fast.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
          mutations: {
            retry: 0,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
