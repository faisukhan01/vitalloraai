"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { CalendarCheck2, Headset, Languages, ShieldCheck } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { IframeNotice } from "@/components/layout/iframe-notice";

const PANEL_STATS = [
  {
    icon: Languages,
    value: "EN · UR · HI · AR",
    label: "Speaks every patient's language",
  },
  {
    icon: CalendarCheck2,
    value: "Live schedule",
    label: "Books against your real calendar",
  },
  {
    icon: Headset,
    value: "Human handoff",
    label: "Escalates the moment it should",
  },
];

const easeOut = [0.21, 0.47, 0.32, 0.98] as const;

/**
 * Auth layout — premium split screen.
 * Left: immersive brand panel (animated aurora, dot texture, product stats).
 * Right: quiet, focused form column so the glass card reads clearly in both themes.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <div className="flex min-h-screen flex-1">
      {/* ── Brand panel — always-dark gradient for depth ─────────────────── */}
      <aside className="relative hidden w-[46%] max-w-2xl flex-col justify-between overflow-hidden bg-gradient-to-br from-stone-950 via-teal-950 to-stone-900 p-10 text-white lg:flex xl:p-14">
        {/* Dot texture */}
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[0.16] [background-image:radial-gradient(rgba(255,255,255,0.55)_1px,transparent_1px)] [background-size:22px_22px]"
        />
        {/* Animated aurora glows */}
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-teal-500/25 blur-3xl"
          animate={reduceMotion ? undefined : { x: [0, -36, 0], y: [0, 28, 0] }}
          transition={reduceMotion ? undefined : { duration: 16, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 -left-20 size-[26rem] rounded-full bg-emerald-500/15 blur-3xl"
          animate={reduceMotion ? undefined : { x: [0, 32, 0], y: [0, -24, 0] }}
          transition={reduceMotion ? undefined : { duration: 20, repeat: Infinity, ease: "easeInOut" }}
        />
        {/* Thin light seam */}
        <div
          aria-hidden="true"
          className="absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-teal-300/30 to-transparent"
        />

        <motion.div
          className="relative"
          initial={reduceMotion ? false : { opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: easeOut }}
        >
          <Link href="/" aria-label="Vitalora AI home" className="inline-flex">
            <BrandMark wordmarkClassName="text-white" />
          </Link>
        </motion.div>

        <div className="relative max-w-md">
          <motion.h2
            className="text-3xl font-semibold leading-[1.15] tracking-tight xl:text-4xl"
            initial={reduceMotion ? false : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: easeOut, delay: 0.08 }}
          >
            Every call answered.
            <br />
            <span className="bg-gradient-to-r from-teal-300 via-teal-200 to-emerald-200 bg-clip-text text-transparent">
              In every language.
            </span>
            <br />
            At every hour.
          </motion.h2>

          <motion.p
            className="mt-4 text-sm leading-relaxed text-white/60"
            initial={reduceMotion ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: easeOut, delay: 0.16 }}
          >
            VITALORA is the AI voice receptionist for modern clinics — it
            answers, books, reschedules and escalates, so your front desk never
            rings busy.
          </motion.p>

          <div className="mt-8 space-y-3">
            {PANEL_STATS.map((stat, i) => (
              <motion.div
                key={stat.value}
                className="flex items-center gap-3.5 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 backdrop-blur-sm"
                initial={reduceMotion ? false : { opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.5, ease: easeOut, delay: 0.24 + i * 0.09 }}
              >
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-teal-400/15 text-teal-200"
                >
                  <stat.icon className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold tracking-tight text-white">{stat.value}</p>
                  <p className="text-xs text-white/55">{stat.label}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        <motion.p
          className="relative flex items-center gap-2 text-xs text-white/45"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.55 }}
        >
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
          Every receptionist identifies itself as an AI at the start of each call.
        </motion.p>
      </aside>

      {/* ── Form side ────────────────────────────────────────────────────── */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <ThemeToggle className="absolute right-4 top-4 z-10 hidden lg:inline-flex" />
        <div className="flex items-center justify-between p-4 sm:p-6 lg:hidden">
          <Link href="/" aria-label="Vitalora AI home">
            <BrandMark size="sm" />
          </Link>
          <ThemeToggle />
        </div>
        <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:px-6 sm:py-10">
          <div className="w-full max-w-md">
            <IframeNotice />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
