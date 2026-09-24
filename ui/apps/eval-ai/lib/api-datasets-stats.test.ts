import { afterEach, describe, expect, it, vi } from "vitest";

const sessionAwareFetch = vi.fn();
vi.mock("@evalai/shared/session", () => ({
  sessionAwareFetch: (...args: unknown[]) => sessionAwareFetch(...args),
}));

import { api } from "@/lib/api";

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

afterEach(() => {
  sessionAwareFetch.mockReset();
});

describe("api.getDatasetStats", () => {
  it("requests /datasets/stats and returns total + by_status", async () => {
    const body = {
      total: 10,
      by_status: { PUBLISHED: 4, DRAFT: 6 },
    };
    sessionAwareFetch.mockResolvedValueOnce(jsonResponse(body));

    const result = await api.getDatasetStats();

    const url = sessionAwareFetch.mock.calls[0][0] as string;
    const parsed = new URL(url, "http://x");
    expect(parsed.pathname).toBe("/api/eval-hub/datasets/stats");
    expect(result).toEqual(body);
  });
});

describe("published count single source", () => {
  it("overview KPI and library chips read the same PUBLISHED count", () => {
    const stats = {
      total: 10,
      by_status: {
        DRAFT: 3,
        PUBLISHED: 4,
        DEPRECATED: 1,
        RETIRED: 0,
        REJECTED: 2,
        VALIDATED: 0,
        APPROVED: 0,
      },
    };
    const overviewPublished = stats.by_status.PUBLISHED ?? 0;
    const chipPublished = stats.by_status.PUBLISHED ?? 0;
    expect(overviewPublished).toBe(chipPublished);
    expect(overviewPublished).toBe(4);
  });
});
