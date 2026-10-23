import Link from "next/link";
import { CalendarCheck2, Headset, Languages } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { ThemeToggle } from "@/components/layout/theme-toggle";

const PANEL_POINTS = [
  {
    icon: Languages,
    title: "Every patient's language",
    text: "English, Urdu, Hindi and Arabic — detected and spoken naturally.",
  },
  {
    icon: CalendarCheck2,
    title: "Your real schedule",
    text: "Books against your providers' calendars with conflict prevention.",
  },
  {
    icon: Headset,
    title: "Humans stay in the loop",
    text: "Emergencies and complex requests escalate to your staff instantly.",
  },
];

/**
 * Auth layout — split screen: brand panel (desktop) + centered form card.
 * The form side stays neutral so glass form cards read clearly in both themes.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-1">
      {/* Brand panel — always-dark gradient for depth (works in both themes) */}
      <aside className="relative hidden w-[44%] max-w-2xl flex-col justify-between overflow-hidden bg-gradient-to-br from-stone-950 via-teal-950 to-stone-900 p-10 text-white lg:flex xl:p-14">
        {/* Decorative glows */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-teal-500/20 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 -left-24 size-96 rounded-full bg-emerald-500/10 blur-3xl"
        />

        <div className="relative">
          <Link href="/" aria-label="Vitalora AI home" className="inline-flex">
            <BrandMark wordmarkClassName="text-white" />
          </Link>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">
            Every call answered. In every language. At every hour.
          </h2>
          <ul className="mt-8 space-y-5">
            {PANEL_POINTS.map((point) => (
              <li key={point.title} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-teal-200"
                >
                  <point.icon className="size-4.5" />
                </span>
                <div>
                  <p className="text-sm font-medium text-white">{point.title}</p>
                  <p className="mt-0.5 text-sm text-white/60">{point.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative flex items-center gap-2 text-xs text-white/50">
          Every VITALORA receptionist identifies itself as an AI assistant at
          the start of each call.
        </p>
      </aside>

      {/* Form side */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <ThemeToggle className="absolute right-4 top-4 z-10 hidden lg:inline-flex" />
        <div className="flex items-center justify-between p-4 sm:p-6 lg:hidden">
          <Link href="/" aria-label="Vitalora AI home">
            <BrandMark size="sm" />
          </Link>
          <ThemeToggle />
        </div>
        <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:px-6 sm:py-10">
          <div className="w-full max-w-md">{children}</div>
        </main>
      </div>
    </div>
  );
}
