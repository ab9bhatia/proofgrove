import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Chip, ToneBadge } from "@/components/status-badge";
import { FilterSelect, SearchField, Toolbar, filterSelectClass } from "@/components/toolbar";

describe("SearchField", () => {
  it("names itself and declares search semantics", () => {
    // The icon is decorative, so the label prop is the only accessible name a
    // search input gets. Both of these regressed across the app before the
    // primitive existed.
    const html = renderToStaticMarkup(
      createElement(SearchField, { label: "Search captured traces", value: "", onChange: () => {} }),
    );
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Search captured traces"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("uses the compact control height, not a hand-rolled one", () => {
    const html = renderToStaticMarkup(
      createElement(SearchField, { label: "Search", value: "", onChange: () => {} }),
    );
    // h-11 is the design system's `sm` input: 44px, the minimum touch target.
    // The call sites this replaced used h-9.
    expect(html).toContain("h-11");
  });

  it("turns off native search-field chrome so the 8px radius token wins", () => {
    // WebKit renders `type="search"` as a pill regardless of `rounded-lg`
    // unless appearance is off — this is what made search fields look like a
    // different control from every other input in the design system.
    const html = renderToStaticMarkup(
      createElement(SearchField, { label: "Search", value: "", onChange: () => {} }),
    );
    expect(html).toContain("appearance-none");
  });
});

describe("FilterSelect", () => {
  it("names itself and renders its options", () => {
    const html = renderToStaticMarkup(
      createElement(
        FilterSelect,
        { label: "Filter by outcome", value: "error", onChange: () => {} },
        createElement("option", { value: "" }, "All"),
        createElement("option", { value: "error" }, "Error"),
      ),
    );
    expect(html).toContain('aria-label="Filter by outcome"');
    expect(html).toContain(">Error</option>");
  });

  it("shares one class with form selects that label themselves", () => {
    // Form selects keep their visible <label htmlFor> and take the class alone,
    // so they are not announced twice. Both paths must style identically.
    const html = renderToStaticMarkup(
      createElement(FilterSelect, { label: "Filter", onChange: () => {}, value: "" }),
    );
    for (const token of filterSelectClass.split(" ")) {
      expect(html).toContain(token);
    }
  });
});

describe("Toolbar", () => {
  it("wraps its controls on one row", () => {
    const html = renderToStaticMarkup(
      createElement(Toolbar, {}, createElement("button", {}, "Reset")),
    );
    expect(html).toContain("flex-wrap");
    expect(html).toContain(">Reset</button>");
  });
});

describe("badges", () => {
  it("gives outcome colour to ToneBadge only", () => {
    const failing = renderToStaticMarkup(createElement(ToneBadge, { tone: "fail" }, "Error"));
    expect(failing).toContain("text-gate-fail");

    // A Chip is metadata. It never earns a gate colour, which is what kept the
    // trace row from having a single thing to look at.
    const chip = renderToStaticMarkup(createElement(Chip, {}, "llm"));
    expect(chip).not.toContain("gate-");
    expect(chip).toContain("text-muted-foreground");
  });

  it("draws every pill at one size", () => {
    const tone = renderToStaticMarkup(createElement(ToneBadge, { tone: "neutral" }, "x"));
    const chip = renderToStaticMarkup(createElement(Chip, {}, "x"));
    for (const token of ["rounded-full", "px-2", "py-0.5", "text-xs"]) {
      expect(tone).toContain(token);
      expect(chip).toContain(token);
    }
  });
});
