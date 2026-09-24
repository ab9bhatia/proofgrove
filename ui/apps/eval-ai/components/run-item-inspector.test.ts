import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  lockRunItemPageScroll,
  RunItemDrawer,
} from "@/components/run-item-drawer";
import {
  executionEvidenceSummary,
  groupScorerResults,
  RunItemCaseReview,
  RunItemInspector,
} from "@/components/run-item-inspector";
import type { KpiResult, MetricResult, RunItemDetail } from "@/lib/api";

const item: RunItemDetail = {
  run_id: "run-1",
  example_id: "example-1",
  sequence_position: 0,
  dataset_version: "dataset-v1",
  input: { query: "Should we approve the request?", locale: "en-AE" },
  output: {
    response: [
      "## Recommendation",
      "",
      "**Approve** after these checks:",
      "",
      "- Verify the budget",
      "- Record the decision",
    ].join("\n"),
    citations: ["policy-4"],
  },
  expected: {
    expected_answer: "Approve after verification.",
    rubric: "Mention the required checks.",
  },
  metadata: null,
  retrieval_snippets: [],
  expected_tools: [],
  tool_calls: [],
  tool_result_artifacts: [],
  execution: {
    invocation_id: "invocation-1",
    kagent_session_id: "session-1",
    latency_ms: 120,
    usage: null,
    invocation_error: null,
    trace_id: null,
    span_id: null,
  },
  scorer_results: [],
  evidence_ref: "evidence-pack://run-1/items/example-1",
  evidence_policy: {
    redaction_enabled: true,
    max_persisted_string_size: 10_000,
    retention_policy: "stored_with_run_lifecycle",
  },
  capture_state: "complete",
};

function scorer(
  metricId: string,
  score: number,
  thresholdResult: MetricResult["threshold_result"],
): MetricResult {
  return {
    metric_id: metricId,
    evaluator_instance_id: `${metricId}-instance`,
    run_id: "run-1",
    row_id: "example-1",
    score,
    normalised_score: score,
    label: null,
    passed: thresholdResult === "pass",
    rationale: "Because the evidence supports this score.",
    error_message: null,
    threshold: 0.7,
    threshold_result: thresholdResult,
    trace_id: null,
    prompt_version: "rubrics.v1",
    judge_prompt_tokens: 10,
    judge_completion_tokens: 5,
    judge_total_tokens: 15,
    judge_model: "judge-model",
    evaluator_id: metricId,
    evaluator_version: "1.0",
    execution_status: "success",
    execution_metadata: {},
  };
}

describe("RunItemInspector", () => {
  it("locks and restores the Proofgrove page scroller behind the evidence dialog", () => {
    const style = { overflow: "auto" };

    const unlock = lockRunItemPageScroll(style);

    expect(style.overflow).toBe("hidden");
    unlock();
    expect(style.overflow).toBe("auto");
  });

  it("renders the actual answer as the primary Markdown evidence", () => {
    const html = renderToStaticMarkup(createElement(RunItemInspector, { item }));

    expect(html).toContain("Actual answer");
    expect(html).toMatch(/<h5[^>]*>Recommendation<\/h5>/);
    expect(html).toContain("Approve</strong>");
    expect(html).toContain("Verify the budget</li>");
    expect(html).not.toContain("## Recommendation");
    expect(html).toContain("Additional output fields");
    expect(html).toContain("policy-4");
    expect(html).toContain("Additional input fields");
    expect(html).toContain("en-AE");
    expect(html).toContain("Additional expectation fields");
    expect(html).toContain("Mention the required checks.");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain("Trace");
  });

  it("discloses simulated scorer output instead of presenting a score", () => {
    const simulated: MetricResult = {
      ...scorer("llm.correctness", 0, null),
      score: null,
      normalised_score: null,
      passed: null,
      metric_status: "unscored",
      unscored_reason: "simulated",
      requested_scorer: "deepeval",
      executed_scorer: "mock",
    };

    const html = renderToStaticMarkup(
      createElement(RunItemCaseReview, {
        item: { ...item, scorer_results: [simulated] },
        kpis: [],
      }),
    );

    expect(html).toContain("Simulated - no real judge ran");
    expect(html).toContain("Requested scorer");
    expect(html).toContain("deepeval");
    expect(html).toContain("Executed scorer");
    expect(html).toContain("mock");
  });

  it("presents a selected item in a reviewer side panel", () => {
    const html = renderToStaticMarkup(
      createElement(RunItemDrawer, {
        exampleId: item.example_id,
        item,
        loading: false,
        error: null,
        position: 2,
        total: 5,
        kpis: [],
        onClose: () => undefined,
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Evidence inspector · dataset row 2 of 5");
    expect(html).toContain("Previous");
    expect(html).toContain("Next");
    expect(html).toContain("Actual answer");
    expect(html).toContain("Trace not captured");
  });

  it("links every case drawer to Projects only when genuine project and trace ids exist", () => {
    const html = renderToStaticMarkup(
      createElement(RunItemDrawer, {
        exampleId: item.example_id,
        item: {
          ...item,
          execution: { ...item.execution, trace_id: "1234567890abcdef1234567890abcdef", span_id: "0123456789abcdef" },
        },
        loading: false,
        error: null,
        position: 1,
        total: 1,
        kpis: [],
        projectId: "project-support",
        onClose: () => undefined,
      }),
    );

    expect(html).toContain("Trace ID recorded");
    expect(html).toContain("Open trace in Projects");
    expect(html).toContain('/projects/project-support/traces/1234567890abcdef1234567890abcdef');
  });

  it("does not claim or link a disabled or malformed OTel trace", () => {
    for (const trace_id of ["0".repeat(32), "invalid-trace"]) {
      const html = renderToStaticMarkup(createElement(RunItemDrawer, {
        exampleId: item.example_id,
        item: { ...item, execution: { ...item.execution, trace_id, span_id: "0".repeat(16) } },
        loading: false, error: null, position: 1, total: 1, kpis: [],
        projectId: "project-support", onClose: () => undefined,
      }));
      expect(html).toContain("Trace not captured");
      expect(html).not.toContain("Open trace in Projects");
      expect(html).not.toContain("Genuine trace ID");
      expect(html).not.toContain(trace_id);
    }
  });

  it("can present the same saved evidence in a centered case dialog", () => {
    const unscoredResult: MetricResult = {
      ...scorer("agent.tool_selection", 0, null),
      score: null,
      normalised_score: null,
      passed: null,
      metric_status: "unscored",
      unscored_reason: "evidence_unavailable",
    };
    const html = renderToStaticMarkup(
      createElement(RunItemDrawer, {
        variant: "dialog",
        exampleId: item.example_id,
        item: { ...item, scorer_results: [unscoredResult] },
        loading: false,
        error: null,
        position: 1,
        total: 2,
        kpis: [],
        onClose: () => undefined,
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Case 1 of 2");
    expect(html).toMatch(/<h2[^>]*>Should we approve the request\?<\/h2>/);
    // Centring is the shared modal variant's job (`items-center justify-center`);
    // the panel used to translate itself on top of that and land off-centre.
    expect(html).toContain("justify-center");
    expect(html).not.toContain("left-1/2");
    expect(html).toContain("rounded-2xl");
    expect(html).toContain("Actual response");
    expect(html).toContain("Expected response");
    expect(html).toContain("Metric results");
    expect(html).toContain("More evidence");
    // One name for the state. This assertion used to require both spellings.
    expect(html).toContain("Not scored");
    expect(html).not.toContain("Unscored");
    expect(html).not.toContain("\\u2014");
    expect(html).toContain("duration-200");
    expect(html).toContain("group-open/more:grid-rows-[1fr]");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain("Selected dataset row");
  });

  it("keeps an artifact-backed partial trace successful and inspectable", () => {
    const html = renderToStaticMarkup(
      createElement(RunItemInspector, {
        item: {
          ...item,
          capture_state: "partial",
          tool_result_artifacts: [
            {
              artifact_id: "artifact-1",
              artifact_ref: "artifact://tool-results/artifact-1",
              tool_name: "document_search",
              tool_call_index: 0,
              content_type: "application/json",
              size_bytes: 3_700_000,
              preview: "preview",
              preview_bytes: 131_072,
            },
          ],
        },
      }),
    );

    expect(html).toContain("Large output stored separately");
    expect(html).toContain("Large tool output stored separately");
    expect(html).toContain("does not by itself mean the trace is partial");
  });

  it("reports execution evidence as not configured when the run scored final responses", () => {
    const html = renderToStaticMarkup(
      createElement(RunItemInspector, { item, evaluationScope: "final_response" }),
    );

    // The stat tile truncates to one line, so it carries a status, not a sentence.
    expect(html).toContain("Outside the evaluated depth");
    expect(html).not.toContain("Not configured. Not configured");
    expect(html).not.toContain("Full execution was not captured for this run.");
  });

  it("does not invent a depth for a run that recorded none", () => {
    const html = renderToStaticMarkup(
      createElement(RunItemInspector, { item, evaluationScope: null }),
    );

    expect(html).toContain("Scope not recorded");
    expect(html).not.toContain("Final response");
    expect(html).not.toContain("Not configured.");
    expect(html).not.toContain("Not captured");
    expect(
      executionEvidenceSummary({ traceId: null, toolCallCount: 0, evaluationScope: null }),
    ).toContain("Scope not recorded");
  });

  it("reports execution evidence as not captured only when full execution was configured", () => {
    const html = renderToStaticMarkup(
      createElement(RunItemInspector, { item, evaluationScope: "full_execution" }),
    );

    expect(html).toContain("Not captured");
    expect(html).not.toContain("Outside the evaluated depth");
  });

  it("prefers recorded execution evidence over any depth message", () => {
    expect(
      executionEvidenceSummary({
        traceId: "1234567890abcdef1234567890abcdef",
        toolCallCount: 0,
        evaluationScope: "final_response",
      }),
    ).toBe("Trace ID recorded");
    expect(
      executionEvidenceSummary({ traceId: null, toolCallCount: 2, evaluationScope: null }),
    ).toBe("Tool interactions captured");
    expect(
      executionEvidenceSummary({ traceId: null, toolCallCount: 0, evaluationScope: "tool_interactions" }),
    ).toBe("Outside the evaluated depth");
  });

  it("groups each scorer once by metric family and references related run KPIs", () => {
    const metrics = [
      scorer("llm.correctness", 0.8, "pass"),
      scorer("llm.relevance", 0.4, "fail"),
      scorer("rag.groundedness", 0.6, "warn"),
      scorer("safety.ungrounded_attributes", 1, "pass"),
    ];
    const responseKpi: KpiResult = {
      kpi_id: "kpi.response_quality",
      run_id: "run-1",
      composite_score: 0.65,
      gate_result: "warn",
      constituent_scores: [
        {
          metric_id: "llm.correctness",
          weight: 0.75,
          raw_score: 0.7,
          normalised_score: 0.7,
          sample_size: 10,
        },
        {
          metric_id: "llm.relevance",
          weight: 0.25,
          raw_score: 0.5,
          normalised_score: 0.5,
          sample_size: 10,
        },
      ],
      threshold_pass: 0.8,
      threshold_warn: 0.6,
      threshold_fail: 0.6,
      evaluated_target: "tenant/evidence-agent",
    };
    const safetyKpi: KpiResult = {
      ...responseKpi,
      kpi_id: "kpi.safety_trust",
      composite_score: 1,
      constituent_scores: [
        {
          metric_id: "safety.ungrounded_attributes",
          weight: 1,
          raw_score: 1,
          normalised_score: 1,
          sample_size: 10,
        },
      ],
    };
    const retrievalKpi: KpiResult = {
      ...responseKpi,
      kpi_id: "kpi.retrieval_quality",
      composite_score: 0.6,
      constituent_scores: [
        {
          metric_id: "rag.groundedness",
          weight: 1,
          raw_score: 0.6,
          normalised_score: 0.6,
          sample_size: 10,
        },
      ],
    };
    const factualKpi: KpiResult = {
      ...responseKpi,
      kpi_id: "kpi.factual_integrity",
      composite_score: 0.72,
      constituent_scores: [
        {
          metric_id: "rag.groundedness",
          weight: 0.7,
          raw_score: 0.6,
          normalised_score: 0.6,
          sample_size: 10,
        },
        {
          metric_id: "safety.ungrounded_attributes",
          weight: 0.3,
          raw_score: 1,
          normalised_score: 1,
          sample_size: 10,
        },
      ],
    };

    const groups = groupScorerResults(metrics, [
      responseKpi,
      retrievalKpi,
      safetyKpi,
      factualKpi,
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "LLM quality",
      "RAG quality",
      "Safety",
    ]);
    expect(groups[0].worstGate).toBe("fail");
    expect(groups[0].failingCount).toBe(1);
    expect(groups[1].relatedKpis.map((kpi) => kpi.kpiId)).toEqual([
      "kpi.retrieval_quality",
      "kpi.factual_integrity",
    ]);
    expect(groups[2].relatedKpis.map((kpi) => kpi.kpiId)).toEqual([
      "kpi.safety_trust",
      "kpi.factual_integrity",
    ]);
    const groupedMetricIds = groups.flatMap((group) =>
      group.metrics.map((metric) => metric.metric_id),
    );
    expect(groupedMetricIds).toEqual(metrics.map((metric) => metric.metric_id));
    expect(new Set(groupedMetricIds).size).toBe(groupedMetricIds.length);
  });
});

describe("case metric results grouping", () => {
  it("groups a case's metrics into the same collapsible families as the run report", () => {
    const html = renderToStaticMarkup(
      createElement(RunItemCaseReview, {
        item: {
          ...item,
          scorer_results: [
            { metric_id: "llm.correctness", normalised_score: 1, threshold: 0.8, metric_requirement: "required" },
            { metric_id: "nlp.bleu", normalised_score: 0.02, threshold: 0.5, metric_requirement: "optional" },
            { metric_id: "ops.latency", normalised_score: 0.7, threshold: 0.8, metric_requirement: "optional" },
          ],
        },
      } as never),
    );
    expect(html).toContain("LLM quality");
    expect(html).toContain("NLP diagnostics");
    expect(html).toContain("Operational");
    // Collapsible, and diagnostics are labelled here too so one case reads the
    // same way the run report does.
    expect(html).toContain("<details");
    expect(html).toContain("Diagnostic · does not gate");
  });
});

describe("trace evidence in the dialog case review", () => {
  const html = () =>
    renderToStaticMarkup(
      createElement(RunItemCaseReview, {
        item: {
          ...item,
          execution: { ...item.execution, trace_id: "abcdef1234567890abcdef1234567890" },
        },
      } as never),
    );

  it("exposes a trace section on the surface the report actually opens", () => {
    // The report opens cases in this variant; a drill-down that existed only in
    // the drawer variant was unreachable from there.
    expect(html()).toContain("Captured trace evidence");
  });

  it("does not fetch the archive until the section is opened", () => {
    // Collapsed and unmounted: opening a case must not pull a trace archive
    // nobody asked for.
    expect(html()).not.toContain('role="tree"');
    expect(html()).not.toContain("Loading archived trace evidence");
  });

  it("says plainly when no trace was recorded", () => {
    const bare = renderToStaticMarkup(
      createElement(RunItemCaseReview, { item } as never),
    );
    expect(bare).toContain("No trace was recorded for this case");
  });
});

describe("case metric results show a metric in its own units", () => {
  it("leads with the measurement, not a percentage, for an ops metric", () => {
    const rendered = renderToStaticMarkup(
      createElement(RunItemCaseReview, {
        item: {
          ...item,
          scorer_results: [
            {
              metric_id: "ops.total_token_count",
              score: 1593,
              normalised_score: 1,
              threshold: 0.8,
              metric_requirement: "optional",
              threshold_result: "pass",
            },
          ],
        },
      } as never),
    );
    // The run report showed "1,593 tokens" while this surface showed "100.0%"
    // for the same metric.
    expect(rendered).toContain("1,593 tokens");
  });
});

describe("case summary counts only what was judged", () => {
  it("shows historical operational scores as measurements without offering judge review", () => {
    const measurement = { ...scorer("ops.token_efficiency", 1, "pass"), metric_status: "scored" as const };
    const html = renderToStaticMarkup(createElement(RunItemCaseReview, {
      item: { ...item, scorer_results: [measurement] }, kpis: [],
    }));
    expect(html).toContain("0 checks · 1 measurement");
    expect(html).toContain("No verdict");
    expect(html).not.toContain("100.0%");
    expect(html).not.toContain("Send to review");
    expect(groupScorerResults([measurement], [])[0].worstGate).toBeNull();
  });

  it("leaves operational measurements out of the metrics-passed denominator", () => {
    // ops.* metrics record a value and no verdict, so counting them here read
    // "1 of 3 metrics passed" on a case that ran exactly one judgement — and the
    // metric table below, which banks measurements separately, said otherwise.
    const html = renderToStaticMarkup(
      createElement(RunItemCaseReview, {
        item: {
          ...item,
          scorer_results: [
            scorer("llm.relevance", 1, "pass"),
            { ...scorer("ops.latency", 1500, null), normalised_score: null, passed: null },
            { ...scorer("ops.total_token_count", 900, null), normalised_score: null, passed: null },
          ],
        },
        kpis: [],
      }),
    );

    expect(html).toContain("1 of 1 metrics passed");
    expect(html).not.toContain("1 of 3 metrics passed");
    expect(html).toContain("1 check · 2 measurements");
  });
});

describe("an unscored case does not claim a denominator", () => {
  it("leaves results with no verdict out of the metrics-passed count", () => {
    // "0 of 1 metrics passed" on a case where the single metric was never judged
    // reads as a failure. Nothing was judged, so there is nothing to count.
    const unscored: MetricResult = {
      ...scorer("llm.relevance", 0, null),
      score: null,
      normalised_score: null,
      passed: null,
      metric_status: "unscored",
    };
    const html = renderToStaticMarkup(
      createElement(RunItemCaseReview, { item: { ...item, scorer_results: [unscored] }, kpis: [] }),
    );

    expect(html).toContain("No metric results");
    expect(html).not.toContain("0 of 1 metrics passed");
  });
});
