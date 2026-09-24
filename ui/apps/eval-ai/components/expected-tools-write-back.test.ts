import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ExpectedToolsWriteBack,
  recordExpectedTools,
  recordQuestion,
} from "./expected-tools-write-back";

const records = [
  {
    dataset_record_id: "r1",
    inputs: { question: "latest AAPL price?" },
    expectations: { expected_response: "AAPL is up 2%." },
    tags: {},
  },
  {
    dataset_record_id: "r2",
    inputs: { question: "summarise the filing" },
    expectations: {
      expected_response: "It is up.",
      expected_actions: "search(q='AAPL');summarize(text)",
    },
    tags: {},
  },
];

function render(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(ExpectedToolsWriteBack, {
      open: true,
      onOpenChange: vi.fn(),
      datasetName: "finance_qa",
      datasetStatus: "DRAFT",
      tools: ["search", "summarize"],
      records,
      selectedRecordIds: [],
      onToggleRecord: vi.fn(),
      onToggleAll: vi.fn(),
      createVersion: false,
      onCreateVersionChange: vi.fn(),
      onCommit: vi.fn(),
      ...overrides,
    } as never),
  );
}

describe("recordQuestion", () => {
  it("reads whichever input key the dataset used", () => {
    expect(recordQuestion({ inputs: { query: "q" }, expectations: {}, tags: {} })).toBe("q");
    expect(recordQuestion({ inputs: { prompt: "p" }, expectations: {}, tags: {} })).toBe("p");
    expect(recordQuestion({ inputs: {}, expectations: {}, tags: {} })).toBe("(no question)");
  });
});

describe("recordExpectedTools", () => {
  it("parses tool names the way the scorer does", () => {
    expect(
      recordExpectedTools({
        inputs: {},
        expectations: { expected_actions: "search(q='AAPL');summarize(text)" },
        tags: {},
      }),
    ).toEqual(["search", "summarize"]);
  });

  it("reports nothing when the row declares no actions", () => {
    expect(
      recordExpectedTools({ inputs: {}, expectations: { expected_response: "a" }, tags: {} }),
    ).toEqual([]);
  });
});

describe("ExpectedToolsWriteBack", () => {
  it("renders nothing while closed", () => {
    expect(render({ open: false })).toBe("");
  });

  it("separates the row expectation from run scoping in what it tells the operator", () => {
    const html = render();
    expect(html).toContain("different claim from scoping this run");
    expect(html).toContain("Rows you leave unticked are not changed");
  });

  it("shows which rows already carry an expectation and which are ungradeable", () => {
    const html = render();
    expect(html).toContain("latest AAPL price?");
    expect(html).toContain("nothing — tool metrics not gradeable");
    expect(html).toContain("search, summarize");
  });

  it("will not commit with no rows chosen", () => {
    const html = render({ selectedRecordIds: [] });
    expect(html).toContain("disabled");
    expect(html).toContain("Write to 0 rows");
  });

  it("counts the chosen rows on the commit action", () => {
    expect(render({ selectedRecordIds: ["r1"] })).toContain("Write to 1 row");
    expect(render({ selectedRecordIds: ["r1", "r2"] })).toContain("Write to 2 rows");
  });

  it("blocks an immutable dataset until branching is opted into", () => {
    const html = render({ datasetStatus: "PUBLISHED", selectedRecordIds: ["r1"] });
    expect(html).toContain("is PUBLISHED and cannot");
    expect(html).toContain("Copy it into a new draft version");
    // The commit control stays disabled while the opt-in is unticked.
    expect(html).toContain("disabled");
  });

  it("offers the branching commit once the operator opts in", () => {
    const html = render({
      datasetStatus: "PUBLISHED",
      selectedRecordIds: ["r1"],
      createVersion: true,
    });
    expect(html).toContain("Create version and write");
  });

  it("says so when there is no tool selection to write", () => {
    const html = render({ tools: [] });
    expect(html).toContain("no tools are selected".replace(/^./, (c) => c.toUpperCase()));
  });

  it("reports where a committed write landed, including a new version", () => {
    const html = render({
      result: {
        dataset_name: "finance_qa_v2",
        annotated: 2,
        tools: ["search"],
        created_version: true,
        source_dataset_name: "finance_qa",
        version_number: 2,
        status: "DRAFT",
      },
    });
    // The heading has to move on too — editing language over a finished
    // outcome read as though the write had not happened.
    expect(html).toContain("Expected tools written — one step left");
    expect(html).not.toContain("Set expected tools on dataset rows");
    // Closing here abandons an unpublished draft, so the label says so.
    expect(html).toContain("Close without publishing");
    expect(html).toContain("Created draft version finance_qa_v2");
    expect(html).toContain("2 rows now declare these expected tools");
    // The editing surface is gone: a picker for the ORIGINAL dataset beside a
    // success message about a new draft was the confusing part.
    expect(html).not.toContain("Rows to annotate");
    expect(html).not.toContain("Write to 0 rows");
  });

  it("offers to publish the draft rather than sending the operator away", () => {
    // Editing needs DRAFT and evaluating needs PUBLISHED, so a draft the
    // operator cannot publish from here means abandoning the run they came to
    // configure.
    const html = render({
      result: {
        dataset_name: "finance_qa_v2",
        annotated: 1,
        tools: ["search"],
        created_version: true,
        source_dataset_name: "finance_qa",
        version_number: 2,
        status: "DRAFT",
      },
      onPublishVersion: () => {},
    });
    expect(html).toContain("A draft cannot be evaluated yet");
    expect(html).toContain("Publish this version and use it for this run");
  });

  it("states plainly that the run was retargeted once published", () => {
    const html = render({
      result: {
        dataset_name: "finance_qa_v2",
        annotated: 1,
        tools: ["search"],
        created_version: true,
        source_dataset_name: "finance_qa",
        version_number: 2,
        status: "DRAFT",
      },
      publishState: "published",
    });
    expect(html).toContain("Expected tools are live for this run");
    expect(html).toContain("Close");
    expect(html).not.toContain("Close without publishing");
    expect(html).toContain("This run now evaluates");
    expect(html).toContain("finance_qa_v2");
    expect(html).not.toContain("Publish this version");
  });

  it("shows which governed step refused, rather than a generic failure", () => {
    const html = render({
      result: {
        dataset_name: "finance_qa_v2",
        annotated: 1,
        tools: ["search"],
        created_version: true,
        source_dataset_name: "finance_qa",
        version_number: 2,
        status: "DRAFT",
      },
      onPublishVersion: () => {},
      publishSteps: [
        { label: "Validate", ok: false, detail: "expected output missing on 1 row" },
      ],
    });
    expect(html).toContain("Validate");
    expect(html).toContain("expected output missing on 1 row");
    expect(html).toContain("Try publishing again");
    // The ✗ and the red text are both invisible to a screen reader, so the
    // outcome is a word as well.
    expect(html).toContain("Failed:");
    // Steps arrive one at a time during an async operation, so they announce.
    expect(html).toContain('aria-live="polite"');
  });

  it("blocks every close path while a write is in flight", () => {
    // Closing mid-write lets the dataset change underneath an in-flight
    // request, so a stale response can land against the wrong dataset.
    const html = render({ busy: true, selectedRecordIds: ["r1"] });
    const closeButtons = html.match(/Close/g) ?? [];
    expect(closeButtons.length).toBeGreaterThan(0);
    // Both the header close and the footer close carry the disabled attribute.
    expect(html.match(/disabled=""/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("surfaces an error to the operator", () => {
    const html = render({ error: "Could not write the expected tools." });
    expect(html).toContain("Could not write the expected tools.");
    expect(html).toContain('role="alert"');
  });

  it("explains an empty dataset rather than showing a bare table", () => {
    const html = render({ records: [] });
    expect(html).toContain("no rows to annotate");
  });

  it("cannot fork a second time: the opt-in is gone once a version exists", () => {
    const html = render({
      datasetStatus: "PUBLISHED",
      createVersion: true,
      result: {
        dataset_name: "ds_v2",
        annotated: 1,
        tools: ["search"],
        created_version: true,
        source_dataset_name: "ds",
        version_number: 2,
        status: "DRAFT",
      },
    });
    expect(html).not.toContain("Copy it into a new draft version");
    expect(html).not.toContain("Create version and write");
  });
});
