import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LlmCatalogToolbar } from "@/components/catalog/llm-catalog-toolbar";

describe("LlmCatalogToolbar", () => {
  it("uses matching Proofgrove control heights for search and source filter", () => {
    const html = renderToStaticMarkup(
      createElement(LlmCatalogToolbar, {
        query: "",
        source: "all",
        onQueryChange: () => undefined,
        onSourceChange: () => undefined,
      }),
    );

    // 44px and a native select, like every other catalog toolbar. The 60px
    // pair with a Radix combobox matched nothing else in the app.
    expect(html).toMatch(/<input[^>]*h-11/);
    expect(html).toMatch(/<select[^>]*h-11/);
    expect(html).not.toContain('role="combobox"');
    expect(html).toContain('aria-label="Filter LLMs by source"');
    expect(html).toContain('name="model-search"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('placeholder="Search models…"');
    expect(html).toContain("All sources");
    expect(html).toContain("OpenAI");
    expect(html).toContain("Local Ollama");
    expect(html).not.toContain("Compass");
    expect(html).toContain('name="model-source"');
    expect(html).not.toContain("h-9");
  });
});
