"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * ThemeToggle — light/dark/system cycle kept simple: toggle between light
 * and dark once the mounted theme is known (next-themes handles `system`).
 * Renders a stable placeholder before mount to avoid hydration mismatch.
 */
function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={cn("size-9", className)}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}
    </Button>
  );
}

export { ThemeToggle };
