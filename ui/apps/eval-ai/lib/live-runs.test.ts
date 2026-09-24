import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api-errors";
import type { RunResult } from "@/lib/api";

const listRuns = vi.fn();
const getRun = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    tenant: async () => ({ tenant_id: "t1" }),
  },
  evaluationApi: {
    listRuns: (tenantId: string) => listRuns(tenantId),
    getRun: (id: string, tenantId: string) => getRun(id, tenantId),
  },
}));

// recallRunLabel touches sessionStorage; keep it inert for these list-level tests.
vi.mock("@/lib/run-form-memory", () => ({ recallRunLabel: () => null, recallRunForm: () => ({ evaluationName: "Synthetic active evaluation" }) }));

import { loadRunsWithLiveStatus, rememberActiveRunId } from "@/lib/live-runs";

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    run_id: "r1",
    status: "completed",
    error_message: null,
    label: null,
    metric_results: [],
    kpi_results: [],
    overall_gate: null,
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:01.000Z",
    run_type: "evaluation",
    experiment: undefined,
    ...overrides,
  } as RunResult;
}

afterEach(() => {
  listRuns.mockReset();
  getRun.mockReset();
  vi.unstubAllGlobals();
});

describe("loadRunsWithLiveStatus list-failure handling", () => {
  it("propagates a listRuns failure instead of swallowing it into an empty list", async () => {
    listRuns.mockRejectedValueOnce(
      new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE", message: "down" }),
    );

    await expect(loadRunsWithLiveStatus()).rejects.toBeInstanceOf(ApiError);
    // Never falls through to per-run snapshots on a failed list.
    expect(getRun).not.toHaveBeenCalled();
  });

  it("returns the listed runs when the list succeeds", async () => {
    listRuns.mockResolvedValueOnce([run({ run_id: "r1", status: "completed" })]);

    const runs = await loadRunsWithLiveStatus();
    expect(runs.map((r) => r.run_id)).toEqual(["r1"]);
    // A completed run is not active, so no live snapshot fetch is needed.
    expect(getRun).not.toHaveBeenCalled();
  });
});

describe("loadRunsWithLiveStatus job-status merging", () => {
  it("keeps the run's real name when the live call returns only job status", async () => {
    // A job-status stub invents its description — "Evaluation a1b2c3d4", a
    // guessed scenario, "<dataset>.v1". Letting it overwrite what the list
    // already knows changed the row's own name under the reader mid-run, which
    // is half of the flicker on an in-flight row.
    listRuns.mockResolvedValue([
      run({
        run_id: "r1",
        status: "running",
        experiment: {
          name: "Claims policy regression",
          dataset_version: "claims.v7",
          target_endpoint: "tenant/claims-agent",
          scenario: "rag",
          market: "global",
          judge_model: "gpt-4.1-mini",
          judge_temperature: 0,
          has_ground_truth: true,
          tags: {},
        },
      } as Partial<RunResult>),
    ]);
    // No metric_results and no overall_gate: this is a job status, not a run.
    getRun.mockResolvedValue({ run_id: "r1", status: "running", dataset_name: "claims" });

    const [merged] = await loadRunsWithLiveStatus();

    expect(merged.status).toBe("running");
    expect(merged.experiment?.name).toBe("Claims policy regression");
    expect(merged.experiment?.dataset_version).toBe("claims.v7");
  });
});


it("preserves successful submission when remembering its ID hits storage quota", () => {
  vi.stubGlobal("window", { sessionStorage: { getItem: () => null, setItem: () => { throw new Error("Quota exceeded"); } } });
  expect(() => rememberActiveRunId("server-created-run")).not.toThrow();
});
