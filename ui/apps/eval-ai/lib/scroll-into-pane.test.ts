/** @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";

import { scrollIntoPane } from "./scroll-into-pane";

function pane(): { pane: HTMLElement; target: HTMLElement } {
  document.body.innerHTML = "";
  const paneElement = document.createElement("div");
  paneElement.className = "eval-hub-workspace-scroll";
  const target = document.createElement("div");
  paneElement.append(target);
  document.body.append(paneElement);
  return { pane: paneElement, target };
}

describe("scrollIntoPane", () => {
  it("scrolls the pane instead of every scrollable ancestor", () => {
    const { pane: paneElement, target } = pane();
    paneElement.scrollTo = vi.fn() as unknown as typeof paneElement.scrollTo;
    target.scrollIntoView = vi.fn();

    scrollIntoPane(target);

    // The native call would also scroll the document, which `overflow: hidden`
    // does not prevent — that is what pushed the shell out of view.
    expect(paneElement.scrollTo).toHaveBeenCalled();
    expect(target.scrollIntoView).not.toHaveBeenCalled();
  });

  it("falls back to the native call outside a pane", () => {
    document.body.innerHTML = "";
    const loose = document.createElement("div");
    loose.scrollIntoView = vi.fn();
    document.body.append(loose);

    scrollIntoPane(loose);

    expect(loose.scrollIntoView).toHaveBeenCalled();
  });

  it("does nothing without an element", () => {
    expect(() => scrollIntoPane(null)).not.toThrow();
  });
});

describe("offsets", () => {
  it("subtracts the element's scroll margin and the pane's scroll padding", () => {
    const { pane: paneElement, target } = pane();
    target.style.scrollMarginTop = "24px";
    paneElement.style.scrollPaddingTop = "8px";
    // jsdom zeroes every rect, so stub them to place the target 100px down.
    paneElement.getBoundingClientRect = (() => ({ top: 0, height: 500 })) as never;
    target.getBoundingClientRect = (() => ({ top: 100, height: 40 })) as never;
    const calls: { top: number }[] = [];
    paneElement.scrollTo = ((opts: { top: number }) => calls.push(opts)) as unknown as typeof paneElement.scrollTo;

    scrollIntoPane(target, { block: "start" });

    // 100 offset − 24 scroll-margin − 8 scroll-padding. Dropping either, as the
    // hand-rolled maths did, lands the heading flush or behind the sticky bar.
    expect(calls).toHaveLength(1);
    expect(calls[0].top).toBe(68);
  });
});
