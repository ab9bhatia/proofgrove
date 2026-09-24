import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MetricCatalogEntry } from "@/lib/api";
import { MetricCatalogFilters } from "@/components/catalog/metric-catalog-filters";

const baseMetric = {
  description: "Metric description",
  scoring_type: "scale",
  requires_ground_truth: false,
} as const;

const metrics: MetricCatalogEntry[] = [
  { ...baseMetric, metric_id: "llm.correctness", name: "Correctness", scenario: "llm_core" },
  { ...baseMetric, metric_id: "rag.groundedness", name: "Groundedness", scenario: "rag" },
  { ...baseMetric, metric_id: "agent.task", name: "Task", scenario: "agentic" },
  { ...baseMetric, metric_id: "shared.safety", name: "Safety", scenario: null },
];

describe("MetricCatalogFilters", () => {
  it("uses the shared control height and counts shared metrics in every family", () => {
    const html = renderToStaticMarkup(
      createElement(MetricCatalogFilters, {
        metrics,
        query: "",
        scenario: "llm_core",
        onQueryChange: () => undefined,
        onScenarioChange: () => undefined,
      }),
    );

    // 44px, matching the tabs beside it and every other catalog toolbar. The
    // 60px field was this page's alone.
    expect(html).toMatch(/<input[^>]*h-11/);
    expect(html).toContain('aria-label="Filter metrics by evaluation type"');
    // The selected family is marked selected and carries its count; the exact
    // element nesting is the shared FilterTabs' business, not this test's.
    expect(html).toMatch(/aria-pressed="true"[\s\S]*?LLM[\s\S]*?2/);
    // A shared metric counts in every family it applies to.
    expect(html).toMatch(/RAG[\s\S]{0,120}?2/);
    expect(html).toMatch(/Agent[\s\S]{0,120}?2/);
    expect(html).toMatch(/All[\s\S]{0,120}?4/);
  });
});

describe("filter row layout", () => {
  it("keeps the count explanation out of the control row", () => {
    // Placed as a flex item beside the search field and tabs, the explanation
    // claimed the whole row and collapsed the search field to its icon.
    const html = renderToStaticMarkup(
      createElement(MetricCatalogFilters, {
        metrics,
        query: "",
        scenario: "all",
        onQueryChange: () => undefined,
        onScenarioChange: () => undefined,
      }),
    );

    const rowStart = html.indexOf('<div class="flex flex-wrap items-center gap-2');
    const hint = html.indexOf("counted under every tab");
    expect(rowStart).toBeGreaterThan(-1);
    expect(hint).toBeGreaterThan(-1);

    // The control row closes before the hint begins, so the hint is a sibling of
    // the row rather than a third item competing with it for width.
    const rowCloses = html.lastIndexOf("</div>", hint);
    expect(rowCloses).toBeGreaterThan(rowStart);
    // The class that caused it: full basis on a non-wrapping row.
    expect(html).not.toContain("basis-full");
  });
});
