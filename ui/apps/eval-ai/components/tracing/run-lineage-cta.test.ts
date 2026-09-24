import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RUN_REPORT_LINEAGE_LABEL,
  RUN_UNREADABLE_EXPLANATION,
  RunLineageCta,
  readabilityForTrace,
  runReportLineageHref,
} from "./run-lineage-cta";

describe("runReportLineageHref", () => {
  it("builds a run report link with the case item param", () => {
    expect(runReportLineageHref("run/abc", "case 1")).toBe(
      "/runs/run%2Fabc?item=case%201",
    );
  });
});

describe("RunLineageCta", () => {
  it("renders an Open run report link with item when readable", () => {
    const html = renderToStaticMarkup(
      createElement(RunLineageCta, {
        runId: "run-1",
        exampleId: "case-9",
        readable: true,
      }),
    );
    expect(html).toContain(RUN_REPORT_LINEAGE_LABEL);
    expect(html).toContain('href="/runs/run-1?item=case-9"');
    expect(html).not.toContain(RUN_UNREADABLE_EXPLANATION);
  });

  it("renders nothing while readability is unresolved", () => {
    const html = renderToStaticMarkup(
      createElement(RunLineageCta, {
        runId: "run-1",
        exampleId: "case-9",
        readable: null,
      }),
    );
    expect(html).toBe("");
  });

  it("renders copyable run id and explanation when unreadable", () => {
    const html = renderToStaticMarkup(
      createElement(RunLineageCta, {
        runId: "run-other-tenant",
        exampleId: "case-9",
        readable: false,
      }),
    );
    expect(html).not.toContain('href="/runs/');
    expect(html).not.toContain(RUN_REPORT_LINEAGE_LABEL);
    expect(html).toContain("run-other-tenant");
    expect(html).toContain(RUN_UNREADABLE_EXPLANATION);
    expect(html).toContain("Copy run ID");
  });
});

/**
 * The trace drawer keeps its header mounted across trace switches, so a
 * readability result from the previous trace must not be reused for the next.
 */
describe("readabilityForTrace", () => {
  it("resolves only for the trace it was recorded against", () => {
    expect(readabilityForTrace("trace-2", { traceId: "trace-2", readable: true })).toBe(true);
    expect(readabilityForTrace("trace-2", { traceId: "trace-2", readable: false })).toBe(false);
  });

  it("stays unresolved for a stale result or before any result", () => {
    expect(readabilityForTrace("trace-2", { traceId: "trace-1", readable: true })).toBeNull();
    expect(readabilityForTrace("trace-2", null)).toBeNull();
  });
});
