import { describe, expect, it } from "vitest";

import { latestPublishedDatasets } from "@/lib/evaluation-datasets";
import type { DatasetInfo } from "@/lib/api";

function dataset(overrides: Partial<DatasetInfo>): DatasetInfo {
  return {
    dataset_name: "support",
    tenant_id: "tenant-a",
    product_id: "proofgrove",
    status: "PUBLISHED",
    version_number: 1,
    ...overrides,
  } as DatasetInfo;
}

describe("evaluation dataset selection", () => {
  it("keeps the latest published version in each lineage", () => {
    const result = latestPublishedDatasets([
      dataset({ dataset_name: "support-v1", version_number: 1 }),
      dataset({
        dataset_name: "support-v2",
        parent_dataset_name: "support-v1",
        version_number: 2,
      }),
      dataset({ dataset_name: "draft-only", status: "DRAFT" }),
    ]);

    expect(result.map((item) => item.dataset_name)).toEqual(["support-v2"]);
  });
});
