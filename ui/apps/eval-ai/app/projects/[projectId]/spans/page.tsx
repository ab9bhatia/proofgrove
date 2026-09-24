"use client";

import { useParams, useSearchParams } from "next/navigation";
import { LONG_LIST_PER_PAGE } from "@/lib/pagination";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "@/components/page-state";
import { FilterSelect, SearchField, Toolbar } from "@/components/toolbar";
import { EvaluationRunGroups, GroupingSelect, useTracingGrouping } from "@/components/tracing/evaluation-run-groups";
import { TraceDrawer } from "@/components/tracing/trace-drawer";
import { SpanScoring } from "@/components/tracing/span-scoring";
import { SpanTable } from "@/components/tracing/span-table";
import {
  appendSpansPage,
  spanRowKey,
  canLoadMoreSpans,
  emptySpansPageState,
  readTraceSelection,
  spansCountLabel,
  writeTraceSelection,
  type SpansPageState,
  type TraceSelection,
} from "@/components/tracing/trace-workspace";
import { api } from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import { WINDOW_OPTIONS, sinceForWindow, type WindowValue } from "../traces/page";

const PAGE_SIZE = LONG_LIST_PER_PAGE;

/** Archived OTLP span statuses, as served by the span index. */
const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "ok", label: "OK" },
  { value: "error", label: "Error" },
  { value: "unset", label: "Unset" },
] as const;

export type SpanFilters = {
  search: string;
  status: "" | "ok" | "error" | "unset";
  window: WindowValue;
};

export function readSpanFilters(params: { get(key: string): string | null }): SpanFilters {
  const status = params.get("status");
  const window = params.get("window");
  return {
    search: params.get("search") ?? "",
    status: status === "ok" || status === "error" || status === "unset" ? status : "",
    window: window === "1h" || window === "24h" || window === "7d" ? window : "",
  };
}

export function writeSpanFilters(current: string, filters: SpanFilters): string {
  const params = new URLSearchParams(current);
  for (const [key, value] of [
    ["search", filters.search.trim()],
    ["status", filters.status],
    ["window", filters.window],
  ] as const) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  return params.toString();
}

export default function ProjectSpansPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading captured spans…" />}>
      <ProjectSpans />
    </Suspense>
  );
}

// Same conventions as the Traces tab: debounced search, immediate selects,
// URL-persisted filters via replaceState, keyset cursor paging with an honest
// "showing N of M" count, and stale-response guarding on filter changes.
function ProjectSpans() {
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const projectId = decodeURIComponent(params.projectId);
  const [filters, setFilters] = useState<SpanFilters>(() => readSpanFilters(searchParams));
  const [selection, setSelection] = useState<TraceSelection>(() => readTraceSelection(searchParams));
  const [appliedSearch, setAppliedSearch] = useState(filters.search);
  // Transport and framework plumbing are excluded server-side, by the endpoint
  // and its count together, so everything fetched is listed and the total is
  // the total. Filtering here instead once answered "1,595 spans" with an empty
  // table, because a page of results could be entirely plumbing.
  const [state, setState] = useState<SpansPageState>(emptySpansPageState);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const selectedSpans = state.items.filter((span) => selectedKeys.has(spanRowKey(span)));
  const [sort, setSort] = useState("newest");
  const [grouping, setGrouping] = useTracingGrouping();
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedSearch(filters.search), 300);
    return () => window.clearTimeout(timer);
  }, [filters.search]);

  const queryOptions = useMemo(
    () => ({
      limit: PAGE_SIZE,
      search: appliedSearch.trim() || undefined,
      status: filters.status || undefined,
      since: sinceForWindow(filters.window),
    }),
    [appliedSearch, filters.status, filters.window],
  );

  const changeFilters = useCallback((next: Partial<SpanFilters>) => {
    setSelectedKeys(new Set());
    setFilters((current) => {
      const merged = { ...current, ...next };
      const query = writeSpanFilters(window.location.search, merged);
      window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
      return merged;
    });
  }, []);

  const applySelection = useCallback((next: TraceSelection) => {
    setSelection(next);
    const query = writeTraceSelection(window.location.search, next);
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  }, []);

  const loadFirst = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      const page = await api.listProjectSpansPage(projectId, tenantId, queryOptions);
      if (seq !== requestSeq.current) return;
      setState((prev) => appendSpansPage(prev, page, true));
    } catch (reason) {
      if (seq !== requestSeq.current) return;
      setError(userFacingError(reason, "Unable to load archived spans"));
      setState(emptySpansPageState());
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [projectId, queryOptions]);

  const loadMore = useCallback(async () => {
    if (!canLoadMoreSpans(state) || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    setError(null);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      const page = await api.listProjectSpansPage(projectId, tenantId, {
        ...queryOptions,
        cursor: state.nextCursor,
      });
      if (seq !== requestSeq.current) return;
      setState((prev) => appendSpansPage(prev, page));
    } catch (reason) {
      if (seq !== requestSeq.current) return;
      setError(userFacingError(reason, "Unable to load more archived spans"));
    } finally {
      setLoadingMore(false);
    }
  }, [projectId, state, loadingMore, queryOptions]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadFirst(), 0);
    return () => window.clearTimeout(timer);
  }, [loadFirst]);

  const hasFilters = Boolean(queryOptions.search || queryOptions.status || queryOptions.since);

  return (
    <div>
      <Toolbar>
        <SearchField
          name="span-search"
          value={filters.search}
          onChange={(event) => changeFilters({ search: event.target.value })}
          placeholder="Search span name or trace…"
          label="Search captured spans"
        />
        <FilterSelect
          value={filters.status}
          onChange={(event) => changeFilters({ status: event.target.value as SpanFilters["status"] })}
          label="Filter by span status"
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </FilterSelect>
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
        <button type="button" className="min-h-11 rounded-lg border px-3 text-sm disabled:opacity-50" disabled={loading || !state.items.length} onClick={() => setSelectedKeys(new Set(state.items.slice(0, 100).map(spanRowKey)))}>Select {Math.min(state.items.length, 100)} loaded spans</button>
        <SpanScoring toolbar projectId={projectId} selections={selectedSpans.map((span) => ({ trace_id: span.trace_id, span_id: span.span_id }))} />
        {selectedSpans.length ? <button type="button" className="min-h-11 px-3 text-sm underline" onClick={() => setSelectedKeys(new Set())}>Clear {selectedSpans.length} selected</button> : null}
      </Toolbar>

      {loading ? (
        <LoadingState label="Loading captured spans…" />
      ) : error && state.items.length === 0 ? (
        <ErrorState message={error} onRetry={() => void loadFirst()} />
      ) : state.items.length === 0 ? (
        <div><EmptyState
          title={hasFilters ? "No spans match these filters" : "No spans indexed yet"}
          description={
            hasFilters
              ? "The filters were applied across the full span index. Clear them to see every classified span."
              : "No model, agent, tool or retrieval spans are indexed for this project yet. Transport and framework spans are never listed here. Spans appear once traces are exported and archived — nothing is fabricated in the meantime."
          }
        />
          {hasFilters ? <button type="button" className="mt-3 min-h-11 rounded-lg border px-4 text-sm text-brand-text focus-visible:ring-2 focus-visible:ring-ring" onClick={() => changeFilters({ search: "", status: "", window: "" })}>Clear filters</button> : null}
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
              {spansCountLabel(state.items.length, state.total)}
            </p>
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={!canLoadMoreSpans(state) || loadingMore}
              className="inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loadingMore ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {canLoadMoreSpans(state) ? "Load more" : "All spans loaded"}
            </button>
          </div>
          <EvaluationRunGroups
            grouping={grouping}
            items={state.items}
            itemNoun="span"
            renderItems={(spans) => (
              <SpanTable
                spans={spans}
                selectedKeys={selectedKeys}
                onToggleSelection={(span) => setSelectedKeys((current) => {
                  const next = new Set(current);
                  const key = spanRowKey(span);
                  if (next.has(key)) next.delete(key);
                  else if (next.size < 100) next.add(key);
                  return next;
                })}
                sort={sort}
                onSort={setSort}
                projectId={projectId}
                currentQuery={typeof window === "undefined" ? "" : window.location.search}
                onOpenSpan={(span) => applySelection({ trace: span.trace_id, span: span.span_id })}
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
