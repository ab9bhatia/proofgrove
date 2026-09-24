import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LlmFormDialog } from "@/components/catalog/llm-form-dialog";

function props(overrides = {}) {
  return {
    modelId: "",
    displayName: "",
    endpoint: "",
    description: "",
    saving: false,
    error: null,
    onModelIdChange: vi.fn(),
    onDisplayNameChange: vi.fn(),
    onEndpointChange: vi.fn(),
    onDescriptionChange: vi.fn(),
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe("LlmFormDialog", () => {
  it("renders custom LLM onboarding as a modal dialog", () => {
    const html = renderToStaticMarkup(createElement(LlmFormDialog, props()));

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="new-llm-form-title"');
    expect(html).toContain('aria-describedby="new-llm-form-hint"');
    expect(html).toContain("w-[min(44rem,calc(100vw-2rem))]");
    expect(html).toContain("max-h-[60vh]");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("New LLM");
    expect(html).toContain("Model id");
    expect(html).toContain("OpenAI-compatible base URL");
    expect(html).toContain("Cancel");
    expect(html).toContain("Add custom LLM");
  });
});
