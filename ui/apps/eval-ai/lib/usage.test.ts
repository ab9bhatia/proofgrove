import { describe, expect, it, vi } from "vitest";

import type { UsageBucket, UsageDay } from "@/lib/api-types";
import {
  bucketLabel,
  costDelta,
  costLabel,
  deltaFor,
  failureRateDelta,
  failureRatePercent,
  tokensLabel,
  usageChartRows,
  usageTableRows,
} from "./usage";

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    runs: 0,
    failed_runs: 0,
    cases: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    latency_ms_p50: null,
    latency_ms_p90: null,
    estimated_cost_usd: null,
    unpriced_cases: 0,
    cases_without_usage: 0,
    prompt_measured_cases: 0,
    completion_measured_cases: 0,
    ...overrides,
  };
}

describe("failureRatePercent", () => {
  it("is null when nothing attempted — never a fake 0%", () => {
    expect(failureRatePercent(bucket())).toBeNull();
  });
  it("counts failed launches against everything that tried", () => {
    expect(failureRatePercent(bucket({ runs: 3, failed_runs: 1 }))).toBe(25);
  });
});

describe("costLabel", () => {
  it("is null when nothing was priceable", () => {
    expect(costLabel(bucket())).toBeNull();
  });
  it("never shows a real cost as zero", () => {
    expect(costLabel(bucket({ estimated_cost_usd: 0.00003 }))).toBe("< $0.0001");
    expect(costLabel(bucket({ estimated_cost_usd: 0.1234 }))).toBe("$0.1234");
  });
});

describe("chart and table rows", () => {
  const day: UsageDay = {
    date: "2026-09-10",
    ...bucket({ runs: 2, failed_runs: 1, cases: 4, prompt_tokens: 100, completion_tokens: 20, prompt_measured_cases: 4, completion_measured_cases: 4 }),
  };
  const quiet: UsageDay = { date: "2026-09-09", ...bucket() };

  it("keeps nulls as gaps, not zeros", () => {
    const [row] = usageChartRows([quiet]);
    expect(row.p50).toBeNull();
    expect(row.cost).toBeNull();
    expect(row.prompt).toBeNull();
    expect(row.completion).toBeNull();
    expect(row.failureRate).toBeNull();
  });

  it("renders missing measurements as dashes in the table", () => {
    const rows = usageTableRows([day, quiet]);
    expect(rows[0].values).toEqual(["2026-09-10", "2", "1", "4", "—", "—", "100", "20", "—"]);
    expect(rows[1].values[1]).toBe("0"); // zero runs is a genuine zero
  });

  it("preserves measured zero and does not invent a missing token half", () => {
    const [row] = usageChartRows([{date: "2026-09-10", ...bucket({cases: 1, prompt_measured_cases: 1})}]);
    expect(row.prompt).toBe(0);
    expect(row.completion).toBeNull();
  });

  it("labels hour buckets as clock times", () => {
    const hour: UsageDay = { date: "2026-09-11T14:00", ...bucket({ runs: 1 }) };
    expect(usageChartRows([hour], "hour")[0].date).toBe("14:00");
    expect(bucketLabel("2026-09-11", "day")).toBe("09-11");
  });
});

describe("deltaFor", () => {
  it("is null against an empty previous period — absence is not growth", () => {
    expect(deltaFor(10, 0)).toBeNull();
  });
  it("signs and rounds the change", () => {
    expect(deltaFor(105_780, 74_580)).toEqual({
      text: "+41.8%",
      previousLabel: "74,580",
      direction: "up",
    });
    expect(deltaFor(50, 100)?.text).toBe("-50%");
    expect(deltaFor(100, 100)?.direction).toBe("flat");
  });
});

describe("costDelta", () => {
  it("compares only when both periods priced something", () => {
    expect(costDelta(bucket({ estimated_cost_usd: 1 }), bucket())).toBeNull();
    expect(costDelta(bucket(), bucket({ estimated_cost_usd: 1 }))).toBeNull();
    const delta = costDelta(bucket({ estimated_cost_usd: 2 }), bucket({ estimated_cost_usd: 1 }));
    expect(delta?.text).toBe("+100%");
    expect(delta?.previousLabel).toBe("$1.0000");
  });
});

describe("failureRateDelta", () => {
  it("is null when either period attempted nothing", () => {
    expect(failureRateDelta(bucket({ runs: 1 }), bucket())).toBeNull();
  });
  it("compares rates in percentage points, not counts", () => {
    const delta = failureRateDelta(bucket({ runs: 1, failed_runs: 1 }), bucket({ runs: 3, failed_runs: 1 }));
    expect(delta?.text).toBe("+25 pt"); // 50% now vs 25% before
    expect(delta?.previousLabel).toBe("25%");
    expect(delta?.direction).toBe("up");
  });
});

describe("tokensLabel", () => {
  it("compacts large counts without lying about small ones", () => {
    expect(tokensLabel(62_940_000)).toBe("62.94M");
    expect(tokensLabel(45_200)).toBe("45.2k");
    expect(tokensLabel(980)).toBe("980");
  });
});

describe("getUsage request shape", () => {
  it("sends window (and not days) when a window is chosen", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
    try {
      const { evaluationApi } = await import("./api");
      await evaluationApi.getUsage("tenant-x", { window: "24h", days: 30, targetModel: "gpt-4.1-mini" });
      expect(calls).toHaveLength(1);
      const url = new URL(calls[0], "http://test");
      expect(url.searchParams.get("window")).toBe("24h");
      expect(url.searchParams.get("days")).toBeNull();
      expect(url.searchParams.get("target_model")).toBe("gpt-4.1-mini");
      expect(url.searchParams.get("tenant_id")).toBe("tenant-x");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
