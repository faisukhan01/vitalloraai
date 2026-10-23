"use client";

import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";

import { GlassCard } from "@/components/glass/glass-card";
import { LandingSection, Reveal } from "@/components/landing/reveal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Pricing — three tiers with capability-based copy. No invented prices,
 * customer counts or testimonials: numbers ship when the business ships them.
 */
const TIERS = [
  {
    name: "Starter",
    summary: "For a single clinic proving the workflow.",
    price: "Simple monthly subscription",
    features: [
      "1 clinic, up to 2 AI receptionists",
      "Multilingual voice answering & booking",
      "Your knowledge base for grounded answers",
      "Call history & basic analytics",
      "Email support",
    ],
    cta: "Start with a trial workspace",
    href: "/register",
    highlighted: false,
  },
  {
    name: "Growth",
    summary: "For busy multi-provider clinics.",
    price: "Scales with answered minutes",
    features: [
      "Everything in Starter",
      "Multiple providers, services & rooms",
      "Callback workflows for your staff",
      "Advanced analytics & exports",
      "Priority support",
    ],
    cta: "Create your workspace",
    href: "/register",
    highlighted: true,
  },
  {
    name: "Enterprise",
    summary: "For hospital groups and multi-clinic organizations.",
    price: "Custom contract & SLA",
    features: [
      "Everything in Growth",
      "Unlimited clinics under one organization",
      "Configurable retention policies",
      "Onboarding, training & review of configs",
      "Contractual support agreement",
    ],
    cta: "Talk to us",
    href: "mailto:hello@vitalora.ai?subject=VITALORA%20Enterprise",
    highlighted: false,
  },
];

export function Pricing() {
  return (
    <LandingSection
      id="pricing"
      eyebrow="Pricing"
      title="Straightforward tiers, honest terms"
      description="Start with a trial workspace — you only move to a paid tier when VITALORA is answering real calls for your clinic. Final pricing is confirmed with our team."
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {TIERS.map((tier, i) => (
          <Reveal key={tier.name} delay={i * 0.08} className="h-full">
            <GlassCard
              variant={tier.highlighted ? "strong" : "default"}
              className={cn(
                "relative flex h-full flex-col p-5 sm:p-6",
                tier.highlighted && "ring-1 ring-primary/40"
              )}
            >
              {tier.highlighted ? (
                <span className="absolute -top-2.5 left-5 rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground shadow-[var(--shadow-glow-value)]">
                  Recommended
                </span>
              ) : null}
              <h3 className="text-lg font-semibold tracking-tight text-foreground">
                {tier.name}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">{tier.summary}</p>
              <p className="mt-4 text-sm font-medium text-foreground">
                {tier.price}
              </p>
              <ul className="mt-5 flex-1 space-y-2.5">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2.5 text-sm">
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-success"
                      aria-hidden="true"
                    />
                    <span className="text-muted-foreground">{feature}</span>
                  </li>
                ))}
              </ul>
              <Button
                asChild
                variant={tier.highlighted ? "default" : "outline"}
                className="mt-6 min-h-11 w-full rounded-full"
              >
                <Link href={tier.href}>
                  {tier.cta}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </Button>
            </GlassCard>
          </Reveal>
        ))}
      </div>
      <p className="mt-6 text-center text-xs text-muted-foreground">
        All tiers include tenant isolation, the audit log, and an AI
        receptionist that identifies itself as AI. No customer counts or
        testimonials are shown here because none are published yet.
      </p>
    </LandingSection>
  );
}
