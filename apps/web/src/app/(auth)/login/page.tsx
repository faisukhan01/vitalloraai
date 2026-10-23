import { Suspense } from "react";

import { SkeletonGlassLine } from "@/components/glass/skeleton-glass";
import { LoginForm } from "./login-form";

function LoginFormFallback() {
  return (
    <div className="space-y-7">
      <div className="space-y-2.5 text-center">
        <SkeletonGlassLine className="ml-auto h-8 w-44" />
        <SkeletonGlassLine className="ml-auto h-4 w-60" />
      </div>
      <div className="space-y-4">
        <div className="space-y-2">
          <SkeletonGlassLine className="h-4 w-20" />
          <SkeletonGlassLine className="h-11 w-full rounded-xl" />
        </div>
        <div className="space-y-2">
          <SkeletonGlassLine className="h-4 w-16" />
          <SkeletonGlassLine className="h-11 w-full rounded-xl" />
        </div>
        <SkeletonGlassLine className="h-11 w-full rounded-xl" />
      </div>
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
