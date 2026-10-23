"use client";

import {
  BarChart3,
  Building2,
  CalendarCheck2,
  BookOpenCheck,
  Headset,
  Languages,
  type LucideIcon,
} from "lucide-react";

import { GlassCard } from "@/components/glass/glass-card";
import { LandingSection, Reveal } from "@/components/landing/reveal";

interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
}

const FEATURES: Feature[] = [
  {
    icon: Languages,
    title: "Multilingual voice AI",
    description:
      "Speaks with patients in English, Urdu, Hindi and Arabic, detecting and switching language naturally within the conversation.",
  },
  {
    icon: CalendarCheck2,
    title: "Appointment booking with conflict prevention",
    description:
      "Books, reschedules and cancels against your real provider calendars. Double-bookings are prevented at the database level — not by good intentions.",
  },
  {
    icon: BookOpenCheck,
    title: "Knowledge-grounded answers",
    description:
      "Answers about your services, preparation instructions and policies come from your own knowledge base — full-text retrieval over documents you control.",
  },
  {
    icon: Headset,
    title: "Human escalation & safety",
    description:
      "Emergencies, clinical questions and frustrated callers are handed to your staff with a callback request and the full conversation context.",
  },
  {
    icon: BarChart3,
    title: "Analytics from real call data",
    description:
      "Every session is logged: volumes, outcomes, languages used and escalations — so you can see exactly what the receptionist handled.",
  },
  {
    icon: Building2,
    title: "Enterprise-ready multi-clinic tenancy",
    description:
      "Organizations, clinics, providers and role-based access are first-class. Every query is scoped to your organization — tenant isolation is enforced, not promised.",
  },
];

export function Features() {
  return (
    <LandingSection
      id="features"
      eyebrow="Capabilities"
      title="Everything a great front desk does — on every call"
      description="VITALORA is designed around the real work of a clinic receptionist, with the controls an enterprise expects."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature, i) => (
          <Reveal key={feature.title} delay={i * 0.06}>
            <GlassCard hoverLift className="h-full p-5 sm:p-6">
              <span
                aria-hidden="true"
                className="flex size-11 items-center justify-center rounded-xl bg-brand-soft text-primary"
              >
                <feature.icon className="size-5.5" />
              </span>
              <h3 className="mt-4 font-semibold tracking-tight text-foreground">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {feature.description}
              </p>
            </GlassCard>
          </Reveal>
        ))}
      </div>
    </LandingSection>
  );
}
