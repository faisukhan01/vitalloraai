"use client";

import * as React from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  AudioLines,
  CalendarCheck2,
  PhoneIncoming,
  ShieldCheck,
} from "lucide-react";

import { GlassCard } from "@/components/glass/glass-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SUPPORTED_LANGUAGES } from "@vitalora/shared-types";

/** Deterministic waveform heights (SSR-safe — no Math.random). */
const WAVEFORM = [
  0.35, 0.62, 0.48, 0.85, 0.55, 0.72, 0.4, 0.95, 0.6, 0.78, 0.45, 0.88, 0.52,
  0.68, 0.38, 0.8, 0.58, 0.92, 0.5, 0.7, 0.42, 0.82, 0.64, 0.75, 0.48, 0.86,
  0.56, 0.66,
];

/**
 * Simulated live-call UI — a marketing mockup. Static content, clearly
 * labeled; makes no claim of being a live connection.
 */
function CallMock() {
  const reduceMotion = useReducedMotion();

  return (
    <GlassCard variant="strong" className="overflow-hidden">
      {/* Mock header */}
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-teal-700 text-white"
          >
            <AudioLines className="size-4.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              Front Desk Assistant
            </p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <PhoneIncoming className="size-3" aria-hidden="true" />
              Incoming call · 00:42
            </p>
          </div>
        </div>
        <Badge
          variant="outline"
          className="shrink-0 rounded-full border-warning/30 bg-warning/10 text-warning"
        >
          Simulated preview
        </Badge>
      </div>

      {/* Waveform */}
      <div
        className="flex h-16 items-center justify-center gap-[3px] border-b border-border/70 px-4 sm:h-20"
        aria-hidden="true"
      >
        {WAVEFORM.map((h, i) =>
          reduceMotion ? (
            <span
              key={i}
              className="w-1 rounded-full bg-primary/70"
              style={{ height: `${Math.round(h * 100)}%` }}
            />
          ) : (
            <motion.span
              key={i}
              className="w-1 rounded-full bg-primary/70"
              style={{ height: `${Math.round(h * 100)}%` }}
              animate={{ scaleY: [1, 0.45, 1.05, 0.7, 1], opacity: [0.7, 1, 0.8, 1, 0.7] }}
              transition={{
                duration: 1.6 + (i % 5) * 0.18,
                repeat: Infinity,
                ease: "easeInOut",
                delay: (i % 7) * 0.09,
              }}
            />
          )
        )}
      </div>

      {/* Transcript */}
      <div className="space-y-3 px-4 py-4 sm:px-5">
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-secondary px-3.5 py-2.5 text-sm text-secondary-foreground">
            Hi — I need to move my appointment with Dr. Ahmed to another day.
          </div>
        </div>
        <div className="flex justify-start">
          <div className="max-w-[90%] rounded-2xl rounded-bl-sm border border-primary/20 bg-primary/10 px-3.5 py-2.5 text-sm text-foreground">
            Of course. You&apos;re booked for Thursday at 4:20 PM. I can move
            you to <span className="font-medium">Friday 10:00 AM</span> or{" "}
            <span className="font-medium">Saturday 11:30 AM</span> — which works
            better?
          </div>
        </div>
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-secondary px-3.5 py-2.5 text-sm text-secondary-foreground">
            Friday morning is perfect.
          </div>
        </div>
        <div className="flex justify-start">
          <div className="max-w-[90%] rounded-2xl rounded-bl-sm border border-primary/20 bg-primary/10 px-3.5 py-2.5 text-sm text-foreground">
            Done — you&apos;re confirmed for Friday, 10:00 AM. I&apos;ve updated
            the clinic&apos;s calendar, so the slot is closed for other callers.
          </div>
        </div>
      </div>

      {/* Mock footer */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/70 px-4 py-3 sm:px-5">
        <span className="text-xs text-muted-foreground">Speaking:</span>
        {SUPPORTED_LANGUAGES.map((lang) => (
          <span
            key={lang.code}
            className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-xs text-muted-foreground"
          >
            {lang.label}
          </span>
        ))}
      </div>
    </GlassCard>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-28 sm:pt-32 lg:pt-36">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-10">
          {/* Copy */}
          <div className="max-w-2xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: "easeOut" }}
            >
              <Badge
                variant="outline"
                className="glass-subtle rounded-full px-3 py-1 text-xs font-medium text-foreground"
              >
                <ShieldCheck className="size-3.5 text-primary" aria-hidden="true" />
                Voice AI built for healthcare front desks
              </Badge>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.08, ease: "easeOut" }}
              className="mt-5 text-display-sm font-semibold text-foreground sm:text-display"
            >
              Your clinic&apos;s AI receptionist,{" "}
              <span className="bg-gradient-to-r from-teal-600 to-emerald-500 bg-clip-text text-transparent dark:from-teal-400 dark:to-emerald-400">
                fluent in every patient&apos;s language.
              </span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.16, ease: "easeOut" }}
              className="mt-5 text-base text-muted-foreground sm:text-lg"
            >
              VITALORA answers your phones in English, Urdu, Hindi and Arabic —
              books, reschedules and cancels appointments directly against your
              real schedule, prevents double-bookings, and hands over to your
              staff the moment a human is the right answer.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.24, ease: "easeOut" }}
              className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center"
            >
              <Button size="lg" asChild className="min-h-11 rounded-full px-6 shadow-[var(--shadow-glow-value)]">
                <Link href="/register">
                  Create your clinic workspace
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                asChild
                className="min-h-11 rounded-full px-6"
              >
                <Link href="/login">Sign in</Link>
              </Button>
            </motion.div>

            <motion.ul
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.34 }}
              className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground"
            >
              <li className="flex items-center gap-1.5">
                <CalendarCheck2 className="size-3.5 text-primary" aria-hidden="true" />
                Works against your clinic&apos;s real calendar
              </li>
              <li className="flex items-center gap-1.5">
                <ShieldCheck className="size-3.5 text-primary" aria-hidden="true" />
                Escalates to humans when needed
              </li>
              <li className="flex items-center gap-1.5">
                <AudioLines className="size-3.5 text-primary" aria-hidden="true" />
                Identifies itself as AI on every call
              </li>
            </motion.ul>
          </div>

          {/* Product mock */}
          <motion.div
            initial={{ opacity: 0, y: 28 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.2, ease: "easeOut" }}
          >
            <CallMock />
            <p className="mt-3 text-center text-xs text-muted-foreground">
              Illustrative preview of the live-call view. Not a live
              connection — real calls appear in your Call History.
            </p>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
