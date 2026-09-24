"use client";

import { comparisonDifferences } from "@/lib/chart-data";

import { formatDateTimeOrNull } from "@/lib/format-time";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  ExternalLink,
  GitCompareArrows,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { Button, buttonVariants } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@evalai/shared/ui/sonner";
import { LoadingState } from "@/components/page-state";
import { CopyableId, CopyIdButton } from "@/components/copyable-id";
import { ReportView } from "@/components/report/view";
import {
  MAX_COMPARISON_RUNS,
  MIN_COMPARISON_RUNS,
  comparisonHrefForRuns,
  comparisonKey,
  isRunComplete,
} from "@/lib/comparison-href";
import { api, evaluationApi, type RunResult } from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import { gatedRunScore, presentRunOutcome } from "@/lib/run-outcome";
import { RunOutcomeBadge } from "@/components/run-outcome-badge";
import { downloadLibraryCsv } from "@/lib/eval-export";
import { runHistoryApi } from "@/lib/run-history";
import { middleTruncate } from "@/lib/truncate";
import {
  readRunLibraryUrlState,
  writeRunLibrarySearchParams,
  type LibrarySortDir,
  type LibrarySortKey,
  type RunLibraryUrlState,
} from "@/lib/library-url-state";
import {
  evaluateHrefFromRun,
  evaluationName,
  formatRunScore,
  runDetailsHref,
  runLabel,
  runScenarioTypeLabel,
} from "@/lib/run-recommendation";
import { cn } from "@evalai/shared/utils";
import { scrollIntoPane } from "@/lib/scroll-into-pane";
import { SearchField, SegmentedControl } from "@/components/toolbar";

export type ExperimentRunGroup = {
  key: string;
  name: string;
  experimentId: string | null;
  experimentIds: string[];
  latest: RunResult;
  previous: RunResult[];
  runs: RunResult[];
};

type EvaluationLifecycleView = "active" | "archived";
type EvaluationLifecycleAction = "archive" | "restore";

type ColumnId = "name" | "run_id" | "traces" | "score" | "delta" | "status" | "started" | "ended";

type DateMode = "any" | "specific" | "range";

type RunFilters = {
  name: string;
  type: "" | "Agent" | "RAG" | "LLM" | "Existing responses" | "Baseline";
  status: "" | "Running" | "Completed" | "Stopped" | "Error";
  dateMode: DateMode;
  date: string;
  dateFrom: string;
  dateTo: string;
};

// Slim column set from the evaluation-surfaces refactor, plus Traces so a
// run can open its project-scoped capture filter in one click.
export const COLUMN_DEFS: { id: ColumnId; header: string }[] = [
  { id: "name", header: "Run" },
  { id: "run_id", header: "Run ID" },
  { id: "traces", header: "Traces" },
  { id: "score", header: "KPI composite" },
  { id: "delta", header: "Δ vs previous" },
  { id: "status", header: "Status" },
  { id: "started", header: "Start" },
  { id: "ended", header: "End" },
];
const COLUMN_WIDTHS_STORAGE_KEY = "eval-hub.evaluation-runs.column-widths.v9";
const SELECT_COLUMN_WIDTH = 44;
const GROUPS_PER_PAGE = 8;

const DEFAULT_COLUMN_WIDTHS: Record<ColumnId, number> = {
  name: 180,
  run_id: 210,
  traces: 90,
  score: 140,
  delta: 130,
  status: 110,
  started: 200,
  ended: 200,
};

const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 520;

// The filter controls in this view take the shared control style rather than a
// fifth copy of it; `w-full` is the only thing local about them.

/* ── Library view URL state (shareable, restored on reload) ──────
 *
 * Local companions to readRunLibraryUrlState/readAnalysisUrlState for the two
 * view toggles that previously lived in useState only and were lost on reload:
 * the advanced-filters panel. Kept here (not in
 * lib/library-url-state.ts / lib/chart-data.ts) so the shared helpers stay
 * untouched; params are namespaced to avoid clobbering existing keys.
 */

function loadColumnWidths(): Record<ColumnId, number> {
  if (typeof window === "undefined") return { ...DEFAULT_COLUMN_WIDTHS };
  try {
    const raw = window.localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_COLUMN_WIDTHS };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_COLUMN_WIDTHS };
    const next = { ...DEFAULT_COLUMN_WIDTHS };
    for (const column of COLUMN_DEFS) {
      const value = (parsed as Record<string, unknown>)[column.id];
      if (typeof value === "number" && Number.isFinite(value) && value >= MIN_COLUMN_WIDTH) {
        next[column.id] = Math.round(value);
      }
    }
    return next;
  } catch {
    return { ...DEFAULT_COLUMN_WIDTHS };
  }
}

export function runIsArchived(run: RunResult): boolean {
  return run.experiment?.status?.toLowerCase() === "archived";
}

export function isOneOffDiagnosticRun(run: RunResult): boolean {
  return run.experiment?.tags?.one_off_diagnostic === "true" || Boolean(run.diagnostic_only);
}

export function groupRunsByName(runs: RunResult[]): ExperimentRunGroup[] {
  const buckets = new Map<string, RunResult[]>();

  for (const run of runs) {
    const experimentId = run.experiment?.experiment_id?.trim();
    // One-off diagnostics opt out of auto-group display: keep each as its own row.
    const key = isOneOffDiagnosticRun(run)
      ? `diagnostic:${run.run_id}`
      : experimentId
        ? `evaluation:${experimentId}`
        : isRunStoppable(run) || run.experiment?.tags?.evaluation_name
          ? `active:${run.run_id}`
          : "historical:ungrouped";
    const list = buckets.get(key) ?? [];
    list.push(run);
    buckets.set(key, list);
  }

  const groups: ExperimentRunGroup[] = [];
  for (const [key, list] of buckets) {
    const sorted = [...list].sort((a, b) => {
      const dateDelta = new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
      if (dateDelta !== 0) return dateDelta;
      const aNum = a.run_number ?? 0;
      const bNum = b.run_number ?? 0;
      return bNum - aNum;
    });
    const [latest, ...previous] = sorted;
    const experimentIds = [
      ...new Set(
        sorted
          .map((run) => run.experiment?.experiment_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    groups.push({
      key,
      name: key === "historical:ungrouped" ? "Ungrouped historical runs" : evaluationName(latest),
      experimentId: latest.experiment?.experiment_id ?? null,
      experimentIds,
      latest,
      previous,
      runs: sorted,
    });
  }

  return groups.sort(
    (a, b) => new Date(b.latest.started_at).getTime() - new Date(a.latest.started_at).getTime(),
  );
}

/**
 * Recency key behind the sortable "Last run" column: the latest run's end, or
 * its start while it has not ended, so an in-flight run sorts by when it began
 * rather than sinking to the bottom of the list. Ordering only — the cell
 * itself never presents a start time as an end (see `presentRunEnd`).
 */
function groupLastRunTime(group: ExperimentRunGroup): number {
  const raw = group.latest.completed_at || group.latest.started_at;
  const parsed = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function groupLatestScore(group: ExperimentRunGroup): number {
  return gatedRunScore(group.latest) ?? Number.NEGATIVE_INFINITY;
}

/** Sort filtered library groups by Last run / Latest KPI composite / Runs. */
export function sortExperimentGroups(
  groups: ExperimentRunGroup[],
  sortKey: LibrarySortKey,
  sortDir: LibrarySortDir,
): ExperimentRunGroup[] {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...groups].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "runs") cmp = a.runs.length - b.runs.length;
    else if (sortKey === "latest_score") cmp = groupLatestScore(a) - groupLatestScore(b);
    else cmp = groupLastRunTime(a) - groupLastRunTime(b);
    if (cmp !== 0) return cmp * direction;
    return a.name.localeCompare(b.name);
  });
}

export function nextLibrarySort(
  currentKey: LibrarySortKey,
  currentDir: LibrarySortDir,
  nextKey: LibrarySortKey,
): { sortKey: LibrarySortKey; sortDir: LibrarySortDir } {
  if (currentKey === nextKey) {
    return { sortKey: nextKey, sortDir: currentDir === "asc" ? "desc" : "asc" };
  }
  // Default newly selected columns to descending (newest / highest / most).
  return { sortKey: nextKey, sortDir: "desc" };
}

/**
 * Sort affordance for one column header. `aria-sort` alone told assistive tech
 * which column was sorted and left sighted users guessing, so the header also
 * renders a chevron driven by this state.
 */
export function librarySortIndicator(
  currentKey: LibrarySortKey,
  currentDir: LibrarySortDir,
  column: LibrarySortKey,
): { direction: LibrarySortDir | null; hint: string } {
  if (currentKey !== column) {
    return { direction: null, hint: "Not sorted. Activate to sort descending." };
  }
  return currentDir === "asc"
    ? { direction: "asc", hint: "Sorted ascending. Activate to sort descending." }
    : { direction: "desc", hint: "Sorted descending. Activate to sort ascending." };
}

function SortIndicator({ direction }: { direction: LibrarySortDir | null }) {
  const Icon = direction === "asc" ? ChevronUp : direction === "desc" ? ChevronDown : ChevronsUpDown;
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-3.5 shrink-0", direction ? "text-foreground" : "text-muted-foreground/60")}
    />
  );
}

function formatCompactTimestamp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** When a run began. Absent only if the backend never recorded a start. */
export function presentRunStart(run: RunResult): string {
  return formatDateTimeOrNull(run.started_at) ?? "Start time not recorded";
}

/**
 * When a run ended — told honestly. A running row deliberately keeps End
 * empty; other unfinished states are named instead of borrowing `started_at`.
 * The copy comes from `presentRunOutcome` so the table speaks one vocabulary.
 */
export function presentRunEnd(run: RunResult): { time: string | null; state: string | null } {
  const ended = formatDateTimeOrNull(run.completed_at);
  if (ended) return { time: ended, state: null };
  const status = (run.status || "").trim().toLowerCase();
  if (status === "running") return { time: null, state: null };
  if (status === "pending" || status === "awaiting_trace" || status === "failed" || status === "blocked" || status === "cancelled") {
    return { time: null, state: presentRunOutcome(run).label };
  }
  return { time: null, state: "End time not recorded" };
}

/**
 * Wall-clock span of a run that actually ended. It rides along under the End
 * time rather than claiming a column of its own: it is derived from Start and
 * End, so it is never worth a third time column in an already dense table.
 * Null whenever there is no honest end to measure to.
 */
export function runDurationLabel(run: RunResult): string | null {
  if (!run.completed_at) return null;
  const start = new Date(run.started_at).getTime();
  const end = new Date(run.completed_at).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Compact start → end for the mobile run card; it never invents an end. */
function formatCompactRunSpan(run: RunResult): string {
  const start = formatCompactTimestamp(run.started_at) ?? "Start time not recorded";
  const end = presentRunEnd(run);
  if (!end.time) return end.state ? `${start} → ${end.state}` : `${start} →`;
  const ended = formatCompactTimestamp(run.completed_at) ?? end.time;
  const duration = runDurationLabel(run);
  return duration ? `${start} → ${ended} · ${duration}` : `${start} → ${ended}`;
}

/**
 * Group-level "Last run": the end of the group's most recent run. A group row
 * aggregates many runs, so "last run" is a legitimate question there — and the
 * answer is one run's end, not a first-start → last-end span, which would
 * blend two different runs into a single range and keep widening as the
 * evaluation is re-run. When that most recent run has not ended, the label
 * says so and shows what is true: when it started.
 */
function groupLastRunLabel(group: ExperimentRunGroup): string {
  const end = presentRunEnd(group.latest);
  return end.time ?? `${end.state || presentRunOutcome(group.latest).label} · started ${presentRunStart(group.latest)}`;
}

/** Exact Tracing workspace filter for an evaluation run, when it has a Project. */
export function tracesHrefForRun(run: RunResult): string | null {
  const projectId = run.lineage?.project_id || run.experiment?.project_id;
  if (!projectId) return null;
  return `/projects/${encodeURIComponent(projectId)}/traces?run_id=${encodeURIComponent(run.run_id)}`;
}

export { isRunComplete, comparisonHrefForRuns } from "@/lib/comparison-href";

/**
 * The run's gated score as a number.
 *
 * Read from the score itself, not parsed back out of its formatted label. The
 * label is rounded to whole percent, so 0.696 and 0.704 both became "70%" and
 * the delta column reported no movement at all where the score had risen.
 */
function scoreValue(run: RunResult): number | null {
  const score = gatedRunScore(run);
  return typeof score === "number" && Number.isFinite(score) ? score : null;
}

/** Human-readable reason two runs cannot be delta-compared. */
function comparisonBasisDifference(run: RunResult, previous: RunResult): string {
  return `different ${comparisonDifferences(previous, run).join(", ")}`;
}

export type PreviousDelta =
  | { kind: "none" }
  | { kind: "value"; delta: number }
  | { kind: "incomparable"; reason: string };

/**
 * The "Δ vs previous" cell only means something when both runs share the same
 * comparison basis. A delta computed across incompatible runs is a fabricated
 * number, so gate it on comparison-key equality and surface the reason instead.
 */
export function deltaAgainstPrevious(
  run: RunResult,
  previous: RunResult | null | undefined,
): PreviousDelta {
  if (!previous) return { kind: "none" };
  const runKey = comparisonKey(run);
  const previousKey = comparisonKey(previous);
  if (!runKey || !previousKey || runKey !== previousKey) {
    return { kind: "incomparable", reason: comparisonBasisDifference(run, previous) };
  }
  const currentScore = scoreValue(run);
  const previousScore = scoreValue(previous);
  if (currentScore == null || previousScore == null) return { kind: "none" };
  return { kind: "value", delta: currentScore - previousScore };
}

export function latestComparableRuns(group: Pick<ExperimentRunGroup, "runs">): RunResult[] {
  const cohorts = new Map<string, RunResult[]>();
  for (const run of group.runs) {
    const key = comparisonKey(run);
    if (!key || !isRunComplete(run)) continue;
    const cohort = cohorts.get(key) ?? [];
    cohort.push(run);
    cohorts.set(key, cohort);
  }
  return [...cohorts.values()].find((cohort) => cohort.length >= MIN_COMPARISON_RUNS) ?? [];
}

/** Map backend job statuses onto the Runs status labels. */
function normalizeRunStatus(status: string): "Running" | "Completed" | "Error" | string {
  const value = status.trim().toLowerCase();
  if (value === "pending" || value === "running" || value === "awaiting_trace") return "Running";
  if (value === "completed") return "Completed";
  if (value === "completed_with_partial_evidence") return "Partial evidence";
  if (value === "cancelled") return "Stopped";
  if (value === "failed") return "Error";
  if (!value) return "Unknown";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function runIdentity(run: RunResult, group: ExperimentRunGroup): string {
  const runNumber = run.run_number;
  const runNumberIsUnique =
    runNumber != null &&
    group.runs.filter((candidate) => candidate.run_number === runNumber).length === 1;
  if (runNumberIsUnique) return `${run.lineage?.source_run_id ? "Rescore" : "Run"} ${runNumber}`;
  // Identify the run by when it began: every run has a start, finished or not.
  return `${run.lineage?.source_run_id ? "Rescore" : "Run"} · ${formatCompactTimestamp(run.started_at) ?? "unknown start time"}`;
}

function statusTextClass(status: string): string {
  switch (normalizeRunStatus(status)) {
    case "Running":
      return "text-sky-700 dark:text-sky-300";
    case "Error":
      return "text-destructive";
    case "Stopped":
      return "text-state-caution";
    default:
      return "text-muted-foreground";
  }
}


export function isRunStoppable(run: Pick<RunResult, "status">): boolean {
  return ["pending", "running", "awaiting_trace"].includes(
    (run.status || "").trim().toLowerCase(),
  );
}

function dayKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function runMatchesFilters(run: RunResult, filters: RunFilters): boolean {
  const name = [evaluationName(run), run.lineage?.target_prompt_ref, run.lineage?.target_prompt_version].filter(Boolean).join(" ");
  if (filters.name.trim() && !name.toLowerCase().includes(filters.name.trim().toLowerCase())) {
    return false;
  }

  if (filters.type) {
    const type = runScenarioTypeLabel(run);
    if (type !== filters.type) return false;
  }

  if (filters.status) {
    if (normalizeRunStatus(run.status || "") !== filters.status) return false;
  }

  const runDay = dayKey(run.completed_at || run.started_at);
  if (filters.dateMode === "specific" && filters.date) {
    if (runDay !== filters.date) return false;
  }
  if (filters.dateMode === "range") {
    if (filters.dateFrom && (!runDay || runDay < filters.dateFrom)) return false;
    if (filters.dateTo && (!runDay || runDay > filters.dateTo)) return false;
  }

  return true;
}

function filtersActive(filters: RunFilters): boolean {
  return Boolean(
    filters.name.trim() ||
      filters.type ||
      filters.status ||
      (filters.dateMode === "specific" && filters.date) ||
      (filters.dateMode === "range" && (filters.dateFrom || filters.dateTo)),
  );
}

/**
 * Whether an empty filtered result might be hiding matches that were never
 * loaded. The run list is a server-capped slice, so filtering only sees the
 * loaded runs; when the true server total exceeds what we hold locally, an
 * empty result cannot honestly claim the filter covered every run.
 */
export function runFilterMayHaveUnloadedMatches(
  hasFilters: boolean,
  loadedRunCount: number,
  serverTotal: number | null,
): boolean {
  return hasFilters && serverTotal != null && serverTotal > loadedRunCount;
}

export function ExperimentsLibrary({
  runs,
  loading,
  highlightRunId,
  embedded = false,
  refreshing = false,
  onManualRefresh,
  onRefresh,
}: {
  runs: RunResult[];
  loading: boolean;
  highlightRunId?: string;
  /** When true, drop the nested library title (host page already labels the tab). */
  embedded?: boolean;
  refreshing?: boolean;
  onManualRefresh?: () => void;
  onRefresh?: () => void | Promise<void>;
}) {
  const libraryRef = useRef<HTMLElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  const urlState = useMemo(
    () => readRunLibraryUrlState(new URLSearchParams(searchParamsString)),
    [searchParamsString],
  );
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  const filters: RunFilters = useMemo(
    () => ({
      name: urlState.query,
      type: urlState.type,
      status: urlState.status,
      dateMode: urlState.dateMode,
      date: urlState.date,
      dateFrom: urlState.dateFrom,
      dateTo: urlState.dateTo,
    }),
    [urlState],
  );
  const lifecycleView: EvaluationLifecycleView = urlState.lifecycle;
  const [lifecycleAction, setLifecycleAction] = useState<{
    action: EvaluationLifecycleAction;
    group: ExperimentRunGroup;
  } | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [runToStop, setRunToStop] = useState<RunResult | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const page = urlState.page;
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(new Set(urlState.expanded));
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>(urlState.selectedRunIds);
  const [selectedRun, setSelectedRun] = useState<RunResult | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<ColumnId[]>(["name", "run_id", "traces", "score", "status", "started"]);
  const [columnWidths, setColumnWidths] = useState<Record<ColumnId, number>>(DEFAULT_COLUMN_WIDTHS);
  const resizeRef = useRef<{
    id: ColumnId;
    startX: number;
    startWidth: number;
  } | null>(null);

  const navigateLibrary = useCallback(
    (nextState: RunLibraryUrlState, history: "push" | "replace") => {
      const query = writeRunLibrarySearchParams(searchParamsString, nextState);
      const href = query ? `${pathname}?${query}` : pathname;
      router[history](href, { scroll: false });
    },
    [pathname, router, searchParamsString],
  );

  useEffect(() => {
    // Learn the true server-side run total (F9 paging) so the footer can annotate
    // truncation honestly when this view shows only a loaded slice. Best-effort:
    // a failure just leaves the honest local count in place.
    let cancelled = false;
    api
      .tenant()
      .then(({ tenant_id }) => runHistoryApi.list({ limit: 1, tenant_id }))
      .then((page) => {
        if (!cancelled) setServerTotal(page.total);
      })
      .catch(() => {
        /* keep the local count; never fabricate a total */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // URL state is the shareable source of truth for analytical context.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpandedGroupKeys(new Set(urlState.expanded));
    setSelectedRunIds(urlState.selectedRunIds);
    setSelectedRun(urlState.openRunId ? runs.find((run) => run.run_id === urlState.openRunId) ?? null : null);
  }, [runs, urlState.expanded, urlState.openRunId, urlState.selectedRunIds]);

  useEffect(() => {
    // Hydrating persisted table preferences is this effect's synchronization boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setColumnWidths(loadColumnWidths());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(columnWidths));
  }, [columnWidths]);

  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      const active = resizeRef.current;
      if (!active) return;
      const delta = event.clientX - active.startX;
      const nextWidth = Math.max(MIN_COLUMN_WIDTH, Math.round(active.startWidth + delta));
      setColumnWidths((current) =>
        current[active.id] === nextWidth ? current : { ...current, [active.id]: nextWidth },
      );
    }

    function onPointerUp() {
      resizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  const archivedGroupCount = useMemo(
    () => groupRunsByName(runs.filter(runIsArchived)).length,
    [runs],
  );
  const activeGroupCount = useMemo(
    () => groupRunsByName(runs.filter((run) => !runIsArchived(run))).length,
    [runs],
  );

  const groups = useMemo(() => {
    const lifecycleRuns = runs.filter((run) =>
      lifecycleView === "archived" ? runIsArchived(run) : !runIsArchived(run),
    );
    const filtered = lifecycleRuns.filter((run) => runMatchesFilters(run, filters));
    return sortExperimentGroups(groupRunsByName(filtered), urlState.sortKey, urlState.sortDir);
  }, [runs, filters, lifecycleView, urlState.sortKey, urlState.sortDir]);

  const pageCount = Math.max(1, Math.ceil(groups.length / GROUPS_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * GROUPS_PER_PAGE;
  const visibleGroups = groups.slice(pageStart, pageStart + GROUPS_PER_PAGE);
  const visibleRunCount = visibleGroups.reduce((sum, group) => sum + group.runs.length, 0);
  const selectedRunGroup = selectedRun
    ? groups.find((group) => group.runs.some((run) => run.run_id === selectedRun.run_id)) ?? null
    : null;

  const tableMinWidth = useMemo(
    () =>
      SELECT_COLUMN_WIDTH +
      COLUMN_DEFS.filter((column) => visibleColumns.includes(column.id)).reduce(
        (sum, column) => sum + (columnWidths[column.id] ?? DEFAULT_COLUMN_WIDTHS[column.id]),
        0,
      ),
    [columnWidths, visibleColumns],
  );

  const selectableRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of groups) {
      const cohorts = new Map<string, RunResult[]>();
      for (const run of group.runs) {
        const key = comparisonKey(run);
        if (!key || !isRunComplete(run)) continue;
        const cohort = cohorts.get(key) ?? [];
        cohort.push(run);
        cohorts.set(key, cohort);
      }
      for (const cohort of cohorts.values()) {
        if (cohort.length < MIN_COMPARISON_RUNS) continue;
        cohort.forEach((run) => ids.add(run.run_id));
      }
    }
    return ids;
  }, [groups]);

  const selectedRuns = useMemo(
    () =>
      selectedRunIds
        .map((id) => runs.find((run) => run.run_id === id))
        .filter((run): run is RunResult => Boolean(run)),
    [runs, selectedRunIds],
  );
  const selectedComparisonKey = selectedRuns[0] ? comparisonKey(selectedRuns[0]) : null;
  // Derived from the same grouping that produces `group.key`, not from the
  // evaluation name. These were two different value spaces —
  // "evaluation:<experimentId>" versus the lowercased display name — so
  // `group.key === selectedGroupKey` was never true once anything was selected.
  // With nothing selected the guard short-circuits on null, which is why the
  // first checkbox worked and every one after it silently did nothing.
  const selectedGroupKey = selectedRuns[0]
    ? groups.find((group) => group.runs.some((run) => run.run_id === selectedRuns[0].run_id))?.key ??
      null
    : null;

  function startColumnResize(id: ColumnId, event: ReactPointerEvent<HTMLSpanElement>) {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      id,
      startX: event.clientX,
      startWidth: columnWidths[id] ?? DEFAULT_COLUMN_WIDTHS[id],
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function resizeColumnWithKeyboard(id: ColumnId, delta: number) {
    setColumnWidths((current) => ({
      ...current,
      [id]: Math.min(
        MAX_COLUMN_WIDTH,
        Math.max(MIN_COLUMN_WIDTH, (current[id] ?? DEFAULT_COLUMN_WIDTHS[id]) + delta),
      ),
    }));
  }

  useEffect(() => {
    if (!highlightRunId || loading) return;
    const groupIndex = groups.findIndex((group) =>
      group.runs.some((run) => run.run_id === highlightRunId),
    );
    if (groupIndex < 0) return;
    const highlightedGroup = groups[groupIndex];
    if (!expandedGroupKeys.has(highlightedGroup.key)) {
      // The requested URL highlight owns expansion synchronization.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExpandedGroupKeys((current) => new Set(current).add(highlightedGroup.key));
      return;
    }
    const targetPage = Math.floor(groupIndex / GROUPS_PER_PAGE) + 1;
    if (targetPage !== currentPage) {
      navigateLibrary({ ...urlState, page: targetPage }, "replace");
      return;
    }
    const el = document.querySelector(`[data-run-id="${CSS.escape(highlightRunId)}"]`);
    scrollIntoPane(el, { behavior: "smooth", block: "center" });
  }, [
    currentPage,
    expandedGroupKeys,
    groups,
    highlightRunId,
    loading,
    navigateLibrary,
    urlState,
  ]);

  useEffect(() => {
    if (!selectedRun) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") navigateLibrary({ ...urlState, openRunId: "" }, "replace");
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [navigateLibrary, selectedRun, urlState]);

  function toggleRunSelected(runId: string) {
    let next: string[];
    if (selectedRunIds.includes(runId)) next = selectedRunIds.filter((id) => id !== runId);
    else {
      if (selectedRunIds.length >= MAX_COMPARISON_RUNS) return;
      const run = runs.find((candidate) => candidate.run_id === runId);
      if (!run || !selectableRunIds.has(runId)) return;
      const first = runs.find((candidate) => candidate.run_id === selectedRunIds[0]);
      if (
        first &&
        (comparisonKey(first) !== comparisonKey(run) ||
          evaluationName(first).toLocaleLowerCase() !== evaluationName(run).toLocaleLowerCase())
      ) {
        return;
      }
      next = [...selectedRunIds, runId];
    }
    setSelectedRunIds(next);
    navigateLibrary({ ...urlState, selectedRunIds: next }, "replace");
  }

  function compareSelectedRuns() {
    const baseline = selectedRuns[0];
    if (!baseline) return;
    const href = comparisonHrefForRuns(selectedRuns, baseline.run_id);
    if (href) router.push(href);
  }

  function toggleGroupExpanded(groupKey: string) {
    const next = new Set(expandedGroupKeys);
    if (next.has(groupKey)) next.delete(groupKey);
    else next.add(groupKey);
    setExpandedGroupKeys(next);
    navigateLibrary({ ...urlState, expanded: [...next] }, "replace");
  }

  function openRunReport(run: RunResult) {
    setSelectedRun(run);
    navigateLibrary({ ...urlState, openRunId: run.run_id }, "replace");
  }

  function closeRunReport() {
    setSelectedRun(null);
    navigateLibrary({ ...urlState, openRunId: "" }, "replace");
  }

  function selectLifecycleView(view: EvaluationLifecycleView) {
    setExpandedGroupKeys(new Set());
    setSelectedRunIds([]);
    setLifecycleError(null);
    navigateLibrary({ ...urlState, lifecycle: view, page: 1, expanded: [], selectedRunIds: [], openRunId: "" }, "push");
  }

  async function applyLifecycleAction() {
    if (!lifecycleAction || lifecycleBusy) return;
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      for (const experimentId of lifecycleAction.group.experimentIds) {
        if (lifecycleAction.action === "archive") {
          await evaluationApi.archiveExperiment(experimentId);
        } else {
          await evaluationApi.restoreExperiment(experimentId);
        }
      }
      setLifecycleAction(null);
      setExpandedGroupKeys(new Set());
      setSelectedRunIds([]);
      await onRefresh?.();
    } catch (reason) {
      setLifecycleError(
        reason instanceof Error
          ? reason.message
          : `Unable to ${lifecycleAction.action} evaluation`,
      );
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function stopRun() {
    if (!runToStop || stopBusy) return;
    setStopBusy(true);
    setStopError(null);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      await evaluationApi.cancelRun(runToStop.run_id, tenantId);
      toast.success("Evaluation run stopped");
      setRunToStop(null);
      await onRefresh?.();
    } catch (reason) {
      setStopError(userFacingError(reason, "Unable to stop evaluation run"));
    } finally {
      setStopBusy(false);
    }
  }

  function clearAllFilters() {
    navigateLibrary(
      {
        ...urlState,
        query: "",
        type: "",
        status: "",
        dateMode: "any",
        date: "",
        dateFrom: "",
        dateTo: "",
        page: 1,
      },
      "push",
    );
  }

  function updateFilters(
    patch: Partial<RunFilters>,
    history: "push" | "replace" = "replace",
  ) {
    navigateLibrary(
      {
        ...urlState,
        query: patch.name ?? urlState.query,
        type: patch.type ?? urlState.type,
        status: patch.status ?? urlState.status,
        dateMode: patch.dateMode ?? urlState.dateMode,
        date: patch.date ?? urlState.date,
        dateFrom: patch.dateFrom ?? urlState.dateFrom,
        dateTo: patch.dateTo ?? urlState.dateTo,
        page: 1,
      },
      history,
    );
  }

  const hasFilters = filtersActive(filters);

  // The run list is a loaded slice (the server caps how many runs come back),
  // and filtering runs on that slice only. When more runs exist server-side than
  // we hold locally, an empty filtered result can't honestly claim the filter
  // covered everything — older matching runs may sit beyond the loaded window.
  const loadedRunCount = runs.length;
  const mayHaveUnloadedMatches = runFilterMayHaveUnloadedMatches(
    hasFilters,
    loadedRunCount,
    serverTotal,
  );

  return (
    <section
      ref={libraryRef}
      className={cn(
        "panel overflow-hidden",
        selectedRuns.length > 0 && "mb-24",
      )}
    >
      <div className="border-b border-border px-5 py-4 sm:px-6">
        <div className="min-w-0">
          {embedded ? (
            <>
              <p className="eval-hub-eyebrow mb-1 text-[0.6875rem] text-evalai-purple">Run history</p>
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Expand an evaluation, select a baseline, then add up to three compatible candidates.
              </p>
            </>
          ) : (
            <>
              <p className="eval-hub-eyebrow mb-1 text-[0.6875rem] text-evalai-purple">Run history</p>
              <h2 className="font-display text-lg font-semibold tracking-tight">Evaluation runs</h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Expand an evaluation, select a baseline, then add up to three compatible candidates.
              </p>
            </>
          )}
        </div>

        {/* One row of filters, with the view controls pushed right. Eight controls
            wrapped, stranding Active/Archived and a lone refresh icon on a second
            line that read as a separate toolbar for the same table. */}
        {/* One row: search and filters left, view controls right. */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <SearchField
            value={filters.name}
            onChange={(event) => updateFilters({ name: event.target.value })}
            placeholder="Search evaluations or prompt versions…"
            label="Search evaluation runs"
          />
          <SegmentedControl
            label="Evaluation lifecycle"
            className="ml-auto"
            value={lifecycleView}
            onChange={selectLifecycleView}
            options={[
              { value: "active" as const, label: `Active (${activeGroupCount})` },
              { value: "archived" as const, label: `Archived (${archivedGroupCount})` },
            ]}
          />
        <details className="relative shrink-0">
          <summary className="flex h-11 cursor-pointer items-center rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring">Run table columns</summary>
          <div className="absolute left-0 top-full z-20 grid min-w-52 gap-1 rounded-lg border bg-popover p-3 shadow-lg">
            {COLUMN_DEFS.map((column) => <label key={column.id} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" checked={visibleColumns.includes(column.id)} disabled={column.id === "name"} onChange={() => setVisibleColumns((current) => current.includes(column.id) ? current.filter((id) => id !== column.id) : COLUMN_DEFS.map((item) => item.id).filter((id) => id === column.id || current.includes(id)))} />{column.header}</label>)}
          </div>
        </details>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 rounded-lg"
            onClick={() => {
              const rows = groups.map((group) => ({
                name: group.name,
                runs: group.runs.length,
                latestScore: formatRunScore(group.latest),
                latestOutcome: presentRunOutcome(group.latest).label,
                lastRun: groupLastRunLabel(group),
              }));
              downloadLibraryCsv("evaluation-library-view.csv", rows);
            }}
          >
            Export view (CSV)
          </Button>
          {/* Icon-only, like the refresh beside Add dataset. Seven labelled controls
              did not fit one line, so the row wrapped and read as two toolbars for
              one table; the icon is the cheapest ~90px to give back. */}
          {embedded && onManualRefresh ? (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="rounded-lg"
              onClick={onManualRefresh}
              disabled={refreshing || loading}
              aria-label="Refresh evaluations"
              title="Refresh evaluations"
            >
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden="true" />
            </Button>
          ) : null}
        </div>

        {lifecycleError ? (
          <div
            role="alert"
            className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          >
            <span>{lifecycleError}</span>
            <button
              type="button"
              className="shrink-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setLifecycleError(null)}
              aria-label="Dismiss evaluation lifecycle error"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>

      {loading ? (
        <LoadingState label="Loading evaluations…" className="min-h-48 border-0" />
      ) : groups.length === 0 ? (
        <div className="px-5 py-12 text-center text-sm text-muted-foreground">
          <p className="mb-1">
            {hasFilters
              ? mayHaveUnloadedMatches
                ? `No matches in the loaded ${loadedRunCount} of ${serverTotal} runs.`
                : "No runs match these filters."
              : lifecycleView === "archived"
                ? "No archived evaluations."
                : "No evaluation runs yet."}
          </p>
          {mayHaveUnloadedMatches ? (
            <p className="text-xs text-muted-foreground">
              Older runs beyond the loaded window may still match — clear the filters to widen the view.
            </p>
          ) : null}
          {hasFilters ? (
            <Button type="button" variant="outline" size="sm" className="mt-3" onClick={clearAllFilters}>
              Clear all filters
            </Button>
          ) : null}
          {!hasFilters && lifecycleView === "active" ? (
            <p className="text-xs">
              Start from a{" "}
              <Link href="/evaluate" className="font-medium text-brand-text underline-offset-4 hover:underline dark:text-brand">
                new evaluation
              </Link>
              ; the published dataset determines the evaluation type.
            </p>
          ) : null}
        </div>
      ) : (
        <>
        <div className="space-y-3 p-3 md:hidden">
          {visibleGroups.map((group) => {
            const expanded = expandedGroupKeys.has(group.key);
            return (
              <article key={group.key} className="overflow-hidden border-b border-border last:border-b-0">
                <div className="flex items-start gap-3 p-4">
                  <button type="button" aria-expanded={expanded} onClick={() => toggleGroupExpanded(group.key)} className="min-h-11 min-w-0 flex-1 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="flex items-center gap-2 font-semibold"><ChevronRight className={cn("size-4 shrink-0 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} aria-hidden="true" /><span className="truncate" title={group.name}>{middleTruncate(group.name)}</span></span>
                    <span className="mt-1 block pl-6 text-xs text-muted-foreground">{group.runs.length} runs · last {groupLastRunLabel(group)}</span>
                  </button>
                  <RunOutcomeBadge run={group.latest} />
                </div>
                {expanded ? (
                  <div className="space-y-2 border-t bg-muted/10 p-3">
                    {group.runs.map((run) => {
                      const checked = selectedRunIds.includes(run.run_id);
                      const complete = isRunComplete(run);
                      const sameBasis = !selectedComparisonKey || comparisonKey(run) === selectedComparisonKey;
                      const sameGroup = !selectedGroupKey || group.key === selectedGroupKey;
                      const selectable = complete && selectableRunIds.has(run.run_id) && sameBasis && sameGroup && (selectedRunIds.length < MAX_COMPARISON_RUNS || checked);
                      const reason = !complete ? "Only completed runs can be compared." : !selectableRunIds.has(run.run_id) ? "No compatible run shares this comparison basis." : !sameBasis ? "This run uses a different dataset, metric, contract, evaluator, or scope." : !sameGroup ? "Clear the current comparison before selecting another evaluation." : selectedRunIds.length >= MAX_COMPARISON_RUNS && !checked ? "A comparison supports one baseline and up to three candidates." : checked ? "Selected for comparison." : selectedRunIds.length ? "Available as a candidate." : "Available as the baseline.";
                      return (
                        <article key={run.run_id} className="rounded-lg border bg-background p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium">{runIdentity(run, group)}</p>
                              <p className="mt-1 text-xs text-muted-foreground">{formatCompactRunSpan(run)}</p>
                            </div>
                            <RunOutcomeBadge run={run} />
                          </div>
                          <p className="mt-3 text-xs text-muted-foreground">{reason}</p>
                          <div className={cn("mt-3 grid gap-2", isRunStoppable(run) ? "grid-cols-3" : "grid-cols-2")}>
                            <label className={cn("flex min-h-11 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-medium", !selectable && !checked && "text-muted-foreground")}>
                              <input type="checkbox" checked={checked} aria-disabled={!selectable && !checked} onChange={() => { if (selectable || checked) toggleRunSelected(run.run_id); }} />
                              {checked ? "Selected" : selectedRunIds.length ? "Candidate" : "Baseline"}
                            </label>
                            {complete ? (
                              <button type="button" onClick={() => openRunReport(run)} className="min-h-11 rounded-lg border px-3 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Open result</button>
                            ) : (
                              <Link href={runDetailsHref(run.run_id)} className="flex min-h-11 items-center justify-center rounded-lg border px-3 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Open progress</Link>
                            )}
                            {isRunStoppable(run) ? (
                              <button type="button" onClick={() => setRunToStop(run)} className="inline-flex min-h-11 items-center justify-center gap-1 rounded-lg border border-red-200 px-3 text-xs font-medium text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40">
                                <Square className="size-3" aria-hidden="true" />
                                Stop
                              </button>
                            ) : null}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
        <div className="hidden overflow-hidden md:block">
          <table className="w-full table-fixed text-left text-sm">
            <caption className="sr-only">Evaluation history grouped by stable evaluation identifier</caption>
            <colgroup>
              <col className="w-[38%]" />
              <col className="w-[10%]" />
              <col className="w-[13%]" />
              <col className="w-[13%]" />
              <col className="w-[20%]" />
              <col className="w-[6%]" />
            </colgroup>
            <thead className="border-b border-border bg-muted/20 text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">Evaluation</th>
                <th className="px-3 py-3 text-right font-medium tabular-nums" aria-sort={urlState.sortKey === "runs" ? (urlState.sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="inline-flex min-h-8 items-center justify-end gap-1 rounded-lg font-medium uppercase tracking-[0.08em] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      const next = nextLibrarySort(urlState.sortKey, urlState.sortDir, "runs");
                      navigateLibrary({ ...urlState, ...next, page: 1 }, "replace");
                    }}
                    title={librarySortIndicator(urlState.sortKey, urlState.sortDir, "runs").hint}
                  >
                    Runs
                    <SortIndicator
                      direction={librarySortIndicator(urlState.sortKey, urlState.sortDir, "runs").direction}
                    />
                  </button>
                </th>
                <th className="px-3 py-3 text-right font-medium tabular-nums" aria-sort={urlState.sortKey === "latest_score" ? (urlState.sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="inline-flex min-h-8 items-center justify-end gap-1 rounded-lg font-medium uppercase tracking-[0.08em] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      const next = nextLibrarySort(urlState.sortKey, urlState.sortDir, "latest_score");
                      navigateLibrary({ ...urlState, ...next, page: 1 }, "replace");
                    }}
                    title={librarySortIndicator(urlState.sortKey, urlState.sortDir, "latest_score").hint}
                  >
                    Latest KPI composite
                    <SortIndicator
                      direction={librarySortIndicator(urlState.sortKey, urlState.sortDir, "latest_score").direction}
                    />
                  </button>
                </th>
                <th className="px-3 py-3 font-medium">Latest outcome</th>
                <th className="px-5 py-3 text-right font-medium tabular-nums" aria-sort={urlState.sortKey === "last_run" ? (urlState.sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="inline-flex min-h-8 items-center justify-end gap-1 rounded-lg font-medium uppercase tracking-[0.08em] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      const next = nextLibrarySort(urlState.sortKey, urlState.sortDir, "last_run");
                      navigateLibrary({ ...urlState, ...next, page: 1 }, "replace");
                    }}
                    title={librarySortIndicator(urlState.sortKey, urlState.sortDir, "last_run").hint}
                  >
                    Last run
                    <SortIndicator
                      direction={librarySortIndicator(urlState.sortKey, urlState.sortDir, "last_run").direction}
                    />
                  </button>
                </th>
                <th className="px-2 py-3 text-center font-medium" aria-label="Evaluation actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visibleGroups.map((group) => (
                  <GroupBlock
                  key={group.key}
                  group={group}
                  highlightRunId={highlightRunId}
                  selectedRunIds={selectedRunIds}
                  selectableRunIds={selectableRunIds}
                  selectedComparisonKey={selectedComparisonKey}
                  selectedGroupKey={selectedGroupKey}
                  expanded={expandedGroupKeys.has(group.key)}
                  onToggleExpanded={() => toggleGroupExpanded(group.key)}
                  onToggleRun={toggleRunSelected}
                  onOpenReport={openRunReport}
                  columns={visibleColumns}
                  columnWidths={columnWidths}
                  tableMinWidth={tableMinWidth}
                  onStartColumnResize={startColumnResize}
                  onResizeColumnWithKeyboard={resizeColumnWithKeyboard}
                  onRequestStopRun={setRunToStop}
                  lifecycleAction={lifecycleView === "archived" ? "restore" : "archive"}
                  onRequestLifecycleAction={(action) =>
                    setLifecycleAction({ action, group })
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
      {!loading && groups.length > 0 ? (
        <div className="flex flex-col gap-3 border-t bg-muted/10 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Showing <span className="font-medium text-foreground">{pageStart + 1}</span>–
            <span className="font-medium text-foreground">
              {Math.min(pageStart + GROUPS_PER_PAGE, groups.length)}
            </span>{" "}
            of <span className="font-medium text-foreground">{groups.length}</span> evaluations
            {/* One count, not three. "8 runs on this page" restated the range
                just given, in a different unit; the run-history total is a
                different fact and belongs beside it only when this view is
                showing less than all of it. */}
            {serverTotal != null && serverTotal > visibleRunCount ? (
              <>
                <span aria-hidden="true"> · </span>
                <span>{serverTotal} runs in run history</span>
              </>
            ) : null}
          </p>
          <nav className="flex items-center gap-2" aria-label="Evaluation runs pagination">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={currentPage === 1}
              onClick={() =>
                navigateLibrary({ ...urlState, page: Math.max(1, currentPage - 1) }, "push")
              }
            >
              <ChevronLeft className="mr-1 size-3.5" aria-hidden="true" />
              Previous
            </Button>
            <span className="min-w-20 text-center text-xs font-medium" aria-live="polite">
              Page {currentPage} of {pageCount}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={currentPage === pageCount}
              onClick={() =>
                navigateLibrary(
                  { ...urlState, page: Math.min(pageCount, currentPage + 1) },
                  "push",
                )
              }
            >
              Next
              <ChevronRight className="ml-1 size-3.5" aria-hidden="true" />
            </Button>
          </nav>
        </div>
      ) : null}
      {selectedRun && selectedRunGroup ? (
        <ReportDrawer run={selectedRun} group={selectedRunGroup} onClose={closeRunReport} />
      ) : null}
      {selectedRuns.length > 0 ? (
        <ComparisonSelectionTray
          runs={selectedRuns}
          alignTo={libraryRef}
          onRemove={toggleRunSelected}
          onBaseline={(id) => navigateLibrary({ ...urlState, selectedRunIds: [id, ...selectedRunIds.filter((value) => value !== id)] }, "replace")}
          onClear={() => {
            setSelectedRunIds([]);
            navigateLibrary({ ...urlState, selectedRunIds: [] }, "replace");
          }}
          onCompare={compareSelectedRuns}
        />
      ) : null}
      {lifecycleAction ? (
        <EvaluationLifecycleDialog
          action={lifecycleAction.action}
          group={lifecycleAction.group}
          busy={lifecycleBusy}
          onCancel={() => {
            if (!lifecycleBusy) setLifecycleAction(null);
          }}
          onConfirm={() => void applyLifecycleAction()}
        />
      ) : null}
      {runToStop ? (
        <StopRunDialog
          run={runToStop}
          busy={stopBusy}
          error={stopError}
          onCancel={() => {
            if (!stopBusy) {
              setRunToStop(null);
              setStopError(null);
            }
          }}
          onConfirm={() => void stopRun()}
        />
      ) : null}
    </section>
  );
}

function GroupBlock({
  group,
  highlightRunId,
  selectedRunIds,
  selectableRunIds,
  selectedComparisonKey,
  selectedGroupKey,
  expanded,
  onToggleExpanded,
  onToggleRun,
  onOpenReport,
  columns,
  columnWidths,
  tableMinWidth,
  onStartColumnResize,
  onResizeColumnWithKeyboard,
  onRequestStopRun,
  lifecycleAction,
  onRequestLifecycleAction,
}: {
  group: ExperimentRunGroup;
  highlightRunId?: string;
  selectedRunIds: string[];
  selectableRunIds: Set<string>;
  selectedComparisonKey: string | null;
  selectedGroupKey: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleRun: (runId: string) => void;
  onOpenReport: (run: RunResult) => void;
  columns: ColumnId[];
  columnWidths: Record<ColumnId, number>;
  tableMinWidth: number;
  onStartColumnResize: (id: ColumnId, event: ReactPointerEvent<HTMLSpanElement>) => void;
  onResizeColumnWithKeyboard: (id: ColumnId, delta: number) => void;
  onRequestStopRun: (run: RunResult) => void;
  lifecycleAction: EvaluationLifecycleAction;
  onRequestLifecycleAction: (action: EvaluationLifecycleAction) => void;
}) {
  const [runSort, setRunSort] = useState<{ column: ColumnId; ascending: boolean } | null>(null);
  const orderedRuns = useMemo(() => {
    if (!runSort) return group.runs;
    const value = (run: RunResult): string | number | null => {
      switch (runSort.column) {
        case "name": return run.run_number ?? 0;
        case "run_id": return run.run_id;
        case "status": return normalizeRunStatus(run.status || "");
        case "score": return scoreValue(run);
        case "started": return run.started_at || null;
        case "ended": return run.completed_at || null;
        case "delta": {
          const delta = deltaAgainstPrevious(run, group.runs[group.runs.indexOf(run) + 1]);
          return delta.kind === "value" ? delta.delta : null;
        }
        default: return null;
      }
    };
    return [...group.runs].sort((a, b) => {
      const av = value(a), bv = value(b);
      if (av == null) return bv == null ? 0 : 1;
      if (bv == null) return -1;
      const order = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return runSort.ascending ? order : -order;
    });
  }, [group.runs, runSort]);
  const hasStoppableRuns = group.runs.some(isRunStoppable);
  const completedRunCount = group.runs.filter(isRunComplete).length;
  const comparableRuns = latestComparableRuns(group);
  const hasComparableRuns = comparableRuns.length >= MIN_COMPARISON_RUNS;
  // "Not scored", not an em dash: this app names an absence rather than printing a
  // bare dash, and the Experiments table beside it already does. The same missing
  // score was written two ways depending on which tab you were on.
  // Both the label and the styling come off the score, not off the label's
  // text: comparing a formatter's output is a comparison that breaks silently
  // the next time the wording changes.
  const latestScored = isRunComplete(group.latest) && gatedRunScore(group.latest) != null;
  const latestScore = latestScored ? formatRunScore(group.latest) : "Not scored";
  const latestEnd = presentRunEnd(group.latest);

  return (
    <>
      <tr
        className={cn(
          "transition-colors",
          expanded ? "bg-muted/30" : "bg-background hover:bg-muted/15",
        )}
      >
        <td className="px-5 py-3.5">
          <button
            type="button"
            className="flex max-w-full items-center gap-2.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} runs for ${group.name}`}
            onClick={onToggleExpanded}
          >
            <ChevronRight
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-90",
              )}
              aria-hidden="true"
            />
            <span className="truncate font-semibold text-foreground" title={group.name}>{middleTruncate(group.name)}</span>
            {isOneOffDiagnosticRun(group.latest) ? (
              <span className="rounded-full border border-state-caution/30 bg-state-caution-soft px-2 py-0.5 text-[11px] font-medium text-state-caution">
                Diagnostic
              </span>
            ) : null}
          </button>
        </td>
        <td className="px-3 py-3.5 text-right text-sm tabular-nums text-foreground">
          {group.runs.length}
        </td>
        <td
          className={cn(
            "px-3 py-3.5 text-right text-sm",
            latestScored ? "tabular-nums text-foreground" : "text-xs text-muted-foreground",
          )}
        >
          {latestScore}
        </td>
        <td className="px-3 py-3.5">
          <RunOutcomeBadge run={group.latest} />
        </td>
        <td className="whitespace-nowrap px-5 py-3.5 text-right text-xs tabular-nums text-muted-foreground">
          {latestEnd.time ? (
            latestEnd.time
          ) : (
            <>
              <span className={cn("font-medium", statusTextClass(group.latest.status || ""))}>
                {latestEnd.state || presentRunOutcome(group.latest).label}
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                Started {presentRunStart(group.latest)}
              </span>
            </>
          )}
        </td>
        <td className="px-2 py-3.5 text-center">
          {group.experimentIds.length > 0 ? (
            <EvaluationLifecycleActionButton
              evaluationName={group.name}
              action={lifecycleAction}
              onSelect={onRequestLifecycleAction}
            />
          ) : null}
        </td>
      </tr>
      {expanded ? (
        <tr>
          {/* Tinted, not white: the nested run table sat on the same background as
              the rows around it, so there was no telling where an expansion ended
              and the next collapsed evaluation began. */}
          <td colSpan={6} className="border-t bg-muted/20 p-0">
            <p className="border-b bg-muted/15 px-5 py-2.5 text-xs text-muted-foreground">
              {isOneOffDiagnosticRun(group.latest)
                ? "Diagnostic rescores are isolated results. Open the source evaluation and run it again to create a comparable candidate."
                : hasComparableRuns
                ? `${comparableRuns.length} of ${completedRunCount} completed runs share the same comparison basis.`
                : completedRunCount >= MIN_COMPARISON_RUNS
                  ? "The completed runs use different datasets, metrics, contracts, evaluators, or evidence scopes, so they cannot be compared safely."
                  : "Complete at least two runs of this evaluation to compare a baseline and candidate."}
            </p>
            <div className="overflow-x-auto">
                <table
                  className="w-full table-fixed text-left text-sm"
                  style={{ minWidth: Math.max(860, tableMinWidth + (hasStoppableRuns ? 100 : 0)) }}
                >
                  <caption className="sr-only">Runs available for this evaluation</caption>
                  <colgroup>
                    <col style={{ width: SELECT_COLUMN_WIDTH }} />
                    {columns.map((column) => (
                      <col
                        key={column}
                        style={{ width: columnWidths[column] ?? DEFAULT_COLUMN_WIDTHS[column] }}
                      />
                    ))}
                    {hasStoppableRuns ? <col style={{ width: 100 }} /> : null}
                  </colgroup>
                  <thead className="border-b border-border bg-muted/15 text-muted-foreground">
                    <tr>
                      <th className="px-2 py-2.5 text-center font-medium" aria-label="Compare runs">
                        <GitCompareArrows className="mx-auto size-3.5" aria-hidden="true" />
                      </th>
                      {columns.map((column) => {
                        const definition = COLUMN_DEFS.find((candidate) => candidate.id === column);
                        const header = definition?.header || column;
                        const numeric = ["score", "delta", "started"].includes(column);
                        return (
                          <th
                            key={column}
                            className={cn(
                              "relative px-3 py-2.5 font-medium",
                              numeric && "text-right tabular-nums",
                            )}
                            aria-sort={column === "traces" ? undefined : runSort?.column === column ? (runSort.ascending ? "ascending" : "descending") : "none"}
                            style={{ width: columnWidths[column] ?? DEFAULT_COLUMN_WIDTHS[column] }}
                          >
                            {column === "traces" ? <span className="pr-2">{header}</span> : <button type="button" className="inline-flex min-h-8 items-center gap-1 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setRunSort((current) => ({ column, ascending: current?.column === column ? !current.ascending : true }))}>{header}<SortIndicator direction={runSort?.column === column ? (runSort.ascending ? "asc" : "desc") : null} /></button>}
                            <span
                              role="separator"
                              tabIndex={0}
                              aria-orientation="vertical"
                              aria-label={`Resize ${header} column`}
                              aria-valuemin={MIN_COLUMN_WIDTH}
                              aria-valuemax={MAX_COLUMN_WIDTH}
                              aria-valuenow={columnWidths[column] ?? DEFAULT_COLUMN_WIDTHS[column]}
                              title="Drag to resize"
                              onPointerDown={(event) => onStartColumnResize(column, event)}
                              onKeyDown={(event) => {
                                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                                event.preventDefault();
                                onResizeColumnWithKeyboard(column, event.key === "ArrowLeft" ? -16 : 16);
                              }}
                              className="absolute inset-y-0 right-0 z-10 w-3 cursor-col-resize touch-none select-none outline-none after:absolute after:inset-y-2 after:right-1 after:w-px after:bg-border hover:after:bg-foreground/35 focus-visible:after:w-0.5 focus-visible:after:bg-ring active:after:bg-foreground"
                            />
                          </th>
                        );
                      })}
                      {hasStoppableRuns ? <th className="sticky right-0 z-10 border-l bg-card px-3 py-2.5 text-right font-medium">Stop</th> : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {orderedRuns.map((run) => {
                      const complete = isRunComplete(run);
                      const status = normalizeRunStatus(run.status || "unknown");
                      const highlighted = Boolean(highlightRunId && highlightRunId === run.run_id);
                      const runningHref = runDetailsHref(run.run_id);
                      const checkedIndex = selectedRunIds.indexOf(run.run_id);
                      const checked = checkedIndex >= 0;
                      const hasComparablePartner = selectableRunIds.has(run.run_id);
                      const belongsToSelectedSetup =
                        !selectedComparisonKey || comparisonKey(run) === selectedComparisonKey;
                      const belongsToSelectedGroup =
                        !selectedGroupKey || group.key === selectedGroupKey;
                      const selectionAtLimit =
                        selectedRunIds.length >= MAX_COMPARISON_RUNS && !checked;
                      const comparisonSelectable =
                        complete &&
                        hasComparablePartner &&
                        belongsToSelectedSetup &&
                        belongsToSelectedGroup &&
                        !selectionAtLimit;
                      const comparisonReason = !complete
                        ? "Only completed runs can be compared"
                        : !hasComparablePartner
                          ? isOneOffDiagnosticRun(run) ? "Diagnostic rescores are isolated; create a new run from the source evaluation to compare" : "Run this evaluation again with the same comparison basis to create a candidate"
                          : !belongsToSelectedGroup
                            ? "Finish or clear the current evaluation comparison first"
                            : !belongsToSelectedSetup
                              ? "This run used a different dataset, metric, contract, evaluator, or evidence scope"
                              : selectionAtLimit
                                ? "You can compare one baseline with up to three candidates"
                                : selectedRunIds.length === 0
                                  ? "Select as baseline"
                                  : "Add as candidate";
                      const comparisonHelpId = `comparison-help-${run.run_id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
                      const identity = runIdentity(run, group);
                      const previousRun = group.runs[group.runs.indexOf(run) + 1];
                      const previousDelta = deltaAgainstPrevious(run, previousRun);
                      const scoreDelta =
                        previousDelta.kind === "value" ? previousDelta.delta : null;
                      return (
                        <tr
                          key={run.run_id}
                          data-run-id={run.run_id}
                          className={cn(
                            "align-middle transition-colors",
                            highlighted
                              ? "bg-muted ring-1 ring-inset ring-foreground/20"
                              : "hover:bg-muted/15",
                          )}
                        >
                          <td className="px-2 py-3 text-center align-top">
                            <input
                              type="checkbox"
                              className="mt-1 size-3.5 accent-primary"
                              checked={checked}
                              aria-disabled={!comparisonSelectable && !checked}
                              aria-describedby={comparisonHelpId}
                              onChange={() => {
                                if (comparisonSelectable || checked) onToggleRun(run.run_id);
                              }}
                              aria-label={
                                checked
                                  ? `Remove ${identity} from comparison`
                                  : selectedRunIds.length === 0
                                    ? `Select ${identity} as baseline`
                                    : `Select ${identity} as candidate`
                              }
                              title={comparisonReason}
                            />
                            <span id={comparisonHelpId} className="sr-only">{comparisonReason}</span>
                          </td>
                          {columns.map((column) => {
                            if (column === "name") {
                              return (
                                <td key={column} className="px-3 py-3">
                                  <div className="min-w-0">
                                    <div className="flex min-w-0 items-center gap-2">
                                      {complete ? (
                                        <button
                                          type="button"
                                          onClick={() => onOpenReport(run)}
                                          className="min-w-0 truncate font-medium text-foreground underline-offset-4 hover:underline"
                                        >
                                          {run.run_number ? identity : "Run"}
                                        </button>
                                      ) : (
                                        <Link
                                          href={runningHref}
                                          className="min-w-0 truncate font-medium text-foreground underline-offset-4 hover:underline"
                                          title="Open run progress"
                                        >
                                          {run.run_number ? identity : "Run"}
                                        </Link>
                                      )}
                                      {complete && run.run_id === group.latest.run_id ? (
                                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                          Latest
                                        </span>
                                      ) : null}

                                    </div>
                                    <div className="mt-0.5 flex min-w-0 items-center gap-2">
                                      {checked ? (
                                        <span className="shrink-0 rounded border bg-background px-1.5 py-0.5 text-[9px] font-medium text-foreground">
                                          {checkedIndex === 0 ? "Baseline" : `Candidate ${checkedIndex}`}
                                        </span>
                                      ) : null}
                                    </div>
                                    {!complete && run.error_message ? (
                                      <p className="mt-1 line-clamp-2 text-[11px] text-destructive">
                                        {run.error_message}
                                      </p>
                                    ) : null}
                                  </div>
                                </td>
                              );
                            }
                            if (column === "run_id") {
                              return (
                                <td key={column} className="px-3 py-3">
                                  <div className="flex min-w-0 items-center gap-2">
                                    {/* The run id opens the run. The evaluation
                                        name column used to carry that link, and
                                        it is no longer shown by default — so the
                                        always-present column has to be the way
                                        in, or the row becomes unopenable. */}
                                    {complete ? (
                                      <button
                                        type="button"
                                        onClick={() => onOpenReport(run)}
                                        className="block min-w-0 flex-1 truncate text-left font-mono text-xs text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        title={`Open report for ${run.run_id}`}
                                      >
                                        {run.run_id}
                                      </button>
                                    ) : (
                                      <Link
                                        href={runningHref}
                                        className="block min-w-0 flex-1 truncate font-mono text-xs text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        title="Open run progress"
                                      >
                                        {run.run_id}
                                      </Link>
                                    )}
                                    <CopyIdButton value={run.run_id} kind="run" />

                                  </div>
                                </td>
                              );
                            }
                            if (column === "traces") {
                              const tracesHref = tracesHrefForRun(run);
                              return (
                                <td key={column} className="px-3 py-3 text-xs">
                                  {tracesHref ? (
                                    <Link
                                      href={tracesHref}
                                      className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                      aria-label={`View traces for run ${run.run_id}`}
                                    >
                                      View
                                      <ExternalLink className="size-3" aria-hidden="true" />
                                    </Link>
                                  ) : (
                                    <span className="text-muted-foreground" title="No tracing Project is recorded for this run">
                                      Not recorded
                                    </span>
                                  )}
                                </td>
                              );
                            }
                            if (column === "score") {
                              const runScored = complete && gatedRunScore(run) != null;
                              const runScore = runScored ? formatRunScore(run) : "Not scored";
                              // Same vocabulary as the group row above and the
                              // Experiments table beside it: name the absence,
                              // and keep tabular figures off the words (it
                              // widens the space to a digit's width).
                              return (
                                <td
                                  key={column}
                                  className={cn(
                                    "px-3 py-3 text-right text-xs",
                                    runScored ? "tabular-nums" : "text-muted-foreground",
                                  )}
                                >
                                  {runScore}
                                </td>
                              );
                            }
                            if (column === "delta") {
                              if (previousDelta.kind === "incomparable") {
                                return (
                                  <td
                                    key={column}
                                    className="px-3 py-3 text-right text-xs tabular-nums text-muted-foreground"
                                    title={`Not comparable · ${previousDelta.reason}`}
                                  >
                                    Not comparable · {previousDelta.reason}
                                  </td>
                                );
                              }
                              return (
                                <td
                                  key={column}
                                  className={cn(
                                    "px-3 py-3 text-right text-xs",
                                    scoreDelta == null ? "text-muted-foreground" : "tabular-nums",
                                    scoreDelta != null && scoreDelta > 0 && "text-state-positive",
                                    scoreDelta != null && scoreDelta < 0 && "text-destructive",
                                  )}
                                >
                                  {scoreDelta == null
                                    ? "No earlier run"
                                    : `${scoreDelta > 0 ? "+" : ""}${Math.round(scoreDelta * 100)} pp`}
                                </td>
                              );
                            }
                            if (column === "ended") return <td key={column} className="px-3 py-3 text-xs">{presentRunEnd(run).time ?? presentRunEnd(run).state}</td>;
                            if (column === "status") {
                              return (
                                <td key={column} className="px-3 py-3">
                                  <span
                                    className={cn(
                                      "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium",
                                      statusTextClass(run.status || ""),
                                    )}
                                  >
                                    {status === "Running" ? (
                                      <span
                                        className="size-1.5 animate-pulse rounded-full bg-sky-500"
                                        aria-hidden="true"
                                      />
                                    ) : null}
                                    {status}
                                  </span>
                                </td>
                              );
                            }
                            // Start and End were two columns whose timestamps
                            // overprinted each other once the table overflowed.
                            // One cell: when it began, and how long it took.
                            const duration = runDurationLabel(run);
                            const end = presentRunEnd(run);
                            return (
                              <td
                                key={column}
                                className="whitespace-nowrap px-3 py-3 text-right text-xs tabular-nums text-muted-foreground"
                              >
                                {presentRunStart(run)}
                                {end.time && duration ? (
                                  <span className="text-muted-foreground/70"> · {duration}</span>
                                ) : !end.time ? (
                                  <span className={cn("ml-1.5 font-medium", statusTextClass(run.status || ""))}>
                                    {end.state}
                                  </span>
                                ) : null}
                              </td>
                            );
                          })}
                          {hasStoppableRuns ? <td className={cn("sticky right-0 border-l px-3 py-3 text-right", highlighted ? "bg-muted" : "bg-card")}>
                                    {isRunStoppable(run) ? (
                                      <button
                                        type="button"
                                        onClick={() => onRequestStopRun(run)}
                                        className="inline-flex shrink-0 items-center gap-1 min-h-9 rounded-md border border-destructive/20 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-red-300 dark:hover:bg-red-950/40"
                                        aria-label={`Stop run ${run.run_id}`}
                                        title="Stop evaluation run"
                                      >
                                        <Square className="size-3" aria-hidden="true" />
                                        Stop
                                      </button>
                                    ) : null}
                          </td> : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function EvaluationLifecycleActionButton({
  evaluationName,
  action,
  onSelect,
}: {
  evaluationName: string;
  action: EvaluationLifecycleAction;
  onSelect: (action: EvaluationLifecycleAction) => void;
}) {
  const restoring = action === "restore";
  return (
    <button
      type="button"
      onClick={() => onSelect(action)}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        restoring
          ? "text-muted-foreground hover:bg-muted hover:text-foreground"
          : "text-muted-foreground hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40 dark:hover:text-red-300",
      )}
      aria-label={`${restoring ? "Restore" : "Archive"} ${evaluationName}`}
      title={restoring ? "Restore evaluation" : "Archive evaluation"}
    >
      {restoring ? (
        <RotateCcw className="size-4" aria-hidden="true" />
      ) : (
        <Archive className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * Display name for one tray row. The user's own run label (Baseline /
 * Candidate A / …) always wins; `Run N` is shown only while that run_number is
 * unique across the selection — run_numbers collide across distinct
 * experiments attached to one comparison, and four rows all reading "Run 1"
 * identify nothing — otherwise the row falls back to its start time.
 */
export function trayRunName(run: RunResult, selection: RunResult[]): string {
  const label = runLabel(run).trim();
  if (label) return label;
  const runNumber = run.run_number;
  const unique =
    runNumber != null &&
    selection.filter((candidate) => candidate.run_number === runNumber).length === 1;
  if (unique) return `Run ${runNumber}`;
  return formatCompactTimestamp(run.started_at) ?? "Unknown start time";
}

export function ComparisonSelectionTray({
  runs,
  alignTo,
  onRemove,
  onBaseline,
  onClear,
  onCompare,
}: {
  runs: RunResult[];
  alignTo?: RefObject<HTMLElement | null>;
  onRemove: (runId: string) => void;
  onBaseline?: (runId: string) => void;
  onClear: () => void;
  onCompare: () => void;
}) {
  const ready = runs.length >= MIN_COMPARISON_RUNS;
  const candidateCount = Math.max(0, runs.length - 1);
  const [alignedBounds, setAlignedBounds] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    const anchor = alignTo?.current;
    if (!anchor) return;

    const updateBounds = () => {
      const rect = anchor.getBoundingClientRect();
      const viewportInset = 16;
      const left = Math.max(viewportInset, rect.left);
      const right = Math.min(window.innerWidth - viewportInset, rect.right);
      setAlignedBounds({ left, width: Math.max(0, right - left) });
    };

    updateBounds();
    const resizeObserver = new ResizeObserver(updateBounds);
    resizeObserver.observe(anchor);
    window.addEventListener("resize", updateBounds);
    document.addEventListener("transitionend", updateBounds);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateBounds);
      document.removeEventListener("transitionend", updateBounds);
    };
  }, [alignTo]);

  return (
    <div
      role="region"
      aria-label="Run comparison selection"
      aria-live="polite"
      className={cn(
        "fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-40 rounded-xl border bg-background/95 p-3 shadow-2xl backdrop-blur-md sm:p-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]",
        !alignedBounds && "inset-x-4 mx-auto w-[min(62rem,calc(100vw-2rem))]",
      )}
      style={alignedBounds ?? undefined}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex min-w-0 items-center gap-3 lg:w-52 lg:shrink-0">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
            <GitCompareArrows className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">
              {runs.length} run{runs.length === 1 ? "" : "s"} selected
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {ready
                ? `1 baseline · ${candidateCount} candidate${candidateCount === 1 ? "" : "s"}`
                : "Select at least one candidate"}
            </span>
          </span>
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 xl:grid-cols-4">
          {runs.map((run, index) => (
            <div key={run.run_id} className="flex min-w-0 items-center gap-1">
              {onBaseline ? <input type="radio" name="comparison-baseline" checked={index === 0} onChange={() => onBaseline(run.run_id)} aria-label={`Use ${trayRunName(run, runs)} as baseline`} className="size-4 shrink-0 accent-primary" /> : null}
            <button
              type="button"
              onClick={() => onRemove(run.run_id)}
              className="group inline-flex h-9 min-w-0 items-center gap-2 rounded-lg border bg-muted/25 px-2.5 text-left outline-none transition hover:border-foreground/25 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Remove ${index === 0 ? "baseline" : `candidate ${index}`} ${trayRunName(run, runs)}`}
              title="Remove from comparison"
            >
              <span className="min-w-0">
                <span className="block text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {index === 0 ? "Baseline" : `Candidate ${index}`}
                </span>
                <span className="block truncate text-xs font-medium">
                  {trayRunName(run, runs)}
                </span>
              </span>
              <X className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
            </button>
            </div>
          ))}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onCompare}
            disabled={!ready}
            title={ready ? `Compare ${runs.length} selected runs` : "Select at least one candidate"}
          >
            <GitCompareArrows className="mr-1.5 size-3.5" aria-hidden="true" />
            {ready ? `Compare ${runs.length} runs` : "Compare runs"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function EvaluationLifecycleDialog({
  action,
  group,
  busy,
  onCancel,
  onConfirm,
}: {
  action: EvaluationLifecycleAction;
  group: ExperimentRunGroup;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoring = action === "restore";

  return (
    <Dialog
      labelledBy="evaluation-lifecycle-title"
      describedBy="evaluation-lifecycle-description"
      onClose={busy ? () => undefined : onCancel}
      scrimLabel={`Cancel ${action} evaluation`}
      initialFocusRef={cancelRef}
      overlayClassName="z-[60]"
      scrimClassName="bg-black/45 backdrop-blur-[1px]"
      width="w-[min(28rem,calc(100vw-2rem))]"
      className="shrink-0 overflow-y-auto p-5 sm:p-6"
    >
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-foreground">
          {restoring ? (
            <RotateCcw className="size-4.5" aria-hidden="true" />
          ) : (
            <Archive className="size-4.5" aria-hidden="true" />
          )}
        </div>
        <h2 id="evaluation-lifecycle-title" className="mt-4 text-lg font-semibold tracking-tight">
          {restoring ? "Restore evaluation?" : "Archive evaluation?"}
        </h2>
        <p id="evaluation-lifecycle-description" className="mt-2 text-sm leading-6 text-muted-foreground">
          {restoring
            ? `“${group.name}” will return to Active evaluations with its ${group.runs.length} historical run${group.runs.length === 1 ? "" : "s"}.`
            : `“${group.name}” will be removed from Active evaluations. Its ${group.runs.length} historical run${group.runs.length === 1 ? "" : "s"}, reports, and evidence will remain available in Archived.`}
        </p>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn("w-full sm:w-auto", !restoring && "bg-red-700 text-white hover:bg-red-800")}
          >
            {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" /> : null}
            {restoring ? "Restore evaluation" : "Archive evaluation"}
          </Button>
        </div>
    </Dialog>
  );
}

export function StopRunDialog({
  run,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  run: RunResult;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      labelledBy="stop-run-title"
      describedBy="stop-run-description"
      onClose={busy ? () => undefined : onCancel}
      scrimLabel="Cancel stopping evaluation run"
      initialFocusRef={cancelRef}
      overlayClassName="z-[70]"
      scrimClassName="bg-black/45 backdrop-blur-[1px]"
      width="w-[min(28rem,calc(100vw-2rem))]"
      className="shrink-0 overflow-y-auto p-5 sm:p-6"
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300">
        <Square className="size-4.5" aria-hidden="true" />
      </div>
      <h2 id="stop-run-title" className="mt-4 text-lg font-semibold tracking-tight">
        Stop evaluation run?
      </h2>
      <p id="stop-run-description" className="mt-2 text-sm leading-6 text-muted-foreground">
        This stops the in-progress run and prevents incomplete results from being published. Evidence already emitted by the target may remain available for diagnostics.
      </p>
      <p className="mt-3 rounded-lg bg-muted/50 px-3 py-2">
        <CopyableId value={run.run_id} kind="run" valueClassName="text-muted-foreground" />
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>
      ) : null}
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button ref={cancelRef} type="button" variant="outline" onClick={onCancel} disabled={busy} className="w-full sm:w-auto">
          Keep running
        </Button>
        <Button type="button" onClick={onConfirm} disabled={busy} className="w-full bg-red-700 text-white hover:bg-red-800 sm:w-auto">
          {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" /> : <Square className="mr-1.5 size-3.5" aria-hidden="true" />}
          {busy ? "Stopping…" : "Stop run"}
        </Button>
      </div>
    </Dialog>
  );
}

export function ReportDrawer({
  run,
  group,
  onClose,
}: {
  run: RunResult;
  group: ExperimentRunGroup;
  onClose: () => void;
}) {
  const reportHref = `/runs/${encodeURIComponent(run.run_id)}`;
  const evaluateHref = evaluateHrefFromRun(run);
  const compareHref = comparisonHrefForRuns(
    latestComparableRuns(group).slice(0, MAX_COMPARISON_RUNS),
  );
  const titleRef = useRef<HTMLHeadingElement>(null);
  const typeLabel = runScenarioTypeLabel(run);
  const score = formatRunScore(run);

  return (
    <Dialog
      variant="drawer"
      as="aside"
      labelledBy="run-report-drawer-title"
      onClose={onClose}
      scrimLabel="Close run report"
      initialFocusRef={titleRef}
      scrimClassName="bg-black/40"
      width="sm:w-[88vw] lg:w-[72vw] xl:w-[960px]"
      className="pb-[env(safe-area-inset-bottom)] pr-[env(safe-area-inset-right)]"
    >
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Run report
            </p>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <h2
                ref={titleRef}
                id="run-report-drawer-title"
                tabIndex={-1}
                className="truncate text-base font-semibold outline-none"
              >
                {evaluationName(run)}
              </h2>
              <RunOutcomeBadge run={run} />
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {run.run_number != null ? `Run ${run.run_number}` : "Evaluation run"}
              <span aria-hidden="true"> · </span>
              {typeLabel}
              <span aria-hidden="true"> · </span>
              KPI composite {score}
              {runLabel(run) ? (
                <>
                  <span aria-hidden="true"> · </span>
                  Label {runLabel(run)}
                </>
              ) : null}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {compareHref ? (
              <Link href={compareHref} className={buttonVariants({ size: "sm" })}>
                <GitCompareArrows className="mr-1.5 size-3.5 shrink-0" aria-hidden="true" />
                Compare runs
              </Link>
            ) : null}
            {tracesHrefForRun(run) ? <Link href={tracesHrefForRun(run)!} className={buttonVariants({variant: "outline", size: "sm"})}>View traces</Link> : null}
            <Link href={reportHref} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Full report
              <ExternalLink className="ml-1.5 size-3.5 shrink-0" aria-hidden="true" />
            </Link>
            <Link
              href={evaluateHref}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Pencil className="mr-1.5 size-3.5" aria-hidden="true" />
              Run evaluation
            </Link>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close run report"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/10 p-3 sm:p-5">
          <ReportView run={run} embedded />
        </div>
    </Dialog>
  );
}
