"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { HeartPulse } from "lucide-react";

import { useAuthStore } from "@/stores/auth-store";

/**
 * AuthGate — mounts the session bootstrap and protects authenticated routes.
 *  - loading:       branded loading screen (real state, no fake data)
 *  - anonymous:     redirect to /login (preserving the intended path)
 *  - authenticated: render children
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const bootstrap = useAuthStore((s) => s.bootstrap);

  React.useEffect(() => {
    if (status === "loading") {
      void bootstrap();
    }
  }, [status, bootstrap]);

  React.useEffect(() => {
    if (status === "anonymous") {
      const here = window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(here)}`);
    }
  }, [status, router]);

  if (status !== "authenticated") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-screen flex-1 flex-col items-center justify-center gap-4 px-6"
      >
        <span className="glass flex size-16 items-center justify-center rounded-2xl shadow-[var(--shadow-glow-value)]">
          <HeartPulse
            className="size-8 animate-pulse text-primary"
            aria-hidden="true"
          />
        </span>
        <div className="text-center">
          <p className="font-semibold tracking-tight">VITALORA AI</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Preparing your workspace…
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
