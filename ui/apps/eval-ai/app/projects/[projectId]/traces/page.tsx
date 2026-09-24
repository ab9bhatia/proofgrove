"use client";

import { useParams, useSearchParams } from "next/navigation";
import { LONG_LIST_PER_PAGE } from "@/lib/pagination";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "@evalai/shared/ui/sonner";
import { EmptyState, ErrorState, LoadingState } from "@/components/page-state";
import { FilterSelect, SearchField, Toolbar } from "@/components/toolbar";
import { EvaluationRunGroups, GroupingSelect, useTracingGrouping } from "@/components/tracing/evaluation-run-groups";
import { TraceDrawer } from "@/components/tracing/trace-drawer";
import { TraceTable } from "@/components/tracing/trace-table";
import {
  appendTracesPage,
  canLoadMoreTraces,
  emptyTracesPageState,
  readTraceSelection,
  tracesCountLabel,
  writeTraceSelection,
  type TraceSelection,
  type TracesPageState,
} from "@/components/tracing/trace-workspace";
import { api, type CapturedTraceSummary, type TraceInvocationOutcome } from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";

const PAGE_SIZE = LONG_LIST_PER_PAGE;

const STATUS_OPTIONS: Array<{ value: "" | TraceInvocationOutcome; label: string }> = [
  { value: "", label: "Any outcome" },
  { value: "succeeded", label: "Succeeded" },
  { value: "error", label: "Error" },
  { value: "unknown", label: "Unknown" },
];

/** Time-window presets mapped to a `since` bound at request time. Shared with
 * the Spans tab so both toolbars speak the same time-range language. */
export const WINDOW_OPTIONS = [
  { value: "", label: "All time" },
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
] as const;
export type WindowValue = (typeof WINDOW_OPTIONS)[number]["value"];

const WINDOW_MS: Record<Exclude<WindowValue, "">, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export function sinceForWindow(window: WindowValue, now: Date = new Date()): string | undefined {
  if (!window) return undefined;
  return new Date(now.getTime() - WINDOW_MS[window]).toISOString();
}

export type TraceFilters = {
  search: string;
  runId: string;
  status: "" | TraceInvocationOutcome;
  window: WindowValue;
};

/** Run links and pasted run UUIDs keep the existing exact-run query contract. */
export function traceSearchFilters(value: string): Pick<TraceFilters, "search" | "runId"> {
  const isRunId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
  return isRunId ? { search: "", runId: value.trim() } : { search: value, runId: "" };
}

export function readTraceFilters(params: { get(key: string): string | null }): TraceFilters {
  const status = params.get("status");
  const window = params.get("window");
  return {
    search: params.get("search") ?? "",
    runId: params.get("run_id") ?? "",
    status: status === "succeeded" || status === "error" || status === "unknown" ? status : "",
    window: window === "1h" || window === "24h" || window === "7d" ? window : "",
  };
}

export function writeTraceFilters(current: string, filters: TraceFilters): string {
  const params = new URLSearchParams(current);
  for (const [key, value] of [
    ["search", filters.search.trim()],
    ["run_id", filters.runId.trim()],
    ["status", filters.status],
    ["window", filters.window],
  ] as const) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  return params.toString();
}

export default function ProjectTracesPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading captured traces…" />}>
      <ProjectTraces />
    </Suspense>
  );
}

function ProjectTraces() {
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const searchParamsKey = searchParams.toString();
  const projectId = decodeURIComponent(params.projectId);
  const [filters, setFilters] = useState<TraceFilters>(() => readTraceFilters(searchParams));
  // Master-detail drawer selection, restored from ?trace=&span= on reload. The
  // list stays mounted (and keeps its scroll position) while the drawer is
  // open; replaceState keeps the URL shareable without history spam.
  const [selection, setSelection] = useState<TraceSelection>(() => readTraceSelection(searchParams));
  // Debounce text filters; selects apply immediately.
  const [appliedSearch, setAppliedSearch] = useState(filters.search);
  const [appliedRunId, setAppliedRunId] = useState(filters.runId);
  const [state, setState] = useState<TracesPageState>(emptyTracesPageState);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sort, setSort] = useState("newest");
  const [grouping, setGrouping] = useTracingGrouping();
  const [showHidden, setShowHidden] = useState(false);
  const [visibilityBusyId, setVisibilityBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  // Next can preserve this client component when navigating between two URLs
  // for the same Tracing route. Re-read URL filters in that case so an
  // Evaluation "Traces" link replaces any previous workspace search with its
  // exact run_id instead of leaving stale results mounted.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = readTraceFilters(new URLSearchParams(searchParamsKey));
      setFilters((current) =>
        current.search === next.search &&
        current.runId === next.runId &&
        current.status === next.status &&
        current.window === next.window
          ? current
          : next,
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [searchParamsKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAppliedSearch(filters.search);
      setAppliedRunId(filters.runId);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [filters.runId, filters.search]);

  const queryOptions = useMemo(
    () => ({
      limit: PAGE_SIZE,
      search: appliedSearch.trim() || undefined,
      runId: appliedRunId.trim() || undefined,
      status: filters.status || undefined,
      since: sinceForWindow(filters.window),
      includeHidden: showHidden,
    }),
    [appliedRunId, appliedSearch, filters.status, filters.window, showHidden],
  );

  const changeFilters = useCallback(
    (next: Partial<TraceFilters>) => {
      setFilters((current) => {
        const merged = { ...current, ...next };
        const query = writeTraceFilters(window.location.search, merged);
        window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
        return merged;
      });
    },
    [],
  );

  const applySelection = useCallback((next: TraceSelection) => {
    setSelection(next);
    const query = writeTraceSelection(window.location.search, next);
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  }, []);

  // Any filter change restarts from the first page; a stale in-flight response
  // must never overwrite a newer filter's results.
  const loadFirst = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      const page = await api.listProjectTracesPage(projectId, tenantId, queryOptions);
      if (seq !== requestSeq.current) return;
      setState((prev) => appendTracesPage(prev, page, true));
    } catch (reason) {
      if (seq !== requestSeq.current) return;
      setError(userFacingError(reason, "Unable to load captured traces"));
      setState(emptyTracesPageState());
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [projectId, queryOptions]);

  const loadMore = useCallback(async () => {
    if (!canLoadMoreTraces(state) || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    setError(null);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      const page = await api.listProjectTracesPage(projectId, tenantId, {
        ...queryOptions,
        cursor: state.nextCursor,
      });
      if (seq !== requestSeq.current) return;
      setState((prev) => appendTracesPage(prev, page));
    } catch (reason) {
      if (seq !== requestSeq.current) return;
      setError(userFacingError(reason, "Unable to load more captured traces"));
    } finally {
      setLoadingMore(false);
    }
  }, [projectId, state, loadingMore, queryOptions]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadFirst(), 0);
    return () => window.clearTimeout(timer);
  }, [loadFirst]);

  const toggleHidden = useCallback(async (trace: CapturedTraceSummary) => {
    setVisibilityBusyId(trace.trace_id);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      if (trace.hidden) {
        await api.unhideProjectTrace(projectId, trace.trace_id, tenantId);
      } else {
        await api.hideProjectTrace(projectId, trace.trace_id, tenantId);
      }
      await loadFirst();
    } catch (reason) {
      toast.error(trace.hidden ? "Could not unhide trace" : "Could not hide trace", {
        description: userFacingError(reason, "Try again."),
      });
    } finally {
      setVisibilityBusyId(null);
    }
  }, [loadFirst, projectId]);

  const hasFilters = Boolean(queryOptions.search || queryOptions.runId || queryOptions.status || queryOptions.since);

  return (
    <div>
      <Toolbar>
        <SearchField
          name="trace-search"
          value={filters.runId || filters.search}
          onChange={(event) => changeFilters(traceSearchFilters(event.target.value))}
          placeholder="Search traces, evaluations, cases, or paste a run ID…"
          label="Search captured traces"
        />
        <FilterSelect
          value={filters.status}
          onChange={(event) => changeFilters({ status: event.target.value as TraceFilters["status"] })}
          label="Filter by invocation outcome"
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </FilterSelect>
        {state.hiddenCount > 0 || showHidden ? (
          <button
            type="button"
            aria-pressed={showHidden}
            onClick={() => setShowHidden((current) => !current)}
            className="inline-flex min-h-11 items-center rounded-lg border border-input px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {showHidden ? "Hide hidden" : `${state.hiddenCount} hidden`}
          </button>
        ) : null}
        <FilterSelect
          value={filters.window}
          onChange={(event) => changeFilters({ window: event.target.value as WindowValue })}
          label="Filter by time range"
        >
          {WINDOW_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </FilterSelect>
        <GroupingSelect value={grouping} onChange={setGrouping} />
      </Toolbar>

      {loading ? (
        <LoadingState label="Loading captured traces…" />
      ) : error && state.items.length === 0 ? (
        <ErrorState message={error} onRetry={() => void loadFirst()} />
      ) : state.items.length === 0 ? (
        <div><EmptyState
          title={hasFilters ? "No traces match these filters" : "No trace IDs recorded"}
          description={
            hasFilters
              ? "The filters were applied across the full captured history. Clear them to see every trace."
              : "Cases without a genuine persisted trace ID remain available under Evaluations and their case inspector."
          }
        />{hasFilters ? <button type="button" className="mt-3 min-h-11 rounded-lg border px-4 text-sm text-brand-text focus-visible:ring-2 focus-visible:ring-ring" onClick={() => changeFilters({search: "", runId: "", status: "", window: ""})}>Clear filters</button> : null}</div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
              {tracesCountLabel(state.items.length, state.total)}
            </p>
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={!canLoadMoreTraces(state) || loadingMore}
              className="inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingMore ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {canLoadMoreTraces(state) ? "Load more" : "All traces loaded"}
            </button>
          </div>
          <EvaluationRunGroups
            grouping={grouping}
            items={state.items}
            itemNoun="trace"
            renderItems={(traces) => (
              <TraceTable
                traces={traces}
                sort={sort}
                onSort={setSort}
                projectId={projectId}
                onOpenTrace={(trace) => applySelection({ trace: trace.trace_id, span: null })}
                onToggleHidden={(trace) => void toggleHidden(trace)}
                visibilityBusyId={visibilityBusyId}
              />
            )}
          />
          {error ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}

      {selection.trace ? (
        <TraceDrawer
          projectId={projectId}
          traceId={selection.trace}
          selectedSpanId={selection.span}
          currentQuery={typeof window === "undefined" ? "" : window.location.search}
          onSelectSpan={(query) => {
            window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
            setSelection(readTraceSelection(new URLSearchParams(query)));
          }}
          onClose={() => applySelection({ trace: null, span: null })}
        />
      ) : null}
    </div>
  );
}
