import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { JudgeAgreementNote } from "./judge-agreement-note";

const entry = (over: Partial<{ agreed: number; reviewed: number; ambiguous: number }> = {}) => ({
  metric_id: "llm.coherence",
  agreed: 0,
  reviewed: 0,
  ambiguous: 0,
  ...over,
});

describe("JudgeAgreementNote", () => {
  it("names the scope, so the count is not read as belonging to this run alone", () => {
    // The counts span every run in the tenant. Unscoped, "0 of 1" reads as a
    // verdict on the run in front of you.
    render(<JudgeAgreementNote entry={entry({ agreed: 2, reviewed: 3 })} />);
    expect(screen.getByText(/Across all runs/)).toBeTruthy();
    expect(screen.getByText("2 of 3")).toBeTruthy();
  });

  it("says nobody has reviewed rather than rendering nothing", () => {
    // Silence read as "no reviews in this run" or "the judge is fine" —
    // whichever the reader already believed. Both are wrong.
    render(<JudgeAgreementNote entry={undefined} />);
    expect(screen.getByText(/nobody has reviewed this metric yet/)).toBeTruthy();
  });

  it("does not report a failed fetch as an absence of reviews", () => {
    // Both a dropped request and a genuinely unreviewed metric arrive as an
    // undefined entry. Only one of them is a fact about review history, and
    // asserting the wrong one is worse than saying nothing.
    render(<JudgeAgreementNote entry={undefined} unavailable />);
    expect(screen.getByText("Agreement unavailable")).toBeTruthy();
    expect(screen.queryByText(/nobody has reviewed/)).toBeNull();
  });

  it("reports excluded multi-metric findings even when nothing was counted", () => {
    render(<JudgeAgreementNote entry={entry({ ambiguous: 2 })} />);
    expect(screen.getByText(/2 cases not counted/)).toBeTruthy();
  });
});
