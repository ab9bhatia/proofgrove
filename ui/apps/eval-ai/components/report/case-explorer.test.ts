import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RunItemSummary } from "@/lib/api";
import {
  CaseDetailsSection,
  adjacentCaseId,
  caseNeedsAttention,
  filterCases,
  firstCaseNeedingAttention,
} from "./case-explorer";

function item(overrides: Partial<RunItemSummary> = {}): RunItemSummary {
  return {
    run_id: "run-1",
    example_id: "case",
    query: "question",
    sequence_position: 0,
    dataset_version: "v1",
    worst_gate: "pass",
    metric_count: 1,
    failing_count: 0,
    error_count: 0,
    scored_count: 1,
    unscored_count: 0,
    not_applicable_count: 0,
    evaluation_state: "evaluated",
    latency_ms: null,
    trace_available: false,
    evidence_ref: "ref",
    capture_state: "complete",
    artifact_count: 0,
    ...overrides,
  };
}

const items: RunItemSummary[] = [
  item({ example_id: "pass-1", worst_gate: "pass" }),
  item({ example_id: "fail-1", worst_gate: "fail", failing_count: 1 }),
  item({ example_id: "pass-2", worst_gate: "pass" }),
  item({ example_id: "fail-2", worst_gate: "fail", failing_count: 1 }),
];

describe("case filtering", () => {
  it("splits attention from passed cases", () => {
    expect(items.filter(caseNeedsAttention).map((i) => i.example_id)).toEqual(["fail-1", "fail-2"]);
    expect(filterCases(items, "attention").map((i) => i.example_id)).toEqual(["fail-1", "fail-2"]);
    expect(filterCases(items, "passed").map((i) => i.example_id)).toEqual(["pass-1", "pass-2"]);
    expect(filterCases(items, "all")).toHaveLength(4);
  });
});

describe("filtered case navigation", () => {
  it("keeps prev/next within the filtered set instead of the unfiltered items", () => {
    const attention = filterCases(items, "attention");
    // From the first attention case, next is the SECOND attention case —
    // never the "pass-2" case that sits between them in the unfiltered list.
    expect(adjacentCaseId(attention, "fail-1", 1)).toBe("fail-2");
    expect(adjacentCaseId(attention, "fail-1", 1)).not.toBe("pass-2");
    // The last case in the filter has no next; the first has no previous.
    expect(adjacentCaseId(attention, "fail-2", 1)).toBeNull();
    expect(adjacentCaseId(attention, "fail-1", -1)).toBeNull();
    expect(adjacentCaseId(attention, "fail-2", -1)).toBe("fail-1");
  });

  it("returns null when the selected case is not in the filtered set", () => {
    const passed = filterCases(items, "passed");
    expect(adjacentCaseId(passed, "fail-1", 1)).toBeNull();
    expect(adjacentCaseId(passed, null, 1)).toBeNull();
  });
});


describe("case list load failure", () => {
  it("renders retryable load-failure copy instead of a missing-case message", () => {
    const onRetry = vi.fn();
    const html = renderToStaticMarkup(
      createElement(CaseDetailsSection, {
        items: [],
        loading: false,
        error: "network down",
        expanded: new Set<string>(),
        detailsById: {},
        detailLoading: new Set<string>(),
        onToggle: () => undefined,
        onExpandAll: () => undefined,
        onRetry,
      }),
    );
    expect(html).toContain("Couldn&#x27;t load cases for this run.");
    expect(html).toContain("network down");
    expect(html).toContain("Retry");
    expect(html).not.toContain("was not found");
  });
});

describe("expanded case trace evidence", () => {
  const detail = {
    run_id: "run-1",
    example_id: "traced",
    sequence_position: 0,
    dataset_version: "v1",
    input: null,
    output: null,
    expected: null,
    metadata: null,
    retrieval_snippets: null,
    expected_tools: null,
    tool_calls: null,
    tool_result_artifacts: [],
    execution: {
      invocation_id: null,
      kagent_session_id: null,
      latency_ms: null,
      usage: null,
      invocation_error: null,
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: null,
    },
    scorer_results: [],
    evidence_ref: "ref",
    evidence_policy: {} as never,
    capture_state: "complete" as const,
  };

  function render(detailsById: Record<string, unknown>) {
    return renderToStaticMarkup(
      createElement(CaseDetailsSection, {
        items: [item({ example_id: "traced", trace_available: true })],
        loading: false,
        error: null,
        // The evidence stats only render in the embedded (inline-expanded)
        // layout; the compact list opens a dialog instead.
        embedded: true,
        expanded: new Set(["traced"]),
        detailsById: detailsById as never,
        detailLoading: new Set<string>(),
        onToggle: () => undefined,
        onExpandAll: () => undefined,
      }),
    );
  }

  it("shows the real trace id, not the words 'Captured trace ID'", () => {
    const html = render({ traced: detail });
    // The label used to be rendered where the value belongs, so the cell read
    // "Captured trace ID" for every traced case and identified nothing.
    expect(html).not.toContain("Captured trace ID");
    // The whole id, not an elided one — it gets copied into a log search.
    expect(html).toContain(detail.execution.trace_id);
    expect(html).not.toContain("…");
  });

  it("says the id is not recorded when the detail loaded without one", () => {
    const html = render({ traced: { ...detail, execution: { ...detail.execution, trace_id: null } } });
    expect(html).toContain("Captured — ID not recorded");
  });
});

describe("firstCaseNeedingAttention", () => {
  it("picks the first case that did not pass, in list order", () => {
    // Opening a run showed a list with nothing selected, so the first thing
    // anyone did on a failing run was hunt for the failure.
    const items = [
      item({ example_id: "a", worst_gate: "pass" }),
      item({ example_id: "b", worst_gate: "fail", failing_count: 1 }),
      item({ example_id: "c", worst_gate: "fail", failing_count: 1 }),
    ];
    expect(firstCaseNeedingAttention(items)).toBe("b");
  });

  it("picks nothing from a set that hides the failures", () => {
    // Under ?caseFilter=passed the attention case is not in the list, so
    // selecting it opens a case the reader cannot see.
    const items = [
      item({ example_id: "a", worst_gate: "pass" }),
      item({ example_id: "b", worst_gate: "fail", failing_count: 1 }),
    ];
    expect(firstCaseNeedingAttention(filterCases(items, "passed"))).toBeNull();
    expect(firstCaseNeedingAttention(filterCases(items, "attention"))).toBe("b");
  });

  it("picks nothing when every case passed", () => {
    // Opening an arbitrary case on a clean run is noise, not a head start.
    expect(firstCaseNeedingAttention([item({ example_id: "a" })])).toBeNull();
    expect(firstCaseNeedingAttention([])).toBeNull();
  });
});
