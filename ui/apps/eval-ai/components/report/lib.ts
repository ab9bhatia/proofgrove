import { METRIC_GROUPS, metricMeaning } from "@/lib/metric-groups";
import type {
  GateResult,
  MetricResult,
  RunItemSummary,
  RunResult,
} from "@/lib/api";
import { evaluationScopeLabel } from "@/components/evaluation/scope-selector";
import { formatDuration } from "@/lib/format-duration";

export type CaseScoreSummary = { mean: number; count: number };

export function pickText(value: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (!value) return "";
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return "";
}

export function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function humanizeKey(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : key;
}

/**
 * A run's Quality Outcome section is shown only when an approved quality
 * profile governs it. A bare `run_manifest_id` never enables governance UI.
 */
export function isQualityGoverned(run: RunResult): boolean {
  return Boolean(run.quality_profile_id || run.lineage?.quality_profile_id);
}

/**
 * Release governance requires a resolved gate policy. Release-decision UI stays
 * hidden until a capability check exists, so this is necessary but not
 * sufficient to render the release affordance.
 */
export function isReleaseGoverned(run: RunResult): boolean {
  return Boolean(run.gate_policy_id || run.lineage?.gate_policy_id);
}

export type CaseEvidencePresentation = {
  captureLabel: "Complete" | "Partial evidence" | "Not recorded";
  evaluationLabel: "Technical error" | "Not evaluated" | "Output too large" | null;
  captureTone: "positive" | "attention" | "neutral";
  evaluationTone: "attention" | "negative" | "neutral" | null;
};

/**
 * Present the backend-owned capture and evaluation states without deriving a
 * new failure classification from scores or error text.
 */
export function caseEvidencePresentation(
  item: Partial<Pick<RunItemSummary, "capture_state" | "evaluation_state">>,
): CaseEvidencePresentation {
  const captureLabel =
    item.capture_state === "complete"
      ? "Complete"
      : item.capture_state === "partial"
        ? "Partial evidence"
        : "Not recorded";
  const evaluationLabel =
    item.evaluation_state === "technical_error"
      ? "Technical error"
      : item.evaluation_state === "not_evaluated"
        ? "Not evaluated"
        : item.evaluation_state === "output_too_large"
          ? "Output too large"
          : null;

  return {
    captureLabel,
    evaluationLabel,
    captureTone:
      item.capture_state === "complete"
        ? "positive"
        : item.capture_state === "partial"
          ? "attention"
          : "neutral",
    evaluationTone:
      item.evaluation_state === "technical_error"
        ? "negative"
        : item.evaluation_state === "output_too_large"
          ? "attention"
          : item.evaluation_state === "not_evaluated"
            ? "neutral"
            : null,
  };
}

export function formatPlainEnglish(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "Not specified";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => `${"  ".repeat(depth)}• ${formatPlainEnglish(item, depth + 1)}`)
      .join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        const formatted = formatPlainEnglish(item, depth + 1);
        const nested = typeof item === "object" && item !== null;
        return `${"  ".repeat(depth)}${humanizeKey(key)}:${nested ? "\n" : " "}${formatted}`;
      })
      .join("\n");
  }
  return String(value);
}

/**
 * A metric's own measurement, in the units it was taken in.
 *
 * The normalised 0-1 value is what the threshold compares against, but it is
 * not what an operator acts on: "0.70" does not tell you a call took nine
 * seconds. Metrics that are natively 0-1 return null — there is nothing to add.
 */
export function nativeMetricValue(metricId: string, value: number | null): string | null {
  if (value === null) return null;
  // Seconds on the wire; one formatter decides how a duration is written, so the
  // report and the trace tables stop spelling the same 1.73s two different ways.
  if (metricId === "ops.latency") return formatDuration(value * 1000);
  if (metricId.endsWith("_token_count")) {
    return `${Math.round(value).toLocaleString()} tokens`;
  }
  // Every other ops.* metric is a measurement too, and a measurement with no
  // formatter of its own still has a value worth showing. Without this,
  // ops.token_efficiency — which carries no verdict and so no normalised score
  // — fell through to "Not scored", which is false: it was measured.
  if (isMeasurement(metricId)) {
    return value.toLocaleString(undefined, { maximumSignificantDigits: 3 });
  }
  return null;
}

export function metricDisplayName(metricId: string): string {
  const leaf = metricId.includes(".") ? metricId.split(".").pop()! : metricId;
  return leaf.replace(/_/g, " ");
}

/** A configured judge is not evidence that a judge was invoked. */
export function judgeLabelForRun(run: RunResult): string {
  if (scoringMethodForRun(run).label === "Deterministic scoring") return "Not used · deterministic metrics";
  return run.lineage?.judge_model || run.experiment?.judge_model || "Not recorded";
}

export function scoringMethodForRun(run: RunResult): { label: string; detail: string } {
  const modes = new Set<string>();
  for (const result of run.metric_results) {
    const evaluator = (result.evaluator_id || "").toLowerCase();
    if (evaluator.includes("ragas")) modes.add("RAGAS");
    else if (evaluator.includes("deepeval")) modes.add("DeepEval");
    else if (evaluator.startsWith("trace.")) modes.add("Trace scoring");
    else if (evaluator === "builtin.trace" || evaluator === "builtin.native" || evaluator === "builtin.deterministic" || evaluator.startsWith("native.") || evaluator.startsWith("deterministic.")) modes.add("Deterministic scoring");
    else if (result.judge_model?.trim()) modes.add("LLM judge");
  }
  const judgedResults = run.metric_results.filter((result) => Boolean(result.judge_model?.trim()));
  const judgeModels = [
    ...new Set(
      judgedResults
        .map((result) => result.judge_model?.trim())
        .filter((model): model is string => Boolean(model)),
    ),
  ];

  if (modes.size > 1) {
    return {
      label: "Mixed scoring",
      detail: [...modes].join(" · "),
    };
  }

  const [onlyMode] = [...modes];
  if (onlyMode === "LLM judge") {
    return {
      label: "LLM judge",
      detail:
        judgeModels.length === 1
          ? `Model ${judgeModels[0]}`
          : `${judgeModels.length} judge models recorded`,
    };
  }

  if (onlyMode) {
    return {
      label: onlyMode,
      detail: `${run.metric_results.length} recorded scorer result${run.metric_results.length === 1 ? "" : "s"}`,
    };
  }

  return {
    label: "Not recorded",
    detail: "No metric provenance available",
  };
}

/** Family prefix → the heading the creation flow already uses for it. */
export const METRIC_FAMILY_LABELS: Record<string, string> = {
  ...Object.fromEntries(METRIC_GROUPS.map((group) => [group.id, group.label])),
  performance: "Operational measurements",
};

/** Why a family's red chip may not mean what it looks like. */
export const METRIC_FAMILY_NOTES: Record<string, string> = {
  diagnostics:
    "Word-overlap against the expected text, not correctness. A right answer " +
    "phrased differently scores low, so these read as signals rather than failures.",
  performance: "Automatically captured values; a measurement alone is not a pass/fail judgment.",
};

export interface MetricFamilyGroup<T> {
  prefix: string;
  label: string;
  note: string | null;
  items: T[];
}

/**
 * Group anything metric-shaped into the families the creation flow uses, in
 * that same order. Shared so the run report and a single case's results cannot
 * drift into different groupings of the same metrics. Families with no members
 * are dropped; anything outside the known prefixes falls into "Other" rather
 * than disappearing.
 */
export function groupByMetricFamily<T>(
  items: T[],
  metricId: (item: T) => string,
): Array<MetricFamilyGroup<T>> {
  const familyOf = (item: T) => /^(llm|agent|rag|safety|nlp|ops)\./.test(metricId(item)) ? metricMeaning({ metric_id: metricId(item) }) : "other";
  const known = Object.entries(METRIC_FAMILY_LABELS).map(([prefix, label]) => ({
    prefix,
    label,
    note: (METRIC_FAMILY_NOTES[prefix] ?? null) as string | null,
    items: items.filter((item) => familyOf(item) === prefix),
  }));
  return known.filter((family) => family.items.length > 0);
}

export interface MetricSummary {
  id: string;
  label: string;
  family: string;
  /**
   * Whether this metric can move the verdict. Diagnostics are scored and
   * thresholded but gate nothing, so a red chip on one is information — the
   * report has to say which it is rather than rendering both identically.
   */
  gating: boolean;
  /**
   * Mean of the metric's own units, where those differ from the normalised
   * score — seconds for latency, tokens for a count. `null` when the metric is
   * natively 0-1 and the normalised mean already says everything.
   */
  nativeMean: number | null;
  mean: number | null;
  caseCount: number;
  totalCases: number;
  threshold: number | null;
  thresholdVaries: boolean;
  worstGate: GateResult | null;
  state: "scored" | "unscored" | "not_applicable" | "technical_error";
  failingCount: number;
  warningCount: number;
  errorCount: number;
  results: MetricResult[];
}

export function metricResultIsScored(result: MetricResult): boolean {
  return result.metric_status === "scored" || (
    result.metric_status == null &&
    result.normalised_score !== null &&
    result.threshold_result !== null
  );
}

export function summarizeMetricScores(run: RunResult, totalCases: number): MetricSummary[] {
  const byMetric = new Map<string, MetricResult[]>();
  for (const result of run.metric_results || []) {
    const rows = byMetric.get(result.metric_id) ?? [];
    rows.push(result);
    byMetric.set(result.metric_id, rows);
  }

  const metricIds = new Set([...byMetric.keys(), ...(run.active_metrics || [])]);
  return [...metricIds]
    .map((id) => {
      const rows = byMetric.get(id) ?? [];
      const thresholds = [...new Set(rows.map((row) => row.threshold))];
      const failingCount = rows.filter((row) => row.threshold_result === "fail").length;
      const warningCount = rows.filter((row) => row.threshold_result === "warn").length;
      const errorCount = rows.filter((row) => row.metric_status === "technical_error").length;
      const applicableRows = rows.filter((row) => row.metric_applicability !== "not_applicable");
      const state: MetricSummary["state"] = rows.some((row) => row.metric_status === "technical_error")
        ? "technical_error"
        : rows.length > 0 && applicableRows.length === 0
          ? "not_applicable"
          : applicableRows.length > 0 && applicableRows.every(metricResultIsScored)
            ? "scored"
            : "unscored";
      const worstGate: GateResult | null = state !== "scored"
        ? null
        : failingCount
          ? "fail"
          : warningCount
            ? "warn"
            : applicableRows.length > 0 && applicableRows.every((row) => row.threshold_result === "pass")
              ? "pass"
              : null;
      const family = id.includes(".") ? id.split(".")[0] : "metric";
      const observedCases = new Set(rows.map((row) => row.row_id)).size;
      const scoredRows = rows.filter(
        (row): row is MetricResult & { normalised_score: number } =>
          row.normalised_score !== null && metricResultIsScored(row) && row.metric_applicability !== "not_applicable",
      );
      // Optional means diagnostic. Absent means unrecorded, and an unrecorded
      // requirement must not be shown as "does not gate" — default to gating so
      // the report never understates what a red chip costs.
      const gating = !rows.some((row) => row.metric_requirement === "optional");
      const nativeRows = rows.filter(
        (row): row is MetricResult & { score: number } =>
          typeof row.score === "number" && row.score !== row.normalised_score,
      );

      return {
        id,
        label: metricDisplayName(id),
        family,
        gating,
        nativeMean: nativeRows.length
          ? nativeRows.reduce((sum, row) => sum + row.score, 0) / nativeRows.length
          : null,
        mean: scoredRows.length
          ? scoredRows.reduce((sum, row) => sum + row.normalised_score, 0) / scoredRows.length
          : null,
        caseCount: observedCases,
        totalCases: Math.max(totalCases, observedCases),
        threshold: thresholds.length === 1 ? thresholds[0] : null,
        thresholdVaries: thresholds.length > 1,
        worstGate,
        state,
        failingCount,
        warningCount,
        errorCount,
        results: rows,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function qualityOutcomes(run: RunResult) {
  const byMetric = new Map<string, MetricResult[]>();
  for (const result of run.metric_results || []) {
    if (!result.metric_id.startsWith("quality.")) continue;
    const list = byMetric.get(result.metric_id) ?? [];
    list.push(result);
    byMetric.set(result.metric_id, list);
  }

  let met = 0;
  let partial = 0;
  let notMet = 0;
  let unavailable = 0;
  const groups = [...byMetric.entries()].map(([metricId, results]) => {
    const scored = results.filter(
      (row): row is MetricResult & { normalised_score: number } =>
          row.normalised_score !== null && metricResultIsScored(row) && row.metric_applicability !== "not_applicable",
    );
    const mean = scored.length
      ? scored.reduce((sum, row) => sum + row.normalised_score, 0) / scored.length
      : null;
    const passes = results.filter((row) => row.threshold_result === "pass").length;
    const warns = results.filter((row) => row.threshold_result === "warn").length;
    const fails = results.filter((row) => row.threshold_result === "fail").length;
    const applicable = results.filter((row) => row.metric_applicability !== "not_applicable");
    const state = results.some((row) => row.metric_status === "technical_error")
      ? "technical_error"
      : applicable.length === 0
        ? "not_applicable"
        : applicable.some((row) => !metricResultIsScored(row) || row.threshold_result === null)
          ? "not_scored"
          : fails > 0
            ? "fail"
            : warns > 0
              ? "warn"
              : passes === applicable.length
                ? "pass"
                : "not_scored";
    const gate: GateResult | null = state === "pass" || state === "warn" || state === "fail" ? state : null;
    const caseIds = [...new Set(results.map((row) => row.row_id))];
    const affectedCaseIds = [
      ...new Set(
        results
          .filter(
            (row) =>
              row.threshold_result !== "pass" ||
              Boolean(row.error_message) ||
              Boolean(row.execution_status && row.execution_status !== "success"),
          )
          .map((row) => row.row_id),
      ),
    ];
    if (gate === "pass") met += 1;
    else if (gate === "warn") partial += 1;
    else if (gate === "fail") notMet += 1;
    else unavailable += 1;
    return {
      metricId,
      label: metricDisplayName(metricId),
      mean,
      passes,
      warns,
      fails,
      gate,
      state,
      caseIds,
      affectedCaseIds,
      rationales: results
        .map((row) => row.rationale?.trim())
        .filter((text): text is string => Boolean(text))
        .slice(0, 8),
    };
  });

  const overall =
    groups.filter((group) => group.mean !== null).length === 0
      ? null
      : groups
          .filter((group): group is typeof group & { mean: number } => group.mean !== null)
          .reduce((sum, group) => sum + group.mean, 0) /
        groups.filter((group) => group.mean !== null).length;

  return { groups, met, partial, notMet, unavailable, overall };
}

export type QualityOutcome = ReturnType<typeof qualityOutcomes>;

/**
 * Metrics that did not cleanly pass, by the one definition the whole report
 * uses.
 *
 * The header and the panel beneath it previously counted this differently —
 * "10 metrics · 3 need attention" above "14 metrics · 7 need attention", on the
 * same card. The header counted only metrics with a score while the panel
 * counted every metric; and the panel treated a null gate as attention, which
 * swept in metrics that were legitimately not applicable.
 *
 * Not-applicable is a real answer, not a problem: a metric that could not apply
 * to this run is excluded. Unscored, technical errors, and warn/fail gates are
 * included.
 */
export function metricsNeedingAttention(metrics: MetricSummary[]): MetricSummary[] {
  return metrics.filter(
    (metric) =>
      metric.state === "unscored" ||
      metric.state === "technical_error" ||
      metric.errorCount > 0 ||
      metric.worstGate === "fail" ||
      metric.worstGate === "warn",
  );
}

/**
 * Metrics that are measurements rather than judgements.
 *
 * A latency or a token count has no declared budget to grade against, so the
 * backend records the captured value and no verdict. They belong in a
 * measurement band, not in a table whose columns are Average score, Case
 * coverage and Outcome.
 */
export function isMeasurement(metricId: string): boolean {
  return metricId.startsWith("ops.");
}

export interface MetricMeasurement {
  id: string;
  label: string;
  /** The captured value in its own units, already formatted. */
  value: string;
  /** Worst observed value, where the spread matters and a mean would hide it. */
  worst: string | null;
  sampleSize: number;
}

/**
 * The run's operational measurements, as facts rather than scores.
 *
 * Latency leads with its worst case: a mean of 11.6 s reads unremarkable while
 * a case took 23.7 s, and the tail is the part anyone acts on.
 */
export function metricMeasurements(run: RunResult): MetricMeasurement[] {
  const byMetric = new Map<string, number[]>();
  for (const result of run.metric_results || []) {
    if (!isMeasurement(result.metric_id)) continue;
    if (typeof result.score !== "number") continue;
    const values = byMetric.get(result.metric_id) ?? [];
    values.push(result.score);
    byMetric.set(result.metric_id, values);
  }
  return [...byMetric.entries()]
    .map(([id, values]) => {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const max = Math.max(...values);
      const spreadMatters = id === "ops.latency" && values.length > 1 && max > mean;
      return {
        id,
        label: metricDisplayName(id),
        value: nativeMetricValue(id, mean) ?? mean.toFixed(2),
        worst: spreadMatters ? nativeMetricValue(id, max) ?? max.toFixed(2) : null,
        sampleSize: values.length,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export type MetricTone = "pass" | "warn" | "fail" | "unknown";

/**
 * How a metric's own score should read, judged against that metric's threshold
 * rather than a global cutoff.
 *
 * A fixed "70% is green" rule painted 75% emerald beside a FAIL badge whenever
 * the metric's threshold was 80 — the number said healthy and the badge said
 * failed, on the same row. The recorded gate is authoritative where one exists;
 * otherwise the metric's own threshold decides; and where neither is known the
 * score gets no colour at all rather than a flattering one.
 */
export function metricTone(
  gate: GateResult | null,
  mean: number | null,
  threshold: number | null,
): MetricTone {
  if (gate === "pass") return "pass";
  if (gate === "warn") return "warn";
  if (gate === "fail") return "fail";
  if (mean === null) return "unknown";
  if (threshold === null) return "unknown";
  return mean >= threshold ? "pass" : "fail";
}

export function toneTextClass(tone: MetricTone): string {
  if (tone === "pass") return "text-emerald-700 dark:text-emerald-300";
  if (tone === "warn") return "text-amber-700 dark:text-amber-300";
  if (tone === "fail") return "text-red-700 dark:text-red-300";
  return "text-muted-foreground";
}

export function toneBarClass(tone: MetricTone): string {
  if (tone === "pass") return "bg-emerald-500";
  if (tone === "warn") return "bg-amber-500";
  if (tone === "fail") return "bg-red-500";
  return "bg-muted-foreground/40";
}

export function scoreColor(pct: number): string {
  if (pct >= 70) return "text-emerald-700 dark:text-emerald-300";
  if (pct >= 50) return "text-amber-700 dark:text-amber-300";
  return "text-red-700 dark:text-red-300";
}

export function barColor(pct: number): string {
  if (pct >= 70) return "bg-emerald-500";
  if (pct >= 50) return "bg-amber-500";
  return "bg-red-500";
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function attentionLabel(count: number, noun?: string): string {
  if (noun) {
    return `${countLabel(count, noun)} ${count === 1 ? "needs" : "need"} attention`;
  }
  return `${count} ${count === 1 ? "needs" : "need"} attention`;
}

export { formatDateTime as formatWhen } from "@/lib/format-time";

export function formatPercentValue(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

export function runEvidencePresentation(run: RunResult) {
  const requestedScope = run.lineage?.requested_evaluation_scope ?? null;
  const scope = run.lineage?.resolved_evaluation_scope ?? run.lineage?.evaluation_scope ?? run.experiment?.evaluation_scope ?? null;
  const scopeLabel = evaluationScopeLabel(scope);
  const requestedScopeLabel = evaluationScopeLabel(requestedScope);
  const scopeDetail = requestedScope && requestedScope !== scope
    ? `Requested ${requestedScopeLabel}; metrics or contract requirements expanded the effective scope`
    : scopeLabel === "Scope not recorded"
      ? "Historical scope metadata is unavailable"
      : "Resolved evidence scope used by this run";
  const verdictLabel = run.diagnostic_only
    ? "Diagnostic only"
    : run.verdict_status === "conclusive"
      ? "Conclusive"
      : run.verdict_status === "inconclusive"
        ? "Inconclusive"
        : run.verdict_status === "blocked"
          ? "Blocked"
          : "Not recorded";
  const verdictDetail = run.diagnostic_only
    ? "No release verdict or quality gate"
    : run.verdict_status === "conclusive"
      ? "Required evaluation results are complete"
      : run.verdict_status === "inconclusive"
        ? run.lineage?.exact_runtime_identity_required &&
          run.lineage?.target_identity_status === "unverified"
          ? "Exact runtime identity could not be attested"
          : "Required evidence or scoring is incomplete"
        : run.verdict_status === "blocked"
          ? run.lineage?.target_identity_status === "mismatched"
            ? "Observed target identity did not match the resolved target"
            : "Evaluation could not proceed"
          : "Historical verdict metadata is unavailable";
  const captureLabel =
    run.evidence_capture_status === "complete"
      ? "Complete"
      : run.evidence_capture_status === "partial"
        ? "Partial"
        : run.evidence_capture_status === "not_captured"
          ? "Not captured"
          : run.evidence_capture_status === "unknown"
            ? "Unknown"
            : "Not recorded";

  return { scopeLabel, scopeDetail, verdictLabel, verdictDetail, captureLabel };
}

export function runEvidenceContractPresentation(run: RunResult) {
  const lineageRequirements = run.lineage?.effective_evidence_requirements ?? [];
  const readinessRequirements = run.evidence_readiness?.effective_evidence_requirements ?? [];
  const effectiveRequirements =
    lineageRequirements.length > 0 ? lineageRequirements : readinessRequirements;
  if (effectiveRequirements.length === 0) return null;

  const lineageMetricDependencies = run.lineage?.metric_evidence_requirements ?? {};
  const metricDependencies = Object.entries(
    Object.keys(lineageMetricDependencies).length > 0
      ? lineageMetricDependencies
      : run.evidence_readiness?.metric_evidence_requirements ?? {},
  ).sort(([left], [right]) => left.localeCompare(right));
  const manifestHash = run.lineage?.run_manifest_hash ?? null;
  const configurationHash = run.lineage?.run_configuration_hash ?? null;
  const configurationFingerprint = manifestHash ?? configurationHash;
  const metricRequirements = [...(run.lineage?.metric_requirements ?? [])].sort(
    (left, right) => left.metric_id.localeCompare(right.metric_id),
  );
  const kpiCompositions = [...(run.lineage?.kpi_compositions ?? [])].sort(
    (left, right) => left.kpi_id.localeCompare(right.kpi_id),
  );
  const source = manifestHash
    ? "Immutable run manifest"
    : configurationHash
      ? "Resolved run configuration"
    : run.lineage?.run_manifest_id
      ? "Historical run manifest"
      : "Run readiness snapshot";

  return {
    effectiveRequirements,
    metricDependencies,
    configurationFingerprint,
    metricRequirements,
    kpiCompositions,
    source,
    // "categories", not "required categories". This is the contract's whole
    // category list; the table below marks one of them Not required when the
    // run demonstrably cannot owe it — a target with no retrieval stage. The
    // old wording made the header contradict the table directly under it.
    summary: `${effectiveRequirements.length} evidence categor${effectiveRequirements.length === 1 ? "y" : "ies"}`,
  };
}

export type CaseCounts = {
  passed: number;
  warned: number;
  failed: number;
  total: number;
  notScored: number;
};

/**
 * Case outcomes derived from a run's own `metric_results`.
 *
 * This is the fallback half of the report's pass-rate calculation, extracted
 * because a second surface needs it: the experiment page has no loaded
 * `RunItemSummary[]` and never will, so it can only count from the metric rows.
 *
 * The report keeps its preference order — loaded items first, these rows second
 * — inline, because that half has one caller. What is shared is this derivation,
 * and sharing it means the two surfaces cannot drift on what "warned" means.
 *
 * A case counts as warned when every one of its rows was scored, none failed,
 * and they were not all passes; "not scored" is reserved for rows the run never
 * reached a verdict on. Returns null when the run carries no metric rows at all,
 * which is a different statement from "zero cases passed".
 */
export function caseCountsFromMetrics(run: RunResult): CaseCounts | null {
  const rows = run.metric_results ?? [];
  if (!rows.length) return null;

  const rowIds = new Set(rows.map((row) => row.row_id));
  let passed = 0;
  let warned = 0;
  let failed = 0;
  for (const rowId of rowIds) {
    // Only gated rows can carry a verdict. Operational counters — latency, token
    // counts — have no threshold by design, and requiring *every* row to read
    // "pass" meant a single ungated counter made a fully passing case count as
    // "not scored". Every case on a run with ops metrics did, so "cases passed"
    // was structurally always zero and "cases not scored" measured nothing but
    // the presence of counters.
    const caseRows = rows.filter((row) => row.row_id === rowId);
    const gatedRows = caseRows.filter((row) => row.threshold_result != null);
    // A row that was meant to gate and never reached a verdict is not the same
    // as one that never gates by design. `threshold_result: null` covers both —
    // an ops counter has no threshold, but so does a required check whose
    // evaluator crashed or abstained. Treating them alike let a case whose
    // required check errored count as passed on the strength of its siblings.
    // The distinguishing fields are on the row already.
    const withheld = caseRows.some(
      (row) =>
        row.threshold_result == null &&
        row.metric_requirement !== "optional" &&
        (row.metric_status === "technical_error" ||
          row.metric_status === "unscored" ||
          row.unscored_reason != null),
    );
    if (gatedRows.length === 0 || withheld) continue;
    if (gatedRows.some((row) => row.threshold_result === "fail")) failed += 1;
    else if (gatedRows.every((row) => row.threshold_result === "pass")) passed += 1;
    // Gated throughout, nothing failed, not all passes: at least one warn.
    else warned += 1;
  }

  return {
    passed,
    warned,
    failed,
    total: rowIds.size,
    notScored: rowIds.size - passed - warned - failed,
  };
}
