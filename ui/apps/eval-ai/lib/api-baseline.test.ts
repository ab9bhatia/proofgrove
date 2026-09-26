import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluationApi, type BaselineChange } from "@/lib/api";

const change: BaselineChange = {
  baseline_change_id: "chg-1",
  experiment_id: "exp-1",
  tenant_id: "tenant-a",
  actor: "reviewer@example.com",
  action: "promote",
  previous_baseline_run_id: "run-old",
  new_baseline_run_id: "run-new",
  created_at: "2026-08-22T10:00:00Z",
};

function stubFetch(payload: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("audited baseline client", () => {
  it("promoteBaseline POSTs the run to the audited baseline endpoint, not the legacy promote route", async () => {
    const calls = stubFetch(change);

    const result = await evaluationApi.promoteBaseline("exp-1", "run-new");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/proofgrove/evaluation/experiments/exp-1/baseline");
    expect(calls[0].url).not.toContain("/promote");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ run_id: "run-new" });
    expect(result.action).toBe("promote");
    expect(result.previous_baseline_run_id).toBe("run-old");
  });

  it("listBaselineHistory reads the audit trail endpoint", async () => {
    const calls = stubFetch([change]);

    const result = await evaluationApi.listBaselineHistory("exp-1");

    expect(calls[0].url).toBe("/api/proofgrove/evaluation/experiments/exp-1/baseline/history");
    expect(calls[0].init?.method).toBeUndefined();
    expect(result).toHaveLength(1);
    expect(result[0].baseline_change_id).toBe("chg-1");
  });

  it("undoBaseline POSTs to the audited undo endpoint with no body", async () => {
    const calls = stubFetch({ ...change, action: "undo" });

    const result = await evaluationApi.undoBaseline("exp-1");

    expect(calls[0].url).toBe("/api/proofgrove/evaluation/experiments/exp-1/baseline/undo");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBeUndefined();
    expect(result.action).toBe("undo");
  });

  it("escapes experiment ids in every audited baseline path", async () => {
    const calls = stubFetch(change);

    await evaluationApi.promoteBaseline("exp/1", "run-new");
    await evaluationApi.listBaselineHistory("exp/1");
    await evaluationApi.undoBaseline("exp/1");

    expect(calls.map((call) => call.url)).toEqual([
      "/api/proofgrove/evaluation/experiments/exp%2F1/baseline",
      "/api/proofgrove/evaluation/experiments/exp%2F1/baseline/history",
      "/api/proofgrove/evaluation/experiments/exp%2F1/baseline/undo",
    ]);
  });
});
