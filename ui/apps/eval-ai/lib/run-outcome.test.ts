import { describe, expect, it } from "vitest";
import type { KpiResult, MetricResult, RunItemSummary, RunResult } from "@/lib/api";
import {
  gatedRunScore,
  runCoverageSummary,
  metricHasVerdict,
  metricScoreLabel,
  runScoreBasis,
  runScoreLabel,
  observedRunScore,
  OUTCOME_TONES,
  presentCaseOutcome,
  presentRunOutcome,
  type PresentedCaseOutcome,
  type PresentedRunOutcome,
} from "@/lib/run-outcome";

function kpi(composite: number | null, observed: number | null = composite): KpiResult {
  return {
    kpi_id: "quality",
    run_id: "run-1",
    composite_score: composite,
    observed_score: observed,
    gate_result: composite == null ? null : "pass",
    constituent_scores: [],
    threshold_pass: 0.8,
    threshold_warn: 0.6,
    threshold_fail: 0.6,
    evaluated_target: "target",
  };
}

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    run_id: "run-1",
    status: "completed",
    verdict_status: "conclusive",
    overall_gate: "pass",
    metric_results: [],
    kpi_results: [kpi(0.9)],
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    started_at: "2026-08-21T00:00:00Z",
    completed_at: "2026-08-21T00:01:00Z",
    ...overrides,
  };
}

describe("presentation-only run outcome", () => {
  it("shows a gated score only for a conclusive backend verdict", () => {
    expect(gatedRunScore(run())).toBe(0.9);
    const inconclusive = run({ verdict_status: "inconclusive", overall_gate: null, kpi_results: [kpi(null, 1)] });
    expect(gatedRunScore(inconclusive)).toBeNull();
    expect(observedRunScore(inconclusive)).toBe(1);
    expect(presentRunOutcome(inconclusive)).toMatchObject({
      kind: "inconclusive",
      label: "Inconclusive",
      gate: null,
      scoreLabel: "—",
      observedScoreLabel: "100%",
    });
  });

  it.each([
    [{ status: "blocked", verdict_status: "blocked", overall_gate: null }, "blocked", "Blocked"],
    [{ diagnostic_only: true, verdict_status: null, overall_gate: null }, "diagnostic", "Diagnostic only"],
    [{ status: "failed", verdict_status: null, overall_gate: null }, "error", "Did not finish"],
    [{ status: "cancelled", verdict_status: null, overall_gate: null }, "cancelled", "Stopped"],
    [{ status: "completed_with_partial_evidence", verdict_status: "inconclusive", overall_gate: null }, "partial_evidence", "Partial evidence"],
    [{ verdict_status: null, overall_gate: null }, "not_recorded", "Outcome not recorded"],
  ] as const)("preserves independent non-gate state %#", (overrides, kind, label) => {
    expect(presentRunOutcome(run(overrides))).toMatchObject({ kind, label, gate: null });
  });

  // A gate without a quality contract behind it is real but ungoverned. The
  // qualifier was already computed here and then discarded by every renderer
  // that handed `gate` to GateBadge, so a run nothing governed showed a plain
  // green "Pass". `governed` is exposed so a caller composing its own headline
  // does not have to recover the fact by sniffing the label.
  it("marks a gated run ungoverned when no quality contract stands behind it", () => {
    const outcome = presentRunOutcome(run());
    expect(outcome).toMatchObject({ kind: "pass", label: "Pass · ungoverned", gate: "pass", governed: false });
  });

  it("drops the qualifier once a quality profile is recorded, on the run or its lineage", () => {
    expect(presentRunOutcome(run({ quality_profile_id: "qp-1" }))).toMatchObject({
      label: "Pass",
      governed: true,
    });
    expect(presentRunOutcome(run({ lineage: { quality_profile_id: "qp-1" } }))).toMatchObject({
      label: "Pass",
      governed: true,
    });
  });

  it("reports governance on non-gate states too, so no renderer has to guess", () => {
    expect(presentRunOutcome(run({ status: "failed", verdict_status: null, overall_gate: null })).governed).toBe(false);
  });

  // A surface that already states governance in its own column should not
  // repeat it in the badge — "Pass · ungoverned" beside a Governance cell
  // reading "Ungoverned" says one thing twice and wraps the badge to two lines.
  it("offers the bare verdict word for surfaces that state governance separately", () => {
    expect(presentRunOutcome(run())).toMatchObject({
      label: "Pass · ungoverned",
      shortLabel: "Pass",
    });
  });

  it("keeps short and full identical wherever there is no qualifier to drop", () => {
    const outcome = presentRunOutcome(run({ verdict_status: "inconclusive", overall_gate: null }));
    expect(outcome.shortLabel).toBe(outcome.label);
  });
});

function item(overrides: Partial<RunItemSummary> = {}): RunItemSummary {
  return {
    run_id: "run-1",
    example_id: "case-1",
    query: "question",
    sequence_position: 0,
    dataset_version: "v1",
    worst_gate: null,
    metric_count: 1,
    failing_count: 0,
    error_count: 0,
    scored_count: 0,
    unscored_count: 0,
    not_applicable_count: 0,
    evaluation_state: "evaluated",
    latency_ms: null,
    trace_available: false,
    evidence_ref: "case-1",
    capture_state: "complete",
    artifact_count: 0,
    ...overrides,
  };
}

describe("presentation-only case outcome", () => {
  it("never presents an unscored-only case as Pass", () => {
    expect(presentCaseOutcome(item({ unscored_count: 1, worst_gate: null }))).toMatchObject({
      kind: "unscored",
      label: "Not scored",
      gate: null,
    });
  });

  it("never presents a not-applicable-only case as Pass or a technical error", () => {
    expect(presentCaseOutcome(item({ not_applicable_count: 1 }))).toMatchObject({
      kind: "not_applicable",
      label: "Not applicable",
      gate: null,
    });
  });

  it("keeps a mixed scored and unscored case partially scored", () => {
    expect(presentCaseOutcome(item({ scored_count: 1, unscored_count: 1, worst_gate: "pass" }))).toMatchObject({
      kind: "unscored",
      label: "Partially scored",
      gate: null,
    });
  });
});

describe("one name per case state", () => {
  it("distinguishes nothing-captured from captured-but-unscored", () => {
    // These two states previously answered to "Not scored" and "Unscored", two
    // words for what a reader could only assume was the same thing.
    const nothingCaptured = presentCaseOutcome(item({ worst_gate: null }));
    const capturedNotScored = presentCaseOutcome(item({ unscored_count: 1, worst_gate: null }));

    expect(nothingCaptured.label).toBe("Not recorded");
    expect(capturedNotScored.label).toBe("Not scored");
    expect(nothingCaptured.label).not.toBe(capturedNotScored.label);
  });
});

describe("one state, one name, one tone", () => {
  it("gives every outcome state a tone, so no caller has to invent one", () => {
    // The table is the reason a badge exists for every outcome rather than only
    // for the passing ones. A state missing from it would send its caller back to
    // picking a colour by hand, which is how "Pass" ended up louder than
    // "Inconclusive" in the first place.
    const runKinds: PresentedRunOutcome["kind"][] = [
      "pending", "running", "error", "cancelled", "blocked", "diagnostic",
      "inconclusive", "partial_evidence", "pass", "warn", "fail", "not_recorded",
    ];
    const caseKinds: PresentedCaseOutcome["kind"][] = [
      "pass", "warn", "fail", "unscored", "not_applicable", "technical_error", "not_recorded",
    ];

    for (const kind of [...runKinds, ...caseKinds]) {
      expect(OUTCOME_TONES[kind]).toBeDefined();
    }
  });

  it("keeps states that need a human out of the neutral tone", () => {
    for (const kind of ["error", "blocked", "technical_error", "inconclusive", "partial_evidence", "unscored"] as const) {
      expect(OUTCOME_TONES[kind]).not.toBe("neutral");
    }
    // Not-applicable is a real answer and diagnostic is deliberate; neither is a problem.
    expect(OUTCOME_TONES.not_applicable).toBe("neutral");
    expect(OUTCOME_TONES.diagnostic).toBe("neutral");
  });
});

describe("runScoreBasis", () => {
  it("prefers the gated score and says so", () => {
    expect(runScoreBasis(run())).toEqual({ value: 0.9, basis: "gated" });
    expect(runScoreLabel(run())).toBe("90%");
  });

  it("falls back to the observed score and names the basis", () => {
    // No gate: the trend chart plotted this value while the row beside it
    // printed the gated one as an em dash, and neither said which it used.
    const ungated = run({ verdict_status: "inconclusive", overall_gate: null, kpi_results: [kpi(null, 0)] });

    expect(gatedRunScore(ungated)).toBeNull();
    expect(runScoreBasis(ungated)).toEqual({ value: 0, basis: "observed" });
    expect(runScoreLabel(ungated)).toBe("0% observed · not gated");
  });

  it("names the absence when there is no score on either basis", () => {
    const unscored = run({ verdict_status: "inconclusive", overall_gate: null, kpi_results: [] });

    expect(runScoreBasis(unscored)).toEqual({ value: null, basis: null });
    // Never a bare dash — this is the third spelling the app used to carry.
    expect(runScoreLabel(unscored)).toBe("Not scored");
    expect(runScoreLabel(unscored)).not.toContain("\u2014");
  });

  it("leaves presentRunOutcome's contract alone", () => {
    // Sixteen non-test files render scoreLabel. Its meaning is "the gated
    // score, or an em dash"; runScoreLabel is the honest-fallback alternative,
    // not a replacement.
    const ungated = run({ verdict_status: "inconclusive", overall_gate: null, kpi_results: [kpi(null, 0)] });

    expect(presentRunOutcome(ungated).scoreLabel).toBe("\u2014");
    expect(presentRunOutcome(ungated).observedScoreLabel).toBe("0%");
  });
});

describe("metricScoreLabel", () => {
  const base = { normalised_score: 0.94, threshold: 0.8 } as never as MetricResult;

  it("never renders a score for a metric whose scorer crashed", () => {
    // The defect this guards: a crashed scorer kept its normalised_score, so the
    // row printed "94.0%" beside its own "Scorer error recorded" label.
    const crashed = { ...base, metric_status: "technical_error" } as MetricResult;
    expect(metricScoreLabel(crashed)).toBe("Scorer error");
    expect(metricHasVerdict(crashed)).toBe(false);
  });

  it("names a simulated result rather than scoring it", () => {
    const simulated = { ...base, unscored_reason: "simulated" } as MetricResult;
    expect(metricScoreLabel(simulated)).toBe("Simulated - no real judge ran");
    expect(metricHasVerdict(simulated)).toBe(false);
  });

  it("names an inapplicable metric", () => {
    const na = { ...base, metric_applicability: "not_applicable" } as MetricResult;
    expect(metricScoreLabel(na)).toBe("Not applicable");
    expect(metricHasVerdict(na)).toBe(false);
  });

  it("says Not scored rather than 0%", () => {
    expect(metricScoreLabel({ ...base, normalised_score: null } as MetricResult)).toBe("Not scored");
  });

  it("renders a real score", () => {
    expect(metricScoreLabel(base)).toBe("94.0%");
    expect(metricHasVerdict(base)).toBe(true);
  });
});

describe("observed score and coverage honesty", () => {
  const kpi = (over: Partial<KpiResult>) => ({ observed_score: 0.86, composite_score: null, ...over }) as KpiResult;

  it("reports no observed score when the run says nothing was scored", () => {
    // The defect: a mean over KPI observed values printed a plausible percentage
    // on a run whose every case went unscored.
    const run = { kpi_results: [kpi({ required_scored_count: 0, optional_scored_count: 0 })] } as RunResult;
    expect(observedRunScore(run)).toBeNull();
  });

  it("keeps the observed score for a diagnostic run that did score cases", () => {
    const run = { kpi_results: [kpi({ required_scored_count: 4 })] } as RunResult;
    expect(observedRunScore(run)).toBeCloseTo(0.86);
  });

  it("leaves runs that predate coverage counts alone", () => {
    // No counts reported at all is not the same as counts reporting zero.
    const run = { kpi_results: [kpi({})] } as RunResult;
    expect(observedRunScore(run)).toBeCloseTo(0.86);
  });

  it("states coverage only when the score does not cover everything", () => {
    const partial = { kpi_results: [kpi({ required_scored_count: 12, required_applicable_pair_count: 20 })] } as RunResult;
    expect(runCoverageSummary(partial)).toBe("12 of 20 required checks scored");

    const complete = { kpi_results: [kpi({ required_scored_count: 20, required_applicable_pair_count: 20 })] } as RunResult;
    expect(runCoverageSummary(complete)).toBeNull();

    expect(runCoverageSummary({ kpi_results: [] } as never as RunResult)).toBeNull();
  });
});

describe("presentCaseOutcome coverage vs verdict", () => {
  it("does not call a case partly scored because optional metrics had nothing to measure", () => {
    // A provided-response run cannot measure latency or token usage. Counting
    // those as coverage gaps put every case of such a run in a state checked
    // BEFORE the verdict, so a case with a failing REQUIRED metric announced
    // itself as "Partially scored" and never as a failure.
    const outcome = presentCaseOutcome(
      item({
        worst_gate: "fail",
        failing_count: 1,
        scored_count: 4,
        unscored_count: 5,
        unscored_required_count: 0,
      }),
    );
    expect(outcome.kind).toBe("fail");
  });

  it("still says partly scored when something required went unmeasured", () => {
    const outcome = presentCaseOutcome(
      item({ scored_count: 3, unscored_count: 1, unscored_required_count: 1 }),
    );
    expect(outcome.label).toBe("Partially scored");
  });
});
