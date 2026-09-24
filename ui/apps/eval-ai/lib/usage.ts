import type { UsageBucket, UsageDay } from "@/lib/api-types";

export type UsageDelta = {
  /** e.g. "+41.8%" — always signed, one decimal. */
  text: string;
  /** Previous-period value rendered as "vs 74,580 last period" after the delta. */
  previousLabel: string;
  direction: "up" | "down" | "flat";
};

/**
 * Period-over-period delta for a count metric. Null — meaning "show no chip" —
 * when the previous period had nothing to compare against: a delta against an
 * empty period is +∞%, which reads as growth when it is really absence.
 */
export function deltaFor(current: number, previous: number): UsageDelta | null {
  if (previous <= 0) return null;
  const change = ((current - previous) / previous) * 100;
  const rounded = Math.round(change * 10) / 10;
  return {
    text: `${rounded > 0 ? "+" : ""}${rounded}%`,
    previousLabel: previous.toLocaleString("en-US"),
    direction: rounded > 0 ? "up" : rounded < 0 ? "down" : "flat",
  };
}

/** Cost delta only when BOTH periods priced something — estimates never compare against nulls. */
export function costDelta(current: UsageBucket, previous: UsageBucket): UsageDelta | null {
  if (current.estimated_cost_usd === null || previous.estimated_cost_usd === null) return null;
  const delta = deltaFor(current.estimated_cost_usd, previous.estimated_cost_usd);
  if (!delta) return null;
  return { ...delta, previousLabel: costLabel(previous) ?? "—" };
}

/** Failure-rate delta compares the rates (percentage points), not the raw counts. */
export function failureRateDelta(current: UsageBucket, previous: UsageBucket): UsageDelta | null {
  const currentRate = failureRatePercent(current);
  const previousRate = failureRatePercent(previous);
  if (currentRate === null || previousRate === null) return null;
  const points = Math.round((currentRate - previousRate) * 10) / 10;
  return {
    text: `${points > 0 ? "+" : ""}${points} pt`,
    previousLabel: `${previousRate}%`,
    direction: points > 0 ? "up" : points < 0 ? "down" : "flat",
  };
}

/** Chart axis label for a bucket key: hour buckets → "14:00", day buckets → "MM-DD". */
export function bucketLabel(date: string, bucket: "hour" | "day"): string {
  return bucket === "hour" ? date.slice(11) : date.slice(5);
}

/**
 * Presentation helpers for the usage dashboard (#3334). Extracted so the
 * honesty rules — never render a missing measurement as zero, never let a
 * failure rate divide by nothing — are testable without rendering.
 */

/** Failed launches as a share of everything that tried to run, or null when nothing did. */
export function failureRatePercent(bucket: UsageBucket): number | null {
  const attempts = bucket.runs + bucket.failed_runs;
  if (attempts === 0) return null;
  return Math.round((bucket.failed_runs / attempts) * 1000) / 10;
}

/** "$1.2340" for a priced amount, null for unpriced. Tiny costs never read as zero. */
export function usdLabel(cost: number | null): string | null {
  if (cost === null) return null;
  if (cost > 0 && cost < 0.0001) return "< $0.0001";
  return `$${cost.toFixed(4)}`;
}

/** "1.2340" for a priced bucket, null when nothing was priceable. Tiny costs never read as zero. */
export function costLabel(bucket: UsageBucket): string | null {
  return usdLabel(bucket.estimated_cost_usd);
}

export type UsageChartRow = {
  date: string;
  runs: number;
  failed: number;
  p50: number | null;
  p90: number | null;
  prompt: number | null;
  completion: number | null;
  failureRate: number | null;
  cost: number | null;
};

/** Chart-ready rows; labels via {@link bucketLabel}, nulls preserved so lines gap honestly. */
export function usageChartRows(days: UsageDay[], bucket: "hour" | "day" = "day"): UsageChartRow[] {
  return days.map((day) => ({
    date: bucketLabel(day.date, bucket),
    runs: day.runs,
    failed: day.failed_runs,
    p50: day.latency_ms_p50,
    p90: day.latency_ms_p90,
    prompt: day.prompt_measured_cases > 0 ? day.prompt_tokens : null,
    completion: day.completion_measured_cases > 0 ? day.completion_tokens : null,
    failureRate: failureRatePercent(day),
    cost: day.estimated_cost_usd,
  }));
}

/** Accessible-table rows mirroring the charts, with honest dashes for missing data. */
export function usageTableRows(days: UsageDay[]): Array<{ key: string; values: string[] }> {
  return days.map((day) => ({
    key: day.date,
    values: [
      day.date,
      String(day.runs),
      String(day.failed_runs),
      String(day.cases),
      day.latency_ms_p50 === null ? "—" : String(day.latency_ms_p50),
      day.latency_ms_p90 === null ? "—" : String(day.latency_ms_p90),
      day.prompt_measured_cases > 0 ? String(day.prompt_tokens) : "—",
      day.completion_measured_cases > 0 ? String(day.completion_tokens) : "—",
      costLabel(day) ?? "—",
    ],
  }));
}

export const USAGE_WINDOWS = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
] as const;

export type UsageWindow = (typeof USAGE_WINDOWS)[number]["value"];

export function isUsageWindow(value: string): value is UsageWindow {
  return USAGE_WINDOWS.some((window) => window.value === value);
}

/** Compact token headline: 62_940_000 → "62.94M", 45_200 → "45.2k"; below 10k, plain digits. */
export function tokensLabel(total: number): string {
  if (total >= 1_000_000) return `${(Math.round(total / 10_000) / 100).toLocaleString("en-US")}M`;
  if (total >= 10_000) return `${(Math.round(total / 100) / 10).toLocaleString("en-US")}k`;
  return total.toLocaleString("en-US");
}
