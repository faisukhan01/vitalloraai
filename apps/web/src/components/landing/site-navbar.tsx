"use client";

import * as React from "react";
import Link from "next/link";
import { Menu } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

const NAV_LINKS = [
  { label: "Features", href: "#features" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Security", href: "#security" },
  { label: "Pricing", href: "#pricing" },
] as const;

/**
 * SiteNavbar — floating glass pill, sticky on every landing scroll position.
 * Mobile: hamburger opens a Sheet with the same links (44px targets).
 */
export function SiteNavbar() {
  const [open, setOpen] = React.useState(false);

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-4 sm:px-6">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>
      <nav
        aria-label="Main"
        className="glass-strong mx-auto mt-3 flex h-14 max-w-6xl items-center justify-between rounded-full px-4 sm:px-5"
      >
        <Link
          href="/"
          aria-label="Vitalora AI home"
          className="rounded-full focus-visible:outline-2"
        >
          <BrandMark />
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => (
            <Button key={link.href} variant="ghost" size="sm" asChild>
              <a
                href={link.href}
                className="rounded-full text-sm text-muted-foreground hover:text-foreground"
              >
                {link.label}
              </a>
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          <ThemeToggle className="hidden sm:inline-flex" />
          <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button size="sm" asChild className="hidden rounded-full shadow-[var(--shadow-glow-value)] sm:inline-flex">
            <Link href="/register">Get started</Link>
          </Button>

          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-10 md:hidden"
                aria-label="Open navigation menu"
              >
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-80">
              <SheetHeader>
                <SheetTitle>
                  <BrandMark size="sm" />
                </SheetTitle>
                <SheetDescription className="sr-only">
                  Vitalora AI navigation
                </SheetDescription>
              </SheetHeader>
              <nav aria-label="Mobile" className="flex flex-col gap-1 px-4">
                {NAV_LINKS.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="flex min-h-11 items-center rounded-lg px-3 text-base text-foreground hover:bg-accent hover:text-accent-foreground"
                  >
                    {link.label}
                  </a>
                ))}
              </nav>
              <div className="mt-auto flex flex-col gap-2 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Theme</span>
                  <ThemeToggle />
                </div>
                <Button variant="outline" asChild className="min-h-11">
                  <Link href="/login">Sign in</Link>
                </Button>
                <Button asChild className="min-h-11">
                  <Link href="/register">Get started</Link>
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </nav>
    </header>
  );
}
