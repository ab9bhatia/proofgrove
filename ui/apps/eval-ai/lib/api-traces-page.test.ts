import { afterEach, describe, expect, it, vi } from "vitest";

const sessionAwareFetch = vi.fn();
vi.mock("@evalai/shared/session", () => ({ sessionAwareFetch: (...args: unknown[]) => sessionAwareFetch(...args) }));

import { api, type CapturedTracesPage } from "@/lib/api";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  } as unknown as Response;
}

const envelope: CapturedTracesPage = {
  items: [],
  next_cursor: "cursor-2",
  has_more: true,
  total: 42,
  hidden_count: 3,
};

afterEach(() => {
  sessionAwareFetch.mockReset();
});

describe("api.listProjectTracesPage", () => {
  it("calls the keyset /traces/page endpoint with tenant + limit and returns the envelope", async () => {
    sessionAwareFetch.mockResolvedValueOnce(jsonResponse(envelope));

    const result = await api.listProjectTracesPage("proj-1", "tenant-a", { limit: 25 });

    const url = sessionAwareFetch.mock.calls[0][0] as string;
    const parsed = new URL(url, "http://x");
    expect(parsed.pathname).toBe("/api/eval-hub/tracing/projects/proj-1/traces/page");
    expect(parsed.searchParams.get("tenant_id")).toBe("tenant-a");
    expect(parsed.searchParams.get("limit")).toBe("25");
    expect(parsed.searchParams.has("cursor")).toBe(false);
    expect(result).toEqual(envelope);
  });

  it("passes the keyset cursor when advancing a page", async () => {
    sessionAwareFetch.mockResolvedValueOnce(jsonResponse({ ...envelope, next_cursor: null, has_more: false }));

    await api.listProjectTracesPage("proj-1", "tenant-a", { limit: 25, cursor: "cursor-2" });

    const url = sessionAwareFetch.mock.calls[0][0] as string;
    const parsed = new URL(url, "http://x");
    expect(parsed.searchParams.get("cursor")).toBe("cursor-2");
  });

  it("passes search/status/since/until filters and omits empties", async () => {
    sessionAwareFetch.mockResolvedValueOnce(jsonResponse(envelope));
    await api.listProjectTracesPage("proj-1", "tenant-a", {
      search: "  fraud  ",
      runId: "  run-123  ",
      status: "error",
      since: "2026-08-22T00:00:00Z",
    });
    const url = sessionAwareFetch.mock.calls[0][0] as string;
    const parsed = new URL(url, "http://x");
    expect(parsed.searchParams.get("search")).toBe("fraud");
    expect(parsed.searchParams.get("run_id")).toBe("run-123");
    expect(parsed.searchParams.get("status")).toBe("error");
    expect(parsed.searchParams.get("since")).toBe("2026-08-22T00:00:00Z");
    expect(parsed.searchParams.has("until")).toBe(false);
  });

  it("encodes the project id", async () => {
    sessionAwareFetch.mockResolvedValueOnce(jsonResponse(envelope));
    await api.listProjectTracesPage("proj/with space", "tenant-a");
    const url = sessionAwareFetch.mock.calls[0][0] as string;
    expect(url).toContain("/tracing/projects/proj%2Fwith%20space/traces/page");
  });

  it("requests hidden rows and posts reversible visibility changes", async () => {
    sessionAwareFetch
      .mockResolvedValueOnce(jsonResponse(envelope))
      .mockResolvedValueOnce(jsonResponse({ trace_id: "trace/1", hidden: true }))
      .mockResolvedValueOnce(jsonResponse({ trace_id: "trace/1", hidden: false }));

    await api.listProjectTracesPage("proj-1", "tenant-a", { includeHidden: true });
    expect(new URL(sessionAwareFetch.mock.calls[0][0], "http://x").searchParams.get("include_hidden"))
      .toBe("true");
    await api.hideProjectTrace("proj-1", "trace/1", "tenant-a");
    await api.unhideProjectTrace("proj-1", "trace/1", "tenant-a");
    expect(sessionAwareFetch.mock.calls[1][0]).toContain("/traces/trace%2F1/hide?");
    expect(sessionAwareFetch.mock.calls[2][0]).toContain("/traces/trace%2F1/unhide?");
  });
});
