/** @vitest-environment jsdom */

/**
 * The comparison effect starts at `api.tenant()`, which rejects with a 503 when
 * the workspace cannot be resolved. Without a `.catch` the spinner clears onto
 * an empty comparison and the rejection escapes as an unhandled rejection.
 */

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api-errors";
import type { RunResult } from "@/lib/api";

const tenant = vi.fn();
const listExperimentRuns = vi.fn();
const listRunItems = vi.fn();
const compareRuns = vi.fn();
const getRun = vi.fn();

vi.mock("@/lib/api", () => ({
  api: { tenant: () => tenant() },
  evaluationApi: {
    listExperimentRuns: (...args: unknown[]) => listExperimentRuns(...args),
    listRunItems: (...args: unknown[]) => listRunItems(...args),
    compareRuns: (...args: unknown[]) => compareRuns(...args),
    getRun: (...args: unknown[]) => getRun(...args),
  },
}));

// The gate probes `/api/status`; readiness is covered by its own tests.
vi.mock("@/components/proofgrove-gate", () => ({
  ProofgroveGate: ({ children }: { children: React.ReactNode }) => children,
}));

// A stable params instance, exactly as the router hands out: a fresh object per
// render would re-trigger the load effect forever and mask what is asserted here.
let searchParams = new URLSearchParams(
  "baseline_run_id=baseline&candidate_run_id=candidate",
);
const router = { replace: vi.fn(), push: vi.fn() };

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "experiment-1" }),
  useRouter: () => router,
  useSearchParams: () => searchParams,
}));

const { ExperimentComparePage } = await import("@/app/experiments/[id]/compare/page");

function run(id: string, number: number): RunResult {
  return {
    run_id: id,
    status: "completed",
    experiment: {
      experiment_id: "experiment-1",
      name: "Support evaluation",
      dataset_version: "support.v4",
      target_endpoint: "tenant/support-agent",
      scenario: "agentic",
      market: "global",
      judge_model: "gpt-4.1-mini",
      judge_temperature: 0,
      has_ground_truth: true,
      tags: {},
    },
    metric_results: [],
    kpi_results: [],
    overall_gate: "pass",
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    started_at: "2025-01-01T00:00:00Z",
    completed_at: "2025-01-01T00:00:00Z",
    run_number: number,
    label: undefined,
  };
}

afterEach(() => {
  cleanup();
  searchParams = new URLSearchParams("baseline_run_id=baseline&candidate_run_id=candidate");
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("compare page tenant resolution failure", () => {
  it("surfaces a user-facing error instead of an empty comparison", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      unhandled.push(event.reason);
    };
    window.addEventListener("unhandledrejection", onUnhandled);

    const runs = [run("baseline", 1), run("candidate", 2)];
    // The initial load resolves the workspace; the comparison call hits the 503.
    tenant.mockResolvedValueOnce({ tenant_id: "tenant-classroom" });
    tenant.mockRejectedValue(
      new ApiError({
        status: 503,
        code: "service_unavailable",
        message: "Workspace context is unavailable.",
        recovery: "Retry in a moment.",
      }),
    );
    listExperimentRuns.mockResolvedValue(runs);
    listRunItems.mockResolvedValue([]);
    getRun.mockImplementation((runId: string) =>
      Promise.resolve(runs.find((candidate) => candidate.run_id === runId)),
    );

    try {
      render(createElement(ExperimentComparePage));

      await waitFor(() => {
        expect(screen.getByText(/Workspace context is unavailable\./)).toBeTruthy();
      });
      // The failure must not be reported as an incompatible-run problem, and no
      // comparison numbers may be rendered over it.
      expect(screen.queryByText(/cannot be compared safely/)).toBeNull();
      expect(compareRuns).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  });
});

it("does not reload run data when opening a sample changes the URL", async () => {
  const runs = [run("baseline", 1), run("candidate", 2)];
  tenant.mockResolvedValue({tenant_id:"tenant-classroom"});
  listExperimentRuns.mockResolvedValue(runs);
  listRunItems.mockResolvedValue([]);
  getRun.mockImplementation((id: string) => Promise.resolve(runs.find(r => r.run_id === id)));
  compareRuns.mockResolvedValue({
    experiment_id: "experiment-1", base_run_id: "baseline", candidate_run_id: "candidate",
    kpi_deltas: [], sample_deltas: [], measurement_deltas: [],
    sample_counts: { improved: 0, regressed: 0, same: 0, unavailable: 0 },
    metric_failures: { new: [], fixed: [], persistent: [] }, metadata_diff: {},
  });
  const view = render(createElement(ExperimentComparePage));
  await waitFor(() => expect(compareRuns).toHaveBeenCalled());
  expect(listExperimentRuns).toHaveBeenCalledTimes(1);
  searchParams = new URLSearchParams("baseline_run_id=baseline&candidate_run_id=candidate&tab=samples&sample=case-1");
  view.rerender(createElement(ExperimentComparePage));
  await waitFor(() => expect(screen.getByRole("tab", {name:"samples"}).getAttribute("aria-selected")).toBe("true"));
  expect(listExperimentRuns).toHaveBeenCalledTimes(1);
  expect(getRun).toHaveBeenCalledTimes(2);
});


it("keeps metric and chart changes made before URL navigation completes", async () => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const runs = [run("baseline", 1), run("candidate", 2)].map(item => ({
    ...item,
    lineage: { comparison_basis_hash: "same", comparison_basis_version: "v1" },
    kpi_results: ["first", "second"].map(kpi_id => ({
      kpi_id, run_id: item.run_id, composite_score: 0.8, observed_score: 0.8,
      gate_result: "pass", constituent_scores: [], threshold_pass: 0.7,
      threshold_warn: 0.5, threshold_fail: 0, evaluated_target: "llm",
    })),
  }));
  tenant.mockResolvedValue({ tenant_id: "tenant-classroom" });
  listExperimentRuns.mockResolvedValue(runs);
  listRunItems.mockResolvedValue([]);
  getRun.mockImplementation((id: string) => Promise.resolve(runs.find(item => item.run_id === id)));
  compareRuns.mockResolvedValue({ kpi_deltas: [], sample_deltas: [], measurement_deltas: [],
    sample_counts: { improved: 0, regressed: 0, same: 0, unavailable: 0 },
    metric_failures: { new: [], fixed: [], persistent: [] }, metadata_diff: {},
  });
  render(createElement(ExperimentComparePage));
  const select = await screen.findByRole("combobox", { name: "Analysis metric" }) as HTMLSelectElement;
  const value = select.options[1].value;
  act(() => {
    fireEvent.change(select, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Over iterations" }));
  });
  await waitFor(() => {
    const query = new URLSearchParams(router.replace.mock.lastCall?.[0]);
    expect(query.get("an_kpi")).toBe(value);
    expect(query.get("av")).toBe("trend");
  });
  expect(listExperimentRuns).toHaveBeenCalledTimes(1);
});
