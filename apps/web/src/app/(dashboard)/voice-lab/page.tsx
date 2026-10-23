import { Suspense } from "react";
import { VoiceLabClient } from "./voice-lab-client";
import { SkeletonGlass } from "@/components/glass";

export const metadata = {
  title: "Voice Laboratory — VITALORA AI",
};

export default function VoiceLabPage() {
  return (
    <Suspense fallback={<SkeletonGlass className="h-[70vh]" />}>
      <VoiceLabClient />
    </Suspense>
  );
}
