import { api, evaluationApi, type ExperimentDefinition, type JobStatus, type RunResult, type Scenario } from "@/lib/api";
import { recallRunForm, recallRunLabel } from "@/lib/run-form-memory";

const STORAGE_KEY = "evalhub:active-run-ids";
const FIRST_SEEN_KEY = "evalhub:run-first-seen";
const ACTIVE = new Set(["pending", "running", "awaiting_trace"]);

function isRunResult(value: RunResult | JobStatus): value is RunResult {
  if (!Array.isArray((value as RunResult).metric_results)) return false;
  const status = (value.status || "").toLowerCase();
  return (
    status === "completed" ||
    status === "failed" ||
    (value as RunResult).metric_results.length > 0 ||
    Boolean((value as RunResult).overall_gate)
  );
}

function readStoredIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

function writeStoredIds(ids: string[]) {
  if (typeof window === "undefined") return;
  const unique = [...new Set(ids)].slice(0, 20);
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(unique));
  } catch {
    // Browser storage is best-effort; the submitted run still exists.
  }
}

/**
 * When this browser first saw a run, kept so a job status can be ordered.
 *
 * ``JobStatus`` carries no start time, so a run that the list endpoint has not
 * caught up with yet had one invented — ``new Date()``, regenerated on every
 * poll, and then used as the sort key. The row jumped position on every tick,
 * which is the flicker: not a render glitch, a moving timestamp. Remembering
 * the first sighting gives the row one stable place to sit until the server
 * supplies the real time.
 */
function recallFirstSeen(runId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(FIRST_SEEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    const existing = parsed[runId];
    if (typeof existing === "string" && existing) return existing;
    const now = new Date().toISOString();
    window.sessionStorage.setItem(
      FIRST_SEEN_KEY,
      JSON.stringify({ ...parsed, [runId]: now }),
    );
    return now;
  } catch {
    return null;
  }
}

/** Remember a run id so Run history can keep showing live status. */
export function rememberActiveRunId(runId: string) {
  if (!runId) return;
  writeStoredIds([runId, ...readStoredIds()]);
}

function jobToRunStub(job: JobStatus, runId: string): RunResult {
  const status = job.status || "pending";
  const responseSource = (job.response_source || (job.agent ? "agent" : "evaluation")).toLowerCase();
  const scenario: Scenario =
    (job.scenario as Scenario | null | undefined) ||
    (responseSource.includes("agent")
      ? "agentic"
      : responseSource.includes("rag")
        ? "rag"
        : "llm_core");
  const label = job.label?.trim() || null;
  const evaluationName =
    job.evaluation_name?.trim() ||
    recallRunForm(runId)?.evaluationName?.trim() ||
    null;
  const displayName =
    evaluationName ||
    (job.dataset_name
      ? `${job.dataset_name} (${responseSource})`
      : `Evaluation ${runId.slice(0, 8)}`);
  return {
    run_id: runId,
    status,
    error_message: job.error_message,
    label,
    metric_results: [],
    kpi_results: [],
    overall_gate: null,
    root_cause: null,
    review_queue: [],
    active_metrics: job.active_metrics || [],
    started_at: recallFirstSeen(runId) ?? new Date().toISOString(),
    completed_at:
      job.completed_at ||
      (status === "failed" || status === "cancelled" ? new Date().toISOString() : null),
    run_type: "evaluation",
    response_source: job.response_source,
    experiment: {
      name: displayName,
      dataset_version: job.dataset_version || (job.dataset_name ? `${job.dataset_name}.v1` : "unknown"),
      target_endpoint: job.agent || job.target_endpoint || "",
      target_version: job.target_model || null,
      scenario,
      market: "global",
      judge_model: job.judge_model || "",
      judge_temperature: 0,
      has_ground_truth: true,
      tags: {
        ...(label ? { label } : {}),
        ...(evaluationName ? { evaluation_name: evaluationName } : {}),
      },
    },
  };
}

/** A live snapshot, and whether it is a real run or a job-status stub.
 *
 *  The stub invents its display fields — "Evaluation a1b2c3d4" for a name, a
 *  guessed scenario, `<dataset>.v1` for a version. Those are fine when nothing
 *  better exists, and wrong the moment the list endpoint supplies the real
 *  ones: merged blindly, the row's own name changed under the reader while it
 *  ran. The caller needs to know which it got. */
type LiveSnapshot = { run: RunResult; stub: boolean };

async function fetchRunSnapshot(runId: string, tenantId: string): Promise<LiveSnapshot | null> {
  try {
    const result = await evaluationApi.getRun(runId, tenantId);
    if (isRunResult(result)) return { run: result, stub: false };
    return { run: jobToRunStub(result, runId), stub: true };
  } catch {
    return null;
  }
}

function mergeExperiment(
  existing: ExperimentDefinition | undefined,
  snapshot: ExperimentDefinition | undefined,
  label: string | null | undefined,
): ExperimentDefinition | undefined {
  if (!existing && !snapshot) return undefined;
  const base = existing ?? snapshot!;
  const overlay = snapshot ?? existing!;
  const mergedLabel =
    label?.trim() ||
    overlay.tags?.label?.trim() ||
    base.tags?.label?.trim() ||
    "";
  return {
    ...base,
    ...overlay,
    name: overlay.name || base.name || "Untitled run",
    dataset_version: overlay.dataset_version || base.dataset_version || "unknown",
    target_endpoint: overlay.target_endpoint || base.target_endpoint || "",
    scenario: (overlay.scenario || base.scenario || "llm_core") as Scenario,
    market: overlay.market || base.market || "global",
    judge_model: overlay.judge_model ?? base.judge_model ?? "",
    judge_temperature: overlay.judge_temperature ?? base.judge_temperature ?? 0,
    has_ground_truth: overlay.has_ground_truth ?? base.has_ground_truth ?? true,
    tags: {
      ...(base.tags ?? {}),
      ...(overlay.tags ?? {}),
      ...(mergedLabel ? { label: mergedLabel } : {}),
    },
  };
}

/**
 * Merge listRuns() with live getRun() snapshots for highlighted / remembered
 * in-flight ids so Run history shows Running/Completed/Failed
 * even before the list endpoint includes open jobs.
 */
export async function loadRunsWithLiveStatus(opts?: {
  highlightRunId?: string;
}): Promise<RunResult[]> {
  // A list failure must surface as an error in the caller (an empty list would
  // be indistinguishable from "no runs yet"), so it is allowed to propagate.
  // Live snapshots are only merged on top of a list that actually succeeded.
  const { tenant_id: tenantId } = await api.tenant();
  const listed = await evaluationApi.listRuns(tenantId);
  const byId = new Map(listed.map((run) => [run.run_id, run]));

  const tracked = new Set<string>([
    ...readStoredIds(),
    ...(opts?.highlightRunId ? [opts.highlightRunId] : []),
    ...listed
      .filter((run) => ACTIVE.has((run.status || "").toLowerCase()))
      .map((run) => run.run_id),
  ]);

  const stillActive: string[] = [];
  await Promise.all(
    [...tracked].map(async (runId) => {
      const live = await fetchRunSnapshot(runId, tenantId);
      if (!live) return;
      const snapshot = live.run;
      const existing = byId.get(runId);
      const remembered = recallRunLabel(runId);
      const label =
        snapshot.label ??
        existing?.label ??
        existing?.experiment?.tags?.label ??
        (remembered || null);
      byId.set(runId, {
        ...(existing ?? snapshot),
        ...snapshot,
        label,
        // A stub describes the run only because nothing better was available.
        // Where the list already knows the run, its description wins.
        experiment:
          live.stub && existing?.experiment
            ? mergeExperiment(existing.experiment, undefined, label)
            : mergeExperiment(existing?.experiment, snapshot.experiment, label),
        started_at: existing?.started_at || snapshot.started_at,
        // Keep richer completed payloads from list when getRun only returns job status.
        metric_results: snapshot.metric_results?.length
          ? snapshot.metric_results
          : existing?.metric_results ?? [],
        kpi_results: snapshot.kpi_results?.length
          ? snapshot.kpi_results
          : existing?.kpi_results ?? [],
        overall_gate: snapshot.overall_gate ?? existing?.overall_gate ?? null,
        active_metrics: snapshot.active_metrics?.length
          ? snapshot.active_metrics
          : existing?.active_metrics ?? [],
      });
      if (ACTIVE.has((snapshot.status || "").toLowerCase())) stillActive.push(runId);
    }),
  );

  writeStoredIds(stillActive);

  return [...byId.values()]
    .map((run) => {
      const remembered = recallRunLabel(run.run_id);
      if (!remembered || runLabelValue(run)) return run;
      return {
        ...run,
        label: remembered,
        experiment: mergeExperiment(run.experiment, run.experiment, remembered),
      };
    })
    .sort((a, b) => {
      const aTime = new Date(a.started_at || 0).getTime();
      const bTime = new Date(b.started_at || 0).getTime();
      return bTime - aTime;
    });
}

function runLabelValue(run: RunResult): string {
  return (run.label || run.experiment?.tags?.label || "").trim();
}

export function hasActiveRunStatus(runs: RunResult[], highlightRunId?: string): boolean {
  if (highlightRunId) {
    const highlighted = runs.find((run) => run.run_id === highlightRunId);
    if (highlighted && ACTIVE.has((highlighted.status || "").toLowerCase())) return true;
    if (!highlighted) return true;
  }
  return runs.some((run) => ACTIVE.has((run.status || "").toLowerCase())) || readStoredIds().length > 0;
}
