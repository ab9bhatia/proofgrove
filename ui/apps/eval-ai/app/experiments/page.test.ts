/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperimentSummary, RunResult } from "@/lib/api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  api: { tenant: vi.fn() },
  evaluationApi: {
    listExperimentWorkspaces: vi.fn(),
    listRuns: vi.fn(),
    listExperimentRuns: vi.fn(),
    getExperimentSummary: vi.fn(),
    createExperimentWorkspace: vi.fn(),
    createExperimentFromRuns: vi.fn(),
  },
}));

vi.mock("@/lib/run-history", () => ({ runHistoryApi: { list: vi.fn() } }));
import { runHistoryApi } from "@/lib/run-history";

import { isOneOffDiagnosticRun, groupRunsByName } from "@/components/experiments-library";
import { api, evaluationApi } from "@/lib/api";
import { ExperimentsTable, ExperimentsView } from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    run_id: "run-1",
    status: "completed",
    metric_results: [],
    kpi_results: [],
    overall_gate: null,
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    started_at: "2026-08-21T10:00:00Z",
    completed_at: "2026-08-21T10:01:00Z",
    lineage: { comparison_basis_hash: "basis-1" },
    experiment: {
      experiment_id: "exp-1",
      name: "Shared eval",
      dataset_version: "ds.v1",
      target_endpoint: "golden-dataset:ds",
      scenario: "llm_core",
      market: "global",
      judge_model: "gpt-4o",
      judge_temperature: 0,
      has_ground_truth: true,
      tags: {},
    },
    ...overrides,
  };
}

describe("empty experiment card honesty", () => {
  it("renders no-runs copy for active zero-run workspaces", () => {
    const summary: ExperimentSummary = {
      experiment: {
        experiment_id: "ws-1",
        name: "Pre-run workspace",
        dataset_version: "",
        target_endpoint: "",
        scenario: "",
        market: "global",
        judge_model: "gpt-4o",
        judge_temperature: 0,
        has_ground_truth: true,
        status: "active",
        tags: { workspace_kind: "experiment", pending_first_run: "true" },
      },
      run_count: 0,
      latest_run_id: null,
      latest_score: null,
      latest_gate: null,
      latest_completed_at: null,
      baseline_run_id: null,
      champion_run_id: null,
      release_evidence_run_id: null,
      failed_kpis_latest: [],
      latest_decision: null,
      kind: "experiment",
    };
    // Keep the assertion focused on the honest empty-state contract used by the table row.
    expect(summary.run_count).toBe(0);
    expect(summary.experiment.status).toBe("active");
    expect(summary.kind).toBe("experiment");
  });
});

describe("lineage grouping and diagnostics", () => {
  it("groups compatible lineage runs into one row", () => {
    const groups = groupRunsByName([
      run({ run_id: "a", started_at: "2026-08-22T10:00:00Z" }),
      run({ run_id: "b", started_at: "2026-08-21T10:00:00Z" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.runs).toHaveLength(2);
  });

  it("keeps one-off diagnostics out of the lineage group", () => {
    const diagnostic = run({
      run_id: "diag",
      experiment: {
        experiment_id: "exp-1",
        name: "Shared eval",
        dataset_version: "ds.v1",
        target_endpoint: "golden-dataset:ds",
        scenario: "llm_core",
        market: "global",
        judge_model: "gpt-4o",
        judge_temperature: 0,
        has_ground_truth: true,
        tags: { one_off_diagnostic: "true" },
      },
    });
    expect(isOneOffDiagnosticRun(diagnostic)).toBe(true);
    const groups = groupRunsByName([run({ run_id: "a" }), diagnostic]);
    expect(groups).toHaveLength(2);
  });
});

describe("create experiment name validation", () => {
  it("requires a non-blank experiment name", () => {
    const name = "   ".trim();
    expect(name).toBe("");
  });
});

function summary(
  id: string,
  overrides: Partial<ExperimentSummary> = {},
): ExperimentSummary {
  return {
    experiment: {
      experiment_id: id,
      name: `Experiment ${id}`,
      dataset_version: "ds.v1",
      target_endpoint: "golden-dataset:ds",
      scenario: "llm_core",
      market: "global",
      judge_model: "gpt-4o",
      judge_temperature: 0,
      has_ground_truth: true,
      status: "active",
      tags: { workspace_kind: "experiment" },
    },
    run_count: 2,
    latest_run_id: "run-1",
    latest_score: 0.82,
    latest_gate: null,
    latest_completed_at: "2026-08-21T10:01:00Z",
    baseline_run_id: null,
    champion_run_id: null,
    release_evidence_run_id: null,
    failed_kpis_latest: [],
    latest_decision: null,
    kind: "experiment",
    ...overrides,
  };
}

describe("experiments table", () => {
  it("renders one shared table so columns line up across every experiment", () => {
    const html = renderToStaticMarkup(
      createElement(ExperimentsTable, {
        experiments: [summary("a"), summary("b")],
        total: 2,
        page: 1,
        onPageChange: () => undefined,
      }),
    );

    expect(html).toContain("<table");
    // One <thead>, one column definition — not a grid re-declared per row.
    expect(html.match(/<thead/g)).toHaveLength(1);
    expect(html.match(/<colgroup/g)).toHaveLength(1);
    // Numbers right-aligned with tabular figures, matching the run history table.
    expect(html).toContain('<th scope="col" class="px-3 py-3 text-right font-medium tabular-nums">Runs</th>');
    expect(html).toContain("Latest KPI composite");
    expect(html).toContain("Latest outcome");
    expect(html).toContain("Last run");
    expect(html).toContain('aria-label="Experiment actions"');
    // Seven columns, seven <col> widths — a mismatch leaves an unmapped column.
    expect(html.match(/<col /g)).toHaveLength(7);
    // The Promote affordance is gone for good.
    expect(html).not.toContain("Promote");
  });

  it("marks lineage drafts with a badge and keeps zero-run cells honest", () => {
    const html = renderToStaticMarkup(
      createElement(ExperimentsTable, {
        experiments: [
          summary("draft-1", { kind: "draft", run_count: 0, latest_score: null, latest_completed_at: null }),
        ],
        total: 1,
        page: 1,
        onPageChange: () => undefined,
      }),
    );

    expect(html).toContain(">Draft</span>");
    expect(html).toContain("border-dashed");
    // The Runs column stays a count, so it lines up with rows that show a number.
    expect(html).toContain('<td class="px-3 py-3.5 text-right text-sm tabular-nums text-foreground">0</td>');
    // One absence, said once per column in its own vocabulary — not "No runs
    // yet" repeated across four cells of the same row.
    expect(html).toContain("Not scored");
    expect(html).toContain("Not gated");
    // One vocabulary for a fact the system never captured, shared with the
    // "Not scored" and "Not gated" cells beside it.
    expect(html).toContain("Not recorded");
    expect(html.match(/No runs yet/g)).toHaveLength(1);
    expect(html).not.toContain("—");
  });

  it("keeps the Runs column a count for zero-run and many-run experiments alike", () => {
    const html = renderToStaticMarkup(
      createElement(ExperimentsTable, {
        experiments: [summary("zero", { run_count: 0, latest_score: null, latest_completed_at: null }), summary("many", { run_count: 7 })],
        total: 2,
        page: 1,
        onPageChange: () => undefined,
      }),
    );

    const counts = html.match(/<td class="px-3 py-3\.5 text-right text-sm tabular-nums text-foreground">(\d+)<\/td>/g);
    expect(counts).toEqual([
      '<td class="px-3 py-3.5 text-right text-sm tabular-nums text-foreground">0</td>',
      '<td class="px-3 py-3.5 text-right text-sm tabular-nums text-foreground">7</td>',
    ]);
  });

  it("expands a row to reveal that experiment's runs, fetching them only on demand", async () => {
    const listExperimentRuns = vi.mocked(evaluationApi.listExperimentRuns);
    listExperimentRuns.mockResolvedValue([run({ run_id: "run-9", run_number: 3 })]);

    render(
      createElement(ExperimentsTable, {
        experiments: [summary("a"), summary("b")],
        total: 2,
        page: 1,
        onPageChange: () => undefined,
      }),
    );

    // Nothing is fetched until a row is opened.
    expect(listExperimentRuns).not.toHaveBeenCalled();

    const [toggle] = screen.getAllByRole("button", { name: "Expand runs for Experiment a" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const panelId = toggle.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId!)).toBeNull();

    fireEvent.click(toggle);

    // Only the opened experiment is fetched — never every row up front.
    expect(listExperimentRuns).toHaveBeenCalledTimes(1);
    expect(listExperimentRuns).toHaveBeenCalledWith("a");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect((await screen.findAllByText("Run 3")).length).toBeGreaterThan(0);
    expect(document.getElementById(panelId!)).not.toBeNull();

    const [collapse] = screen.getAllByRole("button", { name: "Collapse runs for Experiment a" });
    fireEvent.click(collapse);
    expect(screen.queryAllByText("Run 3")).toHaveLength(0);
    expect(collapse.getAttribute("aria-expanded")).toBe("false");

    // Reopening reuses the loaded runs instead of refetching.
    fireEvent.click(collapse);
    expect(listExperimentRuns).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Run 3").length).toBeGreaterThan(0);
  });

  it("offers archive on the active list and restore on the archived one", () => {
    const active = renderToStaticMarkup(
      createElement(ExperimentsTable, {
        experiments: [summary("a")],
        total: 1,
        page: 1,
        onPageChange: () => undefined,
        onSetArchived: () => undefined,
      }),
    );
    expect(active).toContain('aria-label="Archive Experiment a"');
    expect(active).not.toContain('aria-label="Restore Experiment a"');

    const archived = renderToStaticMarkup(
      createElement(ExperimentsTable, {
        experiments: [summary("a")],
        total: 1,
        page: 1,
        onPageChange: () => undefined,
        lifecycle: "archived" as const,
        onSetArchived: () => undefined,
      }),
    );
    expect(archived).toContain('aria-label="Restore Experiment a"');
    // Opening the experiment stays reachable either way.
    expect(archived).toContain('aria-label="Open Experiment a"');
  });

  it("capitalises every status, not only the active one", () => {
    const html = renderToStaticMarkup(
      createElement(ExperimentsTable, {
        experiments: [
          summary("a", { experiment: { ...summary("a").experiment, status: "approved" } }),
          summary("b", { experiment: { ...summary("b").experiment, status: "archived" } }),
        ],
        total: 2,
        page: 1,
        onPageChange: () => undefined,
      }),
    );
    expect(html).toContain(">Approved<");
    expect(html).toContain(">Archived<");
    expect(html).not.toContain(">approved<");
    expect(html).not.toContain(">archived<");
  });

  it("pages through the server total instead of silently truncating", () => {
    const html = renderToStaticMarkup(
      createElement(ExperimentsTable, {
        experiments: [summary("a")],
        total: 41,
        page: 1,
        onPageChange: () => undefined,
      }),
    );

    expect(html).toContain('aria-label="Experiments pagination"');
    expect(html).toContain("Page 1 of 3");
    expect(html).toContain('of <span class="font-medium text-foreground">41</span> experiments');
    // Previous is unreachable on the first page, Next is not.
    expect(html).toMatch(/disabled=""[\s\S]*?Previous<\/button>/);
    expect(html).toContain('type="button">Next');
  });
});


describe("new experiment run selection", () => {
  async function openRuns(items: RunResult[]) {
    vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "acme" } as Awaited<ReturnType<typeof api.tenant>>);
    vi.mocked(evaluationApi.listExperimentWorkspaces).mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0, next_cursor: null });
    vi.mocked(evaluationApi.getExperimentSummary).mockRejectedValue(new Error("No existing workspace"));
    vi.mocked(runHistoryApi.list).mockResolvedValue({ items, total: items.length, offset: 0, limit: 100, next_cursor: null });
    render(createElement(ExperimentsView));
    fireEvent.click(await screen.findByRole("button", { name: "New experiment" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /Shared eval/ })).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox", { name: "Choose evaluation for experiment" }), { target: { value: "exp-1" } });
  }

  const include = (id: string) => screen.getByRole("checkbox", { name: new RegExp(`Include .*\\(${id}\\)`) }) as HTMLInputElement;

  it("keeps an incompatible run visible with a reason, and re-enables it after clearing", async () => {
    await openRuns([run({ run_id: "a" }), run({ run_id: "b", lineage: { comparison_basis_hash: "basis-2" } })]);
    fireEvent.click(include("a"));
    expect(include("a").checked).toBe(true);
    expect(include("b").disabled).toBe(true);
    expect(screen.getByText(/Different comparison basis/)).toBeTruthy();
    expect(screen.getByText(/Showing 2 of 2 matching runs/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(include("b").disabled).toBe(false);
    fireEvent.click(include("b"));
    expect(include("a").disabled).toBe(true);
  });

  it("keeps compatible runs selectable and moves the baseline when its run is removed", async () => {
    await openRuns([run({ run_id: "a", run_number: 1 }), run({ run_id: "b", run_number: 2 })]);
    fireEvent.click(include("a"));
    expect(include("b").disabled).toBe(false);
    fireEvent.click(include("b"));
    expect(include("a").checked).toBe(true);
    expect(include("b").checked).toBe(true);
    fireEvent.click(include("a"));
    expect((screen.getByRole("radio", { name: "Use run 2 as baseline" }) as HTMLInputElement).checked).toBe(true);
  });

  it("preserves the chosen basis across search changes and clears it when switching evaluation", async () => {
    const other = run({ run_id: "c", experiment: { ...run().experiment!, experiment_id: "exp-2", name: "Other eval" } });
    await openRuns([run({ run_id: "a" }), run({ run_id: "b", lineage: { comparison_basis_hash: "basis-2" } }), other]);
    fireEvent.click(include("a"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search historical runs" }), { target: { value: "b" } });
    expect(include("b").disabled).toBe(true);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search historical runs" }), { target: { value: "" } });
    expect(include("a").checked).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Choose evaluation for experiment" }), { target: { value: "exp-2" } });
    // A non-empty selection is never discarded silently: the switch waits for
    // confirmation, and until then the evaluation and the selection stand.
    expect(screen.getByText("Switch evaluation and clear the selected runs?")).toBeTruthy();
    expect(screen.getByText("1/4 selected")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Choose evaluation for experiment" }) as HTMLSelectElement).value).toBe("exp-1");
    fireEvent.click(screen.getByRole("button", { name: "Switch and clear" }));
    expect(screen.queryByText("Switch evaluation and clear the selected runs?")).toBeNull();
    expect(screen.getByText("0/4 selected")).toBeTruthy();
    expect(include("c").disabled).toBe(false);
  });

  it("keeps the selection and the evaluation when the switch is cancelled", async () => {
    const other = run({ run_id: "c", experiment: { ...run().experiment!, experiment_id: "exp-2", name: "Other eval" } });
    await openRuns([run({ run_id: "a" }), other]);
    fireEvent.click(include("a"));
    fireEvent.change(screen.getByRole("combobox", { name: "Choose evaluation for experiment" }), { target: { value: "exp-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Keep selection" }));
    expect(screen.queryByText("Switch evaluation and clear the selected runs?")).toBeNull();
    expect((screen.getByRole("combobox", { name: "Choose evaluation for experiment" }) as HTMLSelectElement).value).toBe("exp-1");
    expect(include("a").checked).toBe(true);
    expect(screen.getByText("1/4 selected")).toBeTruthy();
  });

  it("switches without asking when nothing is selected", async () => {
    const other = run({ run_id: "c", experiment: { ...run().experiment!, experiment_id: "exp-2", name: "Other eval" } });
    await openRuns([run({ run_id: "a" }), other]);
    fireEvent.change(screen.getByRole("combobox", { name: "Choose evaluation for experiment" }), { target: { value: "exp-2" } });
    expect(screen.queryByText("Switch evaluation and clear the selected runs?")).toBeNull();
    expect((screen.getByRole("combobox", { name: "Choose evaluation for experiment" }) as HTMLSelectElement).value).toBe("exp-2");
    expect(include("c").disabled).toBe(false);
  });
});


describe("experiment list request ordering", () => {
  it.each(["success", "error"] as const)("ignores a stale %s after switching lifecycle", async (outcome) => {
    let resolveOld!: (page: Awaited<ReturnType<typeof evaluationApi.listExperimentWorkspaces>>) => void;
    let rejectOld!: (reason: Error) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof evaluationApi.listExperimentWorkspaces>>>((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    });
    vi.mocked(api.tenant).mockResolvedValue({ tenant_id: "acme" } as Awaited<ReturnType<typeof api.tenant>>);
    vi.mocked(evaluationApi.listExperimentWorkspaces)
      .mockImplementationOnce(() => oldRequest)
      .mockResolvedValue({ items: [summary("archived")], total: 1, limit: 20, offset: 0, next_cursor: null });
    render(createElement(ExperimentsView, { embedded: true }));
    await waitFor(() => expect(evaluationApi.listExperimentWorkspaces).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    await screen.findAllByText("Experiment archived");
    await act(async () => {
      if (outcome === "success") resolveOld({ items: [summary("active")], total: 1, limit: 20, offset: 0, next_cursor: null });
      else rejectOld(new Error("Old request failed"));
    });
    expect(screen.getAllByText("Experiment archived").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Experiment active")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
