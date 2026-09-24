import { describe, expect, it } from "vitest";

import {
  buildLlmSpanDetail,
  formatLlmCostSummary,
  formatLlmTokenSummary,
  isLlmSpan,
  llmSpanCost,
  llmSpanCostBreakdown,
  llmSpanInvocationParams,
  llmSpanMessageTabs,
  llmSpanModel,
  llmSpanTokenCounts,
} from "./llm-span-detail";

describe("isLlmSpan", () => {
  it("uses the OpenInference kind instead of guessing from telemetry", () => {
    expect(isLlmSpan({ name: "invoke", attributes: { "openinference.span.kind": "LLM" } })).toBe(true);
    for (const entry of [
      { name: "call_llm", attributes: {} },
      { name: "ChatCompletion", attributes: { "gen_ai.operation.name": "chat" } },
      { name: "invoke", attributes: { "openinference.span.kind": "TOOL", "gen_ai.request.model": "gpt" } },
    ]) expect(isLlmSpan(entry)).toBe(false);
  });
});


describe("llmSpanModel", () => {
  it("prefers OpenInference and GenAI model attributes in order", () => {
    expect(llmSpanModel({ "llm.model_name": "gpt-4o" })).toBe("gpt-4o");
    expect(
      llmSpanModel({
        "gen_ai.request.model": "requested",
        "gen_ai.response.model": "actual",
        "llm.model_name": "canonical",
      }),
    ).toBe("canonical");
    expect(llmSpanModel({ "gen_ai.request.model": "gpt-4o-mini" })).toBe("gpt-4o-mini");
  });
});

describe("llmSpanTokenCounts", () => {
  it("reads OpenInference and GenAI token attributes", () => {
    expect(
      llmSpanTokenCounts({
        "llm.token_count.prompt": 10,
        "llm.token_count.completion": 5,
        "llm.token_count.total": 15,
      }),
    ).toEqual({ prompt: 10, completion: 5, cached: null, total: 15 });
    expect(
      llmSpanTokenCounts({
        "gen_ai.usage.input_tokens": 3,
        "gen_ai.usage.output_tokens": 7,
        "gen_ai.usage.cached_input_tokens": 2,
        "gen_ai.usage.total_tokens": 10,
      }),
    ).toEqual({ prompt: 3, completion: 7, cached: 2, total: 10 });
  });

  it("returns nulls when token counts are absent or invalid", () => {
    expect(llmSpanTokenCounts({})).toEqual({ prompt: null, completion: null, cached: null, total: null });
    expect(llmSpanTokenCounts({ "llm.token_count.total": "lots" })).toEqual({
      prompt: null,
      completion: null,
      cached: null,
      total: null,
    });
  });
});

describe("formatLlmTokenSummary", () => {
  it("formats only recorded counts", () => {
    expect(formatLlmTokenSummary({ prompt: 12, completion: 3, cached: null, total: 15 })).toBe(
      "12 prompt · 3 completion · 15 total",
    );
    expect(formatLlmTokenSummary({ prompt: 10, completion: null, cached: 4, total: null })).toBe(
      "10 prompt · 4 cached",
    );
    expect(formatLlmTokenSummary({ prompt: null, completion: null, cached: null, total: 20 })).toBe("20 total");
    expect(formatLlmTokenSummary({ prompt: null, completion: null, cached: null, total: null })).toBeNull();
  });
});

describe("llmSpanCostBreakdown", () => {
  it("returns each llm.cost.* field when recorded", () => {
    expect(
      llmSpanCostBreakdown({
        "llm.cost.total": "0.0021",
        "llm.cost.prompt": "0.0015",
        "llm.cost.completion": "0.0006",
      }),
    ).toEqual({ total: "0.0021", prompt: "0.0015", completion: "0.0006" });
    expect(llmSpanCostBreakdown({})).toEqual({ total: null, prompt: null, completion: null });
  });
});

describe("formatLlmCostSummary", () => {
  it("formats only recorded cost fields", () => {
    expect(
      formatLlmCostSummary({ total: "0.01", prompt: "0.006", completion: "0.004" }),
    ).toBe("0.006 prompt · 0.004 completion · 0.01 total");
    expect(formatLlmCostSummary({ total: null, prompt: null, completion: null })).toBeNull();
  });
});

describe("llmSpanCost", () => {
  it("returns cost only when recorded", () => {
    expect(llmSpanCost({ "llm.cost.total": "0.0021" })).toBe("0.0021");
    expect(llmSpanCost({})).toBeNull();
  });
});

describe("llmSpanInvocationParams", () => {
  it("surfaces platform gen_ai and vertex context attrs", () => {
    const params = llmSpanInvocationParams({
      "gen_ai.system": "gemini",
      "gen_ai.operation.name": "generate_content",
      "gen_ai.agent.name": "evalai_assistant",
      "gen_ai.conversation.id": "3be70f47-4a6d-4609-a812-952854208ac4",
      "gen_ai.task.id": "972b19af-4ea8-4327-8993-54b0245596ad",
      "gcp.vertex.agent.event_id": "13e97070-1955-485e-a5dc-8535de05279d",
      "gcp.vertex.agent.invocation_id": "e-44ad289d-da7c-4778-9be1-55154c996091",
    });
    expect(params.map((p) => p.key)).toEqual([
      "gcp.vertex.agent.event_id",
      "gcp.vertex.agent.invocation_id",
      "gen_ai.operation.name",
      "gen_ai.system",
    ]);
  });

  it("parses invocation_parameters JSON and gen_ai.request.* attrs", () => {
    expect(
      llmSpanInvocationParams({
        "llm.invocation_parameters": '{"temperature":0.2,"max_tokens":512}',
        "gen_ai.request.top_p": "0.9",
        "gen_ai.request.model": "gpt-4o-mini",
      }),
    ).toEqual([
      { key: "max_tokens", value: "512" },
      { key: "temperature", value: "0.2" },
      { key: "top_p", value: "0.9" },
    ]);
  });
});

describe("llmSpanMessageTabs", () => {
  it("builds input and output message tabs from indexed attributes", () => {
    expect(
      llmSpanMessageTabs({
        "llm.input_messages.0.message.role": "user",
        "llm.input_messages.0.message.content": "hi",
        "llm.output_messages.0.message.role": "assistant",
        "llm.output_messages.0.message.content": "hello",
      }).map((tab) => [tab.id, tab.text]),
    ).toEqual([
      ["input", "user: hi"],
      ["output", "assistant: hello"],
    ]);
  });

  it("builds tabs from gen_ai.input.messages / gen_ai.output.messages", () => {
    expect(
      llmSpanMessageTabs({
        "gen_ai.input.messages.0.role": "user",
        "gen_ai.input.messages.0.content": "question",
        "gen_ai.output.messages.0.role": "assistant",
        "gen_ai.output.messages.0.content": "answer",
      }).map((tab) => [tab.id, tab.text]),
    ).toEqual([
      ["input", "user: question"],
      ["output", "assistant: answer"],
    ]);
  });
});

describe("buildLlmSpanDetail", () => {
  it("omits gen_ai usage and operation keys from raw attributes", () => {
    const detail = buildLlmSpanDetail({
      attributes: {
        "gen_ai.request.model": "gpt-5.1",
        "gen_ai.operation.name": "generate_content",
        "gen_ai.usage.input_tokens": "889",
        "gen_ai.usage.output_tokens": "18",
        "gen_ai.system": "gemini",
        "kagent.user_id": "admin@kagent.dev",
      },
    });

    expect(detail.model).toBe("gpt-5.1");
    expect(detail.tokenCounts).toEqual({ prompt: 889, completion: 18, cached: null, total: null });
    expect(detail.omitFromRawAttributes.has("gen_ai.usage.input_tokens")).toBe(true);
    expect(detail.omitFromRawAttributes.has("kagent.user_id")).toBe(false);
  });

  it("builds structured detail for platform generate_content spans", () => {
    const detail = buildLlmSpanDetail({
      attributes: {
        "kagent.user_id": "admin@kagent.dev",
        "gen_ai.task.id": "972b19af-4ea8-4327-8993-54b0245596ad",
        "gen_ai.system": "gemini",
        "gen_ai.operation.name": "generate_content",
        "gen_ai.request.model": "gpt-5.1",
        "gen_ai.agent.name": "evalai_assistant",
        "gen_ai.conversation.id": "3be70f47-4a6d-4609-a812-952854208ac4",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": "889",
        "gen_ai.usage.output_tokens": "18",
        "gcp.vertex.agent.event_id": "13e97070-1955-485e-a5dc-8535de05279d",
        "gcp.vertex.agent.invocation_id": "e-44ad289d-da7c-4778-9be1-55154c996091",
      },
    });

    expect(detail.invocationParams.map((p) => p.key)).toContain("gcp.vertex.agent.invocation_id");
    expect(detail.invocationParams.map((p) => p.key)).not.toContain("gen_ai.agent.name");
    expect(detail.omitFromRawAttributes.has("kagent.user_id")).toBe(false);
    expect(detail.omitFromRawAttributes.has("gen_ai.agent.name")).toBe(true);
  });

  it("omits consumed keys from raw attributes and prefers message tabs over fallback cards", () => {
    const detail = buildLlmSpanDetail({
      attributes: {
        "llm.model_name": "gpt-4o-mini",
        "llm.token_count.prompt": 4,
        "llm.token_count.completion": 6,
        "llm.token_count.total": 10,
        "llm.invocation_parameters": '{"temperature":0}',
        "llm.input_messages.0.message.content": "question",
        "llm.output_messages.0.message.content": "answer",
        "custom.note": "keep me",
      },
    });

    expect(detail.model).toBe("gpt-4o-mini");
    expect(detail.messageTabs).toHaveLength(2);
    expect(detail.fallbackCards).toEqual([]);
    expect(detail.omitFromRawAttributes.has("llm.model_name")).toBe(true);
    expect(detail.omitFromRawAttributes.has("llm.input_messages.0.message.content")).toBe(true);
    expect(detail.omitFromRawAttributes.has("custom.note")).toBe(false);
  });

  it("keeps message attributes no tab rendered in raw evidence", () => {
    // The parts/text shape is not one this parser understands: nothing renders
    // it, so it must stay visible rather than being stripped by prefix.
    const detail = buildLlmSpanDetail({
      attributes: {
        "gen_ai.request.model": "gpt-5.1",
        "gen_ai.operation.name": "chat",
        "gen_ai.input.messages.0.parts.0.text": "captured prompt",
        "gen_ai.output.messages.0.parts.0.text": "captured answer",
      },
    });

    expect(detail.messageTabs).toEqual([]);
    expect(detail.fallbackCards).toEqual([]);
    expect(detail.omitFromRawAttributes.has("gen_ai.input.messages.0.parts.0.text")).toBe(false);
    expect(detail.omitFromRawAttributes.has("gen_ai.output.messages.0.parts.0.text")).toBe(false);
  });

  it("keeps a second message convention that lost its tab slot", () => {
    // llm.input_messages wins the input tab; the gen_ai copy renders nowhere,
    // so its attributes stay in raw evidence instead of vanishing.
    const detail = buildLlmSpanDetail({
      attributes: {
        "llm.input_messages.0.message.role": "user",
        "llm.input_messages.0.message.content": "question",
        "gen_ai.input.messages.0.role": "user",
        "gen_ai.input.messages.0.content": "question (gen_ai copy)",
      },
    });

    expect(detail.messageTabs.map((tab) => tab.text)).toEqual(["user: question"]);
    expect(detail.omitFromRawAttributes.has("llm.input_messages.0.message.content")).toBe(true);
    expect(detail.omitFromRawAttributes.has("gen_ai.input.messages.0.content")).toBe(false);
    expect(detail.omitFromRawAttributes.has("gen_ai.input.messages.0.role")).toBe(false);
  });

  it("keeps model spellings the pane did not render", () => {
    // llmSpanModel renders the first present spelling only; the losing
    // alternatives were never displayed, so raw evidence is their only home.
    const detail = buildLlmSpanDetail({
      attributes: {
        "llm.model_name": "gpt-4o-mini",
        "llm.response.model_name": "gpt-4o-mini-2024",
        "gen_ai.response.model": "gpt-4o-mini-vendor",
        "gen_ai.request.model": "gpt-4o-mini-requested",
      },
    });

    expect(detail.model).toBe("gpt-4o-mini");
    expect(detail.omitFromRawAttributes.has("llm.model_name")).toBe(true);
    expect(detail.omitFromRawAttributes.has("llm.response.model_name")).toBe(false);
    expect(detail.omitFromRawAttributes.has("gen_ai.response.model")).toBe(false);
    expect(detail.omitFromRawAttributes.has("gen_ai.request.model")).toBe(false);
  });

  it("keeps token keys the chosen spelling shadowed", () => {
    const detail = buildLlmSpanDetail({
      attributes: {
        "llm.token_count.prompt": 4,
        "gen_ai.usage.input_tokens": 999,
        "llm.token_count.total": 10,
        "gen_ai.usage.total_tokens": 4242,
      },
    });

    expect(detail.tokenCounts).toEqual({ prompt: 4, completion: null, cached: null, total: 10 });
    expect(detail.omitFromRawAttributes.has("llm.token_count.prompt")).toBe(true);
    expect(detail.omitFromRawAttributes.has("llm.token_count.total")).toBe(true);
    // Contradicting vendor counts stay visible rather than being silently dropped.
    expect(detail.omitFromRawAttributes.has("gen_ai.usage.input_tokens")).toBe(false);
    expect(detail.omitFromRawAttributes.has("gen_ai.usage.total_tokens")).toBe(false);
  });

  it("keeps values the renderers rejected", () => {
    const detail = buildLlmSpanDetail({
      attributes: {
        "llm.model_name": "   ",
        "llm.token_count.completion": "n/a",
        "gen_ai.usage.output_tokens": -5,
        "llm.cost.total": "",
      },
    });

    expect(detail.model).toBeNull();
    expect(detail.tokenCounts.completion).toBeNull();
    expect(detail.cost.total).toBeNull();
    // Nothing rendered these, so nothing may hide them.
    expect(detail.omitFromRawAttributes.has("llm.model_name")).toBe(false);
    expect(detail.omitFromRawAttributes.has("llm.token_count.completion")).toBe(false);
    expect(detail.omitFromRawAttributes.has("gen_ai.usage.output_tokens")).toBe(false);
    expect(detail.omitFromRawAttributes.has("llm.cost.total")).toBe(false);
  });

  it("keeps a gen_ai.request.* attribute that lost its short key to the JSON blob", () => {
    const detail = buildLlmSpanDetail({
      attributes: {
        "llm.invocation_parameters": '{"temperature":0.2}',
        "gen_ai.request.temperature": "0.9",
        "gen_ai.request.top_p": "0.95",
      },
    });

    expect(detail.invocationParams).toEqual([
      { key: "temperature", value: "0.2" },
      { key: "top_p", value: "0.95" },
    ]);
    expect(detail.omitFromRawAttributes.has("llm.invocation_parameters")).toBe(true);
    expect(detail.omitFromRawAttributes.has("gen_ai.request.top_p")).toBe(true);
    // 0.9 is nowhere on screen — the JSON blob's 0.2 won the row.
    expect(detail.omitFromRawAttributes.has("gen_ai.request.temperature")).toBe(false);
  });

  it("keeps an unparseable invocation_parameters blob in raw evidence", () => {
    const detail = buildLlmSpanDetail({
      attributes: { "llm.invocation_parameters": "not json", "llm.model_name": "m" },
    });

    expect(detail.invocationParams).toEqual([]);
    expect(detail.omitFromRawAttributes.has("llm.invocation_parameters")).toBe(false);
  });

  it("omits only the keys a fallback card rendered, not the whole prefix", () => {
    const detail = buildLlmSpanDetail({
      attributes: {
        "llm.model_name": "gpt-4o-mini",
        "llm.input_messages.0.message.content": "question",
        "llm.input_messages.0.message.tool_call_id": "call-7",
        "llm.input_messages.1.parts.0.text": "unsupported shape",
      },
    });

    expect(detail.messageTabs).toHaveLength(1);
    expect(detail.omitFromRawAttributes.has("llm.input_messages.0.message.content")).toBe(true);
    expect(detail.omitFromRawAttributes.has("llm.input_messages.0.message.tool_call_id")).toBe(false);
    expect(detail.omitFromRawAttributes.has("llm.input_messages.1.parts.0.text")).toBe(false);
  });
});

describe("invocation parameters come from the keys real spans actually use", () => {
  it("reads request settings recorded under the llm.request convention", () => {
    // Observed on a live generation span: the settings live only here, so
    // reading the gen_ai prefix alone left the panel showing the provider name
    // and nothing else — a section that named itself and then said nothing.
    const params = llmSpanInvocationParams({
      "gen_ai.request.model": "gpt-5.1",
      "gen_ai.system": "openai",
      "llm.request.type": "chat",
      "llm.request.reasoning_effort": "medium",
    });
    const byKey = Object.fromEntries(params.map((param) => [param.key, param.value]));

    expect(byKey["type"]).toBe("chat");
    expect(byKey["reasoning_effort"]).toBe("medium");
    // The model has its own place in the header; it is not a parameter row.
    expect(byKey["model"]).toBeUndefined();
  });

  it("leaves tool declarations out of the settings list", () => {
    // Tool schemas are large declarations, not invocation settings; they stay
    // in raw attributes rather than flooding this panel.
    const params = llmSpanInvocationParams({
      "llm.request.functions.0.name": "search",
      "llm.request.functions.0.parameters": "{}",
      "llm.request.type": "chat",
    });

    expect(params.map((param) => param.key)).toEqual(["type"]);
  });
});

it("renders recorded ADK roles and tool parts without overriding native messages", () => {
  const attributes = {
    "gcp.vertex.agent.llm_request": JSON.stringify({ config: { system_instruction: "Be brief" }, contents: [{ role: "user", parts: [{ text: "Paris?" }] }, { role: "model", parts: [{ function_call: { name: "weather", args: { city: "Paris" } } }] }] }),
    "gcp.vertex.agent.llm_response": JSON.stringify({ content: { role: "model", parts: [{ text: "Sunny" }] } }),
  };
  const tabs = llmSpanMessageTabs(attributes);
  expect(tabs[0].messages.map(m => m.role)).toEqual(["system", "user", "model"]);
  expect(tabs[0].text).toContain("weather");
  expect(tabs[1].messages).toEqual([{ role: "model", content: "Sunny" }]);
  expect(llmSpanMessageTabs({ ...attributes, "llm.input_messages.0.message.content": "Native" })[0].text).toBe("Native");
  expect(llmSpanMessageTabs({ "gcp.vertex.agent.llm_request": "{truncated" })).toEqual([]);
});
