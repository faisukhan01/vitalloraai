import { Suspense } from "react";

import { GlassCard } from "@/components/glass/glass-card";
import { SkeletonGlassLine } from "@/components/glass/skeleton-glass";
import { LoginForm } from "./login-form";

function LoginFormFallback() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <SkeletonGlassLine className="h-7 w-56" />
        <SkeletonGlassLine className="h-4 w-72" />
      </div>
      <GlassCard variant="strong" className="space-y-5 p-6 sm:p-8">
        <div className="space-y-2">
          <SkeletonGlassLine className="h-4 w-24" />
          <SkeletonGlassLine className="h-11 w-full" />
        </div>
        <div className="space-y-2">
          <SkeletonGlassLine className="h-4 w-20" />
          <SkeletonGlassLine className="h-11 w-full" />
        </div>
        <SkeletonGlassLine className="h-11 w-full rounded-full" />
      </GlassCard>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFormFallback />}>
      <LoginForm />
    </Suspense>
  );
}
