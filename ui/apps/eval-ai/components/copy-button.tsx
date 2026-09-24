"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@evalai/shared/utils";

/**
 * Copy a value to the clipboard, confirming in place.
 *
 * The confirmation is the point: a copy button that looks identical before and
 * after leaves you pressing it twice to be sure. `subject` names what is being
 * copied so the accessible name is specific — several of these can share a page.
 */
export function CopyButton({
  value,
  subject,
  className,
}: {
  value: string;
  /** What is being copied, lowercase, e.g. "prompt". Used in the accessible name. */
  subject: string;
  className?: string;
}) {
  // h-9 to match the `size="sm"` buttons this sits beside. That whole cluster is
  // below the 44px touch guidance, which is an app-wide sizing decision rather
  // than something to fix in one button.
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure origin, denied permission): the text
      // stays selectable, so this degrades to a no-op rather than an error.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? `${subject} copied` : `Copy ${subject}`}
      className={cn(
        "inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
