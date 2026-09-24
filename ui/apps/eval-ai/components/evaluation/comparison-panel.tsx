"use client";
import { modelSelectionId, findSelectedModel } from "@/lib/model-selection";

import { cn } from "@evalai/shared/utils";

import { CheckOption } from "@/components/evaluation/form-primitives";
import type { CompareAxis, COMPARE_AXES } from "@/components/evaluation/helpers";
import { SegmentedChoice } from "@/components/segmented-choice";
import type { LlmCatalogEntry, PromptVersion } from "@/lib/api";
import { promptPreview, promptRef } from "@/lib/prompts";

/**
 * Running the same evaluation more than once, varying one thing.
 *
 * Presentational: every piece of state lives in the workbench, matching how
 * `SystemPromptPanel` beside it is split. Extracted because the workbench had
 * grown past 3000 lines and this section answers one self-contained question.
 *
 * The axis is exclusive and includes "none", so turning a comparison off is a
 * choice you can make rather than the absence of one. Targets belong to a chosen
 * axis, so they appear only once an axis is picked — and switching axis clears
 * them, because a launch that varied two things at once would leave a difference
 * attributable to neither.
 */
export function ComparisonPanel({
  axes,
  axis,
  axisDescription,
  maxTargets,
  savedPrompts,
  selectedPromptRefs,
  llmCatalog,
  selectedLlmId,
  selectedLlmIds,
  onAxisChange,
  onTogglePrompt,
  onToggleLlm,
}: {
  /** Offerable axes; "prompts" is dropped when the library is empty. */
  axes: ReadonlyArray<(typeof COMPARE_AXES)[number]>;
  axis: CompareAxis;
  axisDescription: string;
  maxTargets: number;
  savedPrompts: PromptVersion[];
  selectedPromptRefs: string[];
  llmCatalog: LlmCatalogEntry[];
  /** The model chosen above; it is one arm of the comparison, never an extra. */
  selectedLlmId: string;
  selectedLlmIds: string[];
  onAxisChange: (axis: CompareAxis) => void;
  onTogglePrompt: (ref: string) => void;
  onToggleLlm: (modelId: string) => void;
}) {
  const capReason = `A comparison is capped at ${maxTargets} runs.`;

  return (
    <fieldset className="space-y-3">
      {/* The disclosure's own label already names this; a visible legend
          repeating it put the same words on screen twice. */}
      <legend className="sr-only">Compare against</legend>

      <SegmentedChoice
        options={axes}
        value={axis}
        onChange={onAxisChange}
        label="What the comparison varies"
      />

      {/* One line that changes with the choice, rather than three descriptions
          competing for the same attention. */}
      <p className="text-xs leading-5 text-muted-foreground">
        {axisDescription}
        {axis === "none" ? null : ` Up to ${maxTargets} runs in total.`}
      </p>
      {axis === "prompts" ? (
        <p className="text-xs leading-5 text-muted-foreground" role="status">
          {selectedPromptRefs.length < 2
            ? "Select at least two versions to compare. Only the selected versions will run."
            : `${selectedPromptRefs.length} versions selected. Each runs against the same dataset and scoring checks.`}
        </p>
      ) : null}

      {/* Targets belong to a chosen axis. With no comparison there is nothing to
          pick, so nothing is shown. */}
      <div className={cn("grid gap-2 md:grid-cols-2", axis === "none" && "hidden")}>
        {axis === "prompts"
          ? savedPrompts.map((prompt) => {
              const ref = promptRef(prompt);
              const checked = selectedPromptRefs.includes(ref);
              return (
                <CheckOption
                  key={ref}
                  checked={checked}
                  disabled={!checked && selectedPromptRefs.length >= maxTargets}
                  onChange={() => onTogglePrompt(ref)}
                  disabledReason={capReason}
                  title={prompt.name}
                  meta={ref}
                  description={promptPreview(prompt.content)}
                />
              );
            })
          : llmCatalog
              .filter((model) => model !== findSelectedModel(llmCatalog, selectedLlmId))
              .map((model) => {
                const checked = selectedLlmIds.some(id => findSelectedModel(llmCatalog, id) === model);
                // One comparison holds `maxTargets` runs including the model
                // chosen above, so the extras stop one short of it.
                return (
                  <CheckOption
                    key={modelSelectionId(model)}
                    checked={checked}
                    disabled={!checked && selectedLlmIds.length >= maxTargets - 1}
                    onChange={() => onToggleLlm(modelSelectionId(model))}
                    disabledReason={capReason}
                    title={model.name}
                    meta={model.model_id}
                    description={model.description?.trim() || "No description provided."}
                  />
                );
              })}
      </div>
    </fieldset>
  );
}
