import { describe, expect, it } from "vitest";

import { readSpanFilters, writeSpanFilters } from "./page";

function params(query: string) {
  return new URLSearchParams(query);
}

describe("span filters URL round-trip", () => {
  it("writes only non-default filters and restores them", () => {
    const written = writeSpanFilters("", { search: "agent.run", status: "error", window: "24h" });
    expect(readSpanFilters(params(written))).toEqual({
      search: "agent.run",
      status: "error",
      window: "24h",
    });
  });

  it("keeps defaults out of the query string and preserves unrelated params", () => {
    const written = writeSpanFilters("foo=bar", { search: "", status: "", window: "" });
    const parsed = params(written);
    expect(parsed.get("foo")).toBe("bar");
    expect(parsed.has("search")).toBe(false);
    expect(parsed.has("status")).toBe(false);
    expect(parsed.has("window")).toBe(false);
  });

  it("ignores invalid status and window values instead of trusting the URL", () => {
    expect(readSpanFilters(params("status=nonsense&window=99y&search=x"))).toEqual({
      search: "x",
      status: "",
      window: "",
    });
    // The archived OTLP statuses are the only accepted values.
    expect(readSpanFilters(params("status=unset")).status).toBe("unset");
    expect(readSpanFilters(params("status=ok")).status).toBe("ok");
  });
});
