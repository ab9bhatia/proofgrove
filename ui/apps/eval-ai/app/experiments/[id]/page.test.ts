import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "experiment-1" }),
  usePathname: () => "/evaluations/experiment-1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import {
  analysisCohortNote,
  candidateLimitHint,
  candidateSelectability,
  comparableCandidateRuns,
  ExperimentAnalysisPanel,
  experimentMetricDelta,
  experimentMeasures,
  experimentCompareDisabledReason,
  experimentCompareHref,
  experimentEvidenceScope,
  experimentTargetLabel,
  experimentTargetModel,
  fallbackBaselineRun,
  nextCandidateIds,
  selectionCounterLabel,
} from "./page";
import { readAnalysisUrlState } from "@/lib/chart-data";
import type { GateResult, RunResult } from "@/lib/api";

function run(
  runId: string,
  gate: GateResult,
  composite: number,
  opts: { basisHash?: string; startedAt?: string; kpiId?: string; status?: string } = {},
): RunResult {
  return {
    run_id: runId,
    status: opts.status ?? "completed",
    experiment: {
      experiment_id: "experiment-1",
      name: "Prompt experiment",
      dataset_version: "dataset.v1",
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
        kpi_id: opts.kpiId ?? "quality",
        run_id: runId,
        composite_score: composite,
        observed_score: composite,
        gate_result: gate,
        constituent_scores: [],
        threshold_pass: 0.8,
        threshold_warn: 0.6,
        threshold_fail: 0,
        evaluated_target: "agent",
      },
    ],
    verdict_status: "conclusive",
    overall_gate: gate,
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    started_at: opts.startedAt ?? "2026-08-12T10:00:00Z",
    completed_at: opts.startedAt ?? "2026-08-12T10:00:00Z",
    run_number: 1,
    lineage: {
      comparison_basis_hash: opts.basisHash ?? "hash-A",
      comparison_basis_version: "v2",
    } as RunResult["lineage"],
  };
}

const defaultAnalysis = readAnalysisUrlState(new URLSearchParams());

describe("ExperimentAnalysisPanel (experiment detail page)", () => {
  const runs = [
    run("r1", "pass", 0.82, { startedAt: "2026-08-10T10:00:00Z" }),
    run("r2", "warn", 0.65, { startedAt: "2026-08-11T10:00:00Z" }),
  ];

  it("offers twenty measures in one selector without rendering twenty charts", () => {
    const many = runs.map(item => ({ ...item, kpi_results: Array.from({ length: 20 }, (_, index) => ({
      ...item.kpi_results[0], kpi_id: `quality_${index}`,
    })) }));
    const html = renderToStaticMarkup(createElement(ExperimentAnalysisPanel, {
      name: "Large metric comparison", runs: many, baselineRunId: "r1",
      analysis: defaultAnalysis, onAnalysisChange: () => undefined,
    }));
    expect(experimentMeasures(many)).toHaveLength(20);
    expect(html.match(/<figure/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Analysis metric"');
    expect(html).toContain("quality_19");
  });

  it("compares every run against the selected baseline, including middle iterations", () => {
    const html = renderToStaticMarkup(createElement(ExperimentAnalysisPanel, {
      name: "Prompt experiment", runs: [...runs, run("r3", "pass", 0.9, { startedAt: "2026-08-12T10:00:00Z" })].reverse(),
      baselineRunId: "r2", onBaselineChange: () => undefined,
      analysis: defaultAnalysis, onAnalysisChange: () => undefined,
    }));
    expect(html).toContain("3 of 3 runs comparable");
    expect(html).toContain("82%");
    expect(html).toContain("65%");
    expect(html).toContain("90%");
    expect(html).toContain("17.0 pts vs baseline");
    expect(html).toContain("25.0 pts vs baseline");
    expect(html).toContain('aria-label="Analysis baseline"');
    expect(html).not.toContain("Evaluator comparison");
  });

  it("names incompatible and incomplete runs without charting their measurements", () => {
    const html = renderToStaticMarkup(createElement(ExperimentAnalysisPanel, {
      name: "Mixed experiment", baselineRunId: "r1", runs: [...runs,
        run("other", "fail", 0.4, { basisHash: "other" }),
        run("running", "pass", 0.3, { status: "running" }),
      ], analysis: defaultAnalysis, onAnalysisChange: () => undefined,
    }));
    expect(html).toContain("2 runs excluded");
    expect(html).toContain("Different or missing comparison basis");
    expect(html).toContain("Run running");
    expect(html).not.toContain("40%");
    expect(html).not.toContain("30%");
  });

  it("keeps zero baselines and missing candidate measurements distinct", () => {
    const baseline = run("zero", "fail", 0);
    const candidate = run("higher", "pass", 0.25);
    const measure = experimentMeasures([baseline, candidate])[0];
    expect(measure.value(baseline)).toBe(0);
    expect(experimentMetricDelta(measure, candidate, baseline)).toContain("25.0 pts");
    candidate.kpi_results = [];
    expect(experimentMetricDelta(measure, candidate, baseline)).toBe("Change unavailable");
  });

  it("shows an honest empty state when the baseline has no measurements", () => {
    const empty = run("empty", "pass", 0);
    empty.kpi_results = [];
    const html = renderToStaticMarkup(createElement(ExperimentAnalysisPanel, {
      name: "Empty", baselineRunId: "empty", runs: [empty],
      analysis: defaultAnalysis, onAnalysisChange: () => undefined,
    }));
    expect(html).toContain("No comparable measurements recorded");
    expect(html).not.toContain("0%");
  });

});

describe("analysisCohortNote", () => {
  it("names the comparable cohort when runs share one basis", () => {
    const runs = [
      run("r1", "pass", 0.82, { startedAt: "2026-08-10T10:00:00Z" }),
      run("r2", "warn", 0.65, { startedAt: "2026-08-11T10:00:00Z" }),
    ];
    expect(analysisCohortNote(runs)).toBe(
      "2 of 2 completed runs share the same comparison basis.",
    );
  });

  it("refuses to imply comparability across mixed bases", () => {
    const runs = [
      run("r1", "pass", 0.82, { basisHash: "hash-A" }),
      run("r2", "warn", 0.65, { basisHash: "hash-B" }),
    ];
    expect(analysisCohortNote(runs)).toContain("cannot be compared safely");
  });

  it("asks for a second run before promising a trend", () => {
    expect(analysisCohortNote([run("r1", "pass", 0.82)])).toBe(
      "Complete at least two runs of this experiment to chart a comparable trend.",
    );
  });
});

describe("experimentEvidenceScope", () => {
  function withScope(base: RunResult, scope: string | null): RunResult {
    return {
      ...base,
      lineage: {
        ...(base.lineage ?? {}),
        resolved_evaluation_scope: scope,
      } as RunResult["lineage"],
    };
  }

  it("uses the experiment's own recorded scope when present", () => {
    expect(experimentEvidenceScope("final_response", [])).toBe("Final response");
    // The experiment field wins even when runs disagree.
    expect(
      experimentEvidenceScope("full_execution", [withScope(run("r1", "pass", 0.8), "final_response")]),
    ).toBe("Full execution");
  });

  it("derives the scope from the attached runs' lineage and says so", () => {
    const runs = [
      withScope(run("r1", "pass", 0.8), "final_response"),
      withScope(run("r2", "pass", 0.9), "final_response"),
    ];
    expect(experimentEvidenceScope(null, runs)).toBe("Final response (from runs)");
    expect(experimentEvidenceScope("", runs)).toBe("Final response (from runs)");
  });

  it("names mixed scopes honestly instead of collapsing them", () => {
    const runs = [
      withScope(run("r1", "pass", 0.8), "final_response"),
      withScope(run("r2", "pass", 0.9), "full_execution"),
    ];
    expect(experimentEvidenceScope(null, runs)).toBe(
      "Mixed across runs (Final response, Full execution)",
    );
  });

  it("says Not recorded only when neither the experiment nor any run has a scope", () => {
    expect(experimentEvidenceScope(null, [run("r1", "pass", 0.8)])).toBe("Not recorded");
    expect(experimentEvidenceScope(undefined, [])).toBe("Not recorded");
  });
});


describe("experiment detail compare selection", () => {
  const base = run("base", "pass", 0.8, { startedAt: "2026-08-10T10:00:00Z" });
  const c1 = run("c1", "pass", 0.85, { startedAt: "2026-08-11T10:00:00Z" });
  const c2 = run("c2", "warn", 0.7, { startedAt: "2026-08-12T10:00:00Z" });
  const otherBasis = run("other", "pass", 0.9, {
    basisHash: "hash-B",
    startedAt: "2026-08-13T10:00:00Z",
  });
  const running = run("running", "pass", 0, {
    startedAt: "2026-08-14T10:00:00Z",
    status: "running",
  });

  it("disables Compare until a baseline is pinned", () => {
    expect(experimentCompareDisabledReason(null, [c1])).toBe("Pin a baseline");
    expect(experimentCompareHref("exp-1", null, [c1])).toBeNull();
  });

  it("disables Compare when baseline has zero candidates", () => {
    expect(experimentCompareDisabledReason(base, [])).toBe("Select at least one candidate");
    expect(experimentCompareHref("exp-1", base, [])).toBeNull();
  });

  it("enables a compare href matching the selection", () => {
    expect(experimentCompareDisabledReason(base, [c1, c2])).toBeNull();
    expect(experimentCompareHref("exp/1", base, [c1, c2])).toBe(
      "/evaluations/exp%2F1/compare?baseline_run_id=base&candidate_run_id=c1&candidate_run_id=c2",
    );
  });

  it("never links a candidate the backend would reject", () => {
    expect(experimentCompareDisabledReason(base, [c1, otherBasis])).toBe(
      "Every candidate must share the baseline's comparison basis",
    );
    expect(experimentCompareHref("exp-1", base, [c1, otherBasis])).toBeNull();
    expect(experimentCompareDisabledReason(base, [running])).toBe(
      "Every candidate must share the baseline's comparison basis",
    );
    expect(experimentCompareHref("exp-1", base, [running])).toBeNull();
  });

  it("refuses a baseline that recorded no comparison basis", () => {
    const bare = run("bare", "pass", 0.8, { startedAt: "2026-08-10T10:00:00Z" });
    bare.lineage = null;
    bare.experiment_version_id = null;
    expect(experimentCompareDisabledReason(bare, [c1])).toBe(
      "The baseline recorded no comparison basis",
    );
    expect(experimentCompareHref("exp-1", bare, [c1])).toBeNull();
  });

  it("disables incomparable candidates in the run list instead of offering them", () => {
    expect(candidateSelectability(c1, base, { selected: false, candidateCount: 0 })).toEqual({
      disabled: false,
      reason: null,
      label: "Candidate",
    });
    expect(candidateSelectability(otherBasis, base, { selected: false, candidateCount: 0 })).toEqual(
      {
        disabled: true,
        reason: "Different comparison basis from the baseline",
        label: "Not comparable",
      },
    );
    expect(candidateSelectability(running, base, { selected: false, candidateCount: 0 })).toEqual({
      disabled: true,
      reason: "Only completed runs can be compared",
      label: "Not comparable",
    });
    expect(candidateSelectability(base, base, { selected: false, candidateCount: 0 })).toEqual({
      disabled: true,
      reason: null,
      label: "Baseline",
    });
    // Already-selected candidates stay toggleable at the cap; new ones do not.
    expect(candidateSelectability(c1, base, { selected: true, candidateCount: 3 }).disabled).toBe(
      false,
    );
    expect(candidateSelectability(c1, base, { selected: false, candidateCount: 3 })).toMatchObject({
      disabled: true,
      reason: "Limit 3 candidates reached",
    });
  });

  it("falls back to the comparable cohort, never to whichever run is listed first", () => {
    // `otherBasis` is listed first but shares its basis with nothing.
    expect(fallbackBaselineRun([otherBasis, base, c1])?.run_id).toBe("base");
    // An incomplete run is never an implicit baseline.
    expect(fallbackBaselineRun([running, base, c1])?.run_id).toBe("base");
    // No comparable pair: no implicit baseline is invented.
    expect(fallbackBaselineRun([base, otherBasis])).toBeNull();
    expect(fallbackBaselineRun([])).toBeNull();
  });

  it("no-ops a fourth candidate toggle and surfaces the limit hint", () => {
    const atLimit = ["c1", "c2", "c3"];
    expect(nextCandidateIds(atLimit, "c4", "base")).toEqual(atLimit);
    expect(candidateLimitHint(3)).toBe("Limit 3 candidates reached");
    expect(candidateLimitHint(2)).toBeNull();
  });

  it("counts the cap over the same comparable set the counter renders", () => {
    // `otherBasis` and `running` linger in state but are not comparable, so the
    // counter shows 1. The cap must agree: a legal second candidate is still
    // selectable instead of being refused against an inflated count.
    const runs = [base, c1, c2, otherBasis, running];
    const stale = ["c1", "other", "running"];
    const comparable = comparableCandidateRuns(runs, base, stale).map((r) => r.run_id);
    expect(comparable).toEqual(["c1"]);
    expect(selectionCounterLabel(comparable.length)).toBe(
      "1 baseline · 1 of 3 candidates selected",
    );
    expect(nextCandidateIds(comparable, "c2", "base")).toEqual(["c1", "c2"]);
    // The baseline itself is never part of the comparable candidate set.
    expect(comparableCandidateRuns(runs, base, ["base", "c1"]).map((r) => r.run_id)).toEqual([
      "c1",
    ]);
  });

  it("renders the selection counter as 1 baseline · N of 3", () => {
    expect(selectionCounterLabel(0)).toBe("1 baseline · 0 of 3 candidates selected");
    // Without a pinned baseline the counter must not claim one: the rows beside
    // it read "Pin a baseline first".
    expect(selectionCounterLabel(0, false)).toBe("No baseline · 0 of 3 candidates selected");
    expect(selectionCounterLabel(2, false)).toBe("No baseline · 2 of 3 candidates selected");
    expect(selectionCounterLabel(1)).toBe("1 baseline · 1 of 3 candidates selected");
    expect(selectionCounterLabel(3)).toBe("1 baseline · 3 of 3 candidates selected");
  });
});

describe("experimentTargetModel", () => {
  function withModel(runId: string, model: string | null): RunResult {
    return {
      run_id: runId,
      lineage: model ? ({ resolved_target_provenance: { model } } as RunResult["lineage"]) : null,
    } as RunResult;
  }
  const experiment = { target_endpoint: "https://example.test/agent" } as never;

  it("reports one model when every run recorded the same one", () => {
    expect(experimentTargetModel(experiment, [withModel("a", "gpt-4.1-mini"), withModel("b", "gpt-4.1-mini")]))
      .toBe("gpt-4.1-mini");
  });

  it("says so when runs disagree, rather than picking whichever came first", () => {
    // Reading the first run carrying lineage made the header depend on array
    // order and misdescribe every other run.
    expect(experimentTargetModel(experiment, [withModel("a", "gpt-4.1-mini"), withModel("b", "gpt-5.1")]))
      .toBe("Mixed across runs");
  });

  it("falls back to the experiment's own target when no run recorded a model", () => {
    expect(experimentTargetModel(experiment, [withModel("a", null)])).toBe("https://example.test/agent");
  });

  it("does not present stored dataset responses as an invoked experiment target", () => {
    const storedExperiment = { target_endpoint: "golden-dataset:stored.v1" } as never;
    const storedRun = run("stored", "pass", 1);
    storedRun.response_source = "provided";
    storedRun.experiment = storedExperiment;

    expect(experimentTargetLabel(storedExperiment, [storedRun])).toBe("Not invoked");
    expect(experimentTargetLabel(storedExperiment, [])).toBe("Not invoked");
  });
});
