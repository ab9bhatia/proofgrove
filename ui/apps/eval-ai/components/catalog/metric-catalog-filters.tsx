"use client";


import { SegmentedControl } from "@/components/toolbar";
import type { MetricCatalogEntry } from "@/lib/api";
import { CatalogToolbar, SearchField } from "@/components/toolbar";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "llm_core", label: "LLM" },
  { value: "rag", label: "RAG" },
  { value: "agentic", label: "Agent" },
] as const;

export function MetricCatalogFilters({
  metrics,
  query,
  scenario,
  onQueryChange,
  onScenarioChange,
}: {
  metrics: MetricCatalogEntry[];
  query: string;
  scenario: string;
  onQueryChange: (value: string) => void;
  onScenarioChange: (value: string) => void;
}) {
  return (
    // The shared row inside one card, at the shared 44px — it was a bordered box
    // with a 60px search, the same drift the LLM toolbar had. The grid below is
    // cards rather than a list, so the row keeps its own card; the shape and the
    // control heights are what have to match.
    <div className="border-b">
      <CatalogToolbar>
        <SearchField
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search metrics…"
          label="Search metrics"
        />
        <SegmentedControl
          label="Filter metrics by evaluation type"
          value={scenario}
          onChange={(next) => onScenarioChange(next as typeof scenario)}
          options={FILTERS.map((filter) => ({
            value: filter.value,
            label: `${filter.label} (${metrics.filter(
              (metric) =>
                filter.value === "all" || !metric.scenario || metric.scenario === filter.value,
            ).length})`,
          }))}
        />
      </CatalogToolbar>
      {/*
        A metric with no scenario applies to every evaluation type, so it is
        counted under each tab and the tabs deliberately sum to more than the
        catalog holds. Unexplained, that reads as a bug in the counts.
      */}
      <p className="px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
        Metrics that apply to any evaluation type are counted under every tab.
      </p>
    </div>
  );
}
