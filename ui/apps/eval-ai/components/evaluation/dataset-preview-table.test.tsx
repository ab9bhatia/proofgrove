import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { DatasetRecord } from "@/lib/api";
import { recordsToCsvString } from "@/lib/dataset-csv";
import { DatasetPreviewTable, datasetPreviewRow } from "./dataset-preview-table";

const golden: DatasetRecord = {
  inputs: { question: "When will I receive the refund?" },
  expectations: { expected_output: "Within 5–7 working days." },
  tags: { topic: "refund timing", risk: "medium", source: "synthetic-classroom" },
};

describe("evaluation dataset preview", () => {
  it("shows reference-only golden cases without inventing an actual answer", () => {
    render(<DatasetPreviewTable records={[golden]} />);
    expect(screen.getByRole("columnheader", { name: "Input / question" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Expected output / reference" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Supplied response" })).toBeNull();
    expect(screen.getByText(/the model or agent generates an actual response/)).toBeTruthy();
    expect(screen.getByText("refund timing")).toBeTruthy();
    expect(datasetPreviewRow(golden, 0).response).toBeNull();
  });
  it("separates authored supplied responses from both the reference and metadata", () => {
    const rehearsal = { ...golden, inputs: { ...golden.inputs, response: "Your refund arrives tomorrow." }, tags: { ...golden.tags, evidence: "authored-response" } };
    const before = JSON.stringify(rehearsal);
    const csvBefore = recordsToCsvString([rehearsal]);
    render(<DatasetPreviewTable records={[rehearsal]} />);
    const cells = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");
    expect(cells[2]!.textContent).toBe("Within 5–7 working days.");
    expect(cells[3]!.textContent).toContain("Your refund arrives tomorrow.");
    expect(cells[3]!.textContent).toContain("Authored example · not a live result");
    expect(cells[4]!.textContent).not.toContain("Your refund arrives tomorrow.");
    expect(datasetPreviewRow(rehearsal, 0).metadata).not.toHaveProperty("response");
    expect(JSON.stringify(rehearsal)).toBe(before);
    expect(recordsToCsvString([rehearsal])).toBe(csvBefore);
    expect(csvBefore).toContain("response");
  });
  it("does not let an empty expectation response hide a supplied input answer", () => {
    const record = { ...golden, inputs: { ...golden.inputs, response: "Captured answer" }, expectations: { ...golden.expectations, response: "" } };
    expect(datasetPreviewRow(record, 0).response).toBe("Captured answer");
  });
  it("does not treat synthetic input provenance as proof that a response was authored", () => {
    expect(datasetPreviewRow({ ...golden, inputs: { ...golden.inputs, response: "Captured model answer" } }, 0).authored).toBe(false);
  });
  it("keeps intentional empty supplied answers visible and distinct from missing answers", () => {
    render(<DatasetPreviewTable records={[{ ...golden, inputs: { ...golden.inputs, response: "" } }, golden]} />);
    expect(screen.getByText("Empty response")).toBeTruthy();
    expect(screen.getByText("No supplied response")).toBeTruthy();
  });
  it("identifies a non-text stored response instead of hiding it in metadata", () => {
    render(<DatasetPreviewTable records={[{ ...golden, inputs: { ...golden.inputs, response: { message: "Malformed answer" } } }]} />);
    expect(screen.getByText("Stored value is not a text response.")).toBeTruthy();
    expect(screen.getByText('{"message":"Malformed answer"}')).toBeTruthy();
  });
});
