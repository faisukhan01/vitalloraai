"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ShieldCheck } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { IframeNotice } from "@/components/layout/iframe-notice";

/**
 * Auth layout — quiet, premium, single-column.
 * Nothing competes with the form: a soft ambient backdrop, one focused
 * column, and a single reassurance line at the bottom.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <div className="relative flex min-h-screen flex-1 flex-col overflow-hidden bg-background">
      {/* Ambient backdrop — two soft glows + a fine dot texture. Pure CSS, no cards. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-[radial-gradient(55%_45%_at_50%_-5%,rgba(20,184,166,0.10),transparent_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(38%_32%_at_88%_102%,rgba(16,185,129,0.06),transparent_70%)]" />
        <div className="absolute inset-0 opacity-40 [background-image:radial-gradient(rgba(15,23,42,0.05)_1px,transparent_1px)] [background-size:24px_24px] dark:opacity-30 dark:[background-image:radial-gradient(rgba(255,255,255,0.06)_1px,transparent_1px)]" />
      </div>

      <motion.header
        className="flex items-center justify-between px-5 py-5 sm:px-8"
        initial={reduceMotion ? false : { opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.21, 0.47, 0.32, 0.98] }}
      >
        <Link href="/" aria-label="Vitalora AI home" className="inline-flex">
          <BrandMark size="sm" />
        </Link>
        <ThemeToggle />
      </motion.header>

      <main className="flex flex-1 items-start justify-center px-4 pb-10 pt-2 sm:items-center sm:pt-0">
        <div className="w-full max-w-[25rem]">
          <IframeNotice />
          {children}
        </div>
      </main>

      <motion.footer
        className="pb-6 pt-2 text-center"
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.4 }}
      >
        <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground/80">
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
          The AI identifies itself as an assistant at the start of every call.
        </p>
      </motion.footer>
    </div>
  );
}
