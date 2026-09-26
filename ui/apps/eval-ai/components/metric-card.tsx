import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@evalai/shared/utils";

type MetricCardDelta = {
  /** Signed change, e.g. "+41.8%" or "-2 pt". */
  text: string;
  /** Previous-period value for context, e.g. "74,580". */
  previousLabel: string;
  /** Which way the number moved — rendered as an arrow so color never carries meaning alone. */
  direction: "up" | "down" | "flat";
  /** Whether this movement is good news — the metric decides, not the sign. */
  tone: "good" | "bad" | "neutral";
};

type MetricCardProps = {
  href?: string;
  label: string;
  value: string;
  hint?: string;
  /** Period-over-period chip; omit when there is no honest previous period. */
  delta?: MetricCardDelta | null;
  className?: string;
  /** Standalone bordered card (default) or cell inside a proof strip. */
  variant?: "card" | "strip";
};

const DELTA_TONES = {
  good: "text-[var(--gate-pass)]",
  bad: "text-[var(--gate-fail)]",
  neutral: "text-muted-foreground",
} as const;

const DELTA_ARROWS = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  flat: Minus,
} as const;

/** Delta leads (the fact a scanner wants), context follows; the arrow carries direction beside color. */
function DeltaChip({ delta }: { delta: MetricCardDelta }) {
  const Arrow = DELTA_ARROWS[delta.direction];
  return (
    <p className="mt-1 text-[0.6875rem] tabular-nums">
      <span className={cn("inline-flex items-center gap-0.5 font-medium", DELTA_TONES[delta.tone])}>
        <Arrow aria-hidden className="size-3" />
        {delta.text}
      </span>{" "}
      <span className="text-muted-foreground" title="previous period of equal length">vs {delta.previousLabel}</span>
    </p>
  );
}

export function MetricCard({
  href,
  label,
  value,
  hint,
  delta,
  className,
  variant = "card",
}: MetricCardProps) {
  if (variant === "strip") {
    return (
      <div className={cn("relative flex min-w-0 flex-col justify-center px-4 py-4", className)}>
        {href ? <Link href={href} aria-label={`Open ${label.toLowerCase()}`} className="absolute inset-0 rounded-lg hover:bg-brand/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" /> : null}
        <p className="proofgrove-eyebrow text-[0.6875rem] text-muted-foreground">{label}</p>
        <p className="mt-1 font-display text-2xl font-medium tracking-tight whitespace-nowrap tabular-nums">{value}</p>
        {delta ? <DeltaChip delta={delta} /> : null}
        {hint ? <p className="mt-1 text-xs leading-normal text-muted-foreground">{hint}</p> : null}
      </div>
    );
  }

  return (
    <div className={cn("panel px-4 py-4", className)}>
      <p className="proofgrove-eyebrow text-[0.6875rem] text-muted-foreground">{label}</p>
      <p className="mt-2 font-display text-2xl font-medium tracking-tight tabular-nums">{value}</p>
      {delta ? <DeltaChip delta={delta} /> : null}
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
