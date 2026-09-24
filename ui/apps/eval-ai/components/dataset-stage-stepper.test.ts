import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DatasetStageStepper } from "./dataset-stage-stepper";

describe("DatasetStageStepper", () => {
  it("shows one clean primary lifecycle without a permanent rejection branch", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetStageStepper, { status: "VALIDATED" }),
    );

    expect(html).toContain("Draft");
    expect(html).toContain("Validated");
    expect(html).toContain("Approved");
    expect(html).toContain("Published");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("sm:grid-cols-4");
    expect(html).toContain('<div class="w-full"');
    expect(html).not.toContain("max-w-3xl");
    expect(html).not.toContain(">Reject<");
    expect(html).not.toContain(">|<");
    expect(html).not.toContain("overflow-x");
  });

  it("surfaces rejection only as the current review outcome", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetStageStepper, { status: "REJECTED" }),
    );

    expect(html).toContain("Changes requested during review");
    expect(html).toContain('aria-current="step"');
    expect(html).not.toContain(">Reject<");
  });

  it("renders the published stage as completed while keeping it current", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetStageStepper, { status: "PUBLISHED" }),
    );

    expect(html).toMatch(
      /<li aria-current="step"[^>]*>.*lucide-check.*Published.*Current stage<\/span><\/li>/,
    );
    expect(html).not.toMatch(/<li aria-current="step"[^>]*>.*>4<.*Published/);
  });
});
