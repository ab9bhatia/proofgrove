import { describe, expect, it } from "vitest";

import {
  EVALUATION_SCOPE_LABELS,
  evaluationScopeLabel,
  evidenceDepthNotCapturedCopy,
  evidenceDepthNotConfiguredCopy,
  evidenceDepthNotRecordedCopy,
} from "./scope-selector";
import { EVALUATION_DEPTHS } from "@/components/evaluation/helpers";

describe("evaluation scope labels", () => {
  it("keeps one vocabulary for setup and report surfaces", () => {
    expect(evaluationScopeLabel("final_response")).toBe("Final response");
    expect(evaluationScopeLabel("tool_interactions")).toBe("Tool interactions");
    expect(evaluationScopeLabel("full_execution")).toBe("Full execution");
    expect(EVALUATION_DEPTHS.map((depth) => depth.label)).toEqual([
      EVALUATION_SCOPE_LABELS.final_response,
      EVALUATION_SCOPE_LABELS.tool_interactions,
      EVALUATION_SCOPE_LABELS.full_execution,
    ]);
  });

  it("falls back when the scope is missing", () => {
    // report/lib.ts still labels runs whose scope was never persisted.
    expect(evaluationScopeLabel(null)).toBe("Scope not recorded");
    expect(evaluationScopeLabel(undefined)).toBe("Scope not recorded");
    expect(evidenceDepthNotRecordedCopy()).toContain("Scope not recorded");
  });

  it("keeps not-configured and not-captured copy distinct", () => {
    // There is deliberately no "unavailable" constant here any more: whether a depth is
    // available is the backend's answer, read from `scope_options`, not a fixed string.
    const notConfigured = evidenceDepthNotConfiguredCopy("final_response");
    const notCaptured = evidenceDepthNotCapturedCopy("full_execution");
    expect(notConfigured).toBe("The selected Final response depth did not include this evidence.");
    // The lede belongs to the call site; repeating it here reads as a stutter.
    expect(notConfigured).not.toContain("Not configured");
    expect(notCaptured).toContain("not captured");
    expect(notConfigured).not.toBe(notCaptured);
  });
});
