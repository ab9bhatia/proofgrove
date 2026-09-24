import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Finding } from "@/lib/api";
import {
  DECISION_OUTCOMES,
  decisionOutcomeLabel,
  decisionOutcomes,
  filterFindings,
  failingMetricDetails,
  findingFailureSummary,
  findingTitle,
  pageWithinBounds,
  reviewDecisionError,
  reviewDrawerState,
  reviewIdentityError,
  runEvidenceHref,
  sortFindings,
} from "./page";

function finding(id: string, status: Finding["status"], severity: Finding["severity"]): Finding {
  return {
    finding_id: id,
    run_id: `run-${id}`,
    experiment_id: "experiment-1",
    row_id: `row-${id}`,
    metric_ids: [id === "safety" ? "safety.general" : "llm.correctness"],
    gate_result: "fail",
    severity,
    evidence: { rationale: id === "safety" ? "unsafe response" : "wrong answer" },
    status,
    created_at: "2026-08-17T10:00:00Z",
  };
}

describe("review queue filtering", () => {
  const values = [
    finding("safety", "open", "critical"),
    finding("quality", "resolved", "medium"),
    finding("promoted", "promoted", "high"),
  ];

  it("keeps only actionable findings in the default view", () => {
    expect(filterFindings(values, { status: "active", query: "", severity: "" }).map((item) => item.finding_id)).toEqual(["safety"]);
  });

  it("searches persisted evidence and canonical metric ids", () => {
    expect(filterFindings(values, { status: "all", query: "unsafe", severity: "critical" }).map((item) => item.finding_id)).toEqual(["safety"]);
  });

  it("includes confirmed and promoted findings in completed review", () => {
    expect(filterFindings(values, { status: "resolved", query: "", severity: "" }).map((item) => item.finding_id)).toEqual(["quality", "promoted"]);
  });

  it("orders the queue by severity before recency", () => {
    expect(sortFindings([
      { ...finding("medium", "open", "medium"), created_at: "2026-08-18T12:00:00Z" },
      { ...finding("critical-old", "open", "critical"), created_at: "2026-08-17T12:00:00Z" },
      { ...finding("critical-new", "open", "critical"), created_at: "2026-08-18T10:00:00Z" },
    ]).map((item) => item.finding_id)).toEqual(["critical-new", "critical-old", "medium"]);
  });

  it("leads a finding title with the captured question instead of its metrics", () => {
    const item = {
      ...finding("quality", "open", "high"),
      evidence: { query: "Which policy applies to this refund?", rationale: "wrong answer" },
    };

    expect(findingTitle(item)).toBe("Which policy applies to this refund?");
  });

  it("requires an explicit decision and rationale before a review can be saved", () => {
    // No default outcome: an empty selection is rejected instead of silently
    // confirming the finding.
    expect(reviewDecisionError(null, "looks right")).toBe("Select a decision before saving.");
    expect(reviewDecisionError("", "looks right")).toBe("Select a decision before saving.");
    expect(reviewDecisionError("agree", "   ")).toBe("Add a reviewer note before saving.");
    expect(reviewDecisionError("agree", "confirmed unsafe output")).toBeNull();
  });
});

// Tab keyboard behavior (Arrow/Home/End roving focus) now lives in the shared
// Tabs primitive; see components/ui/tabs.test.ts.

describe("review drawer truthfulness", () => {
  const loaded = { detailsLoading: false, detailsLoaded: true, detailsError: null, hasActiveTask: false };

  it("never shows completion when review details failed to load", () => {
    // Governance thesis: a load failure must not masquerade as a finished
    // review. The drawer surfaces a retryable error, not the "completed" state.
    expect(
      reviewDrawerState({
        detailsLoading: false,
        detailsLoaded: false,
        detailsError: "Unable to load review details",
        hasActiveTask: false,
      }),
    ).toBe("details-error");
  });

  it("stays in loading until review-task loading resolves", () => {
    expect(
      reviewDrawerState({ detailsLoading: false, detailsLoaded: false, detailsError: null, hasActiveTask: false }),
    ).toBe("loading");
    expect(reviewDrawerState({ ...loaded, detailsLoading: true })).toBe("loading");
  });

  it("shows completion only after a successful load confirms no active task", () => {
    expect(reviewDrawerState(loaded)).toBe("completed");
    expect(reviewDrawerState({ ...loaded, hasActiveTask: true })).toBe("decision");
  });
});

describe("review pagination bounds", () => {
  it("resets a page that a shrunken filter left pointing past the data", () => {
    // ?page=5 with only 2 pages of results must collapse to the last real page,
    // not silently render an empty slice.
    expect(pageWithinBounds(5, 2)).toBe(2);
    expect(pageWithinBounds(1, 1)).toBe(1);
    expect(pageWithinBounds(0, 3)).toBe(1);
    expect(pageWithinBounds(2, 3)).toBe(2);
  });
});

describe("review decision governance", () => {
  it("blocks recording until a real signed-in identity resolves", () => {
    // The audit actor must be a real reviewer — never the placeholder identity.
    expect(reviewIdentityError(false)).toBe(
      "Sign-in identity required to record a governance decision.",
    );
    expect(reviewIdentityError(true)).toBeNull();
  });

  it("renders decision history under the same labels the reviewer chose", () => {
    expect(decisionOutcomeLabel("agree")).toBe("Confirm finding");
    expect(decisionOutcomeLabel("disagree")).toBe("Reject finding");
    expect(decisionOutcomeLabel("abstain")).toBe("Need more context");
  });

  it("names the judge's call, not the finding, on a case the judge passed", () => {
    // "Confirm finding" on a passing case reads as "yes, there is a problem",
    // which the store records as AGREEING with the judge — the inverse of what
    // the reviewer meant, on the exact path this flow exists to measure.
    expect(decisionOutcomeLabel("agree", "pass")).toBe("Judge was right to pass");
    expect(decisionOutcomeLabel("disagree", "pass")).toBe("Should have failed");
    expect(decisionOutcomes("pass").map((option) => option.value)).toEqual([
      "agree",
      "disagree",
      "abstain",
    ]);
    expect(decisionOutcomes("fail")).toBe(DECISION_OUTCOMES);
  });
});

describe("run evidence deep link", () => {
  it("links a finding to its run report with the case dialog target", () => {
    expect(runEvidenceHref({ run_id: "run-1", row_id: "case-1" })).toBe(
      "/runs/run-1?item=case-1",
    );
  });

  it("percent-encodes both identifiers exactly once", () => {
    expect(runEvidenceHref({ run_id: "run/xyz+1", row_id: "row 7cfd:501a" })).toBe(
      "/runs/run%2Fxyz%2B1?item=row%207cfd%3A501a",
    );
  });

  it("emits finding.row_id as the item param (row_id ≡ example_id)", () => {
    // Review findings persist the evaluated row id; run items expose that same
    // value as example_id. The producer must emit it so the report resolver
    // matches without an ordinal fallback.
    const findingRowId = "eval-row-7cfd501a";
    expect(runEvidenceHref({ run_id: "run-abc", row_id: findingRowId })).toBe(
      `/runs/run-abc?item=${findingRowId}`,
    );
  });
});

describe("runs needing attention panel", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "page.tsx"),
    "utf8",
  );

  it("never renders an amber panel with an empty list", () => {
    // The panel also shows when the scan was partial and nothing failed; that
    // case needs copy, not a heading over a void.
    expect(source).toContain("attentionRuns.length === 0 ? (");
    expect(source).toContain("Nothing in the scanned runs needs attention.");
  });

  it("does not claim a clean history when the scan was partial", () => {
    expect(source).toContain(
      "not a clean bill of health for the whole history.",
    );
  });
});

describe("the drawer names the finding, the queue names the case", () => {
  it("heads the sheet with what failed, not with the question", () => {
    // The sheet exists to explain the finding; the question is context and now
    // sits on a secondary line instead of being repeated in a boxed Input field.
    const item = {
      ...finding("quality", "open", "high"),
      metric_ids: ["ops.latency", "ops.total_token_count"],
      evidence: { query: "What is 2 plus 2?", rationale: "slow" },
    };

    expect(findingFailureSummary(item)).toBe("2 metrics failed · tokens & latency");
    expect(findingFailureSummary(item)).not.toBe(findingTitle(item));
  });

  it("names a single failing metric directly", () => {
    const item = { ...finding("quality", "open", "high"), metric_ids: ["rag.groundedness"] };
    expect(findingFailureSummary(item)).toBe("Groundedness failed");
  });
});

describe("failing metrics carry their score against the threshold", () => {
  it("reads per-metric detail from the evidence blob", () => {
    const detail = failingMetricDetails({
      failing_metric_details: [
        { metric_id: "rag.groundedness", score: 0.69, normalised_score: 0.69, threshold: 0.7, threshold_result: "fail" },
        "not an object",
      ],
    });

    expect(detail).toHaveLength(1);
    expect(detail[0].metric_id).toBe("rag.groundedness");
    expect(detail[0].threshold).toBe(0.7);
  });

  it("returns nothing for a finding written before the run recorded scores", () => {
    // Those findings show the metric name alone rather than an invented number.
    expect(failingMetricDetails({ rationale: "wrong answer" })).toEqual([]);
    expect(failingMetricDetails({ failing_metric_details: "bogus" })).toEqual([]);
  });
});
