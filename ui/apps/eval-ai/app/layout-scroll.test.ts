import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

describe("application scroll containment", () => {
  it("keeps document scrolling inside the application shell", () => {
    expect(css).toMatch(/html,\s*body\s*{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
  });
});

describe("the shell fills the visible viewport", () => {
  const shell = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
  const sidebar = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");

  it("sizes the frame to the dynamic viewport, not the smallest one", () => {
    // `svh` is the viewport at its smallest — as if every dynamic browser toolbar
    // were shown. On a window with static chrome that is shorter than what the user
    // can see, so the frame stopped early and left bare background beneath it.
    expect(shell).toContain("h-dvh");
    expect(shell).not.toContain("h-svh");
    expect(sidebar).toContain("h-dvh");
    expect(sidebar).not.toContain("h-svh");
  });

  it("applies scroll padding to the pane that actually scrolls", () => {
    // The document cannot scroll (see above), so scroll-padding on `html` never
    // did anything; the browser honours it on the scrolling container.
    const rule = css.slice(css.indexOf("scroll-padding-bottom") - 400, css.indexOf("scroll-padding-bottom"));
    expect(rule).toContain(".eval-hub-workspace-scroll");
  });
});
