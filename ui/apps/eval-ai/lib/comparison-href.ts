import type { RunResult } from "@/lib/api";
import { runComparisonKey } from "@/lib/chart-data";

export const MIN_COMPARISON_RUNS = 2;
export const MAX_COMPARISON_RUNS = 4;

export function isRunComplete(run: RunResult): boolean {
  const status = (run.status || "").toLowerCase();
  return status === "completed" || Boolean(run.metric_results?.length);
}

/**
 * Cohort key for compare affordances, delegated to the single basis rule in
 * `lib/chart-data` so a link is only ever offered for a pair the backend
 * (`store.compare_runs`) actually accepts: same `comparison_basis_hash` AND
 * same `comparison_basis_version`, with an exact `experiment_version_id`
 * fallback only when neither run recorded a basis hash. Sharing an
 * `experiment_id` is not a comparison basis and never was one server-side.
 */
export function comparisonKey(run: RunResult): string | null {
  return runComparisonKey(run);
}

/**
 * Build a compare-page deep link for 2–4 complete runs that share a comparison
 * basis. When `baselineRunId` is set it is used as the baseline; otherwise the
 * chronologically oldest run is the baseline.
 */
export function comparisonHrefForRuns(
  selectedRuns: RunResult[],
  baselineRunId?: string,
): string | null {
  if (
    selectedRuns.length < MIN_COMPARISON_RUNS ||
    selectedRuns.length > MAX_COMPARISON_RUNS ||
    selectedRuns.some((run) => !isRunComplete(run))
  ) {
    return null;
  }

  const comparisonKeys = selectedRuns.map(comparisonKey).filter(Boolean);
  if (comparisonKeys.length !== selectedRuns.length || new Set(comparisonKeys).size !== 1) {
    return null;
  }

  const chronological = [...selectedRuns].sort(
    (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
  );
  const base = baselineRunId
    ? selectedRuns.find((run) => run.run_id === baselineRunId)
    : chronological[0];
  if (!base) return null;
  const candidates = baselineRunId
    ? selectedRuns.filter((run) => run.run_id !== baselineRunId)
    : chronological.slice(1);
  const experimentId = base.experiment?.experiment_id;
  if (!experimentId || candidates.length === 0) return null;
  const candidateQuery = candidates
    .map((candidate) => `candidate_run_id=${encodeURIComponent(candidate.run_id)}`)
    .join("&");
  return `/evaluations/${encodeURIComponent(experimentId)}/compare?baseline_run_id=${encodeURIComponent(base.run_id)}&${candidateQuery}`;
}

/**
 * From a run report, pick this run as baseline plus comparable sibling runs
 * (same comparison key, complete) up to the compare-page limit.
 */
export function comparableRunsForReport(
  thisRun: RunResult,
  siblingRuns: RunResult[],
): RunResult[] {
  const key = comparisonKey(thisRun);
  if (!key || !isRunComplete(thisRun)) return [thisRun];
  const peers = siblingRuns.filter(
    (run) =>
      run.run_id !== thisRun.run_id &&
      isRunComplete(run) &&
      comparisonKey(run) === key,
  );
  // Prefer newest peers so the candidate set reflects recent work.
  const sortedPeers = [...peers].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
  );
  const maxPeers = MAX_COMPARISON_RUNS - 1;
  return [thisRun, ...sortedPeers.slice(0, maxPeers)];
}

export function compareHrefFromRunReport(
  thisRun: RunResult,
  siblingRuns: RunResult[],
): string | null {
  return comparisonHrefForRuns(
    comparableRunsForReport(thisRun, siblingRuns),
    thisRun.run_id,
  );
}

export function compareDisabledReasonFromRunReport(
  thisRun: RunResult,
  siblingRuns: RunResult[],
): string | null {
  if (compareHrefFromRunReport(thisRun, siblingRuns)) return null;
  if (!isRunComplete(thisRun)) {
    return "Compare is available after this run completes";
  }
  const key = comparisonKey(thisRun);
  if (!key) {
    return "This run has no comparison basis to match against siblings";
  }
  return "Need at least one other completed run that shares this comparison basis";
}
