// Client for the F9 server-paginated run-history endpoint
// (`GET /evaluation/run-history`). The legacy `evaluationApi.listRuns()` returns
// the full list; this endpoint pages large histories with cursor/limit/offset/
// total/search/sort so the UI can page via the server and annotate truncation
// honestly ("Showing N of M").
//
// It lives here rather than in `lib/api.ts` (which this slice must not modify)
// but talks to the same BFF proxy with the same error handling.

import { sessionAwareFetch } from "@evalai/shared/session";
import { ApiError, apiErrorFromResponse } from "@/lib/api-errors";
import type { RunResult } from "@/lib/api";

const BASE = "/api/proofgrove";

/** Server-paginated run-history envelope (mirrors backend `PaginatedRuns`). */
export interface PaginatedRuns {
  items: RunResult[];
  /** Full, unpaged match count. */
  total: number;
  limit: number;
  offset: number;
  /** Opaque offset of the next page, or `null` on the last page. */
  next_cursor: string | null;
}

export interface RunHistoryParams {
  limit?: number;
  offset?: number;
  cursor?: string;
  search?: string;
  sort?: "started_at" | "completed_at" | "duration_ms" | "run_number";
  order?: "asc" | "desc";
  /** Required: the F9 run-history endpoint 422s without a tenant. */
  tenant_id: string;
}

export function runHistoryQuery(params: RunHistoryParams): string {
  const query = new URLSearchParams();
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.offset != null) query.set("offset", String(params.offset));
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.search) query.set("search", params.search);
  if (params.sort) query.set("sort", params.sort);
  if (params.order) query.set("order", params.order);
  if (params.tenant_id) query.set("tenant_id", params.tenant_id);
  return query.toString();
}

async function request<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await sessionAwareFetch(`${BASE}${path}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "Unable to reach Proofgrove. Check your connection and try again.",
    });
  }
  if (!res.ok) {
    throw apiErrorFromResponse(res.status, await res.text());
  }
  if (res.status === 204) return {} as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError({
      status: 502,
      code: "INVALID_RESPONSE",
      message: "Proofgrove returned an invalid response. Try again shortly.",
    });
  }
}

export const runHistoryApi = {
  list: (params: RunHistoryParams): Promise<PaginatedRuns> => {
    const qs = runHistoryQuery(params);
    return request<PaginatedRuns>(`/evaluation/run-history${qs ? `?${qs}` : ""}`);
  },
};

/** Honest truncation annotation, or `null` when nothing is hidden. */
export function runHistoryTruncationLabel(loaded: number, total: number): string | null {
  if (total > loaded) return `Showing ${loaded} of ${total} runs`;
  return null;
}

export type RunHistoryPageResult = {
  items: RunResult[];
  total: number;
  loaded: number;
  hasMore: boolean;
  nextCursor: string | null;
  truncationLabel: string | null;
};

/**
 * Consume a single server page through an injected F9 client (`runHistoryApi.list`
 * in production, a mock in tests) and shape it for the UI, including the honest
 * "N of M" truncation annotation.
 */
/** Largest page the run-history endpoint accepts (`limit` is capped at 200). */
export const RUN_HISTORY_MAX_PAGE_SIZE = 200;
/** Ceiling on pages a sweep consumes, so one tenant can never hang the UI. */
export const RUN_HISTORY_SWEEP_MAX_PAGES = 10;

export type RunHistorySweep = {
  /** Distinct runs, newest first — a run repeated across pages appears once. */
  runs: RunResult[];
  /** Full, unpaged match count reported by the server. */
  total: number;
  /** How many *distinct* runs the sweep actually read. */
  scanned: number;
  /** True when every matching run was read; false when the page cap stopped it. */
  complete: boolean;
};

/**
 * Read the whole run population through the paginated endpoint, newest first.
 * Callers that must reason over every run (governance queues) use this instead
 * of the legacy `listRuns()` list, whose store applies a silent limit of 50.
 * When the page cap stops the sweep early the result says so — `complete` is
 * false and `scanned` < `total` — so the caller can mark its view as partial
 * rather than presenting a truncated population as the whole.
 */
export async function sweepRunHistory(
  fetcher: (params: RunHistoryParams) => Promise<PaginatedRuns>,
  params: RunHistoryParams,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<RunHistorySweep> {
  const pageSize = Math.min(opts.pageSize ?? RUN_HISTORY_MAX_PAGE_SIZE, RUN_HISTORY_MAX_PAGE_SIZE);
  const maxPages = opts.maxPages ?? RUN_HISTORY_SWEEP_MAX_PAGES;
  const runs: RunResult[] = [];
  // Coverage is counted in distinct run ids. A server that ignores `offset`
  // returns the same page repeatedly; counting raw items would inflate
  // `scanned` past `total` and report full coverage of a truncated read.
  const seenRunIds = new Set<string>();
  let total = 0;
  let offset = 0;
  for (let read = 0; read < maxPages; read += 1) {
    const pageData = await fetcher({ ...params, limit: pageSize, offset });
    total = pageData.total;
    // A server that returns an empty page while claiming more would loop for
    // ever; stop, and let the coverage check below report the shortfall.
    if (pageData.items.length === 0) break;
    for (const run of pageData.items) {
      if (seenRunIds.has(run.run_id)) continue;
      seenRunIds.add(run.run_id);
      runs.push(run);
    }
    // Paging still advances by what the server sent, so a page of duplicates
    // cannot wedge the cursor.
    offset += pageData.items.length;
    if (pageData.next_cursor == null || offset >= pageData.total) break;
  }
  return { runs, total, scanned: runs.length, complete: runs.length >= total };
}

export async function loadRunHistoryPage(
  fetcher: (params: RunHistoryParams) => Promise<PaginatedRuns>,
  params: RunHistoryParams,
): Promise<RunHistoryPageResult> {
  const pageData = await fetcher(params);
  const loaded = pageData.items.length;
  // `loaded` is only this page; compare against the position reached in the full
  // set (offset + loaded) so the final page never falsely reports more.
  const consumed = pageData.offset + loaded;
  return {
    items: pageData.items,
    total: pageData.total,
    loaded,
    hasMore: pageData.next_cursor != null || consumed < pageData.total,
    nextCursor: pageData.next_cursor,
    truncationLabel: runHistoryTruncationLabel(loaded, pageData.total),
  };
}
