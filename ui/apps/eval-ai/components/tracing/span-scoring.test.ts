/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: { tenant: vi.fn() },
  evaluationApi: { listJudgeModels: vi.fn(), getRunConfiguration: vi.fn() },
  spanScoringApi: { preview: vi.fn(), start: vi.fn(), job: vi.fn(), history: vi.fn() },
}));
import { api, evaluationApi, spanScoringApi } from "@/lib/api";
import { SpanScoring, AutomaticSpanScoringStatus } from "./span-scoring";

const selection = [{ trace_id: "trace", span_id: "span" }];
const preview = {
  preview_hash: "hash", items: [{ ...selection[0], name: "Answer", span_kind: "llm", input: "Question", output: "Answer text", expected_response: null,
    checks: [{ metric_id: "ops.latency", name: "Execution Latency", description: "Captured duration", available: true, unavailable_reason: null, scoring_type: "operational" }, { metric_id: "llm.correctness", name: "Correctness", description: "Compare expected output", available: false, unavailable_reason: "Provide an expected response for this span.", scoring_type: "float" }] }],
};
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "tenant" });
  vi.mocked(evaluationApi.listJudgeModels).mockResolvedValue({ models: [], provider: "azure", fallback: true });
  vi.mocked(spanScoringApi.preview).mockResolvedValue(preview);
  vi.mocked(spanScoringApi.history).mockResolvedValue({ jobs: [], limit: 20 });
});

it("allows captured measurements without a judge and reuses the request after a network failure", async () => {
  vi.mocked(spanScoringApi.start).mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({ job_id: "job", status: "completed", error: null, span_count: 1, metric_ids: ["ops.latency"], results: [] });
  render(createElement(SpanScoring, { projectId: "project", selections: selection }));
  fireEvent.click(screen.getByRole("button", { name: "Score span" }));
  await screen.findByText("Answer text");
  expect((screen.getByRole("checkbox", { name: /Correctness/ }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /Execution Latency/ }));
  expect(screen.queryByRole("combobox", { name: "Judge model" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Score 1 span" }));
  await screen.findByText("Connection lost");
  fireEvent.click(screen.getByRole("button", { name: "Score 1 span" }));
  await waitFor(() => expect(spanScoringApi.start).toHaveBeenCalledTimes(2));
  expect(vi.mocked(spanScoringApi.start).mock.calls[0][2]).toEqual(vi.mocked(spanScoringApi.start).mock.calls[1][2]);
});

it("keeps the evidence readable while editing expectations and requires a refreshed preview", async () => {
  render(createElement(SpanScoring, { projectId: "project", selections: selection }));
  fireEvent.click(screen.getByRole("button", { name: "Score span" }));
  await screen.findByText("Answer text");
  fireEvent.click(screen.getByRole("checkbox", { name: /Execution Latency/ }));
  fireEvent.change(screen.getByRole("textbox", { name: /Expected response/ }), { target: { value: "Correct answer" } });
  expect(screen.getByText("Answer text")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Score 1 span" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Update preview" }));
  await waitFor(() => expect(spanScoringApi.preview).toHaveBeenLastCalledWith("project", "tenant", [{ ...selection[0], expected_response: "Correct answer" }]));
});

it("distinguishes waiting for matching spans from completed automatic scoring", async () => {
  vi.mocked(evaluationApi.getRunConfiguration).mockResolvedValue({ run_id: "run", dataset_name: "synthetic", response_source: "llm", active_metrics: [], enable_llm_judge: false, parallel_requests: 1, run_human_review: false, quality_contract_ids: [], evaluation_scope: "final_response", project_id: "project", span_scoring_enabled: true, span_scoring_counts: {} } as Awaited<ReturnType<typeof evaluationApi.getRunConfiguration>>);
  render(createElement(AutomaticSpanScoringStatus, { runId: "run" }));
  expect((await screen.findByRole("link", { name: "View spans in Tracing" })).getAttribute("href")).toBe("/projects/project/traces?run_id=run");
  await screen.findByText(/No span scores yet/);
  vi.mocked(evaluationApi.getRunConfiguration).mockResolvedValue({ run_id: "run", dataset_name: "synthetic", response_source: "llm", active_metrics: [], enable_llm_judge: false, parallel_requests: 1, run_human_review: false, quality_contract_ids: [], evaluation_scope: "final_response", project_id: "project", span_scoring_enabled: true, span_scoring_counts: { completed: 1, failed: 1 } } as Awaited<ReturnType<typeof evaluationApi.getRunConfiguration>>);
  fireEvent.click(screen.getByRole("button", { name: "Refresh span status" }));
  await screen.findByText(/1 completed, 0 in progress, 1 stopped or failed/);
});

it("retains the latest result for each metric across separate scoring submissions", async () => {
  const saved = (metric_id: string, score: number) => ({ metric_id, score, metric_status: "scored", threshold_result: null, normalised_score: null, rationale: "Saved measurement", trace_id: "trace", span_id: "span" });
  vi.mocked(spanScoringApi.history).mockResolvedValue({ jobs: [
    { job_id: "new", status: "completed", results: [saved("ops.latency", 2), { ...saved("llm.coherence", 0), score: null, metric_status: "unscored" }] },
    { job_id: "old", status: "completed", results: [saved("ops.latency", 1), saved("ops.total_token_count", 10), saved("llm.coherence", 1), saved("ops.output_token_count", 0)] },
  ] as Awaited<ReturnType<typeof spanScoringApi.history>>["jobs"], limit: 20 });
  render(createElement(SpanScoring, { projectId: "project", selections: selection }));
  await screen.findByText("2.0s");
  expect(screen.getByText("10 tokens")).toBeTruthy();
  expect(screen.queryByText("1.0s")).toBeNull();
  expect(screen.getByText("0 tokens")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /coherence/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "latency: 2.0s" }));
  expect(await screen.findByText("Saved measurement")).toBeTruthy();
});

it("shows the judge only after a quality check is selected", async () => {
  vi.mocked(spanScoringApi.preview).mockResolvedValue({ ...preview, items: preview.items.map(item => ({ ...item, checks: [{ metric_id: "llm.coherence", name: "Coherence", description: "Logical flow", available: true, unavailable_reason: null, scoring_type: "float" }] })) });
  render(createElement(SpanScoring, { projectId: "project", selections: selection }));
  fireEvent.click(screen.getByRole("button", { name: "Score span" }));
  await screen.findByText("Answer text");
  expect(screen.queryByRole("combobox", { name: "Judge model" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: /Coherence/ }));
  expect(screen.getByRole("combobox", { name: "Judge model" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /Coherence/ }));
  expect(screen.queryByRole("combobox", { name: "Judge model" })).toBeNull();
});


it("keeps automatic scoring read-only in the annotation summary", async () => {
  vi.mocked(spanScoringApi.history).mockResolvedValue({ jobs: [{ job_id: "pending", status: "running", results: [], error: null, span_count: 1, metric_ids: ["ops.latency"] }] as Awaited<ReturnType<typeof spanScoringApi.history>>["jobs"], limit: 20 });
  render(createElement(SpanScoring, { projectId: "project", selections: selection, annotationSummary: true }));
  expect(await screen.findByText("Scoring is in progress.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Score span" })).toBeNull();
});

it("can refresh an empty automatic summary and explains a failed job without showing unscored chips", async () => {
  vi.mocked(spanScoringApi.history)
    .mockResolvedValueOnce({ jobs: [], limit: 20 })
    .mockResolvedValueOnce({ jobs: [{ job_id: "failed", status: "failed", error: "Judge unavailable", results: [], span_count: 1, metric_ids: ["llm.coherence"] }], limit: 20 });
  render(createElement(SpanScoring, { projectId: "project", selections: selection, annotationSummary: true }));
  await screen.findByText("No saved span scores.");
  fireEvent.click(screen.getByRole("button", { name: "Refresh scores" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Judge unavailable");
  expect(screen.queryByRole("button", { name: /coherence:/ })).toBeNull();
});
