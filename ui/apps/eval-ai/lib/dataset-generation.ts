// Client + pure helpers for the durable dataset-generation job flow
// (`POST /datasets/generate`, `GET /datasets/generation-jobs/{id}`,
// `POST /datasets/generation-jobs/{id}/cancel`).
//
// Generation is persisted server-side as a job with honest phases
// (queued → generating → validating → completed | failed | cancelled), so the
// UI can watch it across page navigations via a `?genJob=<id>` URL param and
// re-attach after a reload. A process restart marks lost jobs
// failed/"interrupted" — surfaced here as an explicit Interrupted state.
//
// It lives here rather than in `lib/api.ts` (which this slice must not modify)
// but talks to the same BFF proxy with the same error handling — mirroring the
// `lib/run-history.ts` standalone-client pattern.

import { sessionAwareFetch } from "@evalai/shared/session";
import { ApiError, apiErrorFromResponse } from "@/lib/api-errors";
import type { GenerateRequest } from "@/lib/api";

const BASE = "/api/proofgrove";

export type GenerationJobPhase =
  | "queued"
  | "generating"
  | "validating"
  | "completed"
  | "failed"
  | "cancelled";

/** Durable generation job as returned by the datasets generation-job endpoints. */
export interface GenerationJob {
  job_id: string;
  tenant: string;
  dataset_name: string;
  phase: GenerationJobPhase;
  /** Only present when honestly known (e.g. requested row count). */
  progress: { done: number; total: number } | null;
  error: string | null;
  /** Registry may mint `{name}_vN`; set once the job completes. */
  result_dataset_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Legacy field kept by POST /datasets/generate ("pending"). */
  status?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await sessionAwareFetch(`${BASE}${path}`, {
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      ...init,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "Unable to reach Proofgrove. Check your connection and try again.",
    });
  }
  if (!res.ok) {
    throw apiErrorFromResponse(res.status, await res.text());
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError({
      status: 502,
      code: "INVALID_RESPONSE",
      message: "Proofgrove returned an invalid response. Try again shortly.",
    });
  }
}

export const datasetGenerationApi = {
  /** Start a durable generation job; returns it in the queued phase. */
  start: (body: GenerateRequest): Promise<GenerationJob> =>
    request<GenerationJob>("/datasets/generate", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  get: (jobId: string): Promise<GenerationJob> =>
    request<GenerationJob>(`/datasets/generation-jobs/${encodeURIComponent(jobId)}`),
  /** Idempotent; the server refuses (409) to cancel completed/failed jobs. */
  cancel: (jobId: string): Promise<GenerationJob> =>
    request<GenerationJob>(`/datasets/generation-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
    }),
};

/* ── Phase semantics ─────────────────────────────────────────────── */

const TERMINAL_PHASES: ReadonlySet<GenerationJobPhase> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalGenerationPhase(phase: GenerationJobPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/** True for jobs the cancel action can still honestly affect. */
export function isCancellableGenerationPhase(phase: GenerationJobPhase): boolean {
  return phase === "queued" || phase === "generating" || phase === "validating";
}

/** Honest reason the backend records when a restart loses an in-flight job. */
export const INTERRUPTED_ERROR = "interrupted";

export interface GenerationPhaseView {
  label: string;
  /** Visual tone the panel should render with. */
  tone: "active" | "success" | "error" | "muted";
  /** Human sentence for the current state (includes the honest error). */
  detail: string;
}

/** Pure phase → rendering descriptor (kept out of JSX so it is testable). */
export function describeGenerationPhase(job: GenerationJob): GenerationPhaseView {
  switch (job.phase) {
    case "queued":
      return {
        label: "Queued",
        tone: "active",
        detail: `Generation for “${job.dataset_name}” is queued.`,
      };
    case "generating":
      return {
        label: "Generating",
        tone: "active",
        detail: `Synthesizing records for “${job.dataset_name}”…`,
      };
    case "validating":
      return {
        label: "Validating",
        tone: "active",
        detail: "Registering and validating the generated records…",
      };
    case "completed":
      return {
        label: "Completed",
        tone: "success",
        detail: `Generated ${job.progress ? `${job.progress.done} records ` : ""}into “${
          job.result_dataset_name ?? job.dataset_name
        }” as a Draft dataset.`,
      };
    case "cancelled":
      return {
        label: "Cancelled",
        tone: "muted",
        detail: "Generation was cancelled. No dataset was registered.",
      };
    case "failed":
      if (job.error === INTERRUPTED_ERROR) {
        return {
          label: "Interrupted",
          tone: "error",
          detail:
            "The service restarted while this job was running; its in-flight work was lost. Start a new generation.",
        };
      }
      return {
        label: "Failed",
        tone: "error",
        detail: job.error || "Generation failed.",
      };
  }
}

/** "3 of 10 rows" when progress is honestly known, otherwise null. */
export function generationProgressLabel(
  progress: GenerationJob["progress"],
): string | null {
  if (!progress || progress.total <= 0) return null;
  return `${progress.done} of ${progress.total} rows`;
}

/* ── URL round-trip (?genJob=<id>) ───────────────────────────────── */

export const GEN_JOB_PARAM = "genJob";

export function readGenerationJobParam(
  search: URLSearchParams | string,
): string | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const value = params.get(GEN_JOB_PARAM)?.trim();
  return value ? value : null;
}

/** Set (or, with null, remove) the genJob param, preserving other params. */
export function writeGenerationJobParam(
  currentQuery: string,
  jobId: string | null,
): string {
  const params = new URLSearchParams(currentQuery);
  if (jobId) params.set(GEN_JOB_PARAM, jobId);
  else params.delete(GEN_JOB_PARAM);
  return params.toString();
}

/* ── Watch loop ──────────────────────────────────────────────────── */

export interface WatchGenerationJobOptions {
  /** Injected in tests; defaults to the real client. */
  fetchJob?: (jobId: string) => Promise<GenerationJob>;
  intervalMs?: number;
  /** Called with every observed job snapshot, including the terminal one. */
  onUpdate?: (job: GenerationJob) => void;
  signal?: AbortSignal;
  /** Consecutive fetch failures tolerated before giving up (pod restarts). */
  maxTransientErrors?: number;
}

/**
 * Poll one generation job until it reaches an honest terminal phase.
 * Resolves with the terminal job; rejects on persistent fetch errors.
 * Aborting the signal stops watching without cancelling the server job.
 */
export async function watchGenerationJob(
  jobId: string,
  {
    fetchJob = datasetGenerationApi.get,
    intervalMs = 1500,
    onUpdate,
    signal,
    maxTransientErrors = 5,
  }: WatchGenerationJobOptions = {},
): Promise<GenerationJob> {
  if (!jobId) throw new Error("missing generation job id to watch");
  let consecutiveErrors = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException("watch aborted", "AbortError");
    try {
      const job = await fetchJob(jobId);
      consecutiveErrors = 0;
      onUpdate?.(job);
      if (isTerminalGenerationPhase(job.phase)) return job;
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors > maxTransientErrors) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
