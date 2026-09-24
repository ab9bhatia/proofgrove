import { describe, expect, it } from "vitest";

import type { RunResult } from "@/lib/api";
import {
  attentionCountLabel,
  attentionCoverageNote,
  attentionRunHref,
  latestCompletedRuns,
  runsNeedingAttention,
} from "@/lib/attention";

function run(
  id: string,
  name: string,
  startedAt: string,
  status = "completed",
  experimentId?: string,
): RunResult {
  return {
    run_id: id,
    experiment: {
      experiment_id: experimentId,
      name,
      dataset_version: "dataset.v1",
      target_endpoint: "agent",
      scenario: "agentic",
      market: "global",
      judge_model: "judge",
      judge_temperature: 0,
      has_ground_truth: true,
    },
    status,
    metric_results: [],
    kpi_results: [],
    overall_gate: "pass",
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    started_at: startedAt,
    completed_at: status === "completed" ? startedAt : null,
  };
}

describe("attention parity helpers", () => {
  it("yields the same attention run set Overview and Reviews share", () => {
    const failing = {
      ...run("fail-1", "Broken", "2026-08-16T10:00:00Z"),
      verdict_status: "conclusive" as RunResult["verdict_status"],
      overall_gate: "fail" as RunResult["overall_gate"],
    };
    const warning = {
      ...run("warn-1", "Warn", "2026-08-15T10:00:00Z"),
      verdict_status: "conclusive" as RunResult["verdict_status"],
      overall_gate: "warn" as RunResult["overall_gate"],
    };
    const ok = run("ok-1", "Healthy", "2026-08-14T10:00:00Z");

    const latest = latestCompletedRuns([failing, warning, ok]);
    const attention = runsNeedingAttention(latest);

    expect(attention.map((value) => value.run_id)).toEqual(["fail-1", "warn-1"]);
  });

  it("links attention runs with the case=attention filter", () => {
    expect(attentionRunHref("run/with slash")).toBe("/runs/run%2Fwith%20slash?case=attention");
  });

  it("keeps two same-named lineages apart so neither failure is hidden", () => {
    // Same display name, different experiment_id: the evaluations library shows
    // them as two lineages, so the attention queue must not collapse them and
    // report only the newer, passing one.
    const olderFailing = {
      ...run("fail-old", "Checkout agent", "2026-08-10T10:00:00Z", "completed", "exp-old"),
      verdict_status: "conclusive" as RunResult["verdict_status"],
      overall_gate: "fail" as RunResult["overall_gate"],
    };
    const newerPassing = run(
      "pass-new",
      "Checkout agent",
      "2026-08-18T10:00:00Z",
      "completed",
      "exp-new",
    );

    const attention = runsNeedingAttention(latestCompletedRuns([newerPassing, olderFailing]));

    expect(attention.map((value) => value.run_id)).toEqual(["fail-old"]);
  });

  it("still folds a lineage's own reruns into its latest run", () => {
    const older = {
      ...run("run-1", "Checkout agent", "2026-08-10T10:00:00Z", "completed", "exp-shared"),
      verdict_status: "conclusive" as RunResult["verdict_status"],
      overall_gate: "fail" as RunResult["overall_gate"],
    };
    const newer = run(
      "run-2",
      "Checkout agent",
      "2026-08-18T10:00:00Z",
      "completed",
      "exp-shared",
    );

    expect(latestCompletedRuns([older, newer]).map((value) => value.run_id)).toEqual(["run-2"]);
    expect(runsNeedingAttention(latestCompletedRuns([older, newer]))).toEqual([]);
  });

  it("returns an empty list when nothing needs attention", () => {
    const ok = run("ok-1", "Healthy", "2026-08-14T10:00:00Z");
    expect(runsNeedingAttention(latestCompletedRuns([ok]))).toEqual([]);
  });
});

describe("attentionCountLabel", () => {
  it("counts evaluations, the noun Overview and Reviews both use", () => {
    // One latest run per evaluation — calling them "runs" implied a different
    // population from the one Overview reports.
    expect(attentionCountLabel(2, { scanned: 132, total: 132 })).toBe("2 evaluations");
    expect(attentionCountLabel(1, { scanned: 0, total: 0 })).toBe("1 evaluation");
  });

  it("marks the count partial when older runs were not scanned", () => {
    // A governance queue must never present a truncated population as the whole.
    expect(attentionCountLabel(3, { scanned: 2000, total: 5312 })).toBe(
      "3 evaluations in the newest 2000 of 5312 runs",
    );
  });
});

describe("attentionCoverageNote", () => {
  it("is silent when the scan read every run", () => {
    expect(attentionCoverageNote({ scanned: 132, total: 132 })).toBeNull();
    expect(attentionCoverageNote({ scanned: 0, total: 0 })).toBeNull();
  });

  it("states the shortfall when the scan stopped early", () => {
    expect(attentionCoverageNote({ scanned: 2000, total: 5312 })).toBe(
      "Scanned the newest 2000 of 5312 runs — older evaluations are not covered.",
    );
  });
});
