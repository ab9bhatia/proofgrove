import { describe, expect, it } from "vitest";

import type { GateResult, MetricResult, RunResult } from "@/lib/api";
import {
  assignRunDisplayLabels,
  buildKpiSlope,
  buildLatencySeries,
  buildRunTableRows,
  canJoinExperiment,
  buildRunTrend,
  changedMeasures,
  formatMeasureValue,
  gateColor,
  isDiagnosticRun,
  kpiThresholds,
  measuresForRuns,
  readAnalysisUrlState,
  DEFAULT_ANALYSIS_STATE,
  runComparisonKey,
  runLatencyMs,
  runsAreComparable,
  sortRunTableRows,
  writeAnalysisSearchParams,
} from "@/lib/chart-data";

type RunOverrides = Partial<RunResult> & {
  basisHash?: string | null;
  basisVersion?: string | null;
  latencyMs?: number | null;
};

function makeRun(runId: string, overrides: RunOverrides = {}): RunResult {
  const {
    basisHash,
    basisVersion,
    latencyMs,
    ...rest
  } = overrides;
  const lineage = basisHash
    ? {
        comparison_basis_hash: basisHash,
        // Not in the FE type yet, but the backend records it and comparability
        // depends on it, so exercise it here as an extra property.
        comparison_basis_version: basisVersion ?? null,
      }
    : undefined;
  const run: RunResult = {
    run_id: runId,
    status: "completed",
    experiment: {
      experiment_id: "experiment/shared",
      name: "Shared evaluation",
      dataset_version: "dataset.v1",
      target_endpoint: "https://example.test/agent",
      scenario: "agentic",
      market: "global",
      judge_model: "gpt-4o",
      judge_temperature: 0,
      has_ground_truth: true,
      tags: {},
    },
    metric_results: [],
    kpi_results: [
      {
        kpi_id: "quality",
        run_id: runId,
        composite_score: 0.8,
        observed_score: 0.8,
        gate_result: "pass",
        constituent_scores: [],
        threshold_pass: 0.8,
        threshold_warn: 0.6,
        threshold_fail: 0,
        evaluated_target: "agent",
      },
    ],
    verdict_status: "conclusive",
    overall_gate: "pass",
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    started_at: "2026-08-12T10:00:00Z",
    completed_at: "2026-08-12T10:00:00Z",
    run_number: 1,
    experiment_version_id: "version-shared",
    quality_profile_id: "profile/1",
    gate_policy_id: "gate/1",
    ...rest,
  };
  if (lineage) {
    run.lineage = { ...(rest.lineage ?? {}), ...lineage } as RunResult["lineage"];
  }
  if (latencyMs !== undefined) {
    (run as unknown as { latency_ms: number | null }).latency_ms = latencyMs;
  }
  return run;
}

/**
 * An `ops.latency` metric row exactly as the backend records it: `score` is
 * the captured per-item target latency in *seconds* (deterministic adapter:
 * `score = latency_ms / 1000`); an uncaptured row is unscored with a null score.
 */
function opsLatencyResult(runId: string, rowId: string, seconds: number | null): MetricResult {
  return {
    metric_id: "ops.latency",
    evaluator_instance_id: "ops.latency#default",
    run_id: runId,
    row_id: rowId,
    metric_status: seconds == null ? "unscored" : "scored",
    unscored_reason: seconds == null ? "evidence_unavailable" : null,
    score: seconds,
    normalised_score: seconds == null ? null : 1,
    label: null,
    passed: seconds == null ? null : true,
    rationale: null,
    error_message: null,
    threshold: 0.7,
    threshold_result: seconds == null ? null : "pass",
    trace_id: null,
    prompt_version: "v1",
    judge_prompt_tokens: null,
    judge_completion_tokens: null,
    judge_total_tokens: null,
    judge_model: null,
    evaluator_id: "deterministic",
    evaluator_version: "1",
    execution_status: seconds == null ? "missing_evidence" : "success",
    execution_metadata: {},
  };
}

function gatedRun(
  runId: string,
  gate: GateResult,
  composite: number,
  overrides: RunOverrides = {},
): RunResult {
  return makeRun(runId, {
    overall_gate: gate,
    verdict_status: "conclusive",
    kpi_results: [
      {
        kpi_id: "quality",
        run_id: runId,
        composite_score: composite,
        observed_score: composite,
        gate_result: gate,
        constituent_scores: [],
        threshold_pass: 0.8,
        threshold_warn: 0.6,
        threshold_fail: 0,
        evaluated_target: "agent",
      },
    ],
    ...overrides,
  });
}

describe("comparison basis / cohort compatibility", () => {
  it("treats two runs with the same basis hash and version as comparable", () => {
    const a = makeRun("a", { basisHash: "hash-1", basisVersion: "v2" });
    const b = makeRun("b", { basisHash: "hash-1", basisVersion: "v2" });
    expect(runsAreComparable(a, b)).toBe(true);
    expect(runComparisonKey(a)).toBe(runComparisonKey(b));
  });

  it("never compares a v1 (null version) run against a v2 run with the same hash", () => {
    const v1 = makeRun("v1", { basisHash: "hash-1", basisVersion: null });
    const v2 = makeRun("v2", { basisHash: "hash-1", basisVersion: "v2" });
    expect(runsAreComparable(v1, v2)).toBe(false);
  });

  it("falls back to exact experiment_version_id only when no basis hash exists", () => {
    const a = makeRun("a", { experiment_version_id: "exp-v", lineage: undefined });
    const b = makeRun("b", { experiment_version_id: "exp-v", lineage: undefined });
    expect(runsAreComparable(a, b)).toBe(true);
    const c = makeRun("c", { experiment_version_id: "other", lineage: undefined });
    expect(runsAreComparable(a, c)).toBe(false);
  });

  it("only lets completed runs with a recorded basis join an experiment", () => {
    expect(canJoinExperiment(makeRun("ok", { basisHash: "hash-1", basisVersion: "v2" }))).toBe(true);
    expect(
      canJoinExperiment(
        makeRun("active", { basisHash: "hash-1", basisVersion: "v2", status: "running" }),
      ),
    ).toBe(false);
    expect(
      canJoinExperiment(makeRun("bare", { experiment_version_id: undefined, lineage: undefined })),
    ).toBe(false);
  });

  it("keeps a v1 run out of a v2 cohort even though both are individually eligible", () => {
    const v1 = makeRun("v1", { basisHash: "hash-1", basisVersion: null });
    const v2 = makeRun("v2", { basisHash: "hash-1", basisVersion: "v2" });
    expect(canJoinExperiment(v1)).toBe(true);
    expect(canJoinExperiment(v2)).toBe(true);
    expect(runComparisonKey(v1)).not.toBe(runComparisonKey(v2));
  });

  it("treats a run with no recorded basis as comparable to nothing", () => {
    const bare = makeRun("bare", { experiment_version_id: undefined, lineage: undefined });
    const other = makeRun("other", { experiment_version_id: undefined, lineage: undefined });
    expect(runComparisonKey(bare)).toBeNull();
    expect(runsAreComparable(bare, other)).toBe(false);
  });
});

describe("buildRunTrend", () => {
  it("excludes incompatible-basis runs from the comparable trend instead of plotting them", () => {
    const runs = [
      gatedRun("r1", "pass", 0.82, { basisHash: "hash-A", basisVersion: "v2", started_at: "2026-08-10T10:00:00Z" }),
      gatedRun("r2", "warn", 0.65, { basisHash: "hash-A", basisVersion: "v2", started_at: "2026-08-11T10:00:00Z" }),
      gatedRun("r3", "fail", 0.4, { basisHash: "hash-B", basisVersion: "v2", started_at: "2026-08-12T10:00:00Z" }),
    ];
    const trend = buildRunTrend(runs);
    expect(trend.points.map((p) => p.runId)).toEqual(["r1", "r2"]);
    expect(trend.excluded.map((e) => e.runId)).toEqual(["r3"]);
    expect(trend.excluded[0]?.reason).toBeTruthy();
  });

  it("produces a gap (null score) for a run with no gated score instead of inventing a zero", () => {
    const runs = [
      gatedRun("r1", "pass", 0.82, { basisHash: "hash-A", basisVersion: "v2", started_at: "2026-08-10T10:00:00Z" }),
      makeRun("r2", {
        basisHash: "hash-A",
        basisVersion: "v2",
        started_at: "2026-08-11T10:00:00Z",
        status: "running",
        verdict_status: null,
        overall_gate: null,
        kpi_results: [],
      }),
    ];
    const trend = buildRunTrend(runs);
    const gapPoint = trend.points.find((p) => p.runId === "r2");
    expect(gapPoint).toBeDefined();
    expect(gapPoint?.score).toBeNull();
  });

  it("flags diagnostic / ungoverned runs as hollow points", () => {
    const diagnostic = makeRun("diag", {
      basisHash: "hash-A",
      basisVersion: "v2",
      diagnostic_only: true,
      verdict_status: null,
      overall_gate: null,
    });
    const governed = gatedRun("gov", "pass", 0.9, { basisHash: "hash-A", basisVersion: "v2" });
    const trend = buildRunTrend([governed, diagnostic]);
    const diagPoint = trend.points.find((p) => p.runId === "diag");
    const govPoint = trend.points.find((p) => p.runId === "gov");
    expect(diagPoint?.diagnostic).toBe(true);
    expect(govPoint?.diagnostic).toBe(false);
    expect(isDiagnosticRun(diagnostic)).toBe(true);
  });

  it("draws an ungoverned run hollow even when it carries a gate", () => {
    // Conclusive, gated, but no quality profile or gate policy governs it — its
    // gate is not a governed verdict, so it must not read as a filled point.
    const ungoverned = gatedRun("ungov", "pass", 0.9, {
      basisHash: "hash-A",
      basisVersion: "v2",
      quality_profile_id: null,
      gate_policy_id: null,
    });
    const governed = gatedRun("gov", "pass", 0.9, { basisHash: "hash-A", basisVersion: "v2" });
    expect(isDiagnosticRun(ungoverned)).toBe(true);
    const trend = buildRunTrend([governed, ungoverned]);
    expect(trend.points.find((p) => p.runId === "ungov")?.diagnostic).toBe(true);
  });

  it("never presents a point as both a gate verdict and diagnostic", () => {
    // An ungoverned run may carry a gate value, but a diagnostic point must not
    // also read PASS: the presented gate is null whenever the point is hollow.
    const ungoverned = gatedRun("ungov", "pass", 0.9, {
      basisHash: "hash-A",
      basisVersion: "v2",
      quality_profile_id: null,
      gate_policy_id: null,
    });
    const governed = gatedRun("gov", "pass", 0.9, { basisHash: "hash-A", basisVersion: "v2" });
    const trend = buildRunTrend([governed, ungoverned]);
    for (const point of trend.points) {
      expect(point.diagnostic && point.gate != null).toBe(false);
    }
    expect(trend.points.find((p) => p.runId === "ungov")?.gate).toBeNull();
    expect(trend.points.find((p) => p.runId === "gov")?.gate).toBe("pass");
  });

  it("maps gate coloring for pass / warn / fail and stays neutral for no gate", () => {
    const pass = gateColor("pass");
    const warn = gateColor("warn");
    const fail = gateColor("fail");
    const none = gateColor(null);
    expect(new Set([pass, warn, fail, none]).size).toBe(4);
    expect(pass).toBeTruthy();
  });

  it("reads gate colors from the design-system tokens, never hardcoded hexes", () => {
    expect(gateColor("pass")).toBe("var(--gate-pass)");
    expect(gateColor("warn")).toBe("var(--gate-warn)");
    expect(gateColor("fail")).toBe("var(--gate-fail)");
    expect(gateColor(null)).toBe("var(--gate-neutral)");
  });
});

describe("latency", () => {
  it("returns null (gap / not captured) when telemetry is absent — never 0", () => {
    const run = makeRun("no-latency");
    expect(runLatencyMs(run)).toBeNull();
  });

  it("reads a real captured latency when present", () => {
    const run = makeRun("with-latency", { latencyMs: 1234 });
    expect(runLatencyMs(run)).toBe(1234);
  });

  it("builds a latency series with gaps, not zeros, for missing telemetry", () => {
    const series = buildLatencySeries([
      makeRun("r1", { latencyMs: 900, started_at: "2026-08-10T10:00:00Z" }),
      makeRun("r2", { latencyMs: null, started_at: "2026-08-11T10:00:00Z" }),
    ]);
    expect(series.map((p) => p.latencyMs)).toEqual([900, null]);
  });

  it("aggregates captured ops.latency rows into a mean run latency in ms", () => {
    // Shaped like the real RunResult payload: no run-level latency field, but
    // per-item ops.latency metric rows scored in seconds. Their mean is the
    // same per-item average the compare endpoint reports.
    const run = makeRun("ops", {
      metric_results: [
        opsLatencyResult("ops", "row-1", 1.2),
        opsLatencyResult("ops", "row-2", 0.8),
        // Uncaptured row: unscored, contributes nothing (never a fake 0).
        opsLatencyResult("ops", "row-3", null),
      ],
    });
    expect(runLatencyMs(run)).toBeCloseTo(1000, 6);
    const series = buildLatencySeries([run]);
    expect(series[0]?.latencyMs).toBeCloseTo(1000, 6);
  });

  it("keeps latency a gap when ops.latency exists but captured nothing", () => {
    const run = makeRun("ops-missing", {
      metric_results: [opsLatencyResult("ops-missing", "row-1", null)],
    });
    expect(runLatencyMs(run)).toBeNull();
  });

  it("never treats other metric scores or run duration as latency", () => {
    const run = makeRun("other-metrics", {
      metric_results: [
        { ...opsLatencyResult("other-metrics", "row-1", 0.9), metric_id: "quality.faithfulness" },
      ],
      started_at: "2026-08-12T10:00:00Z",
      completed_at: "2026-08-12T10:05:00Z",
    });
    expect(runLatencyMs(run)).toBeNull();
  });
});

describe("assignRunDisplayLabels", () => {
  it("prefers the user's own run label over any numbering", () => {
    const labels = assignRunDisplayLabels([
      makeRun("a", { label: "Baseline", started_at: "2026-08-10T10:00:00Z" }),
      makeRun("b", { label: "Candidate A", started_at: "2026-08-11T10:00:00Z" }),
    ]);
    expect(labels.get("a")).toBe("Baseline");
    expect(labels.get("b")).toBe("Candidate A");
  });

  it("keeps Run N while the recorded run numbers are actually distinct", () => {
    const labels = assignRunDisplayLabels([
      makeRun("a", { run_number: 3, started_at: "2026-08-10T10:00:00Z" }),
      makeRun("b", { run_number: 7, started_at: "2026-08-11T10:00:00Z" }),
    ]);
    expect(labels.get("a")).toBe("Run 3");
    expect(labels.get("b")).toBe("Run 7");
  });

  it("falls back to started-at order when run numbers collide at 1", () => {
    // Backend grouping can leave every run at run_number 1; distinct runs must
    // never all read "Run 1".
    const labels = assignRunDisplayLabels([
      makeRun("late", { run_number: 1, started_at: "2026-08-12T10:00:00Z", completed_at: "2026-08-12T10:00:00Z" }),
      makeRun("early", { run_number: 1, started_at: "2026-08-10T10:00:00Z", completed_at: "2026-08-10T10:00:00Z" }),
      makeRun("mid", { run_number: 1, started_at: "2026-08-11T10:00:00Z", completed_at: "2026-08-11T10:00:00Z" }),
    ]);
    expect(labels.get("early")).toBe("Run 1");
    expect(labels.get("mid")).toBe("Run 2");
    expect(labels.get("late")).toBe("Run 3");
    expect(new Set(labels.values()).size).toBe(3);
  });

  it("propagates collision-safe labels into the run table and trend", () => {
    const runs = [
      gatedRun("r1", "pass", 0.8, { run_number: 1, started_at: "2026-08-10T10:00:00Z", completed_at: "2026-08-10T10:00:00Z", basisHash: "hash-A", basisVersion: "v2" }),
      gatedRun("r2", "pass", 0.9, { run_number: 1, started_at: "2026-08-11T10:00:00Z", completed_at: "2026-08-11T10:00:00Z", basisHash: "hash-A", basisVersion: "v2" }),
    ];
    const rows = buildRunTableRows(runs);
    expect(rows.map((row) => row.label).sort()).toEqual(["Run 1", "Run 2"]);
    const trend = buildRunTrend(runs);
    expect(trend.points.map((point) => point.label)).toEqual(["Run 1", "Run 2"]);
  });
});

describe("kpi slope + thresholds", () => {
  it("reads real thresholds for a KPI and refuses to invent them", () => {
    const run = gatedRun("r1", "pass", 0.82);
    expect(kpiThresholds(run, "quality")).toEqual({ pass: 0.8, warn: 0.6, fail: 0 });
    expect(kpiThresholds(run, "missing-kpi")).toBeNull();
  });

  it("marks a slope incomparable when the two runs do not share a basis", () => {
    const baseline = gatedRun("b", "pass", 0.7, { basisHash: "hash-A", basisVersion: "v2" });
    const candidate = gatedRun("c", "pass", 0.9, { basisHash: "hash-B", basisVersion: "v2" });
    const slope = buildKpiSlope(baseline, candidate, "quality");
    expect(slope.comparable).toBe(false);
    expect(slope.baseline.score).toBe(0.7);
    expect(slope.candidate.score).toBe(0.9);
  });
});

describe("run table rows", () => {
  it("shapes stable rows with an honest latency label and compatibility flag", () => {
    const rows = buildRunTableRows(
      [
        gatedRun("r1", "pass", 0.82, { basisHash: "hash-A", basisVersion: "v2" }),
        makeRun("r2", { basisHash: "hash-B", basisVersion: "v2", latencyMs: 500 }),
      ],
      { comparableBasisKey: runComparisonKey(gatedRun("x", "pass", 0.82, { basisHash: "hash-A", basisVersion: "v2" })) },
    );
    const r1 = rows.find((r) => r.runId === "r1");
    const r2 = rows.find((r) => r.runId === "r2");
    expect(r1?.compatible).toBe(true);
    expect(r2?.compatible).toBe(false);
    expect(r1?.latencyLabel).toBe("Not captured");
    expect(r2?.latencyLabel).not.toBe("0");
  });

  it("sorts deterministically by score descending and ascending", () => {
    const rows = buildRunTableRows([
      gatedRun("low", "warn", 0.5),
      gatedRun("high", "pass", 0.95),
      gatedRun("mid", "warn", 0.7),
    ]);
    const desc = sortRunTableRows(rows, "score", "desc").map((r) => r.runId);
    const asc = sortRunTableRows(rows, "score", "asc").map((r) => r.runId);
    expect(desc).toEqual(["high", "mid", "low"]);
    expect(asc).toEqual(["low", "mid", "high"]);
  });
});

function runWithLatency(
  runId: string,
  composite: number,
  latencySeconds: number | null,
  startedAt = "2026-08-12T10:00:00Z",
): RunResult {
  const run = makeRun(runId, { basisHash: "hash-A", started_at: startedAt, completed_at: startedAt });
  run.kpi_results = [{ ...run.kpi_results[0]!, composite_score: composite, observed_score: composite }];
  run.metric_results =
    latencySeconds == null
      ? []
      : ([
          {
            metric_id: "ops.latency",
            row_id: "row-1",
            score: latencySeconds,
            threshold: 0,
            threshold_result: null,
          },
        ] as unknown as MetricResult[]);
  return run;
}

describe("measures", () => {
  it("offers only what the runs recorded, and drops what none of them did", () => {
    const withLatency = runWithLatency("r1", 0.8, 0.5);
    const ids = measuresForRuns([withLatency]).map((measure) => measure.id);

    expect(ids).toContain("score");
    expect(ids).toContain("ops.latency");
    // No token rows on this run, so no permanently empty token chart.
    expect(ids).not.toContain("ops.total_token_count");
  });

  it("counts a measure as changed when it appears or disappears, not only when it moves", () => {
    const first = runWithLatency("r1", 0.8, 0.5);
    const second = runWithLatency("r2", 0.8, null, "2026-08-13T10:00:00Z");
    const changed = changedMeasures([first, second]).map((measure) => measure.id);

    // Score held steady; latency stopped being captured.
    expect(changed).not.toContain("score");
    expect(changed).toContain("ops.latency");
  });

  it("has nothing to compare with a single run", () => {
    expect(changedMeasures([runWithLatency("r1", 0.8, 0.5)])).toEqual([]);
  });

  it("writes each measure in its own units", () => {
    const [score] = measuresForRuns([runWithLatency("r1", 0.8, 0.5)]);
    const latency = measuresForRuns([runWithLatency("r1", 0.8, 0.5)]).find(
      (measure) => measure.id === "ops.latency",
    )!;

    expect(formatMeasureValue(score!, 0.82)).toBe("82%");
    expect(formatMeasureValue(latency, 500)).toBe("500 ms");
    // Absence is named, never rendered as a zero.
    expect(formatMeasureValue(latency, null)).toBe("Not captured");
  });
});

describe("analysis URL state", () => {
  it("defaults cleanly and round-trips a selected KPI + table view", () => {
    const defaults = readAnalysisUrlState(new URLSearchParams(""));
    expect(defaults).toEqual({
      view: "chart",
      kpi: "",
      sort: "date",
      order: "desc",
      sample: "",
      measures: [],
    });

    const written = writeAnalysisSearchParams("", {
      view: "table",
      kpi: "quality",
      sort: "score",
      order: "asc",
      sample: "case-7",
      measures: ["ops.latency"],
    });
    const params = new URLSearchParams(written);
    const restored = readAnalysisUrlState(params);
    expect(restored).toEqual({
      view: "table",
      kpi: "quality",
      sort: "score",
      order: "asc",
      sample: "case-7",
      measures: ["ops.latency"],
    });
  });

  it("keeps default values out of the query string and preserves unrelated params", () => {
    // Pre-existing generic `kpi`/`sample` params belong to the page, not to the
    // analysis panel, so they must survive untouched (the panel owns `an_*`).
    const written = writeAnalysisSearchParams("page=2&q=hello&kpi=external&sample=xyz", {
      view: "chart",
      kpi: "",
      sort: "date",
      order: "desc",
      sample: "",
      measures: [],
    });
    const params = new URLSearchParams(written);
    expect(params.get("page")).toBe("2");
    expect(params.get("q")).toBe("hello");
    expect(params.get("av")).toBeNull();
    expect(params.get("an_kpi")).toBeNull();
    expect(params.get("an_sample")).toBeNull();
    // Unrelated pre-existing keys are preserved, not clobbered.
    expect(params.get("kpi")).toBe("external");
    expect(params.get("sample")).toBe("xyz");
  });

  it("round-trips the charted measures and treats empty as no choice", () => {
    const params = new URLSearchParams(
      writeAnalysisSearchParams("", {
        ...DEFAULT_ANALYSIS_STATE,
        measures: ["score", "ops.latency"],
      }),
    );
    expect(params.get("an_m")).toBe("score,ops.latency");
    expect(readAnalysisUrlState(params).measures).toEqual(["score", "ops.latency"]);

    // Clearing every measure and never choosing one are the same state: both
    // fall back to the changed-measures default, so neither needs a sentinel.
    const cleared = new URLSearchParams(
      writeAnalysisSearchParams("an_m=score", { ...DEFAULT_ANALYSIS_STATE, measures: [] }),
    );
    expect(cleared.get("an_m")).toBeNull();
    expect(readAnalysisUrlState(cleared).measures).toEqual([]);
  });
});
