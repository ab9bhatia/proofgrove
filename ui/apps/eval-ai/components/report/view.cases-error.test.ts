/** @vitest-environment jsdom */

/**
 * The cases load failure is rendered verbatim inside a `role="alert"`, so it
 * must go through the bounded `userFacingError` contract like every other error
 * path in the report — never a raw transport message.
 */

import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunResult } from "@/lib/api";

const listRunItems = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  api: { tenant: () => Promise.resolve({ tenant_id: "tenant-classroom" }) },
  evaluationApi: {
    listRunItems: (...args: unknown[]) => listRunItems(...args),
    getRunItem: () => Promise.reject(new Error("not used")),
    listExperimentRuns: () => Promise.resolve([]),
    rescoreRun: () => Promise.reject(new Error("not used")),
  },
  platformApi: { capabilities: () => Promise.reject(new Error("not used")) },
}));

const { ReportView } = await import("@/components/report/view");

const run: RunResult = {
  run_id: "run-1",
  status: "completed",
  experiment: {
    experiment_id: "experiment-1",
    name: "Fraud Agent MCP/OTel Suite",
    dataset_version: "ds_demo",
    target_endpoint: "https://example.test/agent",
    scenario: "agentic",
    market: "global",
    judge_model: "gpt-4o",
    judge_temperature: 0,
    has_ground_truth: true,
  },
  metric_results: [],
  kpi_results: [],
  overall_gate: "pass",
  root_cause: null,
  review_queue: [],
  active_metrics: [],
  started_at: "2026-08-03T00:00:00Z",
  completed_at: "2026-08-03T00:01:00Z",
  run_number: 6,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReportView cases load failure", () => {
  it("never renders a raw transport message in the cases alert", async () => {
    listRunItems.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:8000"));

    render(
      createElement(ReportView, { run, initialOpenSections: { cases: true } }),
    );

    const alert = await waitFor(() => {
      const found = screen.getByRole("alert");
      expect(found.textContent).toContain("Couldn't load cases for this run.");
      return found;
    });
    expect(alert.textContent).not.toContain("ECONNREFUSED");
    expect(alert.textContent).toContain("The cases for this run could not be loaded.");
  });
});
