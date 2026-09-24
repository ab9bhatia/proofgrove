"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@evalai/shared/utils";

export type IdentifierKind = "run" | "trace";

export function CopyIdButton({
  value,
  kind,
  className,
}: {
  value: string;
  kind: IdentifierKind;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  const label = `${kind === "run" ? "Run" : "Trace"} ID`;

  useEffect(
    () => () => {
      if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    // ID controls commonly live in linked or clickable rows. Copying must not
    // open the row, toggle a disclosure, or select a surrounding checkbox.
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied. The adjacent ID remains selectable.
    }
  }

  return (
    <button
      type="button"
      onClick={(event) => void copy(event)}
      aria-label={copied ? `${label} copied` : `Copy ${kind} ID`}
      title={copied ? `${label} copied` : `Copy ${label}`}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
    </button>
  );
}

export function CopyableId({
  value,
  kind,
  displayValue = value,
  className,
  valueClassName,
}: {
  value: string;
  kind: IdentifierKind;
  displayValue?: string;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <span className={cn("min-w-0 break-all font-mono text-xs", valueClassName)} title={value}>
        {displayValue}
      </span>
      <CopyIdButton value={value} kind={kind} />
    </span>
  );
}
