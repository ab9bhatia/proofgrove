import { describe, expect, it } from "vitest";

import type { DatasetInfo } from "@/lib/api";
import { filterDatasetsByQuery } from "@/lib/dataset-search";

function dataset(partial: Partial<DatasetInfo> & Pick<DatasetInfo, "dataset_name">): DatasetInfo {
  return {
    dataset_id: `id-${partial.dataset_name}`,
    tenant_id: "tenant-a",
    product_id: "checkout",
      status: "PUBLISHED",
    version_number: 1,
    parent_dataset_name: null,
    dqs: null,
    change_reason: null,
    created_by: "amina",
    record_count: 3,
    ...partial,
  } as DatasetInfo;
}

describe("filterDatasetsByQuery", () => {
  const datasets = [
    dataset({ dataset_name: "checkout_golden" }),
    dataset({ dataset_name: "support_golden", product_id: "support", created_by: "sam" }),
    dataset({ dataset_name: "rag_eval", status: "DRAFT" }),
  ];

  it("returns the whole page for an empty or blank query", () => {
    expect(filterDatasetsByQuery(datasets, "")).toBe(datasets);
    expect(filterDatasetsByQuery(datasets, "   ")).toBe(datasets);
  });

  it("matches name, product, type, status and author, case-insensitively", () => {
    expect(filterDatasetsByQuery(datasets, "SUPPORT").map((ds) => ds.dataset_name)).toEqual([
      "support_golden",
    ]);
    expect(filterDatasetsByQuery(datasets, "rag").map((ds) => ds.dataset_name)).toEqual([
      "rag_eval",
    ]);
    expect(filterDatasetsByQuery(datasets, "draft").map((ds) => ds.dataset_name)).toEqual([
      "rag_eval",
    ]);
    expect(filterDatasetsByQuery(datasets, "sam").map((ds) => ds.dataset_name)).toEqual([
      "support_golden",
    ]);
  });

  it("counts the rows the caption reports, not the raw page", () => {
    // "3 of 100 datasets" while the library lists one match was the bug.
    expect(filterDatasetsByQuery(datasets, "support")).toHaveLength(1);
    expect(datasets).toHaveLength(3);
  });

  it("is idempotent, so applying it in both shell and library is safe", () => {
    const once = filterDatasetsByQuery(datasets, "golden");
    expect(filterDatasetsByQuery(once, "golden")).toEqual(once);
  });
});
