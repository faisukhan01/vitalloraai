"use client";

import * as React from "react";
import { ExternalLink, Info } from "lucide-react";

/**
 * IframeNotice — shown when the app runs inside a preview frame.
 *
 * Embedded previews can restrict cookies and microphone access depending on
 * the browser's privacy settings. We keep everything functional (sessions
 * fall back to per-tab storage), but offer a one-click escape to a real tab
 * for the fully-native experience.
 */
export function IframeNotice() {
  const [embedded, setEmbedded] = React.useState(false);

  React.useEffect(() => {
    try {
      setEmbedded(window.self !== window.top);
    } catch {
      // Cross-origin access throws — being unable to read window.top
      // itself proves we are embedded.
      setEmbedded(true);
    }
  }, []);

  if (!embedded) return null;

  return (
    <div
      role="note"
      aria-label="Preview frame notice"
      className="mb-4 flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">Preview mode detected</p>
        <p className="mt-0.5 text-muted-foreground">
          You&apos;re viewing the app inside a preview frame. Sessions stay
          signed in for this tab — open a real tab for the full experience
          (including microphone access).
        </p>
        <button
          type="button"
          onClick={() => window.open(window.location.href, "_blank", "noopener,noreferrer")}
          className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-full bg-primary px-3.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
          Open in new tab
        </button>
      </div>
    </div>
  );
}
