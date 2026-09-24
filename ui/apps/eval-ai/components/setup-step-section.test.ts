/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SetupStepSection } from "./setup-step-section";

afterEach(() => {
  cleanup();
});

describe("evaluation step section", () => {
  it("collapses completed work into a summary with an edit action", () => {
    const html = renderToStaticMarkup(
      createElement(
        SetupStepSection,
        {
          id: "step-1",
          number: "1",
          title: "Name this evaluation",
          description: "Name the evaluation.",
          state: "complete",
          summary: "Fraud agent baseline",
          onEdit: () => undefined,
        },
        createElement("input", { "aria-label": "Evaluation name" }),
      ),
    );

    expect(html).toContain("Fraud agent baseline");
    expect(html).toContain('aria-label="Edit Name this evaluation"');
    expect(html).not.toContain('aria-label="Evaluation name"');
  });

  it("shows controls only for the active step", () => {
    const html = renderToStaticMarkup(
      createElement(
        SetupStepSection,
        {
          id: "step-2",
          number: "2",
          title: "Configure Agent System",
          description: "Choose the target.",
          state: "active",
          summary: "evalai-assistant",
          onEdit: () => undefined,
        },
        createElement("select", { "aria-label": "Agent" }),
      ),
    );

    expect(html).toContain("Current step");
    expect(html).toContain('aria-label="Agent"');
    expect(html).not.toContain("Edit Configure Agent System");
  });

  it("supports a Change dataset affordance on a completed dataset step", () => {
    const html = renderToStaticMarkup(
      createElement(SetupStepSection, {
        id: "evaluation-step-3",
        number: "3",
        title: "Select Evaluation Dataset",
        description: "Choose a dataset.",
        state: "complete",
        summary: "agent-cases · 12 rows · Agent",
        onEdit: () => undefined,
        actionLabel: "Change dataset",
        actionHref: "/evaluate",
      }),
    );

    expect(html).toContain("agent-cases · 12 rows · Agent");
    expect(html).toContain("Change dataset");
    expect(html).toContain('href="/evaluate"');
    // Paired with the upcoming-state test below: both must name the same string,
    // or this negative passes for the wrong reason once the copy changes.
    expect(html).not.toContain("Finish the step above to unlock.");
  });

  it("shows the upcoming gate copy only when the step is blocked", () => {
    const html = renderToStaticMarkup(
      createElement(SetupStepSection, {
        id: "evaluation-step-3",
        number: "3",
        title: "Select Evaluation Dataset",
        description: "Choose a dataset.",
        state: "upcoming",
        summary: "No dataset selected",
        onEdit: () => undefined,
      }),
    );

    expect(html).toContain("Finish the step above to unlock.");
  });

  it("guards the completed-step header link so unsaved edits can be confirmed", () => {
    const onActionNavigate = vi.fn((event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
    });
    render(
      createElement(SetupStepSection, {
        id: "evaluation-step-3",
        number: "3",
        title: "Select Evaluation Dataset",
        description: "Choose a dataset.",
        state: "complete",
        summary: "agent-cases · 12 rows · Agent",
        onEdit: () => undefined,
        actionLabel: "Change dataset",
        actionHref: "/evaluate",
        onActionNavigate,
      }),
    );

    fireEvent.click(screen.getByRole("link", { name: "Change dataset" }));

    expect(onActionNavigate).toHaveBeenCalledTimes(1);
  });
});
