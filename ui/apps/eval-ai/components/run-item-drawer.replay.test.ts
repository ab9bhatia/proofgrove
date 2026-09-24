/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function stubApi(configPayload: unknown = llmConfig, failFirstConfig = false, history: CaseReplay[] = [], failLibrary = false) {
  let configurationCalls = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });
    let payload: unknown = {};
    let status = 200;
    if (href.includes("/tenant")) payload = { tenant_id: "tenant-1" };
    else if (href.includes("/configuration")) {
      configurationCalls += 1;
      status = failFirstConfig && configurationCalls === 1 ? 503 : 200;
      payload = status === 503 ? { detail: "Unavailable" } : configPayload;
    }
    else if (href.includes("/replays") && init?.method === "POST") payload = successReplay;
    else if (href.includes("/replays")) { payload = history; status = failLibrary ? 503 : 200; }
    else if (href.includes("/platform/prompts")) { payload = []; status = failLibrary ? 503 : 200; }
    else status = 200;
    return Promise.resolve(
      new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }),
    );
  });
  return calls;
}

function mount(props: Record<string, unknown> = {}) {
  return render(
    createElement(RunItemDrawer, {
      exampleId: "ex-1",
      item,
      loading: false,
      error: null,
      position: 1,
      total: 3,
      kpis: [],
      onClose: vi.fn(),
      ...props,
    } as never),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("replay affordance in the drawer", () => {
  it("keeps the button disabled with the exact reason for a non-llm run", async () => {
    stubApi({ ...(llmConfig as object), response_source: "agent" });
    mount();
    await waitFor(() => {
      const button = screen.getByText("Try another prompt").closest("button");
      expect(button?.getAttribute("aria-disabled")).toBe("true");
    });
    expect(screen.getByText(/no system prompt/)).toBeTruthy();
  });

  it("swaps the panel into the drawer body and posts exactly one prompt source", async () => {
    const calls = stubApi();
    mount();
    // Enabled once the llm configuration arrives.
    await waitFor(() => {
      const button = screen.getByText("Try another prompt").closest("button");
      expect(button?.getAttribute("aria-disabled")).toBeNull();
    });
    fireEvent.click(screen.getByText("Try another prompt"));

    // Panel replaced the body — no second dialog was opened.
    expect(await screen.findByText("What the replay reproduces")).toBeTruthy();
    expect(document.querySelectorAll('[role="dialog"]').length).toBeLessThanOrEqual(1);

    // Original configuration is shown before anything runs.
    expect(screen.getByText("support-tone@2")).toBeTruthy();
    expect(screen.getByText("Original system prompt")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/System prompt/), { target: { value: "Answer tersely." } });
    fireEvent.click(screen.getByText("Run replay"));

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes("/replays") && c.init?.method === "POST");
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post?.init?.body));
      expect(body).toEqual({ system_prompt: "Answer tersely." });
      expect(post?.url).toContain("tenant_id=tenant-1");
      expect(post?.url).toContain("/runs/run-1/items/ex-1/replays");
    });
    expect(await screen.findByText("Replay — not scored")).toBeTruthy();
  });
});


describe("replay recovery", () => {
  it("retries a temporary configuration failure without claiming evidence is missing", async () => {
    stubApi(llmConfig, true);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Retry replay configuration" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try another prompt" }).getAttribute("aria-disabled")).toBeNull());
    expect(screen.queryByText(/configuration was not captured/)).toBeNull();
  });

  it("reopens a saved replay's answer and recorded prompt without invoking the model", async () => {
    const calls = stubApi(llmConfig, false, [successReplay]);
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Try another prompt" }).getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Try another prompt" }));
    fireEvent.click(await screen.findByText("Previous replays (1)"));
    fireEvent.click(screen.getByRole("button", { name: /View result/ }));
    expect(await screen.findByText(successReplay.response!)).toBeTruthy();
    expect(screen.getByText(successReplay.system_prompt!)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Compare prompt version" }).getAttribute("href")).toBe("/catalog/prompts/support-tone?compare=3");
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
  });
});


it("shows prompt and history fetch errors with separate retry actions", async () => {
  stubApi(llmConfig, false, [], true);
  mount();
  await waitFor(() => expect(screen.getByRole("button", { name: "Try another prompt" }).getAttribute("aria-disabled")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Try another prompt" }));
  expect(await screen.findByRole("button", { name: "Retry saved prompts" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Retry replay history" })).toBeTruthy();
});
