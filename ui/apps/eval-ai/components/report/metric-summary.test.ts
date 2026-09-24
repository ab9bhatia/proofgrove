import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MetricResult, RunResult } from "@/lib/api";
import { EmbeddedMetricSummary, EvaluatorOverview } from "./case-explorer";
import {
  metricMeasurements,
  metricTone,
  metricsNeedingAttention,
  nativeMetricValue,
  summarizeMetricScores,
} from "./lib";

function metric(overrides: Partial<MetricResult> = {}): MetricResult {
  return {
    metric_id: "llm.correctness",
    row_id: "case-1",
    score: 1,
    normalised_score: 1,
    metric_status: "scored",
    metric_requirement: "required",
    threshold_result: "pass",
    threshold: 0.8,
    metric_applicability: "applicable",
    ...overrides,
  } as unknown as MetricResult;
}

function run(results: MetricResult[]): RunResult {
  return { run_id: "run-1", metric_results: results, active_metrics: [] } as unknown as RunResult;
}

function render(results: MetricResult[]): string {
  return renderToStaticMarkup(
    createElement(EmbeddedMetricSummary, { run: run(results), totalCases: 1 } as never),
  );
}

describe("metric measurement units", () => {
  it("reports latency in seconds and tokens as tokens", () => {
    expect(nativeMetricValue("ops.latency", 9.104)).toBe("9.1s");
    expect(nativeMetricValue("ops.latency", 0.42)).toBe("420ms");
    expect(nativeMetricValue("ops.total_token_count", 301)).toBe("301 tokens");
  });

  it("adds nothing for a metric that is natively 0-1", () => {
    expect(nativeMetricValue("llm.correctness", 1)).toBeNull();
    expect(nativeMetricValue("ops.latency", null)).toBeNull();
  });

  it("carries the native mean only where it differs from the normalised score", () => {
    const [correctness, latency] = summarizeMetricScores(
      run([
        metric({ metric_id: "ops.latency", score: 9.104, normalised_score: 0.7 }),
        metric({ metric_id: "llm.correctness", score: 1, normalised_score: 1 }),
      ]),
      1,
    ).sort((a, b) => a.id.localeCompare(b.id));
    expect(latency.id).toBe("ops.latency");
    expect(latency.nativeMean).toBe(9.104);
    expect(correctness.nativeMean).toBeNull();
  });
});

describe("gating vs diagnostic", () => {
  it("marks an optional metric as non-gating", () => {
    const [summary] = summarizeMetricScores(
      run([metric({ metric_id: "nlp.bleu", metric_requirement: "optional" })]),
      1,
    );
    expect(summary.gating).toBe(false);
  });

  it("treats an unrecorded requirement as gating rather than understating it", () => {
    const [summary] = summarizeMetricScores(
      run([metric({ metric_id: "llm.correctness", metric_requirement: undefined })]),
      1,
    );
    expect(summary.gating).toBe(true);
  });
});

describe("EmbeddedMetricSummary", () => {
  const results = [
    metric({ metric_id: "llm.correctness" }),
    metric({
      metric_id: "nlp.bleu",
      metric_requirement: "optional",
      score: 0.021,
      normalised_score: 0.021,
      threshold_result: "fail",
    }),
    metric({
      metric_id: "ops.latency",
      metric_requirement: "optional",
      score: 9.104,
      normalised_score: 0.7,
      threshold_result: "warn",
    }),
  ];

  it("groups metrics under the same families the creation flow uses", () => {
    const html = render(results);
    expect(html).toContain("LLM quality");
    expect(html).toContain("NLP diagnostics");
    expect(html).toContain("Operational");
    // Grouped, so a text-overlap diagnostic no longer sits between two gating
    // quality metrics.
    expect(html.indexOf("NLP diagnostics")).toBeGreaterThan(html.indexOf("LLM quality"));
  });

  it("lets a family collapse without needing client state", () => {
    const html = render(results);
    // A plain <details open> — collapsible before hydration, and it stays
    // expanded by default so nothing is hidden from the operator.
    expect(html).toContain("<details open");
    expect(html).toContain("<summary");
    // Each heading says how many metrics it hides when closed.
    expect(html).toContain("1 metric");
  });

  it("says which families cannot move the verdict", () => {
    const html = render(results);
    expect(html).toContain("Diagnostic · does not gate");
    // ...and explains why a red chip on word-overlap is not a quality failure.
    expect(html).toContain("not correctness");
  });

  it("puts measurements in their own band, not in the scored table", () => {
    const html = render(results);
    // A latency has no declared budget, so it is reported as a fact and kept
    // out of a table whose columns are Average score and Outcome.
    expect(html).toContain('aria-label="Operational measurements"');
    expect(html).toContain("9.1s");
    expect(html).not.toContain("Scores 70.0% against its threshold");
    // ...and its family heading is gone from the table entirely.
    expect(html).not.toContain("Operational</h4>");
  });

  it("leaves a natively 0-1 metric showing its percentage alone", () => {
    const html = render([metric({ metric_id: "llm.correctness" })]);
    expect(html).toContain("100.0%");
    expect(html).not.toContain("against its threshold");
  });
});

describe("score colour follows the metric's own threshold", () => {
  it("does not paint a below-threshold score green", () => {
    // 75% under an 80% threshold: a global "70% is green" cutoff rendered this
    // emerald beside a FAIL badge, so the number and the badge disagreed.
    expect(metricTone(null, 0.75, 0.8)).toBe("fail");
    expect(metricTone(null, 0.85, 0.8)).toBe("pass");
  });

  it("defers to the recorded gate when there is one", () => {
    expect(metricTone("fail", 0.99, 0.1)).toBe("fail");
    expect(metricTone("warn", 0.99, 0.1)).toBe("warn");
    expect(metricTone("pass", 0.1, 0.9)).toBe("pass");
  });

  it("gives an unjudgeable score no colour rather than a flattering one", () => {
    expect(metricTone(null, null, 0.8)).toBe("unknown");
    expect(metricTone(null, 0.75, null)).toBe("unknown");
  });
});

describe("one definition of metrics needing attention", () => {
  const summarize = (results: MetricResult[]) => summarizeMetricScores(run(results), 1);

  it("counts unscored, errored, warned and failed metrics", () => {
    const metrics = summarize([
      metric({ metric_id: "llm.a", threshold_result: "fail" }),
      metric({ metric_id: "llm.b", threshold_result: "warn" }),
      metric({ metric_id: "llm.c", metric_status: "unscored", normalised_score: null }),
    ]);
    expect(metricsNeedingAttention(metrics)).toHaveLength(3);
  });

  it("does not count a metric that legitimately did not apply", () => {
    // A null gate used to mean "attention", which swept in not-applicable
    // metrics and made the panel's count disagree with the header's.
    const metrics = summarize([
      metric({ metric_id: "llm.a", metric_applicability: "not_applicable", normalised_score: null }),
    ]);
    expect(metricsNeedingAttention(metrics)).toHaveLength(0);
  });
});

describe("measurements are reported as facts", () => {
  it("leads latency with its worst case, because a mean hides the tail", () => {
    const latency = metricMeasurements(
      run([
        metric({ metric_id: "ops.latency", score: 6.2, normalised_score: null, threshold_result: null }),
        metric({ metric_id: "ops.latency", row_id: "case-2", score: 23.7, normalised_score: null, threshold_result: null }),
      ]),
    )[0];
    expect(latency.value).toBe("14.9s");
    expect(latency.worst).toBe("23.7s");
    expect(latency.sampleSize).toBe(2);
  });

  it("does not claim a worst case for a count, where the spread is not the point", () => {
    const tokens = metricMeasurements(
      run([
        metric({ metric_id: "ops.total_token_count", score: 301, normalised_score: null, threshold_result: null }),
      ]),
    )[0];
    expect(tokens.value).toBe("301 tokens");
    expect(tokens.worst).toBeNull();
  });
});

describe("EvaluatorOverview", () => {
  it("keeps zero scores, errors, missing cases and operational measurements distinct", () => {
    const results = [
      metric({ score: 0, normalised_score: 0, threshold_result: "fail" }),
      metric({ row_id: "case-2", metric_status: "technical_error", normalised_score: null, threshold_result: null }),
      metric({ metric_id: "ops.latency", score: 9, normalised_score: 1 }),
    ];
    const html = renderToStaticMarkup(createElement(EvaluatorOverview, { run: run(results), totalCases: 3 }));
    expect(html).toContain("0.0%");
    expect(html).toContain("0 / 1");
    expect(html).toContain("1 / 3");
    expect(html).not.toContain("Latency</th>");
    expect(html).toContain("Errors");
  });
});
