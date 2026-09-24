import { describe, expect, it } from "vitest";
import { nextTabIndexForKey } from "./tabs";

describe("tabs keyboard contract", () => {
  it("moves right with wrap-around", () => {
    expect(nextTabIndexForKey("ArrowRight", 0, 3)).toBe(1);
    expect(nextTabIndexForKey("ArrowRight", 2, 3)).toBe(0);
  });

  it("moves left with wrap-around", () => {
    expect(nextTabIndexForKey("ArrowLeft", 2, 3)).toBe(1);
    expect(nextTabIndexForKey("ArrowLeft", 0, 3)).toBe(2);
  });

  it("jumps to the edges with Home and End", () => {
    expect(nextTabIndexForKey("Home", 2, 3)).toBe(0);
    expect(nextTabIndexForKey("End", 0, 3)).toBe(2);
  });

  it("ignores keys outside the tablist contract", () => {
    // Tab must keep its browser meaning (leave the tablist), and vertical
    // arrows are reserved — these tablists are horizontal.
    expect(nextTabIndexForKey("Tab", 0, 3)).toBeNull();
    expect(nextTabIndexForKey("ArrowDown", 0, 3)).toBeNull();
    expect(nextTabIndexForKey("Enter", 0, 3)).toBeNull();
  });

  it("does nothing for an empty tablist", () => {
    expect(nextTabIndexForKey("ArrowRight", 0, 0)).toBeNull();
  });

  it("matches the two-tab toggle behavior (arrows always switch sides)", () => {
    expect(nextTabIndexForKey("ArrowRight", 0, 2)).toBe(1);
    expect(nextTabIndexForKey("ArrowRight", 1, 2)).toBe(0);
    expect(nextTabIndexForKey("ArrowLeft", 0, 2)).toBe(1);
    expect(nextTabIndexForKey("ArrowLeft", 1, 2)).toBe(0);
  });
});
