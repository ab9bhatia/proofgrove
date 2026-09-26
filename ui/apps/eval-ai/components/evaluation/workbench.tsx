"use client";

import { preparedArtifacts, preparedDataset, preparedEvaluationKind, preparedExperimentName, readLabAvailability, type LabAvailability } from "./prepared-evaluation";
import { PAGE_FRAME } from "@/lib/page-frame";
import { NOVA_AGENT_EVALUATION_HREF, agentBaselineName, nameAfterAgentChange, runnableAgentMetricIds } from "@/lib/local-agents";
import { assignmentFromSearchParams } from "@/lib/assignment-links";
import Link from "next/link";
import { LONG_LIST_PER_PAGE } from "@/lib/pagination";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Check, ChevronDown, ExternalLink, Eye, Loader2, RefreshCw, X } from "lucide-react";
import { Button, buttonVariants } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@evalai/shared/utils";
import {
  agentsApi,
  api,
  evaluationApi,
  fullName,
  platformApi,
  type AgentSummary,
  type DatasetInfo,
  type WriteExpectedToolsResult,
  type DatasetPage,
  type DatasetPageQuery,
  type DatasetRecord,
  type EvaluationScope,
  type EvidenceReadinessResult,
  type DatasetRunRequest,
  type EvaluationAssignmentVersion,
  type LlmCatalogEntry,
  type PromptVersion,
  type MetricCatalogEntry,
  type QualityContractTemplate,
  type RunConfigurationSnapshot,
  type TraceProject,
} from "@/lib/api";
import { ApiError, userFacingError } from "@/lib/api-errors";
import {
  MAX_BAKEOFF_TARGETS,
  completedComparisonHref,
  describeTally,
  isTerminalRunStatus,
  launchTally,
  withPrompt,
  withTarget,
  type BakeoffTarget,
} from "@/lib/bakeoff";
import { promptPreview, promptRef } from "@/lib/prompts";
import { MIN_COMPARISON_RUNS } from "@/lib/comparison-href";
import { refreshTargets } from "@/lib/bakeoff-grouping";
import { readLaunches, rememberLaunch } from "@/lib/bakeoff-store";
import { SystemPromptPanel } from "@/components/evaluation/system-prompt-panel";
import { PageHeader } from "@/components/page-header";
import { ExpectedToolsWriteBack } from "../expected-tools-write-back";
import { DatasetPreviewTable } from "./dataset-preview-table";
import { rememberActiveRunId } from "@/lib/live-runs";
import {
  bindRunFormTenant,
  forgetRunDraft,
  recallRunDraft,
  rememberRunDraft,
  rememberRunForm,
  recallRunForm,
} from "@/lib/run-form-memory";
import { evaluationRunsHref, isQualityMetricId } from "@/lib/run-recommendation";
import {
  datasetMissingFields,
  missingFieldsLabel,
  evaluationKindLabel,
  type EvaluationKind,
} from "@/lib/evaluation-form";
import { latestPublishedDatasets } from "@/lib/evaluation-datasets";
import { ComparisonPanel } from "@/components/evaluation/comparison-panel";
import { AdvancedSettings, ScoringModelControl } from "@/components/evaluation/advanced-settings";
import { RunBar } from "@/components/evaluation/run-bar";
import { ScoringSummary } from "@/components/evaluation/scoring-summary";
import { scrollIntoPane } from "@/lib/scroll-into-pane";
import { SetupProgress } from "@/components/setup-progress";
import {
  EVALUATION_SETUP_STEP_IDS,
  canOpenEvaluationFormStep,
  evaluationFormStepComplete,
  evaluationSetupStepLabels,
  visibleEvaluationFormStep,
} from "@/components/evaluation/steps";
import {
  handleRovingRadioKeyDown,
  rovingRadioTabIndex,
  rovingRadioTabStop,
} from "@/components/roving-radiogroup";
import {
  metricEvidenceScope,
  metricRequiresJudge,
  metricVisibleForKind,
  MetricSelectionPanel,
} from "@/components/metric-selection-panel";
import { DatasetPickerDialog } from "@/components/evaluation/dataset-picker-dialog";
import { RunLabelInput } from "@/components/evaluation/label-input";
import { modelSelectionId, findSelectedModel } from "@/lib/model-selection";
import { llmSourceLabel, LlmPickerDialog } from "@/components/evaluation/llm-picker-dialog";
import { SetupStepSection, type SetupStepState } from "@/components/setup-step-section";
import {
  Disclosure,
  Empty,
  Field,
  focusFirstInvalid,
  Loading,
  Notice,
  SelectedDetail,
  StepContinue,
  unmetStepRequirements,
  type StepRequirement,
} from "@/components/evaluation/form-primitives";
import {
  ANSWER_RECOMMENDED,
  approximateRunDuration,
  applicableScoringMetricIds,
  buildDatasetRunRequest,
  computeRunReady,
  depthOptionState,
  deeperScope,
  displayRunStatus,
  EVALUATION_DEPTHS,
  evaluationDepthVisible,
  groupMetricsByFamily,
  COMPARE_AXES,
  comparisonSummaryLabel,
  type CompareAxis,
  hasContractMetricNotApplicable,
  metricIdsCompatibleWithScope,
  offerableCompareAxes,
  survivingCompareRefs,
  normalizeToolSelection,
  PERFORMANCE_RECOMMENDED,
  recommendedMetricIdsForScope,
  requiredScopeForMetricIds,
  resolveScoringMetricIds,
  restoredProjectState,
  reviewSummaryItems,
  scenarioFor,
  scopeInspectsTools,
  scopeOptionsFrom,
} from "@/components/evaluation/helpers";

export type { EvaluationKind } from "@/lib/evaluation-form";
export {
  groupMetricsByFamily,
  metricIdsCompatibleWithScope,
  recommendedMetricIdsForScope,
  requiredScopeForMetricIds,
  resolveScoringMetricIds,
  reviewSummaryItems,
};

const DATASET_PICKER_PAGE_SIZE = LONG_LIST_PER_PAGE;


const MAX_METRIC_CATALOG_SIZE = 100;

export async function loadDatasetPickerPage(
  current: DatasetInfo[],
  cursor: string | null,
  fetchPage: (query: DatasetPageQuery) => Promise<DatasetPage> = api.listDatasetsPage,
) {
  const page = await fetchPage({
    limit: DATASET_PICKER_PAGE_SIZE,
    status: "PUBLISHED",
    ...(cursor ? { cursor } : {}),
  });
  const items = [...current, ...page.items].filter(
    (item, index, all) => all.findIndex((candidate) => fullName(candidate) === fullName(item)) === index,
  );
  return { items, total: page.total, nextCursor: page.next_cursor };
}

/**
 * Seed the dataset the launcher selected into the picker inventory when the first
 * bounded page does not contain it. Tenants with more published datasets than one
 * page would otherwise show `?dataset=` as an unselected picker.
 *
 * A dataset that cannot be read is reported back rather than swallowed: the page still
 * claims the evaluation type was inferred from it, so the caller has to say it is gone.
 */
export async function ensureRequestedDataset(
  current: DatasetInfo[],
  requested: string | null,
  fetchDataset: (name: string) => Promise<DatasetInfo> = api.getDataset,
): Promise<{ items: DatasetInfo[]; unreadable: string | null }> {
  if (!requested) return { items: current, unreadable: null };
  if (current.some((item) => fullName(item) === requested)) {
    return { items: current, unreadable: null };
  }
  try {
    const dataset = await fetchDataset(requested);
    // The paged inventory is PUBLISHED-only; this path bypasses it, so without the
    // same check a link to a draft or validated dataset would seed the form with
    // evidence a run may not use, and only fail later. Reported as unreadable so
    // the caller says the selection is unavailable rather than silently dropping it.
    if (dataset.status !== "PUBLISHED") {
      return { items: current, unreadable: requested };
    }
    return { items: [...current, dataset], unreadable: null };
  } catch {
    // The dataset may be gone or unreadable; leave the paged inventory as it is so
    // the picker reports the missing selection instead of failing the whole load.
    return { items: current, unreadable: requested };
  }
}

/** Copy for a `?dataset=` entry whose dataset could not be read back. */
export function requestedDatasetUnavailableNotice(name: string): string {
  // Covers both refusals this path can produce: unreadable, and readable but not
  // published. Claiming "could not be read" for a draft would be untrue.
  return `${name} is not available to evaluate — it is not published, or it could not be read. Choose a published dataset below, or return to the dataset list.`;
}

/** Inventory line under the picker. Nothing is filtered out, so it only reports paging. */
export function datasetPickerCountLabel(loaded: number, total: number) {
  return `Showing ${loaded} of ${total} published datasets`;
}

/**
 * The dataset picker inventory: every published dataset, latest version per lineage.
 *
 * Nothing is dropped. Mode-specific compatibility is rendered by the picker from the
 * backend's bounded row summary; readiness remains the authority at launch.
 */
export function datasetPickerOptions(datasets: DatasetInfo[]) {
  return latestPublishedDatasets(datasets).map((dataset) => ({
    dataset,
    name: fullName(dataset),
  }));
}

function boundedMetricCatalog(metrics: MetricCatalogEntry[]) {
  // The backend returns a code-owned static catalog (~45 rows), not tenant data.
  // Fail loudly if that invariant changes instead of silently truncating the picker.
  if (metrics.length > MAX_METRIC_CATALOG_SIZE) {
    throw new Error(`Metric catalog exceeds the supported ${MAX_METRIC_CATALOG_SIZE}-row bound.`);
  }
  return metrics;
}


/**
 * The chosen dataset, its facts, and the actions on it. Rendered both for a dataset the
 * launcher preselected and for one picked here; only the note and the leading action
 * differ, so they are slots rather than a second copy of the card.
 */
function SelectedDatasetCard({
  dataset,
  datasetName,
  note,
  leadingAction,
  previewTriggerRef,
  previewLoading,
  previewOpen,
  onPreview,
}: {
  dataset: DatasetInfo;
  datasetName: string;
  note?: string;
  leadingAction?: React.ReactNode;
  previewTriggerRef: React.Ref<HTMLButtonElement>;
  previewLoading: boolean;
  previewOpen: boolean;
  onPreview: () => void;
}) {
  return (
    <div className="-mx-5 grid gap-4 border-y bg-muted/25 px-5 py-4 sm:-mx-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <p className="proofgrove-eyebrow text-[0.6875rem] text-evalai-purple">Selected dataset</p>
        <p className="truncate text-sm font-semibold" title={fullName(dataset)}>
          {fullName(dataset)}
        </p>
        {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
        <dl className="eval-setup-meta mt-3">
          <SelectedDetail label="Version" value={`v${dataset.version_number}`} />
          <SelectedDetail
            label="Rows"
            value={dataset.record_count == null ? "Not reported" : String(dataset.record_count)}
          />
        </dl>
      </div>
      <div className="flex flex-wrap gap-2 lg:justify-end">
        {leadingAction}
        <Link
          href={`/datasets/${encodeURIComponent(datasetName)}`}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "ghost", size: "sm", className: "whitespace-nowrap" })}
        >
          <ExternalLink className="mr-2 size-4 shrink-0" aria-hidden="true" />
          <span>Open dataset</span>
        </Link>
        <Button
          ref={previewTriggerRef}
          type="button"
          variant="ghost"
          size="sm"
          className="whitespace-nowrap"
          disabled={previewLoading}
          onClick={onPreview}
          aria-expanded={previewOpen}
          aria-haspopup="dialog"
        >
          {previewLoading ? <Loader2 className="mr-2 size-4 shrink-0 animate-spin" aria-hidden="true" /> : <Eye className="mr-2 size-4 shrink-0" aria-hidden="true" />}
          Preview rows
        </Button>
      </div>
    </div>
  );
}

const COPY: Record<EvaluationKind, { title: string; system: string; description: string }> = {
  agent: {
    title: "Agent Evaluation",
    system: "Configure Agent System",
    description: "Evaluate task execution, tool use, groundedness, and response quality.",
  },
  llm: {
    title: "LLM Evaluation",
    system: "Configure LLM System",
    description: "Evaluate direct model responses for correctness, relevance, and clarity.",
  },
  provided: {
    title: "Existing Responses Evaluation",
    system: "Scoring model",
    description: "Score responses already stored in the dataset without invoking a target.",
  },
};

// Radix Select items cannot carry an empty-string value, so the optional selects
// map these sentinels to the empty string the form state expects.

/** Where the chooser starts when the URL did not name a mode. One click changes it. */
/**
 * The Projects a run can be bound to.
 *
 * Archived Projects are refused by the backend at run time ("Selected Project is
 * archived and cannot receive new evaluation runs"), so they are never offered.
 * The collector's "Unassigned" bucket is a pseudo-Project the tracing API
 * synthesises for traces that resolved to no binding — a run must never be bound
 * to the catch-all, so it is dropped here too and the explicit "Leave this run
 * unassigned" option is used instead.
 */
export function selectableTracingProjects(projects: TraceProject[]): TraceProject[] {
  return projects.filter(
    (project) => project.project_id !== "unassigned" && project.status !== "archived",
  );
}

/**
 * Whether an offered Project can receive a run, and the reason shown when it
 * cannot. Historical Projects stay visible and disabled because classifying one
 * is an action the user can take; archived Projects never reach this.
 */
export function tracingProjectOptionState(project: TraceProject): {
  disabled: boolean;
  note: string;
} {
  if (project.purpose !== "system") {
    return { disabled: true, note: " · Historical, classification required" };
  }
  return { disabled: false, note: "" };
}

/** The concurrency the Parallel requests control starts at, and the value the Advanced
 *  summary treats as "nothing to report". */
const DEFAULT_PARALLEL_REQUESTS = 5;

const DEFAULT_METRICS: Record<EvaluationKind, string[]> = {
  agent: [...ANSWER_RECOMMENDED, ...PERFORMANCE_RECOMMENDED],
  llm: [...ANSWER_RECOMMENDED, ...PERFORMANCE_RECOMMENDED],
  // Supplied answers have no live target usage; start with reproducible text metrics.
  provided: ["nlp.f1_score", "nlp.rouge", "nlp.bleu"],
};

/** What the workbench should display for a failed readiness check or run start. */
export interface RunFailureDisplay {
  /** The specific backend reason (with recovery guidance) or the raw error text. */
  message: string;
  /** Additional per-part problem messages, field-prefixed when the backend names one. */
  detailMessages: string[];
  /** Error text for the Tracing Project control when the failure names it. */
  projectError: string | null;
  targetError: string | null;
  datasetError: string | null;
  scopeError: string | null;
  checksError: string | null;
}

const PROJECT_FIELD_PATTERN = /(^|\.)project(_id)?$/i;
const TARGET_FIELD_PATTERN = /(^|\.)(agent|agent_id|target|target_model|target_endpoint|response_source)$/i;
const DATASET_FIELD_PATTERN = /(^|\.)(dataset|dataset_name)$/i;
const SCOPE_FIELD_PATTERN = /(^|\.)(evaluation_scope|selected_tool_ids)$/i;
const CHECKS_FIELD_PATTERN = /(^|\.)(active_metrics|quality_contract_ids|metric|metric_id)$/i;

function fieldError(reason: ApiError, pattern: RegExp): string | null {
  if (reason.field && pattern.test(reason.field)) return reason.message;
  return reason.details.find((detail) => detail.field && pattern.test(detail.field))?.message ?? null;
}

/**
 * Map a run/readiness failure to display slots. Coded backend problems keep
 * their specific message (never the generic status copy), per-field details are
 * listed in full, and problems that name the Project control are additionally
 * attached to that field.
 */
export function describeRunFailure(reason: unknown): RunFailureDisplay {
  if (!(reason instanceof ApiError)) {
    return {
      message: reason instanceof Error ? reason.message : String(reason),
      detailMessages: [],
      projectError: null,
      targetError: null,
      datasetError: null,
      scopeError: null,
      checksError: null,
    };
  }
  const message = userFacingError(reason);
  const detailMessages = reason.details
    .map((detail) => (detail.field ? `${detail.field}: ${detail.message}` : detail.message))
    .filter((text) => text !== message);
  const projectError =
    fieldError(reason, PROJECT_FIELD_PATTERN) ??
    (/^Selected Project\b/.test(reason.message) ? reason.message : null);
  return {
    message,
    detailMessages,
    projectError,
    targetError: fieldError(reason, TARGET_FIELD_PATTERN),
    datasetError: fieldError(reason, DATASET_FIELD_PATTERN),
    scopeError: fieldError(reason, SCOPE_FIELD_PATTERN),
    checksError: fieldError(reason, CHECKS_FIELD_PATTERN),
  };
}

/**
 * `initialKind` only seeds the choice — it is not the authority. What is being evaluated is
 * asked for in step 1 and owned here; nothing about the dataset is allowed to answer it, and
 * every dataset supports both modes.
 *
 * The prop is required, and `null` is a real answer: nothing in the URL asked for a mode.
 * There is no default parameter, because a default parameter is how every caller silently
 * became an LLM evaluation.
 */
export function EvaluationWorkbench({ kind: initialKind }: { kind: EvaluationKind }) {
  // Seeded from the entry screen's answer; the chooser below can still change it.
  const kind = initialKind;
  const copy = COPY[kind];
  const evaluationTypeLabel = evaluationKindLabel(kind);
  const router = useRouter();
  const searchParams = useSearchParams();
  const preparedKind = preparedEvaluationKind(searchParams, kind);
  const entryAgentRef = kind === "agent" ? searchParams.get("agent") : null;
  const entryDatasetName = searchParams.get("dataset") || (preparedKind ? preparedDataset(preparedKind) : null);
  const rerunRequested = searchParams.get("rerun") === "1";
  const rerunSourceRunId = searchParams.get("fromRun") || searchParams.get("run") || "";
  const formPrefillApplied = useRef(false);
  const assignmentPrefillApplied = useRef(false);
  const contractsPrefillApplied = useRef(false);
  const draftPrefillApplied = useRef(false);
  const previewTriggerRef = useRef<HTMLButtonElement>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [projects, setProjects] = useState<TraceProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [assignments, setAssignments] = useState<EvaluationAssignmentVersion[]>([]);
  const [assignmentId, setAssignmentId] = useState("");
  const [assignmentVersion, setAssignmentVersion] = useState("");
  const [agentId, setAgentId] = useState("");
  const [agentDatasetLoading, setAgentDatasetLoading] = useState(false);
  const [agentDatasetError, setAgentDatasetError] = useState<string | null>(null);
  const agentDatasetLoadToken = useRef(0);
  const [llmCatalog, setLlmCatalog] = useState<LlmCatalogEntry[]>([]);
  const [labAvailability, setLabAvailability] = useState<LabAvailability | null>(null);
  // Extra models to run the same evaluation against. Empty = ordinary single
  // run; non-empty turns this submit into a comparison.
  const [systemPrompt, setSystemPrompt] = useState("");
  // Set when the text came from a saved version, cleared the moment it is
  // edited: an unedited copy is attributable, an edited one honestly reports
  // no reference rather than a stale one.
  const [systemPromptRef, setSystemPromptRef] = useState<string | null>(null);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [savedPrompts, setSavedPrompts] = useState<PromptVersion[]>([]);
  const [canManagePrompts, setCanManagePrompts] = useState(false);
  const [promptSaveError, setPromptSaveError] = useState<string | null>(null);
  // Which axis this launch varies. One at a time: varying model and prompt
  // together makes the resulting comparison unattributable.
  const [compareAxis, setCompareAxis] = useState<CompareAxis>("none");
  const [comparePromptRefs, setComparePromptRefs] = useState<string[]>([]);
  const [compareLlmIds, setCompareLlmIds] = useState<string[]>([]);
  // Set once a multi-model launch is in flight: the form is replaced by its
  // progress until the comparison exists.
  const [comparisonLaunchId, setComparisonLaunchId] = useState<string | null>(null);
  const [comparisonTargets, setComparisonTargets] = useState<BakeoffTarget[] | null>(null);
  const [comparisonRefreshFailed, setComparisonRefreshFailed] = useState(false);
  const [comparisonGroupingFailed, setComparisonGroupingFailed] = useState(false);
  const [comparisonWorkspaceId, setComparisonWorkspaceId] = useState<string | null>(null);
  const [comparisonTick, setComparisonTick] = useState(0);
  const [selectedLlmId, setSelectedLlmId] = useState("");
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [datasetTotal, setDatasetTotal] = useState(0);
  const [datasetNextCursor, setDatasetNextCursor] = useState<string | null>(null);
  const [datasetsLoadingMore, setDatasetsLoadingMore] = useState(false);
  const [datasetPageError, setDatasetPageError] = useState<string | null>(null);
  const [datasetName, setDatasetName] = useState("");
  const [metrics, setMetrics] = useState<MetricCatalogEntry[]>([]);
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>(DEFAULT_METRICS[kind]);
  const [contracts, setContracts] = useState<QualityContractTemplate[]>([]);
  const [selectedContracts, setSelectedContracts] = useState<string[]>([]);
  const [contractsOpen, setContractsOpen] = useState(false);
  const [applyContracts, setApplyContracts] = useState(false);
  const [humanReview, setHumanReview] = useState(false);
  const [parallelRequests, setParallelRequests] = useState(DEFAULT_PARALLEL_REQUESTS);
  const [runLabels, setRunLabels] = useState<string[]>([]);
  // The first label is what the single-valued `label` on a run keeps carrying, so
  // every existing reader (Runs list, Experiments, report headers) is unaffected.
  const primaryRunLabel = runLabels[0] ?? "";
  const [evaluationName, setEvaluationName] = useState("");
  const [judgeModels, setJudgeModels] = useState<string[]>([]);
  const [judgeModel, setJudgeModel] = useState("");
  const [importingModels, setImportingModels] = useState(false);
  const [datasetPickerOpen, setDatasetPickerOpen] = useState(false);
  const [llmPickerOpen, setLlmPickerOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRecords, setPreviewRecords] = useState<DatasetRecord[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rerunConfiguration, setRerunConfiguration] =
    useState<RunConfigurationSnapshot | null>(null);
  const [rerunConfigurationLoadedFor, setRerunConfigurationLoadedFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string[]>([]);
  const [setupLoadErrors, setSetupLoadErrors] = useState<Partial<Record<"datasets" | "metrics" | "agents" | "models", string>>>({});
  const setupLoadFailed = Object.keys(setupLoadErrors).length > 0;
  const [projectError, setProjectError] = useState<string | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [checksError, setChecksError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [liveRunStatus, setLiveRunStatus] = useState<string | null>(null);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [settingsVisited, setSettingsVisited] = useState(false);
  const [requestedScope, setEvaluationScope] = useState<EvaluationScope>("final_response");
  // `kind` always holds a value so the target lookups can run, but before the
  // chooser is answered it is a placeholder, not the user's answer. Anything
  // that tells the user what they are evaluating must read this instead —
  // otherwise the form presents an unchosen mode as a decision already made.
  // Answered on the entry screen before this component mounts, so it is never null.
  const chosenKind: EvaluationKind = kind;
  const lockedByAssignment = Boolean(assignmentId && assignmentVersion);
  const lockingAssignment = assignments.find(
    (item) => item.assignment_id === assignmentId && item.version === assignmentVersion,
  ) ?? null;
  const [assignmentLoad, setAssignmentLoad] = useState<{
    source: EvaluationAssignmentVersion;
    detail: EvaluationAssignmentVersion | null;
    error: string | null;
  } | null>(null);
  const currentAssignmentLoad = assignmentLoad?.source === lockingAssignment ? assignmentLoad : null;
  const assignmentManifest = currentAssignmentLoad?.detail?.resolved_run_manifest ?? null;
  const assignmentLoadError = currentAssignmentLoad?.error ?? null;

  useEffect(() => {
    if (!lockingAssignment) return;
    let active = true;
    platformApi.getAssignment(
      lockingAssignment.assignment_id, lockingAssignment.version, lockingAssignment.tenant_id, true,
    ).then((detail) => {
      if (!detail.resolved_run_manifest) throw new Error("The Assignment's checks could not be loaded. Refresh or clear the Assignment.");
      if (active) setAssignmentLoad({ source: lockingAssignment, detail, error: null });
    }).catch((reason) => {
      if (active) setAssignmentLoad({
        source: lockingAssignment, detail: null,
        error: reason instanceof Error ? reason.message : "Could not load Assignment checks. Refresh or clear the Assignment.",
      });
    });
    return () => { active = false; };
  }, [lockingAssignment]);

  const resolvedMetricIds = useMemo(
    () => lockedByAssignment ? assignmentManifest?.metric_ids ?? [] : [...new Set([
      ...resolveScoringMetricIds(selectedMetrics, contracts, selectedContracts, applyContracts),
      ...(kind === "provided" || preparedKind ? [] : PERFORMANCE_RECOMMENDED),
    ])],
    [applyContracts, contracts, selectedContracts, selectedMetrics, lockedByAssignment, assignmentManifest, kind, preparedKind],
  );
  const minimumScope = useMemo(
    () => requiredScopeForMetricIds(metrics, resolvedMetricIds),
    [metrics, resolvedMetricIds],
  );
  // Selected checks set the floor synchronously, before readiness or run requests are built.
  // `requestedScope` remains the user's manual override, so removing the check that raised
  // the floor lowers it again unless the user explicitly chose the deeper level.
  const evaluationScope: EvaluationScope = assignmentManifest?.evaluation_scope ?? deeperScope(requestedScope, minimumScope);
  // Selected-tools level: named tools a tool_interactions run is scoped to.
  // null = whole tool layer (every declared tool participates in scoring).
  const [selectedToolIds, setSelectedToolIds] = useState<string[] | null>(null);
  // Write-back of the named tools onto dataset rows as expectations (#3032).
  // Deliberately separate state from `selectedToolIds`: that scopes the run,
  // this states what rows should call. Nothing here rides the run submit.
  // BYO agents declare no tools in the CR, so the panel has nothing of the
  // agent's to offer. Fall back to the tenant's MCP tool catalogue rather
  // than leaving an unexplained empty panel.
  const [fallbackTools, setFallbackTools] = useState<string[]>([]);
  const writeBackRequestRef = useRef<string | null>(null);
  const [writeBackOpen, setWriteBackOpen] = useState(false);
  const [writeBackRecords, setWriteBackRecords] = useState<DatasetRecord[]>([]);
  const [writeBackRowIds, setWriteBackRowIds] = useState<string[]>([]);
  const [writeBackCreateVersion, setWriteBackCreateVersion] = useState(false);
  const [writeBackBusy, setWriteBackBusy] = useState(false);
  const [writeBackError, setWriteBackError] = useState<string | null>(null);
  const [writeBackResult, setWriteBackResult] = useState<WriteExpectedToolsResult | null>(null);
  const [readiness, setReadiness] = useState<EvidenceReadinessResult | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  // Which load() call owns the state. The kind is now switchable in step 1, so two
  // loads can be in flight at once and the slower one must not win: it would install
  // the previous kind's agents, LLM catalog and scenario-filtered contracts over the
  // current one, leaving a form nothing but Refresh can repair.
  const loadToken = useRef(0);

  useEffect(() => {
    if (!formDirty || activeRunId) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [activeRunId, formDirty]);

  // beforeunload only covers full page unloads; in-app <Link> navigations bypass it. Guard the
  // handful of links that leave this setup so unsaved changes aren't dropped silently.
  const guardInAppNavigation = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!formDirty || activeRunId) return;
      if (!window.confirm("You have unsaved evaluation setup. Leave this page and discard your changes?")) {
        event.preventDefault();
      }
    },
    [activeRunId, formDirty],
  );

  const load = useCallback(async () => {
    const token = (loadToken.current += 1);
    setLoading(true);
    setSetupLoadErrors({});
    setError(null);
    setErrorDetails([]);
    setProjectError(null);
    // Clear a stale optional-source status so a later successful reload doesn't keep showing it.
    setStatus((current) =>
      current && (current.includes("optional setup source") || current.includes("could not be read"))
        ? null
        : current,
    );
    try {
      const [datasetResult, metricsResult, agentsResult, llmsResult] = await Promise.allSettled([
          loadDatasetPickerPage([], null),
          evaluationApi.listMetrics().then(boundedMetricCatalog),
          kind === "agent" ? agentsApi.list(true) : Promise.resolve([]),
          kind === "llm" ? evaluationApi.listLlmCatalog() : Promise.resolve([] as LlmCatalogEntry[]),
        ]);
      const [contractsResult, promptsResult, capabilitiesResult, judgeResult, projectsResult, labResult] = await Promise.allSettled([
        platformApi.listQualityContractTemplates(),
        platformApi.listPrompts(),
        platformApi.capabilities(),
        evaluationApi.listJudgeModels(),
        api.tenant().then(async (tenant) => {
          // Scope remembered forms/drafts to this tenant before any draft is
          // restored or written; a tenant switch purges the previous state.
          bindRunFormTenant(tenant.tenant_id);
          const [projects, listedAssignments] = await Promise.all([
            api.listTraceProjects(tenant.tenant_id),
            platformApi.listAssignments(tenant.tenant_id).catch(() => [] as EvaluationAssignmentVersion[]),
          ]);
          return { projects, assignments: listedAssignments };
        }),
        preparedKind === "llm" ? readLabAvailability() : Promise.resolve(null),
      ]);
      const requestedDataset = datasetResult.status === "fulfilled"
        ? await ensureRequestedDataset(datasetResult.value.items, entryDatasetName)
        : { items: [] as DatasetInfo[], unreadable: null };
      if (token !== loadToken.current) return;
      const sourceErrors: Partial<Record<"datasets" | "metrics" | "agents" | "models", string>> = {};
      for (const [source, label, result] of [
        ["datasets", "Dataset catalog", datasetResult],
        ["metrics", "Metric catalog", metricsResult],
        ["agents", "Agent catalog", agentsResult],
        ["models", "Model catalog", llmsResult],
      ] as const) {
        if (result.status === "rejected") {
          const status = result.reason instanceof ApiError ? ` (HTTP ${result.reason.status})` : "";
          sourceErrors[source] = `${label} could not be loaded${status}. Retry setup to check this source again.`;
        }
      }
      setSetupLoadErrors(sourceErrors);
      // A target discovery outage must not discard successfully fetched evidence.
      // A failed dataset refresh preserves the previous list, visibly marked below.
      if (datasetResult.status === "fulfilled") {
        setDatasets(requestedDataset.items);
        setDatasetTotal(datasetResult.value.total);
        setDatasetNextCursor(datasetResult.value.nextCursor);
        setDatasetPageError(null);
      }
      setMetrics(metricsResult.status === "fulfilled" ? metricsResult.value : []);
      const listedContracts = contractsResult.status === "fulfilled" ? contractsResult.value : [];
      // The library is optional context: failing to load it must not stop a run.
      const listedPrompts = promptsResult.status === "fulfilled" ? promptsResult.value : [];
      setSavedPrompts(listedPrompts);
      // Drop comparison targets the reloaded catalog no longer offers, so a
      // failed refresh cannot leave refs that are invisible but still launch.
      const availableRefs = listedPrompts.map((prompt) => promptRef(prompt));
      setComparePromptRefs((current) => survivingCompareRefs(current, availableRefs));
      if (listedPrompts.length === 0) {
        setCompareAxis((current) => (current === "prompts" ? "none" : current));
      }
      // Offer saving only when the caller could actually save: the endpoint
      // requires the approver role, and a button that 403s is worse than none.
      setCanManagePrompts(
        capabilitiesResult.status === "fulfilled" &&
          capabilitiesResult.value.actions?.manage_prompts === true,
      );
      const judgeConfig: { models: string[] } = judgeResult.status === "fulfilled" ? judgeResult.value : { models: [] };
      const catalogContext = projectsResult.status === "fulfilled"
        ? projectsResult.value
        : { projects: [] as TraceProject[], assignments: [] as EvaluationAssignmentVersion[] };
      const listedProjects = catalogContext.projects;
      const listedAssignments = catalogContext.assignments.filter((item) => !item.archived_at);
      setAssignments(listedAssignments);
      setAssignmentId((currentId) => {
        if (!currentId) return "";
        return listedAssignments.some((item) => item.assignment_id === currentId) ? currentId : "";
      });
      setAssignmentVersion((currentVersion) => {
        if (!currentVersion) return "";
        return listedAssignments.some((item) => item.version === currentVersion) ? currentVersion : "";
      });
      setContracts(listedContracts.filter((contract) => contract.scenario === scenarioFor(kind)));
      setAgents(agentsResult.status === "fulfilled" ? agentsResult.value : []);
      setLlmCatalog(llmsResult.status === "fulfilled" ? llmsResult.value : []);
      setLabAvailability(labResult.status === "fulfilled" ? labResult.value : null);
      // Same inventory as /projects: active system Projects plus visible,
      // disabled historical Projects. Archived Projects are dropped here rather
      // than downstream, so no later lookup — the picker, the agent's bound
      // Project, a restored draft — can resolve to one.
      setProjects(selectableTracingProjects(listedProjects));
      setProjectId((current) =>
        current && listedProjects.some(
          (project) => project.project_id === current && project.purpose === "system",
        )
          ? current
          : "",
      );
      setJudgeModels(judgeConfig.models);
      setJudgeModel((current) =>
        current && judgeConfig.models.includes(current) ? current : "",
      );
      const optionalFailures = [contractsResult, judgeResult, projectsResult].filter((result) => result.status === "rejected").length;
      const notices = [
        requestedDataset.unreadable ? requestedDatasetUnavailableNotice(requestedDataset.unreadable) : null,
        optionalFailures
          ? `${optionalFailures} optional setup source${optionalFailures === 1 ? " is" : "s are"} unavailable. Core evaluation setup remains available.`
          : null,
      ].filter(Boolean);
      if (notices.length) {
        setStatus(notices.join(" "));
      }
    } catch (reason) {
      if (token !== loadToken.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, [entryDatasetName, kind, preparedKind]);

  useEffect(() => {
    let cancelled = false;
    if (!rerunRequested || !rerunSourceRunId) {
      return () => {
        cancelled = true;
      };
    }

    // A client-side move between source runs keeps this component mounted.
    // Make both one-shot hydration effects eligible for the new source; their
    // source-id guard below prevents stale configuration from being applied.
    formPrefillApplied.current = false;
    contractsPrefillApplied.current = false;
    assignmentPrefillApplied.current = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setRerunConfiguration(null);
      try {
        const tenant = await api.tenant();
        const configuration = await evaluationApi.getRunConfiguration(
          rerunSourceRunId,
          tenant.tenant_id,
        );
        if (!cancelled) setRerunConfiguration(configuration);
      } catch (reason) {
        if (!cancelled) {
          setStatus(
            `The original run configuration could not be loaded. Restoring the parameters available in the run summary instead. ${userFacingError(reason)}`,
          );
        }
      } finally {
        if (!cancelled) setRerunConfigurationLoadedFor(rerunSourceRunId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [rerunRequested, rerunSourceRunId]);

  useEffect(() => {
    formPrefillApplied.current = false;
    contractsPrefillApplied.current = false;
    assignmentPrefillApplied.current = false;
    draftPrefillApplied.current = false;
    // Reset form state when the route changes evaluation kind.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedMetrics(DEFAULT_METRICS[kind]);
    setSelectedContracts([]);
    setApplyContracts(false);
    // The dataset survives a kind change on purpose: it is evidence, not a target, and
    // re-picking it after every change of mind is exactly the coupling this step removed.
    setAgentId("");
    setProjectId("");
    setAssignmentId("");
    setAssignmentVersion("");
    setSelectedLlmId("");
    // Comparison selections name the models being cleared just above, so keeping them would
    // leave the form pointing at targets it no longer holds.
    // "none" is the default: a comparison is opt-in, and this effect runs on
    // mount, so "models" here reinstated the pre-chosen axis it replaced.
    setCompareAxis("none");
    setCompareLlmIds([]);
    setComparePromptRefs([]);
    if (kind !== "llm") {
      setSystemPrompt("");
      setSystemPromptRef(null);
    }
    setEvaluationScope("final_response");
    setSelectedToolIds(null);
    setPreviewOpen(false);
    setPreviewRecords([]);
    setPreviewError(null);
    void load();
  }, [kind, load, entryAgentRef]);

  useEffect(() => {
    if (
      loading ||
      formPrefillApplied.current ||
      (rerunRequested && rerunConfigurationLoadedFor !== rerunSourceRunId)
    ) return;
    const rerun = rerunRequested;
    const requestedDataset = entryDatasetName;
    if (!rerun && !requestedDataset && !entryAgentRef) return;

    const fromRun = rerunSourceRunId;
    const memory = fromRun ? recallRunForm(fromRun) : null;
    const configuration = rerunConfiguration;

    const dataset =
      requestedDataset || (configuration ? configuration.dataset_name : memory?.datasetName);
    // Hydrate the rerun form once from URL/session memory.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (dataset) setDatasetName(dataset);

    // Discovery can fail independently of datasets. Keep the entry eligible so
    // Retry setup can apply its requested agent after the catalog recovers.
    if (!rerun && entryAgentRef && !formDirty && !agents.some((agent) => agent.id === entryAgentRef)) {
      setTargetError("This agent is not ready. Open What to test, check its model connection, then refresh.");
      return;
    }
    formPrefillApplied.current = true;

    if (!rerun) {
      if (entryAgentRef && !formDirty) {
        const agent = agents.find((item) => item.id === entryAgentRef);
        if (!agent) {
          setTargetError("This agent is not ready. Open What to test, check its model connection, then refresh.");
          return;
        }
        setAgentId(agent.id);
        setTargetError(null);
        setEvaluationName(agentBaselineName(agent));
        const recommendedMetrics = runnableAgentMetricIds(agent, metrics);
        if (recommendedMetrics.length) setSelectedMetrics(recommendedMetrics);
        if (agent.execution_mode === "guided_local_workflow") {
          setEvaluationScope("tool_interactions");
          setParallelRequests(1);
          setHumanReview(false);
          setJudgeModel("");
        }
        const boundProject = projects.find((project) => project.project_id === agent.system_project_id && project.purpose === "system");
        setProjectId(boundProject?.project_id ?? "");
        if (!requestedDataset && agent.recommended_dataset_id && datasets.some((item) => fullName(item) === agent.recommended_dataset_id)) setDatasetName(agent.recommended_dataset_id);
        setStatus(`Selected ${agent.display_name || agent.name} and its available workflow checks. Review the setup, then run a fresh evaluation.`);
        return;
      }
      if (!preparedKind || formDirty) return;
      const selected = datasets.find((item) => fullName(item) === requestedDataset) ?? null;
      const prepared = preparedArtifacts({
        golden: preparedKind === "llm" ? selected : null,
        rehearsal: preparedKind === "provided" ? selected : null,
        metrics, prompts: savedPrompts, projects, models: llmCatalog, lab: labAvailability,
      });
      setSelectedMetrics(prepared.metricIds);
      setSelectedContracts([]);
      setApplyContracts(false);
      setParallelRequests(1);
      setEvaluationScope("final_response");
      setHumanReview(false);
      setJudgeModel("");
      setEvaluationName(preparedExperimentName(preparedKind));
      setRunLabels([preparedKind === "provided" ? "nova-offline-rehearsal" : "nova-live-model"]);
      setProjectId(prepared.project?.project_id ?? "");
      if (!prepared.project) setProjectError("The prepared Nova project is unavailable. Select an active system project.");
      if (!prepared.metricsReady) setChecksError("Some prepared text metrics are unavailable. Review the selected checks.");
      if (preparedKind === "llm") {
        setSystemPrompt(prepared.prompt?.content ?? "");
        setSystemPromptRef(prepared.prompt ? promptRef(prepared.prompt) : null);
        setSelectedLlmId(prepared.model ? modelSelectionId(prepared.model) : "");
        if (!prepared.model) setTargetError("Configure a live model before running this prepared evaluation.");
      }
      setStatus(preparedKind === "provided"
        ? "Prepared Nova rehearsal: real text scoring on authored responses. No model or agent will be invoked. Review the setup, then run. Your other saved draft is unchanged."
        : "Prepared Nova live evaluation: prompt version 2, reference cases and text metrics selected. Review the setup before invoking the configured model. Your other saved draft is unchanged.");
      return;
    }

    if (kind === "agent") {
      const agent =
        searchParams.get("agent") || (configuration ? configuration.agent : memory?.agentId);
      if (agent) setAgentId(agent);
      // Restore the source run's named-tool selection (selected-tools level).
      // The backend re-validates it against the agent's current tool inventory.
      const toolsParam = searchParams.get("tools");
      if (toolsParam != null) {
        setSelectedToolIds(
          toolsParam.split(",").map((tool) => tool.trim()).filter(Boolean),
        );
      } else if (configuration && configuration.selected_tool_ids !== undefined) {
        setSelectedToolIds(configuration.selected_tool_ids ?? null);
      } else if (memory?.selectedToolIds !== undefined) {
        setSelectedToolIds(memory.selectedToolIds ?? null);
      }
    } else if (kind === "llm") {
      const nextModel =
        searchParams.get("targetModel") ||
        searchParams.get("llm") ||
        (configuration
          ? configuration.target_model
          : memory?.selectedLlmId || memory?.targetModel);
      if (nextModel) setSelectedLlmId(configuration?.target_endpoint?.includes("://") && configuration.target_model === nextModel
        ? modelSelectionId({ model_id: nextModel, endpoint: configuration.target_endpoint }) : nextModel);
    }

    // Restore the source run's tracing Project so the rerun stays in the same
    // trace stream. Only an active system Project is restorable — the same rule
    // the Project selector itself enforces. When the original Project is no
    // longer available, say so on the Project field instead of silently leaving
    // the rerun unassigned; nothing is auto-selected in its place.
    const restoredProject = restoredProjectState(
      searchParams.get("project") ||
        (configuration ? configuration.project_id : memory?.projectId),
      projects,
    );
    if (restoredProject.projectId) setProjectId(restoredProject.projectId);
    const restoredAssignmentId = configuration?.assignment_id || "";
    const restoredAssignmentVersion = configuration?.assignment_version || "";
    if (restoredAssignmentId && restoredAssignmentVersion) {
      const restoredAssignment = assignments.find(
        (item) => item.assignment_id === restoredAssignmentId && item.version === restoredAssignmentVersion,
      );
      setAssignmentId(restoredAssignmentId);
      setAssignmentVersion(restoredAssignmentVersion);
      if (restoredAssignment?.project_id) setProjectId(restoredAssignment.project_id);
      setApplyContracts(false);
      setSelectedContracts([]);
    } else {
      setAssignmentId("");
      setAssignmentVersion("");
    }
    if (restoredProject.notice) setProjectError(restoredProject.notice);

    const judge =
      searchParams.get("judgeModel") ||
      (configuration ? configuration.judge_model : memory?.judgeModel);
    if (judge) {
      setJudgeModel(judge);
    }

    const label =
      searchParams.get("label") || (configuration ? configuration.label : memory?.label);
    if (label) setRunLabels([label]);

    const evalName =
      searchParams.get("evaluationName") ||
      (configuration ? configuration.evaluation_name : memory?.evaluationName);
    if (evalName) setEvaluationName(evalName);

    const rememberedScope =
      (searchParams.get("evaluationScope") as EvaluationScope | null) ||
      (configuration ? configuration.evaluation_scope : memory?.evaluationScope);
    if (rememberedScope && EVALUATION_DEPTHS.some((depth) => depth.scope === rememberedScope)) {
      setEvaluationScope(rememberedScope);
    }

    const parallel = searchParams.get("parallelRequests");
    if (parallel) setParallelRequests(Math.min(20, Math.max(1, Number(parallel) || 5)));
    else if (configuration) setParallelRequests(configuration.parallel_requests);
    else if (memory?.parallelRequests) setParallelRequests(memory.parallelRequests);

    setHumanReview(
      searchParams.get("humanReview") === "1"
        ? true
        : (configuration?.run_human_review ?? memory?.humanReview ?? false),
    );

    if (kind === "llm") {
      const restoredPromptRef =
        searchParams.get("promptRef") ||
        (configuration ? configuration.prompt_version_ref : memory?.systemPromptRef) ||
        null;
      setSystemPrompt(
        configuration ? configuration.system_prompt || "" : memory?.systemPrompt || "",
      );
      setSystemPromptRef(restoredPromptRef);
    }

    const metricsParam = searchParams.get("metrics");
    const restoredMetrics = configuration?.active_metrics || memory?.selectedMetrics || [];
    if (metricsParam || restoredMetrics.length) {
      const runnableMetricIds = new Set(
        metrics
          .filter((metric) => metric.available_in_run !== false)
          .map((metric) => metric.metric_id),
      );
      setSelectedMetrics(
        (metricsParam ? metricsParam.split(",") : restoredMetrics)
          .map((item) => item.trim())
          .filter(
            (item) =>
              item &&
              !isQualityMetricId(item) &&
              runnableMetricIds.has(item),
          ),
      );
    }

    if (
      !restoredAssignmentId &&
      (
        searchParams.get("applyContracts") === "1" ||
        searchParams.get("contractMetrics") ||
        configuration?.quality_contract_ids.length ||
        memory?.applyContracts
      )
    ) {
      setApplyContracts(true);
    }

    setStatus("Loaded parameters from the previous evaluation run.");
  }, [
    loading,
    searchParams,
    entryDatasetName,
    entryAgentRef,
    agents,
    preparedKind,
    formDirty,
    datasets,
    savedPrompts,
    llmCatalog,
    labAvailability,
    kind,
    metrics,
    projects,
    assignments,
    rerunConfiguration,
    rerunConfigurationLoadedFor,
    rerunRequested,
    rerunSourceRunId,
  ]);

  useEffect(() => {
    if (loading || assignmentPrefillApplied.current) return;
    const requested = assignmentFromSearchParams(searchParams);
    if (!requested) return;
    const timer = window.setTimeout(() => {
    assignmentPrefillApplied.current = true;
    const match = assignments.find(
      (item) =>
        item.assignment_id === requested.assignmentId &&
        item.version === requested.assignmentVersion,
    );
    if (!match) {
      setStatus(
        "The Assignment from this link is unavailable or archived. Choose an Assignment explicitly in Advanced Settings, or continue as a diagnostic evaluation.",
      );
      return;
    }
    setAssignmentId(match.assignment_id);
    setAssignmentVersion(match.version);
    if (match.project_id) setProjectId(match.project_id);
    setApplyContracts(false);
    setSelectedContracts([]);
    setStatus(
      `Assignment ${match.name} · ${match.version} selected from the catalogue link. Choose a dataset, then run.`,
    );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, searchParams, assignments]);

  useEffect(() => {
    if (
      loading ||
      contractsPrefillApplied.current ||
      !contracts.length ||
      (rerunRequested && rerunConfigurationLoadedFor !== rerunSourceRunId)
    ) return;
    if (!rerunRequested) return;
    const fromRun = rerunSourceRunId;
    const memory = fromRun ? recallRunForm(fromRun) : null;
    const contractMetrics = (searchParams.get("contractMetrics") || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const memoryContractIds = memory?.selectedContracts || [];
    const recordedContractIds = rerunConfiguration?.quality_contract_ids;
    if (recordedContractIds) {
      contractsPrefillApplied.current = true;
      if (recordedContractIds.length) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setApplyContracts(true);
        setSelectedContracts(recordedContractIds);
      }
      return;
    }
    if (
      !contractMetrics.length &&
      !memoryContractIds.length &&
      searchParams.get("applyContracts") !== "1" &&
      !memory?.applyContracts
    ) {
      return;
    }
    contractsPrefillApplied.current = true;
    // Hydrate the optional contract selection once after its catalog loads.
    setApplyContracts(true);
    if (memoryContractIds.length) {
      setSelectedContracts(memoryContractIds);
      return;
    }
    if (!contractMetrics.length) return;
    setSelectedContracts(
      contracts
        .filter((contract) => contractMetrics.includes(contract.metric_id))
        .map((contract) => contract.template_id),
    );
  }, [
    loading,
    searchParams,
    contracts,
    rerunConfiguration,
    rerunConfigurationLoadedFor,
    rerunRequested,
    rerunSourceRunId,
  ]);

  useEffect(() => {
    if (loading || draftPrefillApplied.current) return;
    draftPrefillApplied.current = true;
    if (searchParams.get("rerun") === "1" || preparedKind || entryAgentRef) return;
    const draft = recallRunDraft(kind);
    if (!draft) return;
    if (entryDatasetName && draft.datasetName !== entryDatasetName) return;
    const timer = window.setTimeout(() => {
      if (draft.evaluationName) setEvaluationName(draft.evaluationName);
      if (draft.labels?.length) setRunLabels(draft.labels);
      else if (draft.label) setRunLabels([draft.label]);
      if (draft.datasetName) setDatasetName(draft.datasetName);
      if (draft.agentId) setAgentId(draft.agentId);
      if (draft.selectedLlmId) setSelectedLlmId(draft.selectedLlmId);
      if (
        draft.projectId &&
        projects.some(
          (project) => project.project_id === draft.projectId && project.purpose === "system",
        )
      ) {
        setProjectId(draft.projectId);
      }
      if (draft.judgeModel) setJudgeModel(draft.judgeModel);
      if (draft.humanReview) setHumanReview(true);
      if (draft.parallelRequests) setParallelRequests(draft.parallelRequests);
      if (draft.selectedMetrics?.length) setSelectedMetrics(draft.selectedMetrics);
      if (draft.selectedContracts?.length) setSelectedContracts(draft.selectedContracts);
      if (draft.applyContracts) setApplyContracts(true);
      if (kind === "llm" && draft.systemPrompt) setSystemPrompt(draft.systemPrompt);
      if (kind === "llm" && draft.systemPromptRef) setSystemPromptRef(draft.systemPromptRef);
      if (draft.selectedToolIds !== undefined) {
        setSelectedToolIds(draft.selectedToolIds ?? null);
      }
      if (
        draft.evaluationScope &&
        EVALUATION_DEPTHS.some((depth) => depth.scope === draft.evaluationScope)
      ) {
        setEvaluationScope(draft.evaluationScope);
      }
      setStatus(`Restored your unfinished setup from ${new Date(draft.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [entryDatasetName, entryAgentRef, kind, loading, projects, searchParams, preparedKind]);

  useEffect(() => {
    if (loading || !draftPrefillApplied.current || !formDirty || activeRunId || preparedKind) return;
    const timer = window.setTimeout(() => {
      rememberRunDraft(kind, {
        kind,
        evaluationName,
        label: runLabels[0] ?? "",
        labels: runLabels,
        datasetName,
        agentId: kind === "agent" ? agentId : null,
        selectedLlmId: kind === "llm" ? selectedLlmId : null,
        projectId,
        judgeModel,
        humanReview,
        parallelRequests,
        selectedMetrics,
        selectedContracts,
        applyContracts,
        systemPrompt,
        systemPromptRef,
        selectedToolIds,
        evaluationScope,
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    activeRunId,
    preparedKind,
    agentId,
    applyContracts,
    datasetName,
    evaluationScope,
    evaluationName,
    formDirty,
    humanReview,
    judgeModel,
    kind,
    loading,
    parallelRequests,
    projectId,
    runLabels,
    selectedContracts,
    selectedLlmId,
    selectedMetrics,
    selectedToolIds,
    systemPrompt,
    systemPromptRef,
  ]);

  const applicableMetrics = useMemo(
    () => metrics.filter((metric) => !isQualityMetricId(metric.metric_id)),
    [metrics],
  );

  // Every published dataset, latest version per lineage — no mode gate.
  const datasetOptions = useMemo(() => datasetPickerOptions(datasets), [datasets]);
  const selectedDataset = useMemo(
    () => datasetOptions.find((option) => option.name === datasetName)?.dataset ?? null,
    [datasetName, datasetOptions],
  );
  const selectedMissingFields = selectedDataset ? datasetMissingFields(selectedDataset) : [];
  const selectedMissingProvidedResponse =
    kind === "provided" && selectedDataset?.missing_provided_response === true;

  async function refreshJudgeModels() {
    setImportingModels(true);
    setError(null);
    try {
      const config = await evaluationApi.listJudgeModels();
      const imported = config.models;
      setJudgeModels(imported);
      setJudgeModel((current) =>
        current && imported.includes(current) ? current : "",
      );
      setStatus(
        imported.length
          ? `Loaded ${imported.length} model${imported.length === 1 ? "" : "s"} from the AI Gateway${config.fallback ? " (configured fallback)" : ""}.`
          : "No scoring models are available from the AI Gateway.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImportingModels(false);
    }
  }

  async function loadMoreDatasets() {
    if (!datasetNextCursor || datasetsLoadingMore) return;
    setDatasetsLoadingMore(true);
    setDatasetPageError(null);
    try {
      const page = await loadDatasetPickerPage(datasets, datasetNextCursor);
      setDatasets(page.items);
      setDatasetTotal(page.total);
      setDatasetNextCursor(page.nextCursor);
    } catch (reason) {
      setDatasetPageError(userFacingError(reason));
    } finally {
      setDatasetsLoadingMore(false);
    }
  }

  async function previewDataset() {
    if (!datasetName) return;
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const records = await api.getRecords(datasetName);
      setPreviewRecords(records.slice(0, 5));
    } catch (reason) {
      setPreviewRecords([]);
      setPreviewError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPreviewLoading(false);
    }
  }

  const closeDatasetPreview = useCallback(() => {
    setPreviewOpen(false);
    window.requestAnimationFrame(() => previewTriggerRef.current?.focus());
  }, []);

  const toggleMetric = useCallback((metricId: string) => {
    if (metricId.startsWith("ops.")) return;
    setChecksError(null);
    setSelectedMetrics((current) =>
      current.includes(metricId)
        ? current.filter((id) => id !== metricId)
        : [...current, metricId],
    );
  }, []);

  function toggleContract(templateId: string) {
    const current = applyContracts ? selectedContracts : [];
    const next = current.includes(templateId)
      ? current.filter((id) => id !== templateId)
      : [...current, templateId];
    setSelectedContracts(next);
    setApplyContracts(next.length > 0);
    setFormDirty(true);
  }

  const selectedLlm = useMemo(
    () => findSelectedModel(llmCatalog, selectedLlmId),
    [llmCatalog, selectedLlmId],
  );
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === agentId) ?? null,
    [agents, agentId],
  );
  const recommendedAgentDataset = selectedAgent?.execution_mode === "guided_local_workflow" ? selectedAgent.recommended_dataset_id : null;
  const agentDatasetMismatch = Boolean(recommendedAgentDataset && datasetName !== recommendedAgentDataset);

  async function useAgentGoldenDataset() {
    if (!recommendedAgentDataset || !selectedAgent) return;
    const token = ++agentDatasetLoadToken.current;
    setAgentDatasetLoading(true);
    setAgentDatasetError(null);
    const requested = await ensureRequestedDataset(datasets, recommendedAgentDataset);
    if (token !== agentDatasetLoadToken.current) return;
    setAgentDatasetLoading(false);
    if (requested.unreadable) {
      setAgentDatasetError(requestedDatasetUnavailableNotice(recommendedAgentDataset));
      return;
    }
    setDatasets((current) => [...current, ...requested.items].filter((item, index, all) => all.findIndex((candidate) => fullName(candidate) === fullName(item)) === index));
    setDatasetName(recommendedAgentDataset);
    setDatasetError(null);
    setPreviewOpen(false);
    setPreviewRecords([]);
    setPreviewError(null);
    setFormDirty(true);
    setStatus(`Selected the prepared golden dataset for ${selectedAgent.display_name || selectedAgent.name}. Review its cases before running.`);
  }

  // Declared tool inventory of the selected agent (null until one is chosen).
  const agentTools = useMemo(
    () => (kind === "agent" && selectedAgent ? selectedAgent.tools : null),
    [kind, selectedAgent],
  );
  // A selection covering every declared tool collapses back to the whole tool
  // layer (null); a subset is the selected-tools evaluation level.
  const normalizedToolSelection = useMemo(
    () => normalizeToolSelection(selectedToolIds, agentTools),
    [agentTools, selectedToolIds],
  );

  const agentDeclaresNoTools =
    kind === "agent" && Boolean(selectedAgent) && (agentTools?.length ?? 0) === 0;
  const activeFallbackTools = useMemo(
    () => (agentDeclaresNoTools ? fallbackTools : []),
    [agentDeclaresNoTools, fallbackTools],
  );

  useEffect(() => {
    if (!agentDeclaresNoTools) return;
    let cancelled = false;
    agentsApi
      .toolServers()
      .then((servers) => {
        if (cancelled) return;
        setFallbackTools([...new Set(servers.flatMap((server) => server.tools))].sort());
      })
      .catch(() => {
        // A missing catalogue is not an error the operator can act on here;
        // the panel already explains that no inventory is known.
        if (!cancelled) setFallbackTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentDeclaresNoTools]);

  // Publishing the draft the write-back just created, without leaving this
  // screen. Editing a dataset needs DRAFT and evaluating it needs PUBLISHED, so
  // without this the operator has to abandon the run they are configuring,
  // take the new version through its lifecycle elsewhere, and start again.
  const [publishing, setPublishing] = useState(false);
  const [publishSteps, setPublishSteps] = useState<
    Array<{ label: string; ok: boolean; detail?: string }>
  >([]);
  const [publishState, setPublishState] = useState<"idle" | "published">("idle");

  // Open the write-back picker: load the rows so the operator chooses which of
  // them actually carry this expectation. Nothing is written until they commit.
  const openWriteBack = useCallback(async () => {
    setWriteBackOpen(true);
    setWriteBackError(null);
    setWriteBackResult(null);
    setPublishSteps([]);
    setPublishState("idle");
    setWriteBackBusy(true);
    // Capture the dataset this load is for. Without it a slower response for a
    // previous dataset could land after a newer one and show the wrong rows.
    const requestedFor = datasetName;
    writeBackRequestRef.current = requestedFor;
    try {
      const records = await api.getRecords(requestedFor);
      if (writeBackRequestRef.current !== requestedFor) return;
      setWriteBackRecords(records);
      setWriteBackRowIds([]);
    } catch (error) {
      if (writeBackRequestRef.current !== requestedFor) return;
      setWriteBackError(userFacingError(error, "Could not load the dataset rows."));
      setWriteBackRecords([]);
    } finally {
      if (writeBackRequestRef.current === requestedFor) setWriteBackBusy(false);
    }
  }, [datasetName]);

  const publishWrittenVersion = useCallback(async () => {
    const target = writeBackResult?.dataset_name;
    if (!target) return;
    setPublishing(true);
    setPublishSteps([]);
    const steps: Array<{ label: string; ok: boolean; detail?: string }> = [];
    const record = (label: string, ok: boolean, detail?: string) => {
      steps.push({ label, ok, detail });
      setPublishSteps([...steps]);
      return ok;
    };
    try {
      const validation = await api.validate(target);
      // A failing quality gate is a refusal, not an error — say which checks
      // blocked it rather than reporting a generic failure.
      if (
        !record(
          "Validate",
          validation.passed,
          validation.passed
            ? `DQS ${validation.dqs.toFixed(2)}`
            : validation.blocker_failures.join(", ") || "quality gate not met",
        )
      ) {
        return;
      }
      await api.approve(target, "proofgrove-ui");
      record("Approve", true);
      await api.publish(target);
      record("Publish", true);
      // Retarget: the new version is the one carrying the expectations just
      // written, so the run being configured must point at it or the write has
      // no effect on what gets scored.
      //
      // Seed it into the picker inventory FIRST. The list was paged in before
      // this version existed, so selecting a name the options do not contain
      // silently selects nothing — which is what made the button look inert.
      const seeded = await ensureRequestedDataset(datasets, target);
      setDatasets(seeded.items);
      setDatasetName(target);
      setPublishState("published");
    } catch (error) {
      const message = userFacingError(error, "Could not publish the new version.");
      const failed = steps.length === 0 ? "Validate" : steps.length === 1 ? "Approve" : "Publish";
      record(failed, false, message);
    } finally {
      setPublishing(false);
    }
  }, [writeBackResult, datasets]);

  const commitWriteBack = useCallback(async () => {
    const tools = normalizedToolSelection ?? agentTools ?? activeFallbackTools;
    if (!tools.length || !writeBackRowIds.length) return;
    setWriteBackBusy(true);
    setWriteBackError(null);
    try {
      const result = await api.writeExpectedTools(datasetName, {
        record_ids: writeBackRowIds,
        tools,
        source_agent: selectedAgent?.id ?? null,
        create_version_if_immutable: writeBackCreateVersion,
      });
      setWriteBackResult(result);
      // Deliberately do NOT retarget the run at a created draft version. The
      // picker only offers PUBLISHED datasets and the backend refuses to run
      // anything else, so switching would strand the form on a dataset that
      // cannot be scored. The dialog tells the operator to take the new draft
      // through validate → approve → publish instead.
      //
      // The dialog keeps reading the dataset it writes to (`datasetName`) —
      // showing the new draft's rows here while a second commit would still
      // write against the original invited a silent second branch. Consent to
      // version is also spent: each opt-in creates exactly one draft.
      if (result.created_version) setWriteBackCreateVersion(false);
      const refreshed = await api.getRecords(datasetName);
      setWriteBackRecords(refreshed);
      setWriteBackRowIds([]);
    } catch (error) {
      setWriteBackError(userFacingError(error, "Could not write the expected tools."));
    } finally {
      setWriteBackBusy(false);
    }
  }, [
    agentTools,
    datasetName,
    activeFallbackTools,
    normalizedToolSelection,
    selectedAgent,
    writeBackCreateVersion,
    writeBackRowIds,
  ]);

  const toolSelectionEmpty =
    scopeInspectsTools(evaluationScope) &&
    normalizedToolSelection !== null &&
    normalizedToolSelection.length === 0;
  // Metric ids required by an applied rubric template; kept even when not applicable so they stay
  // locked and block Run instead of being silently dropped.
  const contractRequiredMetricIds = useMemo(
    () => (applyContracts
      ? contracts.filter((contract) => selectedContracts.includes(contract.template_id)).map((contract) => contract.metric_id)
      : []),
    [applyContracts, contracts, selectedContracts],
  );
  // The metrics actually scored: resolved selection minus backend "known_not_applicable" checks.
  const activeMetricIds = useMemo(
    () => applicableScoringMetricIds(resolvedMetricIds, readiness, contractRequiredMetricIds),
    [resolvedMetricIds, readiness, contractRequiredMetricIds],
  );
  const contractMetricBlocked = useMemo(
    () => hasContractMetricNotApplicable(contractRequiredMetricIds, readiness),
    [contractRequiredMetricIds, readiness],
  );
  // Per-depth availability from the readiness response; unavailable depths render disabled with
  // the exact backend reason. The selected depth is never silently replaced.
  const scopeOptions = useMemo(() => scopeOptionsFrom(readiness), [readiness]);
  const selectedDepth = EVALUATION_DEPTHS.find((depth) => depth.scope === evaluationScope);
  const minimumDepth = EVALUATION_DEPTHS.find((depth) => depth.scope === minimumScope);
  const depthFloorMetric = metrics.find(
    (metric) =>
      resolvedMetricIds.includes(metric.metric_id) &&
      metricEvidenceScope(metric) === minimumScope,
  ) ?? null;
  const depthIsManual = evaluationScope !== minimumScope;
  const evaluationDepthOptionState = (scope: EvaluationScope) => {
    if (deeperScope(scope, minimumScope) !== scope) {
      return {
        disabled: true,
        reason: `${depthFloorMetric?.metric_id ?? "A selected check"} requires ${minimumDepth?.label ?? minimumScope}.`,
        caveat: null,
      };
    }
    return depthOptionState(scopeOptions, scope);
  };
  // Whether any depth beyond the final response is actually offered here. The
  // help text used to say "any depth is available" whenever no check forced a
  // floor — true for an agent, false for an LLM or a provided-response run,
  // where the deeper options are always disabled because there is no tool layer
  // or trace to inspect. Read from the same state the buttons use, so the
  // sentence cannot drift from what the user can click.
  const deeperDepthOffered = EVALUATION_DEPTHS.some(
    (depth) =>
      depth.scope !== "final_response" && !evaluationDepthOptionState(depth.scope).disabled,
  );
  // A restored selection can be disabled for this setup; hand the tab stop to an
  // enabled depth so the radiogroup stays keyboard-reachable.
  const depthTabStop = rovingRadioTabStop({
    values: EVALUATION_DEPTHS.map((depth) => depth.scope),
    current: evaluationScope,
    disabled: (value) => evaluationDepthOptionState(value as EvaluationScope).disabled,
  });
  const selectedCheckCount = (lockedByAssignment ? resolvedMetricIds : activeMetricIds).filter((id) => !id.startsWith("ops.")).length;
  const selectedScoringMetrics = useMemo(
    () => resolvedMetricIds.filter((id) => !id.startsWith("ops.")).map((id) =>
      metrics.find((metric) => metric.metric_id === id) ?? {
        metric_id: id,
        name: contracts.find((contract) => contract.metric_id === id)?.name ?? id,
        description: "Check configured by the Assignment.",
      },
    ),
    [metrics, contracts, resolvedMetricIds],
  );
  const offeredCheckCount = useMemo(
    () => applicableMetrics.filter(
      (metric) =>
        !metric.metric_id.startsWith("ops.") &&
        metricVisibleForKind(metric, kind),
    ).length,
    [applicableMetrics, kind],
  );
  const recommendedMetricIds = useMemo(
    () => recommendedMetricIdsForScope(kind === "agent" ? "tool_interactions" : "final_response"),
    [kind],
  );
  const judgeRequired = useMemo(
    () => selectedScoringMetrics.some(metricRequiresJudge),
    [selectedScoringMetrics],
  );
  // Always the real scorer when a check needs one. The old toggle swapped in a
  // mock judge, whose output records as UNSCORED/SIMULATED — a run that finished,
  // looked complete and asserted nothing for every judged check. The capability
  // still exists server-side via `judge_mode`; it is no longer a product surface.
  const effectiveJudgeEnabled = judgeRequired;
  const targetReady =
    kind === "provided" ? true : kind === "agent" ? Boolean(selectedAgent) : Boolean(selectedLlm);
  const nameReady = Boolean(evaluationName.trim());
  // Not computed is not "cannot": only a dataset the backend read and found incomplete blocks.
  const datasetReady =
    Boolean(selectedDataset) &&
    selectedMissingFields.length === 0 &&
    !selectedMissingProvidedResponse;
  // Step 1 asks two questions: what is being evaluated, and against which
  // dataset. A seeded kind is a starting value, not an answer, so picking a
  // dataset must not complete the step on the user's behalf. `kindChosen` and
  // `chosenKind` are derived beside the scope above, which needs them.
  const showEvaluationDepth = evaluationDepthVisible(chosenKind);

  const settingsReady = selectedCheckCount > 0 && (lockedByAssignment || !applyContracts || selectedContracts.length > 0);
  const stepComplete = evaluationFormStepComplete({
    nameReady,
    targetReady,
    datasetReady,
    settingsReady,
  });
  // Cumulative in section order: Dataset → Name → system.
  const datasetStepRequirements: StepRequirement[] = [
    {
      label: selectedMissingFields.length
        ? `Select a dataset whose rows carry a ${missingFieldsLabel(selectedMissingFields)}`
        : "Select a published dataset",
      met: datasetReady,
    },
  ];
  const nameStepRequirements: StepRequirement[] = [
    ...datasetStepRequirements,
    { label: "Name your evaluation", met: nameReady },
  ];
  const targetStepRequirements: StepRequirement[] = [
    ...nameStepRequirements,
    ...(chosenKind === "provided"
      ? []
      : [{
          label:
            chosenKind === "agent" ? "Select an agent" : "Select an LLM from the LLM Catalog",
          met: targetReady,
        }]),
  ];
  const setupReady = stepComplete[3];
  const progressComplete = [
    stepComplete[0],
    stepComplete[1],
    stepComplete[2],
    stepComplete[3] && settingsVisited,
  ];
  const firstIncompleteStep = stepComplete.findIndex((complete) => !complete);
  const currentStep = firstIncompleteStep === -1 ? 4 : firstIncompleteStep + 1;
  const targetSummary =
    chosenKind === "provided"
      ? "Existing dataset responses"
      : chosenKind === "agent"
      ? selectedAgent?.display_name || selectedAgent?.name || "Not selected"
      : selectedLlm?.name || selectedLlm?.model_id || "Not selected";
  const visibleStep = visibleEvaluationFormStep({ expandedStep, currentStep, stepComplete });
  // Strip cell N is section N. Availability comes from the same gate scrollToStep
  // enforces, so the strip can never offer (or refuse) a step the handler disagrees with.
  const progressStepCompleted = EVALUATION_SETUP_STEP_IDS.map(
    (_id, index) => progressComplete[index] ?? false,
  );
  const progressStepAvailable = EVALUATION_SETUP_STEP_IDS.map((_id, index) =>
    canOpenEvaluationFormStep({ step: index + 1, currentStep, stepComplete }),
  );

  function stateForStep(step: number): SetupStepState {
    if (visibleStep === step) return "active";
    return progressComplete[step - 1] ? "complete" : "upcoming";
  }

  // Readiness is checked with the full resolved selection so the backend reports applicability for
  // every requested metric; the actual run request below sends only the applicable subset.
  const buildReadinessRequest = useCallback(
    (): import("@/lib/api").DatasetRunRequest =>
      buildDatasetRunRequest({
        kind,
        evaluationName,
        runLabel: runLabels[0] ?? null,
        runLabels,
        agentId,
        selectedLlm,
        judgeModel,
        judgeEnabled: effectiveJudgeEnabled,
        activeMetricIds: resolvedMetricIds,
        parallelRequests,
        humanReview,
        applyContracts,
        selectedContracts,
        projectId,
        evaluationScope,
        systemPrompt,
        selectedToolIds: normalizedToolSelection,
        assignmentId,
        assignmentVersion,
      }),
    [
      agentId,
      applyContracts,
      effectiveJudgeEnabled,
      evaluationName,
      evaluationScope,
      humanReview,
      judgeModel,
      kind,
      normalizedToolSelection,
      assignmentId,
      assignmentVersion,
      parallelRequests,
      projectId,
      resolvedMetricIds,
      runLabels,
      selectedContracts,
      selectedLlm,
      systemPrompt,
    ],
  );

  const buildRunRequest = useCallback(
    (): import("@/lib/api").DatasetRunRequest =>
      buildDatasetRunRequest({
        kind,
        evaluationName,
        runLabel: runLabels[0] ?? null,
        runLabels,
        agentId,
        selectedLlm,
        judgeModel,
        judgeEnabled: effectiveJudgeEnabled,
        activeMetricIds,
        parallelRequests,
        humanReview,
        applyContracts,
        selectedContracts,
        projectId,
        evaluationScope,
        systemPrompt,
        selectedToolIds: normalizedToolSelection,
        assignmentId,
        assignmentVersion,
      }),
    [
      activeMetricIds,
      agentId,
      applyContracts,
      effectiveJudgeEnabled,
      evaluationName,
      evaluationScope,
      humanReview,
      judgeModel,
      kind,
      normalizedToolSelection,
      assignmentId,
      assignmentVersion,
      parallelRequests,
      projectId,
      runLabels,
      selectedContracts,
      selectedLlm,
      systemPrompt,
    ],
  );

  useEffect(() => {
    if (!setupReady || !datasetName) {
      // No valid setup to check; drop any prior readiness and the checking indicator.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReadiness(null);
      setReadinessError(null);
      setReadinessLoading(false);
      return;
    }
    // Invalidate readiness immediately — before the debounce resolves — so a stale "Ready to run"
    // can never keep the Run CTA enabled after a readiness input changes.
    setReadinessLoading(true);
    setReadinessError(null);
    let active = true;
    const timer = window.setTimeout(() => {
      evaluationApi.getRunReadiness(datasetName, buildReadinessRequest())
        .then((result) => {
          if (active) setReadiness(result);
        })
        .catch((reason) => {
          if (!active) return;
          setReadiness(null);
          // Surface the specific backend reason (and any per-part details), not generic copy.
          const failure = describeRunFailure(reason);
          setReadinessError([failure.message, ...failure.detailMessages].join(" "));
          setProjectError(failure.projectError);
          setTargetError(failure.targetError);
          setDatasetError(failure.datasetError);
          setScopeError(failure.scopeError);
          setChecksError(failure.checksError);
        })
        .finally(() => {
          if (active) setReadinessLoading(false);
        });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [buildReadinessRequest, datasetName, setupReady]);

  function scrollToStep(step: number) {
    if (!canOpenEvaluationFormStep({ step, currentStep, stepComplete })) return;
    if (step === 4) setSettingsVisited(true);
    setExpandedStep(step);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        scrollIntoPane(document.getElementById(`evaluation-step-${step}`), {
          behavior: "smooth",
          block: "start",
        });
      });
    });
  }

  /**
   * Run the same evaluation against several models and group the results.
   *
   * Every request is this form's own request with only the target swapped, so
   * the runs share a comparison basis and can be grouped. Grouping happens
   * after they finish — a run cannot join a workspace until it completes — and
   * is owned by `BakeoffResume`, so closing the tab does not lose it.
   */
  // Poll the launched runs for display, then watch for the workspace.
  // `BakeoffResume` owns the grouping itself, so this only reads.
  useEffect(() => {
    if (!comparisonTargets || !comparisonLaunchId || comparisonWorkspaceId || comparisonGroupingFailed) return;
    const settled = comparisonTargets.every(
      (target) => !target.runId || isTerminalRunStatus(target.status),
    );
    if (settled && comparisonTargets.filter(target => target.status === "completed").length < 2) return;
    const timer = window.setTimeout(async () => {
      if (settled) {
        const record = readLaunches().find((entry) => entry.launchId === comparisonLaunchId);
        if (record?.workspaceId) setComparisonWorkspaceId(record.workspaceId);
        else if (!record || record.groupingFailed) setComparisonGroupingFailed(true);
        else setComparisonTick((value) => value + 1);
        return;
      }
      try {
        const tenant = await api.tenant();
        setComparisonTargets(await refreshTargets(comparisonTargets, tenant.tenant_id, true));
        setComparisonRefreshFailed(false);
      } catch {
        setComparisonRefreshFailed(true);
        setComparisonTick(value => value + 1);
      }
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [comparisonTargets, comparisonLaunchId, comparisonWorkspaceId, comparisonTick, comparisonGroupingFailed]);

  const readyComparisonHref = completedComparisonHref(comparisonWorkspaceId, comparisonTargets ?? []);
  useEffect(() => {
    if (readyComparisonHref && comparisonTargets?.every((target) => target.status === "completed")) {
      router.replace(readyComparisonHref);
    }
  }, [readyComparisonHref, comparisonTargets, router]);

  async function saveCurrentPrompt() {
    const text = systemPrompt.trim();
    if (!text || savingPrompt) return;
    setSavingPrompt(true);
    setError(null);
    setPromptSaveError(null);
    try {
      const tenant = await api.tenant();
      // Named after the evaluation it was written for, so the library reads as
      // a record of real work rather than "prompt-1, prompt-2".
      const promptId = (evaluationName.trim() || "prompt")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
      const saved = await platformApi.savePrompt({
        tenant_id: tenant.tenant_id,
        prompt_id: promptId || "prompt",
        name: evaluationName.trim() || promptId,
        content: text,
      });
      setSystemPromptRef(`${saved.prompt_id}@${saved.version}`);
      setStatus(`Saved as ${saved.prompt_id} v${saved.version}.`);
      // The save is already committed; a failed refresh is a stale list, not a
      // failed save, and must not send the user back to click Save again.
      try {
        setSavedPrompts(await platformApi.listPrompts());
      } catch {
        // Left stale deliberately: the next load picks the new version up.
      }
    } catch (reason) {
      setPromptSaveError(userFacingError(reason, "Could not save this prompt."));
    } finally {
      setSavingPrompt(false);
    }
  }

  async function launchComparison(runRequest: DatasetRunRequest) {
    const { tenant_id: tenantId } = await api.tenant();
    // One axis per launch. Varying model and prompt together would leave a
    // difference unattributable to either.
    const variants: { label: string; request: DatasetRunRequest }[] =
      compareAxis === "prompts"
        ? comparePromptRefs.map((ref) => ({ label: ref, request: withPrompt(runRequest, ref) }))
        : ([selectedLlm, ...compareLlmIds.map((id) => findSelectedModel(llmCatalog, id))]
            .filter(Boolean) as LlmCatalogEntry[]).map((model) => ({
            label: model.model_id,
            request: withTarget(runRequest, model),
          }));

    setStatus(`Evidence ready. Starting ${variants.length} runs…`);
    const targets: BakeoffTarget[] = [];
    for (const variant of variants) {
      try {
        const job = await evaluationApi.createRunFromDataset(datasetName, variant.request);
        if (job.run_id) rememberActiveRunId(job.run_id);
        targets.push({
          modelId: variant.label,
          runId: job.run_id ?? null,
          status: job.status || "pending",
          error: null,
        });
      } catch (reason) {
        // One model failing to start must not cost the others their run.
        targets.push({
          modelId: variant.label,
          runId: null,
          status: null,
          error: userFacingError(reason, "This model could not start."),
        });
      }
    }

    const started = targets.filter((target) => target.runId);
    if (started.length === 0) throw new Error("No runs could be started.");

    const launchId = `bakeoff-${Date.now()}`;
    rememberLaunch({
      launchId,
      tenantId,
      datasetName,
      evaluationName: evaluationName.trim(),
      targets,
      workspaceId: null,
      createdAt: new Date().toISOString(),
    });

    setFormDirty(false);
    if (!preparedKind) forgetRunDraft(kind);
    setComparisonGroupingFailed(false);
    setComparisonLaunchId(launchId);
    setComparisonTargets(targets);
    const lost = targets.length - started.length;
    setStatus(
      lost > 0
        ? `Started ${started.length} of ${targets.length} runs.`
        : `Started ${started.length} runs.`,
    );
    // No navigation. The comparison panel below is this launch's destination:
    // it shows every arm's progress, names an arm that did not start, links to
    // each run, and offers the comparison once grouping completes. Pushing to
    // one arm's run page discarded all of that, including the "Started N of M"
    // line set immediately above — an arm that failed to start was reported to
    // a component that was unmounted in the same tick.
  }

  async function runEvaluation() {
    if (loading || setupLoadFailed) return;
    setSubmitAttempted(true);
    // Drop stale backend problem details before local validation writes new copy.
    setErrorDetails([]);
    setProjectError(null);
    const focusInvalidSoon = () => window.requestAnimationFrame(() => focusFirstInvalid());
    // Same order as the sections: dataset → name → target.
    const unmetSetup = unmetStepRequirements(targetStepRequirements);
    if (unmetSetup.length > 0) {
      if (!nameReady) focusInvalidSoon();
      setError(unmetSetup[0]!.label + ".");
      return;
    }
    if (toolSelectionEmpty) {
      setScopeError("Select at least one tool to evaluate, or select all tools for the whole tool layer.");
      return setError("Select at least one tool to evaluate.");
    }
    if (activeMetricIds.length === 0) return setError("Select at least one metric to score.");
    if (applyContracts && selectedContracts.length === 0) {
      return setError("Select at least one rubric template or disable Apply Rubric Templates.");
    }
    if (contractMetricBlocked) {
      return setError("A rubric-required check is not applicable to this dataset. Remove that rubric to continue.");
    }

    setBusy(true);
    setError(null);
    setErrorDetails([]);
    setProjectError(null);
    setTargetError(null);
    setDatasetError(null);
    setScopeError(null);
    setChecksError(null);
    setActiveRunId(null);
    setLiveRunStatus("pending");
    setStatus("Starting evaluation…");
    try {
      const annotatedLabel = primaryRunLabel || null;
      const annotatedEvaluationName = evaluationName.trim();
      // One selected prompt is not a comparison, but it is still a choice: run
      // it, linked to that version. Ignoring it would silently evaluate the
      // typed text — or nothing — while the user believes otherwise.
      // An explicitly compared single prompt wins over one merely copied into
      // the box; either way the run records which version it ran.
      const chosenPromptRef = comparePromptRefs.length === 1 ? comparePromptRefs[0] : systemPromptRef;
      const runRequest = chosenPromptRef
        ? withPrompt(buildRunRequest(), chosenPromptRef)
        : buildRunRequest();
      setStatus("Checking evidence readiness…");
      const readiness = await evaluationApi.getRunReadiness(datasetName, runRequest);
      if (readiness.status !== "ready") {
        setLiveRunStatus(null);
        setStatus("Cannot start evaluation.");
        setError(readiness.details.map((detail) => detail.message).join(" ") ||
          "The required evidence is not available for this setup.");
        return;
      }
      // Two prompts is the floor for a prompt comparison: the model chosen
      // above is one arm of a model comparison, but it is not an arm of a
      // prompt one, so a single prompt would launch one ungroupable run.
      if (
        kind === "llm" &&
        (compareLlmIds.length > 0 || comparePromptRefs.length >= MIN_COMPARISON_RUNS)
      ) {
        await launchComparison(runRequest);
        return;
      }

      setStatus("Evidence ready. Creating evaluation…");
      const job = await evaluationApi.createRunFromDataset(datasetName, runRequest);
      const runId = job.run_id ?? job.job_id ?? "";
      setActiveRunId(runId || null);
      if (runId) {
        rememberActiveRunId(runId);
        rememberRunForm(runId, {
          kind,
          evaluationName: annotatedEvaluationName,
          label: annotatedLabel,
          datasetName,
          agentId: kind === "agent" ? agentId : null,
          selectedLlmId: kind === "llm" ? selectedLlm ? modelSelectionId(selectedLlm) : null : null,
          judgeModel: effectiveJudgeEnabled ? judgeModel || null : null,
          enableJudge: effectiveJudgeEnabled,
          humanReview,
          parallelRequests,
          selectedMetrics,
          selectedContracts: applyContracts ? selectedContracts : [],
          applyContracts,
          systemPrompt,
          systemPromptRef: chosenPromptRef,
          selectedToolIds: normalizedToolSelection,
          projectId: projectId || null,
          evaluationScope,
        });
      }
      setLiveRunStatus(job.status || "pending");
      if (!runId) throw new Error("Evaluation started without a run identifier.");
      setStatus("Evaluation started. Opening run history…");
      setFormDirty(false);
      if (!preparedKind) forgetRunDraft(kind);
      router.push(evaluationRunsHref(runId));
    } catch (reason) {
      setLiveRunStatus((current) => (activeRunId && current !== "completed" ? "failed" : current));
      // Show the specific backend reason and every per-part detail; attach the
      // problem to the Project control when the backend names it.
      const failure = describeRunFailure(reason);
      setError(failure.message);
      setErrorDetails(failure.detailMessages);
      setProjectError(failure.projectError);
      setTargetError(failure.targetError);
      setDatasetError(failure.datasetError);
      setScopeError(failure.scopeError);
      setChecksError(failure.checksError);
      if (failure.projectError || failure.targetError || failure.datasetError || failure.scopeError || failure.checksError) {
        window.requestAnimationFrame(() => focusFirstInvalid());
      }
      setStatus(activeRunId ? "Evaluation did not finish." : "Cannot start evaluation.");
    } finally {
      setBusy(false);
    }
  }

  const caseCount = selectedDataset?.record_count ?? null;
  const durationEstimate = approximateRunDuration({
    caseCount,
    scope: evaluationScope,
    judgeEnabled: effectiveJudgeEnabled,
    parallelRequests,
  });
  // readinessLoading is true from the moment a readiness input changes until the debounced check
  // resolves, so this stays false while a stale readiness result is still on screen.
  const runReady = computeRunReady({
    setupReady: setupReady && !setupLoadFailed,
    contractMetricBlocked,
    readinessChecking: readinessLoading,
    readiness,
  });
  const runIssueCount = (readiness ? readiness.details.length : 0) + (contractMetricBlocked ? 1 : 0);
  const selectedAssignment = assignments.find(
    (item) => item.assignment_id === assignmentId && item.version === assignmentVersion,
  );
  const launchGovernanceLevel = !selectedAssignment
    ? "Diagnostic"
    : selectedAssignment.governance_state === "release_governed"
      ? "Release-governed"
      : "Standardized evaluation";

  const comparisonRunCount = kind !== "llm" ? 1
    : compareAxis === "prompts" ? Math.max(1, comparePromptRefs.length)
    : compareAxis === "models" ? 1 + compareLlmIds.length : 1;
  const runButtonLabel = readinessLoading
    ? "Checking evidence…"
    : runReady
      ? comparisonRunCount > 1
        ? `Compare ${comparisonRunCount} ${compareAxis === "prompts" ? "prompt versions" : "models"}`
        : caseCount != null
        ? `Run ${caseCount} case${caseCount === 1 ? "" : "s"}`
        : "Run evaluation"
      : runIssueCount > 0
        ? `Resolve ${runIssueCount} issue${runIssueCount === 1 ? "" : "s"}`
        : "Run evaluation";
  const runDisabled = busy || loading || !runReady;
  const runHelpText = readinessLoading
    ? "Checking whether the required evidence is available…"
    : runReady
      ? null
      : readiness || contractMetricBlocked
        ? "Resolve the highlighted issues to run."
        : "Complete the setup to run.";


  // Rendered in both dataset branches: a dataset the launcher preselected can be just as
  // incomplete as one picked here, and neither is allowed to fail silently at run time.
  const rowCoverageNotice = selectedMissingProvidedResponse ? (
      <Notice tone="error">
        {fullName(selectedDataset!)} has no recorded <span className="font-mono">response</span> on at
        least one inspected row. That is a separate field from the expected output: the expected
        output is what a row is scored <em>against</em>, while the response is the answer being
        scored, so a row carrying only an expected output has nothing for this mode to grade.
        Choose a dataset whose rows record a response, or add one.
      </Notice>
    ) : selectedDataset && selectedMissingFields.length ? (
      <Notice tone="error">
        {fullName(selectedDataset)} is missing {missingFieldsLabel(selectedMissingFields)} on at least
        one inspected row. Every evaluated row needs both a question and an expected output.
        Complete the dataset, or pick another one.
      </Notice>
    ) : null;

  // With nothing chosen there is no selected option to carry the group's tab
  // stop, so the first one takes it and the radiogroup stays reachable.

  const comparableAxes = offerableCompareAxes(savedPrompts.length > 0);
  // Typed to the union, so every value is in the array — no fallback needed.
  const activeAxis = COMPARE_AXES.find((axis) => axis.value === compareAxis)!;
  // A closed disclosure still has to report what it holds, or a configured comparison
  // becomes state the user cannot see they set.
  const comparisonSummary = comparisonSummaryLabel(compareAxis, {
    prompts: comparePromptRefs.length,
    models: compareLlmIds.length,
  });

  if (comparisonTargets) {
    // A comparison in flight replaces the form: the setup that produced it is
    // already spent, and what the reader needs now is whether it is working.
    const tally = launchTally(comparisonTargets);
    return (
      <div className={cn(PAGE_FRAME, "space-y-6")}>
        <PageHeader
          section="Evaluate"
          title={compareAxis === "prompts" ? "Comparing prompt versions" : "Comparing models"}
          description={`${describeTally(tally, compareAxis === "prompts" ? "prompt versions" : "models")} · ${datasetName}`}
        />
        <div className="divide-y overflow-hidden rounded-xl border bg-card" aria-label="Run progress" aria-live="polite">
          {comparisonTargets.map((target) => {
            const status = (target.status || "pending").toLowerCase();
            const finished = isTerminalRunStatus(status) || !target.runId;
            return (
              <div key={target.modelId} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">{target.modelId}</p>
                  {target.error ? <p className="mt-1 text-sm text-destructive">{target.error}</p> : null}
                </div>
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  {!finished ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                  {status === "completed" ? "Complete" : status === "cancelled" ? "Stopped" : !target.runId ? "Did not start" : status === "pending" ? "Queued" : status}
                </span>
                {target.runId ? <Link href={`/runs/${encodeURIComponent(target.runId)}`} className="rounded text-sm font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring">View run</Link> : null}
              </div>
            );
          })}
        </div>
        {comparisonRefreshFailed ? <p role="status" className="text-sm text-muted-foreground">Connection interrupted. Retrying status updates; your runs may still be running.</p> : null}
        {readyComparisonHref ? (
          <Link
            href={readyComparisonHref}
            className={buttonVariants()}
          >
            Open comparison
          </Link>
        ) : (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {comparisonGroupingFailed
              ? "We could not assemble the comparison. Your runs are saved; open their reports above or find them in Run history."
              : tally.completed === tally.requested
              ? "All runs finished. Assembling the comparison…"
              : comparisonTargets.every((target) => !target.runId || isTerminalRunStatus(target.status))
                ? "Some runs did not complete. Their reports remain available above. A comparison needs at least two completed runs."
                : "Runs are still going. The comparison opens when all runs finish successfully."}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(PAGE_FRAME, "space-y-6")}
      onChangeCapture={() => setFormDirty(true)}
      onClickCapture={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('button[role="switch"], button[aria-pressed]')) setFormDirty(true);
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="proofgrove-eyebrow text-[0.6875rem] text-evalai-purple">Evaluation</p>
          <h1 className="mt-1 text-2xl font-semibold">New {evaluationTypeLabel} evaluation</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {copy.description}{" "}
            {/* The only way back to the kind question, now that step 1 no longer
                re-asks it. A link rather than an inline control: switching kind
                discards the other branch's target and comparison setup, so it
                should be a deliberate move, and the unsaved-changes guard runs. */}
            <Link
              href={entryDatasetName ? `/evaluate?dataset=${encodeURIComponent(entryDatasetName)}` : "/evaluate"}
              onClick={guardInAppNavigation}
              className="font-medium text-brand-text underline-offset-4 hover:underline dark:text-brand"
            >
              Change
            </Link>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("mr-2 size-4", loading && "animate-spin")} aria-hidden="true" /> Refresh
        </Button>
      </div>

      {preparedKind === "llm" ? (
        <Notice>
          <p>This setup evaluates answers from an LLM using eight refund cases. To run Nova’s tools and evaluate the complete agent workflow, open the prepared four-case agent evaluation.</p>
          <Link href={NOVA_AGENT_EVALUATION_HREF} onClick={guardInAppNavigation} className="mt-2 inline-flex items-center font-medium text-primary underline">Open Nova agent evaluation</Link>
        </Notice>
      ) : null}

      {setupLoadFailed ? (
        <Notice tone="error">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              {Object.values(setupLoadErrors).map((message) => <p key={message}>{message}</p>)}
              <p className="mt-1 text-xs">Successfully loaded setup remains available. A failed lookup does not mean the catalog is empty.</p>
            </div>
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>Retry setup</Button>
          </div>
        </Notice>
      ) : null}
      {error && (
        <Notice tone="error">
          <p>{error}</p>
          {errorDetails.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
              {errorDetails.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      )}
      {(status || activeRunId) && (
        <Notice>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p>{status || "Evaluation run created."}</p>
              {activeRunId ? (
                <p className="mt-1 font-mono text-xs text-muted-foreground">{activeRunId}</p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {liveRunStatus ? (
                <span className="rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium capitalize">
                  {displayRunStatus(liveRunStatus)}
                </span>
              ) : null}
            </div>
          </div>
        </Notice>
      )}

      {agentDatasetMismatch ? (
        <Notice>
          <p>The selected dataset differs from {selectedAgent?.display_name || selectedAgent?.name}’s prepared cases.</p>
          <p className="mt-1 text-xs text-muted-foreground">Current: {datasetName || "none"} · Prepared: {recommendedAgentDataset}</p>
          <Button className="mt-3" size="sm" variant="outline" disabled={agentDatasetLoading} onClick={() => void useAgentGoldenDataset()}>
            {agentDatasetLoading ? "Loading golden dataset…" : "Use this agent’s golden dataset"}
          </Button>
          {agentDatasetError ? <p role="alert" className="mt-2 text-sm text-destructive">{agentDatasetError}</p> : null}
        </Notice>
      ) : null}

      <SetupProgress
        label="Evaluation setup progress"
        currentStep={visibleStep}
        completed={progressStepCompleted}
        available={progressStepAvailable}
        // Step 3 is the scoring model for a provided run, not the response
        // source — the strip, the step card and the Continue button each named
        // it differently, which reads as three steps rather than one.
        steps={evaluationSetupStepLabels(chosenKind === "provided" ? "Scoring model" : evaluationTypeLabel)}
        onStepSelect={scrollToStep}
      />

      <SetupStepSection
        id="evaluation-step-1"
        number="1"
        title="Select a dataset"
        description="Pick the published dataset whose rows carry this run's evidence."
        state={stateForStep(1)}
        summary={selectedDataset ? `${evaluationTypeLabel} · ${fullName(selectedDataset)} · ${selectedDataset.record_count ?? "Unknown"} rows` : `${evaluationTypeLabel} · No dataset selected`}
        onEdit={() => scrollToStep(1)}
        onInteract={() => setExpandedStep(1)}
        actionLabel={entryDatasetName ? "Change dataset" : "Edit"}
      >
        <div className="space-y-5">
          {loading ? <Loading /> : setupLoadErrors.datasets && datasetOptions.length === 0 ? (
            <Notice tone="error">Dataset availability could not be checked. Use Retry setup above to load the catalog.</Notice>
          ) : datasetOptions.length === 0 && !datasetNextCursor ? (
            <Empty>
              No published datasets yet.{" "}
              <Link
                href="/datasets"
                onClick={guardInAppNavigation}
                className="text-primary underline"
              >
                Open Datasets
              </Link>{" "}
              to onboard and publish one.
            </Empty>
          ) : (
            <div className="space-y-4">
              {setupLoadErrors.datasets ? <Notice tone="error">Showing the last loaded datasets. Retry setup before running to refresh their availability.</Notice> : null}
              {datasetOptions.length === 0 ? (
                <Notice>No published dataset is present in the loaded page. Load more to continue searching the published catalog.</Notice>
              ) : null}
              {selectedDataset ? (
                <SelectedDatasetCard
                  dataset={selectedDataset}
                  datasetName={datasetName}
                  note={datasetName === entryDatasetName ? "Carried over from the dataset you came from." : undefined}
                  leadingAction={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="whitespace-nowrap"
                      aria-haspopup="dialog"
                      aria-expanded={datasetPickerOpen}
                      onClick={() => setDatasetPickerOpen(true)}
                    >
                      Change dataset
                    </Button>
                  }
                  previewTriggerRef={previewTriggerRef}
                  previewLoading={previewLoading}
                  previewOpen={previewOpen}
                  onPreview={() => void previewDataset()}
                />
              ) : datasetOptions.length ? (
                <div className="flex flex-col gap-3 border-y py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">No dataset selected</p>
                    <p id="evaluation-dataset-hint" className="mt-0.5 text-xs text-muted-foreground">
                      {datasetPickerCountLabel(datasets.length, datasetTotal)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    id="evaluation-dataset"
                    aria-haspopup="dialog"
                    aria-expanded={datasetPickerOpen}
                    aria-invalid={datasetError ? true : undefined}
                    aria-describedby={`evaluation-dataset-hint${datasetError ? " evaluation-dataset-error" : ""}`}
                    onClick={() => setDatasetPickerOpen(true)}
                  >
                    Choose dataset
                  </Button>
                </div>
              ) : null}
              {datasetError ? <p id="evaluation-dataset-error" role="alert" className="text-xs font-medium text-destructive">{datasetError}</p> : null}
              {datasetPageError ? <Notice tone="error">{datasetPageError}</Notice> : null}
              {rowCoverageNotice}
            </div>
          )}
        </div>
        <StepContinue
          disabled={!stepComplete[0]}
          label="Continue to name"
          onClick={() => scrollToStep(2)}
          requirements={datasetStepRequirements}
        />
      </SetupStepSection>

      {datasetPickerOpen ? (
          <DatasetPickerDialog
            datasets={datasetOptions.map((option) => option.dataset)}
            kind={kind}
            selectedName={datasetName || null}
            canLoadMore={Boolean(datasetNextCursor)}
            loadingMore={datasetsLoadingMore}
            onLoadMore={() => void loadMoreDatasets()}
            onSelect={(dataset) => {
              agentDatasetLoadToken.current += 1;
              setAgentDatasetLoading(false);
              setAgentDatasetError(null);
              setDatasetName(fullName(dataset));
              setDatasetError(null);
              setPreviewOpen(false);
              setPreviewRecords([]);
              setPreviewError(null);
              setFormDirty(true);
              setDatasetPickerOpen(false);
            }}
            onClose={() => setDatasetPickerOpen(false)}
          />
      ) : null}
      {llmPickerOpen ? (
        <LlmPickerDialog
          models={llmCatalog}
          selectedId={selectedLlmId || null}
          onSelect={(model) => {
            setSelectedLlmId(modelSelectionId(model));
            setTargetError(null);
            setFormDirty(true);
            setLlmPickerOpen(false);
          }}
          onClose={() => setLlmPickerOpen(false)}
        />
      ) : null}
      {previewOpen ? (
        <DatasetPreviewDialog
          datasetName={datasetName}
          loading={previewLoading}
          error={previewError}
          records={previewRecords}
          onClose={closeDatasetPreview}
        />
      ) : null}

      <SetupStepSection
        id="evaluation-step-2"
        number="2"
        title="Name this evaluation"
        description="Give related runs one evaluation name. Add labels only when this run needs to be distinguished."
        state={stateForStep(2)}
        summary={`${evaluationName.trim() || "Not named"} · ${runLabels.length || "No"} ${runLabels.length === 1 ? "label" : "labels"}`}
        onEdit={() => scrollToStep(2)}
        onInteract={() => setExpandedStep(2)}
      >
        <div className="max-w-2xl">
          <Field
            label="Evaluation name"
            hint="Required. Groups related runs in Experiments and Runs."
          >
            <Input
              inputSize="sm"
              name="evaluation-name"
              autoComplete="off"
              aria-label="Evaluation name"
              aria-invalid={submitAttempted && !evaluationName.trim() ? true : undefined}
              value={evaluationName}
              onChange={(event) => setEvaluationName(event.target.value)}
              placeholder="e.g. Fraud agent quality gate…"
              maxLength={256}
              required
            />
          </Field>
        </div>

        <Disclosure
          label="Run labels (optional)"
          summary={runLabels.length ? runLabels.join(", ") : "None"}
        >
          <div className="max-w-2xl space-y-2">
            <p id="run-labels-hint" className="text-xs leading-5 text-muted-foreground">
              Tag this run so it can be found and compared later.
            </p>
            <RunLabelInput
              labels={runLabels}
              describedBy="run-labels-hint"
              onChange={(next) => {
                setRunLabels(next);
                setFormDirty(true);
              }}
            />
          </div>
        </Disclosure>
        <StepContinue
          disabled={!stepComplete[1]}
          label={chosenKind === "provided" ? "Continue to scoring model" : "Continue to system"}
          onClick={() => scrollToStep(3)}
          requirements={nameStepRequirements}
        />
      </SetupStepSection>

      <SetupStepSection
        id="evaluation-step-3"
        number="3"
        title={copy.system}
        description={
          chosenKind === "provided"
            ? "The dataset supplies the responses, so nothing is invoked to produce them. The only system this run uses is the model that scores them."
            : "Choose the system that will produce responses for this evaluation."
        }
        state={stateForStep(3)}
        summary={targetSummary}
        onEdit={() => scrollToStep(3)}
        onInteract={() => setExpandedStep(3)}
      >
        {chosenKind === "provided" ? (
          <div className="space-y-3">
            <Notice>
              Stored responses will be scored as declared dataset evidence. No agent, target model,
              endpoint, or target system prompt is required or invoked.
            </Notice>
            {/* Hosted here rather than in Advanced Settings for this mode only. A
                provided run has no target, so this step would otherwise ask for
                nothing while the one system it does use sat collapsed under step 4.
                `judgeHosted` on AdvancedSettings stops it rendering in both. */}
            {judgeRequired ? (
              <ScoringModelControl
                judgeModel={judgeModel}
                judgeModels={judgeModels}
                refreshingJudgeModels={importingModels}
                onJudgeModelChange={setJudgeModel}
                onRefreshJudgeModels={() => void refreshJudgeModels()}
              />
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">
                No selected check needs a scoring model, so none is used. Pick a check that calls
                for qualitative judgment and the model appears here.
              </p>
            )}
          </div>
        ) : chosenKind === "agent" ? (
          loading ? <Loading /> : setupLoadErrors.agents ? (
            <Notice tone="error">Agent availability could not be checked. Use Retry setup above, or change the evaluation type to a model or existing responses.</Notice>
          ) : agents.length === 0 ? (
            <Empty>
              No ready agents are available in this tenant.{" "}
              <Link href="/catalog/agents" onClick={guardInAppNavigation} className="text-primary underline">Connect an agent endpoint</Link>{" "}
              in What to test, or change the evaluation type to a model or existing responses.
            </Empty>
          ) : (
            <div className="space-y-3">
              {/* Field injects id/aria-describedby into its direct child, but the Radix Select
                  root renders no DOM node — so each Select field wires the label/hint ids onto
                  the trigger explicitly to keep the label association intact. */}
              <Field
                label="Agent"
                hint="Select the agent whose answers and tool workflow you want to evaluate."
                id="evaluation-agent"
                hintId="evaluation-agent-hint"
                error={targetError}
                errorId="evaluation-agent-error"
              >
                <Select
                  value={agentId}
                  onValueChange={(value) => {
                    setAgentId(value);
                    setTargetError(null);
                    // A different agent declares different tools; a stale
                    // named-tool selection must never carry across silently.
                    setSelectedToolIds(null);
                    const nextAgent = agents.find((agent) => agent.id === value);
                    agentDatasetLoadToken.current += 1;
                    setAgentDatasetLoading(false);
                    setAgentDatasetError(null);
                    setEvaluationName((current) => nameAfterAgentChange(current, selectedAgent, nextAgent ?? null));
                    if (nextAgent?.execution_mode === "guided_local_workflow") {
                      const recommendedMetrics = runnableAgentMetricIds(nextAgent, metrics);
                      if (recommendedMetrics.length) setSelectedMetrics(recommendedMetrics);
                      setEvaluationScope("tool_interactions");
                      setParallelRequests(1);
                    }
                    const boundProjectId = nextAgent?.system_project_id;
                    if (boundProjectId) {
                      const boundProject = projects.find(
                        (project) => project.project_id === boundProjectId && project.purpose === "system",
                      );
                      if (boundProject) {
                        setProjectId(boundProject.project_id);
                        setProjectError(null);
                        setStatus(`Selected ${boundProject.name}, the Project bound to this agent.`);
                      } else {
                        setProjectId("");
                        setProjectError("This agent's bound Project is not active or is not a system Project.");
                      }
                    } else {
                      setProjectId("");
                      setProjectError(null);
                    }
                    setFormDirty(true);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    id="evaluation-agent"
                    aria-label="Agent"
                    aria-invalid={targetError ? true : undefined}
                    aria-describedby={`evaluation-agent-hint${targetError ? " evaluation-agent-error" : ""}`}
                  >
                    <SelectValue placeholder="Select an agent…" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.display_name || agent.name}{agent.model ? ` · ${agent.model}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {selectedAgent ? (
                <div
                  aria-live="polite"
                  className="eval-setup-inset grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)] md:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/10 text-success-text">
                        <Check className="size-3.5" aria-hidden="true" />
                      </span>
                      <p className="truncate text-sm font-semibold">
                        {selectedAgent.display_name || selectedAgent.name}
                      </p>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {selectedAgent.description || "No description provided for this agent."}
                    </p>
                  </div>
                  <dl className="eval-setup-meta grid grid-cols-3 gap-3">
                    <SelectedDetail label="Model" value={selectedAgent.model || "Not reported"} />
                    <SelectedDetail label="Namespace" value={selectedAgent.namespace || "—"} />
                    <SelectedDetail label="Tools" value={String(selectedAgent.tools.length)} />
                  </dl>
                </div>
              ) : null}
              {selectedAgent?.execution_mode === "guided_local_workflow" ? (
                <div className="rounded-xl border bg-muted/20 p-4 text-sm leading-6">
                  <p>This agent runs fresh tools on synthetic data and uses the default model to write its response. The run records the tools called, their arguments and their results for the selected checks.</p>
                  <p className="mt-2">These checks cover tool choice and arguments. Compare the final response with the expected answer separately.</p>
                  <p className="mt-2 text-xs text-muted-foreground">Tools: {selectedAgent.tools.join(" · ")}</p>
                  {selectedAgent.recommended_dataset_id ? <p className="mt-2 text-xs text-muted-foreground">Prepared golden dataset: <Link href={`/datasets/${encodeURIComponent(selectedAgent.recommended_dataset_id)}`} className="font-medium text-primary underline">{selectedAgent.recommended_dataset_id}</Link></p> : null}
                  <p className="mt-2 text-xs text-muted-foreground">Change the default response model in <Link href="/catalog/llms" className="font-medium text-primary underline">Models</Link>, then refresh this setup.</p>
                </div>
              ) : null}
            </div>
          )
        ) : (
          loading ? (
            <Loading />
          ) : setupLoadErrors.models ? (
            <Notice tone="error">Model availability could not be checked. Use Retry setup above.</Notice>
          ) : llmCatalog.length === 0 ? (
            <Empty>
              No LLMs are available in this tenant.{" "}
              <Link href="/catalog/llms" className="text-primary underline">
                Open the LLM Catalog
              </Link>{" "}
              to connect OpenAI, choose an installed Ollama model, or onboard a custom endpoint.
            </Empty>
          ) : (
            <div>
              {/* One element, not two: a trigger that named the model and then a block
                  below repeating that name and its id said "gpt-4.1-mini" three times
                  and still left the choice looking unconfirmed. The current selection
                  IS the control — it states what will answer, and carries the way to
                  change it. */}
              <Field
                label="Model"
                hint="Answers every row in the dataset."
                id="evaluation-llm"
                hintId="evaluation-llm-hint"
                error={targetError}
                errorId="evaluation-llm-error"
              >
                {selectedLlm ? (
                  <div className="rounded-lg border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-base font-semibold leading-6">{selectedLlm.name}</p>
                        <p className="mt-0.5 font-mono text-xs text-muted-foreground" translate="no">
                          {selectedLlm.model_id}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-haspopup="dialog"
                          aria-expanded={llmPickerOpen}
                          onClick={() => setLlmPickerOpen(true)}
                        >
                          Change
                        </Button>
                        <Link
                          href={`/catalog/llms?model=${encodeURIComponent(selectedLlm.model_id)}`}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open ${selectedLlm.name} in the LLM catalog`}
                          className={buttonVariants({ variant: "ghost", size: "icon" })}
                        >
                          <ExternalLink className="size-4" aria-hidden="true" />
                        </Link>
                      </div>
                    </div>
                    <p className="mt-3 max-w-prose text-xs leading-5 text-muted-foreground">
                      {/* The source already says where it comes from; a separate SOURCE
                          row restated it. */}
                      {selectedLlm.description?.trim() || `Available through the ${llmSourceLabel(selectedLlm.source).toLowerCase()}.`}
                    </p>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    aria-haspopup="dialog"
                    aria-expanded={llmPickerOpen}
                    aria-invalid={targetError ? true : undefined}
                    aria-describedby={`evaluation-llm-hint${targetError ? " evaluation-llm-error" : ""}`}
                    onClick={() => setLlmPickerOpen(true)}
                    className="w-full justify-between font-normal sm:w-auto"
                  >
                    Select a model…
                    <ChevronDown className="ml-2 size-4 shrink-0" aria-hidden="true" />
                  </Button>
                )}
              </Field>
            </div>
          )
        )}

        {kind === "llm" ? (
          <Disclosure
            label="Add system prompt"
            summary={systemPrompt.trim() ? promptPreview(systemPrompt) : null}
          >
          <SystemPromptPanel
            value={systemPrompt}
            reference={systemPromptRef}
            savedPrompts={savedPrompts}
            saving={savingPrompt}
            canSave={canManagePrompts}
            saveError={promptSaveError}
            onChange={(next) => {
              setSystemPrompt(next);
              // Edited text is no longer the saved version.
              setSystemPromptRef(null);
              setPromptSaveError(null);
              setFormDirty(true);
            }}
            onStartFrom={(prompt) => {
              setSystemPrompt(prompt.content);
              setSystemPromptRef(`${prompt.prompt_id}@${prompt.version}`);
              setPromptSaveError(null);
              setFormDirty(true);
            }}
            onSave={() => void saveCurrentPrompt()}
          />
          </Disclosure>
        ) : null}

        {kind === "llm" && selectedLlmId && (llmCatalog.length > 1 || savedPrompts.length > 0) ? (
          <Disclosure label="Compare against…" summary={comparisonSummary}>
          <ComparisonPanel
            axes={comparableAxes}
            axis={compareAxis}
            axisDescription={activeAxis.description}
            maxTargets={MAX_BAKEOFF_TARGETS}
            savedPrompts={savedPrompts}
            selectedPromptRefs={comparePromptRefs}
            llmCatalog={llmCatalog}
            selectedLlmId={selectedLlmId}
            selectedLlmIds={compareLlmIds}
            onAxisChange={(next) => {
              // One axis at a time: switching clears the other, so a launch can
              // never vary two things at once.
              setCompareAxis(next);
              setCompareLlmIds([]);
              setComparePromptRefs(next === "prompts" && systemPromptRef ? [systemPromptRef] : []);
              setFormDirty(true);
            }}
            onTogglePrompt={(ref) => {
              setComparePromptRefs((current) =>
                current.includes(ref)
                  ? current.filter((entry) => entry !== ref)
                  : current.length >= MAX_BAKEOFF_TARGETS
                    ? current
                    : [...current, ref],
              );
              setFormDirty(true);
            }}
            onToggleLlm={(modelId) => {
              setCompareLlmIds((current) =>
                current.includes(modelId)
                  ? current.filter((id) => id !== modelId)
                  : current.length >= MAX_BAKEOFF_TARGETS - 1
                    ? current
                    : [...current, modelId],
              );
              setFormDirty(true);
            }}
          />
          </Disclosure>
        ) : null}
        <StepContinue
          disabled={!stepComplete[2]}
          label="Continue to evaluation checks"
          onClick={() => scrollToStep(4)}
          requirements={targetStepRequirements}
        />
      </SetupStepSection>

      <SetupStepSection
        id="evaluation-step-4"
        number="4"
        title="Choose checks"
        description={selectedAgent?.execution_mode === "guided_local_workflow" ? "Prepared checks assess tool use; review answer quality separately." : "Add checks from the catalog. The right side shows exactly what this run will score."}
        state={stateForStep(4)}
        summary={`${selectedCheckCount} check${selectedCheckCount === 1 ? "" : "s"}`}
        onEdit={() => scrollToStep(4)}
        onInteract={() => {
          setSettingsVisited(true);
          setExpandedStep(4);
        }}
      >
        {/* Outside the disabled fieldset below, so Clear stays reachable. */}
        {lockedByAssignment ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/40 px-5 py-3">
            <p className="text-xs leading-5 text-muted-foreground">
              <span className="font-medium text-foreground">
                {lockingAssignment?.name ?? "The selected Assignment"}
                {lockingAssignment ? ` · ${lockingAssignment.version}` : ""}
              </span>{" "}
              decides the checks and depth for this run. Clear it to choose them yourself.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setAssignmentId("");
                setAssignmentVersion("");
                setFormDirty(true);
                setStatus("Assignment cleared. Checks and depth are yours to choose again.");
              }}
            >
              Clear Assignment
            </Button>
          </div>
        ) : null}
        <div className="-mx-5 -mb-5 flex flex-col overflow-hidden border-t sm:-mx-6 sm:-mb-6 xl:h-[max(760px,calc(100dvh-6rem))] xl:grid xl:grid-cols-[minmax(0,1.3fr)_minmax(380px,0.8fr)] xl:grid-rows-[auto_minmax(0,1fr)_auto]">
          {/* `display: contents` so disabling does not disturb the grid. */}
          <fieldset disabled={lockedByAssignment} className="contents">
          {showEvaluationDepth ? (
            <fieldset className="border-b px-5 py-4 xl:col-span-2 xl:col-start-1 xl:row-start-1">
              <legend className="sr-only">Execution depth</legend>
              <div className="grid gap-3 xl:grid-cols-[minmax(220px,0.6fr)_minmax(0,1fr)] xl:items-start">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold">Execution depth</h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    {depthIsManual ? "manual" : "auto"}
                  </span>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {minimumScope !== "final_response" && depthFloorMetric ? (
                    <>Minimum is <span className="font-medium text-foreground">{minimumDepth?.label ?? minimumScope}</span> — <span className="font-mono">{depthFloorMetric.metric_id}</span> inspects {minimumScope === "full_execution" ? "the full trace" : minimumScope === "tool_interactions" ? "tool calls" : "the final response"}. You can go deeper, not shallower.</>
                  ) : (
                    deeperDepthOffered
                      ? "Nothing selected needs the tool layer, so any depth is available."
                      : "Only the final response can be scored here — this run has no tool calls or trace to inspect."
                  )}
                </p>
              </div>
              <div>
                <div role="radiogroup" aria-label="Execution depth" className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {EVALUATION_DEPTHS.map((depth) => {
                    const { disabled, reason } = evaluationDepthOptionState(depth.scope);
                    const selected = evaluationScope === depth.scope;
                    const tooShallow = deeperScope(depth.scope, minimumScope) !== depth.scope;
                    return (
                      <button
                        key={depth.scope}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        data-radio-value={depth.scope}
                        tabIndex={rovingRadioTabIndex(depth.scope === depthTabStop)}
                        disabled={disabled}
                        title={reason ?? undefined}
                        onClick={() => {
                          setEvaluationScope(depth.scope);
                          setScopeError(null);
                          setFormDirty(true);
                        }}
                        onKeyDown={(event) =>
                          handleRovingRadioKeyDown(event, {
                            values: EVALUATION_DEPTHS.map((item) => item.scope),
                            current: evaluationScope,
                            disabled: (value) => evaluationDepthOptionState(value as typeof depth.scope).disabled,
                            onSelect: (value) => {
                              setEvaluationScope(value as typeof depth.scope);
                              setScopeError(null);
                              setFormDirty(true);
                            },
                          })
                        }
                        className={cn(
                          "min-w-0 rounded-lg border bg-card px-4 py-4 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          selected ? "border-brand-text/50 bg-brand/10 shadow-[inset_0_0_0_1px_rgba(145,255,1,0.55)]" : "hover:border-brand-text/30",
                          disabled && "cursor-not-allowed opacity-50",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                          {selected ? <Check className="size-3.5 shrink-0 text-brand-text" aria-hidden="true" /> : null}
                          {depth.label}
                        </span>
                        <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">
                          {reason && !tooShallow
                            ? reason
                            : tooShallow && depthFloorMetric
                              ? `Too shallow — ${depthFloorMetric.metric_id} inspects ${minimumScope === "full_execution" ? "the full trace" : "tool calls"}.`
                              : depth.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {scopeError ? <p role="alert" className="mt-2 text-xs text-destructive">{scopeError}</p> : null}
              </div>
              {scopeInspectsTools(evaluationScope) && kind === "agent" ? (
                <details className="group mt-4 border-t">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <span>Tools to evaluate</span>
                    <span className="flex min-w-0 items-center gap-2 font-normal text-muted-foreground">
                      <span className="truncate">{normalizedToolSelection === null ? "Whole tool layer" : `${normalizedToolSelection.length} selected`}</span>
                      <ChevronDown className="size-3.5 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
                    </span>
                  </summary>
                  <div className="max-h-56 overflow-y-auto pb-2">
                  {!selectedAgent ? (
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Select an agent to scope this run to named tools.
                    </p>
                  ) : !agentTools || agentTools.length === 0 ? (
                    <>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        This agent declares no tools to scope against, so the whole tool layer is evaluated.
                      </p>
                      {activeFallbackTools.length > 0 && datasetName ? (
                        <div className="mt-3 border-t pt-3">
                          <p className="text-xs leading-5 text-muted-foreground">
                            You can still state what the dataset expects, using the tenant&apos;s
                            MCP tool catalogue: {" "}
                            <span className="font-mono">{activeFallbackTools.slice(0, 6).join(", ")}</span>
                            {activeFallbackTools.length > 6 ? ` and ${activeFallbackTools.length - 6} more` : ""}.
                          </p>
                          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={openWriteBack}>
                            Set expected tools on dataset rows…
                          </Button>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Unselect tools to score only the named ones — the rest stay captured in the evidence, just not scored.
                      </p>
                      <div className="mt-2 grid gap-1.5 sm:grid-cols-2" role="group" aria-label="Tools to evaluate">
                        {agentTools.map((tool) => {
                          const checked = selectedToolIds === null || selectedToolIds.includes(tool);
                          return (
                            <label key={tool} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-xs hover:border-brand-text/50">
                              <input
                                type="checkbox"
                                className="size-3.5 accent-primary"
                                checked={checked}
                                onChange={() => {
                                  setScopeError(null);
                                  setFormDirty(true);
                                  setSelectedToolIds((current) => {
                                    const effective = new Set(current ?? agentTools);
                                    if (effective.has(tool)) effective.delete(tool);
                                    else effective.add(tool);
                                    const next = agentTools.filter((name) => effective.has(name));
                                    return next.length === agentTools.length ? null : next;
                                  });
                                }}
                              />
                              <span className="min-w-0 truncate font-mono" title={tool}>{tool}</span>
                            </label>
                          );
                        })}
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
                        {normalizedToolSelection === null
                          ? "Whole tool layer: every declared tool participates in scoring."
                          : normalizedToolSelection.length === 0
                            ? "Select at least one tool to evaluate."
                            : `Selected tools: ${normalizedToolSelection.join(", ")}`}
                      </p>
                      {datasetName ? (
                        <div className="mt-3 border-t pt-3">
                          <p className="text-xs leading-5 text-muted-foreground">
                            The selection above scopes this run. To make tool metrics gradeable,
                            the dataset rows also have to say which tools they expect — that is a separate, explicit write.
                          </p>
                          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={openWriteBack}>
                            Set as expected tools on dataset rows…
                          </Button>
                        </div>
                      ) : null}
                    </>
                  )}
                  </div>
                </details>
              ) : null}
            </fieldset>
          ) : null}

          <div className="min-h-0 xl:col-start-1 xl:row-start-2 xl:overflow-y-auto xl:border-r">
            {checksError ? <p role="alert" className="border-b px-5 py-3 text-xs text-destructive">{checksError}</p> : null}
            {/* The panel is given the user's actual selection, not the run-request subset:
                `activeMetricIds` has already dropped not-applicable metrics, so passing it
                here left the panel unable to show — or clear — a selected check that
                readiness later ruled out, while it stayed in `selectedMetrics` and in the
                saved draft. `activeMetricIds` remains what the run request sends. */}
            <MetricSelectionPanel
              kind={kind}
              metrics={lockedByAssignment ? selectedScoringMetrics : applicableMetrics}
              selectedMetricIds={resolvedMetricIds}
              recommendedMetricIds={lockedByAssignment ? [] : recommendedMetricIds}
              contractRequiredIds={contractRequiredMetricIds}
              readiness={readiness}
              onToggle={toggleMetric}
            />
          </div>
          </fieldset>

          <aside className="flex min-h-0 flex-col overflow-y-auto border-t xl:col-start-2 xl:row-start-2 xl:border-t-0" aria-labelledby="run-scoring-title">
            <ScoringSummary
              metrics={selectedScoringMetrics}
              selectedCount={selectedCheckCount}
              offeredCount={offeredCheckCount}
              readiness={readiness}
              onRemove={toggleMetric}
              lockedByAssignment={lockedByAssignment}
              loading={lockedByAssignment && !assignmentManifest && !assignmentLoadError}
              error={assignmentLoadError}
            />
            <div className="pb-2">
              <ExpectedToolsWriteBack
                open={writeBackOpen}
                onOpenChange={setWriteBackOpen}
                datasetName={datasetName}
                // The entry the launcher already resolved. A second lookup
                // here matched on `entry.name`, which the paged list endpoint
                // never returns, so the status was always null — hiding the
                // immutable opt-in and making every write-back to a published
                // dataset an unclearable 409.
                datasetStatus={selectedDataset?.status ?? null}
                onPublishVersion={publishWrittenVersion}
                publishing={publishing}
                publishSteps={publishSteps}
                publishState={publishState}
                tools={normalizedToolSelection ?? agentTools ?? activeFallbackTools}
                records={writeBackRecords}
                selectedRecordIds={writeBackRowIds}
                onToggleRecord={(recordId) =>
                  setWriteBackRowIds((current) =>
                    current.includes(recordId)
                      ? current.filter((id) => id !== recordId)
                      : [...current, recordId],
                  )
                }
                onToggleAll={(selectAll) =>
                  setWriteBackRowIds(
                    selectAll
                      ? writeBackRecords
                          .map((record) => record.dataset_record_id)
                          .filter((id): id is string => Boolean(id))
                      : [],
                  )
                }
                createVersion={writeBackCreateVersion}
                onCreateVersionChange={setWriteBackCreateVersion}
                onCommit={commitWriteBack}
                busy={writeBackBusy}
                error={writeBackError}
                result={writeBackResult}
              />
            <AdvancedSettings
              judgeRequired={judgeRequired}
              judgeHosted={chosenKind === "provided"}
              judgeModel={judgeModel}
              judgeModels={judgeModels}
              refreshingJudgeModels={importingModels}
              onJudgeModelChange={(model) => {
                setJudgeModel(model);
                setFormDirty(true);
              }}
              onRefreshJudgeModels={() => void refreshJudgeModels()}
              contracts={contracts}
              contractsOpen={contractsOpen}
              selectedContracts={applyContracts ? selectedContracts : []}
              onContractsOpenChange={setContractsOpen}
              onToggleContract={toggleContract}
              humanReview={humanReview}
              onHumanReviewChange={setHumanReview}
              parallelRequests={parallelRequests}
              onParallelRequestsChange={setParallelRequests}
              projects={projects}
              projectId={projectId}
              projectError={projectError}
              projectOptionState={tracingProjectOptionState}
              onProjectChange={(next) => {
                setProjectId(next);
                setProjectError(null);
                setFormDirty(true);
              }}
              assignments={assignments}
              assignmentId={assignmentId}
              assignmentVersion={assignmentVersion}
              onAssignmentChange={(nextId, nextVersion) => {
                setAssignmentId(nextId);
                setAssignmentVersion(nextVersion);
                const selected = assignments.find(
                  (item) => item.assignment_id === nextId && item.version === nextVersion,
                );
                if (selected) {
                  setProjectId(selected.project_id);
                  setApplyContracts(false);
                  setSelectedContracts([]);
                  setContractsOpen(false);
                }
                setProjectError(null);
                setFormDirty(true);
              }}
            />
            </div>
          </aside>
          <RunBar
            checkCount={selectedCheckCount}
            runCount={comparisonRunCount}
            depthLabel={selectedDepth?.label ?? evaluationScope}
            caseCount={caseCount ?? null}
            durationEstimate={durationEstimate ?? null}
            readiness={readiness}
            readinessLoading={readinessLoading}
            readinessError={readinessError}
            helpText={runHelpText || null}
            governanceLevel={launchGovernanceLevel}
            busy={busy}
            disabled={runDisabled}
            label={runButtonLabel}
            onRun={() => void runEvaluation()}
          />
        </div>
      </SetupStepSection>

    </div>
  );
}

function DatasetPreviewDialog({
  datasetName,
  loading,
  error,
  records,
  onClose,
}: {
  datasetName: string;
  loading: boolean;
  error: string | null;
  records: DatasetRecord[];
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      variant="modal"
      labelledBy="dataset-preview-title"
      scrimLabel="Close dataset preview"
      onClose={onClose}
      initialFocusRef={closeRef}
      width="w-[min(64rem,calc(100vw-2rem))]"
    >
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 id="dataset-preview-title" className="text-lg font-semibold">Dataset preview</h2>
            <p className="mt-1 truncate text-sm text-muted-foreground" title={datasetName}>
              First five rows from {datasetName}
            </p>
          </div>
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close dataset preview"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 sm:p-6">
          {loading ? (
            <Loading />
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : records.length === 0 ? (
            <p className="text-sm text-muted-foreground">No records available in this dataset.</p>
          ) : (
            <DatasetPreviewTable records={records} />
          )}
        </div>

        <div className="flex justify-end border-t px-5 py-4 sm:px-6">
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
        </div>
    </Dialog>
  );
}
