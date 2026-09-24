import type {
  DatasetRunRequest,
  EvaluationScope,
  EvaluationScopeOption,
  EvidenceReadinessResult,
  MetricCatalogEntry,
  QualityContractTemplate,
} from "@/lib/api";
import type { EvaluationKind } from "@/lib/evaluation-form";
import { cn } from "@evalai/shared/utils";
import { evaluationScopeLabel } from "@/components/evaluation/scope-selector";
import { metricEvidenceScope } from "@/components/metric-selection-panel";

export const ANSWER_RECOMMENDED = ["llm.correctness", "llm.relevance", "llm.coherence"];
export const TOOL_RECOMMENDED = ["agent.tool_call_accuracy", "agent.tool_selection", "agent.tool_input_accuracy"];
export const PERFORMANCE_RECOMMENDED = [
  "ops.latency",
  "ops.total_token_count",
  "ops.input_token_count",
  "ops.output_token_count",
  "ops.token_efficiency",
];

export const METRIC_FAMILIES = [
  ["llm", "Guidelines & policy"],
  ["rag", "Retrieval & grounding"],
  ["agent", "Agent execution"],
  ["safety", "Safety & trust"],
  ["nlp", "Text similarity"],
  ["ops", "Operational"],
] as const;

export function groupMetricsByFamily(metrics: MetricCatalogEntry[]) {
  return METRIC_FAMILIES.map(([prefix, label]) => ({
    prefix,
    label,
    metrics: metrics.filter((metric) => metric.metric_id.startsWith(`${prefix}.`)),
  })).filter((family) => family.metrics.length > 0);
}

export function recommendedMetricIdsForScope(scope: EvaluationScope): string[] {
  return scope === "tool_interactions"
    ? [...ANSWER_RECOMMENDED, ...TOOL_RECOMMENDED, ...PERFORMANCE_RECOMMENDED]
    : [...ANSWER_RECOMMENDED, ...PERFORMANCE_RECOMMENDED];
}

export function requiredScopeForMetricIds(metrics: MetricCatalogEntry[], metricIds: string[]): EvaluationScope {
  const selected = new Set(metricIds);
  return metrics.some((metric) => selected.has(metric.metric_id) && metricEvidenceScope(metric) === "full_execution")
    ? "full_execution"
    : metrics.some((metric) => selected.has(metric.metric_id) && metricEvidenceScope(metric) === "tool_interactions")
      ? "tool_interactions"
      : "final_response";
}

export function metricIdsCompatibleWithScope(metrics: MetricCatalogEntry[], metricIds: string[], scope: EvaluationScope): string[] {
  if (scope !== "final_response") return metricIds;
  const allowed = new Set(
    metrics.filter((metric) => metricEvidenceScope(metric) === "final_response").map((metric) => metric.metric_id),
  );
  return metricIds.filter((metricId) => metricId.startsWith("ops.") || allowed.has(metricId));
}

export function deeperScope(left: EvaluationScope, right: EvaluationScope): EvaluationScope {
  const order: EvaluationScope[] = ["final_response", "tool_interactions", "full_execution"];
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

export function approximateRunDuration({
  caseCount,
  scope,
  judgeEnabled,
  parallelRequests,
}: {
  caseCount: number | null;
  scope: EvaluationScope;
  judgeEnabled: boolean;
  parallelRequests: number;
}): string | null {
  if (caseCount == null || caseCount < 1) return null;
  // ponytail: client-side heuristic; replace with a backend estimate when runtime telemetry is available.
  const secondsPerCase: Record<EvaluationScope, number> = {
    final_response: 60,
    tool_interactions: 90,
    full_execution: 135,
  };
  const seconds = Math.max(
    1,
    Math.ceil(
      (caseCount * secondsPerCase[scope] * (judgeEnabled ? 1.4 : 1)) /
        Math.max(1, parallelRequests),
    ),
  );
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `~${minutes} min${remainder ? ` ${remainder} s` : ""}` : `~${remainder} s`;
}

/** The three user-selectable evaluation depths, in order of increasing depth. */
export const EVALUATION_DEPTHS: ReadonlyArray<{
  scope: EvaluationScope;
  label: string;
  description: string;
}> = [
  {
    scope: "final_response",
    label: evaluationScopeLabel("final_response"),
    description: "Scores the live input and output only. Does not wait for traces.",
  },
  {
    scope: "tool_interactions",
    label: evaluationScopeLabel("tool_interactions"),
    description: "Also inspects the tool calls and results behind each answer.",
  },
  {
    scope: "full_execution",
    label: evaluationScopeLabel("full_execution"),
    description: "Inspects the entire execution trace of each case, end to end.",
  },
];

/**
 * Depth radio appearance. The focus ring is deliberately independent of selection:
 * with a roving tabindex you can tab into the group, and selection styling alone
 * would leave a keyboard user unable to tell where focus is (WCAG 2.4.7).
 *
 * Selection is deliberately *not* in this class string. It is expressed by
 * ``aria-checked`` on the control and styled from that attribute in CSS, so
 * assistive technology and the visual both read the same source and focus can
 * never be mistaken for selection.
 */
export function depthOptionClassName(state: { disabled: boolean }): string {
  return cn(
    "eval-setup-choice",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    state.disabled && "cursor-not-allowed opacity-60",
  );
}

/**
 * The backend's per-depth availability, read from the readiness response. Until the backend has
 * reported (or on an older backend without ``scope_options``), every depth stays offered; the
 * readiness result for the requested depth remains the authority on whether the run may start.
 */
/** Depths that grade tool evidence, and so can be scoped to named tools.
 *
 * Sending the selection only at the shallower depth silently widened a scoped
 * run to the whole tool layer when the depth changed, with nothing recording
 * that the selection had been dropped.
 */
export function scopeInspectsTools(scope: EvaluationScope): boolean {
  return scope === "tool_interactions" || scope === "full_execution";
}

export function evaluationDepthVisible(kind: EvaluationKind | null): boolean {
  return kind !== null;
}

/** Every depth offered, for a backend that has not reported per-depth availability.
 *  Hoisted because `scopeOptionsFrom` runs once per metric per render and this never varies. */
const ALL_DEPTHS_AVAILABLE: EvaluationScopeOption[] = EVALUATION_DEPTHS.map(
  ({ scope }) => ({ scope, available: true }),
);

export type { EvaluationScopeOption };

export function scopeOptionsFrom(
  readiness: EvidenceReadinessResult | null | undefined,
): EvaluationScopeOption[] {
  const options = readiness?.scope_options;
  if (options?.length) return options;
  return ALL_DEPTHS_AVAILABLE;
}

/**
 * Whether one depth option must render disabled, and the exact backend reason to show. An
 * unavailable depth is offered but disabled — never silently replaced with another depth.
 */
export function depthOptionState(
  options: EvaluationScopeOption[],
  scope: EvaluationScope,
): { disabled: boolean; reason: string | null; caveat: string | null } {
  const option = options.find((item) => item.scope === scope);
  if (!option || option.available) {
    return { disabled: false, reason: null, caveat: option?.caveat ?? null };
  }
  return {
    disabled: true,
    reason: option.reason || "This evaluation depth is not available for this setup.",
    caveat: null,
  };
}

export function resolveScoringMetricIds(
  selectedMetrics: string[],
  contracts: QualityContractTemplate[],
  selectedContracts: string[],
  applyTemplates: boolean,
): string[] {
  const templateMetrics = applyTemplates
    ? contracts
        .filter((contract) => selectedContracts.includes(contract.template_id))
        .map((contract) => contract.metric_id)
    : [];
  return [...new Set([...selectedMetrics, ...templateMetrics])];
}

/** Applicability the backend resolved for ``metricId`` (undefined when not reported). */
export function metricApplicability(
  readiness: EvidenceReadinessResult | null | undefined,
  metricId: string,
): "known_applicable" | "potentially_applicable" | "known_not_applicable" | undefined {
  return readiness?.metric_applicability.find((item) => item.metric_id === metricId)?.applicability;
}

export function isKnownNotApplicable(
  readiness: EvidenceReadinessResult | null | undefined,
  metricId: string,
): boolean {
  return metricApplicability(readiness, metricId) === "known_not_applicable";
}

export function notApplicableReason(
  readiness: EvidenceReadinessResult | null | undefined,
  metricId: string,
): string | null {
  const entry = readiness?.metric_applicability.find((item) => item.metric_id === metricId);
  if (!entry || entry.applicability !== "known_not_applicable") return null;
  return entry.reason ?? "This check does not apply to the evidence in this dataset.";
}

/**
 * Metrics that are actually scored for the run: the resolved selection minus any check the
 * backend reports as ``known_not_applicable``. Contract-required metrics (``protectedIds``) are
 * kept even when not applicable so they stay visibly locked and block Run.
 */
export function applicableScoringMetricIds(
  resolvedMetricIds: string[],
  readiness: EvidenceReadinessResult | null | undefined,
  protectedIds: Iterable<string> = [],
): string[] {
  if (!readiness) return resolvedMetricIds;
  const protectedSet = new Set(protectedIds);
  return resolvedMetricIds.filter(
    (metricId) => protectedSet.has(metricId) || !isKnownNotApplicable(readiness, metricId),
  );
}

/**
 * Whether the Run CTA may be enabled. ``readinessChecking`` is true from the moment any readiness
 * input changes until the (debounced) readiness fetch resolves, so a stale ``ready`` result can
 * never keep Run enabled during that window.
 */
export function computeRunReady({
  setupReady,
  contractMetricBlocked,
  readinessChecking,
  readiness,
}: {
  setupReady: boolean;
  contractMetricBlocked: boolean;
  readinessChecking: boolean;
  readiness: EvidenceReadinessResult | null | undefined;
}): boolean {
  return setupReady && !contractMetricBlocked && !readinessChecking && readiness?.status === "ready";
}

/** True when a contract-required metric is not applicable to this dataset (blocks Run). */
export function hasContractMetricNotApplicable(
  protectedIds: Iterable<string>,
  readiness: EvidenceReadinessResult | null | undefined,
): boolean {
  if (!readiness) return false;
  for (const metricId of protectedIds) {
    if (isKnownNotApplicable(readiness, metricId)) return true;
  }
  return false;
}

/** Labels/values for the Review step run summary — Target appears once. */
export function reviewSummaryItems(input: {
  evaluationName: string;
  targetSummary: string;
  datasetLabel: string;
  depthLabel: string;
  checkCount: number;
}): Array<{ label: string; value: string }> {
  return [
    { label: "Evaluation", value: input.evaluationName.trim() || "Not named" },
    { label: "Target", value: input.targetSummary },
    { label: "Dataset", value: input.datasetLabel },
    { label: "Depth", value: input.depthLabel },
    { label: "Checks", value: `${input.checkCount} selected` },
  ];
}

export interface DatasetRunRequestInputs {
  kind: EvaluationKind;
  evaluationName: string;
  runLabel: string | null;
  /** Every label; the backend keeps `label` as the first for existing readers. */
  runLabels?: string[];
  agentId: string;
  selectedLlm: { model_id: string; endpoint?: string | null } | null;
  judgeModel: string | null;
  judgeEnabled: boolean;
  activeMetricIds: string[];
  parallelRequests: number;
  humanReview: boolean;
  applyContracts: boolean;
  selectedContracts: string[];
  projectId: string;
  evaluationScope: EvaluationScope;
  /** Optional system prompt, sent ahead of each row's question. LLM targets only. */
  systemPrompt?: string | null;
  /**
   * Selected-tools level: the named tools to evaluate (null = whole tool
   * layer). Only sent with the tool_interactions depth — the selection is
   * meaningless (and rejected by the backend) at any other depth.
   */
  selectedToolIds?: string[] | null;
  assignmentId?: string | null;
  assignmentVersion?: string | null;
}

/**
 * Build the request used to start (or readiness-check) a dataset run.
 *
 * ``evaluation_scope`` carries the depth the user chose (final answer, tool interactions, or
 * full lifecycle). The backend keeps requested depth and evidence availability separate: it may
 * promote the resolved scope for metric/contract requirements (reported via
 * ``scope_promotion_reasons``) and reports an unavailable depth as a structured readiness
 * blocker rather than silently replacing it.
 */
export function buildDatasetRunRequest(inputs: DatasetRunRequestInputs): DatasetRunRequest {
  const {
    kind,
    evaluationName,
    runLabel,
    runLabels = [],
    agentId,
    selectedLlm,
    judgeModel,
    judgeEnabled,
    activeMetricIds,
    parallelRequests,
    humanReview,
    applyContracts,
    selectedContracts,
    projectId,
    evaluationScope,
    selectedToolIds = null,
    systemPrompt = null,
    assignmentId = null,
    assignmentVersion = null,
  } = inputs;
  const explicitAssignmentId = assignmentId?.trim() || null;
  const explicitAssignmentVersion = assignmentVersion?.trim() || null;
  const hasAssignment = Boolean(explicitAssignmentId && explicitAssignmentVersion);
  const llmEndpoint =
    selectedLlm?.endpoint?.trim() || (selectedLlm ? `llm-catalog:${selectedLlm.model_id}` : "");
  const annotatedLabel = runLabel?.trim() || null;
  return {
    evaluation_name: evaluationName.trim(),
    label: annotatedLabel,
    name: annotatedLabel,
    // The full list; `label` stays the first entry so every existing reader of a
    // single label keeps working unchanged.
    labels: runLabels.length ? runLabels : annotatedLabel ? [annotatedLabel] : [],
    response_source: kind,
    agent: kind === "agent" ? agentId : null,
    target_endpoint: kind === "llm" ? llmEndpoint : null,
    target_model: kind === "llm" ? selectedLlm?.model_id || null : null,
    // An agent owns its own prompt; only an LLM target takes one from here.
    system_prompt: kind === "llm" ? systemPrompt?.trim() || null : null,
    judge_model: judgeEnabled ? judgeModel || null : null,
    enable_llm_judge: judgeEnabled,
    ...(hasAssignment ? {} : { active_metrics: activeMetricIds }),
    parallel_requests: parallelRequests,
    run_human_review: humanReview,
    quality_contract_ids: hasAssignment ? [] : applyContracts ? selectedContracts : [],
    project_id: projectId || null,
    assignment_id: hasAssignment ? explicitAssignmentId : null,
    assignment_version: hasAssignment ? explicitAssignmentVersion : null,
    evaluation_scope: evaluationScope,
    selected_tool_ids: scopeInspectsTools(evaluationScope) ? selectedToolIds : null,
  };
}

/**
 * Collapse an explicit tool selection back to the whole tool layer (null) when
 * it covers every declared tool. An unknown inventory keeps the explicit
 * selection so the backend validates it honestly instead of it being silently
 * dropped; an explicitly empty selection is preserved (the backend rejects it).
 */
export function normalizeToolSelection(
  selected: string[] | null,
  available: string[] | null,
): string[] | null {
  if (selected === null) return null;
  if (available === null || available.length === 0) return selected;
  const chosen = new Set(selected);
  const coversAll = available.every((tool) => chosen.has(tool)) && selected.length > 0;
  return coversAll ? null : selected;
}

/**
 * Resolve a rerun-restored tracing Project against the active inventory. Only
 * an active system Project is restorable (the same rule the selector
 * enforces). When the original run's Project is no longer available the
 * restore must not fail silently: no Project is selected and an explicit
 * notice for the Project field is returned instead. Nothing is auto-selected.
 */
export function restoredProjectState(
  requestedProjectId: string | null | undefined,
  projects: ReadonlyArray<{ project_id: string; purpose?: string | null }>,
): { projectId: string | null; notice: string | null } {
  if (!requestedProjectId) return { projectId: null, notice: null };
  const restorable = projects.some(
    (project) => project.project_id === requestedProjectId && project.purpose === "system",
  );
  if (restorable) return { projectId: requestedProjectId, notice: null };
  return {
    projectId: null,
    notice:
      "The original run's Project is archived or unavailable — choose an active Project or continue unassigned.",
  };
}

export function scenarioFor(kind: EvaluationKind) {
  return kind === "agent" ? "agentic" : "llm_core";
}

export function displayRunStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === "pending" || normalized === "running") return "Running";
  if (normalized === "awaiting_trace") return "Waiting for traces";
  if (normalized === "completed") return "Completed";
  if (normalized === "completed_with_partial_evidence") return "Partial evidence";
  if (normalized === "failed") return "Failed";
  if (normalized === "cancelled") return "Stopped";
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}


/**
 * What a comparison varies. One at a time, so a difference is attributable — and
 * "none" is one of them: without an off state the control rendered an axis as
 * chosen before the user had chosen anything, and offered no way to clear it.
 */
export const COMPARE_AXES = [
  { value: "none", label: "No comparison", description: "One run, using the model and prompt above." },
  { value: "models", label: "Models", description: "Same prompt, one run per model you pick." },
  {
    value: "prompts",
    label: "Prompts",
    description: "Same model, one run per saved prompt version you pick.",
  },
] as const;

export type CompareAxis = (typeof COMPARE_AXES)[number]["value"];

/** "Prompts" is only offerable when there is a library to vary across. */
export function offerableCompareAxes(hasSavedPrompts: boolean) {
  return COMPARE_AXES.filter((axis) => axis.value !== "prompts" || hasSavedPrompts);
}

/**
 * What a closed disclosure reports. Null means "nothing configured" — including
 * an axis chosen but no targets picked yet, which launches a single run.
 */
export function comparisonSummaryLabel(
  axis: CompareAxis,
  counts: { prompts: number; models: number },
): string | null {
  if (axis === "none") return null;
  const count = axis === "prompts" ? counts.prompts : counts.models;
  if (!count) return null;
  const noun = axis === "prompts" ? "prompt" : "model";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}


/**
 * Comparison targets that still exist in the catalog that loaded.
 *
 * The prompt library is optional context: when its request fails the workbench
 * falls back to an empty catalog so the run can still go ahead. The selected
 * refs used to survive that, invisibly — the prompt axis showed nothing chosen
 * while the launch gate still counted them, so Run fired several runs against
 * references the user could no longer see.
 */
export function survivingCompareRefs(
  refs: readonly string[],
  available: readonly string[],
): string[] {
  const present = new Set(available);
  return refs.filter((ref) => present.has(ref));
}
