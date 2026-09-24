import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AgentFormDialog } from "@/components/catalog/agent-form-dialog";

describe("AgentFormDialog", () => {
  it("renders the agent onboarding flow as a modal dialog", () => {
    const html = renderToStaticMarkup(
      createElement(AgentFormDialog, {
        endpoint: "",
        testing: false,
        error: null,
        onEndpointChange: vi.fn(),
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="new-agent-form-title"');
    expect(html).toContain('aria-describedby="new-agent-form-hint"');
    expect(html).toContain("w-[min(36rem,calc(100vw-2rem))]");
    expect(html).toContain("max-h-[60vh]");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("New agent");
    expect(html).toContain("Agent system endpoint");
    expect(html).toContain("Cancel");
    expect(html).toContain("Test and add");
  });
});
