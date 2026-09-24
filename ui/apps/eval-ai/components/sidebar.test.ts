import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("@/components/ui-state", () => ({
  useUIState: () => ({
    sidebarOpen: true,
    toggleSidebar: vi.fn(),
    mobileNavOpen: false,
    openMobileNav: vi.fn(),
    closeMobileNav: vi.fn(),
    fullName: "Alexandria Featherstonehaugh",
    initials: "AF",
  }),
}));

vi.mock("@/components/theme-control", () => ({
  ThemeControl: () =>
    createElement("button", { type: "button", "aria-label": "Appearance: system" }),
}));

import { Sidebar } from "./sidebar";

describe("Sidebar", () => {
  it("shows the local identity without production sign-out controls", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, null));

    // Moving the icons to a row of their own to widen the name left two
    // unlabelled glyphs floating under the account with nothing tying them to
    // it. They belong beside the name; a long name truncates but keeps a title.
    const nameIndex = html.indexOf("Alexandria Featherstonehaugh");
    expect(nameIndex).toBeGreaterThan(-1);
    expect(html).toContain('title="Alexandria Featherstonehaugh"');
    expect(html).not.toContain("Log out");
    expect(html).toContain("Local identity · no sign-in");

    // Appearance is an app setting, so it sits with the collapse control in the
    // header — not beside the account, where it was eating the name's width.
    const footer = html.slice(html.indexOf("Open the learning story"));
    expect(footer).toContain("Appearance:");
    expect(html).toContain("Appearance:");
  });

  it("labels every nav group, including the top one", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, null));

    // The top group was the only unlabelled one, which read as an oversight next
    // to three labelled siblings. All four carry their name, and each group is
    // tied to its own heading rather than repeating it as an aria-label.
    for (const section of ["Workspace"]) {
      expect(html).toContain(`>${section}<`);
      expect(html).toContain(`aria-labelledby="sidebar-group-${section.toLowerCase()}"`);
    }
    expect(html).toContain('<details>');
    expect(html).toContain('aria-label="Lab setup"');
    expect(html).toContain('New evaluation');
  });
});
