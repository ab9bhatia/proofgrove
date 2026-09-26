import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  PROMOTE_ANSWER_KEYS,
  PROMOTE_EXPECTED_KEYS,
  PROMOTE_QUESTION_KEYS,
  PromoteRunItemPanel,
  captureNeedsWarning,
  datasetDisplayName,
  promotableTexts,
} from "@/components/promote-run-item";
import type { DatasetInfo, PromoteRunItemResult, RunItemDetail } from "@/lib/api";

function item(overrides: Partial<RunItemDetail> = {}): RunItemDetail {
  return {
    run_id: "run-1",
    example_id: "ex-1",
    sequence_position: 0,
    dataset_version: null,
    input: { question: "What is the refund window?" },
    output: { response: "Refunds are accepted within 30 days." },
    expected: { expected_output: "30 days." },
    metadata: null,
    retrieval_snippets: null,
    expected_tools: null,
    tool_calls: null,
    tool_result_artifacts: [],
    execution: { trace_id: "trace-abc" } as RunItemDetail["execution"],
    scorer_results: [],
    evidence_ref: "evidence-pack://run-1/items/ex-1",
    evidence_policy: {
      redaction_enabled: false,
      max_persisted_string_size: null,
      retention_policy: "stored_with_run_lifecycle",
    },
    capture_state: "complete",
    ...overrides,
  } as RunItemDetail;
}

function dataset(overrides: Partial<DatasetInfo> = {}): DatasetInfo {
  return {
    dataset_id: "id-1",
    dataset_name: "golden-ds",
    tenant_id: "tenant-1",
    product_id: "proofgrove",
    status: "DRAFT",
    version_number: 1,
    parent_dataset_name: null,
    dqs: null,
    change_reason: null,
    created_by: "test",
    ...overrides,
  } as DatasetInfo;
}

function render(overrides: Record<string, unknown> = {}): string {
  const props = {
    item: item(),
    onBack: vi.fn(),
    datasets: [dataset()],
    datasetsLoading: false,
    hasMore: false,
    onLoadMore: vi.fn(),
    selectedDatasetName: "golden-ds",
    onSelectDataset: vi.fn(),
    targetMode: "existing",
    onTargetModeChange: vi.fn(),
    newDatasetName: "",
    onNewDatasetNameChange: vi.fn(),
    expectedSource: "output",
    onExpectedSourceChange: vi.fn(),
    onExpectedTextChange: vi.fn(),
    createVersion: false,
    onCreateVersionChange: vi.fn(),
    onCommit: vi.fn(),
    busy: false,
    error: null,
    result: null,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(PromoteRunItemPanel, props as never));
}

describe("promotable text extraction", () => {
  it("mirrors the backend builder's key lists exactly", () => {
    // A drifted list would let the panel offer a source the server 422s.
    expect(PROMOTE_QUESTION_KEYS).toEqual(["question", "query", "prompt", "input"]);
    expect(PROMOTE_ANSWER_KEYS).toEqual(["response", "answer", "output", "actual_output", "text"]);
    expect(PROMOTE_EXPECTED_KEYS).toEqual([
      "expected_output",
      "expected_response",
      "expected_sql",
      "expected_answer",
      "answer",
      "response",
    ]);
  });

  it("extracts all three texts", () => {
    expect(promotableTexts(item())).toEqual({
      question: "What is the refund window?",
      actual: "Refunds are accepted within 30 days.",
      expected: "30 days.",
      actualTruncated: false,
      expectedTruncated: false,
    });
  });

  it("reports missing texts as null", () => {
    expect(promotableTexts(item({ output: null, expected: {} }))).toEqual({
      question: "What is the refund window?",
      actual: null,
      expected: null,
      actualTruncated: false,
      expectedTruncated: false,
    });
  });

  it("flags text the persistence layer cut short", () => {
    const marked = promotableTexts(item({ output: { response: `long answer${"…"}[TRUNCATED]` } }));
    expect(marked.actualTruncated).toBe(true);

    // Exactly at the limit is intact evidence — the persistence layer only
    // cuts strings longer than the limit.
    const atLimit = promotableTexts(
      item({
        output: { response: "a".repeat(100) },
        evidence_policy: {
          redaction_enabled: false,
          max_persisted_string_size: 100,
          retention_policy: "stored_with_run_lifecycle",
        },
      }),
    );
    expect(atLimit.actualTruncated).toBe(false);

    const overLimit = promotableTexts(
      item({
        output: { response: "a".repeat(101) },
        evidence_policy: {
          redaction_enabled: false,
          max_persisted_string_size: 100,
          retention_policy: "stored_with_run_lifecycle",
        },
      }),
    );
    expect(overLimit.actualTruncated).toBe(true);
  });

  it("flags imperfect capture", () => {
    expect(captureNeedsWarning(item())).toBe(false);
    expect(captureNeedsWarning(item({ capture_state: "partial" }))).toBe(true);
    expect(
      captureNeedsWarning(
        item({
          evidence_policy: {
            redaction_enabled: true,
            max_persisted_string_size: null,
            retention_policy: "stored_with_run_lifecycle",
          },
        }),
      ),
    ).toBe(true);
  });

  it("reads either dataset name field", () => {
    expect(datasetDisplayName(dataset())).toBe("golden-ds");
    expect(datasetDisplayName(dataset({ dataset_name: undefined, name: "other" }))).toBe("other");
  });
});

describe("PromoteRunItemPanel", () => {
  it("shows both candidate texts with the actual answer selected", () => {
    const html = render();
    expect(html).toContain("Use the actual answer");
    expect(html).toContain("Refunds are accepted within 30 days.");
    expect(html).toContain("Keep the original expectation");
    expect(html).toContain("30 days.");
  });

  it("gates the trace-span source with a stated reason", () => {
    const html = render();
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Trace span — unavailable");
    expect(html).toContain("#2662");
  });

  it("refuses truncated text with a reason rather than offering it", () => {
    const html = render({ item: item({ output: { response: "cut short[TRUNCATED]" } }) });
    expect(html).toContain("truncated when it was persisted");
    // Both the radio and the commit are closed off for that source.
    expect(html).toMatch(/disabled=""[^>]*name="promote-expected-source"/);
    expect(html).toMatch(/disabled=""[^>]*>Promote</);
  });

  it("explains a missing expectation instead of offering it", () => {
    const html = render({ item: item({ expected: {} }) });
    expect(html).toContain("This item carries no original expectation.");
  });

  it("warns when the capture was redacted or partial", () => {
    const html = render({ item: item({ capture_state: "partial" }) });
    expect(html).toContain("Capture state is partial");
    expect(html).toContain("carry this caveat");
  });

  it("offers the immutable opt-in and blocks the commit until ticked", () => {
    const published = dataset({ status: "PUBLISHED" });
    const blocked = render({ datasets: [published], selectedDatasetName: "golden-ds" });
    expect(blocked).toContain("records are immutable");
    expect(blocked).toContain("new draft version");
    // The primary action is disabled while blocked.
    expect(blocked).toMatch(/disabled=""[^>]*>Promote</);
    const opted = render({
      datasets: [published],
      selectedDatasetName: "golden-ds",
      createVersion: true,
    });
    expect(opted).toContain("Create version and promote");
  });

  it("filters retired datasets out of the picker", () => {
    const html = render({
      datasets: [dataset(), dataset({ dataset_name: "old-ds", status: "RETIRED" })],
    });
    expect(html).toContain("golden-ds");
    expect(html).not.toContain("old-ds");
  });

  it("keeps later pages reachable", () => {
    const html = render({ hasMore: true });
    expect(html).toContain("Load more datasets");
  });

  it("reports a duplicate promotion honestly", () => {
    const result: PromoteRunItemResult = {
      dataset_name: "golden-ds",
      record_id: "rid-1",
      duplicate: true,
      created_version: false,
      source_dataset_name: null,
      version_number: 2,
      status: "DRAFT",
    };
    const html = render({ result });
    expect(html).toContain("already promoted here");
    expect(html).toContain("rid-1");
  });

  it("names the new draft and the remaining lifecycle after a branch", () => {
    const result: PromoteRunItemResult = {
      dataset_name: "golden-ds_v2",
      record_id: "rid-1",
      duplicate: false,
      created_version: true,
      source_dataset_name: "golden-ds",
      version_number: 2,
      status: "DRAFT",
    };
    const html = render({ result });
    expect(html).toContain("golden-ds_v2");
    expect(html).toContain("validate, approve and publish");
  });

  it("renders errors inline as an alert", () => {
    const html = render({ error: "Could not promote the run item." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not promote the run item.");
  });
});

 describe("reviewer-authored expected output", () => {
  it("requires a nonblank correct answer and does not depend on a captured expectation", () => {
    expect(render({ expectedSource: "reviewer", expectedText: "   " })).toMatch(/disabled=""[^>]*>Promote</);
    const html = render({ expectedSource: "reviewer", expectedText: "The correct answer.", item: item({ expected: null, output: null }) });
    expect(html).toContain("The correct answer.");
    expect(html).toContain("not feedback or instructions for the judge");
    expect(html).not.toMatch(/disabled=""[^>]*>Promote</);
  });
});
