import type { BadgeTone } from "@/components/status-badge";
import type { MetricResult, RunItemSummary, RunResult } from "@/lib/api";

/**
 * Presentation-only interpretation of the backend's independent run states.
 * It selects copy and tone; it never writes or synthesizes backend truth.
 */
export type PresentedRunOutcome = {
  kind:
    | "pending"
    | "running"
    | "error"
    | "cancelled"
    | "blocked"
    | "diagnostic"
    | "inconclusive"
    | "partial_evidence"
    | "pass"
    | "warn"
    | "fail"
    | "not_recorded";
  label: string;
  gate: RunResult["overall_gate"];
  /**
   * Whether a quality contract stands behind this outcome.
   *
   * `label` already carries this — it says "Pass · ungoverned" — but a caller
   * that composes its own headline (the run report title) cannot recover the
   * fact from a string without sniffing it. Every renderer that claims a verdict
   * needs to know, so it is a field rather than a suffix to parse.
   */
  governed: boolean;
  /**
   * The verdict word alone — "Pass", never "Pass · ungoverned".
   *
   * For a surface that already states governance separately (the run table has
   * its own Governance column), the suffix is duplicated information, and it
   * wraps a badge onto two lines to say something the next cell already says.
   * Use `label` anywhere the badge stands alone; use this only where governance
   * is independently visible.
   */
  shortLabel: string;
  scoreLabel: string;
  observedScoreLabel: string;
};

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function gatedRunScore(run: RunResult): number | null {
  if (run.verdict_status !== "conclusive" || !run.overall_gate) return null;
  return mean(
    (run.kpi_results ?? [])
      .map((kpi) => kpi.composite_score)
      .filter((score): score is number => score !== null),
  );
}

export function observedRunScore(run: RunResult): number | null {
  // A mean over KPI observed values is not evidence that anything was scored.
  // `gatedRunScore` above refuses without a conclusive verdict; this had no
  // guard at all, so a run where every case went unscored still printed a
  // plausible percentage. When the run reports coverage counts and all of them
  // are zero, the honest answer is that there is no score. Runs from before
  // those counts existed report none, and keep their previous behaviour rather
  // than silently losing a score they legitimately have.
  const scoredCounts = (run.kpi_results ?? []).flatMap((kpi) =>
    [kpi.required_scored_count, kpi.optional_scored_count].filter(
      (count): count is number => typeof count === "number",
    ),
  );
  if (scoredCounts.length > 0 && scoredCounts.every((count) => count === 0)) return null;
  return mean(
    (run.kpi_results ?? [])
      .map((kpi) => kpi.observed_score ?? kpi.composite_score)
      .filter((score): score is number => score !== null),
  );
}

/**
 * How much of the run the score actually covers, when the run says.
 *
 * The score's denominator excludes unscored cases — defensible, and the usual
 * convention, but only when the exclusion is stated. It was not stated
 * anywhere: `coverage_label` has shipped since #2642 and nothing rendered it,
 * so a 94% over half the cases read identically to 94% over all of them.
 */
export function runCoverageSummary(run: RunResult): string | null {
  const kpis = run.kpi_results ?? [];
  const scored = kpis.reduce((total, kpi) => total + (kpi.required_scored_count ?? 0), 0);
  const applicable = kpis.reduce((total, kpi) => total + (kpi.required_applicable_pair_count ?? 0), 0);
  if (applicable === 0) return null;
  if (scored >= applicable) return null; // complete coverage needs no caveat
  return `${scored} of ${applicable} required checks scored`;
}

/**
 * Which score a run actually has, and on what basis.
 *
 * A run with no gate still records an observed score, and the two surfaces that
 * show it disagreed: the trend chart plotted the observed value while the row
 * beside it printed the gated one as an em dash, neither saying which basis it
 * used. One helper, so a caller cannot show a number without saying where it
 * came from.
 *
 * `presentRunOutcome` is deliberately left alone — sixteen files render its
 * `scoreLabel`, and its contract is "the gated score, or an em dash". This is
 * for callers that want the honest fallback instead.
 */
export type RunScoreBasis = {
  value: number | null;
  basis: "gated" | "observed" | null;
};

export function runScoreBasis(run: RunResult): RunScoreBasis {
  const gated = gatedRunScore(run);
  if (gated !== null) return { value: gated, basis: "gated" };
  const observed = observedRunScore(run);
  if (observed !== null) return { value: observed, basis: "observed" };
  return { value: null, basis: null };
}

/** The score with its basis stated, or the named absence. Never a bare dash. */
export function runScoreLabel(run: RunResult): string {
  const { value, basis } = runScoreBasis(run);
  if (value === null) return "Not scored";
  const percent = `${(value * 100).toFixed(0)}%`;
  return basis === "observed" ? `${percent} observed · not gated` : percent;
}

function percentage(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(0)}%`;
}

export function presentRunOutcome(run: RunResult): PresentedRunOutcome {
  const scoreLabel = percentage(gatedRunScore(run));
  const observedScoreLabel = percentage(observedRunScore(run));
  const governed = Boolean(run.quality_profile_id || run.lineage?.quality_profile_id);
  if (run.status === "pending") return { kind: "pending", label: "Pending", gate: null, governed, shortLabel: "Pending", scoreLabel, observedScoreLabel };
  if (run.status === "running") return { kind: "running", label: "Running", gate: null, governed, shortLabel: "Running", scoreLabel, observedScoreLabel };
  if (run.status === "awaiting_trace") {
    return { kind: "running", label: "Response ready · evidence pending", gate: null, governed, shortLabel: "Response ready · evidence pending", scoreLabel, observedScoreLabel };
  }
  if (run.status === "completed_with_partial_evidence") {
    // One line. Beside "Pass", "Fail" and "Inconclusive" in the same column,
    // the longer phrase was the only badge that wrapped, and it made every row
    // carrying it two lines tall.
    return { kind: "partial_evidence", label: "Partial evidence", gate: null, governed, shortLabel: "Partial evidence", scoreLabel, observedScoreLabel };
  }
  if (run.status === "failed") return { kind: "error", label: "Did not finish", gate: null, governed, shortLabel: "Did not finish", scoreLabel, observedScoreLabel };
  if (run.status === "cancelled") return { kind: "cancelled", label: "Stopped", gate: null, governed, shortLabel: "Stopped", scoreLabel, observedScoreLabel };
  if (run.status === "blocked" || run.verdict_status === "blocked") {
    return { kind: "blocked", label: "Blocked", gate: null, governed, shortLabel: "Blocked", scoreLabel, observedScoreLabel };
  }
  if (run.diagnostic_only) {
    return { kind: "diagnostic", label: "Diagnostic only", gate: null, governed, shortLabel: "Diagnostic only", scoreLabel, observedScoreLabel };
  }
  if (run.verdict_status === "inconclusive") {
    return { kind: "inconclusive", label: "Inconclusive", gate: null, governed, shortLabel: "Inconclusive", scoreLabel, observedScoreLabel };
  }
  if (run.verdict_status === "conclusive" && run.overall_gate) {
    const labels = { pass: "Pass", warn: "Warn", fail: "Fail" } as const;
    // The gate is real — thresholds were applied and metrics genuinely passed
    // or failed against them — but without a quality contract behind it, it is
    // not a governed verdict. Saying only "Pass" claimed more than the run can
    // support; calling the whole thing "Diagnostic" would claim less than it
    // measured. Say which it is.
    return {
      kind: run.overall_gate,
      label: governed ? labels[run.overall_gate] : `${labels[run.overall_gate]} · ungoverned`,
      gate: run.overall_gate,
      governed,
      shortLabel: labels[run.overall_gate],
      scoreLabel,
      observedScoreLabel,
    };
  }
  return { kind: "not_recorded", label: "Outcome not recorded", gate: null, governed, shortLabel: "Outcome not recorded", scoreLabel, observedScoreLabel };
}

/**
 * One state, one name, one colour.
 *
 * The names were deduplicated first, but each caller still picked its own colour
 * for them — amber here, muted there, plain grey text somewhere else — so "Pass"
 * arrived as a green badge while "Inconclusive" arrived as unstyled text, and the
 * runs that were fine looked more important than the runs that were not. The tone
 * belongs with the label that earns it, not with whoever happens to render it.
 *
 * Neutral is for states that are nobody's problem: not yet started, still running,
 * deliberately diagnostic, or genuinely not applicable. Everything that needs a
 * human gets warn or fail.
 */
export const OUTCOME_TONES: Record<
  PresentedRunOutcome["kind"] | PresentedCaseOutcome["kind"],
  BadgeTone
> = {
  pass: "pass",
  warn: "warn",
  fail: "fail",
  error: "fail",
  technical_error: "fail",
  blocked: "fail",
  inconclusive: "warn",
  partial_evidence: "warn",
  unscored: "warn",
  not_recorded: "warn",
  pending: "neutral",
  running: "neutral",
  cancelled: "neutral",
  diagnostic: "neutral",
  not_applicable: "neutral",
};

/**
 * A metric's score, or the named reason it has none.
 *
 * `normalised_score` is not on its own evidence that a score is real: a metric
 * whose scorer crashed can still carry one, and rendering it produced a
 * "100.0%" sitting beside that metric's own "Scorer error recorded" label. The
 * state has to be read before the number. Two surfaces disagreed here because
 * each decided separately — the run-item inspector checked the state, the case
 * explorer checked only for null — so the decision lives in one place now.
 */
export function metricScoreLabel(result: MetricResult): string {
  if (result.metric_applicability === "not_applicable") return "Not applicable";
  if (result.metric_status === "technical_error") return "Scorer error";
  // A simulated result is not a measurement, so it never renders as one.
  if (result.unscored_reason === "simulated") return "Simulated - no real judge ran";
  if (result.normalised_score === null) return "Not scored";
  return `${(result.normalised_score * 100).toFixed(1)}%`;
}

/**
 * Whether this metric may show a pass/fail badge at all.
 *
 * A gate beside a crashed scorer claims a verdict the evidence cannot support,
 * which is the same lie as the score itself.
 */
export function metricHasVerdict(result: MetricResult): boolean {
  return (
    result.metric_applicability !== "not_applicable" &&
    result.metric_status !== "technical_error" &&
    result.unscored_reason !== "simulated" &&
    result.normalised_score !== null
  );
}

export type PresentedCaseOutcome = {
  kind: "pass" | "warn" | "fail" | "unscored" | "not_applicable" | "technical_error" | "not_recorded";
  label: string;
  gate: RunItemSummary["worst_gate"];
};

/** Presentation-only case label derived from the backend's metric-state counts. */
export function presentCaseOutcome(item: RunItemSummary): PresentedCaseOutcome {
  if (item.evaluation_state === "technical_error" || item.evaluation_state === "output_too_large" || item.error_count > 0) {
    return { kind: "technical_error", label: "Technical error", gate: null };
  }
  // Required metrics only. A provided-response run cannot measure latency or
  // token usage, so five optional metrics go unscored on every case — and
  // counting those made all four cases of such a run read "Partially scored",
  // which is checked before the verdict and therefore hid the three that had a
  // REQUIRED metric fail. What a case answers for is what was required of it.
  const unscoredRequired = item.unscored_required_count ?? item.unscored_count ?? 0;
  if (unscoredRequired > 0) {
    const label = (item.scored_count ?? 0) > 0 ? "Partially scored" : "Not scored";
    return { kind: "unscored", label, gate: null };
  }
  if ((item.scored_count ?? 0) === 0 && (item.not_applicable_count ?? 0) > 0) {
    return { kind: "not_applicable", label: "Not applicable", gate: null };
  }
  if (item.worst_gate) {
    const labels = { pass: "Pass", warn: "Warn", fail: "Fail" } as const;
    return { kind: item.worst_gate, label: labels[item.worst_gate], gate: item.worst_gate };
  }
  // Each state answers to one name, and the name matches the state: "Unscored"
  // and "Not scored" sat in this one function as synonyms, so a reader had no way
  // to tell they described different things. Nothing captured is "Not recorded";
  // captured but unscored is "Not scored".
  return { kind: "not_recorded", label: "Not recorded", gate: null };
}
