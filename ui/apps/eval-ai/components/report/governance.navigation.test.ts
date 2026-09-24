/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RunResult } from "@/lib/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui-state", () => ({ useUIState: () => ({ fullName: "Reviewer", identityResolved: true }) }));
vi.mock("@/lib/api", () => ({
  api: { tenant: async () => ({ tenant_id: "tenant-acme" }) },
  evaluationApi: {
    listRunItems: async () => [],
    listExperimentRuns: async () => [],
    listDecisions: vi.fn(async () => []),
    createDecision: vi.fn(async () => ({ decision_id: "decision-a", experiment_id: "experiment-1", run_id: "run-a", decision: "approved", approved_by: "Reviewer", reason: "Only A is approved" })),
  },
  platformApi: { capabilities: async () => ({ actions: { record_release_decision: true } }) },
}));

import { ReportView } from "./view";

const run: RunResult = {
  run_id: "run-a", status: "completed", metric_results: [], kpi_results: [],
  verdict_status: "conclusive", overall_gate: "pass", diagnostic_only: false,
  evidence_capture_status: "complete", evidence_categories: [], root_cause: null,
  review_queue: [], active_metrics: [], started_at: "2026-08-03T00:00:00Z", completed_at: "2026-08-03T00:01:00Z",
  gate_policy_id: "gate-1", gate_policy_version: "1.0.0",
  release_eligibility: { status: "eligible", code: null, message: null },
  experiment: { experiment_id: "experiment-1", name: "Shared experiment", dataset_version: "ds", target_endpoint: "https://example.test/agent", scenario: "agentic", market: "global", judge_model: "gpt-4o", judge_temperature: 0, has_ground_truth: true },
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("does not carry a recorded release decision or draft rationale into another run", async () => {
  const view = render(createElement(ReportView, { run }));
  fireEvent.change(await screen.findByLabelText("Rationale"), { target: { value: "Only A is approved" } });
  fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
  const confirmation = screen.getByRole("dialog", { name: "Record release decision?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Record decision" }));
  await screen.findByText(/Decision recorded:/);
  expect(screen.getByRole("heading", { name: "Experiment decision history" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Run run-a" }).getAttribute("href")).toBe("/runs/run-a");
  view.rerender(createElement(ReportView, { run: { ...run, run_id: "run-b" } }));
  const rationale = await screen.findByLabelText("Rationale") as HTMLTextAreaElement;
  expect(rationale.value).toBe("");
  expect(screen.queryByText(/Decision recorded:/)).toBeNull();
  expect(screen.getByRole("button", { name: "Record decision" })).toBeTruthy();
});
