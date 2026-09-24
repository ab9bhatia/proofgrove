// Pure, behavior-truthful selectors that shape run history into chart/table
// data. These functions never fabricate values: incompatible-cohort runs are
// excluded (not plotted as comparable), missing scores/telemetry become gaps
// (never invented zeros), and thresholds are surfaced only when really recorded.
//
// The cohort-compatibility rule mirrors the backend exactly (see
// `store.compare_runs` / `_recorded_comparison_basis`): two runs are comparable
// only when both record the same `comparison_basis_hash` AND the same
// `comparison_basis_version`; a v1 run (null version) never compares against a
// v2 run. When no basis hash was recorded, the only fallback is an *exact*
// `experiment_version_id` match. A run with neither is comparable to nothing.

import { formatDateTimeOrNull } from "@/lib/format-time";
import type { GateResult, RunResult } from "@/lib/api";
import {
  caseCountsFromMetrics,
  isQualityGoverned,
  isReleaseGoverned,
  type CaseCounts,
} from "@/components/report/lib";
import { kpiLabel } from "@/components/kpi-scorecard";
import {
  gatedRunScore,
  observedRunScore,
  presentRunOutcome,
  runScoreBasis,
  type PresentedRunOutcome,
} from "@/lib/run-outcome";
import { evaluationName, runLabel } from "@/lib/run-recommendation";

/* ── Comparison basis / cohort compatibility ───────────────────── */

export type ComparisonBasis =
  | { kind: "basis"; hash: string; version: string | null }
  | { kind: "exact"; versionId: string }
  | null;

/** `comparison_basis_version` is recorded by the backend but not yet in the FE
 * `RunLineageSnapshot` type; read it defensively without mutating the type. */
function basisVersionOf(run: RunResult): string | null {
  const lineage = run.lineage as (Record<string, unknown> | null | undefined);
  const value = lineage?.comparison_basis_version;
  return typeof value === "string" && value.trim() ? value : null;
}

export function runComparisonBasis(run: RunResult): ComparisonBasis {
  const hash = run.lineage?.comparison_basis_hash?.trim();
  if (hash) return { kind: "basis", hash, version: basisVersionOf(run) };
  const versionId = run.experiment_version_id?.trim();
  if (versionId) return { kind: "exact", versionId };
  return null;
}

export function comparisonBasisKey(basis: ComparisonBasis): string | null {
  if (!basis) return null;
  if (basis.kind === "basis") return `basis:${basis.hash}::${basis.version ?? ""}`;
  return `exact:${basis.versionId}`;
}

export function runComparisonKey(run: RunResult): string | null {
  return comparisonBasisKey(runComparisonBasis(run));
}

/** A run may join an experiment only when it is completed AND recorded a basis,
 * so every member of a workspace shares one comparison key. */
export function canJoinExperiment(run: RunResult): boolean {
  return run.status === "completed" && runComparisonKey(run) !== null;
}

export function runsAreComparable(a: RunResult, b: RunResult): boolean {
  const keyA = runComparisonKey(a);
  const keyB = runComparisonKey(b);
  return keyA !== null && keyA === keyB;
}

/* ── Governance / diagnostic / score / gate selectors ──────────── */

export type RunGovernance = "release" | "quality" | "ungoverned";

export function runGovernance(run: RunResult): RunGovernance {
  if (isReleaseGoverned(run)) return "release";
  if (isQualityGoverned(run)) return "quality";
  return "ungoverned";
}

export function governanceLabel(governance: RunGovernance): string {
  switch (governance) {
    case "release":
      return "Release governed";
    case "quality":
      return "Quality governed";
    default:
      return "Ungoverned";
  }
}

/** The gate is authoritative only for a conclusive, gated run. */
export function runGate(run: RunResult): GateResult | null {
  return presentRunOutcome(run).gate;
}

/**
 * A point is drawn *hollow* when it is diagnostic-only or otherwise carries no
 * conclusive gate. Governed, conclusive runs render as filled, gate-coloured
 * points; everything else is exploratory and must read as such.
 */
export function isDiagnosticRun(run: RunResult): boolean {
  // An ungoverned run's gate is not a governed verdict, so it must never render
  // as a filled, gate-coloured point even when a gate value is present.
  return (
    run.diagnostic_only === true ||
    runGate(run) === null ||
    runGovernance(run) === "ungoverned"
  );
}

/**
 * Score used on the overall-score trend. Governed conclusive runs contribute
 * their gated score; diagnostic/ungoverned runs contribute their observed
 * score (rendered hollow). When neither exists the point is a gap (`null`).
 */
export function runOverallScore(run: RunResult): number | null {
  return runScoreBasis(run).value;
}

/**
 * Aggregate ops latency for a run, in milliseconds. `RunResult` has no
 * guaranteed run-level latency field, so this reads optional run-level shapes
 * first and then aggregates honestly from what the payload really carries:
 * `ops.latency` metric rows record the *captured* per-item target latency in
 * seconds (backend deterministic adapter: `score = latency_ms / 1000`), so
 * their mean is the same per-item average the compare endpoint reports.
 * Returns `null` ("not captured", a gap) when telemetry is absent — it never
 * substitutes 0 and never repurposes run duration as request latency.
 */
export function runLatencyMs(run: RunResult): number | null {
  const source = run as unknown as Record<string, unknown>;
  const candidates = [source.latency_ms, source.p50_latency_ms, source.median_latency_ms];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const meanSeconds = metricMean(run, "ops.latency");
  return meanSeconds == null ? null : meanSeconds * 1000;
}

/**
 * Mean recorded score for one metric across a run's rows, or `null` when the
 * run recorded none. Absence is a gap, never a zero — the same rule
 * {@link runLatencyMs} has always applied, now shared by every ops measure.
 */
export function metricMean(run: RunResult, metricId: string): number | null {
  const scores = (run.metric_results ?? [])
    .filter((metric) => metric.metric_id === metricId)
    .map((metric) => metric.score)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  if (scores.length === 0) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

/* ── Gate colouring (aligned with GateBadge palette) ───────────── */

// CSS custom properties from globals.css: theme-aware (light/dark) and shared
// with GateBadge and the State pills. Recharts/SVG accept var() color strings.
export const GATE_CHART_COLORS: Record<GateResult, string> = {
  pass: "var(--gate-pass)",
  warn: "var(--gate-warn)",
  fail: "var(--gate-fail)",
};

const NEUTRAL_CHART_COLOR = "var(--gate-neutral)"; // no gate / diagnostic

export function gateColor(gate: GateResult | null): string {
  return gate ? GATE_CHART_COLORS[gate] : NEUTRAL_CHART_COLOR;
}

/* ── Run trend (overall score over runs, compatible cohort only) ─ */

export type TrendPoint = {
  runId: string;
  label: string;
  /** `null` => gap (missing score); never an invented zero. */
  score: number | null;
  /**
   * Presented gate for the point. A point is either a filled gate point or a
   * diagnostic hollow point — never both — so this is always `null` when
   * `diagnostic` is true, even if the run carries an ungoverned gate value.
   */
  gate: GateResult | null;
  /** Hollow point (diagnostic / ungoverned / no conclusive gate). */
  diagnostic: boolean;
  timestamp: number;
};

export type ExcludedRun = {
  runId: string;
  label: string;
  reason: string;
};

export type RunTrend = {
  points: TrendPoint[];
  excluded: ExcludedRun[];
  basisKey: string | null;
  comparableCount: number;
};

function runTimestamp(run: RunResult): number {
  const raw = run.completed_at || run.started_at;
  const value = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(value) ? value : 0;
}

function chronological(runs: RunResult[]): RunResult[] {
  return [...runs].sort((a, b) => {
    const delta = runTimestamp(a) - runTimestamp(b);
    if (delta !== 0) return delta;
    return (a.run_number ?? 0) - (b.run_number ?? 0);
  });
}

/**
 * Display labels for a set of runs shown together (chart axis, table rows).
 * The user's own run label (Baseline / Candidate A / …) always wins. `Run N`
 * from `run_number` is trusted only while the recorded numbers are actually
 * distinct within the set — when grouping leaves several runs at run_number 1
 * (e.g. distinct experiments attached to one comparison), distinct runs must
 * not all read "Run 1", so numbered runs fall back to their started-at order
 * index instead. Runs with no number at all keep their run id.
 */
export function assignRunDisplayLabels(runs: RunResult[]): Map<string, string> {
  const ordered = chronological(runs);
  const seenNumbers = new Set<number>();
  let numbersCollide = false;
  for (const run of ordered) {
    if (run.run_number == null) continue;
    if (seenNumbers.has(run.run_number)) {
      numbersCollide = true;
      break;
    }
    seenNumbers.add(run.run_number);
  }
  const labels = new Map<string, string>();
  ordered.forEach((run, index) => {
    const userLabel = runLabel(run).trim();
    if (userLabel) labels.set(run.run_id, userLabel);
    else if (run.run_number == null) labels.set(run.run_id, run.run_id);
    else if (!numbersCollide) labels.set(run.run_id, `Run ${run.run_number}`);
    else labels.set(run.run_id, `Run ${index + 1}`);
  });
  return labels;
}

function trendLabel(run: RunResult): string {
  const label = runLabel(run).trim();
  if (label) return label;
  if (run.run_number != null) return `Run ${run.run_number}`;
  return run.run_id;
}

/**
 * Build the comparable run-trend. Only the dominant compatible cohort is
 * plotted; every run outside it (different or absent basis) is reported as
 * excluded with a reason, never plotted as if comparable.
 */
/**
 * The largest set of runs that share one comparison basis, oldest first.
 *
 * Every measure plots this same set. Charting a measure over all runs while the
 * score trend plots only the compatible ones would put two runs side by side on
 * the latency chart that the score chart deliberately refused to compare.
 */
export function dominantCohort(runs: RunResult[]): { key: string | null; runs: RunResult[] } {
  const cohorts = new Map<string, RunResult[]>();
  for (const run of chronological(runs)) {
    const key = runComparisonKey(run);
    if (!key) continue;
    const cohort = cohorts.get(key) ?? [];
    cohort.push(run);
    cohorts.set(key, cohort);
  }

  let dominantKey: string | null = null;
  let dominant: RunResult[] = [];
  for (const [key, cohort] of cohorts) {
    if (
      cohort.length > dominant.length ||
      (cohort.length === dominant.length &&
        runTimestamp(cohort[cohort.length - 1]!) > runTimestamp(dominant[dominant.length - 1] ?? cohort[0]!))
    ) {
      dominantKey = key;
      dominant = cohort;
    }
  }
  return { key: dominantKey, runs: dominant };
}

export function buildRunTrend(runs: RunResult[]): RunTrend {
  const ordered = chronological(runs);
  const labels = assignRunDisplayLabels(runs);
  const labelOf = (run: RunResult) => labels.get(run.run_id) ?? trendLabel(run);
  const { key: dominantKey, runs: dominant } = dominantCohort(runs);

  const dominantIds = new Set(dominant.map((run) => run.run_id));
  const points: TrendPoint[] = dominant.map((run) => {
    const diagnostic = isDiagnosticRun(run);
    return {
      runId: run.run_id,
      label: labelOf(run),
      score: runOverallScore(run),
      // A diagnostic point never also carries a gate label: its gate (if any)
      // is not a governed verdict, so presenting both would read "PASS ·
      // DIAGNOSTIC" on one point.
      gate: diagnostic ? null : runGate(run),
      diagnostic,
      timestamp: runTimestamp(run),
    };
  });

  const excluded: ExcludedRun[] = ordered
    .filter((run) => !dominantIds.has(run.run_id))
    .map((run) => ({
      runId: run.run_id,
      label: labelOf(run),
      reason: runComparisonKey(run)
        ? "Different comparison basis"
        : "No recorded comparison basis",
    }));

  return { points, excluded, basisKey: dominantKey, comparableCount: points.length };
}

/* ── KPI composite / thresholds / slope ────────────────────────── */

export function kpiCompositeScore(run: RunResult, kpiId: string): number | null {
  const kpi = (run.kpi_results ?? []).find((entry) => entry.kpi_id === kpiId);
  return kpi?.composite_score ?? null;
}

export type KpiThresholds = { pass: number; warn: number; fail: number };

/** Real recorded thresholds for a KPI, or `null` when the KPI has none. */
export function kpiThresholds(run: RunResult, kpiId: string): KpiThresholds | null {
  const kpi = (run.kpi_results ?? []).find((entry) => entry.kpi_id === kpiId);
  if (!kpi) return null;
  const pass = kpi.threshold_pass;
  const warn = kpi.threshold_warn;
  const fail = kpi.threshold_fail;
  const hasReal = [pass, warn].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  if (!hasReal) return null;
  return { pass, warn, fail };
}

export function listKpiIds(runs: RunResult[]): string[] {
  const ids = new Set<string>();
  for (const run of runs) {
    for (const kpi of run.kpi_results ?? []) ids.add(kpi.kpi_id);
  }
  return [...ids].sort();
}

/* ── Measures (what the analysis section can chart) ────────────── */

export type MeasureGroup = "quality" | "ops" | "cases";

export type Measure = {
  id: string;
  label: string;
  group: MeasureGroup;
  /** This run's value, or `null` when the run recorded none — a gap, never 0. */
  value: (run: RunResult) => number | null;
};

const OPS_TOKEN_MEASURES: Array<[string, string]> = [
  ["ops.input_token_count", "Input tokens"],
  ["ops.output_token_count", "Output tokens"],
  ["ops.total_token_count", "Total tokens"],
  ["ops.token_efficiency", "Token efficiency"],
];

const CASE_MEASURES: Array<[string, string, keyof CaseCounts]> = [
  ["cases.passed", "Cases passed", "passed"],
  ["cases.failed", "Cases failed", "failed"],
  ["cases.warned", "Cases warned", "warned"],
  ["cases.not_scored", "Cases not scored", "notScored"],
];

/**
 * The measures these runs can actually chart.
 *
 * A selector, not a constant: the quality entries are one per KPI the runs
 * recorded, so a module-level registry would have to be rebuilt anyway. Ops and
 * case entries are fixed, but a measure no run recorded is dropped rather than
 * offered as a permanently empty chart.
 */

/** Metric ids the cohort recorded, minus the ones that already have their own measure. */
function listMetricIds(runs: RunResult[]): string[] {
  const explicit = new Set<string>(["ops.latency", ...OPS_TOKEN_MEASURES.map(([id]) => id)]);
  const ids = new Set<string>();
  for (const run of runs) {
    for (const result of run.metric_results ?? []) {
      if (!explicit.has(result.metric_id)) ids.add(result.metric_id);
    }
  }
  return [...ids].sort();
}

/** "llm.correctness" -> "Correctness". The family prefix is noise in a measure list. */
function metricDisplayLabel(metricId: string): string {
  const leaf = metricId.includes(".") ? metricId.split(".").pop()! : metricId;
  const words = leaf.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A metric's normalised score for one run, averaged over the cases it scored.
 *
 * Normalised, not raw: these sit beside KPI scores as percentages, and a raw
 * value has units that differ per metric. A metric with no normalised score on
 * this run is a gap, never a zero.
 */
function metricNormalisedMean(run: RunResult, metricId: string): number | null {
  const values = (run.metric_results ?? [])
    .filter((result) => result.metric_id === metricId)
    .map((result) => result.normalised_score)
    // Finite only, matching metricMean: a non-finite score became a recorded
    // measure and rendered as "NaN%", with unstable ordering behind it.
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function measuresForRuns(runs: RunResult[]): Measure[] {
  // A gated score and an observed one are different quantities, and subtracting
  // across them produces a number that means nothing — "85% → 90%, up 5 pts"
  // where the first is a gate result and the second is a raw mean, with nothing
  // saying so. Cohort membership does not prevent it: the comparison key is the
  // basis hash, which says nothing about governance. So when the cohort mixes
  // the two, only gated scores are plotted and an ungoverned run contributes a
  // gap — the same rule the run-vs-sample score reconciliation already applies.
  const bases = new Set(
    dominantCohort(runs).runs.map((run) => runScoreBasis(run).basis).filter((basis) => basis !== null),
  );
  const scoreValue = bases.size > 1 ? gatedRunScore : runOverallScore;

  const measures: Measure[] = [
    { id: "score", label: "Overall score", group: "quality", value: scoreValue },
    ...listKpiIds(runs).map((kpiId) => ({
      id: kpiId,
      label: kpiLabel(kpiId),
      group: "quality" as const,
      value: (run: RunResult) => kpiCompositeScore(run, kpiId),
    })),
    { id: "ops.latency", label: "Latency", group: "ops", value: runLatencyMs },
    ...OPS_TOKEN_MEASURES.map(([metricId, label]) => ({
      id: metricId,
      label,
      group: "ops" as const,
      value: (run: RunResult) => metricMean(run, metricId),
    })),
    ...CASE_MEASURES.map(([id, label, field]) => ({
      id,
      label,
      group: "cases" as const,
      value: (run: RunResult) => caseCountsFromMetrics(run)?.[field] ?? null,
    })),
    // Every individual metric, not only the KPI rollups above it.
    //
    // This is a comparison: "Response Quality held" is a summary, and the whole
    // question is which of the checks underneath it moved. A KPI can sit
    // perfectly still while correctness falls and coherence rises inside it.
    //
    // These were left out while the analysis was a grid of charts, where one
    // chart per metric was unaffordable. A table costs one row, and only the
    // metrics that actually moved become rows at all — the rest collapse into
    // the "Unchanged" line.
    ...listMetricIds(runs).map((metricId) => ({
      id: `metric:${metricId}`,
      label: metricDisplayLabel(metricId),
      group: "quality" as const,
      value: (run: RunResult) => metricNormalisedMean(run, metricId),
    })),
  ];
  return measures.filter((measure) => runs.some((run) => measure.value(run) !== null));
}

/**
 * How a measure's value reads. Derived from the measure, not carried as a field
 * on every entry: quality is always a percentage, cases are always counts, and
 * ops splits by what the metric records.
 */
export function formatMeasureValue(measure: Measure, value: number | null): string {
  if (value === null) return "Not captured";
  if (measure.group === "quality") return `${Math.round(value * 100)}%`;
  if (measure.group === "cases") return String(value);
  if (measure.id === "ops.latency") return `${Math.round(value)} ms`;
  if (measure.id === "ops.token_efficiency") return value.toFixed(2);
  return `${Math.round(value)}`;
}

/**
 * What a measure did across the cohort, first run to last.
 *
 * The number, not the slope. A chart selected *because* a measure moved has to
 * say by how much: 0.90 → 0.75 is a 17% drop that reads as a flat line when the
 * axis starts at zero, and a reader should never have to estimate a magnitude
 * the data already knows.
 */
export function measureDelta(
  runs: RunResult[],
  measure: Measure,
): { before: number | null; after: number | null; delta: number | null } {
  const cohort = dominantCohort(runs).runs;
  if (cohort.length < 2) return { before: null, after: null, delta: null };
  const before = measure.value(cohort[0]!);
  const after = measure.value(cohort[cohort.length - 1]!);
  return {
    before,
    after,
    delta: before === null || after === null ? null : after - before,
  };
}


/**
 * The measures that moved across the cohort, first run to last.
 *
 * This is what the analysis section leads with, so the rule has to cover
 * absence as well as change: a measure that appears or disappears between the
 * two ends changed, and one absent at both ends did not — it has nothing to
 * say and is not worth a chart.
 */
export function changedMeasures(runs: RunResult[], measures?: Measure[]): Measure[] {
  const cohort = dominantCohort(runs).runs;
  if (cohort.length < 2) return [];
  const first = cohort[0]!;
  const last = cohort[cohort.length - 1]!;
  return (measures ?? measuresForRuns(runs)).filter((measure) => {
    const before = measure.value(first);
    const after = measure.value(last);
    if (before === null && after === null) return false;
    if (before === null || after === null) return true;
    return before !== after;
  });
}

export type KpiSlopeEndpoint = { runId: string; label: string; score: number | null };

export type KpiSlope = {
  kpiId: string;
  baseline: KpiSlopeEndpoint;
  candidate: KpiSlopeEndpoint;
  thresholds: KpiThresholds | null;
  /** True only when the two runs share a recorded comparison basis. */
  comparable: boolean;
  /** Delta is only real for a comparable pair; `null` otherwise. */
  delta: number | null;
};

export function buildKpiSlope(
  baseline: RunResult,
  candidate: RunResult,
  kpiId: string,
): KpiSlope {
  const comparable = runsAreComparable(baseline, candidate);
  const labels = assignRunDisplayLabels([baseline, candidate]);
  const baseScore = kpiCompositeScore(baseline, kpiId);
  const candScore = kpiCompositeScore(candidate, kpiId);
  const delta =
    comparable && baseScore != null && candScore != null ? candScore - baseScore : null;
  return {
    kpiId,
    baseline: {
      runId: baseline.run_id,
      label: labels.get(baseline.run_id) ?? trendLabel(baseline),
      score: baseScore,
    },
    candidate: {
      runId: candidate.run_id,
      label: labels.get(candidate.run_id) ?? trendLabel(candidate),
      score: candScore,
    },
    thresholds: kpiThresholds(baseline, kpiId) ?? kpiThresholds(candidate, kpiId),
    comparable,
    delta,
  };
}

/* ── Latency series ────────────────────────────────────────────── */

export type LatencyPoint = {
  runId: string;
  label: string;
  /** `null` => not captured (gap); never 0-filled. */
  latencyMs: number | null;
};

export function buildLatencySeries(runs: RunResult[]): LatencyPoint[] {
  const labels = assignRunDisplayLabels(runs);
  return chronological(runs).map((run) => ({
    runId: run.run_id,
    label: labels.get(run.run_id) ?? trendLabel(run),
    latencyMs: runLatencyMs(run),
  }));
}

/* ── Stable run table ──────────────────────────────────────────── */

export type RunTableRow = {
  runId: string;
  label: string;
  evaluation: string;
  timestamp: number;
  dateLabel: string;
  gate: GateResult | null;
  outcomeLabel: string;
  /** The verdict word without the governance qualifier, for tables that carry a
   *  Governance column of their own. */
  outcomeShortLabel: string;
  /** Drives the badge tone. Without it the Gate column had to choose between
   *  the honest label (grey, whatever the verdict) and GateBadge's colour
   *  (which prints its own word and drops "· ungoverned"). */
  outcomeKind: PresentedRunOutcome["kind"];
  overallScore: number | null;
  overallScoreLabel: string;
  observedScore: number | null;
  verdict: string;
  latencyMs: number | null;
  latencyLabel: string;
  governance: RunGovernance;
  governanceLabel: string;
  basisKey: string | null;
  compatible: boolean;
  compatibilityLabel: string;
};

export type RunTableSort = "label" | "date" | "gate" | "score" | "latency";

function percentLabel(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function dateLabel(run: RunResult): string {
  return formatDateTimeOrNull(run.completed_at || run.started_at) ?? "—";
}

function latencyLabel(value: number | null): string {
  if (value == null) return "Not captured";
  return `${Math.round(value)} ms`;
}

export function buildRunTableRows(
  runs: RunResult[],
  opts: { comparableBasisKey?: string | null } = {},
): RunTableRow[] {
  const comparableKey = opts.comparableBasisKey ?? null;
  const labels = assignRunDisplayLabels(runs);
  return runs.map((run) => {
    const outcome = presentRunOutcome(run);
    const basisKey = runComparisonKey(run);
    const governance = runGovernance(run);
    const latency = runLatencyMs(run);
    const compatible = comparableKey != null && basisKey === comparableKey;
    const compatibilityLabel = basisKey
      ? comparableKey == null
        ? "Basis recorded"
        : compatible
          ? "Comparable"
          : "Different basis"
      : "No basis";
    return {
      runId: run.run_id,
      label: labels.get(run.run_id) ?? trendLabel(run),
      evaluation: evaluationName(run),
      timestamp: runTimestamp(run),
      dateLabel: dateLabel(run),
      gate: outcome.gate,
      outcomeLabel: outcome.label,
      outcomeShortLabel: outcome.shortLabel,
      outcomeKind: outcome.kind,
      overallScore: gatedRunScore(run),
      overallScoreLabel: percentLabel(gatedRunScore(run)),
      observedScore: observedRunScore(run),
      verdict: run.verdict_status ?? "—",
      latencyMs: latency,
      latencyLabel: latencyLabel(latency),
      governance,
      governanceLabel: governanceLabel(governance),
      basisKey,
      compatible,
      compatibilityLabel,
    };
  });
}

const GATE_RANK: Record<GateResult, number> = { fail: 1, warn: 2, pass: 3 };

function gateRank(gate: GateResult | null): number {
  return gate ? GATE_RANK[gate] : 0;
}

/** Deterministic, stable ordering: rows are compared by the chosen key and
 * ties fall back to run id so the order never depends on input order. */
export function sortRunTableRows(
  rows: RunTableRow[],
  sort: RunTableSort,
  order: "asc" | "desc",
): RunTableRow[] {
  const direction = order === "asc" ? 1 : -1;
  const compareBy = (a: RunTableRow, b: RunTableRow): number => {
    switch (sort) {
      case "label":
        return a.label.localeCompare(b.label);
      case "date":
        return a.timestamp - b.timestamp;
      case "gate":
        return gateRank(a.gate) - gateRank(b.gate);
      case "latency":
        return (a.latencyMs ?? -Infinity) - (b.latencyMs ?? -Infinity);
      case "score":
        return (a.overallScore ?? a.observedScore ?? -Infinity) -
          (b.overallScore ?? b.observedScore ?? -Infinity);
      default:
        return 0;
    }
  };
  return [...rows].sort((a, b) => {
    const primary = compareBy(a, b) * direction;
    if (primary !== 0) return primary;
    return a.runId.localeCompare(b.runId);
  });
}

/* ── Analysis URL state (shareable, restored on reload) ────────── */

export type AnalysisView = "chart" | "trend" | "table";

export type AnalysisUrlState = {
  view: AnalysisView;
  /** Selected KPI id for slope + threshold bands; "" = overall-score view. */
  kpi: string;
  sort: RunTableSort;
  order: "asc" | "desc";
  /** Selected sample/case id. */
  sample: string;
  /**
   * Charted measure ids. Empty means "no choice recorded", which falls back to
   * the measures that changed — the same thing clearing every chip does, so
   * absent and empty can mean one thing and no sentinel is needed.
   */
  measures: string[];
};

type SearchParamsReader = { get(key: string): string | null };

const RUN_TABLE_SORTS = new Set<RunTableSort>(["label", "date", "gate", "score", "latency"]);

export const DEFAULT_ANALYSIS_STATE: AnalysisUrlState = {
  view: "chart",
  kpi: "",
  sort: "date",
  order: "desc",
  sample: "",
  measures: [],
};

export function readAnalysisUrlState(params: SearchParamsReader): AnalysisUrlState {
  const requestedView = params.get("av")?.trim().toLowerCase();
  const view: AnalysisView =
    requestedView === "table" ? "table" : requestedView === "trend" ? "trend" : "chart";
  const requestedSort = (params.get("rt_sort") ?? "").trim().toLowerCase();
  const sort = RUN_TABLE_SORTS.has(requestedSort as RunTableSort)
    ? (requestedSort as RunTableSort)
    : "date";
  const order = params.get("rt_order")?.trim().toLowerCase() === "asc" ? "asc" : "desc";
  return {
    view,
    // Namespaced so analysis state never consumes or clobbers an unrelated
    // pre-existing `kpi`/`sample` query param on the page.
    kpi: params.get("an_kpi")?.trim() ?? "",
    sort,
    order,
    sample: params.get("an_sample")?.trim() ?? "",
    measures: (params.get("an_m") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  };
}

function setOrDelete(params: URLSearchParams, key: string, value: string) {
  if (value.trim()) params.set(key, value);
  else params.delete(key);
}

export function writeAnalysisSearchParams(current: string, state: AnalysisUrlState): string {
  const params = new URLSearchParams(current);
  setOrDelete(params, "av", state.view === "chart" ? "" : state.view);
  setOrDelete(params, "an_kpi", state.kpi);
  setOrDelete(params, "rt_sort", state.sort === "date" ? "" : state.sort);
  setOrDelete(params, "rt_order", state.order === "desc" ? "" : state.order);
  setOrDelete(params, "an_sample", state.sample);
  setOrDelete(params, "an_m", state.measures.join(","));
  return params.toString();
}

/** Explain visible differences without weakening the recorded compatibility check. */
export function comparisonDifferences(base: RunResult, candidate: RunResult): string[] {
  const fields: Array<[string, unknown, unknown]> = [
    ["dataset", base.experiment?.dataset_version, candidate.experiment?.dataset_version],
    ["judge", base.lineage?.judge_model ?? base.experiment?.judge_model, candidate.lineage?.judge_model ?? candidate.experiment?.judge_model],
    ["target", base.experiment?.target_endpoint, candidate.experiment?.target_endpoint],
    ["quality profile", base.experiment?.quality_profile_version, candidate.experiment?.quality_profile_version],
    ["gate policy", base.experiment?.gate_policy_version, candidate.experiment?.gate_policy_version],
    ["evidence scope", base.lineage?.evaluation_scope ?? base.experiment?.evaluation_scope, candidate.lineage?.evaluation_scope ?? candidate.experiment?.evaluation_scope],
    ["saved-evidence rescore", Boolean(base.lineage?.source_run_id), Boolean(candidate.lineage?.source_run_id)],
    ["target version", base.lineage?.target_version_id, candidate.lineage?.target_version_id],
    ["quality profile", base.lineage?.quality_profile_id, candidate.lineage?.quality_profile_id],
    ["gate policy", base.lineage?.gate_policy_id, candidate.lineage?.gate_policy_id],
    ["selected tools", base.lineage?.selected_tool_ids, candidate.lineage?.selected_tool_ids],
    ["check requirements", base.lineage?.metric_requirements, candidate.lineage?.metric_requirements],
    ["gate composition", base.lineage?.kpi_compositions, candidate.lineage?.kpi_compositions],
  ];
  const differences = fields.filter(([, left, right]) => JSON.stringify(left) !== JSON.stringify(right)).map(([label]) => label);
  return differences.length ? [...new Set(differences)] : ["recorded comparison basis (details not available)"];
}
