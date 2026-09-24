import { describe, expect, it } from "vitest";

import { middleTruncate } from "./truncate";

describe("middleTruncate", () => {
  it("leaves a name that already fits alone", () => {
    expect(middleTruncate("Support quality", 40)).toBe("Support quality");
  });

  it("keeps the tail, which is what distinguishes generated names", () => {
    const a = "Bakeoff — Codex E2E Agent 20260814-151533_baseline";
    const b = "Bakeoff — Codex E2E Agent 20260814-151533_candidate";

    // A trailing ellipsis would render these two identically.
    expect(middleTruncate(a, 40)).not.toBe(middleTruncate(b, 40));
    expect(middleTruncate(a, 40).endsWith("baseline")).toBe(true);
    expect(middleTruncate(b, 40).endsWith("candidate")).toBe(true);
  });

  it("stays within the limit", () => {
    const long = "Codex Full Agent Review 20260817-124129 (agent-under-test)";
    expect(middleTruncate(long, 40).length).toBeLessThanOrEqual(40);
    expect(middleTruncate(long, 40)).toContain("…");
  });
});

describe("small and degenerate limits", () => {
  it("never returns more than the limit asks for", () => {
    // `slice(-0)` returns the whole string, so a zero-width tail used to make
    // middleTruncate("abcdef", 2) return "a…abcdef" — longer than the input.
    for (const limit of [0, 1, 2, 3, 4, 5]) {
      expect(middleTruncate("abcdefghij", limit).length).toBeLessThanOrEqual(Math.max(limit, 0));
    }
  });

  it("keeps a character from each side once an ellipsis fits", () => {
    const result = middleTruncate("abcdefghij", 5);
    expect(result).toContain("…");
    expect(result.startsWith("a")).toBe(true);
    expect(result.endsWith("j")).toBe(true);
  });
});
