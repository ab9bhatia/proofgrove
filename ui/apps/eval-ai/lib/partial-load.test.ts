import { describe, expect, it } from "vitest";

import { partialLoadMessage, settledOr } from "@/lib/partial-load";

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return (await Promise.allSettled([promise]))[0];
}

describe("settledOr", () => {
  it("passes a fulfilled value through untouched", async () => {
    const missing: string[] = [];
    const result = await settle(Promise.resolve([1, 2]));
    expect(settledOr(result, [], "metrics", missing)).toEqual([1, 2]);
    expect(missing).toEqual([]);
  });

  it("falls back and names the panel that failed", async () => {
    const missing: string[] = [];
    const result = await settle(Promise.reject(new Error("boom")));
    expect(settledOr(result, [], "metrics", missing)).toEqual([]);
    expect(missing).toEqual(["metrics"]);
  });
});

describe("partialLoadMessage", () => {
  it("says nothing when every panel arrived", () => {
    expect(partialLoadMessage([])).toBeNull();
  });

  it("reads as a sentence for one, two, and many failures", () => {
    expect(partialLoadMessage(["metrics"])).toContain("Could not load metrics.");
    expect(partialLoadMessage(["metrics", "agents"])).toContain("metrics and agents");
    expect(partialLoadMessage(["metrics", "agents", "templates"])).toContain(
      "metrics, agents and templates",
    );
  });
});
