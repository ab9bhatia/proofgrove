import { describe, expect, it, vi } from "vitest";

import type { RunResult } from "@/lib/api";
import type { PaginatedRuns } from "@/lib/run-history";
import {
  loadRunHistoryPage,
  runHistoryQuery,
  runHistoryTruncationLabel,
  sweepRunHistory,
  RUN_HISTORY_MAX_PAGE_SIZE,
} from "@/lib/run-history";

function page(overrides: Partial<PaginatedRuns> = {}): PaginatedRuns {
  return {
    items: [],
    total: 0,
    limit: 50,
    offset: 0,
    next_cursor: null,
    ...overrides,
  };
}

function fakeRun(runId: string): RunResult {
  return { run_id: runId } as RunResult;
}

describe("runHistoryQuery", () => {
  it("builds a cursor/limit/search/sort query for the F9 endpoint", () => {
    const qs = runHistoryQuery({ limit: 25, offset: 50, search: "agent", sort: "started_at", order: "desc", tenant_id: "t1" });
    const params = new URLSearchParams(qs);
    expect(params.get("limit")).toBe("25");
    expect(params.get("offset")).toBe("50");
    expect(params.get("search")).toBe("agent");
    expect(params.get("sort")).toBe("started_at");
    expect(params.get("order")).toBe("desc");
    expect(params.get("tenant_id")).toBe("t1");
  });
});

describe("runHistoryTruncationLabel", () => {
  it("annotates truncation honestly when more rows exist server-side", () => {
    expect(runHistoryTruncationLabel(50, 213)).toBe("Showing 50 of 213 runs");
  });

  it("returns null when everything is loaded (nothing hidden)", () => {
    expect(runHistoryTruncationLabel(12, 12)).toBeNull();
    expect(runHistoryTruncationLabel(12, 8)).toBeNull();
  });
});

describe("loadRunHistoryPage", () => {
  it("consumes a server page from the F9 client and reports an honest N of M", async () => {
    const fetcher = vi.fn(async () =>
      page({
        items: [fakeRun("r1"), fakeRun("r2")],
        total: 40,
        limit: 2,
        offset: 0,
        next_cursor: "2",
      }),
    );

    const result = await loadRunHistoryPage(fetcher, { limit: 2, tenant_id: "t1" });

    expect(fetcher).toHaveBeenCalledWith({ limit: 2, tenant_id: "t1" });
    expect(result.items.map((r) => r.run_id)).toEqual(["r1", "r2"]);
    expect(result.total).toBe(40);
    expect(result.loaded).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("2");
    expect(result.truncationLabel).toBe("Showing 2 of 40 runs");
  });

  it("reports no truncation when the page holds every matching run", async () => {
    const fetcher = vi.fn(async () => page({ items: [fakeRun("only")], total: 1 }));
    const result = await loadRunHistoryPage(fetcher, { tenant_id: "t1" });
    expect(result.hasMore).toBe(false);
    expect(result.truncationLabel).toBeNull();
  });
});

describe("sweepRunHistory", () => {
  function pagedFetcher(total: number) {
    return vi.fn(async ({ limit = 200, offset = 0 }: { limit?: number; offset?: number }) => {
      const items = Array.from(
        { length: Math.max(0, Math.min(limit, total - offset)) },
        (_, index) => fakeRun(`r${offset + index}`),
      );
      const next = offset + items.length;
      return page({ items, total, limit, offset, next_cursor: next < total ? String(next) : null });
    });
  }

  it("reads every run past the legacy 50-row limit", async () => {
    // The legacy listRuns store stops at 50; a governance queue must see all 132.
    const fetcher = pagedFetcher(132);
    const sweep = await sweepRunHistory(fetcher, { tenant_id: "t1" }, { pageSize: 50 });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenNthCalledWith(1, { tenant_id: "t1", limit: 50, offset: 0 });
    expect(fetcher).toHaveBeenNthCalledWith(3, { tenant_id: "t1", limit: 50, offset: 100 });
    expect(sweep.runs).toHaveLength(132);
    expect(sweep.scanned).toBe(132);
    expect(sweep.total).toBe(132);
    expect(sweep.complete).toBe(true);
  });

  it("stops at the page cap and reports the population as partial", async () => {
    const sweep = await sweepRunHistory(
      pagedFetcher(500),
      { tenant_id: "t1" },
      { pageSize: 50, maxPages: 2 },
    );

    expect(sweep.scanned).toBe(100);
    expect(sweep.total).toBe(500);
    expect(sweep.complete).toBe(false);
  });

  it("never loops on an empty page that still claims more rows", async () => {
    const fetcher = vi.fn(async () => page({ items: [], total: 40, next_cursor: "0" }));
    const sweep = await sweepRunHistory(fetcher, { tenant_id: "t1" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sweep.scanned).toBe(0);
    expect(sweep.complete).toBe(false);
  });

  it("counts distinct runs when a server ignores offset", async () => {
    // Every page repeats rows 0-49 of 500. Counting raw items would reach
    // scanned=100 >= total for a 60-run tenant and claim full coverage.
    const fetcher = vi.fn(async ({ limit = 50 }: { limit?: number }) =>
      page({
        items: Array.from({ length: limit }, (_, index) => fakeRun(`r${index}`)),
        total: 500,
        limit,
        offset: 0,
        next_cursor: "50",
      }),
    );

    const sweep = await sweepRunHistory(fetcher, { tenant_id: "t1" }, { pageSize: 50, maxPages: 4 });

    expect(sweep.runs).toHaveLength(50);
    expect(sweep.scanned).toBe(50);
    expect(sweep.complete).toBe(false);
    expect(sweep.runs.map((run) => run.run_id)).toEqual(
      [...new Set(sweep.runs.map((run) => run.run_id))],
    );
  });

  it("does not report full coverage from a duplicated truncated read", async () => {
    const fetcher = vi.fn(async ({ limit = 30 }: { limit?: number }) =>
      page({
        items: Array.from({ length: limit }, (_, index) => fakeRun(`r${index}`)),
        total: 60,
        limit,
        offset: 0,
        next_cursor: "30",
      }),
    );

    const sweep = await sweepRunHistory(fetcher, { tenant_id: "t1" }, { pageSize: 30, maxPages: 3 });

    expect(sweep.scanned).toBe(30);
    expect(sweep.total).toBe(60);
    expect(sweep.complete).toBe(false);
  });

  it("caps the requested page size at the endpoint maximum", async () => {
    const fetcher = pagedFetcher(1);
    await sweepRunHistory(fetcher, { tenant_id: "t1" }, { pageSize: 5000 });
    expect(fetcher).toHaveBeenCalledWith({
      tenant_id: "t1",
      limit: RUN_HISTORY_MAX_PAGE_SIZE,
      offset: 0,
    });
  });
});
