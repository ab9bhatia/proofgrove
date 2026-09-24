import { describe, expect, it } from "vitest";
import type { RunResult } from "@/lib/api";
import {
  comparableRunsForReport,
  compareDisabledReasonFromRunReport,
  compareHrefFromRunReport,
  comparisonHrefForRuns,
  comparisonKey,
} from "./comparison-href";

function run(overrides: Partial<RunResult> & Pick<RunResult, "run_id" | "started_at">): RunResult {
  return {
    status: "completed",
    experiment: {
      experiment_id: "experiment-shared",
      name: "Shared",
      dataset_version: "ds_v1",
      target_endpoint: "https://example.test",
      scenario: "llm_core",
    },
    experiment_version_id: "version-shared",
    lineage: { comparison_basis_hash: "basis-shared" },
    metric_results: [],
    kpi_results: [],
    verdict_status: "conclusive",
    overall_gate: "pass",
    diagnostic_only: false,
    evidence_capture_status: "complete",
    evidence_categories: [],
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    completed_at: overrides.started_at,
    run_number: 1,
    ...overrides,
  } as RunResult;
}

/**
 * The compare affordance must never offer a link the backend rejects, so the
 * key mirrors `store.compare_runs`: hash AND basis version, with an exact
 * `experiment_version_id` fallback only when no basis hash was recorded.
 */
describe("comparisonKey", () => {
  it("separates runs that share a basis hash but not the basis version", () => {
    const v1 = run({
      run_id: "v1",
      started_at: "2026-01-01T00:00:00Z",
      lineage: { comparison_basis_hash: "basis-shared" } as RunResult["lineage"],
    });
    const v2 = run({
      run_id: "v2",
      started_at: "2026-01-02T00:00:00Z",
      lineage: {
        comparison_basis_hash: "basis-shared",
        comparison_basis_version: "v2",
      } as RunResult["lineage"],
    });
    expect(comparisonKey(v1)).not.toBe(comparisonKey(v2));
    expect(comparisonHrefForRuns([v1, v2])).toBeNull();
  });

  it("falls back to an exact experiment_version_id only when no basis hash was recorded", () => {
    const older = run({
      run_id: "older",
      started_at: "2026-01-01T00:00:00Z",
      lineage: null,
    });
    const newer = run({
      run_id: "newer",
      started_at: "2026-01-02T00:00:00Z",
      lineage: null,
    });
    expect(comparisonKey(older)).toBe(comparisonKey(newer));
    expect(comparisonHrefForRuns([older, newer])).toBe(
      "/evaluations/experiment-shared/compare?baseline_run_id=older&candidate_run_id=newer",
    );

    const otherVersion = run({
      run_id: "other-version",
      started_at: "2026-01-03T00:00:00Z",
      lineage: null,
      experiment_version_id: "version-other",
    });
    expect(comparisonHrefForRuns([older, otherVersion])).toBeNull();
  });

  it("never treats a shared experiment_id as a comparison basis", () => {
    const bare = { lineage: null, experiment_version_id: null } as Partial<RunResult>;
    const first = run({ run_id: "first", started_at: "2026-01-01T00:00:00Z", ...bare });
    const second = run({ run_id: "second", started_at: "2026-01-02T00:00:00Z", ...bare });
    expect(first.experiment?.experiment_id).toBe(second.experiment?.experiment_id);
    expect(comparisonKey(first)).toBeNull();
    expect(comparisonHrefForRuns([first, second])).toBeNull();
    expect(compareDisabledReasonFromRunReport(first, [first, second])).toMatch(
      /no comparison basis/i,
    );
  });
});

describe("comparisonHrefForRuns", () => {
  it("builds a compare deep link for compatible runs", () => {
    const older = run({ run_id: "run older", started_at: "2026-01-01T00:00:00Z" });
    const newer = run({ run_id: "run/newer", started_at: "2026-01-02T00:00:00Z" });
    older.experiment = {
      ...older.experiment!,
      experiment_id: "experiment/shared",
    };
    newer.experiment = older.experiment;
    expect(comparisonHrefForRuns([newer, older])).toBe(
      "/evaluations/experiment%2Fshared/compare?baseline_run_id=run%20older&candidate_run_id=run%2Fnewer",
    );
  });

  it("returns null for a solo run", () => {
    const solo = run({ run_id: "solo", started_at: "2026-01-01T00:00:00Z" });
    expect(comparisonHrefForRuns([solo])).toBeNull();
  });
});

describe("compareHrefFromRunReport", () => {
  it("prefills baseline as this run and candidates as comparable siblings", () => {
    const thisRun = run({ run_id: "this-run", started_at: "2026-01-03T00:00:00Z" });
    const older = run({ run_id: "sibling-old", started_at: "2026-01-01T00:00:00Z" });
    const mid = run({ run_id: "sibling-mid", started_at: "2026-01-02T00:00:00Z" });
    const href = compareHrefFromRunReport(thisRun, [older, mid, thisRun]);
    expect(href).toContain("baseline_run_id=this-run");
    expect(href).toContain("candidate_run_id=sibling-mid");
    expect(href).toContain("candidate_run_id=sibling-old");
    expect(comparableRunsForReport(thisRun, [older, mid]).map((r) => r.run_id)).toEqual([
      "this-run",
      "sibling-mid",
      "sibling-old",
    ]);
  });

  it("disables with a reason when no comparable sibling exists", () => {
    const thisRun = run({ run_id: "solo", started_at: "2026-01-01T00:00:00Z" });
    expect(compareHrefFromRunReport(thisRun, [thisRun])).toBeNull();
    expect(compareDisabledReasonFromRunReport(thisRun, [thisRun])).toMatch(/at least one other/i);
  });
});
