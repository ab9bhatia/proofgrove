/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { EvaluationScopeOption, EvidenceReadinessResult, MetricCatalogEntry } from "@/lib/api";
import {
  backendRequirementForMetric,
  blockingReasonForMetric,
  filterMetricSelection,
  groupSelectionState,
  groupToggleTargets,
  metricLockedByContract,
  metricMeaning,
  MetricSelectionPanel,
  metricEvidenceLabel,
  metricEvidenceScope,
  metricUnavailableReason,
  resolvedMetricStatus,
} from "./metric-selection-panel";

afterEach(cleanup);

import { ScoringSummary } from "./evaluation/scoring-summary";

it("shows Assignment checks as fixed and prevents removal", () => {
  let removed = false;
  render(createElement(ScoringSummary, {
    metrics: [{ metric_id: "quality.groundedness", name: "Groundedness", description: "Check groundedness" }],
    selectedCount: 1, offeredCount: 26, readiness: null, lockedByAssignment: true,
    onRemove: () => { removed = true; },
  }));
  expect(screen.getByText("1 fixed")).toBeTruthy();
  const check = screen.getByRole("button", { name: "Groundedness, fixed by assignment" }) as HTMLButtonElement;
  expect(check.disabled).toBe(true);
  fireEvent.click(check);
  expect(removed).toBe(false);
  expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
});

it("shows Assignment loading and failure instead of an empty check selection", () => {
  const props = { metrics: [], selectedCount: 0, offeredCount: 26, readiness: null, lockedByAssignment: true, onRemove: () => {} };
  const view = render(createElement(ScoringSummary, { ...props, loading: true }));
  expect(screen.getByRole("status").textContent).toContain("Loading Assignment checks");
  expect(screen.queryByText("No quality checks selected")).toBeNull();
  view.rerender(createElement(ScoringSummary, { ...props, error: "Could not load Assignment checks" }));
  expect(screen.getByRole("alert").textContent).toBe("Could not load Assignment checks");
});


const metrics: MetricCatalogEntry[] = [
  {
    metric_id: "agent.task_adherence",
    name: "Task Adherence",
    description: "Agent completed the assigned task",
    scenario: "agentic",
    default_adapter: "native",
    requires_trace: true,
    required_evidence_categories: ["tool_calls", "tool_results"],
  },
  {
    metric_id: "llm.correctness",
    name: "Correctness",
    description: "Factual accuracy",
    scenario: "llm_core",
    default_adapter: "deepeval",
  },
  {
    metric_id: "ops.latency",
    name: "Execution Latency",
    description: "End-to-end response latency",
    default_adapter: "deterministic",
  },
  {
    metric_id: "nlp.bleu",
    name: "BLEU",
    description: "N-gram precision",
    default_adapter: "deterministic",
    catalog_diagnostic_default: true,
  },
];

/** A readiness payload carrying only the per-depth availability under test. */
function readinessWithScopes(scope_options: EvaluationScopeOption[]): EvidenceReadinessResult {
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
    scope_options,
  };
}

describe("metric selection panel", () => {
  it("cautions on RAG checks for an agent with a resolved empty tool inventory", () => {
    const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "agent",
      metrics: [{
        metric_id: "rag.groundedness",
        name: "Groundedness",
        description: "Answer support from retrieved context",
      }],
      selectedMetricIds: [],
      recommendedMetricIds: [],
      readiness: {
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
        agent_tools: [],
      },
      onToggle: () => undefined,
    }));

    expect(html).toContain(
      "May not apply — no retrieval tool detected on this agent; runs will be unscored if no retrieval evidence is captured.",
    );
    expect(html).not.toContain('disabled=""');
  });

  it("renders all check families in one catalog and hides operations metrics", () => {
    const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "agent",
      metrics,
      selectedMetricIds: ["agent.task_adherence", "llm.correctness", "nlp.bleu"],
      recommendedMetricIds: ["agent.task_adherence", "llm.correctness"],
      onToggle: () => undefined,
    }));

    // Renamed groups.
    expect(html).toContain("LLM quality");
    expect(html).toContain("Agent behavior");
    expect(html).toContain("NLP diagnostics");
    // Recommended-checks summary cards are gone.
    expect(html).not.toContain("Recommended checks");
    expect(html).not.toContain("Response quality");
    expect(html).not.toContain("Customize checks");
    // Operations metrics are hidden and never offered for selection.
    expect(html).not.toContain("Execution Latency");
    expect(html).not.toContain("Performance");
    expect(html).toContain('aria-label="Search checks"');
    // Catalog rows lead with stable ids, not display names.
    expect(html).toContain("agent.task_adherence");
    expect(html).toContain("nlp.bleu");
  });

  it("uses one described button per check without nested interactive controls", () => {
    const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "agent",
      metrics: [metrics[1]],
      selectedMetricIds: ["llm.correctness"],
      recommendedMetricIds: [],
      onToggle: () => undefined,
    }));

    // The row button is described by the metric's explanatory text via a stable id.
    expect(html).toContain('aria-describedby="metric-desc-llm.correctness"');
    expect(html).toContain('id="metric-desc-llm.correctness"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain("Technical details");
  });

  it("disables a known_not_applicable metric and shows the backend reason", () => {
    const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "agent",
      metrics,
      selectedMetricIds: ["llm.correctness"],
      recommendedMetricIds: [],
      readiness: {
        status: "blocked" as const,
        evaluation_scope: "final_response" as const,
        requested_evaluation_scope: "final_response" as const,
        resolved_evaluation_scope: "final_response" as const,
        scope_promotion_reasons: [],
        effective_evidence_requirements: [],
        metric_applicability: [
          { metric_id: "agent.task_adherence", applicability: "known_not_applicable" as const, reason: "No tool evidence in this dataset." },
        ],
        details: [],
        requested_provenance: {},
        resolved_provenance: {},
      },
      onToggle: () => undefined,
    }));

    expect(html).toContain("Not applicable: No tool evidence in this dataset.");
    // The not-applicable check renders a disabled control.
    expect(html).toContain("disabled=\"\"");
  });

  it("groups checks by user meaning instead of catalog prefixes", () => {
    expect(metrics.map(metricMeaning)).toEqual(["tools", "answer", "performance", "diagnostics"]);
  });

  it("keeps selected, family, and search filtering deterministic", () => {
    expect(filterMetricSelection(metrics, "ops", "").map((metric) => metric.metric_id)).toEqual(["ops.latency"]);
    expect(filterMetricSelection(metrics, "all", "n-gram").map((metric) => metric.metric_id)).toEqual(["nlp.bleu"]);
    expect(filterMetricSelection(metrics, "all", "agent.task").map((metric) => metric.metric_id)).toEqual(["agent.task_adherence"]);
  });

  it("does not infer Full execution from legacy tool evidence", () => {
    expect(metricEvidenceScope(metrics[0])).toBe("tool_interactions");
    expect(metricEvidenceLabel(metrics[0])).toBe("Tool interactions");
    expect(metricEvidenceScope({
      ...metrics[0],
      metric_id: "trace.lifecycle",
      required_evidence_categories: ["trace", "lifecycle_events"],
    })).toBe("full_execution");
    expect(metricEvidenceLabel({
      ...metrics[0],
      metric_id: "trace.lifecycle",
      required_evidence_categories: ["trace", "lifecycle_events"],
    })).toBe("Full execution");
    expect(metricEvidenceScope({
      metric_id: "rag.groundedness",
      name: "Groundedness",
      description: "Answer support from retrieved context",
    })).toBe("tool_interactions");
  });

  it("reads depth availability from the backend rather than assuming full execution is missing", () => {
    const full = {
      ...metrics[0],
      metric_id: "trace.lifecycle",
      required_evidence_categories: ["trace", "lifecycle_events"],
    };
    expect(metricEvidenceScope(full)).toBe("full_execution");

    // No readiness yet, or a backend that reports no scope_options: the depth stays offered.
    // The old behaviour hardcoded "not available in the real evaluation flow yet" here, which
    // became a lie the moment the backend started deriving full execution from the target.
    expect(metricUnavailableReason(full)).toBeNull();
    expect(metricUnavailableReason(full, readinessWithScopes([
      { scope: "full_execution", available: true },
    ]))).toBeNull();

    // Unavailable only when the payload says so, and it is the payload's reason that shows.
    expect(metricUnavailableReason(full, readinessWithScopes([
      { scope: "full_execution", available: false, reason: "This target emits no trace." },
    ]))).toBe("This target emits no trace.");
  });

  it("falls back to a depth-named reason when the backend marks a depth unavailable without one", () => {
    const full = {
      ...metrics[0],
      metric_id: "trace.lifecycle",
      required_evidence_categories: ["trace", "lifecycle_events"],
    };
    expect(metricUnavailableReason(full, readinessWithScopes([
      { scope: "full_execution", available: false },
    ]))).toContain("Full execution");
  });

  it("leaves a shallower check alone when a deeper depth is unavailable", () => {
    // metrics[0] needs only the final response; an unavailable full_execution option
    // must not spill onto it.
    expect(metricUnavailableReason(metrics[0], readinessWithScopes([
      { scope: "final_response", available: true },
      { scope: "full_execution", available: false, reason: "This target emits no trace." },
    ]))).toBeNull();
  });

  it("keeps evidence-compatible checks available", () => {
    expect(metricUnavailableReason(metrics[0])).toBeNull();
    expect(metricUnavailableReason(metrics[1])).toBeNull();
  });

  it("uses backend-resolved requirement and applicability labels", () => {
    const readiness = {
      status: "ready" as const,
      evaluation_scope: "final_response" as const,
      requested_evaluation_scope: "final_response" as const,
      resolved_evaluation_scope: "final_response" as const,
      scope_promotion_reasons: [],
      effective_evidence_requirements: ["input", "final_output"],
      metric_applicability: [{ metric_id: "llm.correctness", applicability: "known_applicable" as const }],
      metric_requirements: [{ metric_id: "llm.correctness", requirement: "required" as const, source: "explicit_selection" as const }],
      details: [],
      requested_provenance: {},
      resolved_provenance: {},
    };
    expect(resolvedMetricStatus(metrics[1], readiness)).toBe("Affects verdict");
    expect(resolvedMetricStatus(metrics[1], {
      ...readiness,
      metric_applicability: [{ metric_id: "llm.correctness", applicability: "known_not_applicable" as const }],
    })).toBe("Not applicable");
  });

  it("never claims Required from the UI-side template inference when the backend keeps a metric optional", () => {
    const readiness: EvidenceReadinessResult = {
      status: "ready",
      evaluation_scope: "final_response",
      requested_evaluation_scope: "final_response",
      resolved_evaluation_scope: "final_response",
      scope_promotion_reasons: [],
      effective_evidence_requirements: ["input", "final_output"],
      metric_applicability: [{ metric_id: "llm.correctness", applicability: "known_applicable" }],
      // Resolver precedence keeps this template-referenced metric optional.
      metric_requirements: [{ metric_id: "llm.correctness", requirement: "optional", source: "quality_contract" }],
      details: [],
      requested_provenance: {},
      resolved_provenance: {},
    };

    const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "llm",
      metrics: [metrics[1]],
      selectedMetricIds: ["llm.correctness"],
      recommendedMetricIds: [],
      // A rubric template references the metric, but the backend says optional:
      // the UI must not claim it is required.
      contractRequiredIds: ["llm.correctness"],
      readiness,
      onToggle: () => undefined,
    }));

    expect(html).not.toContain("Required by rubric");
    expect(html).not.toContain(">Required<");
    expect(html).toContain("For insight only");
    // Not locked on: an optional metric stays user-toggleable.
    expect(html).not.toContain("disabled=\"\"");
  });

  it("shows the Required label only for a backend-resolved required rubric metric", () => {
    const readiness: EvidenceReadinessResult = {
      status: "ready",
      evaluation_scope: "final_response",
      requested_evaluation_scope: "final_response",
      resolved_evaluation_scope: "final_response",
      scope_promotion_reasons: [],
      effective_evidence_requirements: ["input", "final_output"],
      metric_applicability: [{ metric_id: "llm.correctness", applicability: "known_applicable" }],
      metric_requirements: [{ metric_id: "llm.correctness", requirement: "required", source: "quality_contract" }],
      details: [],
      requested_provenance: {},
      resolved_provenance: {},
    };

    const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "llm",
      metrics: [metrics[1]],
      selectedMetricIds: ["llm.correctness"],
      recommendedMetricIds: [],
      // Even without the UI-side inference, backend truth drives the label.
      contractRequiredIds: [],
      readiness,
      onToggle: () => undefined,
    }));

    expect(html).toContain("Required by rubric");
    // Required checks stay locked on.
    expect(html).toContain("disabled=\"\"");
  });

  it("resolves backend requirement per metric, with null when unresolved", () => {
    const readiness: EvidenceReadinessResult = {
      status: "ready",
      evaluation_scope: "final_response",
      requested_evaluation_scope: "final_response",
      resolved_evaluation_scope: "final_response",
      scope_promotion_reasons: [],
      effective_evidence_requirements: [],
      metric_applicability: [],
      metric_requirements: [
        { metric_id: "llm.correctness", requirement: "optional", source: "quality_contract" },
        { metric_id: "agent.task_adherence", requirement: "required", source: "quality_contract" },
      ],
      details: [],
      requested_provenance: {},
      resolved_provenance: {},
    };

    expect(backendRequirementForMetric(metrics[1], readiness)).toBe("optional");
    expect(backendRequirementForMetric(metrics[0], readiness)).toBe("required");
    expect(backendRequirementForMetric(metrics[3], readiness)).toBeNull();
    expect(backendRequirementForMetric(metrics[1], null)).toBeNull();
    expect(backendRequirementForMetric(metrics[1], undefined)).toBeNull();
  });

  it("maps a readiness blocker to the exact metric evidence dependency", () => {
    expect(blockingReasonForMetric(metrics[0], {
      status: "unsupported",
      evaluation_scope: "tool_interactions",
      requested_evaluation_scope: "tool_interactions",
      resolved_evaluation_scope: "tool_interactions",
      scope_promotion_reasons: [],
      effective_evidence_requirements: ["input", "final_output", "tool_calls", "tool_results"],
      metric_applicability: [],
      details: [{ code: "tool_capture_completion_unavailable", evidence_category: "tool_calls", message: "Tool capture completion is unavailable." }],
      requested_provenance: {},
      resolved_provenance: {},
    })).toBe("Tool capture completion is unavailable.");
  });
});

const relevanceMetric: MetricCatalogEntry = {
  metric_id: "llm.relevance",
  name: "Relevance",
  description: "Answer addresses the question",
  scenario: "llm_core",
  default_adapter: "deepeval",
};

const answerGroup: MetricCatalogEntry[] = [metrics[1], relevanceMetric];

function readinessBase(): EvidenceReadinessResult {
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
  };
}

describe("check selection redesign", () => {
  it("filters by id or description and auto-expands matching families", () => {
    render(createElement(MetricSelectionPanel, {
      kind: "agent",
      metrics,
      selectedMetricIds: [],
      recommendedMetricIds: [],
      onToggle: () => undefined,
    }));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search checks" }), {
      target: { value: "factual accuracy" },
    });

    expect(screen.getByRole("button", { name: /LLM quality/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByText("Agent behavior")).toBeNull();
    expect(screen.getByText("llm.correctness")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /LLM quality/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("starts all families collapsed and keeps informative headers", () => {
    const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "agent",
      metrics: [...metrics, relevanceMetric],
      selectedMetricIds: ["llm.correctness"],
      recommendedMetricIds: [],
      onToggle: () => undefined,
    }));

    expect(html).toContain('aria-expanded="false" aria-controls="metric-group-answer"');
    expect(html).toContain('aria-expanded="false" aria-controls="metric-group-tools"');
    expect(html).toContain('id="metric-group-tools" hidden=""');
    expect(html).toContain("1 of 2");
    expect(html).toContain("0 of 1");
    expect(html).toContain("Tool choice, arguments, results, task completion");
    // Check rows exist in the markup (hidden until the group expands).
    expect(html).toContain("llm.correctness");
    expect(html).toContain("agent.task_adherence");
  });

  it("hides the agent behavior family on the LLM path and keeps it on the agent path", () => {
    const props = {
      metrics: [...metrics, relevanceMetric],
      selectedMetricIds: [],
      recommendedMetricIds: [],
      onToggle: () => undefined,
    };
    const llm = renderToStaticMarkup(createElement(MetricSelectionPanel, { ...props, kind: "llm" as const }));
    const agent = renderToStaticMarkup(createElement(MetricSelectionPanel, { ...props, kind: "agent" as const }));

    // Hidden outright, not offered-and-disabled: the group and its checks are absent.
    expect(llm).not.toContain("Agent behavior");
    expect(llm).not.toContain("agent.task_adherence");
    // The same catalogue on the agent path still offers them, so the negative above
    // cannot pass merely because the fixture lacks an agent metric.
    expect(agent).toContain("Agent behavior");
    expect(agent).toContain("agent.task_adherence");
    // LLM quality is unaffected by the filter.
    expect(llm).toContain("llm.correctness");
  });

  it("keeps an already-selected agent check visible on the LLM path so it can be cleared", () => {
    const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "llm",
      metrics: [...metrics, relevanceMetric],
      selectedMetricIds: ["agent.task_adherence"],
      recommendedMetricIds: [],
      onToggle: () => undefined,
    }));

    expect(html).toContain("agent.task_adherence");
  });

  it("keeps a selected agent check clearable on the LLM path even when readiness rules it out", () => {
    // Both filters fire at once here: the kind filter would hide the metric, and readiness
    // marks it not applicable. Selection has to win over both, or the check sits in the
    // saved draft with no control that can remove it.
    const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "llm",
      metrics: [...metrics, relevanceMetric],
      selectedMetricIds: ["agent.task_adherence"],
      recommendedMetricIds: [],
      readiness: {
        status: "ready",
        evaluation_scope: "final_response",
        requested_evaluation_scope: "final_response",
        resolved_evaluation_scope: "final_response",
        scope_promotion_reasons: [],
        effective_evidence_requirements: [],
        metric_applicability: [
          {
            metric_id: "agent.task_adherence",
            applicability: "known_not_applicable" as const,
            reason: "No tool evidence in this dataset.",
          },
        ],
        details: [],
        requested_provenance: {},
        resolved_provenance: {},
      },
      onToggle: () => undefined,
    }));

    expect(html).toContain("agent.task_adherence");
    expect(html).toContain("Not applicable: No tool evidence in this dataset.");
    // Rendered selected and NOT disabled — it must remain removable.
    const row = html.slice(html.indexOf("metric-desc-agent.task_adherence") - 600);
    expect(row).toContain('aria-pressed="true"');
    expect(row.slice(0, row.indexOf("agent.task_adherence"))).not.toContain('disabled=""');
  });

  it("renders every available family at the same level without a More checks wrapper", () => {
    for (const kind of ["llm", "agent"] as const) {
      const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
        kind,
        metrics: [...metrics, relevanceMetric],
        selectedMetricIds: [],
        recommendedMetricIds: [],
        onToggle: () => undefined,
      }));

      expect(html).not.toContain("More checks");
      expect(html).toContain("NLP diagnostics");
    }
  });

  it("computes tri-state group selection: none, some, all", () => {
    expect(groupSelectionState(answerGroup, [])).toBe("none");
    expect(groupSelectionState(answerGroup, ["llm.correctness"])).toBe("some");
    expect(groupSelectionState(answerGroup, ["llm.correctness", "llm.relevance"])).toBe("all");
  });

  it("group toggle: none selects all, some selects the rest, all deselects all", () => {
    expect(groupToggleTargets(answerGroup, [])).toEqual(["llm.correctness", "llm.relevance"]);
    expect(groupToggleTargets(answerGroup, ["llm.correctness"])).toEqual(["llm.relevance"]);
    expect(groupToggleTargets(answerGroup, ["llm.correctness", "llm.relevance"])).toEqual(["llm.correctness", "llm.relevance"]);
  });

  it("group toggle never touches backend-required (locked) checks", () => {
    const readiness: EvidenceReadinessResult = {
      ...readinessBase(),
      metric_requirements: [{ metric_id: "llm.correctness", requirement: "required", source: "quality_contract" }],
    };
    // Deselecting the group leaves the locked check selected.
    expect(groupToggleTargets(answerGroup, ["llm.correctness", "llm.relevance"], readiness)).toEqual(["llm.relevance"]);
    // Selecting the group only adds the selectable check.
    expect(groupToggleTargets(answerGroup, ["llm.correctness"], readiness)).toEqual(["llm.relevance"]);
    // A group of one locked check plus one selected selectable check counts as fully selected.
    expect(groupSelectionState(answerGroup, ["llm.correctness", "llm.relevance"], readiness)).toBe("all");
  });

  it("group toggle never touches not-applicable or unavailable checks", () => {
    const readiness: EvidenceReadinessResult = {
      ...readinessBase(),
      metric_applicability: [{ metric_id: "llm.relevance", applicability: "known_not_applicable", reason: "No reference answers." }],
    };
    // The N/A check is excluded from tri-state math and from toggle targets.
    expect(groupToggleTargets(answerGroup, [], readiness)).toEqual(["llm.correctness"]);
    expect(groupToggleTargets(answerGroup, ["llm.correctness"], readiness)).toEqual(["llm.correctness"]);
    expect(groupSelectionState(answerGroup, ["llm.correctness"], readiness)).toBe("all");

    const unavailableMetric: MetricCatalogEntry = {
      ...relevanceMetric,
      metric_id: "llm.groundedness",
      name: "Groundedness",
      available_in_run: false,
      availability_note: "Needs the full agent execution trace.",
    };
    expect(groupToggleTargets([metrics[1], unavailableMetric], [])).toEqual(["llm.correctness"]);
    expect(groupSelectionState([metrics[1], unavailableMetric], ["llm.correctness"])).toBe("all");
  });

  it("renders partial and full family counts without a second group checkbox", () => {
    const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "llm",
      metrics: answerGroup,
      selectedMetricIds: ["llm.correctness"],
      recommendedMetricIds: [],
      onToggle: () => undefined,
    }));

    expect(html).toContain("1 of 2");
    expect(html).not.toContain('aria-label="All LLM quality checks"');

    const allHtml = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "llm",
      metrics: answerGroup,
      selectedMetricIds: ["llm.correctness", "llm.relevance"],
      recommendedMetricIds: [],
      onToggle: () => undefined,
    }));
    expect(allHtml).toContain("2 of 2");
  });

  it("keeps unavailable and not-applicable checks inside their semantic group, disabled with the exact reason", () => {
    const unavailableMetric: MetricCatalogEntry = {
      ...relevanceMetric,
      metric_id: "llm.groundedness",
      name: "Groundedness",
      available_in_run: false,
      availability_note: "Needs the full agent execution trace.",
    };
    const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "agent",
      metrics: [metrics[0], metrics[1], unavailableMetric],
      selectedMetricIds: ["llm.correctness"],
      recommendedMetricIds: [],
      readiness: {
        ...readinessBase(),
        metric_applicability: [
          { metric_id: "agent.task_adherence", applicability: "known_not_applicable", reason: "No tool evidence in this dataset." },
        ],
      },
      onToggle: () => undefined,
    }));

    // The separate unavailable section is gone.
    expect(html).not.toContain("Unavailable for this run");
    // The unavailable check stays in its group with its exact reason, disabled.
    expect(html).toContain("llm.groundedness");
    expect(html).toContain("Needs the full agent execution trace.");
    expect(html).toContain('disabled=""');
    // The N/A check stays in its group with the backend reason.
    expect(html).toContain("agent.task_adherence");
    expect(html).toContain("Not applicable: No tool evidence in this dataset.");
    // The unavailable check does not count toward its group's selectable total in the header.
    expect(html).toContain("1 of 2");
  });
});

describe("requirement locking by source", () => {
  function blockedToolReadiness(
    source: "explicit_selection" | "quality_contract",
  ): EvidenceReadinessResult {
    return {
      ...readinessBase(),
      status: "unsupported",
      evaluation_scope: "tool_interactions",
      requested_evaluation_scope: "tool_interactions",
      resolved_evaluation_scope: "tool_interactions",
      effective_evidence_requirements: ["input", "final_output", "tool_calls", "tool_results"],
      metric_requirements: [
        { metric_id: "agent.task_adherence", requirement: "required", source },
      ],
      details: [
        {
          code: "tool_capture_completion_unavailable",
          evidence_category: "tool_calls",
          message: "Tool capture completion is unavailable.",
        },
      ],
    };
  }

  it("locks only quality-contract requirements, never explicit selections", () => {
    const contract: EvidenceReadinessResult = {
      ...readinessBase(),
      metric_requirements: [
        { metric_id: "llm.correctness", requirement: "required", source: "quality_contract" },
        { metric_id: "llm.relevance", requirement: "required", source: "explicit_selection" },
      ],
    };
    expect(metricLockedByContract(metrics[1], contract)).toBe(true);
    expect(metricLockedByContract(relevanceMetric, contract)).toBe(false);
    // An optional contract reference never locks either.
    expect(
      metricLockedByContract(metrics[1], {
        ...readinessBase(),
        metric_requirements: [
          { metric_id: "llm.correctness", requirement: "optional", source: "quality_contract" },
        ],
      }),
    ).toBe(false);
    expect(metricLockedByContract(metrics[1], null)).toBe(false);
  });

  it("keeps an unavailable explicit-selection check clearable so the draft can recover", () => {
    const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "agent",
      metrics: [metrics[0]],
      selectedMetricIds: ["agent.task_adherence"],
      recommendedMetricIds: [],
      readiness: blockedToolReadiness("explicit_selection"),
      onToggle: () => undefined,
    }));

    // The blocker tells the user to clear the checkbox...
    expect(html).toContain("Clear this checkbox to continue");
    // ...and the checkbox actually remains enabled, so the advice is followable.
    expect(html).not.toContain('disabled=""');
    // It is still marked as required (it affects the verdict), just not locked.
    expect(html).toContain(">Required<");
    expect(html).not.toContain("Required by rubric");
  });

  it("keeps a quality-contract required check locked even when it is unavailable", () => {
    const html = renderToStaticMarkup(createElement(MetricSelectionPanel, {
      kind: "agent",
      metrics: [metrics[0]],
      selectedMetricIds: ["agent.task_adherence"],
      recommendedMetricIds: [],
      readiness: blockedToolReadiness("quality_contract"),
      onToggle: () => undefined,
    }));

    expect(html).toContain("Required by rubric");
    expect(html).toContain('disabled=""');
    // A locked check never shows advice it cannot follow.
    expect(html).not.toContain("Clear this checkbox to continue");
    expect(html).toContain("Remove the rubric to continue");
  });

  it("lets the group toggle clear an explicit-selection required check", () => {
    const readiness: EvidenceReadinessResult = {
      ...readinessBase(),
      metric_requirements: [
        { metric_id: "llm.correctness", requirement: "required", source: "explicit_selection" },
      ],
    };
    // Both checks are togglable: deselecting the group clears the explicit selection too.
    expect(groupToggleTargets(answerGroup, ["llm.correctness", "llm.relevance"], readiness))
      .toEqual(["llm.correctness", "llm.relevance"]);
  });
});
