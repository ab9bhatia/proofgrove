import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RunItemDrawer } from "@/components/run-item-drawer";
import type { RunItemDetail } from "@/lib/api";

const item = {
  run_id: "run-1",
  example_id: "ex-1",
  sequence_position: 0,
  dataset_version: null,
  input: { question: "What is the refund window?" },
  output: { response: "30 days." },
  expected: null,
  metadata: null,
  retrieval_snippets: null,
  expected_tools: null,
  tool_calls: null,
  tool_result_artifacts: [],
  execution: { trace_id: null },
  scorer_results: [],
  evidence_ref: "evidence-pack://run-1/items/ex-1",
  evidence_policy: {
    redaction_enabled: false,
    max_persisted_string_size: null,
    retention_policy: "stored_with_run_lifecycle",
  },
  capture_state: "complete",
} as unknown as RunItemDetail;

function render(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(RunItemDrawer, {
      exampleId: "ex-1",
      item,
      loading: false,
      error: null,
      position: 1,
      total: 3,
      kpis: [],
      onClose: vi.fn(),
      ...overrides,
    } as never),
  );
}

describe("RunItemDrawer promote affordance", () => {
  it("offers Promote to dataset in the header for a loaded item", () => {
    expect(render()).toContain("Promote to dataset");
  });

  it("offers it in the report's dialog variant too", () => {
    expect(render({ variant: "dialog" })).toContain("Promote to dataset");
  });

  it("does not offer it while the item is still loading", () => {
    expect(render({ item: null, loading: true })).not.toContain("Promote to dataset");
  });
});
