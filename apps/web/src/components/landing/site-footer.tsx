import Link from "next/link";
import { Bot } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";

/**
 * SiteFooter — sticky-to-bottom pattern: the body is `min-h-screen
 * flex flex-col` (root layout) and the landing page wraps content in a
 * flex-1 main; this footer uses `mt-auto` so it hugs the viewport bottom
 * on short pages.
 */
export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-auto border-t border-border/70 glass-subtle">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <BrandMark />
            <p className="mt-3 max-w-sm text-sm text-muted-foreground">
              The AI voice receptionist for clinics — answering every call in
              the patient&apos;s language, and handing over to your team when a
              human is the right answer.
            </p>
          </div>

          <nav aria-label="Product">
            <p className="text-sm font-semibold text-foreground">Product</p>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <a href="#features" className="text-muted-foreground hover:text-foreground">
                  Features
                </a>
              </li>
              <li>
                <a href="#how-it-works" className="text-muted-foreground hover:text-foreground">
                  How it works
                </a>
              </li>
              <li>
                <a href="#security" className="text-muted-foreground hover:text-foreground">
                  Security &amp; privacy
                </a>
              </li>
              <li>
                <a href="#pricing" className="text-muted-foreground hover:text-foreground">
                  Pricing
                </a>
              </li>
            </ul>
          </nav>

          <nav aria-label="Account">
            <p className="text-sm font-semibold text-foreground">Account</p>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <Link href="/login" className="text-muted-foreground hover:text-foreground">
                  Sign in
                </Link>
              </li>
              <li>
                <Link href="/register" className="text-muted-foreground hover:text-foreground">
                  Create a workspace
                </Link>
              </li>
            </ul>
          </nav>
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-border/70 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Bot className="size-4 text-primary" aria-hidden="true" />
            Every VITALORA receptionist identifies itself as an AI assistant at
            the start of each call.
          </p>
          <p className="text-xs text-muted-foreground">
            © {year} Vitalora AI. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
