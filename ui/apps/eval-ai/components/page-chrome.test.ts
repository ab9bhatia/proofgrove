import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PageHeader } from "./page-header";
import { EmptyState, ErrorState, LoadingState } from "./page-state";

describe("page chrome", () => {
  it("renders one semantic page heading with supporting context", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, {
        section: "Workspace",
        title: "Overview",
        description: "Evaluation activity for this workspace.",
      }),
    );

    expect(html).toContain("<h1");
    expect(html).toContain("Overview");
    expect(html).toContain("Evaluation activity for this workspace.");
  });

  it("renders the section eyebrow in the brand's secondary accent", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, { section: "Configure", title: "Prompts" }),
    );

    // Purple is the brand's secondary accent and eyebrows on light are one of
    // its named jobs — alongside data and the focus ring. Recolouring it to
    // muted slate on the theory that one hue was doing too much was a drift
    // from the design system, not a fix, and that still holds.
    //
    // `--eyebrow` is not that drift: same hue, darkened for light only, because
    // #ae74ff measured 2.96:1 against #fbf8ff and this text is small, bold and
    // uppercase. Dark mode keeps #ae74ff, where it already measures 5.3:1. If
    // this assertion ever fails because the class went slate or muted, that is
    // the original drift and should be reverted.
    expect(html).toContain("text-eyebrow");
  });

  it("keeps the title/divider consistent regardless of section", () => {
    const withSection = renderToStaticMarkup(
      createElement(PageHeader, { section: "Evaluate", title: "Evaluations" }),
    );
    const withoutSection = renderToStaticMarkup(
      createElement(PageHeader, { title: "New evaluation contract" }),
    );

    // The divider and title size are baked into the header, not opted into per
    // page — so the two renders must agree apart from the eyebrow itself.
    expect(withSection).toContain("border-b");
    expect(withSection).toContain("text-3xl");
    expect(withSection.replace(/<p[^>]*>Evaluate<\/p>/, "").replace("Evaluations", "New evaluation contract"))
      .toBe(withoutSection);
  });

  it("announces loading and error states while keeping empty states descriptive", () => {
    const loading = renderToStaticMarkup(createElement(LoadingState, { label: "Loading runs…" }));
    const error = renderToStaticMarkup(
      createElement(ErrorState, { message: "The service did not respond." }),
    );
    const empty = renderToStaticMarkup(
      createElement(EmptyState, { title: "No runs yet", description: "Start an evaluation." }),
    );

    expect(loading).toContain('role="status"');
    expect(loading).toContain("Loading runs…");
    expect(error).toContain('role="alert"');
    expect(error).toContain("The service did not respond.");
    expect(empty).toContain("No runs yet");
    expect(empty).toContain("Start an evaluation.");
  });
});
