import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EvalHubGatePanel } from "./eval-hub-gate";

const noop = () => undefined;

describe("eval hub gate panel", () => {
  it("constrains the card so copy wraps instead of clipping at small widths", () => {
    const html = renderToStaticMarkup(
      createElement(EvalHubGatePanel, {
        state: "session-expired",
        onRetry: noop,
        onSignInAgain: noop,
      }),
    );

    // The container can shrink below its content's intrinsic width and never
    // exceeds the viewport: no horizontal overflow at 390px.
    expect(html).toContain("w-full min-w-0 max-w-lg");
    expect(html).toContain("px-4");
    // Title and description always wrap.
    const breakWordsCount = html.split("break-words").length - 1;
    expect(breakWordsCount).toBeGreaterThanOrEqual(2);
    // The wrapping constraint, not the typography: type scale is a design choice,
    // but a heading that cannot shrink or wrap clips its copy at 390px.
    expect(html).toContain("max-w-full break-words font-display");
    expect(html).toContain("max-w-full break-words text-sm text-muted-foreground");
  });

  it("stacks the action buttons vertically on small screens and rows them from sm: up", () => {
    const html = renderToStaticMarkup(
      createElement(EvalHubGatePanel, {
        state: "session-expired",
        onRetry: noop,
        onSignInAgain: noop,
      }),
    );

    expect(html).toContain("flex-col items-stretch");
    expect(html).toContain("sm:flex-row");
    expect(html).toContain("sm:flex-wrap");
    // Both actions are present with centered content when stretched full-width.
    expect(html).toContain("Sign in again");
    expect(html).toContain("Retry");
    expect(html).toContain("justify-center");
  });

  it("keeps auto-recovering states informational with wrapped status text", () => {
    const html = renderToStaticMarkup(
      createElement(EvalHubGatePanel, {
        state: "offline",
        onRetry: noop,
        onSignInAgain: noop,
      }),
    );

    expect(html).toContain("Checking for the service…");
    expect(html).toContain("break-words");
    expect(html).not.toContain("Sign in again");
  });
});
