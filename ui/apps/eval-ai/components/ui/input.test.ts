import { describe, expect, it } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Input, inputVariants } from "./input";
import { selectTriggerVariants } from "./select";

const classes = (value: string) => value.split(/\s+/);

describe("inputVariants", () => {
  it("keeps the Proofgrove 60px spec as the default size", () => {
    const defaulted = classes(inputVariants());
    expect(defaulted).toContain("h-[60px]");
    expect(defaulted).toContain("rounded-[12px]");
    expect(defaulted).toContain("border-2");
    expect(defaulted).toContain("text-base");
    // No size given must equal the explicit default so existing call sites do not change.
    expect(inputVariants()).toBe(inputVariants({ inputSize: "default" }));
  });

  it("provides a compact sm size for dense admin surfaces", () => {
    const sm = classes(inputVariants({ inputSize: "sm" }));
    expect(sm).toContain("h-11");
    expect(sm).toContain("rounded-lg");
    expect(sm).toContain("border");
    expect(sm).toContain("border-input");
    expect(sm).toContain("text-sm");
    expect(sm).not.toContain("h-[60px]");
    expect(sm).not.toContain("border-2");
  });
});

describe("selectTriggerVariants", () => {
  it("keeps the Proofgrove 60px spec as the default trigger size", () => {
    const defaulted = classes(selectTriggerVariants());
    expect(defaulted).toContain("h-[60px]");
    expect(defaulted).toContain("rounded-[12px]");
    expect(defaulted).toContain("border-2");
    expect(defaulted).toContain("text-base");
    expect(selectTriggerVariants()).toBe(selectTriggerVariants({ size: "default" }));
  });

  it("provides a compact sm trigger matching the sm input", () => {
    const sm = classes(selectTriggerVariants({ size: "sm" }));
    expect(sm).toContain("h-11");
    expect(sm).toContain("rounded-lg");
    expect(sm).toContain("border");
    expect(sm).toContain("border-input");
    expect(sm).toContain("text-sm");
    expect(sm).not.toContain("h-[60px]");
    expect(sm).not.toContain("border-2");
  });
});


it("keeps native input size separate from the visual size", () => {
  const html = renderToStaticMarkup(createElement(Input, { size: 12, inputSize: "sm" }));
  expect(html).toContain('size="12"');
  expect(html).toContain("h-11");
  expect(html).not.toContain("inputSize");
  for (const css of [inputVariants({ inputSize: "sm" }), selectTriggerVariants({ size: "sm" })]) {
    expect(classes(css)).toContain("focus-visible:outline-none");
    expect(classes(css)).not.toContain("outline-none");
    expect(css).not.toContain(" focus:");
  }
});
