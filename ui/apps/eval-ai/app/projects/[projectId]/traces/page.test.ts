import { describe, expect, it } from "vitest";

import { traceSearchFilters, readTraceFilters, sinceForWindow, writeTraceFilters } from "./page";

function params(query: string) {
  return new URLSearchParams(query);
}

describe("trace filters URL round-trip", () => {
  it("writes only non-default filters and restores them", () => {
    const written = writeTraceFilters("", {
      search: "fraud agent",
      runId: "run-123",
      status: "error",
      window: "24h",
    });
    const restored = readTraceFilters(params(written));
    expect(restored).toEqual({ search: "fraud agent", runId: "run-123", status: "error", window: "24h" });
  });

  it("keeps defaults out of the query string and preserves unrelated params", () => {
    const written = writeTraceFilters("foo=bar", { search: "", runId: "", status: "", window: "" });
    const parsed = params(written);
    expect(parsed.get("foo")).toBe("bar");
    expect(parsed.has("search")).toBe(false);
    expect(parsed.has("run_id")).toBe(false);
    expect(parsed.has("status")).toBe(false);
    expect(parsed.has("window")).toBe(false);
  });

  it("ignores invalid status and window values instead of trusting the URL", () => {
    const restored = readTraceFilters(params("status=nonsense&window=99y&search=x"));
    expect(restored).toEqual({ search: "x", runId: "", status: "", window: "" });
  });
});

describe("sinceForWindow", () => {
  it("maps presets to an ISO lower bound against a fixed clock", () => {
    const now = new Date("2026-08-23T12:00:00.000Z");
    expect(sinceForWindow("1h", now)).toBe("2026-08-23T11:00:00.000Z");
    expect(sinceForWindow("24h", now)).toBe("2026-08-22T12:00:00.000Z");
    expect(sinceForWindow("7d", now)).toBe("2026-08-16T12:00:00.000Z");
  });

  it("returns undefined for the all-time default (no fabricated bound)", () => {
    expect(sinceForWindow("")).toBeUndefined();
  });
});


describe("single trace search", () => {
  it("routes pasted run IDs to the exact filter and clears it for text searches", () => {
    const id = "401bfa95-f49b-4284-b719-cd14754f0482";
    expect(traceSearchFilters(` ${id} `)).toEqual({ search: "", runId: id });
    expect(traceSearchFilters("Paris")).toEqual({ search: "Paris", runId: "" });
    expect(traceSearchFilters("")).toEqual({ search: "", runId: "" });
  });
});
