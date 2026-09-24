import { describe, expect, it } from "vitest";

import type { MetricResult, RunResult } from "@/lib/api";
import { neutralizeCsvFormula } from "@/lib/csv";
import {
  csvFor,
  exportMetricAverages,
  exportPayloadFor,
  libraryCsv,
  metricAggregateOutcome,
  qualityContractGroups,
} from "@/lib/eval-export";

function metric(partial: Partial<MetricResult> & Pick<MetricResult, "metric_id" | "normalised_score" | "threshold_result">): MetricResult {
  return {
    evaluator_instance_id: "ev-1",
    run_id: "run-export-1",
    row_id: "row-1",
    score: partial.normalised_score,
    label: null,
    passed: partial.threshold_result === "pass",
    rationale: null,
    error_message: null,
    threshold: 0.7,
    trace_id: null,
    prompt_version: "1",
    judge_prompt_tokens: 1,
    judge_completion_tokens: 1,
    judge_total_tokens: 2,
    judge_model: "gpt-4o",
    evaluator_id: "native",
    evaluator_version: "1",
    execution_status: "ok",
    execution_metadata: {},
    ...partial,
  };
}

const run: RunResult = {
  run_id: "run-export-1",
  status: "completed",
  experiment: {
    name: "Export Suite",
    dataset_version: "ds_demo",
    target_endpoint: "https://example.test/agent",
    scenario: "agentic",
    market: "global",
    judge_model: "gpt-4o",
    judge_temperature: 0,
    has_ground_truth: true,
  },
  metric_results: [
    metric({
      metric_id: "agent.tool_selection",
      normalised_score: 0.9,
      threshold_result: "pass",
      rationale: "ok",
    }),
    metric({
      metric_id: "quality.safety_policy",
      normalised_score: 0.4,
      threshold_result: "fail",
      threshold: 0.8,
      rationale: "policy miss",
    }),
  ],
  kpi_results: [],
  overall_gate: "fail",
  root_cause: null,
  review_queue: [],
  active_metrics: ["agent.tool_selection", "quality.safety_policy"],
  started_at: "2026-08-03T00:00:00Z",
  completed_at: "2026-08-03T00:01:00Z",
  run_number: 1,
};

describe("eval-export helpers", () => {
  it("separates metric averages from quality contracts", () => {
    const metrics = exportMetricAverages(run);
    const quality = qualityContractGroups(run);

    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.id).toBe("agent.tool_selection");
    expect(quality.groups).toHaveLength(1);
    expect(quality.groups[0]?.metricId).toBe("quality.safety_policy");
    expect(quality.notMet).toBe(1);
  });

  it("keeps an unscored quality control unavailable instead of passing or failing it", () => {
    const unscored = metric({
      metric_id: "quality.response_clarity",
      normalised_score: null,
      threshold_result: null,
      metric_status: "unscored",
      unscored_reason: "evidence_unavailable",
      passed: null,
      score: null,
    });
    const quality = qualityContractGroups({ ...run, metric_results: [unscored] });
    expect(quality.groups[0]).toMatchObject({
      mean: null,
      gate: null,
      state: "not_scored",
    });
    expect(quality.notMet).toBe(0);
    expect(quality.unavailable).toBe(1);
    expect(quality.overall).toBeNull();
  });

  it("preserves warning and unscored aggregate outcomes instead of inventing failures", () => {
    expect(metricAggregateOutcome({ passes: 0, warns: 1, fails: 0 })).toBe("Warn");
    expect(metricAggregateOutcome({ passes: 0, warns: 0, fails: 0 })).toBe("Not scored");
    expect(metricAggregateOutcome({ passes: 2, warns: 1, fails: 0 })).toBe("Warn");
    expect(metricAggregateOutcome({ passes: 2, warns: 0, fails: 1 })).toBe("Fail");
  });
});

describe("the export carries the honesty the screen showed", () => {
  // A CSV reaches an auditor without passing back through the UI. This wrote a
  // raw `overall_gate` and nothing else, so the file could read `pass` one row
  // above an `overall_score` of "Not scored" — and filtering a spreadsheet on
  // `overall_gate = pass` is the first thing anyone does with it.
  it("states the verdict and governance beside the raw gate", () => {
    const csv = csvFor("full", { ...run, verdict_status: "inconclusive", overall_gate: null });
    expect(csv).toContain("verdict_status,inconclusive");
    expect(csv).toContain("diagnostic_only,false");
    expect(csv).toContain("outcome,Inconclusive");
  });

  it("does not export a synthetic target endpoint for stored responses", () => {
    const csv = csvFor("full", {
      ...run,
      response_source: "provided",
      experiment: {
        ...run.experiment!,
        target_endpoint: "golden-dataset:stored.v1",
      },
    });

    expect(csv).toContain("target_endpoint,");
    expect(csv).not.toContain("golden-dataset:stored.v1");
  });

  it("discloses scorer provenance and simulated results in CSV", () => {
    const simulated = metric({
      metric_id: "llm.correctness",
      normalised_score: null,
      threshold_result: null,
      metric_status: "unscored",
      unscored_reason: "simulated",
      requested_scorer: "deepeval",
      executed_scorer: "mock",
    });

    const csv = csvFor("metrics", { ...run, metric_results: [simulated] });

    expect(csv).toContain("requested_scorer,executed_scorer,result_state");
    expect(csv).toContain("deepeval,mock,Simulated - no real judge ran");
  });

  it("preserves not-applicable state in scorer provenance CSV", () => {
    const notApplicable = metric({
      metric_id: "llm.correctness",
      metric_applicability: "not_applicable",
      metric_status: null,
      normalised_score: null,
      threshold_result: null,
    });

    const csv = csvFor("metrics", { ...run, metric_results: [notApplicable] });

    expect(csv).toContain("not applicable");
    expect(csv).not.toContain("not recorded");
  });

  it("marks an ungoverned pass as ungoverned rather than a clean pass", () => {
    const csv = csvFor("full", {
      ...run,
      verdict_status: "conclusive",
      overall_gate: "pass",
      quality_profile_id: null,
    });
    expect(csv).toContain("governed,false");
    expect(csv).toContain("outcome,Pass · ungoverned");
  });

  it("drops the qualifier when a quality profile stands behind the gate", () => {
    const csv = csvFor("full", {
      ...run,
      verdict_status: "conclusive",
      overall_gate: "pass",
      quality_profile_id: "qp-1",
    });
    expect(csv).toContain("governed,true");
    expect(csv).not.toContain("ungoverned");
  });
});

describe("CSV formula injection", () => {
  it("prefixes formula-like cells so a spreadsheet shows text, not a formula", () => {
    expect(neutralizeCsvFormula("=HYPERLINK(\"http://evil\",\"click\")")).toBe(
      "'=HYPERLINK(\"http://evil\",\"click\")",
    );
    expect(neutralizeCsvFormula("+1+1")).toBe("'+1+1");
    expect(neutralizeCsvFormula("-2+3")).toBe("'-2+3");
    expect(neutralizeCsvFormula("@SUM(A1:A2)")).toBe("'@SUM(A1:A2)");
    expect(neutralizeCsvFormula("\tcmd")).toBe("'\tcmd");
  });

  it("leaves ordinary values and plain numbers untouched", () => {
    expect(neutralizeCsvFormula("Checkout Agent")).toBe("Checkout Agent");
    expect(neutralizeCsvFormula("-12.5")).toBe("-12.5");
    expect(neutralizeCsvFormula("")).toBe("");
  });

  it("neutralises every user-controlled column of the library export", () => {
    const csv = libraryCsv([
      {
        name: "=HYPERLINK(\"http://evil\",\"click\")",
        runs: 3,
        latestScore: "-12.5",
        latestOutcome: "@Fail",
        lastRun: "+2026-08-03",
      },
    ]);
    const [header, row] = csv.split("\n");

    expect(header).toBe("evaluation,runs,latest_score,latest_outcome,last_run");
    // The name is quoted (it holds a comma and quotes) *and* neutralised —
    // quoting alone would still be evaluated as a formula.
    expect(row).toBe(
      "\"'=HYPERLINK(\"\"http://evil\"\",\"\"click\"\")\",3,-12.5,'@Fail,'+2026-08-03",
    );
  });
});

describe("export provenance", () => {
  it("says how the answers came to exist, in every run-scoped export", () => {
    // A file outlives the UI. Without these fields a provided run's score was
    // indistinguishable from live-target evidence: the source survived only as a
    // presentation label, and a non-invoked target as an empty endpoint cell.
    const provided = { ...run, response_source: "provided" } as never;

    const full = exportPayloadFor("full", provided) as Record<string, unknown>;
    expect(full.response_source).toBe("provided");
    expect(full.target_invoked).toBe(false);

    const metrics = exportPayloadFor("metrics", provided) as Record<string, unknown>;
    expect(metrics.response_source).toBe("provided");

    const csv = csvFor("full", provided);
    expect(csv).toContain("response_source,provided");
    expect(csv).toContain("target_invoked,false");
  });
});
