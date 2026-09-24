import { describe, expect, it } from "vitest";
import { asPercent, reliability } from "./reliability-math";

describe("illustrative reliability probabilities", () => {
  it("computes ten required steps separately from repeated attempts", () => {
    expect(reliability(.95, 10).all).toBeCloseTo(.5987369392, 9);
    expect(reliability(.99, 10).all).toBeCloseTo(.9043820750, 9);
    expect(reliability(.75, 3).atLeastOne).toBe(.984375);
    expect(reliability(.75, 3).all).toBe(.421875);
  });
  it("coincides at one trial and diverges monotonically", () => {
    expect(reliability(.75, 1)).toEqual({ all: .75, atLeastOne: .75 });
    for (let n = 2; n <= 20; n++) {
      expect(reliability(.75, n).all).toBeLessThan(reliability(.75, n - 1).all);
      expect(reliability(.75, n).atLeastOne).toBeGreaterThan(reliability(.75, n - 1).atLeastOne);
    }
  });
  it("handles probability endpoints and rejects invalid assumptions", () => {
    expect(reliability(0, 10)).toEqual({ all: 0, atLeastOne: 0 });
    expect(reliability(1, 10)).toEqual({ all: 1, atLeastOne: 1 });
    for (const [p, n] of [[-1, 3], [1.1, 3], [NaN, 3], [.75, 0], [.75, 1.5], [.75, Infinity]]) {
      expect(() => reliability(p, n)).toThrow(RangeError);
    }
  });
  it("does not round a near-certain or rare event to certainty or impossibility", () => {
    expect(asPercent(reliability(.75, 10).atLeastOne)).toBe(">99.99%");
    expect(asPercent(reliability(.75, 10).all)).toBe("5.6%");
    expect(asPercent(reliability(.05, 10).all)).toBe("<0.1%");
  });
});
