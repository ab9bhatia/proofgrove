import { describe, expect, it } from "vitest";
import type { RunResult } from "@/lib/api";
import {
  evaluateHrefForScenario,
  evaluateHrefFromRun,
  evaluationRunsHref,
  evaluationName,
  formatRunScore,
  parseDatasetNameFromVersion,
  recommendationDetailForRun,
  recommendationForRun,
  rerunEvaluationKind,
  runDetailsHref,
  runDisplayName,
  runInvokesTarget,
  runScenarioTypeLabel,
  scenarioTypeLabel,
} from "@/lib/run-recommendation";

function baseRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    run_id: "run-1",
    status: "completed",
    verdict_status: "conclusive",
    metric_results: [],
    kpi_results: [],
    overall_gate: "pass",
    root_cause: null,
    review_queue: [],
    active_metrics: [],
    started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:01:00Z",
    // Release-governed by default (quality profile + gate policy) so pass copy
    // may reference promotion; lesser-governed cases override the ids to null.
    quality_profile_id: "profile-1",
    quality_profile_version: "1.0.0",
    gate_policy_id: "policy-1",
    gate_policy_version: "1.0.0",
    ...overrides,
  };
}

describe("recommendationForRun", () => {
  it("prefers root-cause remediation", () => {
    const run = baseRun({
      overall_gate: "fail",
      root_cause: {
        root_cause_metric_id: "agent.tool_selection",
        root_cause_label: "Tool selection",
        causal_chain: [],
        failing_metrics: ["agent.tool_selection"],
        recommended_remediation: "Fix: Review tool descriptions and agent routing logic.",
        has_ground_truth: true,
      },
    });
    expect(recommendationForRun(run)).toContain("Review tool descriptions");
  });

  it("falls back by gate when no remediation", () => {
    expect(recommendationForRun(baseRun({ overall_gate: "pass" }))).toContain("Safe to promote");
    expect(recommendationForRun(baseRun({ overall_gate: "warn" }))).toContain("Marginal");
    expect(recommendationForRun(baseRun({ overall_gate: "fail" }))).toContain("Quality gate failed");
  });

  it("a release-governed Pass may claim promotion but an ungoverned Pass may not", () => {
    const governed = recommendationForRun(baseRun({ overall_gate: "pass" }));
    const ungoverned = recommendationForRun(
      baseRun({
        overall_gate: "pass",
        quality_profile_id: null,
        quality_profile_version: null,
        gate_policy_id: null,
        gate_policy_version: null,
      }),
    );

    expect(governed).toContain("Safe to promote");
    expect(ungoverned).not.toContain("Safe to promote");
    expect(ungoverned).toContain("no quality contract governs this run");
    // The two Pass recommendations must be materially different copy.
    expect(governed).not.toBe(ungoverned);
  });

  it("treats a quality-governed Pass with no gate policy as a baseline, not promotion", () => {
    const qualityOnly = recommendationForRun(
      baseRun({
        overall_gate: "pass",
        gate_policy_id: null,
        gate_policy_version: null,
      }),
    );
    // Quality passed → valid comparison baseline, but promotion is not authorised.
    expect(qualityOnly).toContain("comparison baseline");
    expect(qualityOnly).not.toContain("Safe to promote");
    // Still distinct from the ungoverned message.
    expect(qualityOnly).not.toContain("no quality contract governs this run");
  });

  it("treats a lineage-only quality profile as a baseline, not promotion", () => {
    const lineageQuality = recommendationForRun(
      baseRun({
        overall_gate: "pass",
        quality_profile_id: null,
        gate_policy_id: null,
        gate_policy_version: null,
        lineage: { quality_profile_id: "profile-from-lineage" },
      }),
    );
    expect(lineageQuality).toContain("comparison baseline");
    expect(lineageQuality).not.toContain("Safe to promote");
  });

  it("keeps a passing recommendation when historical root-cause evidence is stale", () => {
    const run = baseRun({
      overall_gate: "pass",
      root_cause: {
        root_cause_metric_id: "rag.context_sufficiency",
        root_cause_label: "Context sufficiency",
        causal_chain: ["Increase retrieval coverage."],
        failing_metrics: ["rag.context_sufficiency"],
        recommended_remediation: "Review failing evaluation evidence before promoting.",
        has_ground_truth: true,
      },
    });

    expect(recommendationForRun(run)).toContain("Quality gates passed");
    expect(recommendationForRun(run)).not.toContain("failing evaluation evidence");
  });

  it("does not turn missing evidence into a quality-remediation recommendation", () => {
    const run = baseRun({
      verdict_status: "inconclusive",
      overall_gate: null,
      root_cause: {
        root_cause_metric_id: "agent.tool_selection",
        root_cause_label: "Tool selection",
        causal_chain: ["Rewrite the tool prompt"],
        failing_metrics: ["agent.tool_selection"],
        recommended_remediation: "Rewrite the tool prompt.",
        has_ground_truth: true,
      },
    });
    expect(recommendationForRun(run)).toContain("Required evidence");
    expect(recommendationForRun(run)).not.toContain("Rewrite the tool prompt");
  });

  it("keeps stored-response recommendations on the underlying scoring scenario", () => {
    const detail = recommendationDetailForRun(
      baseRun({
        response_source: "provided",
        experiment: {
          name: "Stored results",
          dataset_version: "stored.v1",
          target_endpoint: "golden-dataset:stored",
          scenario: "llm_core",
          market: "global",
          judge_model: "judge-1",
          judge_temperature: 0,
          has_ground_truth: true,
        },
      }),
    );

    expect(detail.example).toContain("refusal style guide");
    expect(detail.example).not.toContain("agent KPIs");
  });
});

describe("run helpers", () => {
  it("formats score from KPI composites", () => {
    const run = baseRun({
      kpi_results: [
        {
          kpi_id: "k1",
          run_id: "run-1",
          composite_score: 0.8,
          gate_result: "pass",
          constituent_scores: [],
          threshold_pass: 0.7,
          threshold_warn: 0.5,
          threshold_fail: 0.3,
          evaluated_target: "t",
        },
        {
          kpi_id: "k2",
          run_id: "run-1",
          composite_score: 0.6,
          gate_result: "warn",
          constituent_scores: [],
          threshold_pass: 0.7,
          threshold_warn: 0.5,
          threshold_fail: 0.3,
          evaluated_target: "t",
        },
      ],
    });
    expect(formatRunScore(run)).toBe("70%");
  });

  it("maps scenario labels and evaluate hrefs", () => {
    expect(scenarioTypeLabel("agentic")).toBe("Agent");
    expect(scenarioTypeLabel("rag")).toBe("RAG");
    expect(scenarioTypeLabel("llm_core")).toBe("LLM");
    expect(runScenarioTypeLabel(baseRun({ response_source: "provided" }))).toBe(
      "Existing responses",
    );
    expect(evaluateHrefForScenario("rag")).toBe("/evaluate?type=rag");
    expect(evaluateHrefForScenario("llm_core")).toBe("/evaluate?type=llm");
    expect(evaluateHrefForScenario("agentic")).toBe("/evaluate?type=agent");
  });

  it("builds the canonical progress and report href for a run", () => {
    expect(runDetailsHref("run/123")).toBe("/runs/run%2F123");
  });

  it("opens run history with a newly launched run highlighted", () => {
    expect(evaluationRunsHref("run/123")).toBe("/evaluations?highlight=run%2F123");
  });

  it("builds rerun href with last-run parameters", () => {
    const href = evaluateHrefFromRun(
      baseRun({
        active_metrics: ["agent.task_adherence", "quality.task_completion"],
        experiment: {
          name: "Demo",
          dataset_version: "demo-ds.v3",
          target_endpoint: "tenant-classroom/fraud-agent",
          scenario: "agentic",
          market: "global",
          judge_model: "gpt-4o",
          judge_temperature: 0,
          has_ground_truth: true,
        },
      }),
    );
    expect(href.startsWith("/evaluate?type=agent&")).toBe(true);
    expect(href).toContain("rerun=1");
    expect(href).toContain("dataset=demo-ds");
    expect(href).toContain("agent=tenant-classroom%2Ffraud-agent");
    expect(href).toContain("judgeModel=gpt-4o");
    expect(href).toContain("metrics=agent.task_adherence");
    expect(href).toContain("applyContracts=1");
    expect(href).toContain("contractMetrics=quality.task_completion");
    expect(href).toContain("fromRun=run-1");
    expect(parseDatasetNameFromVersion("demo-ds.v3")).toBe("demo-ds");
  });

  it("prefers an agent target over an LLM scoring scenario for legacy reruns", () => {
    const run = baseRun({
      active_metrics: ["llm.correctness"],
      experiment: {
        name: "Agent scored for correctness",
        dataset_version: "agent-ds.v1",
        target_endpoint: "tenant-classroom/support-agent",
        scenario: "llm_core",
        market: "global",
        judge_model: "gpt-4o",
        judge_temperature: 0,
        has_ground_truth: true,
      },
    });

    expect(rerunEvaluationKind(run)).toBe("agent");
    expect(evaluateHrefFromRun(run)).toContain("/evaluate?type=agent&");
  });

  it("carries the source run's tracing Project into the rerun href", () => {
    const experiment = {
      name: "Demo",
      dataset_version: "demo-ds.v3",
      target_endpoint: "tenant-classroom/fraud-agent",
      scenario: "agentic" as const,
      market: "global",
      judge_model: "gpt-4o",
      judge_temperature: 0,
      has_ground_truth: true,
    };
    const withProject = evaluateHrefFromRun(
      baseRun({ experiment: { ...experiment, project_id: "project-fraud" } }),
    );
    expect(withProject).toContain("project=project-fraud");

    // Lineage is the fallback authority when the experiment lacks the binding.
    const fromLineage = evaluateHrefFromRun(
      baseRun({
        experiment,
        lineage: { project_id: "project-lineage" },
      }),
    );
    expect(fromLineage).toContain("project=project-lineage");

    // An unassigned run must not invent a Project selection.
    const withoutProject = evaluateHrefFromRun(baseRun({ experiment }));
    expect(withoutProject).not.toContain("project=");
  });

  it("includes label and run id when requested", () => {
    const href = evaluateHrefFromRun(
      baseRun({
        run_id: "run-123",
        label: "baseline-v2",
        experiment: {
          name: "Demo",
          dataset_version: "demo-ds.v1",
          target_endpoint: "tenant-classroom/fraud-agent",
          scenario: "agentic",
          market: "global",
          judge_model: "gpt-4o",
          judge_temperature: 0,
          has_ground_truth: true,
          tags: { label: "baseline-v2" },
        },
      }),
      { includeRunId: true },
    );
    expect(href).toContain("label=baseline-v2");
    expect(href).toContain("run=run-123");
    expect(href).toContain("fromRun=run-123");
  });

  it("builds llm rerun href with catalog model id", () => {
    const href = evaluateHrefFromRun(
      baseRun({
        active_metrics: ["llm.correctness"],
        experiment: {
          name: "LLM Demo",
          dataset_version: "llm-ds.v1",
          target_endpoint: "llm-catalog:gpt-4o",
          target_version: "gpt-4o",
          scenario: "llm_core",
          market: "global",
          judge_model: "",
          judge_temperature: 0,
          has_ground_truth: true,
        },
      }),
    );
    expect(href.startsWith("/evaluate?type=llm&")).toBe(true);
    expect(href).toContain("targetModel=gpt-4o");
    expect(href).not.toContain("endpoint=");
  });

  it("preserves provided and baseline sources without target parameters", () => {
    const provided = baseRun({
      experiment: {
        name: "Stored results",
        dataset_version: "stored.v1",
        target_endpoint: "golden-dataset:stored",
        scenario: "llm_core",
        market: "global",
        judge_model: "judge-1",
        judge_temperature: 0,
        has_ground_truth: true,
      },
      lineage: { resolved_target_provenance: { target_type: "provided" } },
    });
    const providedHref = evaluateHrefFromRun(provided);
    expect(rerunEvaluationKind(provided)).toBe("provided");
    expect(providedHref.startsWith("/evaluate?type=provided&")).toBe(true);
    expect(providedHref).not.toContain("targetModel=");
    expect(providedHref).not.toContain("agent=");
    expect(runScenarioTypeLabel(provided)).toBe("Existing responses");
    expect(runInvokesTarget(provided)).toBe(false);

    const baseline = baseRun({
      ...provided,
      lineage: { resolved_target_provenance: { target_type: "baseline" } },
    });
    expect(rerunEvaluationKind(baseline)).toBe("baseline");
    expect(runInvokesTarget(baseline)).toBe(false);
    expect(evaluateHrefFromRun(baseline).startsWith("/evaluate?type=baseline&")).toBe(true);
    expect(runInvokesTarget(baseRun({ response_source: "agent" }))).toBe(true);
    expect(runInvokesTarget(baseRun({ response_source: "llm" }))).toBe(true);
  });

  it("resolves evaluation name from tags and formats display name with label", () => {
    const run = baseRun({
      label: "v2",
      experiment: {
        name: "dataset (agent)",
        dataset_version: "dataset.v1",
        target_endpoint: "ns/agent",
        scenario: "agentic",
        market: "global",
        judge_model: "gpt-4o",
        judge_temperature: 0,
        has_ground_truth: true,
        tags: { evaluation_name: "Fraud agent quality gate", label: "v2" },
      },
    });
    expect(evaluationName(run)).toBe("Fraud agent quality gate");
    expect(runDisplayName(run)).toBe("Fraud agent quality gate · v2");
  });
});

describe("selected-tools rerun continuity", () => {
  it("carries the historical tool selection into the rerun href", () => {
    const href = evaluateHrefFromRun(
      baseRun({
        lineage: {
          resolved_evaluation_scope: "tool_interactions",
          selected_tool_ids: ["search", "calculator"],
        },
        experiment: {
          name: "Demo",
          dataset_version: "demo-ds.v3",
          target_endpoint: "tenant-classroom/fraud-agent",
          scenario: "agentic",
          market: "global",
          judge_model: "gpt-4o",
          judge_temperature: 0,
          has_ground_truth: true,
        },
      }),
    );
    expect(href).toContain("evaluationScope=tool_interactions");
    expect(href).toContain(`tools=${encodeURIComponent("search,calculator")}`);
  });

  it("carries the saved prompt reference into the rerun href", () => {
    const href = evaluateHrefFromRun(
      baseRun({
        lineage: { target_prompt_ref: "support-policy@3" },
        experiment: {
          name: "Demo",
          dataset_version: "demo-ds.v3",
          target_endpoint: "llm-catalog:gpt-4o",
          target_version: "gpt-4o",
          scenario: "llm_core",
          market: "global",
          judge_model: "gpt-4o",
          judge_temperature: 0,
          has_ground_truth: true,
        },
      }),
    );
    expect(href).toContain("promptRef=support-policy%403");
  });

  it("omits the tools param when the run evaluated the whole tool layer", () => {
    const href = evaluateHrefFromRun(
      baseRun({
        lineage: { resolved_evaluation_scope: "tool_interactions" },
        experiment: {
          name: "Demo",
          dataset_version: "demo-ds.v3",
          target_endpoint: "tenant-classroom/fraud-agent",
          scenario: "agentic",
          market: "global",
          judge_model: "gpt-4o",
          judge_temperature: 0,
          has_ground_truth: true,
        },
      }),
    );
    expect(href).not.toContain("tools=");
  });
});

describe("runInvokesTarget", () => {
  it("answers unknown for a run that records neither source nor endpoint", () => {
    // `!undefined` is true, so the fallback first answered "invoked" for a run
    // carrying nothing to say so. Answering "not invoked" instead only swapped
    // one claim for another: both assert something about a run that recorded
    // nothing. Null is the honest answer, and callers render it as not recorded.
    const run = baseRun({ experiment: { ...baseRun().experiment, target_endpoint: undefined } } as never);
    expect(runInvokesTarget(run)).toBeNull();
  });

  it("still reports a real endpoint as invoked, and a golden-dataset one as not", () => {
    const invoked = baseRun({
      experiment: { ...baseRun().experiment, target_endpoint: "http://agent.test/v1/chat" },
    } as never);
    const baseline = baseRun({
      experiment: { ...baseRun().experiment, target_endpoint: "golden-dataset:claims" },
    } as never);
    expect(runInvokesTarget(invoked)).toBe(true);
    expect(runInvokesTarget(baseline)).toBe(false);
  });
});
