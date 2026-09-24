import { describe, expect, it } from "vitest";

import type { RunConfigurationSnapshot, RunItemDetail } from "@/lib/api-types";
import { replayDisabledReason, replayQuestionText } from "./prompt-replay";

function item(input: Record<string, unknown> | null = { question: "What is the refund window?" }): RunItemDetail {
  return { input } as unknown as RunItemDetail;
}

function config(overrides: Partial<RunConfigurationSnapshot> = {}): RunConfigurationSnapshot {
  return {
    run_id: "run-1",
    dataset_name: "ds",
    response_source: "llm",
    target_model: "gpt-4.1-mini",
    active_metrics: [],
    enable_llm_judge: true,
    parallel_requests: 5,
    run_human_review: true,
    quality_contract_ids: [],
    evaluation_scope: "final_response",
    ...overrides,
  } as RunConfigurationSnapshot;
}

describe("replayQuestionText", () => {
  it("reads through the backend's own key order", () => {
    expect(replayQuestionText({ prompt: "p", question: "q" })).toBe("q");
  });

  it("ignores blank and non-string values", () => {
    expect(replayQuestionText({ question: "  ", query: 42 })).toBeNull();
    expect(replayQuestionText(null)).toBeNull();
  });
});

describe("replayDisabledReason", () => {
  it("is null for an eligible llm case", () => {
    expect(replayDisabledReason(item(), config(), false)).toBeNull();
  });

  it("explains a still-loading case", () => {
    expect(replayDisabledReason(null, config(), false)).toMatch(/loading/i);
  });

  it("explains a missing launch configuration", () => {
    expect(replayDisabledReason(item(), null, true)).toMatch(/Could not load/);
  });

  it("waits while the configuration loads", () => {
    expect(replayDisabledReason(item(), null, false)).toMatch(/Loading/);
  });

  it("explains why an agent run cannot be replayed", () => {
    expect(replayDisabledReason(item(), config({ response_source: "agent" }), false)).toMatch(/no system prompt/);
  });

  it("explains runs that never invoked a target", () => {
    expect(replayDisabledReason(item(), config({ response_source: "provided" }), false)).toMatch(/no target to replay/);
    expect(replayDisabledReason(item(), config({ response_source: "baseline" }), false)).toMatch(/no target to replay/);
  });

  it("explains a missing recorded model", () => {
    expect(replayDisabledReason(item(), config({ target_model: "  " }), false)).toMatch(/target model/);
  });

  it("explains an unresolvable endpoint", () => {
    expect(replayDisabledReason(item(), config({ llm_endpoint_resolvable: false }), false)).toMatch(/endpoint/);
  });

  it("treats an older backend without the flag as resolvable", () => {
    expect(replayDisabledReason(item(), config({ llm_endpoint_resolvable: undefined }), false)).toBeNull();
  });

  it("explains missing input text", () => {
    expect(replayDisabledReason(item({ unrelated: 1 }), config(), false)).toMatch(/input text was not captured/);
  });

  it("explains truncated input", () => {
    expect(replayDisabledReason(item({ question: "What is…[TRUNCATED]" }), config(), false)).toMatch(/truncated/);
  });
});
