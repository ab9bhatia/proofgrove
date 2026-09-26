import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type PromoteRunItemResult } from "@/lib/api";

const result: PromoteRunItemResult = {
  dataset_name: "golden-ds",
  record_id: "rid-1",
  duplicate: false,
  created_version: false,
  source_dataset_name: null,
  version_number: 2,
  status: "DRAFT",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("promoteRunItem client", () => {
  it("POSTs the promotion body to the dataset's promotions endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(
        new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const returned = await api.promoteRunItem("golden ds", {
      run_id: "run-1",
      example_id: "ex-1",
      expected_source: "output",
      create_version_if_immutable: false,
      created_by: "proofgrove-ui",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/proofgrove/datasets/golden%20ds/promotions");
    expect(calls[0].init?.method).toBe("POST");
    // No tenant in the body: the dataset's own tenant scopes the run lookup
    // server-side, so a caller cannot name the tenant the read runs under.
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      run_id: "run-1",
      example_id: "ex-1",
      expected_source: "output",
      create_version_if_immutable: false,
      created_by: "proofgrove-ui",
    });
    expect(returned.record_id).toBe("rid-1");
  });
});
