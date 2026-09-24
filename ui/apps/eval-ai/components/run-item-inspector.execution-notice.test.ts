/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { RunItemInspector } from "@/components/run-item-inspector";
import type { RunItemDetail } from "@/lib/api";

afterEach(() => {
  cleanup();
});

const item: RunItemDetail = {
  run_id: "run-1",
  example_id: "example-1",
  sequence_position: 0,
  dataset_version: "dataset-v1",
  input: { query: "Should we approve the request?" },
  output: { response: "Approve after verification." },
  expected: { expected_answer: "Approve after verification." },
  metadata: null,
  retrieval_snippets: [],
  expected_tools: [],
  tool_calls: [],
  tool_result_artifacts: [],
  execution: {
    invocation_id: "invocation-1",
    kagent_session_id: null,
    trace_id: null,
    span_id: null,
    latency_ms: 120,
    usage: null,
    invocation_error: null,
  },
  evidence_ref: "evidence-pack://run-1/items/example-1",
  evidence_policy: {
    redaction_enabled: null,
    max_persisted_string_size: null,
    retention_policy: "stored_with_run_lifecycle",
  },
  capture_state: "complete",
  scorer_results: [],
};

function openExecutionSection(): HTMLElement {
  fireEvent.click(screen.getByRole("tab", { name: "Execution" }));
  return screen.getByRole("tabpanel");
}

describe("execution evidence notice", () => {
  it("explains a depth that never configured execution evidence", () => {
    render(createElement(RunItemInspector, { item, evaluationScope: "final_response" }));

    expect(openExecutionSection().textContent).toContain(
      "The selected Final response depth did not include this evidence.",
    );
  });

  it("explains a full-execution run whose evidence was not captured", () => {
    render(createElement(RunItemInspector, { item, evaluationScope: "full_execution" }));

    const panel = openExecutionSection();
    expect(panel.textContent).toContain("Full execution was not captured for this run.");
    expect(panel.textContent).not.toContain("did not include this evidence");
  });

  it("claims no depth for a run that recorded none", () => {
    render(createElement(RunItemInspector, { item, evaluationScope: null }));

    const panel = openExecutionSection();
    expect(panel.textContent).toContain("Scope not recorded");
    expect(panel.textContent).not.toContain("Final response");
  });

  it("shows no depth notice when execution evidence exists", () => {
    render(
      createElement(RunItemInspector, {
        item: { ...item, execution: { ...item.execution, trace_id: "1234567890abcdef1234567890abcdef" } },
        evaluationScope: "final_response",
      }),
    );

    const panel = openExecutionSection();
    expect(panel.textContent).not.toContain("did not include this evidence");
    expect(panel.textContent).toContain("1234567890abcdef1234567890abcdef");
  });
});
