import { describe, expect, it } from "vitest";

import type { DatasetInfo } from "@/lib/api";
import { datasetIsUnusable, datasetMissingFields, missingFieldsLabel } from "./evaluation-form";

function dataset(overrides: Partial<DatasetInfo> = {}): DatasetInfo {
  return {
    dataset_id: "dataset-support",
    name: "support",
    tenant_id: "tenant-a",
    product_id: "eval-hub",
    status: "PUBLISHED",
    version_number: 1,
    parent_dataset_name: null,
    dqs: null,
    change_reason: null,
    created_by: "test",
    ...overrides,
  };
}

describe("whether a dataset can be evaluated at all", () => {
  it("needs both a question and an expected output on its rows", () => {
    // A question with nothing to grade the answer against cannot be evaluated either.
    expect(datasetIsUnusable(dataset({ missing_row_fields: [] }), "llm")).toBe(false);
    expect(datasetIsUnusable(dataset({ missing_row_fields: ["expected output"] }), "agent")).toBe(true);
    expect(datasetIsUnusable(dataset({ missing_row_fields: ["question"] }), "provided")).toBe(true);
  });

  it("requires an existing response only for provided evaluations", () => {
    const missingResponse = dataset({
      missing_row_fields: [],
      missing_provided_response: true,
    });
    expect(datasetIsUnusable(missingResponse, "provided")).toBe(true);
    expect(datasetIsUnusable(missingResponse, "agent")).toBe(false);
    expect(datasetIsUnusable(missingResponse, "llm")).toBe(false);
  });

  it("treats a missing verdict as unknown, never as unusable", () => {
    // "Not computed" must not read as "cannot": the create/version/restore responses
    // return the record copy they just made without re-reading rows.
    for (const missing of [undefined, null]) {
      expect(datasetIsUnusable(dataset({ missing_row_fields: missing }), "provided")).toBe(false);
      expect(datasetMissingFields(dataset({ missing_row_fields: missing }))).toEqual([]);
    }
  });

  it("names which half is missing, so the notice never says the wrong one", () => {
    expect(missingFieldsLabel(["expected output"])).toBe("expected output");
    expect(missingFieldsLabel(["question", "expected output"])).toBe("question and expected output");
    expect(missingFieldsLabel([])).toBe("");
  });
});
