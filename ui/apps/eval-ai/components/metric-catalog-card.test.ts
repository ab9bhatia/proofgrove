import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MetricCatalogEntry } from "@/lib/api";
import { MetricCatalogCard } from "./metric-catalog-card";

const metric: MetricCatalogEntry = {
  metric_id: "rag.context_sufficiency",
  name: "Context Sufficiency",
  description: "Checks whether the retrieved context contains enough evidence to answer.",
  scenario: "rag",
  scoring_type: "continuous_score",
  requires_ground_truth: true,
};

describe("MetricCatalogCard", () => {
  it("keeps the decision-making metadata readable in a compact card", () => {
    const html = renderToStaticMarkup(createElement(MetricCatalogCard, { metric }));

    expect(html).toContain('aria-label="Applies to RAG"');
    expect(html).toContain("Context Sufficiency");
    expect(html).toContain("rag.context_sufficiency");
    expect(html).toContain("Scoring");
    expect(html).toContain("continuous score");
    expect(html).toContain("Ground truth");
    expect(html).toContain("Required");
    expect(html).not.toContain("Evaluation type");
  });

  it("labels cross-scenario metrics as shared and avoids implying ground truth is needed", () => {
    const sharedMetric: MetricCatalogEntry = {
      ...metric,
      metric_id: "ops.latency",
      name: "Latency",
      scenario: null,
      requires_ground_truth: false,
    };
    const html = renderToStaticMarkup(createElement(MetricCatalogCard, { metric: sharedMetric }));

    expect(html).toContain('aria-label="Applies to Shared"');
    expect(html).toContain("Not required");
  });

  it("labels catalogued batch metrics without implying inline run support", () => {
    const batchMetric: MetricCatalogEntry = {
      ...metric,
      metric_id: "safety.indirect_attack",
      name: "Indirect Attack",
      scenario: null,
      execution_mode: "batch",
      available_in_run: false,
    };
    const html = renderToStaticMarkup(createElement(MetricCatalogCard, { metric: batchMetric }));

    expect(html).toContain("Batch only");
  });
});
