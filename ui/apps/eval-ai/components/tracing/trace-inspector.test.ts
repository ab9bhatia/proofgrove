import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TraceInspector } from "@/components/tracing/trace-inspector";
import { formatSpanStartTime } from "@/components/tracing/trace-workspace";
import type { CapturedTraceDetail, CapturedTraceSpans } from "@/lib/api";

function detail(): CapturedTraceDetail {
  return {
    project_id: "proj-1",
    trace_id: "trace-1",
    trace_provider: "otel",
    run_id: "run-1",
    example_id: "ex-1",
    evaluation_name: "Eval",
    input_summary: "hello",
    evaluation_status: "evaluated",
    target_revision: "rev-1",
    captured_at: "2026-08-01T10:00:00Z",
    capture_state: "captured",
    attestation_state: "attested",
    invocation_outcome: "succeeded",
    latency_ms: 12,
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    cost: null,
    run_status: "completed",
    verdict_status: null,
    overall_gate: null,
    root_span_name: "POST /",
    root_span_kind: "SERVER",
    span_count: 2,
    error_count: 0,
    hidden: false,
    spans: [],
    tree_available: true,
  } as CapturedTraceDetail;
}

function spans(): CapturedTraceSpans {
  return {
    tree_available: true,
    spans: [
      {
        trace_id: "trace-1",
        span_id: "http",
        parent_span_id: null,
        name: "POST /",
        kind: 2,
        start_time_unix_nano: null,
        end_time_unix_nano: null,
        duration_ms: 100,
        status: null,
        attributes: {},
        resource_attributes: {},
        events: [],
      },
      {
        trace_id: "trace-1",
        span_id: "llm",
        parent_span_id: "http",
        name: "chat",
        kind: null,
        start_time_unix_nano: null,
        end_time_unix_nano: null,
        duration_ms: 50,
        status: null,
        attributes: { "openinference.span.kind": "LLM" },
        resource_attributes: {},
        events: [],
      },
    ],
  };
}

describe("TraceInspector span tree", () => {
  it("lists the spans with an honest count and no filtering controls", () => {
    const html = renderToStaticMarkup(
      createElement(TraceInspector, {
        trace: detail(),
        spans: spans(),
        spansLoading: false,
        spansError: null,
        onRetrySpans: () => undefined,
        item: null,
        scoreError: null,
        onRetryScores: () => undefined,
        selectedSpanId: "llm",
        currentQuery: "",
        onSelectSpan: () => undefined,
      }),
    );

    // The tree shows one trace's spans, all of them, at once. A search box and
    // three filters over a list you can already see was a second filtering
    // vocabulary inside the pane for no reader benefit.
    expect(html).not.toContain("Search name or attributes");
    expect(html).not.toContain('role="searchbox"');
    expect(html).not.toContain("<select");
    // Transport spans are never rendered and the toggle is gone: it only gave
    // the operator a way to bury the evidence under HTTP plumbing.
    expect(html).not.toContain("Show network / transport spans");
    // "archived" ties this count back to the trace summary's own "Archived
    // spans" datum, rather than restating the total as a bare "spans" count.
    expect(html).toContain("1 AI operation");
    expect(html).not.toContain("Hide infra spans");
    expect(html).toContain("chat");
    expect(html).toContain('role="tree"');
    expect(html).toContain(">llm</span>");
    expect(html).toContain("text-purple-700");
    expect(html).not.toContain(">server</span>");
  });
});

describe("TraceInspector LLM span detail pane", () => {
  it("renders Phoenix-style LLM metadata, messages, and invocation params", () => {
    const richSpans = (): CapturedTraceSpans => ({
      tree_available: true,
      spans: [
        {
          trace_id: "trace-1",
          span_id: "llm-rich",
          parent_span_id: null,
          name: "ChatCompletion",
          kind: null,
          start_time_unix_nano: null,
          end_time_unix_nano: null,
          duration_ms: 88,
          status: null,
          attributes: {
            "openinference.span.kind": "LLM",
            "llm.model_name": "gpt-4o-mini",
            "llm.token_count.prompt": 12,
            "llm.token_count.completion": 3,
            "llm.token_count.total": 15,
            "llm.cost.total": "0.0021",
            "llm.invocation_parameters": "{\"temperature\":0.2,\"max_tokens\":512}",
            "llm.input_messages.0.message.role": "user",
            "llm.input_messages.0.message.content": "What is 2+2?",
            "llm.output_messages.0.message.role": "assistant",
            "llm.output_messages.0.message.content": "4",
          },
          resource_attributes: {},
          events: [],
        },
      ],
    });

    const html = renderToStaticMarkup(
      createElement(TraceInspector, {
        trace: detail(),
        spans: richSpans(),
        spansLoading: false,
        spansError: null,
        onRetrySpans: () => undefined,
        item: null,
        scoreError: null,
        onRetryScores: () => undefined,
        selectedSpanId: "llm-rich",
        currentQuery: "",
        onSelectSpan: () => undefined,
      }),
    );

    // Model stays in the header; message sections have clear Input/Output titles.
    expect(html).toContain(">gpt-4o-mini</span>");
    expect(html).toContain("12 prompt · 3 completion · 15 total");
    expect(html).toContain("Model settings");
    expect(html).toContain("temperature");
    expect(html).toContain(">Input</h5>");
    expect(html).toContain(">Output</h5>");
    // Each message is its own role-labelled disclosure, not one joined blob.
    expect(html).toContain(">user</summary>");
    expect(html).toContain(">What is 2+2?</pre>");
    expect(html).toContain(">assistant</summary>");
    expect(html).not.toContain("span-llm-output-tab-output-messages");
    expect(html).toContain("0.0021");
  });

  it("keeps generic input/output cards for tool spans", () => {
    const toolSpans = (): CapturedTraceSpans => ({
      tree_available: true,
      spans: [
        {
          trace_id: "trace-1",
          span_id: "tool",
          parent_span_id: null,
          name: "search",
          kind: null,
          start_time_unix_nano: null,
          end_time_unix_nano: null,
          duration_ms: 10,
          status: null,
          attributes: {
            "openinference.span.kind": "TOOL",
            "input.value": "query",
            "output.value": "results",
          },
          resource_attributes: {},
          events: [],
        },
      ],
    });

    const html = renderToStaticMarkup(
      createElement(TraceInspector, {
        trace: detail(),
        spans: toolSpans(),
        spansLoading: false,
        spansError: null,
        onRetrySpans: () => undefined,
        item: null,
        scoreError: null,
        onRetryScores: () => undefined,
        selectedSpanId: "tool",
        currentQuery: "",
        onSelectSpan: () => undefined,
      }),
    );

    expect(html).toContain("Input");
    expect(html).toContain("Output");
    expect(html).not.toContain("Invocation Params");
    expect(html).not.toContain("Input Messages");
  });
});


describe("TraceInspector annotation summary", () => {
  it("renders case annotations once in the summary", () => {
    const html = renderToStaticMarkup(
      createElement(TraceInspector, {
        trace: detail(),
        spans: spans(),
        spansLoading: false,
        spansError: null,
        onRetrySpans: () => undefined,
        item: {
          run_id: "run-1",
          example_id: "ex-1",
          sequence_position: 1,
          dataset_version: "ds@v1",
          input: null,
          output: null,
          expected: null,
          metadata: null,
          retrieval_snippets: null,
          expected_tools: null,
          tool_calls: null,
          tool_result_artifacts: [],
          execution: {
            invocation_id: "inv-1",
            kagent_session_id: null,
            trace_id: "trace-1",
            span_id: "llm",
            latency_ms: 12,
            usage: null,
          },
          scorer_results: [
            {
              metric_id: "llm.coherence",
              score: 1,
              normalised_score: 1,
              passed: true,
              threshold_result: "pass",
              metric_status: "scored",
              metric_applicability: "applicable",
              unscored_reason: null,
              error_message: null,
            },
          ],
          evidence_ref: "ref",
          evidence_policy: "captured_trace",
          capture_state: "complete",
        },
        scoreError: null,
        onRetryScores: () => undefined,
        selectedSpanId: "llm",
        currentQuery: "",
        onSelectSpan: () => undefined,
      } as never),
    );

    expect(html).not.toContain(">Case scores</h3>");
    expect(html).toContain("Annotation summary");
    expect(html).toContain("Whole case");
    expect(html).toContain("coherence");
    // Rendered once. It was briefly both a tab panel and a block below the
    // tabs, which put two identically-named landmarks on the same pane.
    expect(html.split(">Annotation summary</h3>").length - 1).toBe(1);
    expect(html).not.toContain(">Annotation summary</h4>");
  });

  it("keeps case scores on screen when the span archive fails", () => {
    // Scores come from the run item, not the archive. Nesting them inside the
    // span pane meant a spans outage deleted evidence that had loaded fine.
    const html = renderToStaticMarkup(
      createElement(TraceInspector, {
        trace: detail(),
        spans: null,
        spansLoading: false,
        spansError: "Span archive unavailable",
        item: scoredItem([
          {
            metric_id: "llm.coherence",
            score: 1,
            normalised_score: 1,
            passed: true,
            threshold_result: "pass",
            metric_status: "scored",
            metric_applicability: "applicable",
            unscored_reason: null,
            error_message: null,
          },
        ]),
        scoreError: null,
        onRetryScores: () => undefined,
        selectedSpanId: null,
        currentQuery: "",
        onSelectSpan: () => undefined,
      } as never),
    );

    expect(html).toContain("Span archive unavailable");
    expect(html).toContain("coherence");
    expect(html).toContain("Annotation summary");
  });

  it("says a case recorded no scores rather than showing nothing", () => {
    const html = renderToStaticMarkup(
      createElement(TraceInspector, {
        trace: detail(),
        spans: spans(),
        spansLoading: false,
        spansError: null,
        item: scoredItem([]),
        scoreError: null,
        onRetryScores: () => undefined,
        selectedSpanId: "llm",
        currentQuery: "",
        onSelectSpan: () => undefined,
      } as never),
    );

    expect(html).toContain("Scores not recorded for this captured case.");
  });

  it("hides metrics without scores from the annotation summary", () => {
    const item = scoredItem([
      {
        metric_id: "tool.selection",
        score: null,
        normalised_score: null,
        passed: null,
        threshold_result: null,
        metric_status: "unscored",
        metric_applicability: "applicable",
        unscored_reason: "missing_expected_tools",
        error_message: null,
      },
      {
        metric_id: "rag.groundedness",
        score: null,
        normalised_score: null,
        passed: null,
        threshold_result: null,
        metric_status: "unscored",
        metric_applicability: "not_applicable",
        unscored_reason: null,
        error_message: null,
      },
    ]);
    const html = renderToStaticMarkup(
      createElement(TraceInspector, {
        trace: detail(),
        spans: spans(),
        spansLoading: false,
        spansError: null,
        item,
        scoreError: null,
        onRetryScores: () => undefined,
        selectedSpanId: "llm",
        currentQuery: "",
        onSelectSpan: () => undefined,
      } as never),
    );

    expect(html).toContain("Scores not recorded for this captured case.");
    expect(html).not.toContain("Not applicable");
    expect(html).not.toContain("unscored");
  });
});


describe("LLM message tablist keyboard reachability", () => {
  const source = readFileSync(
    // The tablist lives with the span detail pane, which is where the
    // inspector's 1135 lines split it to.
    join(dirname(fileURLToPath(import.meta.url)), "span-detail-pane.tsx"),
    "utf8",
  );

  it("builds both tab levels from the shared tabs primitive", () => {
    // A role="tablist" with roving tabIndex and no keyboard handling leaves
    // every unselected tab (Output Messages) unreachable from the keyboard.
    // The shared primitive owns that contract, so this pane must not hand-roll
    // a second tablist beside it.
    expect(source).toContain('from "@/components/ui/tabs"');
    expect(source).toContain("<TabsTrigger");
    expect(source).not.toContain('role="tablist"');
    expect(source).not.toContain('role="tab"');
  });
});

describe("transport spans are not offered at all", () => {
  it("hides them with no way to turn them back on", () => {
    const html = renderToStaticMarkup(
      createElement(TraceInspector, {
        trace: detail(),
        spans: spans(),
        spansLoading: false,
        spansError: null,
        onRetrySpans: () => {},
        item: null,
        scoreError: null,
        onRetryScores: () => {},
        selectedSpanId: null,
        currentQuery: "",
        onSelectSpan: () => {},
      } as never),
    );
    // No control to reveal them...
    expect(html).not.toContain("Show network / transport spans");
    expect(html).not.toContain('type="checkbox"');
    // ...but the count still discloses what was dropped, so rows never vanish
    // silently.
    expect(html).not.toContain("transport span");
  });
});


/** A captured case carrying the given scorer results, for the annotation summary. */
function scoredItem(scorerResults: unknown[]) {
  return {
    run_id: "run-1",
    example_id: "ex-1",
    sequence_position: 1,
    dataset_version: "ds@v1",
    input: null,
    output: null,
    expected: null,
    metadata: null,
    retrieval_snippets: null,
    expected_tools: null,
    tool_calls: null,
    tool_result_artifacts: [],
    execution: {
      invocation_id: "inv-1",
      kagent_session_id: null,
      trace_id: "trace-1",
      span_id: "llm",
      latency_ms: 12,
      usage: null,
      invocation_error: null,
    },
    scorer_results: scorerResults,
    evidence_ref: "ref",
    evidence_policy: {
      redaction_enabled: false,
      max_persisted_string_size: null,
      retention_policy: "stored_with_run_lifecycle",
    },
    capture_state: "complete",
  };
}

describe("SpanDetailPane header and tabs", () => {
  function headerSpans(): CapturedTraceSpans {
    return {
      tree_available: true,
      spans: [
        {
          trace_id: "trace-1",
          span_id: "span-header",
          parent_span_id: null,
          name: "agent turn",
          kind: null,
          start_time_unix_nano: "1787000000000000000",
          end_time_unix_nano: "1787000002800000000",
          duration_ms: 2800,
          status: { code: "OK" },
          attributes: {
            "openinference.span.kind": "AGENT",
            "llm.token_count.total": 42,
            "llm.cost.total": "0.0031",
            "input.value": "go",
          },
          resource_attributes: { "service.name": "agent" },
          events: [{ name: "tool.called", attributes: { tool: "search" } }],
        },
      ],
    };
  }

  function render(spansData: CapturedTraceSpans, selected: string): string {
    return renderToStaticMarkup(
      createElement(TraceInspector, {
        trace: detail(),
        spans: spansData,
        spansLoading: false,
        spansError: null,
        onRetrySpans: () => undefined,
        item: null,
        scoreError: null,
        onRetryScores: () => undefined,
        selectedSpanId: selected,
        currentQuery: "",
        onSelectSpan: () => undefined,
      }),
    );
  }

  it("puts kind, name, id, duration, start time, tokens and cost in one header block", () => {
    const html = render(headerSpans(), "span-header");
    expect(html).toContain(">agent</span>");
    expect(html).toContain(">agent turn</h4>");
    expect(html).toContain("span-header");
    expect(html).toContain(">2.8s</span>");
    // Rendered through the shared formatter so the assertion is timezone-safe.
    expect(html).toContain(`at ${formatSpanStartTime("1787000000000000000")}</span>`);
    expect(html).toContain(">42 tokens</span>");
    expect(html).toContain(">Cost 0.0031</span>");
  });

  it("offers Info / Attributes / Events tabs with a real tablist and an event count", () => {
    const html = render(headerSpans(), "span-header");
    expect(html).toContain('aria-label="Span detail sections"');
    expect(html).toContain('id="span-detail-tab-info"');
    expect(html).toContain('id="span-detail-tab-attributes"');
    expect(html).toContain('id="span-detail-tab-events"');
    expect(html).toContain(">Events 1</button>");
    // Info is the landing tab; the others stay mounted behind `hidden`.
    // Attribute order is the primitive's business, so match on the tag.
    expect(html).toMatch(/<button(?=[^>]*aria-selected="true")(?=[^>]*id="span-detail-tab-info")[^>]*>/);
    expect(html).toMatch(/id="span-detail-panel-attributes"[^>]*hidden=""/);
    expect(html).toContain('role="tabpanel"');
    // No autoFocus anywhere in the pane.
    expect(html).not.toContain("autofocus");
  });

  it("routes status, raw attributes and resource attributes into the Attributes tab", () => {
    const html = render(headerSpans(), "span-header");
    const panel = html.slice(html.indexOf('id="span-detail-panel-attributes"'));
    expect(panel).toContain("Status");
    expect(panel).toContain("Search attributes");
    expect(panel).toContain("Resource attributes");
    expect(panel).toContain("service.name");
  });

  it("renders recorded events, and an honest empty state when there are none", () => {
    const withEvents = render(headerSpans(), "span-header");
    expect(withEvents).toContain("tool.called");

    const bare = headerSpans();
    bare.spans[0].events = [];
    const withoutEvents = render(bare, "span-header");
    expect(withoutEvents).toContain(">Events 0</button>");
    expect(withoutEvents).toContain("No events were recorded on this span.");
  });

  it("keeps Phoenix-only affordances out of the pane", () => {
    const html = render(headerSpans(), "span-header");
    for (const absent of ["Annotate", "Playground", "Add to Dataset", "Notes"]) {
      expect(html).not.toContain(absent);
    }
  });
});

describe("formatSpanStartTime", () => {
  it("formats a nano timestamp as a locale date and 12-hour clock", () => {
    expect(formatSpanStartTime("1787000000000000000")).toMatch(
      /^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2} [AP]M$/,
    );
  });

  it("returns null rather than inventing a time for missing or unparseable input", () => {
    expect(formatSpanStartTime(null)).toBeNull();
    expect(formatSpanStartTime("   ")).toBeNull();
    expect(formatSpanStartTime("not-a-number")).toBeNull();
  });
});
