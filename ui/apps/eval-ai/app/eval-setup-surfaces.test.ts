import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The evaluation setup screen has exactly two surface roles:
 *
 *   container  — the step card (`.panel`)
 *   option     — a selectable tile (`.eval-setup-choice`), whose border carries
 *                the selected state
 *
 * Everything between them separates with rules and space. This drifted once
 * already: `.eval-setup-inset`, `.eval-setup-choice` and a boxed disclosure all
 * ended up as a 1px border on `var(--card)`, differing only by corner radius, so
 * a card sat inside a card inside a card and nothing read as hierarchy — despite
 * globals.css already carrying a comment saying not to do that.
 */
const css = readFileSync(join(__dirname, "globals.css"), "utf8");

function ruleFor(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} is missing from globals.css`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("eval setup surfaces", () => {
  it("keeps grouping bands off the card surface", () => {
    const inset = ruleFor(".eval-setup-inset");
    // A band groups; it does not re-declare the surface its parent already is.
    expect(inset).not.toContain("background");
    expect(inset).not.toContain("border-radius");
    expect(inset).not.toMatch(/border:\s/);
  });

  it("keeps the selected-state border on choice tiles", () => {
    // The one place a border earns its keep: it is how selection is shown.
    const choice = ruleFor(".eval-setup-choice");
    expect(choice).toMatch(/border:\s/);
    expect(css).toContain('.eval-setup-choice[aria-checked="true"]');
  });

  it("leaves the step card as the only card surface", () => {
    const panel = ruleFor(".panel");
    expect(panel).toContain("background");
    expect(panel).toContain("border-radius");
  });
});
