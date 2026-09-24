import { describe, expect, it } from "vitest";

import type { DatasetRunRequest } from "@/lib/api";
import {
  MAX_BAKEOFF_TARGETS,
  completedComparisonHref,
  bakeoffTagMap,
  describeTally,
  groupingDecision,
  launchTally,
  withPrompt,
  withTarget,
  type BakeoffTarget,
} from "@/lib/bakeoff";

const baseRequest: DatasetRunRequest = {
  evaluation_name: "model bakeoff",
  response_source: "llm",
  target_model: "gpt-4o",
  target_endpoint: "llm-catalog:gpt-4o",
  judge_model: "gpt-4o-mini",
  enable_llm_judge: true,
  active_metrics: ["quality.correctness"],
  evaluation_scope: "final_response",
  quality_contract_ids: [],
};

function target(overrides: Partial<BakeoffTarget> & { modelId: string }): BakeoffTarget {
  return { runId: null, status: null, error: null, ...overrides };
}

describe("withTarget", () => {
  it("changes the model and nothing the comparison basis covers", () => {
    const swapped = withTarget(baseRequest, {
      model_id: "claude",
      name: "Claude",
      source: "compass",
    });

    expect(swapped.target_model).toBe("claude");
    expect(swapped.target_endpoint).toBe("llm-catalog:claude");
    // Everything the basis hashes must survive the swap, or the runs cannot
    // be grouped into one comparison.
    expect(swapped.active_metrics).toEqual(baseRequest.active_metrics);
    expect(swapped.judge_model).toBe(baseRequest.judge_model);
    expect(swapped.evaluation_scope).toBe(baseRequest.evaluation_scope);
    expect(swapped.quality_contract_ids).toEqual(baseRequest.quality_contract_ids);
  });

  it("preserves an explicit Assignment when cloning a target", () => {
    const swapped = withTarget(
      { ...baseRequest, assignment_id: "claims-release", assignment_version: "1.0.0" },
      { model_id: "claude", name: "Claude", source: "compass" },
    );
    expect(swapped.assignment_id).toBe("claims-release");
    expect(swapped.assignment_version).toBe("1.0.0");
  });

  it("uses a custom model's own endpoint", () => {
    const swapped = withTarget(baseRequest, {
      model_id: "internal-7b",
      name: "Internal",
      source: "custom",
      endpoint: "https://llm.internal/v1",
    });
    expect(swapped.target_endpoint).toBe("https://llm.internal/v1");
  });
});

describe("withPrompt", () => {
  it("swaps the prompt and clears any typed text", () => {
    const swapped = withPrompt({ ...baseRequest, system_prompt: "typed" }, "support@2");

    expect(swapped.prompt_version_ref).toBe("support@2");
    // Both at once is a 422; the saved prompt wins.
    expect(swapped.system_prompt).toBeNull();
  });

  it("leaves everything the comparison basis covers alone", () => {
    const swapped = withPrompt(baseRequest, "support@2");

    expect(swapped.target_model).toBe(baseRequest.target_model);
    expect(swapped.active_metrics).toEqual(baseRequest.active_metrics);
    expect(swapped.judge_model).toBe(baseRequest.judge_model);
    expect(swapped.evaluation_scope).toBe(baseRequest.evaluation_scope);
  });

  it("preserves an explicit Assignment when cloning a prompt", () => {
    const swapped = withPrompt(
      { ...baseRequest, assignment_id: "claims-release", assignment_version: "1.0.0" },
      "support@2",
    );
    expect(swapped.assignment_id).toBe("claims-release");
    expect(swapped.assignment_version).toBe("1.0.0");
  });
});

describe("a chosen prompt is never silently dropped", () => {
  it("keeps the reference on a single run, not just on a comparison", () => {
    // Twice now a prompt the form collected was dropped before the request:
    // once because the builder never received it, once because a lone
    // selection skipped the branch that applied it.
    const single = withPrompt(baseRequest, "support@2");
    expect(single.prompt_version_ref).toBe("support@2");
  });

  it("does not smuggle typed text alongside a reference", () => {
    const swapped = withPrompt({ ...baseRequest, system_prompt: "typed" }, "support@2");
    expect(swapped.system_prompt).toBeNull();
  });
});

describe("groupingDecision", () => {
  it("waits while any launched run is still moving, even with two already done", () => {
    const decision = groupingDecision([
      target({ modelId: "a", runId: "run-a", status: "completed" }),
      target({ modelId: "b", runId: "run-b", status: "completed" }),
      target({ modelId: "c", runId: "run-c", status: "running" }),
    ]);

    // Grouping here would close the workspace around a and b, and `from-runs`
    // is one-shot — c could never join afterwards.
    expect(decision).toEqual({ ready: false, reason: "still-running" });
  });

  it("groups once everything is terminal, ignoring the failures", () => {
    const decision = groupingDecision([
      target({ modelId: "a", runId: "run-a", status: "completed" }),
      target({ modelId: "b", runId: "run-b", status: "failed" }),
      target({ modelId: "c", runId: "run-c", status: "completed" }),
    ]);

    expect(decision).toEqual({
      ready: true,
      runIds: ["run-a", "run-c"],
      baselineRunId: "run-a",
    });
  });

  it("never groups a comparison of one", () => {
    const decision = groupingDecision([
      target({ modelId: "a", runId: "run-a", status: "completed" }),
      target({ modelId: "b", runId: "run-b", status: "blocked" }),
    ]);

    expect(decision).toEqual({ ready: false, reason: "too-few-completed" });
  });

  it("ignores targets that never launched rather than waiting on them forever", () => {
    const decision = groupingDecision([
      target({ modelId: "a", runId: "run-a", status: "completed" }),
      target({ modelId: "b", runId: "run-b", status: "completed" }),
      target({ modelId: "c", error: "Unknown model" }),
    ]);

    expect(decision.ready).toBe(true);
  });
});

describe("bakeoffTagMap", () => {
  it("keeps existing tags the endpoint would otherwise drop", () => {
    const tags = bakeoffTagMap(
      {
        label: "nightly",
        evaluation_name: "model bakeoff",
        source_baseline_run_id: "run-a",
        workspace_kind: "experiment",
        pending_first_run: "true",
      },
      [
        target({ modelId: "a", runId: "run-a", status: "completed" }),
        target({ modelId: "b", runId: "run-b", status: "failed" }),
      ],
    );

    // PATCH replaces non-reserved tags, so anything not re-sent is lost.
    expect(tags.label).toBe("nightly");
    expect(tags.evaluation_name).toBe("model bakeoff");
    expect(tags.source_baseline_run_id).toBe("run-a");

    // Reserved tags are a 422 if named; the backend re-applies them itself.
    expect(tags).not.toHaveProperty("workspace_kind");
    expect(tags).not.toHaveProperty("pending_first_run");

    expect(tags.bakeoff_requested_models).toBe("a,b");
    expect(tags.bakeoff_requested_count).toBe("2");
    expect(tags.bakeoff_completed_count).toBe("1");
  });
});

describe("launchTally / describeTally", () => {
  it("reads as a plain count when nothing was lost", () => {
    const tally = launchTally([
      target({ modelId: "a", runId: "run-a", status: "completed" }),
      target({ modelId: "b", runId: "run-b", status: "completed" }),
    ]);
    expect(describeTally(tally)).toBe("2 models");
    expect(describeTally(tally, "prompt versions")).toBe("2 prompt versions");
  });

  it("names the shortfall when a requested model never produced a run", () => {
    const tally = launchTally([
      target({ modelId: "a", runId: "run-a", status: "completed" }),
      target({ modelId: "b", runId: "run-b", status: "completed" }),
      target({ modelId: "c", runId: "run-c", status: "completed" }),
      target({ modelId: "d", error: "Readiness blocked" }),
    ]);
    expect(describeTally(tally)).toBe("3 of 4 models");
    expect(describeTally(tally, "prompt versions")).toBe("3 of 4 prompt versions");
  });
});

describe("MAX_BAKEOFF_TARGETS", () => {
  it("matches the comparison cap it exists to feed", () => {
    expect(MAX_BAKEOFF_TARGETS).toBe(4);
  });
});


describe("completed comparison destination", () => {
  const targets: BakeoffTarget[] = [
    { modelId: "first", runId: "run-1", status: "completed", error: null },
    { modelId: "second", runId: "run-2", status: "completed", error: null },
    { modelId: "third", runId: "run-3", status: "failed", error: "Failed" },
  ];
  it("opens the actual comparison with completed runs in selection order", () => {
    expect(completedComparisonHref("workspace", targets)).toBe("/evaluations/workspace/compare?baseline_run_id=run-1&candidate_run_id=run-2");
  });
  it("waits for the workspace and at least two completed runs", () => {
    expect(completedComparisonHref(null, targets)).toBeNull();
    expect(completedComparisonHref("workspace", [targets[0], targets[2]])).toBeNull();
  });
});

it("finishes a comparison with a stopped arm instead of waiting forever", () => {
 const targets = [target({ modelId: "a", runId: "a", status: "completed" }), target({ modelId: "b", runId: "b", status: "cancelled" })];
 expect(groupingDecision(targets)).toEqual({ ready: false, reason: "too-few-completed" });
 expect(completedComparisonHref("workspace", targets)).toBeNull();
 expect(groupingDecision([...targets, target({ modelId: "c", runId: "c", status: "completed" })])).toEqual({ ready: true, runIds: ["a", "c"], baselineRunId: "a" });
});
