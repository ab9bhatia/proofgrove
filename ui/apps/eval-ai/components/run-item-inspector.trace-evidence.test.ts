import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TraceEvidenceView } from "@/components/run-item-inspector";
import type { ArchivedTraceSpan, RunItemTraceEvidence } from "@/lib/api";

function span(overrides: Partial<ArchivedTraceSpan> = {}): ArchivedTraceSpan {
  return {
    trace_id: "0123456789abcdef0123456789abcdef",
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

/** Root agent span with an LLM child and an infra (HTTP client) child. */
function sampleSpans(): ArchivedTraceSpan[] {
  return [
    span({
      span_id: "root",
      name: "workbench invocation",
      attributes: { "openinference.span.kind": "AGENT" },
      resource_attributes: { "service.name": "workbench" },
    }),
    span({
      span_id: "llm",
      parent_span_id: "root",
      name: "call model",
      attributes: { "openinference.span.kind": "LLM" },
    }),
    span({
      span_id: "infra",
      parent_span_id: "root",
      name: "POST /v1/chat",
      kind: 3,
    }),
  ];
}

function evidence(overrides: Partial<RunItemTraceEvidence> = {}): RunItemTraceEvidence {
  return {
    state: "available",
    trace_id: "0123456789abcdef0123456789abcdef",
    spans: sampleSpans(),
    object_refs: [],
    pagination_complete: true,
    lifecycle_complete: true,
    evidence_complete: true,
    truncated: false,
    message: null,
    ...overrides,
  };
}

function render(value: RunItemTraceEvidence): string {
  return renderToStaticMarkup(
    createElement(TraceEvidenceView, { evidence: value, item: item(), onRefresh: () => {} }),
  );
}

function item(): import("@/lib/api").RunItemDetail {
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
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "span-1",
      latency_ms: 12,
      usage: null,
      invocation_error: null,
    },
    scorer_results: [],
    evidence_ref: "ref",
    evidence_policy: {
      redaction_enabled: false,
      max_persisted_string_size: null,
      retention_policy: "stored_with_run_lifecycle",
    },
    capture_state: "complete",
  };
}

describe("TraceEvidenceView", () => {
  it("renders spans through the shared span tree with parent/child nesting", () => {
    const html = render(evidence());
    expect(html).toContain('role="tree"');
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('aria-level="1"');
    expect(html).toContain('aria-level="2"');
  });

  it("shows the same semantic kind chips as the trace inspector", () => {
    const html = render(evidence());
    expect(html).toContain(">agent<");
    expect(html).toContain(">llm<");
  });

  it("hides network/transport spans by default but keeps the toggle reachable", () => {
    const html = render(evidence());
    expect(html).not.toContain("POST /v1/chat");
    // Transport spans are never rendered and the toggle is gone: it only gave
    // the operator a way to bury the evidence under HTTP plumbing.
    expect(html).not.toContain("Show network / transport spans");
  });

  it("renders the selected root span through the shared detail pane, raw attributes collapsed", () => {
    const html = render(evidence());
    expect(html).toContain("Span detail");
    expect(html).toContain("Search attributes");
    expect(html).toContain('aria-label="Span attributes"');
    // Resource attributes stay reachable, but behind the shared pane's
    // collapsed <details> rather than the old always-open dump.
    expect(html).toContain("Resource attributes");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
  });

  it("counts AI operations instead of transport spans", () => {
    const html = render(evidence());
    // "shown of archived" ties this count back to the trace summary's own
    // "Archived spans" figure, rather than naming the same total a third way.
    // "shown of archived" ties this count back to the trace summary's own
    // vocabulary, and ships in this commit alongside the wording it asserts.
    expect(html).toContain("2 AI operations");
  });

  it("discloses the exact failing axis even when spans render", () => {
    const html = render(
      evidence({
        evidence_complete: false,
        lifecycle_complete: false,
        message: "Trace evidence is incomplete: archive pagination or trace lifecycle is unfinished.",
      }),
    );
    expect(html).toContain('role="tree"');
    // Axis-differentiated: the lifecycle warning names itself, and the axes
    // that hold are not blamed.
    expect(html).toContain("Trace lifecycle unfinished");
    expect(html).not.toContain("Archive read incomplete");
    // The archive's collapsed one-sentence disjunction is replaced, and it no
    // longer leaks into the pane empty states either.
    expect(html).not.toContain("archive pagination or trace lifecycle");
  });

  it("renders no warning band when the evidence is complete", () => {
    const html = render(evidence());
    expect(html).not.toContain("Capture integrity warnings");
  });

  it("keeps the header honest: span count, trace id, and a bounded read warning", () => {
    const html = render(evidence({ truncated: true, evidence_complete: false }));
    expect(html).toContain("<strong>2</strong>");
    expect(html).toContain("0123456789abcdef0123456789abcdef");
    expect(html).toContain('aria-label="Capture integrity warnings"');
    expect(html).toContain("Bounded result");
  });

  it("does not render an archive tree without a valid trace id", () => {
    const html = render(evidence({ trace_id: null }));
    expect(html).toContain("No valid archived trace ID");
    expect(html).not.toContain('role="tree"');
  });

  it("rejects all-zero and malformed archived identities even if the response claims availability", () => {
    for (const trace_id of ["0".repeat(32), "invalid-trace"]) {
      const html = render(evidence({ trace_id }));
      expect(html).toContain("No valid archived trace ID");
      expect(html).not.toContain('role="tree"');
      expect(html).not.toContain("Open in Projects");
      expect(html).not.toContain(trace_id);
    }
  });

  it("renders the shared empty message when the archive returns no spans", () => {
    const html = render(evidence({ spans: [] }));
    expect(html).toContain("No archived span is available to inspect");
  });

  it("offers a refresh for pending evidence", () => {
    const html = render(
      evidence({ state: "pending", spans: [], message: "Archive indexing is still running." }),
    );
    expect(html).toContain("Archive indexing is still running.");
    expect(html).toContain("Refresh");
    expect(html).not.toContain('role="tree"');
  });

  it("states absence without a refresh when the trace was not found", () => {
    const html = render(
      evidence({ state: "not_found", spans: [], message: "No archived trace matches this row." }),
    );
    expect(html).toContain("No archived trace matches this row.");
    expect(html).not.toContain("Refresh");
    expect(html).not.toContain('role="tree"');
  });
});
