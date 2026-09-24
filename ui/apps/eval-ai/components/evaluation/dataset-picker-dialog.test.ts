/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatasetInfo } from "@/lib/api";
import { DatasetPickerDialog, filterDatasets } from "./dataset-picker-dialog";

afterEach(() => {
  cleanup();
});

function dataset(overrides: Partial<DatasetInfo> & { dataset_id: string }): DatasetInfo {
  return {
    name: overrides.dataset_id,
    tenant_id: "t",
    product_id: "fraud",
    status: "PUBLISHED",
    version_number: 1,
    parent_dataset_name: null,
    dqs: null,
    change_reason: null,
    created_by: "someone",
    ...overrides,
  } as DatasetInfo;
}

const usable = dataset({ dataset_id: "agent-cases", record_count: 12, missing_row_fields: [] });
const incomplete = dataset({
  dataset_id: "half-built",
  record_count: 4,
  missing_row_fields: ["expected output"],
});

function open(
  datasets: DatasetInfo[],
  onSelect = vi.fn(),
  selectedName: string | null = null,
  kind: "agent" | "llm" | "provided" = "llm",
) {
  render(
    createElement(DatasetPickerDialog, {
      datasets,
      kind,
      selectedName,
      canLoadMore: false,
      loadingMore: false,
      onLoadMore: () => undefined,
      onSelect,
      onClose: () => undefined,
    }),
  );
  return onSelect;
}

describe("dataset picker dialog", () => {
  it("shows the metadata the choice depends on, not just names", () => {
    open([usable]);
    // A name alone cannot tell you whether the dataset is worth running.
    expect(screen.getByText("v1")).toBeTruthy();
    expect(screen.getByText("12 rows")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });

  it("marks the current dataset without duplicating its details", () => {
    open([usable], vi.fn(), "agent-cases");
    expect(screen.getByRole("button", { name: /agent-cases/ }).getAttribute("aria-current")).toBe("true");
  });

  it("refuses a dataset whose rows cannot be run, and says why", () => {
    const onSelect = open([incomplete]);

    expect(screen.getByText("Missing expected output")).toBeTruthy();
    const row = screen.getByRole("button", { name: /half-built/ });
    expect(row.hasAttribute("disabled")).toBe(true);
    fireEvent.click(row);
    // Selecting it would only fail later, at run time.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects a usable dataset", () => {
    const onSelect = open([usable]);
    fireEvent.click(screen.getByRole("button", { name: /agent-cases/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("marks missing stored responses only for the provided choice", () => {
    const missingResponse = dataset({
      dataset_id: "stored-results",
      missing_row_fields: [],
      missing_provided_response: true,
    });
    const onSelect = open([missingResponse], vi.fn(), null, "provided");
    // "Missing existing response" read as a false negative to a user whose rows
    // plainly had text: the expected output is a different field from the response.
    expect(screen.getByText("No recorded response")).toBeTruthy();
    expect(screen.getByRole("button", { name: /stored-results/ }).hasAttribute("disabled")).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();

    cleanup();
    open([missingResponse], vi.fn(), null, "agent");
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByRole("button", { name: /stored-results/ }).hasAttribute("disabled")).toBe(false);
  });

  it("presents unknown stored-response coverage neutrally", () => {
    open([
      dataset({
        dataset_id: "large-results",
        missing_row_fields: [],
        missing_provided_response: null,
      }),
    ], vi.fn(), null, "provided");

    const status = screen.getByText("Not computed");
    expect(status.className).toContain("text-muted-foreground");
    expect(status.className).not.toContain("text-success-text");
  });

  it("filters by name and by product", () => {
    const datasets = [usable, incomplete];
    expect(filterDatasets(datasets, "").length).toBe(2);
    expect(filterDatasets(datasets, "half").map((d) => d.dataset_id)).toEqual(["half-built"]);
    expect(filterDatasets(datasets, "fraud").length).toBe(2);
    expect(filterDatasets(datasets, "nothing-matches")).toEqual([]);
  });
});
