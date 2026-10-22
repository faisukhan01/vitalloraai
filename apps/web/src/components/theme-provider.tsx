"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * ThemeProvider — class strategy (`.dark` on <html>), defaults to the OS
 * preference, and disables transition flicker on switch. Wired in the root
 * layout so every route (marketing, auth, dashboard) shares one theme.
 */
function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}

export { ThemeProvider };
