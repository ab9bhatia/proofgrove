import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// DatasetLibrary now owns its own URL state (useSearchParams/useRouter), so a
// static render needs a router even before any data has loaded.
vi.mock("next/navigation", () => ({
  usePathname: () => "/datasets",
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

import { DatasetsList } from "./page";

describe("DatasetsList", () => {
  it("puts the primary action in the page header, not a launcher card", () => {
    const html = renderToStaticMarkup(createElement(DatasetsList));

    expect(html).toContain(">Golden dataset<");
    expect(html).toContain('aria-label="Refresh datasets"');
    expect(html).toMatch(/<button[^>]*>[\s\S]*?Add dataset<\/button>/);
    // The "Add evaluation dataset" launcher card is gone: the header button
    // is the only entry point now, and the form starts closed.
    expect(html).not.toContain("Add evaluation dataset");
    expect(html).not.toContain("Generate evaluation cases or import an existing CSV.");
  });
});
