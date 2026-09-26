import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { UsageDashboard } from "@/components/usage-dashboard";

const mock = vi.hoisted(() => ({ getUsage: vi.fn(), tenant: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { tenant: mock.tenant }, evaluationApi: { getUsage: mock.getUsage } }));
vi.mock("@/components/proofgrove-gate", () => ({ ProofgroveGate: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("recharts", () => {
  const Chart = () => null;
  return { ResponsiveContainer: Chart, LineChart: Chart, Line: Chart, CartesianGrid: Chart, XAxis: Chart, YAxis: Chart, Tooltip: Chart, Legend: Chart };
});
const totals = { runs: 1, failed_runs: 0, cases: 1, prompt_tokens: 0, completion_tokens: 0, prompt_measured_cases: 1, completion_measured_cases: 0, cases_without_usage: 0, unpriced_cases: 1, estimated_cost_usd: null, latency_ms_p50: 0, latency_ms_p90: 0 };
const usage = { window: "30d", bucket: "day", models: ["private-model"], totals, previous_totals: { ...totals, runs: 0, cases: 0 }, days: [{ date: "2026-09-12", ...totals }], recent_runs: [{ run_id: "run-1", name: "Quality check", dataset: "ds.v1", model: "private-model", status: "completed", started_at: "2026-09-12T12:00:00Z" }], failed_launches: [], top_models: { rows: [{ name: "private-model", cases: 1, estimated_cost_usd: null, unpriced_cases: 1 }], others: 0 }, top_datasets: { rows: [], others: 0 } };
beforeEach(() => { vi.resetAllMocks(); mock.tenant.mockResolvedValue({ tenant_id: "tenant-test" }); });
it("shows loading, then an actionable empty state", async () => {
  mock.getUsage.mockResolvedValue({ ...usage, totals: { ...totals, runs: 0, cases: 0 } });
  render(<UsageDashboard />);
  expect(screen.getByText("Loading evaluation activity…")).toBeTruthy();
  expect(await screen.findByText("No evaluation activity in this window")).toBeTruthy();
});
it("shows a load failure and allows retry", async () => {
  mock.getUsage.mockRejectedValueOnce(new Error("Usage service unavailable")).mockResolvedValue(usage);
  render(<UsageDashboard />);
  expect(await screen.findByText("Could not load evaluation activity.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /try again/i }));
  expect(await screen.findByText("Recorded target tokens")).toBeTruthy();
});
it("discloses partial data and reloads for the selected window", async () => {
  mock.getUsage.mockResolvedValue(usage);
  render(<UsageDashboard />);
  expect(await screen.findByText("Recorded target tokens")).toBeTruthy();
  expect(screen.getByText(/1 of 1 cases report input tokens; 0 report output/)).toBeTruthy();
  expect(screen.getByText("Unavailable")).toBeTruthy();
  expect(screen.queryByText("Save view")).toBeNull();
  expect(screen.queryByRole("button", { name: "Show data" })).toBeNull();
  expect(screen.getByRole("link", { name: /Quality check →/ }).getAttribute("href")).toBe("/runs/run-1");
  fireEvent.click(screen.getByRole("button", { name: "7 days" }));
  await waitFor(() => expect(mock.getUsage).toHaveBeenLastCalledWith("tenant-test", { window: "7d", targetModel: null }));
});

it("filters the dashboard from a model ranking and links failed launches", async () => {
  mock.getUsage.mockResolvedValue({ ...usage, totals: { ...totals, failed_runs: 1 }, failed_launches: [{ run_id: "job-1", name: "Failed dataset", status: "failed", model: "private-model", started_at: "2026-09-12T12:00:00Z" }] });
  render(<UsageDashboard />);
  expect(await screen.findByRole("link", { name: "Failed dataset →" })).toHaveProperty("href", expect.stringContaining("/runs/job-1"));
  fireEvent.click(screen.getByRole("button", { name: "Filter dashboard to private-model" }));
  await waitFor(() => expect(mock.getUsage).toHaveBeenLastCalledWith("tenant-test", { window: "30d", targetModel: "private-model" }));
});

it("limits recent runs to five and keeps attention visible for an empty selection", async () => {
  mock.getUsage.mockResolvedValue({ ...usage, recent_runs: Array.from({ length: 8 }, (_, i) => ({ ...usage.recent_runs[0], run_id: `run-${i}`, name: `Recent ${i}` })) });
  render(<UsageDashboard attention={<section>Workspace attention</section>} />);
  expect(await screen.findByText("Recent 0 →")).toBeTruthy();
  expect(screen.getAllByRole("link", { name: /Recent [0-9] →/ })).toHaveLength(5);
  expect(screen.queryByText("Recent 5 →")).toBeNull();
  mock.getUsage.mockResolvedValue({ ...usage, totals: { ...totals, runs: 0, cases: 0 }, recent_runs: [] });
  fireEvent.click(screen.getByRole("button", { name: "7 days" }));
  expect(await screen.findByText("No evaluation activity in this window")).toBeTruthy();
  expect(screen.getByText("Workspace attention")).toBeTruthy();
});
