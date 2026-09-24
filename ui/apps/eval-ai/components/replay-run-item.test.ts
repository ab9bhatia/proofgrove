import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReplayRunItemPanel } from "@/components/replay-run-item";
import { RunItemDrawer } from "@/components/run-item-drawer";
import type { CaseReplay, RunConfigurationSnapshot, RunItemDetail } from "@/lib/api";

const item = {
  run_id: "run-1",
  example_id: "ex-1",
  sequence_position: 0,
  dataset_version: null,
  input: { question: "What is the refund window?" },
  output: { response: "30 days." },
  expected: { expected_output: "30 days." },
  metadata: null,
  retrieval_snippets: null,
  expected_tools: null,
  tool_calls: null,
  tool_result_artifacts: [],
  execution: { trace_id: null, latency_ms: 850, usage: { prompt_tokens: 100, completion_tokens: 20 } },
  scorer_results: [],
  evidence_ref: "evidence-pack://run-1/items/ex-1",
  evidence_policy: {
    redaction_enabled: false,
    max_persisted_string_size: null,
    retention_policy: "stored_with_run_lifecycle",
  },
  capture_state: "complete",
} as unknown as RunItemDetail;

const llmConfig = {
  run_id: "run-1",
  dataset_name: "ds",
  response_source: "llm",
  target_model: "gpt-4.1-mini",
  target_endpoint: "https://gateway.example/v1",
  system_prompt: "Original system prompt",
  prompt_version_ref: "support-tone@2",
  active_metrics: [],
  enable_llm_judge: true,
  parallel_requests: 5,
  run_human_review: true,
  quality_contract_ids: [],
  evaluation_scope: "final_response",
} as unknown as RunConfigurationSnapshot;

const successReplay = {
  replay_id: "replay-1",
  tenant_id: "tenant-1",
  run_id: "run-1",
  example_id: "ex-1",
  prompt_version_ref: "support-tone@3",
  prompt_hash: "abc123def4567890",
  system_prompt: "Answer warmly.",
  target_model: "gpt-4.1-mini",
  target_endpoint: "https://gateway.example/v1",
  response: "Refunds run for thirty days.",
  latency_ms: 640,
  target_usage: { prompt_tokens: 120, completion_tokens: 40, model: "gpt-4.1-mini" },
  invocation_error: null,
  invocation_id: "inv-new",
  trace_id: null,
  span_id: null,
  created_at: "2026-09-10T10:00:00Z",
  created_by: "user",
  estimated_cost_usd: 0.0012,
} as CaseReplay;

function panelProps(overrides: Record<string, unknown> = {}) {
  return {
    item,
    config: llmConfig,
    savedPrompts: [],
    promptText: "",
    promptRef: null,
    onPromptTextChange: () => {},
    onStartFromSaved: () => {},
    onCommit: () => {},
    onBack: () => {},
    ...overrides,
  };
}

describe("replay affordance markup", () => {
  it("renders the button reachable but aria-disabled with a reason before the configuration loads", () => {
    const html = renderToStaticMarkup(
      createElement(RunItemDrawer, {
        exampleId: "ex-1",
        item,
        loading: false,
        error: null,
        position: 1,
        total: 3,
        kpis: [],
        onClose: () => {},
      } as never),
    );
    expect(html).toContain("Try another prompt");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("replay-disabled-reason");
    // Never the disabled attribute — the reason must stay reachable.
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Try another prompt/);
  });
});

describe("ReplayRunItemPanel result view", () => {
  it("labels the replay column as not scored and shows measurements side by side", () => {
    const html = renderToStaticMarkup(createElement(ReplayRunItemPanel, panelProps({ result: successReplay }) as never));
    expect(html).toContain("Original");
    expect(html).toContain("Replay — not scored");
    expect(html).toContain("30 days.");
    expect(html).toContain("Refunds run for thirty days.");
    expect(html).toContain("support-tone@3");
    expect(html).toContain("Estimated cost $0.0012");
    expect(html).toContain("never appear in run results");
  });

  it("never shows a real cost as zero", () => {
    const tiny = { ...successReplay, estimated_cost_usd: 0.00003 } as CaseReplay;
    const html = renderToStaticMarkup(createElement(ReplayRunItemPanel, panelProps({ result: tiny }) as never));
    expect(html).toContain("Estimated cost &lt; $0.0001");
    expect(html).not.toContain("$0.0000");
  });

  it("shows cost unavailable and a recorded failure honestly", () => {
    const failed = {
      ...successReplay,
      response: null,
      invocation_error: "upstream 502",
      estimated_cost_usd: null,
    } as CaseReplay;
    const html = renderToStaticMarkup(createElement(ReplayRunItemPanel, panelProps({ result: failed }) as never));
    expect(html).toContain("The invocation failed and was recorded");
    expect(html).toContain("upstream 502");
    expect(html).toContain("Cost unavailable for this model");
  });
});
