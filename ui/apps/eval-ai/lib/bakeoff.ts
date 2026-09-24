import type { DatasetRunRequest, LlmCatalogEntry } from "@/lib/api";
import { MAX_COMPARISON_RUNS, MIN_COMPARISON_RUNS } from "@/lib/comparison-href";

/**
 * A bakeoff can never be wider than the comparison it exists to produce, so the
 * selection cap is the compare cap — not a second number that can drift from it.
 */
export const MAX_BAKEOFF_TARGETS = MAX_COMPARISON_RUNS;

/**
 * Tags the backend owns. `PATCH /experiments/{id}` rejects a payload that names
 * any of them (422 `reserved_experiment_tags`) and re-applies the existing
 * values itself, so a client tag write must strip them rather than echo them.
 * Mirrors `RESERVED_EXPERIMENT_TAGS` in `api/v1/evaluation.py`.
 */
const RESERVED_EXPERIMENT_TAGS = [
  "workspace_kind",
  "pending_first_run",
  "promoted_to",
  "one_off_diagnostic",
];

/** Run states the backend never leaves on its own. */
const TERMINAL_RUN_STATUSES = ["completed", "failed", "blocked", "cancelled"];

/** One selected model and whatever has happened to it since. */
export interface BakeoffTarget {
  modelId: string;
  /** Null until the enqueue returns, and permanently null if it failed. */
  runId: string | null;
  /** Last polled run status, lowercased. Null before the first poll. */
  status: string | null;
  /** Why this target never launched, or why its run ended badly. */
  error: string | null;
}

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return TERMINAL_RUN_STATUSES.includes((status || "").toLowerCase());
}

export function completedComparisonHref(workspaceId: string | null, targets: BakeoffTarget[]): string | null {
  const completed = targets.filter(isCompletedTarget);
  if (!workspaceId || completed.length < MIN_COMPARISON_RUNS) return null;
  const query = new URLSearchParams();
  completed.forEach((target, index) => {
    query.append(index === 0 ? "baseline_run_id" : "candidate_run_id", target.runId!);
  });
  return `/evaluations/${encodeURIComponent(workspaceId)}/compare?${query}`;
}

function isCompletedTarget(target: BakeoffTarget): boolean {
  return Boolean(target.runId) && (target.status || "").toLowerCase() === "completed";
}

/**
 * The same evaluation request, pointed at a different model.
 *
 * Only the target varies: the backend's comparison basis covers dataset
 * version, cases, metrics, scoring contract and judge config, and deliberately
 * excludes the target model as the variable under test
 * (`evaluation/lineage.py`). Change anything else and the runs stop being
 * comparable — which is why this takes a built request rather than rebuilding
 * one from inputs.
 */
export function withTarget(
  request: DatasetRunRequest,
  model: LlmCatalogEntry,
): DatasetRunRequest {
  return {
    ...request,
    target_model: model.model_id,
    // Mirrors `buildDatasetRunRequest`: a custom entry carries its own base
    // URL, a catalog entry falls back to the sentinel the backend resolves.
    target_endpoint: model.endpoint?.trim() || `llm-catalog:${model.model_id}`,
  };
}

/**
 * The same evaluation request, pointed at a different saved prompt.
 *
 * The sibling of `withTarget`, and for the same reason: the comparison basis
 * excludes the prompt as a variable under test, so runs differing only by
 * prompt version group into one comparison.
 */
export function withPrompt(request: DatasetRunRequest, promptRef: string): DatasetRunRequest {
  return {
    ...request,
    prompt_version_ref: promptRef,
    // A saved prompt and ad-hoc text are mutually exclusive; the backend 422s
    // when both arrive, so the ref clears whatever was typed.
    system_prompt: null,
  };
}

export type GroupingDecision =
  | { ready: true; runIds: string[]; baselineRunId: string }
  | { ready: false; reason: "still-running" | "too-few-completed" };

/**
 * Whether the launched runs can now be grouped into a workspace.
 *
 * Two rules, both enforced by the backend and therefore not optional here:
 * a run that has not completed cannot join a workspace at all
 * (`_validated_workspace_runs` raises 409), and a comparison needs at least
 * `MIN_COMPARISON_RUNS` runs to mean anything.
 *
 * The wait is for *every* launched run to reach a terminal state, not for the
 * first two to complete. Grouping early would close the workspace around a
 * subset and leave later finishers permanently outside it — `from-runs` is a
 * one-shot call and nothing re-opens it.
 */
export function groupingDecision(targets: BakeoffTarget[]): GroupingDecision {
  const launched = targets.filter((target) => target.runId);
  if (launched.some((target) => !isTerminalRunStatus(target.status))) {
    return { ready: false, reason: "still-running" };
  }
  const completed = launched.filter(isCompletedTarget);
  if (completed.length < MIN_COMPARISON_RUNS) {
    return { ready: false, reason: "too-few-completed" };
  }
  const runIds = completed.map((target) => target.runId as string);
  // First completed in the order the user selected: deterministic, and always
  // inside `run_ids` — `from-runs` 422s when the baseline is not one of them.
  return { ready: true, runIds, baselineRunId: runIds[0] };
}

/** Requested vs actually launched, for an honest "3 of 4". */
export function launchTally(targets: BakeoffTarget[]): {
  requested: number;
  completed: number;
} {
  return {
    requested: targets.length,
    completed: targets.filter(isCompletedTarget).length,
  };
}

/**
 * The full tag map to send with `PATCH /experiments/{id}`.
 *
 * The endpoint *replaces* non-reserved tags rather than merging them, so
 * existing tags must be re-sent or they are silently dropped. Reserved tags are
 * stripped: naming one is a 422, and the backend re-applies them regardless.
 */
export function bakeoffTagMap(
  existingTags: Record<string, string> | null | undefined,
  targets: BakeoffTarget[],
): Record<string, string> {
  const carried = Object.fromEntries(
    Object.entries(existingTags || {}).filter(
      ([key]) => !RESERVED_EXPERIMENT_TAGS.includes(key),
    ),
  );
  const tally = launchTally(targets);
  return {
    ...carried,
    bakeoff_requested_models: targets.map((target) => target.modelId).join(","),
    bakeoff_requested_count: String(tally.requested),
    bakeoff_completed_count: String(tally.completed),
  };
}

/**
 * What the workspace should say it compared. Reads "3 of 4" whenever a
 * requested model never produced a run, so a bakeoff that lost a target can
 * never be mistaken for a smaller one that was asked for.
 */
export function describeTally(tally: { requested: number; completed: number }, subject = "models"): string {
  return tally.completed === tally.requested
    ? `${tally.requested} ${subject}`
    : `${tally.completed} of ${tally.requested} ${subject}`;
}
