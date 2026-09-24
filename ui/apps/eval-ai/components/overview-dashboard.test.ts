import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunResult } from "@/lib/api";
import {
  ATTENTION_PREVIEW_LIMIT,
  attentionCoverageNote,
  latestCompletedRuns,
  runsNeedingAttention,
} from "@/lib/attention";
import { attentionLabel } from "@/components/report/lib";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const overviewSource = readFileSync(join(APP_ROOT, "components/overview-dashboard.tsx"), "utf8");
const reviewsSource = readFileSync(join(APP_ROOT, "app/reviews/page.tsx"), "utf8");

function run(id: string, name: string, startedAt: string, status = "completed"): RunResult {
  return {
    run_id: id,
    experiment: {
      name,
      dataset_version: "dataset.v1",
      target_endpoint: "agent",
      scenario: "agentic",
      market: "global",
      judge_model: "judge",
      judge_temperature: 0,
      has_ground_truth: true,
      tags: { evaluation_name: name },
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

describe("overview latest evaluation results", () => {
  it("uses only the latest completed run from each evaluation", () => {
    const values = latestCompletedRuns([
      run("support-old", "Support", "2026-08-14T10:00:00Z"),
      run("support-new", "Support", "2026-08-16T10:00:00Z"),
      run("rag", "RAG", "2026-08-15T10:00:00Z"),
      run("support-live", "Support", "2026-08-17T10:00:00Z", "running"),
    ]);

    expect(values.map((value) => value.run_id)).toEqual(["support-new", "rag"]);
  });
});

describe("runsNeedingAttention", () => {
  it("returns every non-passing evaluation, never a sliced preview count", () => {
    const failing = Array.from({ length: 9 }, (_, i) =>
      run(`fail-${i}`, `Eval ${i}`, `2026-08-0${(i % 9) + 1}T10:00:00Z`),
    ).map((value) => ({
      ...value,
      verdict_status: "conclusive" as RunResult["verdict_status"],
      overall_gate: "fail" as RunResult["overall_gate"],
    }));
    const passing = run("ok", "Healthy", "2026-08-10T10:00:00Z");

    const attention = runsNeedingAttention([...failing, passing]);

    expect(attention).toHaveLength(9);
    expect(attention.length).toBeGreaterThan(ATTENTION_PREVIEW_LIMIT);
    expect(attention.map((value) => value.run_id)).not.toContain("ok");
    // Newest first so the preview slice shows the most recent problems.
    expect(attention[0].run_id).toBe("fail-8");
  });
});

describe("attention banner grammar", () => {
  it("renders singular and plural evaluation attention copy", () => {
    expect(`${attentionLabel(1, "evaluation")}.`).toBe("1 evaluation needs attention.");
    expect(`${attentionLabel(2, "evaluation")}.`).toBe("2 evaluations need attention.");
  });
});

describe("Overview / Reviews attention parity", () => {
  it("builds both attention sets from the same paginated run sweep", () => {
    // /reviews claims "Same evaluations Overview counts". That is only true if
    // Overview reads the same population: `evaluationApi.listRuns` is capped at
    // 50 rows by the store, `sweepRunHistory` reads the whole history.
    for (const source of [overviewSource, reviewsSource]) {
      expect(source).toContain("sweepRunHistory(runHistoryApi.list");
    }
    expect(overviewSource).not.toMatch(/evaluationApi\.listRuns\b/);
  });

  it("keeps the parity claim only while the scan is complete", () => {
    // Both surfaces render the same caveat from the same helper.
    expect(reviewsSource).toContain("attentionCoverageNote(attentionCoverage)");
    expect(overviewSource).toContain("attentionCoverageNote(runCoverage)");
    expect(attentionCoverageNote({ scanned: 200, total: 812 })).toBe(
      "Scanned the newest 200 of 812 runs — older evaluations are not covered.",
    );
    expect(attentionCoverageNote({ scanned: 812, total: 812 })).toBeNull();
  });

  it("counts evaluations past the legacy 50-run cap", () => {
    const runs = Array.from({ length: 120 }, (_, i) => ({
      ...run(`fail-${i}`, `Eval ${i}`, `2026-08-14T10:00:${String(i % 60).padStart(2, "0")}Z`),
      verdict_status: "conclusive" as RunResult["verdict_status"],
      overall_gate: "fail" as RunResult["overall_gate"],
    }));

    expect(runsNeedingAttention(latestCompletedRuns(runs))).toHaveLength(120);
    // The capped list the Overview used to read would have reported 50.
    expect(runsNeedingAttention(latestCompletedRuns(runs.slice(0, 50)))).toHaveLength(50);
  });
});
