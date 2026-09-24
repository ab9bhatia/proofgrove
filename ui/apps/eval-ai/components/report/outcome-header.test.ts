import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RunOutcomeSection, runOutcomeTitle } from "./outcome-header";
import type { MetricResult, RunResult } from "@/lib/api";

function passingMetricResult(rowId: string): MetricResult {
  return {
    metric_id: "agent.task_completion",
    evaluator_instance_id: "judge-1",
    run_id: "run-1",
    row_id: rowId,
    score: 1,
    normalised_score: 1,
    label: "pass",
    passed: true,
    rationale: "The response completed the task.",
    error_message: null,
    threshold: 0.8,
    threshold_result: "pass",
    trace_id: null,
    prompt_version: "v1",
    judge_prompt_tokens: null,
    judge_completion_tokens: null,
    judge_total_tokens: null,
    judge_model: "gpt-4o",
    evaluator_id: "task-completion",
    evaluator_version: "1",
    execution_status: "success",
    execution_metadata: {},
  };
}

const run: RunResult = {
  run_id: "run-1",
  status: "completed",
  experiment: {
    experiment_id: "experiment-1",
    name: "Fraud Agent Suite",
    dataset_version: "ds_demo",
    target_endpoint: "https://example.test/agent",
    scenario: "agentic",
    market: "global",
    judge_model: "gpt-4o",
    judge_temperature: 0,
    has_ground_truth: true,
    target_version: "agent-v3",
    target_version_id: "target-version-3",
    evaluation_scope: "tool_interactions",
  },
  metric_results: [passingMetricResult("case-1"), passingMetricResult("case-2")],
  kpi_results: [],
  verdict_status: "conclusive",
  overall_gate: "pass",
  diagnostic_only: false,
  evidence_capture_status: "complete",
  evidence_categories: [],
  lineage: null,
  root_cause: null,
  review_queue: [],
  active_metrics: [],
  started_at: "2026-08-03T00:00:00Z",
  completed_at: "2026-08-03T00:01:00Z",
  run_number: 6,
  quality_profile_id: "profile-fraud-agent",
  quality_profile_version: "1.2.0",
  gate_policy_id: "gate-fraud-agent",
  gate_policy_version: "1.0.0",
};

type PassRate = {
  passed: number;
  warned: number;
  total: number;
  failed: number;
  notScored: number;
};

function renderOutcome(passRate: PassRate | null): string {
  return renderToStaticMarkup(
    createElement(RunOutcomeSection, {
      run,
      overallScoreLabel: "—",
      overallPct: null,
      passRate,
    }),
  );
}

/** Extract the extra classes applied to the "Case outcome" value cell. */
function caseOutcomeValueClass(passRate: PassRate): string {
  const html = renderOutcome(passRate);
  const match = html.match(
    /<dd class="mt-1\.5 text-lg font-semibold tracking-tight([^"]*)">\d+\/\d+ passed<\/dd>/,
  );
  if (!match) throw new Error("Could not find the Case outcome value cell");
  return match[1];
}

describe("RunOutcomeSection case outcome color", () => {
  it("is positive only when there are no failures, no warnings, and nothing is unscored", () => {
    const cls = caseOutcomeValueClass({ passed: 8, warned: 0, total: 8, failed: 0, notScored: 0 });
    // The gate palette: this is a verdict, not a lifecycle state.
    expect(cls).toContain("text-gate-pass");
  });

  it("is neutral (never positive) when cases are not scored, even with zero failures", () => {
    const cls = caseOutcomeValueClass({ passed: 5, warned: 0, total: 8, failed: 0, notScored: 3 });
    expect(cls).not.toContain("text-emerald");
    expect(cls).not.toContain("text-red");
    expect(cls.trim()).toBe("");
  });

  it("is never positive when cases warned, even with zero failures", () => {
    const cls = caseOutcomeValueClass({ passed: 7, warned: 1, total: 8, failed: 0, notScored: 0 });
    expect(cls).not.toContain("text-emerald");
    expect(cls).not.toContain("text-red");
    expect(cls.trim()).toBe("");
  });

  it("stays negative when there are failures", () => {
    const cls = caseOutcomeValueClass({ passed: 5, warned: 0, total: 8, failed: 3, notScored: 0 });
    // The destructive token, not a raw palette shade: failure colour has one
    // source of truth and flips correctly in dark mode without a paired class.
    expect(cls).toContain("text-destructive");
    expect(cls).not.toContain("text-emerald");
  });
});

describe("RunOutcomeSection outcome title with warned cases", () => {
  it("claims Passed all checks only when nothing warned", () => {
    const html = renderOutcome({ passed: 8, warned: 0, total: 8, failed: 0, notScored: 0 });
    expect(html).toContain("Passed all checks");
  });

  it("never claims Passed all checks while a warning is visible", () => {
    const html = renderOutcome({ passed: 7, warned: 1, total: 8, failed: 0, notScored: 0 });
    expect(html).not.toContain("Passed all checks");
    expect(html).toContain("Passed with 1 warning");
    expect(html).toContain("0 failed · 1 warned · 0 not scored");
  });

  it("pluralizes the warned-count title", () => {
    const html = renderOutcome({ passed: 6, warned: 2, total: 8, failed: 0, notScored: 0 });
    expect(html).toContain("Passed with 2 warnings");
  });
});

describe("RunOutcomeSection disabled Compare action", () => {
  const html = renderToStaticMarkup(
    createElement(RunOutcomeSection, {
      run,
      overallScoreLabel: "—",
      overallPct: null,
      passRate: null,
      compareHref: null,
      compareDisabledReason: "No comparable completed runs yet",
    }),
  );

  it("stays focusable so assistive technology can reach the reason", () => {
    // `disabled` drops the control from the tab order and silences its `title`.
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/<button[^>]*\sdisabled(=|\s|>)/);
  });

  it("names the reason to assistive technology, not only to a mouse", () => {
    const describedBy = html.match(/aria-describedby="([^"]+)"/);
    expect(describedBy).not.toBeNull();
    const reasonId = describedBy![1]!;
    expect(html).toContain(`id="${reasonId}" class="sr-only">No comparable completed runs yet`);
    // The mouse convenience is kept.
    expect(html).toContain('title="No comparable completed runs yet"');
  });
});

describe("the headline cannot contradict the cases below it", () => {
  it("does not claim all checks passed while cases failed", () => {
    // A run can pass its release gate while cases fail a non-gating check.
    // The headline printed "Passed all checks" in green directly above
    // "0/10 passed · 10 failed" in red.
    const html = renderOutcome({ passed: 0, warned: 0, total: 10, failed: 10, notScored: 0 });
    expect(html).not.toContain("Passed all checks");
    expect(html).toContain("10 cases failed a check");
  });

  it("still says so plainly when nothing failed", () => {
    const html = renderOutcome({ passed: 8, warned: 0, total: 8, failed: 0, notScored: 0 });
    expect(html).toContain("Passed all checks");
  });

  it("reports a single failing case in the singular", () => {
    const html = renderOutcome({ passed: 7, warned: 0, total: 8, failed: 1, notScored: 0 });
    expect(html).toContain("1 case failed a check");
  });
});

describe("the verdict cannot outrun what was scored", () => {
  it("does not claim all checks passed when no case was scored", () => {
    // Observed on a live run: "Passed all checks · 100%" above "0/2 passed ·
    // 2 not scored". The gate passed on a KPI while nothing was ever judged.
    expect(runOutcomeTitle({ kind: "pass", passRate: { passed: 0, warned: 0, failed: 0, notScored: 2, total: 2 } }))
      .toBe("Gate passed · no case was scored");
  });

  it("names a partial gap rather than hiding it", () => {
    expect(runOutcomeTitle({ kind: "pass", passRate: { passed: 1, warned: 0, failed: 0, notScored: 1, total: 2 } }))
      .toBe("Gate passed · 1 case not scored");
  });

  it("still says so when everything really did pass", () => {
    expect(runOutcomeTitle({ kind: "pass", passRate: { passed: 2, warned: 0, failed: 0, notScored: 0, total: 2 } }))
      .toBe("Passed all checks");
  });
});

// This headline composes its own text rather than rendering `label`, so it was
// discarding the "· ungoverned" qualifier exactly as the header badge did — a
// green "Passed all checks" above a run no quality contract stood behind.
describe("the verdict cannot claim governance it does not have", () => {
  const allPassed = { passed: 2, warned: 0, failed: 0, notScored: 0, total: 2 };

  it("qualifies a clean pass that nothing governed", () => {
    expect(runOutcomeTitle({ kind: "pass", passRate: allPassed, governed: false }))
      .toBe("Passed all checks · ungoverned");
  });

  it("qualifies a gate that passed with gaps", () => {
    expect(runOutcomeTitle({
      kind: "pass",
      passRate: { passed: 1, warned: 0, failed: 0, notScored: 1, total: 2 },
      governed: false,
    })).toBe("Gate passed · ungoverned · 1 case not scored");
  });

  it("qualifies warn and fail headlines too", () => {
    expect(runOutcomeTitle({ kind: "warn", passRate: null, governed: false })).toBe("Review required · ungoverned");
    expect(runOutcomeTitle({ kind: "fail", passRate: null, governed: false })).toBe("Action required · ungoverned");
  });

  it("defaults to governed so an omitted argument cannot smear the qualifier everywhere", () => {
    expect(runOutcomeTitle({ kind: "pass", passRate: allPassed })).toBe("Passed all checks");
    expect(runOutcomeTitle({ kind: "warn", passRate: null })).toBe("Review required");
  });
});
