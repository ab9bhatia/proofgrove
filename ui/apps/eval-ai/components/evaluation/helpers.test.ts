import { describe, expect, it } from "vitest";

import type { EvidenceReadinessResult } from "@/lib/api";
import {
  approximateRunDuration,
  applicableScoringMetricIds,
  COMPARE_AXES,
  comparisonSummaryLabel,
  offerableCompareAxes,
  survivingCompareRefs,
  buildDatasetRunRequest,
  computeRunReady,
  depthOptionClassName,
  depthOptionState,
  evaluationDepthVisible,
  hasContractMetricNotApplicable,
  normalizeToolSelection,
  restoredProjectState,
  reviewSummaryItems,
} from "./helpers";

describe("run duration estimate", () => {
  it("scales with depth, judge use, cases, and parallel requests", () => {
    expect(approximateRunDuration({ caseCount: 10, scope: "tool_interactions", judgeEnabled: true, parallelRequests: 5 })).toBe("~4 min 12 s");
    expect(approximateRunDuration({ caseCount: 10, scope: "full_execution", judgeEnabled: true, parallelRequests: 5 })).toBe("~6 min 18 s");
    expect(approximateRunDuration({ caseCount: 10, scope: "tool_interactions", judgeEnabled: false, parallelRequests: 10 })).toBe("~1 min 30 s");
    expect(approximateRunDuration({ caseCount: null, scope: "final_response", judgeEnabled: false, parallelRequests: 5 })).toBeNull();
  });
});

describe("evaluation depth copy", () => {
  it("shows depth controls for all evaluation kinds", () => {
    expect(evaluationDepthVisible("agent")).toBe(true);
    expect(evaluationDepthVisible("llm")).toBe(true);
    expect(evaluationDepthVisible("provided")).toBe(true);
    expect(evaluationDepthVisible(null)).toBe(false);
  });

  it("keeps an availability caveat alongside an enabled depth", () => {
    expect(depthOptionState([
      {
        scope: "tool_interactions",
        available: true,
        caveat: "Capture is available, but tool checks are not applicable.",
      },
    ], "tool_interactions")).toEqual({
      disabled: false,
      reason: null,
      caveat: "Capture is available, but tool checks are not applicable.",
    });
  });

  it("shows the backend reason when a provided source cannot go deeper", () => {
    expect(depthOptionState([
      {
        scope: "tool_interactions",
        available: false,
        reason: "provided sources cannot provide tool-interaction evidence in V1.",
      },
    ], "tool_interactions")).toEqual({
      disabled: true,
      reason: "provided sources cannot provide tool-interaction evidence in V1.",
      caveat: null,
    });
  });
});

function readiness(overrides: Partial<EvidenceReadinessResult> = {}): EvidenceReadinessResult {
  return {
    status: "ready",
    evaluation_scope: "final_response",
    requested_evaluation_scope: "final_response",
    resolved_evaluation_scope: "final_response",
    scope_promotion_reasons: [],
    effective_evidence_requirements: [],
    metric_applicability: [],
    details: [],
    requested_provenance: {},
    resolved_provenance: {},
    ...overrides,
  };
}

describe("buildDatasetRunRequest", () => {
  it("sends the user's requested evaluation depth", () => {
    const request = buildDatasetRunRequest({
      kind: "llm",
      evaluationName: "  Fraud gate  ",
      runLabel: "baseline",
      agentId: "",
      selectedLlm: { model_id: "gpt-x", endpoint: null },
      judgeModel: "judge-1",
      judgeEnabled: true,
      activeMetricIds: ["llm.correctness", "ops.latency"],
      parallelRequests: 5,
      humanReview: false,
      applyContracts: false,
      selectedContracts: [],
      projectId: "",
      evaluationScope: "tool_interactions",
    });

    expect(request.evaluation_scope).toBe("tool_interactions");
    expect(request.evaluation_name).toBe("Fraud gate");
    expect(request.active_metrics).toEqual(["llm.correctness", "ops.latency"]);
    expect(request.target_endpoint).toBe("llm-catalog:gpt-x");
  });

  it("derives response_source from the chosen kind alone", () => {
    // The mode is the user's explicit choice in step 1. Nothing about the dataset
    // reaches this decision.
    const base = {
      evaluationName: "Fraud gate",
      runLabel: null,
      agentId: "agent-7",
      selectedLlm: { model_id: "gpt-x", endpoint: null },
      judgeModel: null,
      judgeEnabled: false,
      activeMetricIds: ["llm.correctness"],
      parallelRequests: 5,
      humanReview: false,
      applyContracts: false,
      selectedContracts: [],
      projectId: "",
      evaluationScope: "final_response" as const,
    };

    expect(buildDatasetRunRequest({ ...base, kind: "agent" }).response_source).toBe("agent");
    expect(buildDatasetRunRequest({ ...base, kind: "llm" }).response_source).toBe("llm");
    const provided = buildDatasetRunRequest({
      ...base,
      kind: "provided",
      systemPrompt: "must not be sent",
    });
    expect(provided.response_source).toBe("provided");
    expect(provided.agent).toBeNull();
    expect(provided.target_endpoint).toBeNull();
    expect(provided.target_model).toBeNull();
    expect(provided.system_prompt).toBeNull();

    // The target each mode sends follows the same single choice.
    expect(buildDatasetRunRequest({ ...base, kind: "agent" }).agent).toBe("agent-7");
    expect(buildDatasetRunRequest({ ...base, kind: "agent" }).target_endpoint).toBeNull();
    expect(buildDatasetRunRequest({ ...base, kind: "llm" }).agent).toBeNull();
    expect(buildDatasetRunRequest({ ...base, kind: "llm" }).target_endpoint).toBe(
      "llm-catalog:gpt-x",
    );
  });

  it("omits assignment fields for a diagnostic run", () => {
    const request = buildDatasetRunRequest({
      kind: "llm",
      evaluationName: "Fraud gate",
      runLabel: null,
      agentId: "",
      selectedLlm: { model_id: "gpt-x", endpoint: null },
      judgeModel: null,
      judgeEnabled: false,
      activeMetricIds: ["llm.correctness"],
      parallelRequests: 5,
      humanReview: false,
      applyContracts: false,
      selectedContracts: [],
      projectId: "project-a",
      evaluationScope: "final_response",
    });
    expect(request.assignment_id).toBeNull();
    expect(request.assignment_version).toBeNull();
    expect(request.quality_contract_ids).toEqual([]);
  });

  it("sends the explicit assignment version and drops rubric templates", () => {
    const request = buildDatasetRunRequest({
      kind: "agent",
      evaluationName: "Claims release",
      runLabel: "candidate",
      agentId: "ns/claims",
      selectedLlm: null,
      judgeModel: null,
      judgeEnabled: false,
      activeMetricIds: ["llm.correctness"],
      parallelRequests: 5,
      humanReview: true,
      applyContracts: true,
      selectedContracts: ["qc_tpl_response_clarity"],
      projectId: "project-a",
      evaluationScope: "final_response",
      assignmentId: "claims-release",
      assignmentVersion: "1.0.0",
    });
    expect(request).not.toHaveProperty("active_metrics");
    expect(request.assignment_id).toBe("claims-release");
    expect(request.assignment_version).toBe("1.0.0");
    expect(request.quality_contract_ids).toEqual([]);
  });
});

describe("applicability-aware scoring", () => {
  it("excludes a known_not_applicable metric from the scored request and check count", () => {
    const resolved = ["llm.correctness", "rag.faithfulness", "ops.latency"];
    const ready = readiness({
      status: "blocked",
      metric_applicability: [
        { metric_id: "llm.correctness", applicability: "known_applicable" },
        { metric_id: "rag.faithfulness", applicability: "known_not_applicable", reason: "No retrieved context in this dataset." },
      ],
    });

    const active = applicableScoringMetricIds(resolved, ready);
    expect(active).toEqual(["llm.correctness", "ops.latency"]);
    expect(active).not.toContain("rag.faithfulness");
    // The displayed check count excludes operations metrics too.
    expect(active.filter((id) => !id.startsWith("ops.")).length).toBe(1);
  });

  it("returns the full selection unchanged before readiness is known", () => {
    const resolved = ["llm.correctness", "rag.faithfulness"];
    expect(applicableScoringMetricIds(resolved, null)).toEqual(resolved);
  });

  it("keeps a contract-required metric that is not applicable and flags it as blocking", () => {
    const resolved = ["llm.correctness", "quality.tone"];
    const ready = readiness({
      status: "blocked",
      metric_applicability: [
        { metric_id: "quality.tone", applicability: "known_not_applicable", reason: "Tone rubric does not apply." },
      ],
      details: [{ code: "contract_metric_not_applicable", message: "Tone is not applicable to this dataset." }],
    });
    const protectedIds = ["quality.tone"];

    // The rubric-required metric stays in the request so it remains visibly locked.
    expect(applicableScoringMetricIds(resolved, ready, protectedIds)).toContain("quality.tone");
    expect(hasContractMetricNotApplicable(protectedIds, ready)).toBe(true);
    expect(hasContractMetricNotApplicable(["llm.correctness"], ready)).toBe(false);
  });
});

describe("computeRunReady", () => {
  const ready = readiness({ status: "ready" });

  it("is ready only when setup is complete, nothing is blocked, and the check has resolved", () => {
    expect(computeRunReady({ setupReady: true, contractMetricBlocked: false, readinessChecking: false, readiness: ready })).toBe(true);
  });

  it("is not ready while a stale 'ready' readiness is still being re-checked after a config change", () => {
    // Even though the previous readiness result still says "ready", the checking flag disables Run
    // until the debounced re-check resolves, so no stale "Ready to run" can leak through.
    expect(computeRunReady({ setupReady: true, contractMetricBlocked: false, readinessChecking: true, readiness: ready })).toBe(false);
  });

  it("is not ready when setup is incomplete, a contract metric is blocked, or readiness is not ready", () => {
    expect(computeRunReady({ setupReady: false, contractMetricBlocked: false, readinessChecking: false, readiness: ready })).toBe(false);
    expect(computeRunReady({ setupReady: true, contractMetricBlocked: true, readinessChecking: false, readiness: ready })).toBe(false);
    expect(computeRunReady({ setupReady: true, contractMetricBlocked: false, readinessChecking: false, readiness: readiness({ status: "blocked" }) })).toBe(false);
    expect(computeRunReady({ setupReady: true, contractMetricBlocked: false, readinessChecking: false, readiness: null })).toBe(false);
  });
});

describe("selected-tools level", () => {
  const baseInputs = {
    kind: "agent" as const,
    evaluationName: "Fraud gate",
    runLabel: null,
    agentId: "ns/agent",
    endpoint: "",
    targetModel: "",
    selectedLlm: null,
    judgeModel: null,
    judgeEnabled: false,
    activeMetricIds: ["agent.tool_selection"],
    parallelRequests: 5,
    humanReview: false,
    applyContracts: false,
    selectedContracts: [],
    projectId: "",
  };

  it("sends selected_tool_ids with the tool_interactions depth", () => {
    const request = buildDatasetRunRequest({
      ...baseInputs,
      evaluationScope: "tool_interactions",
      selectedToolIds: ["search"],
    });
    expect(request.selected_tool_ids).toEqual(["search"]);
  });

  it("sends the whole tool layer (null) when no named selection exists", () => {
    const request = buildDatasetRunRequest({
      ...baseInputs,
      evaluationScope: "tool_interactions",
      selectedToolIds: null,
    });
    expect(request.selected_tool_ids).toBeNull();
  });

  it("never sends a tool selection for other depths", () => {
    const request = buildDatasetRunRequest({
      ...baseInputs,
      evaluationScope: "final_response",
      selectedToolIds: ["search"],
    });
    expect(request.selected_tool_ids).toBeNull();
  });

  it("normalizes a full selection back to the whole tool layer", () => {
    expect(normalizeToolSelection(["b", "a"], ["a", "b"])).toBeNull();
    expect(normalizeToolSelection(["a"], ["a", "b"])).toEqual(["a"]);
    expect(normalizeToolSelection(null, ["a", "b"])).toBeNull();
    // Unknown inventory: keep the explicit selection so the backend can
    // validate it honestly instead of silently dropping it.
    expect(normalizeToolSelection(["a"], null)).toEqual(["a"]);
    // An explicitly empty selection is preserved (the backend rejects it).
    expect(normalizeToolSelection([], ["a"])).toEqual([]);
  });
});

describe("restoredProjectState", () => {
  const projects = [
    { project_id: "proj-active", purpose: "system" },
    { project_id: "proj-registry", purpose: "catalog_registry" },
  ];

  it("restores an active system Project without a notice", () => {
    expect(restoredProjectState("proj-active", projects)).toEqual({
      projectId: "proj-active",
      notice: null,
    });
  });

  it("surfaces an explicit notice when the original Project is unavailable", () => {
    const archived = restoredProjectState("proj-archived", projects);
    expect(archived.projectId).toBeNull();
    expect(archived.notice).toMatch(/archived or unavailable/);
    // A non-system (registry) Project is equally non-restorable.
    const registry = restoredProjectState("proj-registry", projects);
    expect(registry.projectId).toBeNull();
    expect(registry.notice).toMatch(/archived or unavailable/);
  });

  it("stays silent when no Project was carried on the rerun", () => {
    expect(restoredProjectState(null, projects)).toEqual({ projectId: null, notice: null });
    expect(restoredProjectState("", projects)).toEqual({ projectId: null, notice: null });
  });
});

describe("depth option appearance", () => {
  it("keeps a focus ring that selection styling cannot stand in for", () => {
    const enabled = depthOptionClassName({ disabled: false });
    const blocked = depthOptionClassName({ disabled: true });

    for (const className of [enabled, blocked]) {
      expect(className).toContain("focus-visible:ring-2");
      expect(className).toContain("focus-visible:ring-ring");
      // Selection moved onto ``aria-checked`` and is styled from that attribute
      // in CSS, so it must not reappear here: a selected ring in the same class
      // string is exactly what would let focus be inferred from selection.
      expect(className).not.toContain("ring-brand-text");
    }
    expect(blocked).toContain("cursor-not-allowed");
  });
});

describe("reviewSummaryItems", () => {
  it("lists Target once among the review labels", () => {
    const items = reviewSummaryItems({
      evaluationName: "Groundedness",
      targetSummary: "Agent A",
      datasetLabel: "cases.v1",
      depthLabel: "Final response",
      checkCount: 3,
    });
    const labels = items.map((item) => item.label);
    expect(labels).toEqual([
      "Evaluation",
      "Target",
      "Dataset",
      "Depth",
      "Checks",
    ]);
    expect(labels.filter((label) => label === "Target")).toHaveLength(1);
    expect(labels).not.toContain("Attach to");
  });
});

describe("comparison axis", () => {
  it("starts with no comparison, so nothing is chosen for the user", () => {
    // The control shipped defaulting to "models", which rendered as selected
    // before the user had chosen anything — and could not be cleared.
    expect(COMPARE_AXES[0]!.value).toBe("none");
  });

  it("offers varying prompts only when there is a library to vary across", () => {
    expect(offerableCompareAxes(true).map((axis) => axis.value)).toEqual([
      "none",
      "models",
      "prompts",
    ]);
    expect(offerableCompareAxes(false).map((axis) => axis.value)).toEqual(["none", "models"]);
  });

  it("keeps an off state reachable whether or not prompts are saved", () => {
    // Without this the only way out of a comparison was to unpick every target.
    expect(offerableCompareAxes(true).some((axis) => axis.value === "none")).toBe(true);
    expect(offerableCompareAxes(false).some((axis) => axis.value === "none")).toBe(true);
  });

  it("reports nothing when no comparison is configured", () => {
    expect(comparisonSummaryLabel("none", { prompts: 3, models: 2 })).toBeNull();
    // An axis chosen but no targets picked still launches a single run.
    expect(comparisonSummaryLabel("models", { prompts: 0, models: 0 })).toBeNull();
  });

  it("counts only the axis being varied", () => {
    expect(comparisonSummaryLabel("models", { prompts: 3, models: 2 })).toBe("2 models");
    expect(comparisonSummaryLabel("prompts", { prompts: 3, models: 2 })).toBe("3 prompts");
    expect(comparisonSummaryLabel("models", { prompts: 0, models: 1 })).toBe("1 model");
  });
});

describe("comparison targets after a reload", () => {
  it("keeps only the refs the catalog still offers", () => {
    // A failed prompt request falls back to an empty catalog. Refs surviving
    // that were invisible in the picker but still counted by the launch gate,
    // so Run fired several runs the user could not see configured.
    expect(survivingCompareRefs(["a@1", "b@2"], ["a@1"])).toEqual(["a@1"]);
    expect(survivingCompareRefs(["a@1", "b@2"], [])).toEqual([]);
  });

  it("leaves an intact selection alone", () => {
    expect(survivingCompareRefs(["a@1", "b@2"], ["b@2", "a@1", "c@3"])).toEqual(["a@1", "b@2"]);
  });
});
