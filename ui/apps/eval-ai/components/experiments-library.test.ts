import { formatDateTimeOrNull } from "@/lib/format-time";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let mockSearchParams = "";

vi.mock("next/navigation", () => ({
  usePathname: () => "/experiments",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mockSearchParams),
}));

import {
  ComparisonSelectionTray,
  comparisonHrefForRuns,
  deltaAgainstPrevious,
  EvaluationLifecycleDialog,
  ExperimentsLibrary,
  groupRunsByName,
  isRunStoppable,
  presentRunEnd,
  presentRunStart,
  ReportDrawer,
  StopRunDialog,
  runDurationLabel,
  runMatchesFilters,
  runFilterMayHaveUnloadedMatches,
  tracesHrefForRun,
  trayRunName,
  COLUMN_DEFS,
} from "@/components/experiments-library";
import type { RunResult } from "@/lib/api";

function scoredRun(
  runId: string,
  experimentVersionId: string,
  composite: number,
  datasetVersion = "dataset.v1",
): RunResult {
  return {
    run_id: runId,
    status: "completed",
    experiment: {
      experiment_id: "experiment/shared",
      name: "Scored evaluation",
      dataset_version: datasetVersion,
      target_endpoint: "https://example.test/agent",
      scenario: "agentic",
      market: "global",
      judge_model: "gpt-4o",
      judge_temperature: 0,
      has_ground_truth: true,
      tags: {},
    },
    metric_results: [],
    kpi_results: [
      {
        kpi_id: "quality",
        run_id: runId,
        composite_score: composite,
        gate_result: "pass",
        constituent_scores: [],
        threshold_pass: 0.8,
        threshold_warn: 0.6,
        threshold_fail: 0,
        evaluated_target: "agent",
      },
    ],
    verdict_status: "conclusive",
    overall_gate: "pass",
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    started_at: "2026-08-12T10:00:00Z",
    completed_at: "2026-08-12T10:00:00Z",
    run_number: 1,
    experiment_version_id: experimentVersionId,
  };
}

describe("deltaAgainstPrevious", () => {
  it("returns a numeric delta when both runs share the same comparison basis", () => {
    const current = scoredRun("run-current", "version-shared", 0.75);
    const previous = scoredRun("run-previous", "version-shared", 0.7);

    const result = deltaAgainstPrevious(current, previous);

    expect(result.kind).toBe("value");
    if (result.kind === "value") {
      expect(result.delta).toBeCloseTo(0.05, 5);
    }
  });

  it("refuses to delta across a different comparison basis", () => {
    const current = scoredRun("run-current", "version-a", 0.75);
    const previous = scoredRun("run-previous", "version-b", 0.7);

    const result = deltaAgainstPrevious(current, previous);

    expect(result.kind).toBe("incomparable");
    if (result.kind === "incomparable") {
      expect(result.reason).toBeTruthy();
    }
  });

  it("names the differing dataset when the basis diverges", () => {
    const current = scoredRun("run-current", "version-a", 0.75, "dataset.v2");
    const previous = scoredRun("run-previous", "version-b", 0.7, "dataset.v1");

    const result = deltaAgainstPrevious(current, previous);

    expect(result).toEqual({ kind: "incomparable", reason: "different dataset" });
  });

  it("has no delta when there is no previous run", () => {
    expect(deltaAgainstPrevious(scoredRun("solo", "version-a", 0.75), undefined)).toEqual({
      kind: "none",
    });
  });
});

function run(
  runId: string,
  experimentId: string,
  startedAt: string,
  runNumber: number,
  name = "Shared experiment name",
  experimentVersionId = `version-${experimentId}`,
): RunResult {
  return {
    run_id: runId,
    status: "completed",
    experiment: {
      experiment_id: experimentId,
      name,
      dataset_version: "dataset.v1",
      target_endpoint: "https://example.test/agent",
      scenario: "agentic",
      market: "global",
      judge_model: "gpt-4o",
      judge_temperature: 0,
      has_ground_truth: true,
      tags: { evaluation_name: name },
    },
    metric_results: [],
    kpi_results: [],
    overall_gate: "pass",
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    started_at: startedAt,
    completed_at: startedAt,
    run_number: runNumber,
    experiment_version_id: experimentVersionId,
  };
}

describe("ExperimentsLibrary", () => {
  it("builds a persisted two-run comparison and rejects unrelated evaluations", () => {
    const older = run("run older", "experiment/shared", "2026-08-11T10:00:00Z", 1);
    const newer = run("run/newer", "experiment/shared", "2026-08-12T10:00:00Z", 2);
    const unrelated = run("run-other", "experiment-other", "2026-08-13T10:00:00Z", 1);

    expect(comparisonHrefForRuns([newer, older])).toBe(
      "/evaluations/experiment%2Fshared/compare?baseline_run_id=run%20older&candidate_run_id=run%2Fnewer",
    );
    expect(comparisonHrefForRuns([older])).toBeNull();
    expect(comparisonHrefForRuns([older, unrelated])).toBeNull();
  });

  it("builds an explicit baseline comparison with up to three candidates", () => {
    const runs = [
      run("baseline", "experiment/shared", "2026-08-10T10:00:00Z", 1),
      run("candidate-1", "experiment/shared", "2026-08-11T10:00:00Z", 2),
      run("candidate-2", "experiment/shared", "2026-08-12T10:00:00Z", 3),
      run("candidate-3", "experiment/shared", "2026-08-13T10:00:00Z", 4),
    ];

    expect(comparisonHrefForRuns(runs, "baseline")).toBe(
      "/evaluations/experiment%2Fshared/compare?baseline_run_id=baseline&candidate_run_id=candidate-1&candidate_run_id=candidate-2&candidate_run_id=candidate-3",
    );
    expect(
      comparisonHrefForRuns(
        [...runs, run("candidate-4", "experiment/shared", "2026-08-14T10:00:00Z", 5)],
        "baseline",
      ),
    ).toBeNull();
  });

  it("allows historical runs with separate parents when their immutable setup matches", () => {
    const baseline = run(
      "baseline-run",
      "historical-parent-a",
      "2026-08-11T10:00:00Z",
      1,
      "Historical evaluation",
      "exp-shared-version",
    );
    const candidate = run(
      "candidate-run",
      "historical-parent-b",
      "2026-08-12T10:00:00Z",
      1,
      "Historical evaluation",
      "exp-shared-version",
    );

    expect(comparisonHrefForRuns([candidate, baseline])).toBe(
      "/evaluations/historical-parent-a/compare?baseline_run_id=baseline-run&candidate_run_id=candidate-run",
    );
  });

  it("groups by evaluation name and collapses run details by default", () => {
    const html = renderToStaticMarkup(
      createElement(ExperimentsLibrary, {
        runs: [
          run("run-new", "experiment-b", "2026-08-12T10:00:00Z", 1, undefined, "shared-version"),
          run("run-old", "experiment-a", "2026-08-11T10:00:00Z", 9, undefined, "shared-version"),
        ],
        loading: false,
      }),
    );

    expect(html).not.toContain("run-new");
    expect(html).not.toContain("run-old");
    expect(html).toContain("Shared experiment name");
    expect(html).not.toContain('href="/experiments/experiment-b"');
    expect(html).not.toContain('title="Open evaluation"');
    expect(html).toContain('aria-label="Expand runs for Shared experiment name"');
    // The footer states the evaluation range once. "N runs on this page"
    // restated that range in a different unit right beside it.
    expect(html).toContain(">2</span> evaluations");
    expect(html).not.toContain("runs on this page");
    expect(html).toContain("Latest KPI composite");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-label="Run comparison selection"');
    expect(html).not.toContain('aria-label="Compare runs for Shared experiment name"');
    expect(html).not.toContain("0/2");
    expect(html).not.toContain("Run Experiment");
    expect(html).toContain("Run table columns");
    expect(html).not.toContain("Select as baseline");
    expect(html).toMatch(/<th[^>]*>Evaluation<\/th>/i);
    // Each sortable header is a button whose label is followed by a visible
    // sort chevron (aria-sort alone left sighted users without the state).
    expect(html).toMatch(/>Runs<svg[^>]*class="[^"]*lucide-chevrons-up-down[^"]*"/);
    expect(html).toMatch(/>Latest KPI composite<svg[^>]*class="[^"]*lucide-chevrons-up-down[^"]*"/);
    expect(html).toMatch(/>Last run<svg[^>]*class="[^"]*lucide-chevron-down[^"]*"/);
    expect(html).toContain('title="Sorted descending. Activate to sort ascending."');
    expect(html).toMatch(/aria-sort="descending"/);
    expect(html).toMatch(/<th[^>]*>Latest outcome<\/th>/i);
    expect(html).not.toContain("Show run IDs");
    expect(html).toContain("Export view (CSV)");
    expect(html).toMatch(/aria-sort="descending"[^>]*><button[\s\S]{0,300}>Last run</);
    expect(html).toContain('placeholder="Search evaluations or prompt versions…"');
    // Search, the lifecycle switch and Export — nothing else. Every run on the
    // cluster is Completed and judged by one model, so a status or judge filter
    // sorts nothing; the Advanced toggle and the Columns menu that hid the rest
    // are both gone.
    expect(html).toContain('aria-label="Evaluation lifecycle"');
    for (const gone of ["Any status", "Any type", "Any date", "Toggle advanced filters", ">Columns<"]) {
      expect(html).not.toContain(gone);
    }
    expect(html).not.toContain("Hide 1 earlier run");
    expect(html).not.toMatch(/placeholder="Search runs"/i);
    expect(html).not.toMatch(/<th[^>]*>Previous<\/th>/i);
    expect(html).not.toMatch(/<th[^>]*>Quality report<\/th>/i);
    expect(html).not.toMatch(/<th[^>]*>Recommendation<\/th>/i);
    expect(html).toContain('aria-label="Evaluation actions"');
    expect(html).toContain('<span class="sr-only">Actions</span>');
    expect(html).toContain('class="w-[6%]"');
  });

  it("keeps expanded groups lean: multi-run analysis lives on the experiment detail page", () => {
    mockSearchParams = "expanded=evaluation%3Aexperiment-1";
    try {
      const html = renderToStaticMarkup(
        createElement(ExperimentsLibrary, {
          runs: [
            run("run-new", "experiment-1", "2026-08-12T10:00:00Z", 2, undefined, "shared-version"),
            run("run-old", "experiment-1", "2026-08-11T10:00:00Z", 1, undefined, "shared-version"),
          ],
          loading: false,
        }),
      );

      expect(html).toContain('aria-expanded="true"');
      // The run rows and compare-selection affordances stay…
      expect(html).toContain("Run 2");
      expect(html).toContain("Run 1");
      expect(html).toMatch(/<button[^>]*>Run ID<svg/);
      expect(html).toContain('<span class="pr-2">Traces</span>');
      expect(html).toContain("run-new");
      expect(html).toContain("run-old");
      expect(html).toContain("2 of 2 completed runs share the same comparison basis.");
      expect(html).toMatch(/type="checkbox"/i);
      // …but the analysis charts/table moved to the experiment detail page.
      expect(html).not.toContain('aria-label="Analysis view"');
      expect(html).not.toContain("Ops latency");
      expect(html).not.toContain("KPI slope");
    } finally {
      mockSearchParams = "";
    }
  });

  it("links a run to its exact project-scoped trace filter", () => {
    const linked = run("run/with space", "experiment-1", "2026-08-12T10:00:00Z", 1);
    linked.lineage = { project_id: "project/with space" };

    expect(tracesHrefForRun(linked)).toBe(
      "/projects/project%2Fwith%20space/traces?run_id=run%2Fwith%20space",
    );
    expect(tracesHrefForRun({ ...linked, lineage: undefined, experiment: { ...linked.experiment!, project_id: null } })).toBeNull();
  });

  it("renders passing and attention outcomes as the same badge family", () => {
    mockSearchParams = "expanded=evaluation%3Aexperiment-1";
    try {
      const passing = {
        ...run(
          "run-pass",
          "experiment-1",
          "2026-08-11T10:00:00Z",
          1,
          undefined,
          "shared-version",
        ),
        verdict_status: "conclusive",
      } satisfies RunResult;
      const partial = {
        ...run(
          "run-partial",
          "experiment-1",
          "2026-08-12T10:00:00Z",
          2,
          undefined,
          "shared-version",
        ),
        status: "completed_with_partial_evidence",
        overall_gate: null,
      } satisfies RunResult;

      const html = renderToStaticMarkup(
        createElement(ExperimentsLibrary, { runs: [partial, passing], loading: false }),
      );

      // Both outcomes are badges, in one shape. Pass keeps the gate-pass token:
      // a release verdict is the one outcome the app states in colour everywhere.
      // "Pass · ungoverned": the run carries no quality contract, so the gate is
      // real but not a governed verdict. The badge used to drop the qualifier.
      // The radius is asserted from this commit on, which is where the pill
      // lands — the tone and label were already guarded two commits below.
      expect(html).toMatch(/class="[^"]*rounded-full[^"]*bg-gate-pass-soft[^"]*"[^>]*>Pass · ungoverned<\/span>/);
      expect(html).toMatch(
        /class="[^"]*rounded-full[^"]*bg-gate-warn-soft[^"]*"[^>]*>Partial evidence<\/span>/,
      );
    } finally {
      mockSearchParams = "";
    }
  });

  it("paginates evaluation groups without splitting their runs", () => {
    const runs = Array.from({ length: 10 }, (_, index) =>
      run(
        `run-${index + 1}`,
        `experiment-${index + 1}`,
        `2026-08-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
        1,
        `Evaluation ${index + 1}`,
      ),
    );
    const html = renderToStaticMarkup(
      createElement(ExperimentsLibrary, { runs, loading: false }),
    );

    expect(html).toContain("Showing");
    expect(html).toContain("of <span class=\"font-medium text-foreground\">10</span> evaluations");
    expect(html).toContain("Page 1 of 2");
    expect(html).toContain('aria-label="Evaluation runs pagination"');
    expect(html).toContain("Evaluation 10");
    expect(html).not.toContain("Evaluation 2");
  });

  it("keeps archived evaluations out of the active view and exposes the lifecycle switch", () => {
    const active = run(
      "run-active",
      "experiment-active",
      "2026-08-12T10:00:00Z",
      1,
      "Active evaluation",
    );
    const archived = run(
      "run-archived",
      "experiment-archived",
      "2026-08-11T10:00:00Z",
      1,
      "Archived evaluation",
    );
    archived.experiment!.status = "archived";

    const html = renderToStaticMarkup(
      createElement(ExperimentsLibrary, { runs: [active, archived], loading: false }),
    );

    expect(html).toContain("Active evaluation");
    expect(html).not.toContain(">Archived evaluation<");
    expect(html).toContain("Active (1)");
    expect(html).toContain("Archived (1)");
    expect(html).toContain('aria-label="Evaluation lifecycle"');
    expect(html).toContain('aria-label="Archive Active evaluation"');
    expect(html).toContain('title="Archive evaluation"');
    expect(html).not.toMatch(/aria-label="Archive Active evaluation"[^>]*>\s*Archive\s*<\/button>/);
  });

  it("explains that archive preserves evidence and restore returns the evaluation", () => {
    const evaluationRun = run(
      "run-1",
      "experiment-1",
      "2026-08-12T10:00:00Z",
      1,
      "Customer support evaluation",
    );
    const group = groupRunsByName([evaluationRun])[0]!;

    const archiveHtml = renderToStaticMarkup(
      createElement(EvaluationLifecycleDialog, {
        action: "archive",
        group,
        busy: false,
        onCancel: () => undefined,
        onConfirm: () => undefined,
      }),
    );
    const restoreHtml = renderToStaticMarkup(
      createElement(EvaluationLifecycleDialog, {
        action: "restore",
        group,
        busy: false,
        onCancel: () => undefined,
        onConfirm: () => undefined,
      }),
    );

    expect(archiveHtml).toContain('role="dialog"');
    expect(archiveHtml).toContain("w-[min(28rem,calc(100vw-2rem))]");
    expect(archiveHtml).toContain("max-h-[min(760px,90vh)]");
    expect(archiveHtml).toContain("flex-col-reverse");
    expect(archiveHtml).toContain("w-full sm:w-auto");
    expect(archiveHtml).toContain("Archive evaluation?");
    expect(archiveHtml).toContain("reports, and evidence will remain available in Archived");
    expect(restoreHtml).toContain("Restore evaluation?");
    expect(restoreHtml).toContain("return to Active evaluations");
  });

  it("shows the comparison tray immediately after choosing a baseline", () => {
    const comparisonRuns = Array.from({ length: 4 }, (_, index) =>
      run(
        `run-${index + 1}`,
        "experiment-shared",
        `2026-08-${String(index + 10).padStart(2, "0")}T10:00:00Z`,
        index + 1,
        "Agent regression evaluation",
        "shared-version",
      ),
    );
    const html = renderToStaticMarkup(
      createElement(ComparisonSelectionTray, {
        runs: [comparisonRuns[0]!],
        onRemove: () => undefined,
        onClear: () => undefined,
        onCompare: () => undefined,
      }),
    );

    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Run comparison selection"');
    expect(html).toContain("1 run selected");
    expect(html).toContain("Select at least one candidate");
    expect(html).toContain("Baseline");
    expect(html).toContain("Compare runs");
    expect(html).toContain("bottom-[max(1.25rem,env(safe-area-inset-bottom))]");
    expect(html).not.toContain("max-w-");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Compare runs.*<\/button>/s);
  });

  it("labels one baseline and up to three candidates in the comparison tray", () => {
    const comparisonRuns = Array.from({ length: 4 }, (_, index) =>
      run(
        `run-${index + 1}`,
        "experiment-shared",
        `2026-08-${String(index + 10).padStart(2, "0")}T10:00:00Z`,
        index + 1,
        "Agent regression evaluation",
        "shared-version",
      ),
    );
    const html = renderToStaticMarkup(
      createElement(ComparisonSelectionTray, {
        runs: comparisonRuns,
        onRemove: () => undefined,
        onClear: () => undefined,
        onCompare: () => undefined,
      }),
    );

    expect(html).toContain("4 runs selected");
    expect(html).toContain("1 baseline · 3 candidates");
    expect(html).toContain("Candidate 1");
    expect(html).toContain("Candidate 2");
    expect(html).toContain("Candidate 3");
    expect(html).toContain("Compare 4 runs");
  });

  it("surfaces the user's run labels in the comparison tray rows", () => {
    const selection = [
      { ...run("run-b", "experiment-a", "2026-08-10T10:00:00Z", 1), label: "Prod baseline" },
      { ...run("run-c", "experiment-b", "2026-08-11T10:00:00Z", 1), label: "Candidate A" },
    ];
    const html = renderToStaticMarkup(
      createElement(ComparisonSelectionTray, {
        runs: selection,
        onRemove: () => undefined,
        onClear: () => undefined,
        onCompare: () => undefined,
      }),
    );

    expect(html).toContain("Prod baseline");
    expect(html).toContain("Candidate A");
    // The colliding run_number 1 must not be what identifies the rows.
    expect(html).not.toContain("Run 1");
  });

  it("never identifies colliding run numbers as the same run in the tray", () => {
    const labelled = { ...run("run-l", "experiment-a", "2026-08-10T10:00:00Z", 1), label: "Baseline" };
    const collidingA = run("run-x", "experiment-b", "2026-08-11T10:00:00Z", 1);
    const collidingB = run("run-y", "experiment-c", "2026-08-12T10:00:00Z", 1);
    const unique = run("run-u", "experiment-d", "2026-08-13T10:00:00Z", 5);
    const selection = [labelled, collidingA, collidingB, unique];

    expect(trayRunName(labelled, selection)).toBe("Baseline");
    // run_number 1 collides across distinct experiments: fall back to time,
    // never present two different runs both as "Run 1".
    expect(trayRunName(collidingA, selection)).not.toBe("Run 1");
    expect(trayRunName(collidingB, selection)).not.toBe("Run 1");
    expect(trayRunName(collidingA, selection)).not.toBe(trayRunName(collidingB, selection));
    // A genuinely unique run number is still the clearest name.
    expect(trayRunName(unique, selection)).toBe("Run 5");
  });

  it("gives the run drawer a direct comparison path and keeps setup actions secondary", () => {
    const older = run(
      "baseline-run",
      "experiment-shared",
      "2026-08-11T10:00:00Z",
      1,
      "Agent regression evaluation",
      "shared-version",
    );
    const newer = run(
      "candidate-run",
      "experiment-shared",
      "2026-08-12T10:00:00Z",
      2,
      "Agent regression evaluation",
      "shared-version",
    );
    const group = groupRunsByName([newer, older])[0]!;
    const html = renderToStaticMarkup(
      createElement(ReportDrawer, {
        run: newer,
        group,
        onClose: () => undefined,
      }),
    );

    expect(html).toContain("Compare runs");
    expect(html).toContain(
      "/evaluations/experiment-shared/compare?baseline_run_id=baseline-run&amp;candidate_run_id=candidate-run",
    );
    expect(html).toContain("Full report");
    expect(html).toContain("Run evaluation");
    expect(html).not.toContain(">Rerun<");
    expect(html).not.toContain(">Edit setup<");
  });
});

describe("runFilterMayHaveUnloadedMatches", () => {
  it("flags an empty filtered result when more runs exist beyond the loaded slice", () => {
    // 25 runs loaded, 120 held server-side: matches may sit beyond the cap.
    expect(runFilterMayHaveUnloadedMatches(true, 25, 120)).toBe(true);
  });

  it("does not over-claim when the loaded slice already covers every run", () => {
    expect(runFilterMayHaveUnloadedMatches(true, 40, 40)).toBe(false);
    expect(runFilterMayHaveUnloadedMatches(true, 40, 30)).toBe(false);
  });

  it("stays quiet without an active filter or a known server total", () => {
    expect(runFilterMayHaveUnloadedMatches(false, 25, 120)).toBe(false);
    expect(runFilterMayHaveUnloadedMatches(true, 25, null)).toBe(false);
  });
});

describe("run start and end", () => {
  function timedRun(
    runId: string,
    startedAt: string,
    completedAt: string | null,
    status = "completed",
    runNumber = 1,
  ): RunResult {
    const value = run(runId, "experiment-1", startedAt, runNumber, "Timed evaluation", "shared-version");
    value.status = status;
    value.completed_at = completedAt;
    return value;
  }

  it("reports the true end of a finished run and how long it took", () => {
    const finished = timedRun("run-done", "2026-08-12T10:00:00Z", "2026-08-12T10:01:30Z");

    expect(presentRunEnd(finished).state).toBeNull();
    expect(presentRunEnd(finished).time).toBe(formatDateTimeOrNull("2026-08-12T10:01:30Z"));
    expect(runDurationLabel(finished)).toBe("1m 30s");
    expect(runDurationLabel(timedRun("s", "2026-08-12T10:00:00Z", "2026-08-12T10:00:42Z"))).toBe("42s");
    expect(runDurationLabel(timedRun("h", "2026-08-12T10:00:00Z", "2026-08-12T12:30:00Z"))).toBe("2h 30m");
  });

  it("leaves End empty while running and names other honest states without borrowing Start", () => {
    const states: [string, string][] = [
      ["pending", "Pending"],
      ["failed", "Did not finish"],
      ["blocked", "Blocked"],
      ["cancelled", "Stopped"],
      // A run marked complete with no completion time is a gap in the record,
      // not a finished run: say so rather than inventing a timestamp.
      ["completed", "End time not recorded"],
    ];

    for (const [status, label] of states) {
      const unfinished = timedRun(`run-${status}`, "2026-08-12T10:00:00Z", null, status);
      expect(presentRunEnd(unfinished)).toEqual({ time: null, state: label });
      // No em dash, no blank, no start time wearing an end time's label.
      expect(presentRunEnd(unfinished).state).not.toBe("—");
      expect(presentRunEnd(unfinished).state).not.toBe("");
      expect(presentRunEnd(unfinished).state).not.toBe(presentRunStart(unfinished));
      expect(runDurationLabel(unfinished)).toBeNull();
    }

    const running = timedRun("run-running", "2026-08-12T10:00:00Z", null, "running");
    expect(presentRunEnd(running)).toEqual({ time: null, state: null });
    expect(runDurationLabel(running)).toBeNull();
  });

  it("offers Stop only for active runs and confirms the destructive action", () => {
    const running = timedRun("run-live", "2026-08-12T12:00:00Z", null, "running", 3);
    const finished = timedRun("run-done", "2026-08-12T10:00:00Z", "2026-08-12T10:01:30Z", "completed", 1);
    expect(isRunStoppable(running)).toBe(true);
    expect(isRunStoppable({ status: "pending" })).toBe(true);
    expect(isRunStoppable({ status: "awaiting_trace" })).toBe(true);
    expect(isRunStoppable(finished)).toBe(false);
    expect(isRunStoppable({ status: "cancelled" })).toBe(false);

    mockSearchParams = "expanded=evaluation%3Aexperiment-1";
    try {
      const html = renderToStaticMarkup(
        createElement(ExperimentsLibrary, { runs: [running, finished], loading: false }),
      );
      expect(html).toContain("Stop evaluation run");
      const stopCell = (html.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).find(cell => cell.includes('aria-label="Stop run run-live"'));
      expect(stopCell).toBeDefined();
      expect(stopCell).not.toContain("Copy");
      expect(stopCell).not.toContain("Open run progress");
      expect(html).toContain(">Stop</th>");
      expect(html.match(/Stop evaluation run"/g)).toHaveLength(1);
      const completedHtml = renderToStaticMarkup(
        createElement(ExperimentsLibrary, { runs: [finished], loading: false }),
      );
      expect(completedHtml).not.toContain("sticky right-0");
      expect(completedHtml).not.toContain(">Actions</th>");
    } finally {
      mockSearchParams = "";
    }

    const dialog = renderToStaticMarkup(
      createElement(StopRunDialog, {
        run: running,
        busy: false,
        error: null,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );
    expect(dialog).toContain("Stop evaluation run?");
    expect(dialog).toContain("prevents incomplete results from being published");
    expect(dialog).toContain("run-live");
    expect(dialog).toContain("Keep running");
    expect(dialog).toContain("Stop run");
  });

  it("keeps the start honest and refuses to measure an impossible duration", () => {
    const started = timedRun("run-live", "2026-08-12T10:00:00Z", null, "running");
    expect(presentRunStart(started)).toBe(formatDateTimeOrNull("2026-08-12T10:00:00Z"));

    const noStart = timedRun("run-nostart", "", null, "running");
    expect(presentRunStart(noStart)).toBe("Start time not recorded");

    // An end before the start is bad data, not a negative duration.
    expect(runDurationLabel(timedRun("run-skew", "2026-08-12T10:05:00Z", "2026-08-12T10:00:00Z"))).toBeNull();
  });
});

describe("the run table's fixed column set", () => {
  it("offers start and end time alongside the run identity and results", () => {
    // Eleven columns ran the table to 1469px inside a 1130px pane: the checkbox
    // and run number scrolled out of reach, and Start overprinted End. Outcome
    // restated Status, Label was empty on every run, and Type and Judge are
    // properties of the evaluation these rows already sit under — one judge
    // across all fifty runs, one type in 22 of 23 groups. Traces stays: it is
    // the only column that opens the project-scoped capture filter.
    const ids = COLUMN_DEFS.map((column) => column.id);
    expect(ids).toEqual(["name", "run_id", "traces", "score", "delta", "status", "started", "ended"]);
    for (const gone of ["label", "pass", "type", "judge"]) {
      expect(ids).not.toContain(gone);
    }
  });

  it("names every absence instead of printing a bare dash", () => {
    const html = renderToStaticMarkup(
      createElement(ExperimentsLibrary, {
        runs: [run("run-1", "experiment-1", "2026-08-12T10:00:00Z", 1)],
        loading: false,
      }),
    );
    expect(html).not.toContain(">—<");
  });
});

it("finds runs by exact target prompt version as well as evaluation name", () => {
  const run = { ...scoredRun("run-1", "exp-v1", 0.9), lineage: { target_prompt_ref: "support:v2", target_prompt_version: "version-456" } } as RunResult;
  const filters = { name: "version-456", type: "" as const, status: "" as const, dateMode: "any" as const, date: "", dateFrom: "", dateTo: "" };
  expect(runMatchesFilters(run, filters)).toBe(true);
  expect(runMatchesFilters(run, { ...filters, name: "support:v2" })).toBe(true);
  expect(runMatchesFilters(run, { ...filters, name: "support:v3" })).toBe(false);
});

it("does not group active runs as historical before their evaluation ID arrives", () => {
 const a = { ...scoredRun("active-a", "v1", 0), status: "running" };
 const b = { ...scoredRun("active-b", "v1", 0), status: "pending" };
 a.experiment!.experiment_id = undefined;
 b.experiment!.experiment_id = undefined;
 const groups = groupRunsByName([a,b]);
 expect(groups).toHaveLength(2);
 expect(groups.map(g => g.key)).toEqual(["active:active-a", "active:active-b"]);
 expect(groups.every(g => g.name !== "Ungrouped historical runs")).toBe(true);
 a.status = "cancelled";
 a.experiment!.tags = { evaluation_name: "Synthetic stop check" };
 expect(groupRunsByName([a])[0].key).toBe("active:active-a");
 expect(groupRunsByName([a])[0].name).toBe("Synthetic stop check");
});
