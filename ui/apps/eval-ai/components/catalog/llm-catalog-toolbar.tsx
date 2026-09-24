"use client";


import type { LlmSource } from "@/lib/api";
import { CatalogToolbar, FilterSelect, SearchField } from "@/components/toolbar";

const SOURCE_LABELS: Record<"all" | LlmSource, string> = {
  all: "All sources",
  openai: "OpenAI",
  ollama: "Local Ollama",
  compass: "OpenAI-compatible gateway",
  custom: "Custom endpoint",
};

export function LlmCatalogToolbar({
  query,
  source,
  onQueryChange,
  onSourceChange,
}: {
  query: string;
  source: "all" | LlmSource;
  onQueryChange: (value: string) => void;
  onSourceChange: (value: "all" | LlmSource) => void;
}) {
  return (
    // The shared row, not a bordered card of its own floating above the list:
    // that read as a second panel for one control pair, and its 60px search and
    // Radix select matched nothing else in the catalog.
    <CatalogToolbar>
      <SearchField
        name="model-search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search models…"
        label="Search LLMs"
      />
      <FilterSelect
        name="model-source"
        label="Filter LLMs by source"
        value={source}
        onChange={(event) => onSourceChange(event.target.value as "all" | LlmSource)}
      >
        {Object.entries(SOURCE_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </FilterSelect>
    </CatalogToolbar>
  );
}
