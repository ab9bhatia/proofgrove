import { describe, expect, it } from "vitest";

import type {
  ArchivedTraceSpan,
  CapturedTraceSummary,
  CapturedTracesPage,
  IndexedSpanSummary,
  IndexedSpansPage,
} from "@/lib/api";
import {
  appendSpansPage,
  appendTracesPage,
  canLoadMoreSpans,
  groupTracingResults,
  inspectorLayout,
  emptySpansPageState,
  readTraceSelection,
  spanTraceHref,
  spansCountLabel,
  writeTraceSelection,
  archivedSpanLabel,
  canLoadMoreTraces,
  emptyTracesPageState,
  resolveSelectedSpanId,
  spanBarMetrics,
  spanDepth,
  spanHasError,
  spanKindLabel,
  spanSelectionQuery,
  spanTokenCount,
  traceLifecycleChip,
  traceLlmTokenHint,
  traceSpanEmptyMessage,
  traceOpenHref,
  traceRowKey,
  traceWarnings,
  tracesCountLabel,
} from "./trace-workspace";

function trace(overrides: Partial<CapturedTraceSummary> = {}): CapturedTraceSummary {
  return {
    project_id: "p",
    trace_id: "t1",
    trace_provider: null,
    run_id: "r1",
    run_name: "Baseline",
    run_number: 1,
    example_id: "e1",
    evaluation_name: "eval",
    captured_at: null,
    capture_state: "captured",
    attestation_state: "attested",
    invocation_outcome: "succeeded",
    latency_ms: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cost: null,
    run_status: "completed",
    verdict_status: null,
    overall_gate: null,
    ...overrides,
  };
}

function page(overrides: Partial<CapturedTracesPage> = {}): CapturedTracesPage {
  return { items: [], next_cursor: null, has_more: false, total: 0, ...overrides };
}

function span(overrides: Partial<ArchivedTraceSpan> = {}): ArchivedTraceSpan {
  return {
    trace_id: "t1",
    span_id: "s1",
    parent_span_id: null,
    name: "root",
    kind: null,
    start_time_unix_nano: null,
    end_time_unix_nano: null,
    duration_ms: null,
    status: null,
    attributes: {},
    resource_attributes: {},
    events: [],
    ...overrides,
  };
}

describe("appendTracesPage + pagination", () => {
  it("reports an honest N of M and keeps advancing while a cursor remains", () => {
    const first = appendTracesPage(
      emptyTracesPageState(),
      page({ items: [trace({ trace_id: "t1" }), trace({ trace_id: "t2" })], next_cursor: "c2", has_more: true, total: 5, hidden_count: 3 }),
      true,
    );
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe("c2");
    expect(first.hiddenCount).toBe(3);
    expect(canLoadMoreTraces(first)).toBe(true);
    expect(tracesCountLabel(first.items.length, first.total)).toBe("Showing 2 of 5 traces");
  });

  it("appends the next page and de-duplicates a re-emitted boundary row", () => {
    const first = appendTracesPage(emptyTracesPageState(), page({ items: [trace({ trace_id: "t1" }), trace({ trace_id: "t2" })], next_cursor: "c2", has_more: true, total: 4 }), true);
    const second = appendTracesPage(first, page({ items: [trace({ trace_id: "t2" }), trace({ trace_id: "t3" }), trace({ trace_id: "t4" })], next_cursor: null, has_more: false, total: 4 }));
    expect(second.items.map((t) => t.trace_id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(second.hasMore).toBe(false);
    expect(canLoadMoreTraces(second)).toBe(false);
    expect(tracesCountLabel(second.items.length, second.total)).toBe("Showing 4 of 4 traces");
  });

  it("disables Load more when has_more is false even with a stray cursor absent", () => {
    const state = appendTracesPage(emptyTracesPageState(), page({ items: [trace()], next_cursor: null, has_more: false, total: 1 }), true);
    expect(canLoadMoreTraces(state)).toBe(false);
    expect(tracesCountLabel(1, 1)).toBe("Showing 1 of 1 trace");
  });

  it("distinguishes rows of the same trace across cases", () => {
    expect(traceRowKey({ trace_id: "t", example_id: "a" })).not.toBe(traceRowKey({ trace_id: "t", example_id: "b" }));
  });
});

describe("groupTracingResults", () => {
  it("groups traces by evaluation name and then distinct run identity", () => {
    const groups = groupTracingResults([
      trace({ trace_id: "t1", evaluation_name: "Support quality", run_id: "r1", run_name: "Baseline" }),
      trace({ trace_id: "t2", evaluation_name: "Support quality", run_id: "r2", run_name: "Candidate", run_number: 2 }),
      trace({ trace_id: "t3", evaluation_name: "Support quality", run_id: "r1", run_name: "Baseline" }),
      trace({ trace_id: "t4", evaluation_name: "Safety", run_id: "r3", run_name: "Release" }),
    ]);

    expect(groups.map((group) => [group.evaluationName, group.itemCount])).toEqual([
      ["Support quality", 3],
      ["Safety", 1],
    ]);
    expect(groups[0].runs.map((run) => [run.runIdLabel, run.items.map((item) => item.trace_id)])).toEqual([
      ["r1", ["t1", "t3"]],
      ["r2", ["t2"]],
    ]);
  });

  it("uses an explicit fallback only when a run ID is not recorded", () => {
    const groups = groupTracingResults([
      indexedSpan({ trace_id: "unlinked", run_id: null, run_name: null, run_number: null, evaluation_name: null }),
      indexedSpan({ trace_id: "legacy", run_id: "legacy-run", run_name: null, run_number: null }),
    ]);

    expect(groups[0].evaluationName).toBe("Not linked to an evaluation");
    expect(groups[0].runs[0].runIdLabel).toBe("Not linked to a run");
    expect(groups[1].runs[0].runIdLabel).toBe("legacy-run");
  });
});

describe("resolveSelectedSpanId + URL selection", () => {
  const spans = [span({ span_id: "root", parent_span_id: null }), span({ span_id: "child", parent_span_id: "root" })];

  it("keeps a requested span that exists", () => {
    expect(resolveSelectedSpanId(spans, "child")).toBe("child");
  });

  it("falls back to the root span when the requested id is stale or absent", () => {
    expect(resolveSelectedSpanId(spans, "gone")).toBe("root");
    expect(resolveSelectedSpanId(spans, null)).toBe("root");
  });

  it("returns empty when there are no spans", () => {
    expect(resolveSelectedSpanId([], "anything")).toBe("");
  });

  it("writes the span id to the URL param and restores it round-trip", () => {
    const written = spanSelectionQuery("", "child");
    expect(new URLSearchParams(written).get("span")).toBe("child");
    // Restoring: the param drives resolveSelectedSpanId back to the same span.
    expect(resolveSelectedSpanId(spans, new URLSearchParams(written).get("span"))).toBe("child");
  });

  it("preserves other existing params when selecting a span", () => {
    const written = spanSelectionQuery("view=trace", "child");
    const params = new URLSearchParams(written);
    expect(params.get("view")).toBe("trace");
    expect(params.get("span")).toBe("child");
  });

  it("computes cycle-guarded depth", () => {
    expect(spanDepth(spans, spans[0])).toBe(0);
    expect(spanDepth(spans, spans[1])).toBe(1);
  });
});

describe("archivedSpanLabel (truthful span count)", () => {
  it("shows a real count, including a truthful zero, only after a successful load", () => {
    expect(archivedSpanLabel(0, false, null)).toBe("0");
    expect(archivedSpanLabel(3, false, null)).toBe("3");
  });

  it("never renders a loading or failed archive as an empty result", () => {
    // In flight: nullable count, still loading.
    expect(archivedSpanLabel(null, true, null)).toBe("Checking…");
    // Failed: nullable count with an error message.
    expect(archivedSpanLabel(null, false, "boom")).toBe("Unavailable");
    // Loading wins over a stale error while a retry is in flight.
    expect(archivedSpanLabel(null, true, "boom")).toBe("Checking…");
  });

  it("falls back without asserting empty when no signal is available", () => {
    expect(archivedSpanLabel(null, false, null)).toBe("Not recorded");
  });
});

describe("spanBarMetrics (proportional latency bars)", () => {
  it("computes proportional offset and width against the trace window", () => {
    const spans = [
      span({ span_id: "root", start_time_unix_nano: "1000000000", end_time_unix_nano: "1100000000" }),
      span({ span_id: "child", parent_span_id: "root", start_time_unix_nano: "1025000000", end_time_unix_nano: "1075000000" }),
    ];
    const [root, child] = spanBarMetrics(spans);
    expect(root).toEqual({ offsetPct: 0, widthPct: 100 });
    expect(child).toEqual({ offsetPct: 25, widthPct: 50 });
  });

  it("handles nanosecond epoch values beyond Number precision", () => {
    // Real OTLP nanos exceed 2^53; percentages must still be exact.
    const spans = [
      span({ span_id: "a", start_time_unix_nano: "1712345678000000000", end_time_unix_nano: "1712345679000000000" }),
      span({ span_id: "b", start_time_unix_nano: "1712345678500000000", end_time_unix_nano: "1712345679000000000" }),
    ];
    const [a, b] = spanBarMetrics(spans);
    expect(a).toEqual({ offsetPct: 0, widthPct: 100 });
    expect(b).toEqual({ offsetPct: 50, widthPct: 50 });
  });

  it("gives a single-span trace the full width", () => {
    const only = spanBarMetrics([
      span({ span_id: "solo", start_time_unix_nano: "5", end_time_unix_nano: "10" }),
    ]);
    expect(only).toEqual([{ offsetPct: 0, widthPct: 100 }]);
  });

  it("returns an exact zero width for a zero-duration span in a real window", () => {
    const [, instant] = spanBarMetrics([
      span({ span_id: "root", start_time_unix_nano: "0", end_time_unix_nano: "100" }),
      span({ span_id: "instant", start_time_unix_nano: "40", end_time_unix_nano: "40" }),
    ]);
    expect(instant).toEqual({ offsetPct: 40, widthPct: 0 });
  });

  it("treats a zero-width trace window as full-width, zero-offset bars", () => {
    const bars = spanBarMetrics([
      span({ span_id: "a", start_time_unix_nano: "7", end_time_unix_nano: "7" }),
      span({ span_id: "b", start_time_unix_nano: "7", end_time_unix_nano: "7" }),
    ]);
    expect(bars).toEqual([
      { offsetPct: 0, widthPct: 100 },
      { offsetPct: 0, widthPct: 100 },
    ]);
  });

  it("renders no bar (null) for spans with missing or malformed timestamps", () => {
    const bars = spanBarMetrics([
      span({ span_id: "ok", start_time_unix_nano: "0", end_time_unix_nano: "100" }),
      span({ span_id: "missing", start_time_unix_nano: null, end_time_unix_nano: null }),
      span({ span_id: "half", start_time_unix_nano: "10", end_time_unix_nano: null }),
      span({ span_id: "reversed", start_time_unix_nano: "90", end_time_unix_nano: "10" }),
      span({ span_id: "garbage", start_time_unix_nano: "not-a-number", end_time_unix_nano: "100" }),
    ]);
    expect(bars[0]).toEqual({ offsetPct: 0, widthPct: 100 });
    expect(bars.slice(1)).toEqual([null, null, null, null]);
  });

  it("falls back to duration-magnitude bars only when no span has timestamps", () => {
    const bars = spanBarMetrics([
      span({ span_id: "long", duration_ms: 200 }),
      span({ span_id: "short", duration_ms: 50 }),
      span({ span_id: "unknown", duration_ms: null }),
    ]);
    expect(bars[0]).toEqual({ offsetPct: 0, widthPct: 100 });
    expect(bars[1]).toEqual({ offsetPct: 0, widthPct: 25 });
    expect(bars[2]).toBeNull();
  });

  it("never fabricates a bar when durations are all zero or missing", () => {
    expect(spanBarMetrics([span({ duration_ms: null })])).toEqual([null]);
    expect(spanBarMetrics([span({ span_id: "z", duration_ms: 0 })])).toEqual([{ offsetPct: 0, widthPct: 0 }]);
    expect(spanBarMetrics([])).toEqual([]);
  });
});

describe("spanKindLabel (honest kind chip)", () => {
  it("prefers the semantic openinference kind attribute", () => {
    expect(spanKindLabel(span({ kind: 2, attributes: { "openinference.span.kind": "LLM" } }))).toBe("llm");
  });

  it("maps OTLP numeric kinds", () => {
    expect(spanKindLabel(span({ kind: 1 }))).toBe("internal");
    expect(spanKindLabel(span({ kind: 2 }))).toBe("server");
    expect(spanKindLabel(span({ kind: 3 }))).toBe("client");
    expect(spanKindLabel(span({ kind: 4 }))).toBe("producer");
    expect(spanKindLabel(span({ kind: 5 }))).toBe("consumer");
  });

  it("returns null for absent, unspecified, or unknown kinds — no chip", () => {
    expect(spanKindLabel(span({ kind: null }))).toBeNull();
    expect(spanKindLabel(span({ kind: 0 }))).toBeNull();
    expect(spanKindLabel(span({ kind: 99 }))).toBeNull();
    expect(spanKindLabel(span({ kind: null, attributes: { "openinference.span.kind": "  " } }))).toBeNull();
  });
});

describe("spanHasError (status dot)", () => {
  it("recognises OTLP error status codes in numeric and string forms", () => {
    expect(spanHasError(span({ status: { code: 2 } }))).toBe(true);
    expect(spanHasError(span({ status: { code: "2" } }))).toBe(true);
    expect(spanHasError(span({ status: { code: "STATUS_CODE_ERROR" } }))).toBe(true);
    expect(spanHasError(span({ status: { code: "ERROR" } }))).toBe(true);
  });

  it("flags spans carrying an exception event", () => {
    expect(spanHasError(span({ events: [{ name: "exception" }] }))).toBe(true);
  });

  it("stays quiet for ok/unset/absent status", () => {
    expect(spanHasError(span({ status: null }))).toBe(false);
    expect(spanHasError(span({ status: { code: 1 } }))).toBe(false);
    expect(spanHasError(span({ status: { code: "STATUS_CODE_OK" } }))).toBe(false);
    expect(spanHasError(span({ status: { code: "STATUS_CODE_UNSET" } }))).toBe(false);
    expect(spanHasError(span({ events: [{ name: "retry" }] }))).toBe(false);
  });
});

describe("spanTokenCount (per-item token counts)", () => {
  it("reads gen_ai and openinference token attributes, number or numeric string", () => {
    expect(spanTokenCount(span({ attributes: { "gen_ai.usage.total_tokens": 123 } }))).toBe(123);
    expect(spanTokenCount(span({ attributes: { "llm.token_count.total": "456" } }))).toBe(456);
  });

  it("returns null when absent or non-numeric — nothing is shown", () => {
    expect(spanTokenCount(span())).toBeNull();
    expect(spanTokenCount(span({ attributes: { "gen_ai.usage.total_tokens": "lots" } }))).toBeNull();
    expect(spanTokenCount(span({ attributes: { "gen_ai.usage.total_tokens": -1 } }))).toBeNull();
  });
});

describe("traceLlmTokenHint (trace-level aggregation)", () => {
  it("sums only generation spans, never tool executions", () => {
    expect(
      traceLlmTokenHint([
        span({
          span_id: "llm",
          name: "invoke",
          attributes: {
            "openinference.span.kind": "LLM",
            "gen_ai.operation.name": "chat",
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 10,
          },
        }),
        span({
          span_id: "tool",
          name: "lookup_policy",
          attributes: {
            "openinference.span.kind": "TOOL",
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.usage.input_tokens": 900,
          },
        }),
      ]),
    ).toBe("100 prompt · 10 completion");
  });

  it("returns null when no generation span records counts", () => {
    expect(traceLlmTokenHint([span({ attributes: { "gen_ai.operation.name": "execute_tool" } })])).toBeNull();
  });

  it("aggregates leaf LLM spans only, avoiding nested double-count", () => {
    expect(
      traceLlmTokenHint([
        span({
          span_id: "parent",
          name: "agent.run",
          attributes: {
            "openinference.span.kind": "LLM",
            "gen_ai.operation.name": "chat",
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 10,
            "gen_ai.usage.total_tokens": 110,
          },
        }),
        span({
          span_id: "child",
          parent_span_id: "parent",
          name: "ChatCompletion",
          attributes: {
            "openinference.span.kind": "LLM",
            "gen_ai.usage.input_tokens": 50,
            "gen_ai.usage.output_tokens": 5,
            "gen_ai.usage.total_tokens": 55,
          },
        }),
      ]),
    ).toBe("50 prompt · 5 completion · 55 total");
  });

  it("de-dupes an LLM nested under a non-LLM span inside another LLM", () => {
    // LLM → chain → LLM: a direct parent/child check missed this and summed
    // the wrapper's usage on top of the call it already includes.
    expect(
      traceLlmTokenHint([
        span({
          span_id: "outer",
          name: "agent.run",
          attributes: {
            "openinference.span.kind": "LLM",
            "gen_ai.operation.name": "chat",
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 10,
            "gen_ai.usage.total_tokens": 110,
          },
        }),
        span({
          span_id: "chain",
          parent_span_id: "outer",
          name: "plan",
          attributes: { "openinference.span.kind": "CHAIN" },
        }),
        span({
          span_id: "inner",
          parent_span_id: "chain",
          name: "ChatCompletion",
          attributes: {
            "openinference.span.kind": "LLM",
            "gen_ai.usage.input_tokens": 50,
            "gen_ai.usage.output_tokens": 5,
            "gen_ai.usage.total_tokens": 55,
          },
        }),
      ]),
    ).toBe("50 prompt · 5 completion · 55 total");
  });

  it("drops a total drawn from different spans than the parts", () => {
    // One call reports only a total, another only parts: "100 prompt ·
    // 50 completion · 3000 total" would read as if the parts summed to 3000.
    expect(
      traceLlmTokenHint([
        span({
          span_id: "a",
          name: "ChatCompletion",
          attributes: {
            "openinference.span.kind": "LLM",
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 50,
          },
        }),
        span({
          span_id: "b",
          name: "ChatCompletion",
          attributes: { "openinference.span.kind": "LLM", "gen_ai.usage.total_tokens": 3000 },
        }),
      ]),
    ).toBe("100 prompt · 50 completion · totals not reported by every call");
  });

  it("marks a sum that only part of the LLM calls reported", () => {
    expect(
      traceLlmTokenHint([
        span({
          span_id: "a",
          name: "ChatCompletion",
          attributes: {
            "openinference.span.kind": "LLM",
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 50,
            "gen_ai.usage.total_tokens": 150,
          },
        }),
        span({ span_id: "b", name: "ChatCompletion", attributes: { "openinference.span.kind": "LLM" } }),
        span({ span_id: "c", name: "ChatCompletion", attributes: { "openinference.span.kind": "LLM" } }),
      ]),
    ).toBe("100 prompt · 50 completion · 150 total · usage from 1 of 3 LLM calls");
  });

  it("scans a deep trace without a quadratic child lookup", () => {
    // 4000 spans: a `spans.some(...)` inside the per-span loop made this
    // 16M comparisons. Guard the complexity, not just the result.
    const deep = Array.from({ length: 4000 }, (_, index) =>
      span({
        span_id: `s${index}`,
        parent_span_id: index === 0 ? null : `s${index - 1}`,
        name: index % 2 === 0 ? "ChatCompletion" : "chain.step",
        attributes: {
          "openinference.span.kind": index % 2 === 0 ? "LLM" : "CHAIN",
          ...(index === 3998 ? { "gen_ai.usage.input_tokens": 7, "gen_ai.usage.output_tokens": 3 } : {}),
        },
      }),
    );
    const started = Date.now();
    const hint = traceLlmTokenHint(deep);
    expect(Date.now() - started).toBeLessThan(1000);
    // Only the innermost LLM span counts; every LLM ancestor is shadowed.
    expect(hint).toBe("7 prompt · 3 completion");
  });
});

describe("traceWarnings (honest partial-capture band)", () => {
  it("is empty for a clean, attested, successful trace", () => {
    expect(traceWarnings(trace())).toEqual([]);
  });

  it("surfaces partial capture and unknown attestation", () => {
    const warnings = traceWarnings(trace({ capture_state: "partial", attestation_state: "unknown" }));
    const ids = warnings.map((w) => w.id);
    expect(ids).toContain("capture");
    expect(ids).toContain("attestation");
    expect(warnings.find((w) => w.id === "capture")?.label).toBe("Partial capture");
  });

  it("flags a failed invocation as an error", () => {
    const warnings = traceWarnings(trace({ invocation_outcome: "error" }));
    expect(warnings.find((w) => w.id === "invocation")?.tone).toBe("error");
  });
});

describe("traceRowKey (non-evaluation index rows)", () => {
  it("stays stable when the index row has no case id", () => {
    expect(traceRowKey(trace({ example_id: null }))).toBe("t1::");
    expect(traceRowKey(trace())).toBe("t1::e1");
  });
});

describe("traceOpenHref (honest navigation targets)", () => {
  it("links evaluation traces to their case-backed detail page", () => {
    expect(traceOpenHref("proj-1", trace())).toBe("/projects/proj-1/traces/t1");
  });

  it("links non-evaluation index rows to the trace viewer", () => {
    expect(traceOpenHref("proj-1", trace({ run_id: null }))).toBe("/projects/proj-1/traces/t1");
  });

  it("links Unassigned traces to the trace viewer", () => {
    expect(traceOpenHref("unassigned", trace())).toBe("/projects/unassigned/traces/t1");
  });
});

describe("traceLifecycleChip (collector-confirmed states)", () => {
  it("maps each honest lifecycle state to its own copy and tone", () => {
    expect(traceLifecycleChip("requested")).toMatchObject({ label: "Requested", tone: "neutral" });
    expect(traceLifecycleChip("pending_export")).toMatchObject({ label: "Pending export", tone: "warn" });
    expect(traceLifecycleChip("archive_confirmed")).toMatchObject({ label: "Archived", tone: "pass" });
    expect(traceLifecycleChip("archive_unavailable")).toMatchObject({
      label: "Archive unavailable",
      tone: "fail",
    });
  });

  it("explains pending export without claiming spans exist", () => {
    expect(traceLifecycleChip("pending_export")?.detail).toContain("no spans have landed");
  });

  it("returns null for legacy rows without a lifecycle — nothing is invented", () => {
    expect(traceLifecycleChip(undefined)).toBeNull();
    expect(traceLifecycleChip(null)).toBeNull();
  });
});

describe("traceSpanEmptyMessage", () => {
  it("prefers the archive lookup state over the legacy summary placeholder", () => {
    expect(
      traceSpanEmptyMessage(
        "Trace export may still be in flight.",
        "Archived OpenTelemetry spans are not available through this service yet.",
      ),
    ).toBe("Trace export may still be in flight.");
  });
});

describe("trace drawer selection URL round-trip", () => {
  it("writes trace and span params and restores them", () => {
    const written = writeTraceSelection("status=error&search=x", { trace: "t-9", span: "s-3" });
    const params = new URLSearchParams(written);
    expect(params.get("trace")).toBe("t-9");
    expect(params.get("span")).toBe("s-3");
    // Unrelated filter params survive the selection write.
    expect(params.get("status")).toBe("error");
    expect(params.get("search")).toBe("x");
    expect(readTraceSelection(params)).toEqual({ trace: "t-9", span: "s-3" });
  });

  it("clearing the trace also clears the span (Escape/close semantics)", () => {
    const opened = writeTraceSelection("", { trace: "t-9", span: "s-3" });
    const closed = new URLSearchParams(writeTraceSelection(opened, { trace: null, span: null }));
    expect(closed.has("trace")).toBe(false);
    expect(closed.has("span")).toBe(false);
  });

  it("never reports a span selection without an open trace", () => {
    expect(readTraceSelection(new URLSearchParams("span=s-3"))).toEqual({ trace: null, span: null });
    const written = writeTraceSelection("span=s-3", { trace: null, span: "s-3" });
    expect(new URLSearchParams(written).has("span")).toBe(false);
  });
});

function indexedSpan(overrides: Partial<IndexedSpanSummary> = {}): IndexedSpanSummary {
  return {
    project_id: "p",
    trace_id: "t1",
    run_id: "r1",
    run_name: "Baseline",
    run_number: 1,
    evaluation_name: "Support quality",
    span_id: "s1",
    parent_span_id: null,
    name: "agent.run",
    kind: "llm",
    semantic_kind: "llm",
    input_preview: null,
    output_preview: null,
    llm_token_count_prompt: null,
    llm_token_count_completion: null,
    estimated_cost_usd: null,
    started_at: "2026-08-01T10:00:00Z",
    duration_ms: 12.5,
    status: "ok",
    ...overrides,
  };
}

function spansPage(overrides: Partial<IndexedSpansPage> = {}): IndexedSpansPage {
  return { items: [], next_cursor: null, has_more: false, total: 0, ...overrides };
}

describe("spans tab paging state", () => {
  it("appends pages, de-duplicating on the trace+span key", () => {
    const first = appendSpansPage(
      emptySpansPageState(),
      spansPage({ items: [indexedSpan(), indexedSpan({ span_id: "s2" })], next_cursor: "c1", has_more: true, total: 3 }),
      true,
    );
    const second = appendSpansPage(
      first,
      spansPage({ items: [indexedSpan({ span_id: "s2" }), indexedSpan({ span_id: "s3" })], total: 3 }),
    );
    expect(second.items.map((item) => item.span_id)).toEqual(["s1", "s2", "s3"]);
    expect(second.hasMore).toBe(false);
    expect(canLoadMoreSpans(second)).toBe(false);
    expect(canLoadMoreSpans(first)).toBe(true);
  });

  it("reset replaces the accumulated list", () => {
    const first = appendSpansPage(emptySpansPageState(), spansPage({ items: [indexedSpan()], total: 1 }), true);
    const reset = appendSpansPage(first, spansPage({ items: [indexedSpan({ span_id: "s9" })], total: 1 }), true);
    expect(reset.items.map((item) => item.span_id)).toEqual(["s9"]);
  });

  it("labels the honest showing count", () => {
    expect(spansCountLabel(1, 1)).toBe("Showing 1 of 1 span");
    expect(spansCountLabel(2, 50)).toBe("Showing 2 of 50 spans");
  });
});

describe("spanTraceHref", () => {
  it("links a span row to its same-page drawer selection", () => {
    expect(spanTraceHref("proj 1", "trace/1", "span/1", "status=error")).toBe(
      "/projects/proj%201/spans?status=error&trace=trace%2F1&span=span%2F1",
    );
  });
});

describe("inspectorLayout", () => {
  it("keeps flow panes document-scrolled with capped tree and scores", () => {
    const layout = inspectorLayout("flow");
    expect(layout.grid).toBe("");
    expect(layout.section).toBe("");
    expect(layout.tree).toContain("max-h-[28rem]");
    expect(layout.detail).toBe("");
  });

  it("caps page panes at the viewport rather than pinning them to it", () => {
    const layout = inspectorLayout("page");
    // A ceiling, not a height. Pinning the grid to the viewport with a 30rem
    // floor meant a two-span trace stretched both panes down the whole screen
    // and the reader scrolled past empty panes to reach anything below.
    expect(layout.grid).toContain("lg:max-h-[calc(100vh-8rem)]");
    expect(layout.grid).not.toContain("lg:h-[calc(100vh-8rem)]");
    expect(layout.grid).not.toContain("min-h-[30rem]");
    expect(layout.section).toContain("lg:min-h-0");
    expect(layout.section).toContain("lg:flex-col");
    for (const pane of [layout.tree, layout.detail]) {
      expect(pane).toContain("lg:min-h-0");
      expect(pane).toContain("lg:flex-1");
    }
    // Fixed caps must not survive on lg — the pane's height bounds it instead.
    expect(layout.tree).toContain("lg:max-h-none");
  });
});
