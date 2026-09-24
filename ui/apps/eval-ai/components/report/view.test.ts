import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { gatedRunScore } from "@/lib/run-outcome";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import {
  CaseDetailsSection,
  EmbeddedRunDetails,
  EmbeddedMetricSummary,
  ExpectedOutputCard,
  ReportView,
  caseEvidencePresentation,
  runEvidenceContractPresentation,
  runEvidencePresentation,
  scoringMethodForRun,
  resolveDeepLinkedCase,
  summarizeMetricScores,
} from "@/components/report/view";
import type { MetricResult, RunItemSummary, RunResult } from "@/lib/api";

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
    name: "Fraud Agent MCP/OTel Suite",
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
  evidence_categories: [
    {
      category: "tool_calls",
      required: true,
      status: "captured",
      record_count: 0,
      completeness_attested: true,
      provenance_status: "attested",
      provenance_source: "evaluation collector",
    },
  ],
  lineage: {
    run_manifest_id: "manifest-f425c36d",
    run_manifest_hash: "f425c36dc3e7d5c5144739b6c9d3eb0cf2064734926c367f2e0b5f7b8cffb5fa",
    effective_evidence_requirements: [
      "input",
      "final_output",
      "tool_calls",
      "tool_results",
    ],
    metric_evidence_requirements: {
      "agent.task_adherence": ["tool_calls", "tool_results"],
      "safety.general": [],
    },
  },
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

const caseItems: RunItemSummary[] = [
  {
    run_id: "run-1",
    example_id: "case-failed",
    query: "Did the agent verify the customer before disclosing account details?",
    sequence_position: 0,
    dataset_version: "dataset-v1",
    worst_gate: "fail",
    metric_count: 4,
    failing_count: 2,
    error_count: 0,
    evaluation_state: "evaluated",
    latency_ms: 420,
    trace_available: true,
    evidence_ref: "evidence://case-failed",
    capture_state: "complete",
    artifact_count: 0,
  },
  {
    run_id: "run-1",
    example_id: "case-passed",
    query: "Did the agent explain the next step clearly?",
    sequence_position: 1,
    dataset_version: "dataset-v1",
    worst_gate: "pass",
    metric_count: 4,
    failing_count: 0,
    error_count: 0,
    evaluation_state: "evaluated",
    latency_ms: 310,
    trace_available: false,
    evidence_ref: "evidence://case-passed",
    capture_state: "complete",
    artifact_count: 0,
  },
];

describe("the overall score reads from the score, not from its label", () => {
  it("gives an unscored run a null percentage, never NaN", () => {
    // The percentage used to be parsed back out of the formatted label by
    // testing it against an em dash. Once the formatter named the absence
    // instead, the test stopped matching and Number("Not scored") produced NaN
    // — and NaN == null is false, so the progress bar and the score colour both
    // received NaN rather than being skipped.
    const scored = gatedRunScore({
      ...run,
      verdict_status: "conclusive",
      overall_gate: "pass",
      kpi_results: [{ kpi_id: "quality", composite_score: 0.82 }],
    } as unknown as RunResult);
    const unscored = gatedRunScore({
      ...run,
      verdict_status: "conclusive",
      overall_gate: "pass",
      kpi_results: [],
    } as unknown as RunResult);

    const pct = (value: number | null) => (value == null ? null : Math.round(value * 100));
    expect(pct(unscored)).toBeNull();
    expect(Number.isNaN(pct(unscored) as number)).toBe(false);
    expect(pct(scored)).toBe(82);
  });
});

describe("ReportView", () => {
  // The regression this file did not have. `presentRunOutcome` computed
  // "Pass · ungoverned" and the header handed the gate to GateBadge instead,
  // which printed its own word — so the most prominent chip on the report, plus
  // the headline above it, both claimed a governed verdict for a run no quality
  // contract stood behind. Assert the qualifier survives all the way to markup.
  it("does not let the header claim a governed pass for an ungoverned run", () => {
    const ungoverned: RunResult = {
      ...run,
      quality_profile_id: null,
      lineage: { ...run.lineage, quality_profile_id: null },
    };
    const html = renderToStaticMarkup(createElement(ReportView, { run: ungoverned }));
    expect(html).toContain("ungoverned");
  });

  it("keeps the plain verdict when a quality profile is recorded", () => {
    // The base fixture is governed, which is why this bug survived: every
    // rendering test in this file exercised the path where the qualifier is
    // correctly absent.
    expect(run.quality_profile_id ?? run.lineage?.quality_profile_id).toBeTruthy();
    const html = renderToStaticMarkup(createElement(ReportView, { run }));
    expect(html).not.toContain("ungoverned");
  });

  it("explains partial telemetry without presenting the run as active", () => {
    const partialRun: RunResult = {
      ...run,
      status: "completed_with_partial_evidence",
      verdict_status: "inconclusive",
      overall_gate: null,
      evidence_capture_status: "partial",
      evidence_categories: [
        {
          category: "tool_calls",
          required: true,
          status: "partial",
          record_count: 1,
          completeness_attested: false,
          provenance_status: "self_reported",
          provenance_source: "a2a-capture-fallback",
          diagnostic: "root_span_missing",
        },
      ],
    };

    const html = renderToStaticMarkup(
      createElement(ReportView, { run: partialRun, initialOpenSections: { evidence: true } }),
    );

    expect(html).toContain("Completed with partial telemetry evidence");
    expect(html).toContain("Root span missing");
    expect(html).toContain("linked enrichment run automatically");
  });

  it("keeps unscored, not-applicable, and mixed metric groups out of Pass", () => {
    const unscored: MetricResult = {
      ...passingMetricResult("case-2"),
      score: null,
      normalised_score: null,
      passed: null,
      threshold_result: null,
      metric_status: "unscored",
      metric_applicability: "applicable",
      unscored_reason: "evidence_unavailable",
    };
    const notApplicable: MetricResult = {
      ...unscored,
      metric_id: "agent.tool_selection",
      metric_status: null,
      metric_applicability: "not_applicable",
      unscored_reason: null,
    };
    const summaries = summarizeMetricScores(
      {
        ...run,
        metric_results: [
          { ...passingMetricResult("case-1"), metric_status: "scored", metric_applicability: "applicable" },
          unscored,
          notApplicable,
        ],
      },
      2,
    );

    expect(summaries.find((metric) => metric.id === "agent.task_completion")).toMatchObject({
      state: "unscored",
      worstGate: null,
    });
    expect(summaries.find((metric) => metric.id === "agent.tool_selection")).toMatchObject({
      state: "not_applicable",
      worstGate: null,
      errorCount: 0,
    });
  });

  it("renders InEval-aligned run report sections and actions", () => {
    const html = renderToStaticMarkup(
      createElement(ReportView, { run, initialOpenSections: { evidence: true } }),
    );

    expect(html).toContain("Fraud Agent MCP/OTel Suite");
    expect(html).toContain("Run report");
    // The header shows the humanised outcome only. It used to render the raw
    // status beside it, so "Completed_with_partial_evidence" sat next to
    // "Completed · partial evidence" — the same fact twice, one of it an enum.
    expect(html).not.toMatch(/>\s*completed\s*</);
    expect(html).toContain("Run evaluation");
    expect(html).toContain("Rescore saved evidence");
    expect(html).toContain("Compare");
    // Solo-run SSR render: compare is disabled until sibling runs resolve.
    expect(html).toContain("Loading comparable runs");
    expect(html).toContain("Export");
    expect(html).not.toContain("Rerun - Config");
    expect(html).not.toContain("Monitor");
    expect(html).toContain("Run outcome");
    expect(html).toContain("Evaluation evidence");
    expect(html).toContain("Tool interactions");
    expect(html).toContain("Conclusive");
    expect(html).toContain("Overall capture");
    expect(html).toContain("Evidence contract");
    expect(html).toContain("4 evidence categories · Immutable run manifest");
    expect(html).toContain("Resolved before execution");
    expect(html).toContain("Configuration fingerprint");
    expect(html).toContain("Additional metric dependencies");
    expect(html).toContain("agent.task_adherence");
    expect(html).toContain("Scope evidence only");
    expect(html).toContain("Evidence categories");
    expect(html).toContain("Tool calls");
    expect(html).toContain("0 · none observed");
    expect(html).toContain("Attested complete");
    expect(html).toContain("evaluation collector");
    expect(html).toContain("Case evidence inspector");
    expect(html).toContain("Inspect case evidence");
    expect(html).not.toContain("Preview simulated trace");
    expect(html).not.toContain("Simulated trace preview is enabled");
    expect(html).toContain("Checking the saved case evidence for this run");
    expect(html).toContain("Trace-linked evidence and identifiers appear");
    expect(html).toContain("only when the backend marks them available");
    expect(html).toContain("2/2 passed");
    expect(html).toContain("Run details");
    expect(html).not.toContain(">Recommendation<");
    expect(html).toContain("Quality gates passed. Safe to promote or use as baseline.");
    expect(html).toContain("Case details");
    expect(html).toContain("Metric averages");
    expect(html).toContain("1 metric");
    expect(html).toContain("2 cases");
    expect(html).toContain("All passed");
    expect(html).toContain("Dataset ds_demo");
    expect(html).toContain("Quality controls");
    expect(html).toContain('style="box-sizing:border-box;width:100%"');
    expect(html).toContain("No quality controls recorded");
    expect(html).toContain("governed by a quality contract, but no quality-control results were recorded");
    expect(html).toContain("w-full max-w-2xl");
    expect(html).toContain("KPI composite");
    expect(html).toContain('aria-label="Evaluator outcomes"');
    expect(html).toContain("Case outcome");
    expect(html).toContain("Evaluation method");
    expect(html).toContain("LLM judge");
    expect(html).toContain("Model gpt-4o");
    expect(html).toContain("Dataset version");
    expect(html).toContain("Target version");
    expect(html).toContain("agent-v3");
    expect(html).toContain("Quality contract");
    expect(html).toContain("Attached");
    expect(html).not.toContain(">Scoring<");
    expect(html).not.toContain("Run ID");
    expect(html).toContain('aria-expanded="false"');
    expect(html.indexOf("Run outcome")).toBeLessThan(
      html.indexOf("Evaluation evidence"),
    );
    expect(html.indexOf("Evaluation evidence")).toBeLessThan(
      html.indexOf("Quality controls"),
    );
    expect(html.indexOf("Quality controls")).toBeLessThan(
      html.indexOf("Metric averages"),
    );
    expect(html.indexOf("Metric averages")).toBeLessThan(html.indexOf("Case details"));
    expect(html.indexOf("Case details")).toBeLessThan(html.indexOf("Run details"));
  });

  it("counts a fully scored warn case as warned, not as not scored, and never claims Passed all checks", () => {
    const warnRun: RunResult = {
      ...run,
      metric_results: [
        // case-1: fully scored, all pass.
        passingMetricResult("case-1"),
        // case-2: fully scored, one warn — this is a scored outcome, not "not scored".
        {
          ...passingMetricResult("case-2"),
          score: 0.65,
          normalised_score: 0.65,
          label: "warn",
          passed: false,
          threshold_result: "warn",
        },
      ],
    };

    const html = renderToStaticMarkup(
      createElement(ReportView, { run: warnRun }),
    );

    // passed=1, warned=1, failed=0, notScored=0.
    expect(html).toContain("1/2 passed");
    expect(html).toContain("0 failed · 1 warned · 0 not scored");
    // The cases section summary surfaces the warning.
    expect(html).toContain("1 warned");
    // The outcome header must not claim a clean pass while a warning is visible.
    expect(html).not.toContain("Passed all checks");
    expect(html).toContain("Passed with 1 warning");
  });

  it("hides the Quality section and release decision for an ungoverned run", () => {
    const ungovernedRun: RunResult = {
      ...run,
      quality_profile_id: null,
      quality_profile_version: null,
      gate_policy_id: null,
      gate_policy_version: null,
      // A bare run_manifest_id must never enable governance UI.
      lineage: { run_manifest_id: "manifest-only" },
    };

    const html = renderToStaticMarkup(
      createElement(ReportView, { run: ungovernedRun, initialOpenSections: { evidence: true } }),
    );

    // Quality Outcome section is gated on an approved quality contract.
    expect(html).not.toContain("Quality controls");
    // Release decision affordance stays hidden (no capability endpoint yet).
    expect(html).not.toContain("Decide release");
    expect(html).not.toContain("Record the guarded release");
    // The run is still fully reviewable through its cases and metrics.
    expect(html).toContain("Case details");
    expect(html).toContain("Metric averages");
    // Ungoverned pass copy must not claim it is safe to promote/release.
    expect(html).not.toContain("Safe to promote");
  });

  it("shows the Quality section for a governed run but never the release affordance", () => {
    const html = renderToStaticMarkup(
      createElement(ReportView, { run, initialOpenSections: { evidence: true } }),
    );
    expect(html).toContain("Quality controls");
    expect(html).not.toContain("Decide release");
  });

  it("treats a quality-profile run with no manifest as governed in the empty state", () => {
    const governedNoManifestRun: RunResult = {
      ...run,
      // Governed by a quality profile, but no run manifest recorded anywhere.
      lineage: { quality_profile_id: "profile-fraud-agent" },
    };

    const html = renderToStaticMarkup(
      createElement(ReportView, { run: governedNoManifestRun }),
    );

    // The empty-state copy branches on governance, not manifest presence, so a
    // governed run without a manifest must never read "No quality contract attached".
    expect(html).toContain("Quality controls");
    expect(html).toContain("No quality controls recorded");
    expect(html).not.toContain("No quality contract attached");
  });

  it("shows a retryable error for a failed embedded case detail instead of empty evidence", () => {
    const html = renderToStaticMarkup(
      createElement(CaseDetailsSection, {
        items: caseItems,
        loading: false,
        error: null,
        embedded: true,
        expanded: new Set<string>(["case-failed"]),
        detailsById: {},
        detailLoading: new Set<string>(),
        detailErrors: {
          "case-failed": "This case's saved evidence could not be loaded. Try again.",
        },
        onToggle: () => undefined,
        onExpandAll: () => undefined,
        onRetryDetail: () => undefined,
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("load this case");
    expect(html).toContain("saved evidence could not be loaded");
    expect(html).toContain("Try again");
    // A failed detail load must not be rendered as genuine "missing output".
    expect(html).not.toContain("Actual output");
    expect(html).not.toContain("No judge scores captured for this case.");
  });

  it("keeps historical scope and capture metadata honest", () => {
    const historicalRun: RunResult = {
      ...run,
      experiment: { ...run.experiment!, evaluation_scope: null },
      lineage: null,
      verdict_status: undefined,
      evidence_capture_status: undefined,
      evidence_categories: [],
    };

    expect(runEvidencePresentation(historicalRun)).toEqual({
      scopeLabel: "Scope not recorded",
      scopeDetail: "Historical scope metadata is unavailable",
      verdictLabel: "Not recorded",
      verdictDetail: "Historical verdict metadata is unavailable",
      captureLabel: "Not recorded",
    });

    const html = renderToStaticMarkup(createElement(ReportView, { run: historicalRun }));
    expect(html).toContain("Scope not recorded");
    expect(html).toContain("Category-level evidence was not recorded");
    expect(html).toContain("does not imply that evidence was absent");
    expect(html).not.toContain("Evidence contract");
  });

  it("uses the immutable lineage contract before the readiness snapshot", () => {
    expect(runEvidenceContractPresentation({
      ...run,
      evidence_readiness: {
        status: "ready",
        evaluation_scope: "tool_interactions",
        requested_evaluation_scope: "final_response",
        resolved_evaluation_scope: "tool_interactions",
        scope_promotion_reasons: [],
        effective_evidence_requirements: ["input", "final_output"],
        metric_applicability: [],
        details: [],
        requested_provenance: {},
        resolved_provenance: {},
      },
    })).toMatchObject({
      effectiveRequirements: ["input", "final_output", "tool_calls", "tool_results"],
      source: "Immutable run manifest",
      summary: "4 evidence categories",
    });
  });

  it("shows a readiness-owned evidence contract for runs without a manifest", () => {
    const readinessRun: RunResult = {
      ...run,
      lineage: null,
      evidence_readiness: {
        status: "ready",
        evaluation_scope: "final_response",
        requested_evaluation_scope: "final_response",
        resolved_evaluation_scope: "final_response",
        scope_promotion_reasons: [],
        effective_evidence_requirements: ["input", "final_output"],
        metric_evidence_requirements: {
          "quality.response_clarity": [],
        },
        metric_applicability: [],
        details: [],
        requested_provenance: {},
        resolved_provenance: {},
      },
    };

    const html = renderToStaticMarkup(
      createElement(ReportView, { run: readinessRun, initialOpenSections: { evidence: true } }),
    );
    expect(html).toContain("2 evidence categories · Run readiness snapshot");
    expect(html).toContain("Input · Final output");
    expect(html).toContain("quality.response_clarity");
    expect(html).not.toContain("Configuration fingerprint");
  });

  it("shows the frozen non-governed scoring configuration without calling it a manifest", () => {
    const configuredRun: RunResult = {
      ...run,
      lineage: {
        run_configuration_id: "scoring-53f81c",
        run_configuration_hash: "53f81c3047b02ac05f6c0d35c6e112bcd9f492be4f19c24ee4be682676f20219",
        effective_evidence_requirements: ["input", "final_output"],
        metric_evidence_requirements: {
          "llm.correctness": [],
          "ops.latency": [],
        },
        metric_requirements: [
          {
            metric_id: "llm.correctness",
            requirement: "required",
            source: "legacy_scenario_primary",
          },
          {
            metric_id: "ops.latency",
            requirement: "required",
            source: "legacy_cross_cutting",
          },
        ],
        kpi_compositions: [
          {
            kpi_id: "quality",
            required_gate_constituents: ["llm.correctness", "ops.latency"],
            optional_diagnostic_constituents: [],
            fixed_gate_weights: { "llm.correctness": 0.75, "ops.latency": 0.25 },
            thresholds: { pass: 0.8, warn: 0.6 },
            hard_blocker_metric_ids: [],
          },
        ],
      },
    };

    const html = renderToStaticMarkup(
      createElement(ReportView, { run: configuredRun, initialOpenSections: { evidence: true } }),
    );

    expect(html).toContain("2 evidence categories · Resolved run configuration");
    expect(html).toContain("53f81c3047b02ac05f6c0d35c6e112bcd9f492be4f19c24ee4be682676f20219");
    expect(html).toContain("Metric requirements");
    // The resolver's enum names are ours, not the reader's.
    expect(html).toContain("Default for this scenario");
    expect(html).not.toContain("Legacy scenario primary");
    expect(html).toContain("Applies to every scenario");
    expect(html).toContain("Fixed gate composition");
    expect(html).toContain("llm.correctness · 75%");
    expect(html).toContain("ops.latency · 25%");
    expect(html).not.toContain("Immutable run manifest");
  });

  it("labels diagnostic-only runs without inventing a release verdict", () => {
    const presentation = runEvidencePresentation({
      ...run,
      diagnostic_only: true,
      verdict_status: null,
      overall_gate: null,
    });

    expect(presentation.verdictLabel).toBe("Diagnostic only");
    expect(presentation.verdictDetail).toBe("No release verdict or quality gate");
  });

  it("does not claim an LLM judge when metric provenance is deterministic", () => {
    const deterministicRun: RunResult = {
      ...run,
      active_metrics: ["ops.latency"],
      metric_results: [
        {
          ...passingMetricResult("case-1"),
          metric_id: "ops.latency",
          evaluator_id: "builtin.deterministic",
          judge_model: "stale-configured-model",
        },
      ],
    };

    expect(scoringMethodForRun(deterministicRun)).toEqual({
      label: "Deterministic scoring",
      detail: "1 recorded scorer result",
    });

    const html = renderToStaticMarkup(createElement(ReportView, { run: deterministicRun }));
    expect(html).toContain("Deterministic scoring");
    expect(html).toContain("Not used · deterministic metrics");
    expect(html).not.toContain("LLM judge");
    expect(html).not.toContain("Judge gpt-4o");
  });

  it("prefers the immutable run lineage when provenance is available", () => {
    const lineageRun: RunResult = {
      ...run,
      experiment: {
        ...run.experiment!,
        target_version: "mutable-target-version",
        judge_model: "mutable-judge",
        run_manifest_id: "mutable-manifest",
      },
      lineage: {
        target_version_id: "resolved-target-version",
        judge_model: "resolved-judge",
        run_manifest_id: "resolved-manifest",
        experiment_version_id: "setup-snapshot-1",
        captured_at: "2026-08-03T00:00:00Z",
      },
    };

    const html = renderToStaticMarkup(createElement(ReportView, { run: lineageRun }));

    expect(html).toContain("resolved-target-version");
    expect(html).toContain("resolved-judge");
    expect(html).toContain("Attached");
    expect(html).not.toContain("mutable-target-version");
    expect(html).toContain('title="resolved-judge">resolved-judge');
    expect(html).not.toContain('title="mutable-judge">mutable-judge');
  });

  it("shows backend-owned target identity assurance and lineage", () => {
    const provenanceRun: RunResult = {
      ...run,
      lineage: {
        ...run.lineage,
        exact_runtime_identity_required: true,
        target_identity_status: "unverified",
        requested_target_provenance: {
          target_type: "agent",
          identifier: "claims-agent",
          revision: "revision-7",
          status: "attested",
        },
        resolved_target_provenance: {
          target_type: "agent",
          identifier: "claims-agent",
          revision: "revision-7",
          status: "attested",
        },
        observed_target_provenance: {
          target_type: "agent",
          identifier: "claims-agent",
          status: "unavailable",
        },
      },
    };

    const html = renderToStaticMarkup(createElement(EmbeddedRunDetails, { run: provenanceRun }));

    expect(html).toContain("Identity assurance");
    expect(html).toContain("Unverified · Exact identity required");
    expect(html).toContain("Requested target");
    expect(html).toContain("Resolved target");
    expect(html).toContain("Observed target");
    expect(html).toContain("claims-agent@revision-7 · Attested");
    expect(html).toContain("claims-agent · Unavailable");
  });

  it("explains post-run identity mismatch without calling the gate unrecorded", () => {
    const mismatchedRun: RunResult = {
      ...run,
      verdict_status: "blocked",
      overall_gate: null,
      lineage: {
        ...run.lineage,
        exact_runtime_identity_required: true,
        target_identity_status: "mismatched",
      },
    };

    expect(runEvidencePresentation(mismatchedRun).verdictDetail).toBe(
      "Observed target identity did not match the resolved target",
    );
    const html = renderToStaticMarkup(createElement(EmbeddedRunDetails, { run: mismatchedRun }));
    // Assert the cell's content, not its markup. The value is rendered through
    // RunOutcomeBadge now, so a shape-coupled regex breaks on a wrapper element
    // while the behaviour under test is unchanged.
    const releaseCell = html.match(/Release result<\/dt><dd[^>]*>(.*?)<\/dd>/)?.[1] ?? "";
    expect(releaseCell).toContain("Blocked");
    expect(releaseCell).not.toContain("Outcome not recorded");
  });

  it("uses focused tabs in the embedded drawer and defaults to overview", () => {
    const html = renderToStaticMarkup(createElement(ReportView, { run, embedded: true }));

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Run report sections"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Overview<\/button>/);
    expect(html).toContain(">Cases</button>");
    expect(html).toContain(">Metrics</button>");
    expect(html).toContain(">Quality</button>");
    expect(html).toContain(">Details</button>");
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain("Summary");
    expect(html).toContain("Evaluator outcomes");
    expect(html).toContain("Recommendation");
    expect(html).toContain("Quality gates passed. Safe to promote or use as baseline.");
    expect(html).not.toContain("Run details");
    expect(html).not.toContain("Case details");
    expect(html).not.toContain("All runs");
    expect(html).not.toContain("Edit setup");
    expect(html).not.toContain("run-1");
  });

  it("renders compact quality controls and opens controls that need attention", () => {
    const qualityRun: RunResult = {
      ...run,
      metric_results: [
        {
          ...passingMetricResult("case-1"),
          metric_id: "quality.response_clarity",
        },
        {
          ...passingMetricResult("case-2"),
          metric_id: "quality.response_clarity",
        },
        {
          ...passingMetricResult("case-1"),
          metric_id: "quality.safety_policy",
          score: 0.4,
          normalised_score: 0.4,
          passed: false,
          threshold_result: "fail",
          rationale: "The response disclosed restricted information.",
        },
      ],
    };

    const html = renderToStaticMarkup(createElement(ReportView, { run: qualityRun }));

    expect(html).toContain("response clarity");
    expect(html).toContain("2 case results");
    expect(html).toContain("safety policy");
    expect(html).toContain("1 case result");
    expect(html).toContain("Evidence");
    expect(html).toContain("The response disclosed restricted information.");
    expect(html).toContain("2 metrics");
    expect(html).toContain("1 needs attention");
    expect(html).not.toContain("View metric evidence");
    expect(html).not.toContain("Review 1 affected case");
    expect(html).not.toContain("View 2 evaluated cases");
    expect(html).toMatch(/<details[^>]*open=""[^>]*>/);
    expect(html).not.toContain('role="progressbar"');
  });

  it("renders compact, collapsed evidence rows for the embedded cases tab", () => {
    const html = renderToStaticMarkup(
      createElement(CaseDetailsSection, {
        items: caseItems,
        loading: false,
        error: null,
        embedded: true,
        expanded: new Set<string>(),
        detailsById: {},
        detailLoading: new Set<string>(),
        onToggle: () => undefined,
        onExpandAll: () => undefined,
      }),
    );

    expect(html).toContain("2 cases");
    expect(html).toContain("1 needs attention");
    expect(html).toContain("Needs attention (1)");
    expect(html).toContain("Passed (1)");
    expect(html).toContain("Did the agent verify the customer");
    expect(html).toContain("2 failing");
    expect(html).toContain("No failures");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("case-failed");
    expect(html).not.toContain("Actual output");
  });

  it("renders full-page cases as a compact evidence table without inline expansion", () => {
    const html = renderToStaticMarkup(
      createElement(CaseDetailsSection, {
        items: caseItems,
        loading: false,
        error: null,
        expanded: new Set<string>(),
        detailsById: {},
        detailLoading: new Set<string>(),
        onToggle: () => undefined,
        onExpandAll: () => undefined,
        onInspect: () => undefined,
        scoresById: {
          "case-failed": { mean: 0.55, count: 4 },
          "case-passed": { mean: 0.95, count: 4 },
        },
      }),
    );

    expect(html).toContain("Case</span>");
    expect(html).toContain("Outcome</span>");
    expect(html).toContain("Evidence</span>");
    expect(html).toContain("Average score</span>");
    expect(html).toContain("Latency</span>");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("Did the agent verify the customer");
    expect(html).toContain("55.0%");
    expect(html).toContain("4 metrics");
    expect(html).toContain("Complete");
    expect(html).toContain("Select a case to inspect its saved output");
    expect(html).not.toContain("Expand all");
    expect(html).not.toContain("Actual output");
    expect(html).not.toContain("overflow-x-auto");
  });

  it("shows a compact metric table with score, threshold, coverage, and scoring evidence", () => {
    const metricRun: RunResult = {
      ...run,
      active_metrics: ["llm.correctness", "rag.groundedness", "safety.toxicity"],
      metric_results: [
        {
          metric_id: "llm.correctness",
          evaluator_instance_id: "correctness-v1",
          run_id: "run-1",
          row_id: "case-1",
          score: 0.9,
          normalised_score: 0.9,
          label: null,
          passed: true,
          rationale: "Correct answer.",
          error_message: null,
          threshold: 0.7,
          threshold_result: "pass",
          trace_id: null,
          prompt_version: "v1",
          judge_prompt_tokens: 10,
          judge_completion_tokens: 5,
          judge_total_tokens: 15,
          judge_model: "gpt-4o",
          evaluator_id: "correctness",
          evaluator_version: "1",
          execution_status: "success",
          execution_metadata: {},
        },
        {
          metric_id: "llm.correctness",
          evaluator_instance_id: "correctness-v1",
          run_id: "run-1",
          row_id: "case-2",
          score: 0.4,
          normalised_score: 0.4,
          label: null,
          passed: false,
          rationale: "Incorrect answer.",
          error_message: null,
          threshold: 0.7,
          threshold_result: "fail",
          trace_id: null,
          prompt_version: "v1",
          judge_prompt_tokens: 10,
          judge_completion_tokens: 5,
          judge_total_tokens: 15,
          judge_model: "gpt-4o",
          evaluator_id: "correctness",
          evaluator_version: "1",
          execution_status: "success",
          execution_metadata: {},
        },
        {
          metric_id: "rag.groundedness",
          evaluator_instance_id: "groundedness-v1",
          run_id: "run-1",
          row_id: "case-1",
          score: 0.8,
          normalised_score: 0.8,
          label: null,
          passed: true,
          rationale: "Grounded response.",
          error_message: null,
          threshold: 0.6,
          threshold_result: "pass",
          trace_id: null,
          prompt_version: "v1",
          judge_prompt_tokens: 10,
          judge_completion_tokens: 5,
          judge_total_tokens: 15,
          judge_model: "gpt-4o",
          evaluator_id: "groundedness",
          evaluator_version: "1",
          execution_status: "success",
          execution_metadata: {},
        },
      ],
    };

    const html = renderToStaticMarkup(
      createElement(EmbeddedMetricSummary, { run: metricRun, totalCases: 2 }),
    );

    expect(html).toContain("3 metrics");
    expect(html).toContain("Complete coverage: 1 of 3 metrics");
    expect(html).toContain("2 need attention");
    expect(html).toContain("Average score");
    expect(html).toContain("Case coverage");
    expect(html).toContain("Worst case");
    expect(html).toContain("correctness");
    expect(html).toContain("65.0%");
    expect(html).toContain("Threshold 70% per case");
    expect(html).toContain("1/2");
    expect(html).toContain("50% attempted · 1 scored");
    expect(html).toContain("Not scored");
    expect(html).toContain("View scoring details for correctness");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("No issues");
    expect(html).toContain("Case scoring evidence");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("duration-200");
    expect(html).toContain("does not infer why a metric was missing");

    const summaries = summarizeMetricScores(metricRun, 2);
    const correctness = summaries.find((metric) => metric.id === "llm.correctness");
    expect(correctness?.results).toHaveLength(2);
    expect(correctness?.results[1]?.rationale).toBe("Incorrect answer.");
    expect(correctness?.results[1]?.evaluator_id).toBe("correctness");
  });

  it("presents quality controls as a clear outcome summary with collapsed evidence", () => {
    const qualityRun: RunResult = {
      ...run,
      metric_results: [
        {
          metric_id: "quality.answer_quality",
          evaluator_instance_id: "answer-quality-v1",
          run_id: "run-1",
          row_id: "case-1",
          score: 0.82,
          normalised_score: 0.82,
          label: null,
          passed: true,
          rationale: "The answer met the contract requirement.",
          error_message: null,
          threshold: 0.7,
          threshold_result: "pass",
          trace_id: null,
          prompt_version: "v1",
          judge_prompt_tokens: 10,
          judge_completion_tokens: 5,
          judge_total_tokens: 15,
          judge_model: "gpt-4o",
          evaluator_id: "answer-quality",
          evaluator_version: "1",
          execution_status: "success",
          execution_metadata: {},
        },
      ],
    };

    const html = renderToStaticMarkup(createElement(ReportView, { run: qualityRun }));

    expect(html).toContain("Quality controls");
    expect(html).toContain("1 control evaluated");
    expect(html).toContain("Quality score");
    expect(html).toContain("82%");
    expect(html).toContain("Evidence");
    expect(html).toContain("The answer met the contract requirement.");
    expect(html).not.toContain("View metric evidence");
    expect(html).not.toContain("View 1 evaluated case");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("[Quality contract]");
  });

  it("keeps reviewer context visible and technical run details collapsed in the drawer", () => {
    const html = renderToStaticMarkup(createElement(EmbeddedRunDetails, { run }));

    expect(html).toContain("Dataset");
    expect(html).toContain("ds_demo");
    expect(html).toContain("Target");
    expect(html).toContain("https://example.test/agent");
    expect(html).toContain("Judge");
    expect(html).toContain("gpt-4o");
    expect(html).toContain("Release result");
    expect(html).toContain("Run label");
    expect(html).toContain("No label");
    expect(html).toContain("<details");
    expect(html).toContain("Technical details");
    expect(html).toContain("Target version");
    expect(html).toContain("agent-v3");
    expect(html).toContain("Target version ID");
    expect(html).toContain("target-version-3");
    expect(html).toContain("Quality contract manifest");
    expect(html).toContain("Not recorded");
    expect(html).toContain("run-1");
    expect(html.match(/https:\/\/example\.test\/agent/g)).toHaveLength(1);
    expect(html).toContain("group-open:grid-rows-[1fr]");
    expect(html).toContain("duration-200");
  });

  it("does not present a stored-response dataset identity as an invoked target", () => {
    const stored = {
      ...run,
      response_source: "provided" as const,
      experiment: {
        ...run.experiment!,
        target_endpoint: "golden-dataset:stored.v1",
      },
    };

    const html = renderToStaticMarkup(createElement(EmbeddedRunDetails, { run: stored }));

    expect(html).toContain("Not invoked");
    expect(html).toContain("Requested response source");
    expect(html).not.toContain("golden-dataset:stored.v1");
  });

  it("presents backend capture and evaluation states without inferring a failure type", () => {
    expect(
      caseEvidencePresentation({ capture_state: "complete", evaluation_state: "evaluated" }),
    ).toEqual({
      captureLabel: "Complete",
      evaluationLabel: null,
      captureTone: "positive",
      evaluationTone: null,
    });
    expect(
      caseEvidencePresentation({ capture_state: "partial", evaluation_state: "evaluated" }),
    ).toMatchObject({ captureLabel: "Partial evidence", evaluationLabel: null });
    expect(
      caseEvidencePresentation({
        capture_state: "complete",
        evaluation_state: "technical_error",
      }),
    ).toMatchObject({ captureLabel: "Complete", evaluationLabel: "Technical error" });
    expect(
      caseEvidencePresentation({
        capture_state: "partial",
        evaluation_state: "output_too_large",
      }),
    ).toMatchObject({ captureLabel: "Partial evidence", evaluationLabel: "Output too large" });
    expect(caseEvidencePresentation({})).toMatchObject({
      captureLabel: "Not recorded",
      evaluationLabel: null,
    });
  });

  it("keeps raw expected-output JSON hidden by default", () => {
    const html = renderToStaticMarkup(
      createElement(ExpectedOutputCard, {
        expected: {
          expected_output: "Escalate the request for secondary authentication.",
          internal_code: "RAW-ONLY-VALUE",
        },
        plainText: "Escalate the request for secondary authentication.",
      }),
    );

    expect(html).toContain("Expected response");
    expect(html).toContain("Escalate the request for secondary authentication.");
    expect(html).toContain(">JSON</button>");
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain("RAW-ONLY-VALUE");
    expect(html).not.toContain(">Plain English</button>");
  });

  it("turns JSON-encoded expected output into readable labels", () => {
    const html = renderToStaticMarkup(
      createElement(ExpectedOutputCard, {
        expected: null,
        plainText: JSON.stringify({ decision: "Escalate", secondary_authentication: true }),
      }),
    );

    expect(html).toContain("Decision: Escalate");
    expect(html).toContain("Secondary authentication: true");
    expect(html).not.toContain('&quot;decision&quot;');
  });
});


describe("ReportView disabled Compare CTA", () => {
  const html = renderToStaticMarkup(createElement(ReportView, { run }));

  it("keeps the CTA focusable and names its reason to assistive technology", () => {
    // `disabled` would drop it from the tab order and silence the reason.
    expect(html).toContain('aria-disabled="true"');
    const describedBy = html.match(/aria-describedby="([^"]+-compare-reason)"/);
    expect(describedBy).not.toBeNull();
    // Assert the wiring and the words, not the element's classes — the reason
    // moved out of `sr-only` and became visible, which is the point.
    const reason = html.match(new RegExp(`id="${describedBy![1]!}"[^>]*>([^<]*)<`));
    expect(reason?.[1]).toContain("Loading comparable runs…");
  });

  it("shows the reason to sighted users, not only to assistive technology", () => {
    // `title` is hover-only and never appears on touch, and `sr-only` hides the
    // text outright — so a sighted touch user got a greyed control and no
    // explanation. The header's reason now renders as visible text.
    //
    // Scoped to the header deliberately. The report carries a *second* Compare
    // CTA in the Run outcome section, inside a compact primary/overflow action
    // row where a reason line does not fit; it keeps title + sr-only, and the
    // header's visible reason covers the same question on the same page.
    // The reason appears on hover via `title`, and is announced to assistive
    // technology via `aria-describedby` pointing at the sr-only text.
    //
    // A CSS `group-hover` tooltip was tried instead, to reach keyboard focus as
    // well. It rendered but never revealed on the deployed build — the variant
    // did not survive into the stylesheet — so this is the version that
    // demonstrably works. The keyboard/touch gap is real and stays open under
    // #2919 gap 8 ("explain disabled actions") rather than being papered over
    // with markup that looks right and does nothing.
    const describedBy = html.match(/aria-describedby="([^"]+-compare-reason)"/);
    expect(html).toContain(`id="${describedBy![1]!}" class="sr-only"`);
    expect(html).toContain('title="Loading comparable runs…"');
  });

  it("gives Compare the same frame as its sibling actions", () => {
    // It was a `ghost` variant: no border, while Export and Rescore were
    // outlined and Run evaluation was filled. Three weights for one primary and
    // three secondary actions — and the borderless one read as disabled even
    // when it was not.
    const compare = html.match(/<button[^>]*aria-describedby="[^"]+-compare-reason"[^>]*>/)?.[0] ?? "";
    expect(compare).toContain("border border-input");
  });
});

describe("resolveDeepLinkedCase", () => {
  const items: Array<Pick<(typeof caseItems)[number], "example_id">> = [
    { example_id: "case-alpha" },
    { example_id: "case-beta" },
    { example_id: "42" },
  ];

  it("opens a case when item matches example_id", () => {
    expect(resolveDeepLinkedCase(items, "case-beta")).toEqual({
      status: "matched",
      exampleId: "case-beta",
    });
  });

  it("matches a numeric example_id exactly", () => {
    expect(resolveDeepLinkedCase(items, "42")).toEqual({
      status: "matched",
      exampleId: "42",
    });
  });

  it("never resolves an ordinal to a neighbouring case", () => {
    // "Case 01"/"Case 02" are `sequence_position + 1`, so an ordinal deep link
    // has no unambiguous target: it must miss rather than open the wrong case.
    expect(resolveDeepLinkedCase(items, "1")).toEqual({ status: "not_found" });
    expect(resolveDeepLinkedCase(items, "2")).toEqual({ status: "not_found" });
  });

  it("reports not_found for a genuinely missing id once items are loaded", () => {
    expect(resolveDeepLinkedCase(items, "missing-case")).toEqual({ status: "not_found" });
    expect(resolveDeepLinkedCase(items, "99")).toEqual({ status: "not_found" });
  });
});
