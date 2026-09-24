import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SetupProgress } from "@/components/setup-progress";
import {
  DATASET_STEP,
  EVALUATION_SETUP_STEP_IDS,
  canOpenEvaluationFormStep,
  evaluationFormStepComplete,
  evaluationSetupStepLabels,
  evaluationSetupSteps,
  visibleEvaluationFormStep,
} from "./steps";

function renderStrip(args: {
  currentStep: number;
  completed: boolean[];
  stepComplete: boolean[];
}): string {
  const { currentStep, completed, stepComplete } = args;
  return renderToStaticMarkup(
    createElement(SetupProgress, {
      currentStep,
      completed: EVALUATION_SETUP_STEP_IDS.map((_id, index) => completed[index] ?? false),
      available: EVALUATION_SETUP_STEP_IDS.map((_id, index) =>
        canOpenEvaluationFormStep({ step: index + 1, currentStep, stepComplete }),
      ),
      steps: evaluationSetupStepLabels("Agent"),
      onStepSelect: () => undefined,
    }),
  );
}

describe("evaluation setup steps", () => {
  it("defines one step order shared by launcher and workbench", () => {
    expect([...EVALUATION_SETUP_STEP_IDS]).toEqual(["dataset", "name", "system", "settings"]);
    expect(evaluationSetupStepLabels("Agent")).toEqual(["Dataset", "Name", "Agent", "Checks"]);
    expect(evaluationSetupStepLabels("RAG system")).toEqual([
      "Dataset",
      "Name",
      "RAG system",
      "Checks",
    ]);
    expect(evaluationSetupSteps("Agent").map((step) => step.id)).toEqual([
      "dataset",
      "name",
      "system",
      "settings",
    ]);
    // The flow starts by choosing a dataset, so the strip must start there too.
    expect(DATASET_STEP).toBe(1);
  });

  it("numbers the rendered strip the way the workbench numbers its sections", () => {
    // The badge on each workbench section is its form step, so a strip number that
    // disagreed would scroll the user to a section labelled something else.
    const html = renderStrip({
      currentStep: 1,
      completed: [false, false, false, false],
      stepComplete: [false, false, false, false],
    });

    expect(html).toMatch(/Step 1<\/span><span[^>]*>Dataset/);
    expect(html).toMatch(/Step 2<\/span><span[^>]*>Name/);
    expect(html).toMatch(/Step 3<\/span><span[^>]*>Agent/);
    expect(html).toMatch(/Step 4<\/span><span[^>]*>Checks/);
  });
});

describe("dataset step gate", () => {
  it("stays openable from any step, so a launcher prefill can be reviewed", () => {
    expect(
      canOpenEvaluationFormStep({
        step: DATASET_STEP,
        currentStep: 3,
        stepComplete: [false, false, false, false],
      }),
    ).toBe(true);
    expect(
      visibleEvaluationFormStep({
        expandedStep: DATASET_STEP,
        currentStep: 3,
        stepComplete: [false, false, false, false],
      }),
    ).toBe(DATASET_STEP);
  });
});

describe("progress strip availability", () => {
  it("enables exactly the steps the open gate accepts", () => {
    // Entered with ?dataset=: the dataset is chosen, nothing else is.
    const stepComplete = evaluationFormStepComplete({
      nameReady: false,
      targetReady: false,
      datasetReady: true,
      settingsReady: false,
    });
    const html = renderStrip({ currentStep: 2, completed: stepComplete, stepComplete });

    expect(html).toContain('aria-label="Step 1: Dataset, complete"');
    expect(html).toContain('aria-label="Step 2: Name, current"');
    // System and Checks are gated on Name, and say so rather than sitting inert.
    expect(html).toContain('aria-label="Step 3: Agent, locked — complete Name first"');
    expect(html).toContain('aria-label="Step 4: Checks, locked — complete Name first"');
  });

  it("never disables a step whose selection would scroll somewhere", () => {
    const stepComplete = evaluationFormStepComplete({
      nameReady: true,
      targetReady: true,
      datasetReady: false,
      settingsReady: false,
    });
    const html = renderStrip({ currentStep: 1, completed: stepComplete, stepComplete });

    // Checks needs the dataset, and the strip refuses it for the same reason
    // scrollToStep would — not the previous strip cell being incomplete.
    expect(
      canOpenEvaluationFormStep({ step: 4, currentStep: 1, stepComplete }),
    ).toBe(false);
    expect(html).toContain('aria-label="Step 4: Checks, locked — complete Dataset first"');
    expect(html).toContain('aria-label="Step 1: Dataset, current"');
  });
});

describe("evaluation form step completeness", () => {
  it("marks Dataset complete from selection alone when entered via ?dataset=", () => {
    const steps = evaluationFormStepComplete({
      nameReady: false,
      targetReady: false,
      datasetReady: true,
      settingsReady: false,
    });
    expect(steps).toEqual([true, false, false, false]);
    expect(canOpenEvaluationFormStep({ step: 1, currentStep: 1, stepComplete: steps })).toBe(true);
  });

  it("keeps Name/System gates for settings readiness", () => {
    const steps = evaluationFormStepComplete({
      nameReady: true,
      targetReady: true,
      datasetReady: true,
      settingsReady: false,
    });
    expect(steps[3]).toBe(false);
    expect(canOpenEvaluationFormStep({ step: 2, currentStep: 1, stepComplete: steps })).toBe(true);
  });

  it("expands every step the progress strip can open", () => {
    const steps = evaluationFormStepComplete({
      nameReady: false,
      targetReady: false,
      datasetReady: false,
      settingsReady: false,
    });

    // Entering at /evaluate?type=agent with no dataset: the Dataset step opens from
    // the strip, so it must also render expanded instead of falling back elsewhere.
    expect(canOpenEvaluationFormStep({ step: 1, currentStep: 1, stepComplete: steps })).toBe(true);
    expect(
      visibleEvaluationFormStep({ expandedStep: 1, currentStep: 1, stepComplete: steps }),
    ).toBe(1);
  });

  it("falls back to the current step for a step that cannot be opened", () => {
    const steps = evaluationFormStepComplete({
      nameReady: false,
      targetReady: false,
      datasetReady: false,
      settingsReady: false,
    });

    expect(canOpenEvaluationFormStep({ step: 4, currentStep: 1, stepComplete: steps })).toBe(false);
    expect(
      visibleEvaluationFormStep({ expandedStep: 4, currentStep: 1, stepComplete: steps }),
    ).toBe(1);
    expect(
      visibleEvaluationFormStep({ expandedStep: null, currentStep: 2, stepComplete: steps }),
    ).toBe(2);
  });

  it("leaves Dataset incomplete when no dataset is selected", () => {
    const steps = evaluationFormStepComplete({
      nameReady: true,
      targetReady: true,
      datasetReady: false,
      settingsReady: false,
    });
    expect(steps[0]).toBe(false);
  });
});
