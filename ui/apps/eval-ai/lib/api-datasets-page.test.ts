import { afterEach, describe, expect, it, vi } from "vitest";

const sessionAwareFetch = vi.fn();
vi.mock("@evalai/shared/session", () => ({
  sessionAwareFetch: (...args: unknown[]) => sessionAwareFetch(...args),
}));

import { api, type DatasetPage, type DatasetRecordsPage } from "@/lib/api";

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

const datasetEnvelope: DatasetPage = {
  items: [],
  total: 107,
  limit: 50,
  offset: 0,
  next_cursor: "50",
};

const recordsEnvelope: DatasetRecordsPage = {
  items: [],
  total: 180,
  limit: 50,
  offset: 50,
  next_cursor: "100",
};

afterEach(() => {
  sessionAwareFetch.mockReset();
});

describe("api.listDatasetsPage", () => {
  it("requests the paged dataset list and returns the honest envelope", async () => {
    sessionAwareFetch.mockResolvedValueOnce(jsonResponse(datasetEnvelope));

    const result = await api.listDatasetsPage({ limit: 50 });

    const url = sessionAwareFetch.mock.calls[0][0] as string;
    const parsed = new URL(url, "http://x");
    expect(parsed.pathname).toBe("/api/proofgrove/datasets");
    expect(parsed.searchParams.get("limit")).toBe("50");
    expect(parsed.searchParams.has("offset")).toBe(false);
    expect(parsed.searchParams.has("cursor")).toBe(false);
    expect(result).toEqual(datasetEnvelope);
  });

  it("passes the cursor and status filter when advancing a page", async () => {
    sessionAwareFetch.mockResolvedValueOnce(
      jsonResponse({ ...datasetEnvelope, next_cursor: null }),
    );

    await api.listDatasetsPage({ limit: 50, cursor: "50", status: "PUBLISHED" });

    const url = sessionAwareFetch.mock.calls[0][0] as string;
    const parsed = new URL(url, "http://x");
    expect(parsed.searchParams.get("cursor")).toBe("50");
    expect(parsed.searchParams.get("status")).toBe("PUBLISHED");
  });

  it("scopes the list to the tenant so total matches the chip counts", async () => {
    sessionAwareFetch.mockResolvedValueOnce(jsonResponse(datasetEnvelope));

    await api.listDatasetsPage({ limit: 50, tenant_id: "tenant-classroom" });

    const url = sessionAwareFetch.mock.calls[0][0] as string;
    const parsed = new URL(url, "http://x");
    expect(parsed.searchParams.get("tenant_id")).toBe("tenant-classroom");
  });
});

describe("api.getRecordsPage", () => {
  it("requests one page of records with limit + offset", async () => {
    sessionAwareFetch.mockResolvedValueOnce(jsonResponse(recordsEnvelope));

    const result = await api.getRecordsPage("my ds/v1", { limit: 50, offset: 50 });

    const url = sessionAwareFetch.mock.calls[0][0] as string;
    const parsed = new URL(url, "http://x");
    expect(parsed.pathname).toBe("/api/proofgrove/datasets/my%20ds%2Fv1/records");
    expect(parsed.searchParams.get("limit")).toBe("50");
    expect(parsed.searchParams.get("offset")).toBe("50");
    expect(result).toEqual(recordsEnvelope);
  });
});

describe("legacy unpaged dataset calls", () => {
  it("listDatasets still hits the bare endpoint without paging params", async () => {
    sessionAwareFetch.mockResolvedValueOnce(jsonResponse([]));

    await api.listDatasets();

    const url = sessionAwareFetch.mock.calls[0][0] as string;
    const parsed = new URL(url, "http://x");
    expect(parsed.pathname).toBe("/api/proofgrove/datasets");
    expect(parsed.searchParams.has("limit")).toBe(false);
  });

  it("getRecords still hits the bare records endpoint (full export path)", async () => {
    sessionAwareFetch.mockResolvedValueOnce(jsonResponse([]));

    await api.getRecords("ds");

    const url = sessionAwareFetch.mock.calls[0][0] as string;
    const parsed = new URL(url, "http://x");
    expect(parsed.pathname).toBe("/api/proofgrove/datasets/ds/records");
    expect(parsed.searchParams.has("limit")).toBe(false);
  });
});
