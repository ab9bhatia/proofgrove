import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LlmCatalogEntry } from "@/lib/api";
import { LlmCatalogList } from "@/components/catalog/llm-catalog-list";

const models: LlmCatalogEntry[] = [
  {
    model_id: "gpt-5.4",
    name: "gpt-5.4",
    source: "compass",
    description: "Available through the Proofgrove AI Gateway.",
    endpoint: "http://ai-gateway.example.test/v1",
  },
  {
    model_id: "custom/support-model",
    name: "Support model",
    source: "custom",
    description: "Fine-tuned for support responses.",
    endpoint: "https://models.example.test/v1",
  },
];

describe("LlmCatalogList", () => {
  it("leads with the model and provider before disclosure details", () => {
    const html = renderToStaticMarkup(
      createElement(LlmCatalogList, { models, highlightedModelId: "gpt-5.4" }),
    );

    expect(html).toContain('aria-label="Available LLMs"');
    expect(html).toContain('role="listitem"');
    expect(html).toContain(">Model<");
    expect(html).toContain(">Provider<");
    expect(html).toContain(">Endpoint<");
    expect(html).toContain(">Details<");
    expect(html).toContain("gpt-5.4");
    expect(html).not.toMatch(/<p[^>]*>gpt-5\.4<\/p>/);
    expect(html).toContain("Support model");
    expect(html).toMatch(/<p[^>]*translate="no"[^>]*>custom\/support-model<\/p>/);
    expect(html).toContain("OpenAI-compatible gateway");
    expect(html).not.toContain("Compass");
    expect(html).toContain("Custom");
    expect(html.indexOf("Support model")).toBeLessThan(html.indexOf("https://models.example.test/v1"));
    expect(html).toContain("Available through the Proofgrove AI Gateway.");
    expect(html).toContain("https://models.example.test/v1");
    expect(html).toContain("min-h-11");
    expect(html).toContain("focus-visible:ring");
    expect(html).toContain("overflow-x-auto");
  });
});
