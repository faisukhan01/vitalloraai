"use client";

import { CalendarClock, PhoneCall, Settings2 } from "lucide-react";

import { GlassCard } from "@/components/glass/glass-card";
import { LandingSection, Reveal } from "@/components/landing/reveal";

const STEPS = [
  {
    icon: Settings2,
    step: "1",
    title: "Connect your clinic",
    description:
      "Add your clinic, providers, services and opening hours. Your real schedule — not a parallel copy — becomes the source of truth.",
  },
  {
    icon: PhoneCall,
    step: "2",
    title: "Shape your receptionist",
    description:
      "Choose languages, voice and persona, set the greeting, and add the documents your callers ask about: services, policies, preparation instructions.",
  },
  {
    icon: CalendarClock,
    step: "3",
    title: "Go live",
    description:
      "The receptionist answers calls, books with conflict prevention, requests callbacks for your staff, and logs every conversation for review.",
  },
];

export function HowItWorks() {
  return (
    <LandingSection
      id="how-it-works"
      eyebrow="How it works"
      title="Live in three steps"
      description="No telephony rip-and-replace. Configure your clinic once and put the AI on your existing phone flow."
    >
      <ol className="grid gap-4 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.step}>
            <Reveal delay={i * 0.1} className="h-full">
              <GlassCard hoverLift className="relative h-full p-5 sm:p-6">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-teal-700 text-sm font-semibold text-white shadow-[var(--shadow-glow-value)]"
                  >
                    {step.step}
                  </span>
                  <step.icon
                    className="size-5 text-muted-foreground"
                    aria-hidden="true"
                  />
                </div>
                <h3 className="mt-4 font-semibold tracking-tight text-foreground">
                  {step.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {step.description}
                </p>
              </GlassCard>
            </Reveal>
          </li>
        ))}
      </ol>
    </LandingSection>
  );
}
