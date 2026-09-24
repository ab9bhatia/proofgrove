import { describe, expect, it } from "vitest";

import { spanContentCards, spanContentExtraction } from "./span-content";

describe("spanContentCards", () => {
  it("extracts OpenInference input/output values as cards, in input→output order", () => {
    const cards = spanContentCards({
      "output.value": "The answer is 42.",
      "input.value": "What is the answer?",
      "other.attr": "ignored",
    });
    expect(cards.map((card) => [card.label, card.text])).toEqual([
      ["Input", "What is the answer?"],
      ["Output", "The answer is 42."],
    ]);
  });

  it("extracts gen_ai prompt/completion strings", () => {
    const cards = spanContentCards({
      "gen_ai.prompt": "Summarise the doc",
      "gen_ai.completion": "A summary.",
    });
    expect(cards.map((card) => card.label)).toEqual(["Prompt", "Completion"]);
  });

  it("groups indexed gen_ai message attributes into one role-annotated card, sorted numerically", () => {
    const cards = spanContentCards({
      "gen_ai.prompt.10.content": "third",
      "gen_ai.prompt.10.role": "user",
      "gen_ai.prompt.0.content": "first",
      "gen_ai.prompt.0.role": "system",
      "gen_ai.prompt.2.content": "second",
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].label).toBe("Prompt");
    expect(cards[0].text).toBe("system: first\n\nsecond\n\nuser: third");
  });

  it("groups OpenInference llm.*_messages attributes", () => {
    const cards = spanContentCards({
      "llm.input_messages.0.message.role": "user",
      "llm.input_messages.0.message.content": "hi",
      "llm.output_messages.0.message.role": "assistant",
      "llm.output_messages.0.message.content": "hello",
    });
    expect(cards.map((card) => [card.label, card.text])).toEqual([
      ["Input Messages", "user: hi"],
      ["Output Messages", "assistant: hello"],
    ]);
  });

  it("stringifies structured values as pretty JSON but never fabricates absent keys", () => {
    const cards = spanContentCards({ "input.value": { question: "q" } });
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toBe(JSON.stringify({ question: "q" }, null, 2));
  });

  it("returns nothing for unrecognised, empty or missing attributes", () => {
    expect(spanContentCards({})).toEqual([]);
    expect(spanContentCards(null)).toEqual([]);
    expect(spanContentCards({ "input.value": "   ", "gen_ai.prompt": null })).toEqual([]);
    expect(spanContentCards({ "custom.payload": "not a recognised key" })).toEqual([]);
  });

  it("keeps distinct card keys when both a direct value and an indexed group exist", () => {
    const cards = spanContentCards({
      "gen_ai.prompt": "raw prompt",
      "gen_ai.prompt.0.content": "message prompt",
    });
    const keys = cards.map((card) => card.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(cards).toHaveLength(2);
  });
});

describe("spanContentExtraction consumed keys", () => {
  it("reports only the attribute keys a card actually rendered", () => {
    const { cards, consumedKeys } = spanContentExtraction({
      "input.value": "question",
      "gen_ai.input.messages.0.role": "user",
      "gen_ai.input.messages.0.content": "hi",
      "gen_ai.input.messages.1.parts.0.text": "unsupported shape",
    });

    expect(cards.map((card) => card.label)).toEqual(["Input", "Input Messages"]);
    expect([...consumedKeys].sort()).toEqual([
      "gen_ai.input.messages.0.content",
      "gen_ai.input.messages.0.role",
      "input.value",
    ]);
  });

  it("consumes nothing when no card renders", () => {
    expect(spanContentExtraction({ "custom.payload": "keep" }).consumedKeys.size).toBe(0);
    expect(spanContentExtraction(null).consumedKeys.size).toBe(0);
  });
});
