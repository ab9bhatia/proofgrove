import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { evaluationSetupStepLabels } from "@/components/evaluation/steps";
import { SetupProgress } from "./setup-progress";

describe("evaluation progress", () => {
  it("marks completed work and exposes the current step", () => {
    const html = renderToStaticMarkup(
      createElement(SetupProgress, {
        label: "Evaluation setup progress",
        currentStep: 3,
        completed: [true, true, false, false],
        available: [true, true, true, false],
        steps: evaluationSetupStepLabels("Agent"),
        onStepSelect: () => undefined,
      }),
    );

    expect(html).toContain('aria-label="Evaluation setup progress"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Step 1");
    expect(html).toContain("Dataset");
    expect(html).toContain("Name");
    expect(html).toContain("Agent");
    expect(html).toContain("Checks");
    expect(html).toContain("bg-brand");
    expect(html).toContain("bg-success");
    // Checks is the only unavailable step here; the class hook is not the attribute.
    expect(html).toContain('disabled=""');
  });

  it("keeps settings current when every requirement is ready", () => {
    const html = renderToStaticMarkup(
      createElement(SetupProgress, {
        label: "Evaluation setup progress",
        currentStep: 4,
        completed: [true, true, true, true],
        available: [true, true, true, true],
        steps: evaluationSetupStepLabels("Agent"),
        onStepSelect: () => undefined,
      }),
    );

    expect(html).toMatch(/aria-current="step"[^>]*>[\s\S]*?Step 4[\s\S]*?Checks/);
    expect(html).not.toContain('disabled=""');
  });

  it("renders the strip in the workbench section order", () => {
    const html = renderToStaticMarkup(
      createElement(SetupProgress, {
        label: "Evaluation setup progress",
        currentStep: 1,
        completed: [false, false, false, false],
        steps: evaluationSetupStepLabels("Target"),
      }),
    );

    expect(html).toMatch(/aria-current="step"[^>]*>[\s\S]*?Step 1[\s\S]*?Dataset/);
    expect(html).toMatch(/Step 2[\s\S]*?Name/);
    expect(html).not.toContain("Choose dataset");
    expect(html).not.toContain("Configure target");
  });

  it("takes availability from the caller rather than the completed prerequisite", () => {
    // Availability is the caller's gate, not "previous cell complete": here the system
    // step is open while Name is still incomplete, and Checks stays locked.
    const html = renderToStaticMarkup(
      createElement(SetupProgress, {
        label: "Evaluation setup progress",
        currentStep: 1,
        completed: [false, false, false, false],
        available: [true, false, true, false],
        steps: evaluationSetupStepLabels("Agent"),
        onStepSelect: () => undefined,
      }),
    );

    expect(html).toContain('aria-label="Step 3: Agent"');
    expect(html).toContain('aria-label="Step 2: Name, locked — complete Dataset first"');
    expect(html).toContain('aria-label="Step 4: Checks, locked — complete Dataset first"');
  });

  it("never renders the current step as a disabled control", () => {
    const html = renderToStaticMarkup(
      createElement(SetupProgress, {
        label: "Evaluation setup progress",
        currentStep: 2,
        completed: [false, false, false, false],
        available: [true, true, true, false],
        steps: evaluationSetupStepLabels("Agent"),
        onStepSelect: () => undefined,
      }),
    );

    expect(html).toMatch(/aria-current="step"[^>]*>[\s\S]*?Step 2/);
    expect(html).not.toMatch(/disabled=""[^>]*aria-current="step"/);
    expect(html).not.toMatch(/aria-current="step"[^>]*disabled=""/);
  });

  it("renders text, not dead buttons, when no step can be selected", () => {
    const html = renderToStaticMarkup(
      createElement(SetupProgress, {
        label: "Evaluation setup progress",
        currentStep: 3,
        completed: [false, false, false, false],
        steps: evaluationSetupStepLabels("Target"),
      }),
    );

    expect(html).not.toContain("<button");
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('aria-current="step"');
  });
});
