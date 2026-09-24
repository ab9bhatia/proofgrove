import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  readCompareViewState,
  writeCompareViewState,
  buildBackendSampleRows,
  buildSummary,
  ConfigurationTab,
  IncompleteSelection,
  joinRunLabels,
  OverviewTab,
  EvaluatorComparisonTable,
  rankComparisonValues,
  requestedComparisonRunIds,
  resolveComparisonSelection,
  ResultsTable,
  RunSelector,
  SampleTable,
  TraceComparisonDialog,
} from "@/app/experiments/[id]/compare/page";
import type { RunComparison, RunItemDetail, RunResult } from "@/lib/api";

describe("independent evaluator comparison", () => {
  it("keeps zero correctness visible beside high relevance and excludes measurements", () => {
    const baseline = run("base", 1, "2026-09-09T00:00:00Z");
    const example = runItemDetail("base").scorer_results[0];
    baseline.metric_results = [
      { ...example, metric_id: "llm.correctness", score: 0, normalised_score: 0, threshold_result: "fail" },
      { ...example, metric_id: "llm.relevance", score: 1, normalised_score: 1 },
      { ...example, metric_id: "ops.latency_ms", score: 200, normalised_score: null, threshold_result: null },
    ];
    const candidate = run("candidate", 2, "2026-09-09T00:01:00Z");
    candidate.metric_results = [{ ...example, metric_id: "llm.correctness", metric_status: "technical_error", normalised_score: null, threshold_result: null }];
    const html = renderToStaticMarkup(createElement(EvaluatorComparisonTable, { runs: [baseline, candidate] }));
    expect(html).toContain("0.0% average");
    expect(html).toContain("100.0% average");
    expect(html).toContain("0 / 1 passed");
    expect(html).toContain("Not scored");
    expect(html).toContain("Not recorded");
    expect(html).toContain("1 scoring error");
    expect(html).not.toContain("Latency");
  });

  it("does not invent quality results when only operational measurements exist", () => {
    const baseline = run("base", 1, "2026-09-09T00:00:00Z");
    baseline.active_metrics = ["ops.latency_ms"];
    const html = renderToStaticMarkup(createElement(EvaluatorComparisonTable, { runs: [baseline] }));
    expect(html).toContain("No evaluator results recorded");
  });
});

function run(id: string, number: number, completedAt: string, label?: string): RunResult {
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
    started_at: completedAt,
    completed_at: completedAt,
    run_number: number,
    label,
  };
}

function runItemDetail(runId: string): RunItemDetail {
  return {
    run_id: runId,
    example_id: "case-1",
    sequence_position: 1,
    dataset_version: "support.v4",
    input: { query: "How do I cancel?" },
    output: { response: "Open settings and select Cancel subscription." },
    expected: null,
    metadata: null,
    retrieval_snippets: null,
    expected_tools: [],
    tool_calls: [],
    tool_result_artifacts: [],
    execution: {
      invocation_id: null,
      kagent_session_id: null,
      latency_ms: 740,
      usage: null,
      invocation_error: null,
      trace_id: null,
      span_id: null,
    },
    scorer_results: [{
      metric_id: "quality.response_clarity",
      evaluator_instance_id: `${runId}-clarity`,
      run_id: runId,
      row_id: "case-1",
      score: 0.9,
      normalised_score: 0.9,
      label: "clear",
      passed: true,
      rationale: "The response gives a direct cancellation path.",
      error_message: null,
      threshold: 0.8,
      threshold_result: "pass",
      trace_id: null,
      prompt_version: "v1",
      judge_prompt_tokens: null,
      judge_completion_tokens: null,
      judge_total_tokens: null,
      judge_model: "gpt-4.1-mini",
      evaluator_id: "response-clarity",
      evaluator_version: "v1",
      execution_status: "completed",
      execution_metadata: {},
    }],
    evidence_ref: "evidence://case-1",
    evidence_policy: {
      redaction_enabled: true,
      max_persisted_string_size: 10000,
      retention_policy: "stored_with_run_lifecycle",
    },
    capture_state: "complete",
  };
}

function comparison(
  candidateRunId = "candidate",
  overrides: Partial<RunComparison> = {},
): RunComparison {
  return {
    experiment_id: "experiment-1",
    base_run_id: "baseline",
    candidate_run_id: candidateRunId,
    base_gate: "pass",
    candidate_gate: "pass",
    kpi_deltas: [],
    sample_deltas: [{
      row_id: "case-1",
      base_score: 1,
      candidate_score: 1,
      delta: 0,
      result: "same",
    }],
    base_quality_score: 1,
    candidate_quality_score: 1,
    quality_delta: 0,
    base_latency_ms: 1000,
    candidate_latency_ms: 1000,
    latency_delta_percent: 0,
    sample_counts: { improved: 0, regressed: 0, same: 1, unavailable: 0 },
    metric_failures: { new: [], fixed: [], persistent: [] },
    metadata_diff: {},
    ...overrides,
  };
}

describe("comparison run selection", () => {
  const available = [
    run("baseline", 1, "2026-08-14T11:18:25Z"),
    run("candidate-1", 2, "2026-08-15T11:18:25Z"),
    run("candidate-2", 3, "2026-08-16T11:18:25Z"),
    run("candidate-3", 4, "2026-08-17T11:18:25Z"),
  ];

  it("parses baseline and candidates from the URL, deduped and capped", () => {
    const params = new URLSearchParams(
      "baseline_run_id=baseline&candidate_run_id=candidate-1&candidate_run_id=candidate-1",
    );
    expect(requestedComparisonRunIds(params)).toEqual(["baseline", "candidate-1"]);

    const legacy = new URLSearchParams("base=baseline&candidate=candidate-1");
    expect(requestedComparisonRunIds(legacy)).toEqual(["baseline", "candidate-1"]);
  });

  it("renders exactly the two runs the URL requested — no auto-filled extras", () => {
    const params = new URLSearchParams("baseline_run_id=baseline&candidate_run_id=candidate-1");
    const selection = resolveComparisonSelection(requestedComparisonRunIds(params), available);

    // Exactly the requested pair, even though two more runs exist in the experiment.
    expect(selection).toEqual(["baseline", "candidate-1"]);
  });

  it("keeps a one-run URL at one run instead of silently adding arbitrary runs", () => {
    const params = new URLSearchParams("baseline_run_id=baseline");
    const selection = resolveComparisonSelection(requestedComparisonRunIds(params), available);

    expect(selection).toEqual(["baseline"]);
    expect(selection).toHaveLength(1);
  });

  it("drops unknown run ids without substituting other runs", () => {
    const selection = resolveComparisonSelection(["baseline", "deleted-run"], available);
    expect(selection).toEqual(["baseline"]);
  });

  it("shows an honest prompt with a link back when fewer than two runs are selected", () => {
    const html = renderToStaticMarkup(
      createElement(IncompleteSelection, { experimentId: "experiment-1" }),
    );

    expect(html).toContain("Select at least one more run to compare");
    expect(html).toContain('href="/evaluations/experiment-1"');
    expect(html).toContain("never added to a comparison automatically");
  });
});

// The Run score row reimplemented the mean without the conclusive-verdict guard
// every other score surface applies, so an inconclusive candidate rendered a
// clean number and got ranked against the baseline as if it were governed — on
// the one screen whose job is deciding whether something got better.
describe("the comparison will not score a run the app refuses to score", () => {
  const scored = (verdict: RunResult["verdict_status"]) => ({
    ...run("candidate", 2, "2026-08-17T08:43:09Z"),
    verdict_status: verdict,
    kpi_results: [
      {
        kpi_id: "quality",
        run_id: "candidate",
        composite_score: 0.82,
        observed_score: 0.82,
        gate_result: "pass" as const,
        constituent_scores: [],
        threshold_pass: 0.8,
        threshold_warn: 0.6,
        threshold_fail: 0.6,
        evaluated_target: "tenant/support-agent",
      },
    ],
  });

  it("shows the score for a conclusive run", () => {
    const html = renderToStaticMarkup(
      createElement(ResultsTable, {
        runs: [run("baseline", 1, "2026-08-14T11:18:25Z"), scored("conclusive")],
        comparisons: [comparison()],
      }),
    );
    expect(html).toContain("0.82");
  });

  it("withholds it for an inconclusive run carrying the very same KPI", () => {
    const html = renderToStaticMarkup(
      createElement(ResultsTable, {
        runs: [run("baseline", 1, "2026-08-14T11:18:25Z"), scored("inconclusive")],
        comparisons: [comparison()],
      }),
    );
    expect(html).not.toContain("0.82");
  });
});

describe("RunSelector", () => {
  it("renders metric comparisons as mobile cards without a horizontal table", () => {
    const runs = [
      run("baseline", 1, "2026-08-14T11:18:25Z"),
      run("candidate", 2, "2026-08-17T08:43:09Z"),
    ];
    const html = renderToStaticMarkup(
      createElement(ResultsTable, { runs, comparisons: [comparison()] }),
    );

    expect(html).toContain('aria-label="Run-level metric comparison"');
    expect(html).toContain("xl:hidden");
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("xl:block");
    expect(html).not.toContain('class="overflow-x-auto rounded-2xl');
  });

  it("uses user labels as run identities and positional names only as roles", () => {
    const runs = [
      run("baseline", 1, "2026-08-14T11:18:25Z", "control-v2"),
      run("candidate", 2, "2026-08-17T08:43:09Z", "variant-b"),
    ];
    const html = renderToStaticMarkup(
      createElement(ResultsTable, { runs, comparisons: [comparison()] }),
    );

    expect(html).toContain("control-v2");
    expect(html).toContain("variant-b");
    expect(html).toContain("Baseline");
    expect(html).toContain("Candidate 1");
  });

  it("falls back to positional run identities when user labels are absent", () => {
    const runs = [
      run("baseline", 1, "2026-08-14T11:18:25Z"),
      run("candidate", 2, "2026-08-17T08:43:09Z"),
    ];
    const html = renderToStaticMarkup(
      createElement(ResultsTable, { runs, comparisons: [comparison()] }),
    );

    expect(html).toContain("Baseline");
    expect(html).toContain("Candidate 1");
  });

  it("starts as a compact baseline and candidate summary without a wide matrix", () => {
    const runs = [
      run("baseline", 1, "2026-08-14T11:18:25Z"),
      run("candidate", 2, "2026-08-17T08:43:09Z"),
    ];
    const html = renderToStaticMarkup(
      createElement(RunSelector, {
        runs,
        selectedRuns: runs,
        onChange: () => undefined,
      }),
    );

    expect(html).toContain("Comparison setup");
    expect(html).toContain("2 runs · 1 baseline · 1 candidate");
    expect(html).toContain("Baseline");
    expect(html).toContain("Candidate 1");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Change runs");
    expect(html).toContain('inert=""');
    expect(html).not.toContain("overflow-x-auto");
    expect(html).not.toContain("min-w-[760px]");
    expect(html).not.toContain("<table");
  });

  it("reports tied quality and no sample changes without claiming a winner", () => {
    const runs = [
      run("baseline", 1, "2026-08-14T11:18:25Z"),
      run("candidate", 2, "2026-08-17T08:43:09Z"),
    ];
    runs.forEach((value) => {
      value.kpi_results = [
        {
          kpi_id: "quality",
          run_id: value.run_id,
          composite_score: 1,
          gate_result: "pass",
          constituent_scores: [],
          threshold_pass: 0.8,
          threshold_warn: 0.6,
          threshold_fail: 0,
          evaluated_target: "support-agent",
        },
      ];
    });

    const summary = buildSummary(
      runs,
      [
        {
          exampleId: "case-1",
          name: "Support case",
          scores: [1, 1],
          deltas: [null, 0],
          candidateResults: ["Same"],
          delta: 0,
          result: "Same",
          failed: false,
        },
      ],
      [comparison()],
    );

    // One verdict reconciling both grains. "Tied on aggregate quality" used to
    // sit directly above "1 candidate regressed" with nothing explaining that a
    // run score and a sample score measure different things.
    expect(summary.title).toContain("matches the baseline run score");
    expect(summary.title).toContain("held every one of");
    expect(summary.body).toContain("a sample score is the mean of that sample's metric results");
    expect(summary.body).not.toContain("strongest");
    expect(summary.body).not.toContain("Review the highlighted regressions");
    expect(summary.qualityText).toBe("No change");
    expect(summary.sampleText).toBe("No changes");
  });

  it("summarises every selected candidate, not just the first", () => {
    const runs = [
      run("baseline", 1, "2026-08-14T11:18:25Z"),
      run("candidate-1", 2, "2026-08-15T11:18:25Z"),
      run("candidate-2", 3, "2026-08-16T11:18:25Z"),
      run("candidate-3", 4, "2026-08-17T11:18:25Z"),
    ];
    const comparisons = [
      comparison("candidate-1", {
        base_quality_score: 0.8,
        candidate_quality_score: 0.9,
        quality_delta: 0.1,
        base_latency_ms: 1000,
        candidate_latency_ms: 900,
        latency_delta_percent: -10,
        sample_counts: { improved: 2, regressed: 0, same: 0, unavailable: 0 },
      }),
      comparison("candidate-2", {
        base_quality_score: 0.8,
        candidate_quality_score: 0.7,
        quality_delta: -0.1,
        base_latency_ms: 1000,
        candidate_latency_ms: 1200,
        latency_delta_percent: 20,
        sample_counts: { improved: 0, regressed: 3, same: 0, unavailable: 0 },
      }),
      comparison("candidate-3", {
        base_quality_score: 0.8,
        candidate_quality_score: 0.85,
        quality_delta: 0.05,
        base_latency_ms: 1000,
        candidate_latency_ms: 700,
        latency_delta_percent: -30,
        sample_counts: { improved: 1, regressed: 0, same: 0, unavailable: 0 },
      }),
    ];

    const summary = buildSummary(runs, [], comparisons);

    // One summary per candidate.
    expect(summary.candidateSummaries).toHaveLength(3);
    expect(summary.candidateSummaries.map((entry) => entry.label)).toEqual([
      "Candidate 1",
      "Candidate 2",
      "Candidate 3",
    ]);

    // Winners identified across ALL candidates, not just the first.
    expect(summary.bestQualityLabel).toBe("Candidate 1");
    expect(summary.fastestLabel).toBe("Candidate 3");
    expect(summary.regressionCandidates).toEqual(["Candidate 2"]);
    expect(summary.body).toContain("Candidate 2");
  });

  it("joins tied run labels as an Oxford list", () => {
    expect(joinRunLabels([])).toBe("");
    expect(joinRunLabels(["Baseline"])).toBe("Baseline");
    expect(joinRunLabels(["Baseline", "Candidate 1"])).toBe("Baseline and Candidate 1");
    expect(joinRunLabels(["Baseline", "Candidate 1", "Candidate 2"])).toBe(
      "Baseline, Candidate 1, and Candidate 2",
    );
    expect(joinRunLabels(["Baseline", "Candidate 1", "Candidate 2", "Candidate 3"])).toBe(
      "Baseline, Candidate 1, Candidate 2, and Candidate 3",
    );
  });

  it("distinguishes ties, unique winners, missing evidence, and single results", () => {
    expect(rankComparisonValues([1, 1], false)).toEqual({ status: "tie", indexes: [0, 1] });
    expect(rankComparisonValues([1, 0.85, 0.92], false)).toEqual({ status: "unique", indexes: [0] });
    expect(rankComparisonValues([1700, 758], true)).toEqual({ status: "unique", indexes: [1] });
    expect(rankComparisonValues([null, 0.92], false)).toEqual({ status: "only", indexes: [1] });
    expect(rankComparisonValues([null, null], false)).toEqual({ status: "none", indexes: [] });
  });

  it("uses backend-owned sample deltas for every candidate and exposes mixed outcomes", () => {
    const runs = [
      run("baseline", 1, "2026-08-14T11:18:25Z"),
      run("candidate-1", 2, "2026-08-15T11:18:25Z"),
      run("candidate-2", 3, "2026-08-16T11:18:25Z"),
      run("candidate-3", 4, "2026-08-17T11:18:25Z"),
    ];
    const rows = buildBackendSampleRows(runs, {}, [
      comparison("candidate-1", { sample_deltas: [{ row_id: "case-1", base_score: 0.8, candidate_score: 0.9, delta: 0.1, result: "improved" }] }),
      comparison("candidate-2", { sample_deltas: [{ row_id: "case-1", base_score: 0.8, candidate_score: 0.7, delta: -0.1, result: "regressed" }] }),
      comparison("candidate-3", { sample_deltas: [{ row_id: "case-1", base_score: 0.8, candidate_score: null, delta: null, result: "unavailable" }] }),
    ]);

    expect(rows[0].deltas).toEqual([null, 0.1, -0.1, null]);
    expect(rows[0].candidateResults).toEqual(["Improved", "Regressed", "Unavailable"]);
    expect(rows[0].result).toBe("Mixed");
  });

  it("opens comparison evidence in an accessible dialog instead of a separate tab", () => {
    const runs = [
      run("baseline", 1, "2026-08-14T11:18:25Z"),
      run("candidate", 2, "2026-08-17T08:43:09Z"),
    ];
    const html = renderToStaticMarkup(
      createElement(TraceComparisonDialog, {
        runs,
        sample: {
          exampleId: "case-1",
          name: "Cancellation policy explanation",
          scores: [0.8, 0.9],
          deltas: [null, 0.1],
          candidateResults: ["Improved"],
          delta: 0.1,
          result: "Improved",
          failed: false,
        },
        details: {
          baseline: runItemDetail("baseline"),
          candidate: {
            ...runItemDetail("candidate"),
            scorer_results: runItemDetail("candidate").scorer_results.map(result => ({
              ...result, evaluator_instance_id: "candidate-evaluator",
            })),
          },
        },
        loading: false,
        onClose: () => undefined,
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Evidence comparison");
    expect(html).toContain("Cancellation policy explanation");
    expect(html).toContain('aria-label="Close evidence comparison"');
    // Only gated metrics can pass, so only they are counted.
    expect(html).toContain("1/1 gated metrics passed");
    expect(html).toContain("Evaluator results");
    expect(html).toContain('aria-expanded="false"');
    // Instruction, written as instruction — it used to sit in the position and
    // weight of a link while doing nothing when clicked.
    expect(html).toContain("Open a metric to read its rationale");
    expect(html).not.toContain("Not scored on this run");
    expect(html).not.toContain("No tool calls captured");
    expect(html).not.toContain("Browse samples");
  });

  it("names the two score grains instead of printing one of them twice", () => {
    // "Overall Score" is the mean of the KPI composites, so with a single KPI
    // it was the same number under two names. The sample mean is the other
    // grain and was never shown at all.
    const withKpi = (runId: string, number: number, completedAt: string, score: number) => {
      const base = run(runId, number, completedAt);
      return {
        ...base,
        kpi_results: [
          {
            kpi_id: "kpi.response_quality",
            run_id: runId,
            composite_score: score,
            observed_score: score,
            gate_result: "pass" as const,
            constituent_scores: [],
            threshold_pass: 0.8,
            threshold_warn: 0.6,
            threshold_fail: 0,
            evaluated_target: "agent",
          },
        ],
      } as typeof base;
    };
    const runs = [
      withKpi("baseline", 1, "2026-08-14T11:18:25Z", 1),
      withKpi("candidate", 2, "2026-08-17T08:43:09Z", 1),
    ];
    const html = renderToStaticMarkup(
      createElement(ResultsTable, { runs, comparisons: [comparison()] }),
    );

    expect(html).toContain("KPI composite");
    // The single KPI is named once — in the run score's detail line — and no
    // longer gets a row of its own, because that row *was* the run score.
    // Once per rendered view (mobile cards + desktop table), and only inside
    // the run score's detail line — the KPI no longer gets a row of its own,
    // because that row *was* the run score.
    expect((html.match(/Response quality/g) ?? []).length).toBe(
      (html.match(/KPI composite/g) ?? []).length,
    );
    expect(html).toContain("Mean of 1 KPI");
    expect(html).toContain("Sample mean");
    expect(html).not.toContain("Overall Score");
  });

  it("shows configuration differences first without a horizontally scrolling table", () => {
    const baseline = run("baseline", 1, "2026-08-14T11:18:25Z");
    const candidate = run("candidate", 2, "2026-08-17T08:43:09Z");
    candidate.experiment = { ...candidate.experiment!, judge_model: "gpt-4.1" };

    const html = renderToStaticMarkup(
      createElement(ConfigurationTab, { runs: [baseline, candidate] }),
    );

    expect(html).toContain("Configuration differences");
    // No count pill: sameness was stated four times over, and the differences
    // themselves are listed directly below this heading.
    expect(html).not.toContain("1 difference<");
    // Sentence case, and no family prefix: the label used to title-case every
    // word and print "Llm.Coherence" / "Kpi.Response Quality" with our
    // namespace in front.
    expect(html).toContain("Judge model");
    expect(html).toContain("Changed");
    expect(html).toContain("Different");
    // "Settings (N)", not "Matching settings · N unchanged": the disclosure
    // counts what is inside it rather than restating the verdict a third time.
    expect(html).toContain("Settings (");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Experiment Id");
    expect(html).not.toContain("Created At");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("overflow-x-auto");
    expect(html).not.toContain("min-w-[760px]");
  });

  it("does not show a synthetic target endpoint for stored-response runs", () => {
    const stored = run("stored", 1, "2026-08-14T11:18:25Z");
    stored.response_source = "provided";
    stored.experiment = {
      ...stored.experiment!,
      target_endpoint: "golden-dataset:stored.v1",
    };

    const html = renderToStaticMarkup(createElement(ConfigurationTab, { runs: [stored] }));

    expect(html).toContain("Not invoked");
    expect(html).not.toContain("golden-dataset:stored.v1");
  });

  it("keeps sample rows in the Samples tab instead of duplicating them on Overview", () => {
    const runs = [
      run("baseline", 1, "2026-08-14T11:18:25Z"),
      run("candidate", 2, "2026-08-17T08:43:09Z"),
    ];
    const samples = [{
      exampleId: "case-1",
      name: "Cancellation policy explanation",
      scores: [0.8, 0.9],
      deltas: [null, 0.1],
      candidateResults: ["Improved" as const],
      delta: 0.1,
      result: "Improved" as const,
      failed: false,
    }];
    const html = renderToStaticMarkup(
      createElement(OverviewTab, {
        runs,
        comparisons: [comparison()],
        summary: buildSummary(runs, samples, [comparison()]),
        onShowSamples: () => undefined,
      }),
    );

    expect(html).toContain("Review samples");
    expect(html).toContain("Operational measurements");
    expect(html).toContain("Analysis metric");
    expect(html).toContain("Over iterations");
    expect(html).not.toContain("Evaluator score changes");
    expect(html).not.toContain("Sample-Level Comparison");
    expect(html).not.toContain("Cancellation policy explanation");
    expect(html).not.toContain("View all samples");
  });

  it("fits four-run sample comparison without a horizontal scroller", () => {
    const runs = [
      run("baseline", 1, "2026-08-14T11:18:25Z"),
      run("candidate-1", 2, "2026-08-15T11:18:25Z"),
      run("candidate-2", 3, "2026-08-16T11:18:25Z"),
      run("candidate-3", 4, "2026-08-17T11:18:25Z"),
    ];
    const html = renderToStaticMarkup(
      createElement(SampleTable, {
        runs,
        rows: [{
          exampleId: "case-1",
          name: "Cancellation policy explanation",
          scores: [0.7, 0.8, 0.9, 1],
          deltas: [null, 0.1, 0.2, 0.3],
          candidateResults: ["Improved", "Improved", "Improved"],
          delta: 0.3,
          result: "Improved",
          failed: false,
        }],
        onOpenSample: () => undefined,
      }),
    );

    expect(html).not.toContain("overflow-x-auto");
    expect(html).not.toContain("min-w-[760px]");
    expect(html).toContain("hidden w-full table-fixed");
    expect(html).toContain("divide-y md:hidden");
    expect(html).toContain("Candidate 3");
    expect(html).toContain("Evidence");
  });
});

describe("compare view URL state", () => {

  it("round-trips tab, filters, query, and selected sample", () => {
    const written = writeCompareViewState("baseline_run_id=r1&candidate_run_id=r2", {
      tab: "samples",
      sampleFilter: "regressed",
      metricFilter: "llm.correctness",
      sampleQuery: "fraud",
      selectedSample: "case-7",
    });
    const params = new URLSearchParams(written);
    // Selection params preserved untouched.
    expect(params.get("baseline_run_id")).toBe("r1");
    expect(params.get("candidate_run_id")).toBe("r2");
    const restored = readCompareViewState(params);
    expect(restored).toEqual({
      tab: "samples",
      sampleFilter: "regressed",
      metricFilter: "llm.correctness",
      sampleQuery: "fraud",
      selectedSample: "case-7",
    });
  });

  it("keeps defaults out of the URL and rejects invalid values", () => {
    const written = writeCompareViewState("", {
      tab: "overview",
      sampleFilter: "all",
      metricFilter: "all",
      sampleQuery: "",
      selectedSample: null,
    });
    expect(written).toBe("");
    const restored = readCompareViewState(new URLSearchParams("tab=bogus&sampleFilter=nope"));
    expect(restored.tab).toBe("overview");
    expect(restored.sampleFilter).toBe("all");
  });
});

 it("links the exact same-prompt versions from configuration", () => {
  const baseline = run("base", 1, "2026-09-09T00:00:00Z");
  const candidate = run("candidate", 2, "2026-09-09T00:01:00Z");
  baseline.lineage = { ...baseline.lineage, target_prompt_ref: "support@2" };
  candidate.lineage = { ...candidate.lineage, target_prompt_ref: "support@4" };
  const html = renderToStaticMarkup(createElement(ConfigurationTab, { runs: [baseline, candidate] }));
  expect(html).toContain("/catalog/prompts/support?compare=2&amp;candidate=4");
  candidate.lineage.target_prompt_ref = "different@4";
  expect(renderToStaticMarkup(createElement(ConfigurationTab, { runs: [baseline, candidate] }))).not.toContain("Compare prompt text:");
});
