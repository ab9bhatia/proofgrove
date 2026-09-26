import { describe, expect, it } from "vitest";
import { fullName, type DatasetInfo } from "@/lib/api";
import { datasetVersionLabel, groupDatasetsByLineage, lineageRootName } from "@/lib/dataset-lineage";

function ds(partial: Partial<DatasetInfo> & { name: string }): DatasetInfo {
  return {
    dataset_id: partial.dataset_id || `id-${partial.name}`,
    name: partial.name,
    tenant_id: "t1",
    product_id: partial.product_id || "proofgrove",
    status: partial.status || "DRAFT",
    version_number: partial.version_number ?? 1,
    parent_dataset_name: partial.parent_dataset_name ?? null,
    dqs: null,
    change_reason: null,
    created_by: partial.created_by || "proofgrove-ui",
    record_count: partial.record_count ?? 0,
  };
}

describe("groupDatasetsByLineage", () => {
  it("puts the highest version on the landing row", () => {
    const groups = groupDatasetsByLineage([
      ds({ name: "Eval", version_number: 1 }),
      ds({ name: "Eval_v2", version_number: 2, parent_dataset_name: "Eval" }),
      ds({ name: "Eval_v3", version_number: 3, parent_dataset_name: "Eval_v2" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(fullName(groups[0].latest)).toBe("Eval_v3");
    expect(groups[0].previous.map(fullName)).toEqual(["Eval_v2", "Eval"]);
    expect(groups[0].rootName).toBe("Eval");
  });

  it("keeps unrelated datasets in separate groups", () => {
    const groups = groupDatasetsByLineage([
      ds({ name: "Alpha", version_number: 1 }),
      ds({ name: "Beta", version_number: 1 }),
    ]);
    expect(groups.map((group) => group.rootName).sort()).toEqual(["Alpha", "Beta"]);
  });
});

describe("lineageRootName", () => {
  it("walks parents to the root", () => {
    const members = [
      ds({ name: "Eval", version_number: 1 }),
      ds({ name: "Eval_v2", version_number: 2, parent_dataset_name: "Eval" }),
    ];
    const byName = new Map(members.map((item) => [fullName(item), item]));
    expect(lineageRootName(members[1], byName)).toBe("Eval");
  });
});

describe("datasetVersionLabel", () => {
  it("collapses a version the name already carries", () => {
    // Stored on every run recorded before the backend fix, and those records
    // are immutable.
    expect(datasetVersionLabel("Codex E2E Agent 20260814-151533_v11.v11")).toBe(
      "Codex E2E Agent 20260814-151533_v11",
    );
    expect(datasetVersionLabel("support-quality.v3.v3")).toBe("support-quality.v3");
  });

  it("leaves a different trailing version alone", () => {
    // "legacy_v5" forked from v5 and is now on v7. Both are real.
    expect(datasetVersionLabel("legacy_v5.v7")).toBe("legacy_v5.v7");
    expect(datasetVersionLabel("support-quality.v3")).toBe("support-quality.v3");
  });

  it("handles absence without inventing a value", () => {
    expect(datasetVersionLabel(null)).toBe("");
    expect(datasetVersionLabel(undefined)).toBe("");
  });
});
