/** Canonical evaluation setup step ids, in progress-strip order. */
export const EVALUATION_SETUP_STEP_IDS = ["dataset", "name", "system", "settings"] as const;

export type EvaluationSetupStepId = (typeof EVALUATION_SETUP_STEP_IDS)[number];

/**
 * Progress-strip labels for the unified setup flow.
 * The strip order is the workbench DOM section order (Dataset → Name → system →
 * Settings), which is also the order the flow is entered in: /evaluate starts by
 * choosing a dataset, so Dataset is step 1 everywhere. Strip step number, section
 * badge number and DOM position are one and the same — there is no mapping seam.
 */
export function evaluationSetupStepLabels(systemLabel: string): readonly string[] {
  return ["Dataset", "Name", systemLabel, "Checks"];
}

export function evaluationSetupSteps(systemLabel: string): ReadonlyArray<{
  id: EvaluationSetupStepId;
  number: number;
  label: string;
}> {
  const labels = evaluationSetupStepLabels(systemLabel);
  return EVALUATION_SETUP_STEP_IDS.map((id, index) => ({
    id,
    number: index + 1,
    label: labels[index]!,
  }));
}

/** The Dataset step, named so a later renumber cannot silently invert its gate. */
export const DATASET_STEP = EVALUATION_SETUP_STEP_IDS.indexOf("dataset") + 1;

/** Step completeness, cumulative: Dataset leads, so nothing precedes its selection. */
export function evaluationFormStepComplete(flags: {
  nameReady: boolean;
  targetReady: boolean;
  datasetReady: boolean;
  settingsReady: boolean;
}): boolean[] {
  const { nameReady, targetReady, datasetReady, settingsReady } = flags;
  return [
    datasetReady,
    datasetReady && nameReady,
    datasetReady && nameReady && targetReady,
    datasetReady && nameReady && targetReady && settingsReady,
  ];
}

/** Whether the workbench may open a step from the progress strip / Continue. */
export function canOpenEvaluationFormStep(args: {
  step: number;
  currentStep: number;
  stepComplete: boolean[];
}): boolean {
  const { step, currentStep, stepComplete } = args;
  // Dataset can be prefilled from the launcher, so it must stay reachable to pick or
  // review it — true by position now that it leads, and stated so it survives a renumber.
  if (step === DATASET_STEP) return true;
  if (step <= currentStep) return true;
  return Boolean(stepComplete[step - 1]);
}

/**
 * Which step renders expanded. It must honour the same gate as
 * canOpenEvaluationFormStep: a step the strip lets you open has to expand, or the
 * page scrolls to a collapsed section whose controls are never exposed.
 */
export function visibleEvaluationFormStep(args: {
  expandedStep: number | null;
  currentStep: number;
  stepComplete: boolean[];
}): number {
  const { expandedStep, currentStep, stepComplete } = args;
  if (!expandedStep) return currentStep;
  return canOpenEvaluationFormStep({ step: expandedStep, currentStep, stepComplete })
    ? expandedStep
    : currentStep;
}
