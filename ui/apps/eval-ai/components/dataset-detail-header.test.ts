import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DatasetInfo } from "@/lib/api";
import { DatasetDetailHeader } from "./dataset-detail-header";

const dataset: DatasetInfo = {
  dataset_id: "dataset-1",
  name: "support-quality",
  tenant_id: "tenant-classroom",
  product_id: "customer-support",
  status: "DRAFT",
  version_number: 2,
  parent_dataset_name: null,
  dqs: null,
  change_reason: null,
  created_by: "proofgrove-ui",
  record_count: 12,
};

describe("DatasetDetailHeader", () => {
  it("prioritizes dataset identity, lifecycle action, and compact summary metadata", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetDetailHeader, {
        dataset,
        displayName: "support-quality",
        displayStatus: "DRAFT",
        recordCount: 12,
        actions: [{ label: "Run validation", action: "validate" }],
        actionLoading: null,
        onAction: () => undefined,
        onDelete: () => undefined,
      }),
    );

    expect(html).toContain('aria-labelledby="dataset-title"');
    expect(html).toContain("support-quality");
    expect(html).toContain("DRAFT");
    expect(html).toContain("v2");
    expect(html).toContain("Run validation");
    expect(html).toContain(">Lifecycle<");
    expect(html).toContain('aria-label="Lifecycle stages"');
    expect(html).toContain(">Product<");
    expect(html).toContain(">customer-support<");
    expect(html).toContain(">Records<");
    expect(html).toContain(">12<");
    expect(html).toContain(">Data quality<");
    expect(html).toContain(">Not run<");
    expect(html).toContain(">Delete<");
    expect(html).toContain("Only published datasets can be selected for an evaluation");
  });

  it("removes the publication guidance after the dataset is published", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetDetailHeader, {
        dataset: { ...dataset, status: "PUBLISHED" },
        displayName: "support-quality",
        displayStatus: "PUBLISHED",
        recordCount: 12,
        actions: [],
        actionLoading: null,
        onAction: () => undefined,
        evaluateHref: "/evaluate?dataset=dataset-1",
      }),
    );

    expect(html).toContain("Evaluate dataset");
    expect(html).not.toContain("Only published datasets can be selected for an evaluation");
  });

  it("offers a record-preserving editable restore for a retired version", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetDetailHeader, {
        dataset: { ...dataset, status: "RETIRED" },
        displayName: "support-quality",
        displayStatus: "RETIRED",
        recordCount: 12,
        actions: [{ label: "Restore as editable draft", action: "restore-draft" }],
        actionLoading: null,
        onAction: () => undefined,
      }),
    );

    expect(html).toContain("This retired version remains read-only");
    expect(html).toContain("copy its records into the next version");
    expect(html).toContain("Restore as editable draft");
    expect(html).not.toContain("Run validation");
  });
});
