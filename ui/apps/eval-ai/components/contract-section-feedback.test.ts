import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ContractSectionFeedback } from "./contract-section-feedback";

describe("ContractSectionFeedback", () => {
  it("announces successful operations without treating them as errors", () => {
    const html = renderToStaticMarkup(
      createElement(ContractSectionFeedback, {
        feedback: { tone: "success", message: "Project created." },
      }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Project created.");
  });

  it("uses alert semantics for operation errors", () => {
    const html = renderToStaticMarkup(
      createElement(ContractSectionFeedback, {
        feedback: { tone: "error", message: "Unable to create project." },
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Unable to create project.");
  });
});
