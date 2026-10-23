"use client";

import { Check, Info } from "lucide-react";

import { GlassCard } from "@/components/glass/glass-card";
import { LandingSection, Reveal } from "@/components/landing/reveal";

const PRACTICES = [
  {
    title: "Encrypted in transit",
    description:
      "All traffic — API calls and live voice sessions — travels over TLS.",
  },
  {
    title: "Minimal PII",
    description:
      "We store only what booking requires: name, contact detail, and the appointment itself. No health records leave your systems.",
  },
  {
    title: "Configurable retention",
    description:
      "Transcript and audit retention are configured per organization — your data is kept only as long as you decide.",
  },
  {
    title: "Tenant isolation",
    description:
      "Every database query is scoped to your organization. One tenant's data is never reachable from another's.",
  },
  {
    title: "Full audit trail",
    description:
      "Sensitive actions — logins, changes to receptionists, callback handling — are written to an immutable audit log.",
  },
  {
    title: "AI disclosure",
    description:
      "The receptionist identifies itself as an AI assistant at the start of every call, and never claims to be a clinician.",
  },
];

export function Security() {
  return (
    <LandingSection
      id="security"
      eyebrow="Security & privacy"
      title="Designed for healthcare privacy — stated plainly"
      description="Here is exactly what VITALORA does today, and what it does not claim."
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {PRACTICES.map((item, i) => (
          <Reveal key={item.title} delay={i * 0.06}>
            <GlassCard className="flex h-full items-start gap-3 p-4 sm:p-5">
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-success/10 text-success"
              >
                <Check className="size-3.5" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  {item.title}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {item.description}
                </p>
              </div>
            </GlassCard>
          </Reveal>
        ))}
      </div>

      <Reveal delay={0.15}>
        <GlassCard
          variant="subtle"
          className="mt-6 flex items-start gap-3 border-warning/30 p-4 sm:p-5"
        >
          <Info className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Compliance status — no overclaiming
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              VITALORA is <span className="font-medium text-foreground">not</span>{" "}
              claimed to be HIPAA-compliant at this stage. We follow
              healthcare-privacy practices by design (encryption in transit,
              minimal PII, configurable retention, tenant isolation) and will
              publish our compliance status here when it is formally assessed.
            </p>
          </div>
        </GlassCard>
      </Reveal>

    </LandingSection>
  );
}
