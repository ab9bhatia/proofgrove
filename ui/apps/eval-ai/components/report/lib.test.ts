import { describe, expect, it } from "vitest";

import type { MetricResult, RunResult } from "@/lib/api";
import { caseCountsFromMetrics, groupByMetricFamily } from "./lib";

describe("groupByMetricFamily", () => {
  const ids = [
    "ops.latency",
    "llm.correctness",
    "nlp.bleu",
    "safety.general",
    "weird_metric",
  ].map((metric_id) => ({ metric_id }));

  it("orders families the way the creation flow does", () => {
    expect(groupByMetricFamily(ids, (item) => item.metric_id).map((f) => f.label)).toEqual([
      "LLM quality",
      "Safety",
      "NLP diagnostics",
      "Other checks",
      "Operational measurements",
    ]);
  });

  it("keeps a metric outside the known families rather than dropping it", () => {
    const other = groupByMetricFamily(ids, (item) => item.metric_id).find(
      (family) => family.prefix === "other",
    );
    expect(other?.items).toEqual([{ metric_id: "weird_metric" }]);
  });

  it("drops families with no members", () => {
    const labels = groupByMetricFamily([{ metric_id: "llm.correctness" }], (i) => i.metric_id);
    expect(labels).toHaveLength(1);
    expect(labels[0].label).toBe("LLM quality");
  });

  it("carries the note that explains a family's red chips", () => {
    const nlp = groupByMetricFamily(ids, (item) => item.metric_id).find(
      (family) => family.prefix === "diagnostics",
    );
    expect(nlp?.note).toContain("not correctness");
  });
});

describe("caseCountsFromMetrics", () => {
  function metric(row_id: string, threshold_result: MetricResult["threshold_result"], metric_id = "llm.correctness"): MetricResult {
    return { row_id, metric_id, threshold_result } as MetricResult;
  }

  function runWith(metric_results: MetricResult[]): RunResult {
    return { run_id: "run-1", metric_results } as RunResult;
  }

  it("counts a case as passed only when every one of its rows passed", () => {
    const counts = caseCountsFromMetrics(
      runWith([metric("a", "pass"), metric("a", "pass", "ops.latency"), metric("b", "pass")]),
    );

    expect(counts).toEqual({ passed: 2, warned: 0, failed: 0, total: 2, notScored: 0 });
  });

  it("counts a case as failed when any row failed, whatever the others did", () => {
    const counts = caseCountsFromMetrics(
      runWith([metric("a", "pass"), metric("a", "fail", "ops.latency")]),
    );

    expect(counts).toEqual({ passed: 0, warned: 0, failed: 1, total: 1, notScored: 0 });
  });

  it("counts a fully scored case with no fails and no all-pass as warned", () => {
    const counts = caseCountsFromMetrics(
      runWith([metric("a", "pass"), metric("a", "warn", "ops.latency")]),
    );

    expect(counts).toEqual({ passed: 0, warned: 1, failed: 0, total: 1, notScored: 0 });
  });

  it("lets a case pass despite ungated rows beside it", () => {
    // Operational counters carry no threshold by design. Requiring every row to
    // read "pass" meant one latency row made a fully passing case count as "not
    // scored" — so on any run with ops metrics, "cases passed" was always zero
    // and "cases not scored" measured nothing but the presence of counters.
    const counts = caseCountsFromMetrics(
      runWith([metric("a", "pass"), metric("a", null, "ops.latency"), metric("b", "pass")]),
    );

    expect(counts).toEqual({ passed: 2, warned: 0, failed: 0, total: 2, notScored: 0 });
  });

  it("reserves 'not scored' for a case with no gated row at all", () => {
    // Nothing was gated, so nothing can be said — that is a different statement
    // from "it was judged and did not pass".
    const counts = caseCountsFromMetrics(
      runWith([metric("a", "pass"), metric("b", null, "ops.latency"), metric("b", null, "ops.total_token_count")]),
    );

    expect(counts).toEqual({ passed: 1, warned: 0, failed: 0, total: 2, notScored: 1 });
  });

  it("still fails a case when a gated row failed, whatever the counters say", () => {
    const counts = caseCountsFromMetrics(
      runWith([metric("a", "fail"), metric("a", null, "ops.latency")]),
    );

    expect(counts).toEqual({ passed: 0, warned: 0, failed: 1, total: 1, notScored: 0 });
  });

  it("does not pass a case whose required check never reached a verdict", () => {
    // Every other null-threshold fixture here is an ops counter, which proves
    // only that ungated-by-design does not block a pass. A required check whose
    // evaluator crashed carries the same null threshold and must not be treated
    // the same way — the case cannot be called passed on its siblings alone.
    const crashed = {
      row_id: "a",
      metric_id: "llm.correctness",
      threshold_result: null,
      metric_requirement: "required",
      metric_status: "technical_error",
    } as unknown as MetricResult;

    const counts = caseCountsFromMetrics(runWith([crashed, metric("a", "pass", "llm.fluency")]));

    expect(counts).toEqual({ passed: 0, warned: 0, failed: 0, total: 1, notScored: 1 });
  });

  it("still passes a case when the withheld row was optional", () => {
    // An optional check is diagnostic; abstaining on one says nothing about the
    // case, so it must not drag a genuinely passing case into "not scored".
    const abstained = {
      row_id: "a",
      metric_id: "llm.tone",
      threshold_result: null,
      metric_requirement: "optional",
      metric_status: "unscored",
    } as unknown as MetricResult;

    const counts = caseCountsFromMetrics(runWith([abstained, metric("a", "pass")]));

    expect(counts).toEqual({ passed: 1, warned: 0, failed: 0, total: 1, notScored: 0 });
  });

  it("returns null with no metric rows, which is not the same as zero passed", () => {
    expect(caseCountsFromMetrics(runWith([]))).toBeNull();
    expect(caseCountsFromMetrics({ run_id: "run-1" } as RunResult)).toBeNull();
  });
});
