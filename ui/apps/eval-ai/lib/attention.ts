import type { RunResult } from "@/lib/api";
import { presentRunOutcome } from "@/lib/run-outcome";

function isCompleted(run: RunResult): boolean {
  return run.status === "completed" || Boolean(run.completed_at);
}

/**
 * Identity of the lineage a run belongs to. `experiment_id` comes first because
 * two distinct lineages can carry the same display name, and the evaluations
 * library groups by `experiment_id` too. Keying on the name merged them, so a
 * failing lineage disappeared from the attention queue behind a newer,
 * same-named one that passed. The name is only a fallback for historical runs
 * that recorded no experiment identity at all.
 */
function evaluationKey(run: RunResult): string {
  const experimentId = run.experiment?.experiment_id?.trim();
  if (experimentId) return `experiment:${experimentId}`;
  const name = run.experiment?.tags?.evaluation_name?.trim() || run.experiment?.name?.trim();
  if (name) return `name:${name.toLocaleLowerCase()}`;
  return `run:${run.run_id}`;
}

function runTime(run: RunResult): number {
  const value = run.completed_at || run.started_at;
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function latestCompletedRuns(runs: RunResult[]): RunResult[] {
  const latest = new Map<string, RunResult>();
  for (const run of [...runs].filter(isCompleted).sort((a, b) => runTime(b) - runTime(a))) {
    const key = evaluationKey(run);
    if (!latest.has(key)) latest.set(key, run);
  }
  return [...latest.values()];
}

/**
 * Every evaluation whose latest completed run is non-passing, newest first.
 * Shared by Overview and Reviews so both surfaces count the same runs.
 */
export function runsNeedingAttention(latest: RunResult[]): RunResult[] {
  return latest
    .filter((run) => ["fail", "warn", "inconclusive", "blocked", "error"].includes(presentRunOutcome(run).kind))
    .sort((a, b) => runTime(b) - runTime(a));
}

/** Run population the attention set was computed over. */
export interface AttentionCoverage {
  /** Runs actually read. */
  scanned: number;
  /** Full run count the server reports for the tenant. */
  total: number;
}

/**
 * Count line for the attention section. The population is one latest run per
 * evaluation, which every surface calls an "evaluation" — the noun here matches
 * so Overview and Reviews cannot appear to count different things. The trailing
 * coverage clause counts raw runs, because that is what the scan actually read.
 *
 * When the scan could not reach every run the label says so — a governance
 * queue never presents a truncated population as the whole one.
 */
export function attentionCountLabel(count: number, coverage: AttentionCoverage): string {
  const evaluations = `${count} evaluation${count === 1 ? "" : "s"}`;
  if (coverage.scanned >= coverage.total) return evaluations;
  return `${evaluations} in the newest ${coverage.scanned} of ${coverage.total} runs`;
}

/**
 * Sentence-form coverage caveat for surfaces that state the attention count in
 * prose, or `null` when the scan read every run.
 */
export function attentionCoverageNote(coverage: AttentionCoverage): string | null {
  if (coverage.scanned >= coverage.total) return null;
  return `Scanned the newest ${coverage.scanned} of ${coverage.total} runs — older evaluations are not covered.`;
}

/** How many attention rows the overview previews before deferring to /reviews. */
export const ATTENTION_PREVIEW_LIMIT = 4;

/** Deep link from Reviews attention rows into the run report attention filter. */
export function attentionRunHref(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}?case=attention`;
}
