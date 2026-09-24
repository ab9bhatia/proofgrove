import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DatasetRecordMetadata, MetadataJsonDialog } from "./dataset-record-metadata";

describe("dataset record metadata", () => {
  it("omits fields shown as columns while retaining the full JSON action", () => {
    const html = renderToStaticMarkup(createElement(DatasetRecordMetadata, {
      record: { inputs: {}, expectations: {}, tags: { risk: "Low", custom: "Visible" } },
      hiddenKeys: ["risk"], onViewJson: () => undefined, recordLabel: "record 2",
    }));
    expect(html).not.toContain("Low");
    expect(html).toContain("Visible");
    expect(html).toContain("View metadata JSON for record 2");
  });
  it("shows only metadata in JSON mode, preserving stored keys and values", () => {
    const html = renderToStaticMarkup(createElement(MetadataJsonDialog, {
      recordLabel: "Record 1", question: "", onClose: () => undefined,
      record: { inputs: { question: "Where?", context: "Europe" }, expectations: { expected_output: "Paris" }, tags: { risk: "Low", expected_authored_by: "reviewer" } },
    }));
    expect(html).toContain("Record metadata JSON");
    expect(html).toContain("expected_authored_by");
    expect(html).toContain("reviewer");
    expect(html).toContain("context");
    expect(html).not.toContain("Where?");
    expect(html).not.toContain("Paris");
    expect(html).not.toContain("Written by reviewer");
  });
  it("leads with readable provenance and keeps technical fields in a collapsed disclosure", () => {
    const html = renderToStaticMarkup(createElement(DatasetRecordMetadata, {
      record: { inputs: {}, expectations: {}, tags: {
        risk: "Low", domain: "Geography", expected_authored_by: "reviewer",
        source_run_id: "run-123", source_redacted: "true",
      } },
    }));
    expect(html).toContain("Written by reviewer");
    expect(html).toContain("Geography");
    expect(html).toContain("More details");
    expect(html).toContain('href="/runs/run-123"');
    expect(html).toContain("Source redacted");
    expect(html).toContain(">Yes<");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("expected_authored_by");
  });

  it("preserves false, zero, nested values and escaped long text", () => {
    const html = renderToStaticMarkup(createElement(DatasetRecordMetadata, {
      record: { inputs: { count: 0, enabled: false, context: { note: "<script>" + "x".repeat(500) } }, expectations: {}, tags: {} },
    }));
    expect(html).toContain(">0<");
    expect(html).toContain(">No<");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("x".repeat(500));
  });

  it("names the empty state without duplicating question or reference columns", () => {
    const html = renderToStaticMarkup(createElement(DatasetRecordMetadata, {
      record: { inputs: { question: "Where?" }, expectations: { expected_output: "Paris" }, tags: {} },
    }));
    expect(html).toContain("No metadata");
    expect(html).not.toContain("Paris");
  });
});
