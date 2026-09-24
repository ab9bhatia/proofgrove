import type { PropsWithChildren } from "react";

import { cn } from "@evalai/shared/utils";

/**
 * One pill, three roles.
 *
 * `ToneBadge` carries outcome and is the only badge allowed colour; it reads
 * from the `--gate-*` tokens so pass/warn/fail mean the same thing here as on a
 * gate. `Chip` carries neutral metadata — a kind, a count, a revision — and
 * never earns colour. `StatusBadge` stays for the publish lifecycle, whose
 * states are not outcomes.
 *
 * Before this the app drew the same pill in roughly twenty places across two
 * paddings and three font sizes.
 */
export type BadgeTone = "pass" | "warn" | "fail" | "neutral";

const TONE_STYLES: Record<BadgeTone, string> = {
  pass: "border-gate-pass/30 bg-gate-pass-soft text-gate-pass",
  warn: "border-gate-warn/30 bg-gate-warn-soft text-gate-warn",
  fail: "border-gate-fail/30 bg-gate-fail-soft text-gate-fail",
  neutral: "border-border bg-muted/30 text-muted-foreground",
};

// One radius for the whole badge family, and it is a pill.
//
// This was 8px on the reasoning that a fully-round pill is "off the token scale".
// It isn't: the brand's radius system is controls 8px, cards 12px, and pills for
// tags and badges — a pill IS the badge token. At 8px a badge wore the same
// corner as the button beside it, so shape stopped telling you which was which.
// GateBadge and RunOutcomeBadge both route through here, so they move together
// and no status wears two shapes.
const PILL = "inline-flex items-center rounded-full border text-xs font-medium";
/**
 * Two sizes, because the app genuinely has two jobs for this pill: a dense one
 * that rides inside a table row, and a roomier one that sits beside a page
 * heading counting what is on screen. Everything else about them is identical.
 */
const PILL_SIZES = { sm: "px-2 py-0.5", md: "px-2.5 py-1", lg: "px-4 py-2 text-base" } as const;

export function ToneBadge({
  tone,
  size = "sm",
  children,
  className,
}: PropsWithChildren<{ tone: BadgeTone; size?: keyof typeof PILL_SIZES; className?: string }>) {
  return <span className={cn(PILL, PILL_SIZES[size], TONE_STYLES[tone], className)}>{children}</span>;
}

export function Chip({
  size = "sm",
  children,
  className,
}: PropsWithChildren<{ size?: keyof typeof PILL_SIZES; className?: string }>) {
  return (
    <span className={cn(PILL, PILL_SIZES[size], "border-border font-normal text-muted-foreground", className)}>
      {children}
    </span>
  );
}

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground border-border",
  VALIDATED: "bg-blue-50 text-blue-700 border-blue-300 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
  APPROVED: "bg-violet-50 text-violet-700 border-violet-300 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-800",
  PUBLISHED: "bg-state-positive-soft text-state-positive border-state-positive/30 dark:bg-state-positive-soft dark:text-state-positive dark:border-state-positive/30",
  DEPRECATED: "bg-state-caution-soft text-state-caution border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution dark:border-state-caution/30",
  // Retired is an end state, Draft is a beginning. They were the same grey pill,
  // so the only difference on screen was the word. The dashed border reads as
  // "no longer in force" without spending a colour on a non-outcome.
  RETIRED: "bg-transparent text-muted-foreground border-dashed border-muted-foreground/50 line-through decoration-muted-foreground/40",
  REJECTED: "bg-red-50 text-red-700 border-red-300 dark:bg-red-950 dark:text-red-300 dark:border-red-800",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        PILL,
        PILL_SIZES.sm,
        // Callers spell the lifecycle both ways — "PUBLISHED" from the catalog
        // APIs, "draft" from the contract ones. Matching case-insensitively is
        // what let a second copy of this map exist, unstyled in dark mode.
        STATUS_STYLES[status.toUpperCase()] ?? STATUS_STYLES.DRAFT,
        className,
      )}
    >
      {/* CSS `capitalize` uppercases the first letter but leaves the rest alone, so
          the "PUBLISHED" spelling stayed shouting while "draft" became "Draft" —
          the same lifecycle state rendered two ways on two screens. */}
      {status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}
    </span>
  );
}


/**
 * The version a label points at, or that none does.
 *
 * Which version is live is the fact these surfaces exist to answer, so it is one
 * component rather than the same span pasted into each of them — three copies
 * had already been written, and they drift the moment one is restyled.
 */
export function ProductionBadge({ version }: { version: number | null }) {
  if (version === null) return <Chip>no production version</Chip>;
  return (
    <span className="inline-flex items-center rounded-full bg-brand/10 px-2.5 py-1 text-[11px] font-semibold text-brand-text ring-1 ring-brand/25 dark:bg-brand/15 dark:text-brand dark:ring-brand/30">
      production · v{version}
    </span>
  );
}
