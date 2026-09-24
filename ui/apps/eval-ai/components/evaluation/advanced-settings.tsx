"use client";

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog } from "@/components/ui/dialog";
import { AssignmentPickerDialog } from "@/components/evaluation/assignment-picker-dialog";

import { CheckOption, Toggle } from "@/components/evaluation/form-primitives";
import type { EvaluationAssignmentVersion, QualityContractTemplate, TraceProject } from "@/lib/api";

/** Sentinel for "no judge model named", which a Select cannot express as "". */
export const JUDGE_PLATFORM_DEFAULT_VALUE = "__platform_default__";
/** Sentinel for "no tracing project", for the same reason. */
export const PROJECT_UNASSIGNED_VALUE = "__unassigned__";
/**
 * The model that scores the answers — not the system under evaluation.
 *
 * Lives here for the three modes that have a target, where it is a rarely-changed
 * detail. An Existing-responses run has no target at all, so the workbench hosts
 * this in the setup step instead and passes `judgeHosted` to keep it from
 * rendering twice: two inputs driving one value is worse than a buried one.
 */
export function ScoringModelControl({
  judgeModel,
  judgeModels,
  refreshingJudgeModels,
  onJudgeModelChange,
  onRefreshJudgeModels,
}: {
  judgeModel: string;
  judgeModels: string[];
  refreshingJudgeModels: boolean;
  onJudgeModelChange: (value: string) => void;
  onRefreshJudgeModels: () => void;
}) {
  return (
          <div>
            <p className="text-sm font-medium">Scoring model</p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              The model that scores the answers. Not the system being evaluated.
            </p>
            <div className="mt-2 flex items-center gap-2">
                <Select
                  value={judgeModel || JUDGE_PLATFORM_DEFAULT_VALUE}
                  onValueChange={(value) =>
                    onJudgeModelChange(value === JUDGE_PLATFORM_DEFAULT_VALUE ? "" : value)
                  }
                >
                  <SelectTrigger
                    size="sm"
                    id="evaluation-judge-model"
                    aria-label="Scoring model"
                    className="h-9 min-w-0 flex-1 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={JUDGE_PLATFORM_DEFAULT_VALUE}>Use platform default</SelectItem>
                    {judgeModels.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon-sm"
                  title="Refresh scoring models"
                  aria-label="Refresh scoring models"
                  onClick={onRefreshJudgeModels}
                  disabled={refreshingJudgeModels}
                >
                  {refreshingJudgeModels ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="size-4" aria-hidden="true" />
                  )}
                </Button>
            </div>
          </div>
  );
}

/**
 * The settings a run rarely needs changed.
 *
 * Grouped into one component because they share a single question — how this run
 * executes, rather than what it evaluates — and because leaving them inline kept
 * the workbench past 3000 lines. Presentational: the workbench owns every value.
 *
 * The judge block appears only when a selected check needs qualitative judgment,
 * so the model picker is never offered for a run that would ignore it.
 */
export function AdvancedSettings({
  judgeRequired,
  judgeHosted = false,
  judgeModel,
  judgeModels,
  refreshingJudgeModels,
  onJudgeModelChange,
  onRefreshJudgeModels,
  contracts,
  contractsOpen,
  selectedContracts,
  onContractsOpenChange,
  onToggleContract,
  humanReview,
  onHumanReviewChange,
  parallelRequests,
  onParallelRequestsChange,
  projects,
  projectId,
  projectError,
  projectOptionState,
  onProjectChange,
  assignments,
  assignmentId,
  assignmentVersion,
  onAssignmentChange,
}: {
  judgeRequired: boolean;
  /** The setup step already renders the scoring model; do not render it twice. */
  judgeHosted?: boolean;
  judgeModel: string;
  judgeModels: string[];
  refreshingJudgeModels: boolean;
  onJudgeModelChange: (model: string) => void;
  onRefreshJudgeModels: () => void;
  contracts: QualityContractTemplate[];
  contractsOpen: boolean;
  selectedContracts: string[];
  onContractsOpenChange: (open: boolean) => void;
  onToggleContract: (templateId: string) => void;
  humanReview: boolean;
  onHumanReviewChange: (review: boolean) => void;
  parallelRequests: number;
  onParallelRequestsChange: (count: number) => void;
  projects: TraceProject[];
  projectId: string;
  projectError: string | null;
  /** Why a project cannot be chosen, decided by the caller. */
  projectOptionState: (project: TraceProject) => { disabled: boolean; note: string };
  onProjectChange: (projectId: string) => void;
  assignments: EvaluationAssignmentVersion[];
  assignmentId: string;
  assignmentVersion: string;
  onAssignmentChange: (assignmentId: string, assignmentVersion: string) => void;
}) {
  const assignmentSelected = Boolean(assignmentId && assignmentVersion);
  const [pickerOpen, setPickerOpen] = useState(false);
  const selectedAssignment = assignmentId
    ? assignments.find(
        (item) => item.assignment_id === assignmentId && item.version === assignmentVersion,
      ) ?? null
    : null;
  return (
    <section className="border-t px-5 pb-2" aria-labelledby="advanced-configurations-title">
      <h3 id="advanced-configurations-title" className="py-3 text-sm font-semibold">
        Advanced configurations
      </h3>
      <div className="space-y-3 pb-2">
        {judgeRequired && !judgeHosted ? (
          <ScoringModelControl
            judgeModel={judgeModel}
            judgeModels={judgeModels}
            refreshingJudgeModels={refreshingJudgeModels}
            onJudgeModelChange={onJudgeModelChange}
            onRefreshJudgeModels={onRefreshJudgeModels}
          />
        ) : null}

        <div className={judgeRequired ? "border-t pt-3" : ""}>
          <label htmlFor="evaluation-assignment" className="block text-sm font-medium">
            Assignment
          </label>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            Optional. Pins the profile, gate, and target.
          </p>
          <div className="mt-2">
            {/* A button that opens a table, not a select. An Assignment is told
                apart by its Profile, Gate Policy and date — four facts that do not
                fit one option line, which is why the list read as one repeated
                name. Same shape as the dataset and agent pickers. */}
            {selectedAssignment ? (
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{selectedAssignment.name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {selectedAssignment.profile_id} · v{selectedAssignment.profile_version}
                    {selectedAssignment.gate_policy_id
                      ? ` · gated by ${selectedAssignment.gate_policy_id}`
                      : " · no gate"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                    Change
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onAssignmentChange("", "")}
                  >
                    Clear
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2.5">
                <p className="text-sm text-muted-foreground">Diagnostic — no Assignment</p>
                <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                  Choose Assignment
                </Button>
              </div>
            )}
          </div>
          {pickerOpen ? (
            <AssignmentPickerDialog
              assignments={assignments}
              selectedKey={assignmentId ? `${assignmentId}@${assignmentVersion}` : null}
              onSelect={(assignment) => {
                onAssignmentChange(assignment.assignment_id, assignment.version);
                setPickerOpen(false);
              }}
              onClear={() => {
                onAssignmentChange("", "");
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          ) : null}
        </div>

        {assignmentSelected ? null : (
          <div className="border-t pt-3">
            <p className="text-sm font-medium">Rubric templates</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 w-full justify-start"
              onClick={() => onContractsOpenChange(true)}
              aria-haspopup="dialog"
            >
              {selectedContracts.length
                ? `${selectedContracts.length} rubric template${selectedContracts.length === 1 ? "" : "s"} selected`
                : "Select rubric templates"}
            </Button>
            {contractsOpen ? (
              <Dialog
                variant="modal"
                labelledBy="rubric-picker-title"
                describedBy="rubric-picker-description"
                scrimLabel="Close rubric templates"
                onClose={() => onContractsOpenChange(false)}
                width="w-[min(48rem,calc(100vw-2rem))]"
              >
                <div className="border-b px-5 py-4">
                  <h2 id="rubric-picker-title" className="text-lg font-semibold">Select rubric templates</h2>
                  <p id="rubric-picker-description" className="mt-1 text-sm text-muted-foreground">
                    Attach built-in scoring rubrics to this run. Selections apply immediately.
                  </p>
                </div>
                <div className="grid min-h-0 gap-3 overflow-y-auto p-5 sm:grid-cols-2">
                  {contracts.length ? contracts.map((contract) => (
                    <CheckOption
                      key={contract.template_id}
                      checked={selectedContracts.includes(contract.template_id)}
                      onChange={() => onToggleContract(contract.template_id)}
                      title={contract.name}
                      description={contract.description}
                    />
                  )) : (
                    <p className="text-sm text-muted-foreground">Rubric templates are currently unavailable.</p>
                  )}
                </div>
                <div className="flex justify-end border-t px-5 py-3">
                  <Button type="button" onClick={() => onContractsOpenChange(false)}>Done</Button>
                </div>
              </Dialog>
            ) : null}
          </div>
        )}

        <div className="space-y-3 border-t pt-3">
          <Toggle
            compact
            checked={humanReview}
            onChange={onHumanReviewChange}
            label="Human review"
            description="Send failed or borderline cases to Reviews for human confirmation."
          />
          {/* Two controls share one label, so a fieldset/legend groups them and each input is
              wired to the shared hint — Field only clones its single direct child. */}
          <fieldset className="space-y-2">
            <legend className="block text-sm font-medium">Parallel requests</legend>
            <p id="parallel-requests-hint" className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Five keeps a run moving without overloading the target.
            </p>
            <div className="flex items-center gap-3">
              <input
                aria-label="Parallel requests"
                aria-describedby="parallel-requests-hint"
                className="h-11 min-w-0 flex-1 cursor-pointer accent-primary"
                type="range"
                min={1}
                max={20}
                value={parallelRequests}
                onChange={(event) => onParallelRequestsChange(Number(event.target.value))}
              />
              <Input
                inputSize="sm"
                aria-label="Parallel request count"
                aria-describedby="parallel-requests-hint"
                className="w-16 px-2 text-center"
                type="number"
                min={1}
                max={20}
                value={parallelRequests}
                onChange={(event) =>
                  onParallelRequestsChange(Math.min(20, Math.max(1, Number(event.target.value))))
                }
              />
            </div>
          </fieldset>
        </div>

        <div className="border-t pt-3">
          <label htmlFor="evaluation-tracing-project" className="block text-sm font-medium">
            Tracing project (optional)
          </label>
          <div className="mt-2">
            <Select
              value={projectId || PROJECT_UNASSIGNED_VALUE}
              onValueChange={(value) =>
                onProjectChange(value === PROJECT_UNASSIGNED_VALUE ? "" : value)
              }
            >
              <SelectTrigger
                size="sm"
                id="evaluation-tracing-project"
                className="gap-2 text-left [&>span]:min-w-0"
                aria-label="Tracing Project"
                aria-invalid={projectError ? true : undefined}
                aria-describedby={projectError ? "evaluation-tracing-project-error" : undefined}
              >
                <SelectValue>
                  {projects.find((project) => project.project_id === projectId)?.name || "Leave this run unassigned"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] rounded-lg border [&_[data-radix-select-viewport]]:min-w-0 [&_[data-radix-select-viewport]]:p-1">
                <SelectItem className="mx-0 h-auto min-h-11 rounded-md pr-10 text-sm font-normal leading-5" value={PROJECT_UNASSIGNED_VALUE}>Leave this run unassigned</SelectItem>
                {projects.map((project) => (
                  <SelectItem
                    key={project.project_id}
                    value={project.project_id}
                    textValue={project.name}
                    className="mx-0 h-auto min-h-11 rounded-md pr-10 text-sm font-normal leading-5 [&>span:first-child]:min-w-0"
                    disabled={projectOptionState(project).disabled}
                  >
                    <span className="block break-words font-medium">{project.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {project.system_type}{projectOptionState(project).note}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {projectError ? (
            <p
              id="evaluation-tracing-project-error"
              role="alert"
              className="mt-2 text-xs font-medium text-destructive"
            >
              {projectError}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
