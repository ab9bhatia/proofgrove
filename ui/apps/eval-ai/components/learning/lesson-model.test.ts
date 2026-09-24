import { describe, expect, it } from "vitest";
import { INITIAL_PLAN, planMarkdown, releaseDecision } from "./lesson-model";

describe("lesson decisions", () => {
  it("keeps a critical failure separate from an excellent average", () => {
    expect(releaseDecision(99, 95, 1, false).allowed).toBe(true);
    expect(releaseDecision(99, 95, 1, true)).toEqual({ averagePasses: true, criticalBlocks: true, allowed: false });
    expect(releaseDecision(99, 95, 0, true).allowed).toBe(true);
  });

  it("honors the inclusive threshold even without a critical failure", () => {
    expect(releaseDecision(99, 99, 0, true).allowed).toBe(true);
    expect(releaseDecision(99, 100, 0, false)).toEqual({ averagePasses: false, criticalBlocks: false, allowed: false });
  });

  it("exports the learner's own decisions and a reusable test checklist", () => {
    const plan = { ...INITIAL_PLAN, system: "  My revision assistant  ", blocker: "Cites the wrong lecture", nextChange: "Pin prompt v2 and compare" };
    const markdown = planMarkdown(plan);
    expect(markdown).toContain("## System under test\n\nMy revision assistant\n");
    expect(markdown).toContain("Cites the wrong lecture");
    expect(markdown).toContain("Pin prompt v2 and compare");
    expect(markdown).not.toContain(INITIAL_PLAN.system);
    expect(markdown.match(/- \[ \]/g)).toHaveLength(5);
    expect(markdown).toContain("Human".toLowerCase());
    expect(markdown).toContain("not a release approval");
  });
});
