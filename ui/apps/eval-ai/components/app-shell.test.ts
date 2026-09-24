import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./sidebar", () => ({ Sidebar: () => createElement("aside") }));

import { AppShell } from "./app-shell";

describe("AppShell", () => {
  it("contains document scrolling inside the viewport-height main pane", () => {
    const html = renderToStaticMarkup(createElement(AppShell, null, "content"));

    // Structure only. The shell's background is a design choice that has changed
    // and will again; what must not change is that the shell is exactly one
    // viewport tall and clips, so scrolling happens in the main pane below.
    // dvh rather than svh: svh is the viewport at its smallest — as if every
    // dynamic browser toolbar were shown — so the frame could stop short of what
    // the user can actually see.
    expect(html).toContain("flex h-dvh overflow-hidden");
    // Not anchored to the start of the attribute: the pane legitimately gains
    // utility classes ahead of these, and pinning position makes the guard fail
    // for a reason that has nothing to do with scrolling.
    expect(html).toContain("min-h-0 min-w-0 flex-1 overflow-auto overscroll-none");
  });
});
