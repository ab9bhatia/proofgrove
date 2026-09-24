import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { KpiResult, MetricResult, RunResult } from "@/lib/api";
import { ExperimentOutcome } from "./experiment-outcome";

function kpi(composite: number | null, observed: number | null = composite): KpiResult {
  return {
    kpi_id: "quality",
    run_id: "run-1",
    composite_score: composite,
    observed_score: observed,
    gate_result: composite == null ? null : "pass",
    constituent_scores: [],
    threshold_pass: 0.8,
    threshold_warn: 0.6,
    threshold_fail: 0.6,
    evaluated_target: "target",
  } as KpiResult;
}

function metric(row_id: string, threshold_result: MetricResult["threshold_result"]): MetricResult {
  return { row_id, metric_id: "llm.correctness", threshold_result } as MetricResult;
}

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    run_id: "run-9",
    status: "completed",
    verdict_status: "conclusive",
    overall_gate: "pass",
    kpi_results: [kpi(0.9)],
    metric_results: [metric("a", "pass"), metric("b", "pass")],
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    started_at: "2026-08-27T14:27:00Z",
    completed_at: "2026-08-27T14:28:00Z",
    ...overrides,
  } as RunResult;
}

function render(props: Parameters<typeof ExperimentOutcome>[0]) {
  return renderToStaticMarkup(createElement(ExperimentOutcome, props));
}

describe("ExperimentOutcome", () => {
  it("says what the run did, and names the KPIs that failed", () => {
    // The page held `failed_kpis_latest` and rendered it nowhere — the one
    // thing it knew about a failing run and never said.
    const html = render({
      run: run(),
      failedKpiIds: ["kpi.response_quality", "kpi.retrieval_quality"],
      label: "Run 1",
    });

    expect(html).toContain("2 quality checks failed");
    expect(html).toContain("Response Quality");
    expect(html).toContain("Retrieval Quality");
    // Mapped through kpiLabel, never the raw id.
    expect(html).not.toContain("kpi.response_quality");
  });

  it("says nothing about KPIs when none failed", () => {
    const html = render({ run: run(), failedKpiIds: [], label: "Run 1" });

    expect(html).not.toContain("quality check");
    expect(html).not.toContain("quality checks failed");
  });

  it("counts one KPI in the singular", () => {
    const html = render({ run: run(), failedKpiIds: ["kpi.factual_integrity"], label: "Run 1" });

    expect(html).toContain("1 quality check failed");
    expect(html).not.toContain("1 quality checks failed");
  });

  it("carries the basis with an ungated score instead of printing a bare dash", () => {
    const html = render({
      run: run({ verdict_status: "inconclusive", overall_gate: null, kpi_results: [kpi(null, 0)] }),
      failedKpiIds: [],
      label: "Run 1",
    });

    expect(html).toContain("0% observed · not gated");
    expect(html).not.toContain(">—<");
  });

  it("names the absence when a run has no score at all", () => {
    const html = render({
      run: run({ verdict_status: "inconclusive", overall_gate: null, kpi_results: [] }),
      failedKpiIds: [],
      label: "Run 1",
    });

    expect(html).toContain("Not scored");
  });

  it("breaks the case counts down only when something was not a pass", () => {
    const clean = render({ run: run(), failedKpiIds: [], label: "Run 1" });
    expect(clean).toContain("2/2 passed");
    expect(clean).not.toContain("failed ·");

    const mixed = render({
      run: run({ metric_results: [metric("a", "pass"), metric("b", "fail"), metric("c", null)] }),
      failedKpiIds: [],
      label: "Run 1",
    });
    expect(mixed).toContain("1/3 passed");
    expect(mixed).toContain("1 failed");
    expect(mixed).toContain("1 not scored");
  });

  it("gives evidence capture its own fact, not a note under latency", () => {
    // Capture completeness has nothing to do with speed; parked in the latency
    // column's detail slot it read as a non-sequitur.
    const html = render({
      run: run({ evidence_capture_status: "partial" } as Partial<RunResult>),
      failedKpiIds: [],
      label: "Run 1",
    });

    expect(html).toContain(">Evidence</dt>");
    expect(html).toContain("partial");
    expect(html).not.toContain("Evidence partial");
  });

  it("says Not recorded rather than 0 when there are no metric rows", () => {
    // Zero cases passed and no cases recorded are different statements.
    const html = render({ run: run({ metric_results: [] }), failedKpiIds: [], label: "Run 1" });

    expect(html).toContain("Not recorded");
    expect(html).not.toContain("0/0 passed");
  });

  it("uses the label it was given, so the chart axis cannot disagree with it", () => {
    const html = render({ run: run(), failedKpiIds: [], label: "Run 4" });

    expect(html).toContain("Run 4");
    expect(html).not.toContain("Run 1");
  });

  it("offers both ways forward, and links the run to its report", () => {
    const html = render({ run: run(), failedKpiIds: [], label: "Run 1" });

    expect(html).toContain('href="/runs/run-9"');
    expect(html).toContain("Open run report");
    expect(html).toContain("Run again");
    // Rerun goes to the prefilled setup, not back to the report.
    expect(html).toContain('href="/evaluate?');
    expect(html).toContain("rerun=1");
  });
});
