import { describe, expect, it } from "vitest";

import type { ArchivedTraceSpan } from "@/lib/api";
import {
  INITIAL_SPAN_RENDER_CAP,
  cappedSpanRows,
  defaultExpandedSpanIds,
  expandSpanAncestors,
  filterSpanRows,
  friendlySpanName,
  isInfraSpan,
  spanCapExpandLabel,
  spanKindChip,
  spanMatchCountLabel,
  spanTreeEmptyLabel,
  spanTreeKeyAction,
  spanTreeRows,
  toggleSpanExpanded,
  visibleSpanRows,
  type SpanTreeRow,
} from "./span-tree";

describe("friendlySpanName", () => {
  it("keeps the last two dot segments while ellipsizing the prefix", () => {
    expect(friendlySpanName("openinference.instrumentation.langchain.chain.invoke"))
      .toBe("openinference.…chain.invoke");
    expect(friendlySpanName("chain.invoke")).toBe("chain.invoke");
  });
});

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

/** root ─ a ─ a1, a ─ a2, root ─ b (flat input, arbitrary order). */
function sampleSpans(): ArchivedTraceSpan[] {
  return [
    span({ span_id: "root", name: "root" }),
    span({ span_id: "b", parent_span_id: "root", name: "b" }),
    span({ span_id: "a", parent_span_id: "root", name: "a" }),
    span({ span_id: "a1", parent_span_id: "a", name: "a1" }),
    span({ span_id: "a2", parent_span_id: "a", name: "a2" }),
  ];
}

const ids = (rows: SpanTreeRow[]) => rows.map((row) => row.span.span_id);

describe("spanTreeRows", () => {
  it("orders rows depth-first with children under their parent", () => {
    const rows = spanTreeRows(sampleSpans());
    expect(ids(rows)).toEqual(["root", "b", "a", "a1", "a2"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 2, 2]);
  });

  it("marks parents and records the parent id", () => {
    const rows = spanTreeRows(sampleSpans());
    const byId = new Map(rows.map((row) => [row.span.span_id, row]));
    expect(byId.get("root")?.hasChildren).toBe(true);
    expect(byId.get("a")?.hasChildren).toBe(true);
    expect(byId.get("a1")?.hasChildren).toBe(false);
    expect(byId.get("a1")?.parentId).toBe("a");
    expect(byId.get("root")?.parentId).toBeNull();
  });

  it("marks last children so the renderer can draw mid and terminal elbows", () => {
    const byId = new Map(spanTreeRows(sampleSpans()).map((row) => [row.span.span_id, row]));
    expect(byId.get("b")?.isLastChild).toBe(false);
    expect(byId.get("a")?.isLastChild).toBe(true);
    expect(byId.get("a1")?.isLastChild).toBe(false);
    expect(byId.get("a2")?.isLastChild).toBe(true);
  });

  it("treats orphans (missing parent) as roots instead of dropping them", () => {
    const rows = spanTreeRows([span({ span_id: "x", parent_span_id: "missing" })]);
    expect(ids(rows)).toEqual(["x"]);
    expect(rows[0].depth).toBe(0);
  });

  it("survives parent cycles without losing spans", () => {
    const rows = spanTreeRows([
      span({ span_id: "a", parent_span_id: "b" }),
      span({ span_id: "b", parent_span_id: "a" }),
    ]);
    expect(ids(rows).sort()).toEqual(["a", "b"]);
  });

  it("ignores a self-parenting span's bogus edge", () => {
    const rows = spanTreeRows([span({ span_id: "a", parent_span_id: "a" })]);
    expect(ids(rows)).toEqual(["a"]);
    expect(rows[0].depth).toBe(0);
  });
});

describe("expand/collapse state", () => {
  it("defaults to parents above depth 2 expanded, deeper parents collapsed", () => {
    const deep = [
      span({ span_id: "d0" }),
      span({ span_id: "d1", parent_span_id: "d0" }),
      span({ span_id: "d2", parent_span_id: "d1" }),
      span({ span_id: "d3", parent_span_id: "d2" }),
      span({ span_id: "d4", parent_span_id: "d3" }),
    ];
    const rows = spanTreeRows(deep);
    const expanded = defaultExpandedSpanIds(rows);
    expect(expanded.has("d0")).toBe(true);
    expect(expanded.has("d1")).toBe(true);
    expect(expanded.has("d2")).toBe(false); // depth-2 parent stays collapsed
    // Leaves are never in the expanded set.
    expect(expanded.has("d4")).toBe(false);
    const visible = visibleSpanRows(rows, expanded);
    expect(ids(visible)).toEqual(["d0", "d1", "d2"]);
  });

  it("hides the whole subtree of a collapsed parent", () => {
    const rows = spanTreeRows(sampleSpans());
    const expanded = toggleSpanExpanded(defaultExpandedSpanIds(rows), "a");
    const visible = visibleSpanRows(rows, expanded);
    expect(ids(visible)).toEqual(["root", "b", "a"]);
  });

  it("toggle round-trips", () => {
    const rows = spanTreeRows(sampleSpans());
    const initial = defaultExpandedSpanIds(rows);
    const reopened = toggleSpanExpanded(toggleSpanExpanded(initial, "a"), "a");
    expect(ids(visibleSpanRows(rows, reopened))).toEqual(ids(visibleSpanRows(rows, initial)));
  });

  it("expandSpanAncestors reveals a deep selection and is a no-op when already visible", () => {
    const rows = spanTreeRows(sampleSpans());
    const collapsed = new Set<string>();
    const expanded = expandSpanAncestors(rows, collapsed, "a1");
    expect(expanded.has("root")).toBe(true);
    expect(expanded.has("a")).toBe(true);
    expect(ids(visibleSpanRows(rows, expanded))).toContain("a1");
    // Already visible → same set instance back (no state churn).
    expect(expandSpanAncestors(rows, expanded, "a1")).toBe(expanded);
  });
});

describe("spanTreeKeyAction (ARIA tree pattern)", () => {
  const rows = spanTreeRows(sampleSpans());
  const expanded = defaultExpandedSpanIds(rows);
  const visible = visibleSpanRows(rows, expanded); // root, b, a, a1, a2

  it("moves selection with ArrowUp/ArrowDown and clamps at the ends", () => {
    expect(spanTreeKeyAction(visible, 0, "ArrowDown", expanded)).toEqual({ type: "move", index: 1 });
    expect(spanTreeKeyAction(visible, 0, "ArrowUp", expanded)).toEqual({ type: "none" });
    expect(spanTreeKeyAction(visible, visible.length - 1, "ArrowDown", expanded)).toEqual({ type: "none" });
    expect(spanTreeKeyAction(visible, 3, "Home", expanded)).toEqual({ type: "move", index: 0 });
    expect(spanTreeKeyAction(visible, 0, "End", expanded)).toEqual({ type: "move", index: visible.length - 1 });
  });

  it("ArrowRight expands a collapsed parent, then steps into the first child", () => {
    const collapsed = toggleSpanExpanded(expanded, "a");
    const collapsedVisible = visibleSpanRows(rows, collapsed); // root, b, a
    expect(spanTreeKeyAction(collapsedVisible, 2, "ArrowRight", collapsed)).toEqual({ type: "expand", id: "a" });
    // Expanded parent: ArrowRight moves to the first child (the next visible row).
    expect(spanTreeKeyAction(visible, 2, "ArrowRight", expanded)).toEqual({ type: "move", index: 3 });
    // Leaf: nothing.
    expect(spanTreeKeyAction(visible, 3, "ArrowRight", expanded)).toEqual({ type: "none" });
  });

  it("ArrowLeft collapses an expanded parent, otherwise jumps to the parent row", () => {
    expect(spanTreeKeyAction(visible, 2, "ArrowLeft", expanded)).toEqual({ type: "collapse", id: "a" });
    // Leaf → parent row index.
    expect(spanTreeKeyAction(visible, 3, "ArrowLeft", expanded)).toEqual({ type: "move", index: 2 });
    // Expanded root collapses; an already-collapsed root has no parent → none.
    expect(spanTreeKeyAction(visible, 0, "ArrowLeft", expanded)).toEqual({ type: "collapse", id: "root" });
    const rootCollapsed = toggleSpanExpanded(expanded, "root");
    const onlyRoot = visibleSpanRows(rows, rootCollapsed);
    expect(spanTreeKeyAction(onlyRoot, 0, "ArrowLeft", rootCollapsed)).toEqual({ type: "none" });
  });

  it("returns none for unrelated keys", () => {
    expect(spanTreeKeyAction(visible, 0, "Enter", expanded)).toEqual({ type: "none" });
  });
});

describe("cappedSpanRows", () => {
  const many = spanTreeRows(
    Array.from({ length: INITIAL_SPAN_RENDER_CAP + 25 }, (_, i) => span({ span_id: `s${i}` })),
  );

  it("caps the initial render and reports the honest hidden count", () => {
    const { rows, hiddenCount } = cappedSpanRows(many, false);
    expect(rows.length).toBe(INITIAL_SPAN_RENDER_CAP);
    expect(hiddenCount).toBe(25);
  });

  it("shows everything once expanded, and never caps small trees", () => {
    expect(cappedSpanRows(many, true)).toEqual({ rows: many, hiddenCount: 0 });
    const few = many.slice(0, 3);
    expect(cappedSpanRows(few, false)).toEqual({ rows: few, hiddenCount: 0 });
  });
});

describe("spanKindChip", () => {
  it("gives semantic OpenInference kinds their own tone", () => {
    expect(spanKindChip(span({ attributes: { "openinference.span.kind": "AGENT" } }))).toEqual({
      label: "agent",
      tone: "agent",
    });
    expect(spanKindChip(span({ attributes: { "openinference.span.kind": "LLM" } }))).toEqual({ label: "llm", tone: "llm" });
    expect(spanKindChip(span({ attributes: { "openinference.span.kind": "TOOL" } }))).toEqual({ label: "tool", tone: "tool" });
    expect(spanKindChip(span({ attributes: { "openinference.span.kind": "CHAIN" } }))).toEqual({ label: "chain", tone: "chain" });
    expect(spanKindChip(span({ attributes: { "openinference.span.kind": "RETRIEVER" } }))).toEqual({
      label: "retriever",
      tone: "retriever",
    });
  });

  it("does not invent AI types from names, OTLP kinds, or GenAI attributes", () => {
    for (const entry of [span(), span({ kind: 3 }), span({ name: "call_llm" }),
      span({ attributes: { "gen_ai.operation.name": "chat", "gen_ai.usage.total_tokens": 42 } })]) {
      expect(spanKindChip(entry)).toEqual({ label: "span", tone: "muted" });
    }
  });
});


describe("isInfraSpan", () => {
  it("flags any server/client/producer/consumer without openinference kind", () => {
    const spans = [
      span({
        span_id: "http",
        name: "POST /",
        kind: 2, // SERVER
        attributes: {},
      }),
      span({
        span_id: "chain",
        parent_span_id: "http",
        name: "agent",
        attributes: { "openinference.span.kind": "CHAIN" },
      }),
      span({
        span_id: "llm",
        parent_span_id: "chain",
        name: "chat",
        attributes: { "openinference.span.kind": "LLM" },
      }),
      span({
        span_id: "client",
        name: "outbound",
        kind: 3, // CLIENT
        attributes: {},
      }),
      span({
        span_id: "producer",
        name: "publish",
        kind: 4, // PRODUCER
        attributes: {},
      }),
    ];
    const rows = spanTreeRows(spans);
    const byId = new Map(rows.map((row) => [row.span.span_id, row]));
    expect(isInfraSpan(byId.get("http")!, rows)).toBe(true);
    expect(isInfraSpan(byId.get("client")!, rows)).toBe(true);
    expect(isInfraSpan(byId.get("producer")!, rows)).toBe(true);
    expect(isInfraSpan(byId.get("chain")!, rows)).toBe(false);
    expect(isInfraSpan(byId.get("llm")!, rows)).toBe(false);
  });

  it("does not infer AI operations from names or INTERNAL kind", () => {
    const rows = spanTreeRows([
      span({ span_id: "get", name: "GET /v1/chat", kind: 1, attributes: {} }),
      span({ span_id: "grpc", name: "grpc.Unary", kind: null, attributes: {} }),
      span({ span_id: "agent", name: "Support Agent", kind: 1, attributes: {} }),
      span({ span_id: "llm", name: "ChatCompletion", kind: null, attributes: {} }),
      span({ span_id: "leaf", name: "handler", kind: 1, attributes: {} }),
    ]);
    const byId = new Map(rows.map((row) => [row.span.span_id, row]));
    expect(isInfraSpan(byId.get("get")!, rows)).toBe(true);
    expect(isInfraSpan(byId.get("grpc")!, rows)).toBe(true);
    expect(isInfraSpan(byId.get("agent")!, rows)).toBe(true);
    expect(isInfraSpan(byId.get("llm")!, rows)).toBe(true);
    expect(isInfraSpan(byId.get("leaf")!, rows)).toBe(true);
  });

  it("keeps an INTERNAL span when OpenInference supplies its AI type", () => {
    const rows = spanTreeRows([span({ kind: 1, attributes: { "openinference.span.kind": "AGENT" } })]);
    expect(isInfraSpan(rows[0], rows)).toBe(false);
  });

  it("does not infer type from GenAI operations or token fields", () => {
    const rows = spanTreeRows([span({ attributes: { "gen_ai.operation.name": "chat", "gen_ai.usage.total_tokens": 42 } })]);
    expect(isInfraSpan(rows[0], rows)).toBe(true);
  });

  it("preserves AI ancestry across hidden wrappers without changing recorded parent IDs", () => {
    const rows = spanTreeRows([
      span({ span_id: "agent", attributes: { "openinference.span.kind": "AGENT" } }),
      span({ span_id: "wrapper", parent_span_id: "agent" }),
      span({ span_id: "llm", parent_span_id: "wrapper", attributes: { "openinference.span.kind": "LLM" } }),
    ]);
    const filtered = filterSpanRows(rows, { hideInfra: true }).rows;
    expect(ids(filtered)).toEqual(["agent", "llm"]);
    expect(filtered[1].parentId).toBe("agent");
    expect(filtered[1].depth).toBe(1);
    expect(filtered[1].span.parent_span_id).toBe("wrapper");
  });
});

describe("filterSpanRows", () => {
  const fixture = () =>
    spanTreeRows([
      span({
        span_id: "http",
        name: "POST /",
        kind: 2,
        duration_ms: 500,
        attributes: {},
      }),
      span({
        span_id: "chain",
        parent_span_id: "http",
        name: "support.agent",
        duration_ms: 400,
        attributes: { "openinference.span.kind": "CHAIN", "session.id": "abc" },
      }),
      span({
        span_id: "llm",
        parent_span_id: "chain",
        name: "chat.completion",
        duration_ms: 200,
        status: { code: 2 },
        attributes: { "openinference.span.kind": "LLM" },
      }),
      span({
        span_id: "tool",
        parent_span_id: "chain",
        name: "search",
        duration_ms: 50,
        attributes: { "openinference.span.kind": "TOOL" },
      }),
    ]);

  it("matches name and attribute keys/values and keeps the ancestor chain", () => {
    const rows = fixture();
    const { rows: filtered, matchCount, matchedIds } = filterSpanRows(rows, { query: "session.id" });
    expect(matchCount).toBe(1);
    expect([...matchedIds]).toEqual(["chain"]);
    expect(filtered.map((row) => row.span.span_id)).toEqual(["http", "chain"]);
  });

  it("composes kind, status, and duration filters", () => {
    const rows = fixture();
    const { matchedIds, matchCount } = filterSpanRows(rows, {
      kinds: ["llm"],
      status: "error",
      minDurationMs: 100,
    });
    expect(matchCount).toBe(1);
    expect([...matchedIds]).toEqual(["llm"]);

    const okOnly = filterSpanRows(rows, { status: "ok", kinds: ["tool"] });
    expect([...okOnly.matchedIds]).toEqual(["tool"]);
  });

  it("hides infra spans and promotes semantic children", () => {
    const rows = fixture();
    const { rows: filtered, matchedIds } = filterSpanRows(rows, { hideInfra: true });
    expect(filtered.map((row) => row.span.span_id)).toEqual(["chain", "llm", "tool"]);
    expect(matchedIds.has("http")).toBe(false);
    expect(filtered[0].parentId).toBeNull();
  });

  it("skips auto-expanding infra roots by default", () => {
    const rows = fixture();
    const expanded = defaultExpandedSpanIds(filterSpanRows(rows, { hideInfra: true }).rows);
    expect(expanded.has("http")).toBe(false);
    expect(expanded.has("chain")).toBe(true);
  });

  it("reports how many transport spans the infra toggle removed", () => {
    const rows = fixture();
    const hidden = filterSpanRows(rows, { hideInfra: true });
    expect(hidden.matchCount).toBe(3);
    expect(hidden.infraHiddenCount).toBe(1);
    expect(hidden.matchesHiddenByInfra).toBe(0);

    const shown = filterSpanRows(rows, { hideInfra: false });
    expect(shown.matchCount).toBe(4);
    expect(shown.infraHiddenCount).toBe(0);
    expect(shown.matchesHiddenByInfra).toBe(0);
  });
});

describe("spanTreeEmptyLabel", () => {
  it("blames the filter, not the transport toggle, when a search has no hits", () => {
    expect(
      spanTreeEmptyLabel({
        filterActive: true,
        hideInfra: true,
        matchesHiddenByInfra: 0,
        emptyMessage: "No spans were archived for this trace.",
      }),
    ).toBe("No spans match these filters.");
  });

  it("points at the toggle when it hid the only matches", () => {
    expect(
      spanTreeEmptyLabel({
        filterActive: true,
        hideInfra: true,
        matchesHiddenByInfra: 2,
        emptyMessage: "No spans were archived for this trace.",
      }),
    ).toBe(
      "No spans match these filters among AI operations. 2 matching unclassified spans are hidden — enable Show unclassified spans to see them.",
    );
    expect(
      spanTreeEmptyLabel({
        filterActive: true,
        hideInfra: true,
        matchesHiddenByInfra: 1,
        emptyMessage: "x",
      }),
    ).toContain("1 matching unclassified span is hidden");
  });

  it("explains the transport toggle when no other filter is active", () => {
    expect(
      spanTreeEmptyLabel({ filterActive: false, hideInfra: true, emptyMessage: "archived none" }),
    ).toBe(
      "No OpenInference span types were recorded. Show unclassified spans to inspect the captured steps.",
    );
  });

  it("falls back to the caller's empty message with no filters at all", () => {
    expect(
      spanTreeEmptyLabel({ filterActive: false, hideInfra: false, emptyMessage: "archived none" }),
    ).toBe("archived none");
  });
});

describe("span match / cap honesty labels (hideInfra only)", () => {
  it("never captions a reduced tree with the unfiltered span total", () => {
    // 120 semantic rows rendered out of 400 captured spans.
    expect(
      spanMatchCountLabel(120, 400, false, { infraHiddenCount: 280 }),
    ).toBe("120 shown of 400 archived · 280 transport spans hidden");
  });

  it("singularises a single hidden transport span", () => {
    expect(spanMatchCountLabel(3, 4, false, { infraHiddenCount: 1 })).toBe(
      "3 shown of 4 archived · 1 transport span hidden",
    );
  });

  it("still says 'match' when a search filter is also active", () => {
    expect(
      spanMatchCountLabel(2, 400, true, { infraHiddenCount: 280 }),
    ).toBe("2 of 400 spans match · 280 transport spans hidden");
  });

  it("says how many matches the transport toggle swallowed", () => {
    const rows = spanTreeRows([
      span({ span_id: "http", name: "POST /v1/chat", kind: 2, attributes: {} }),
      span({
        span_id: "chain",
        parent_span_id: "http",
        name: "support.agent",
        attributes: { "openinference.span.kind": "CHAIN" },
      }),
    ]);
    // The query matches only the transport span, which hideInfra then removes.
    const result = filterSpanRows(rows, { query: "/v1/chat", hideInfra: true });
    expect(result.matchCount).toBe(0);
    expect(result.matchesHiddenByInfra).toBe(1);
    expect(
      spanMatchCountLabel(result.matchCount, rows.length, true, {
        infraHiddenCount: result.infraHiddenCount,
        matchesHiddenByInfra: result.matchesHiddenByInfra,
      }),
    ).toBe("0 of 2 spans match · 1 transport span hidden, 1 matching");
  });

  it("states shown-vs-total in the cap expander when infra is hidden", () => {
    expect(
      spanCapExpandLabel({
        visibleCount: 150,
        hiddenCount: 20,
        matchCount: 170,
        totalSpans: 400,
        filterActive: false,
        infraHiddenCount: 230,
      }),
    ).toBe("Show all 150 spans (20 more of 170 shown · 400 total)");
  });
});

describe("span match / cap honesty labels", () => {
  it("states filtered totals beside the render cap", () => {
    expect(spanMatchCountLabel(3, 40, true)).toBe("3 of 40 spans match");
    expect(spanMatchCountLabel(40, 40, false)).toBe("40 spans");
    expect(
      spanCapExpandLabel({
        visibleCount: 150,
        hiddenCount: 20,
        matchCount: 170,
        totalSpans: 400,
        filterActive: true,
      }),
    ).toBe("Show all 150 matching spans (20 more of 170 matches · 400 total)");
  });
});

describe("transport spans are never expanded into the tree", () => {
  function withTransportRoot(): ArchivedTraceSpan[] {
    return [
      span({ span_id: "http", parent_span_id: null, name: "POST /", kind: 2 }),
      span({
        span_id: "agent",
        parent_span_id: "http",
        name: "invoke",
        attributes: { "openinference.span.kind": "AGENT" },
      }),
      span({
        span_id: "llm",
        parent_span_id: "agent",
        name: "call model",
        attributes: { "openinference.span.kind": "LLM" },
      }),
    ];
  }

  it("never opens a transport wrapper, and always opens the semantic work", () => {
    const expanded = defaultExpandedSpanIds(filterSpanRows(spanTreeRows(withTransportRoot()), { hideInfra: true }).rows);
    expect(expanded.has("http")).toBe(false);
    expect(expanded.has("agent")).toBe(true);
  });
});

describe("a real LLM span is never mistaken for transport", () => {
  it("keeps a provider-named generation span carried over a CLIENT kind", () => {
    // Observed in the live archive: `openai.chat` with OTLP kind CLIENT and
    // full gen_ai prompt/completion content. An earlier rule required
    // "chat.completion", so this was classified as plumbing and hidden — the
    // reason the trace UI looked like it had no LLM spans at all.
    const rows = spanTreeRows([
      span({ span_id: "chat", name: "openai.chat", kind: 3, attributes: { "openinference.span.kind": "LLM", "gen_ai.operation.name": "chat" } }),
    ]);
    expect(isInfraSpan(rows[0], rows)).toBe(false);
  });
});


it("uses server compatibility types without classifying raw telemetry in the UI", () => {
  expect(spanKindChip(span({ semantic_kind: "llm", semantic_kind_source: "telemetry_compatibility" }))).toEqual({ label: "llm", tone: "llm" });
  expect(spanKindChip(span({ semantic_kind: "llm", attributes: { "openinference.span.kind": "TOOL" } }))).toEqual({ label: "tool", tone: "tool" });
  expect(spanKindChip(span({ attributes: { "gen_ai.request.model": "model" } }))).toEqual({ label: "span", tone: "muted" });
});
