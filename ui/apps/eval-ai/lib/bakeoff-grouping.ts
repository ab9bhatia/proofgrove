import { evaluationApi } from "@/lib/api";
import {
  bakeoffTagMap,
  groupingDecision,
  isTerminalRunStatus,
  type BakeoffTarget,
} from "@/lib/bakeoff";
import { readLaunches, updateLaunch, type BakeoffLaunch } from "@/lib/bakeoff-store";

/**
 * Re-poll every launched run that has not finished yet.
 *
 * Shared by the launcher (which polls for display) and the reconciler (which
 * polls to decide when to group), so both agree on what a target's state means.
 */
export async function refreshTargets(
  targets: BakeoffTarget[],
  tenantId: string,
  reportErrors = false,
): Promise<BakeoffTarget[]> {
  return Promise.all(
    targets.map(async (target) => {
      if (!target.runId || isTerminalRunStatus(target.status)) return target;
      try {
        const run = await evaluationApi.getRun(target.runId, tenantId);
        const status = ((run as { status?: string }).status || "").toLowerCase();
        const message = (run as { error_message?: string | null }).error_message;
        return {
          ...target,
          status,
          error: status === "failed" ? message || "Run failed" : target.error,
        };
      } catch (error) {
        if (reportErrors) throw error;
        // A failed read is not a failed run — leave the target alone and retry.
        return target;
      }
    }),
  );
}

/** Run `fn` under a cross-tab lock where the browser supports one. */
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as { locks?: LockManager }).locks;
  if (!locks) return fn();
  return locks.request(name, fn) as Promise<T>;
}

/**
 * Group a launch's completed runs into one workspace, at most once.
 *
 * `from-runs` is not idempotent — every call mints a fresh workspace — so this
 * takes a cross-tab lock and re-reads the persisted record inside it rather
 * than trusting the caller's snapshot, which may have been read before another
 * tab grouped the same launch.
 *
 * That closes the two-tab window but NOT the lost-response one: if the POST
 * commits server-side and the response never arrives, a later retry still
 * creates a second workspace. Closing that needs a backend idempotency key
 * (see the issue's accepted risks).
 *
 * Returns the workspace id, or null when the launch is not groupable yet.
 */
export async function groupLaunch(launch: BakeoffLaunch): Promise<string | null> {
  return withLock(`bakeoff:${launch.launchId}`, async () => {
    const current = readLaunches().find((entry) => entry.launchId === launch.launchId);
    // No stored record means this launch was already handled and pruned — NOT
    // that it still needs grouping. Falling back to the caller's snapshot here
    // is what let a second pass re-POST `from-runs` and mint a twin.
    if (!current) return null;
    if (current.workspaceId) return current.workspaceId;

    const decision = groupingDecision(current.targets);
    if (!decision.ready) return null;

    const summary = await evaluationApi.createExperimentFromRuns({
      tenant_id: current.tenantId,
      name: current.evaluationName?.trim() || `Comparison — ${current.datasetName}`,
      run_ids: decision.runIds,
      baseline_run_id: decision.baselineRunId,
    });
    const workspaceId = summary.experiment.experiment_id as string;
    updateLaunch(current.launchId, { workspaceId, groupedAt: new Date().toISOString() });

    // Tags are a nicety — the workspace and its comparison are already correct
    // without them. A failure here must never cost the user the workspace they
    // just paid for, so it is swallowed rather than thrown.
    try {
      await evaluationApi.patchExperiment(workspaceId, {
        tenant_id: current.tenantId,
        tags: bakeoffTagMap(summary.experiment.tags, current.targets),
      });
    } catch {
      // Intentionally ignored; the workspace id below is what matters.
    }
    // The record is deliberately kept, carrying its workspace id: the launch
    // screen polls it to learn where to send the user, and its presence keeps
    // any later pass from grouping these runs again. `writeLaunches` prunes it
    // once it is old enough to be of no use to anyone.
    return workspaceId;
  });
}
