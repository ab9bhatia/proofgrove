// Phoenix-style LLM span detail extraction from archived OTLP attributes.
// Only surfaces values that genuinely exist on the span — nothing is fabricated.

import { spanContentExtraction, type SpanContentCard } from "@/components/tracing/span-content";
import { semanticSpanKind } from "@/components/tracing/span-tree";
import type { ArchivedTraceSpan } from "@/lib/api";

/** Platform correlation attrs promoted into the metadata band — omit from invocation params. */
const METADATA_PROMOTED_CONTEXT_KEYS = new Set([
  "gen_ai.agent.name",
  "gen_ai.conversation.id",
  "gen_ai.task.id",
]);
/** Vertex correlation attrs shown only in invocation parameters. */
const GEN_AI_INVOCATION_CONTEXT_KEYS = [
  "gcp.vertex.agent.event_id",
  "gcp.vertex.agent.invocation_id",
] as const;

const MODEL_ATTRIBUTES = [
  "llm.model_name",
  "llm.response.model_name",
  "llm.request.model_name",
  "gen_ai.response.model",
  "gen_ai.request.model",
] as const;

const PROMPT_TOKEN_KEYS = ["llm.token_count.prompt", "gen_ai.usage.input_tokens"] as const;
const COMPLETION_TOKEN_KEYS = ["llm.token_count.completion", "gen_ai.usage.output_tokens"] as const;
const CACHED_TOKEN_KEYS = ["gen_ai.usage.cached_input_tokens"] as const;
const TOTAL_TOKEN_KEYS = ["llm.token_count.total", "gen_ai.usage.total_tokens"] as const;

const COST_TOTAL_KEYS = ["llm.cost.total"] as const;
const COST_PROMPT_KEYS = ["llm.cost.prompt"] as const;
const COST_COMPLETION_KEYS = ["llm.cost.completion"] as const;
const COST_KEYS = ["llm.cost.total", "llm.cost.prompt", "llm.cost.completion"] as const;

const INVOCATION_JSON_KEY = "llm.invocation_parameters";
const GEN_AI_REQUEST_PREFIX = "gen_ai.request.";
/**
 * The other convention for request settings. Real spans record `type`,
 * `reasoning_effort` and similar only here, so reading just the `gen_ai.*`
 * prefix left the invocation panel showing provider metadata and no actual
 * parameters. Tool schemas (`functions.*`) are declarations, not settings, and
 * are large — they stay in raw attributes.
 */
const LLM_REQUEST_PREFIX = "llm.request.";

const MESSAGE_TAB_GROUPS: ReadonlyArray<{ prefix: string; id: "input" | "output"; label: string }> = [
  { prefix: "llm.input_messages", id: "input", label: "Input Messages" },
  { prefix: "llm.output_messages", id: "output", label: "Output Messages" },
  { prefix: "gen_ai.input.messages", id: "input", label: "Input Messages" },
  { prefix: "gen_ai.output.messages", id: "output", label: "Output Messages" },
  { prefix: "gen_ai.prompt", id: "input", label: "Input Messages" },
  { prefix: "gen_ai.completion", id: "output", label: "Output Messages" },
];

export interface LlmTokenCounts {
  prompt: number | null;
  completion: number | null;
  cached: number | null;
  total: number | null;
}

export interface LlmCostBreakdown {
  total: string | null;
  prompt: string | null;
  completion: string | null;
}

export interface LlmInvocationParam {
  key: string;
  value: string;
}

export interface LlmMessage {
  /** Recorded role ("user"/"assistant"/"system"); null when the span omits it. */
  role: string | null;
  content: string;
}

export interface LlmMessageTab {
  id: "input" | "output";
  label: string;
  /** Flat `role: content` rendering, kept for copy-to-clipboard. */
  text: string;
  messages: LlmMessage[];
}

export interface LlmSpanDetail {
  model: string | null;
  tokenCounts: LlmTokenCounts;
  cost: LlmCostBreakdown;
  invocationParams: LlmInvocationParam[];
  messageTabs: LlmMessageTab[];
  fallbackCards: SpanContentCard[];
  /** Attribute keys already rendered in the structured LLM pane. */
  omitFromRawAttributes: ReadonlySet<string>;
}

export function isLlmSpan(span: Pick<ArchivedTraceSpan, "name" | "attributes" | "semantic_kind">): boolean {
  return semanticSpanKind(span) === "llm";
}

function parseNonNegativeInt(raw: unknown): number | null {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : null;
  if (value != null && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  return null;
}

function attributeText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

/**
 * A value a renderer actually used, plus the attribute key it came from.
 *
 * The pane offers several spellings per fact and renders the first that parses.
 * Omitting *every* alternative from raw evidence would hide attributes nothing
 * displayed, so each picker reports the one key it consumed.
 */
interface AttributePick<T> {
  value: T;
  key: string;
}

function firstStringAttributeEntry(
  attributes: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): AttributePick<string> | null {
  for (const key of keys) {
    const text = attributeText(attributes[key]);
    if (text != null) return { value: text, key };
  }
  return null;
}

function firstIntAttributeEntry(
  attributes: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): AttributePick<number> | null {
  for (const key of keys) {
    const value = parseNonNegativeInt(attributes[key]);
    if (value != null) return { value, key };
  }
  return null;
}

export function llmSpanModel(attributes: Record<string, unknown> | null | undefined): string | null {
  if (!attributes) return null;
  return firstStringAttributeEntry(attributes, MODEL_ATTRIBUTES)?.value ?? null;
}

export function llmSpanTokenCounts(
  attributes: Record<string, unknown> | null | undefined,
): LlmTokenCounts {
  return llmSpanTokenCountEntries(attributes).counts;
}

/** Token counts plus the exact keys they were read from. */
function llmSpanTokenCountEntries(
  attributes: Record<string, unknown> | null | undefined,
): { counts: LlmTokenCounts; keys: string[] } {
  if (!attributes) {
    return { counts: { prompt: null, completion: null, cached: null, total: null }, keys: [] };
  }
  const prompt = firstIntAttributeEntry(attributes, PROMPT_TOKEN_KEYS);
  const completion = firstIntAttributeEntry(attributes, COMPLETION_TOKEN_KEYS);
  const cached = firstIntAttributeEntry(attributes, CACHED_TOKEN_KEYS);
  const total = firstIntAttributeEntry(attributes, TOTAL_TOKEN_KEYS);
  return {
    counts: {
      prompt: prompt?.value ?? null,
      completion: completion?.value ?? null,
      cached: cached?.value ?? null,
      total: total?.value ?? null,
    },
    keys: [prompt, completion, cached, total]
      .filter((entry): entry is AttributePick<number> => entry != null)
      .map((entry) => entry.key),
  };
}

/** Compact header line for prompt/completion/cached/total counts; null when none are recorded. */
export function formatLlmTokenSummary(counts: LlmTokenCounts): string | null {
  const parts: string[] = [];
  if (counts.prompt != null) parts.push(`${counts.prompt} prompt`);
  if (counts.completion != null) parts.push(`${counts.completion} completion`);
  if (counts.cached != null) parts.push(`${counts.cached} cached`);
  if (counts.total != null) parts.push(`${counts.total} total`);
  return parts.length ? parts.join(" · ") : null;
}

export function llmSpanCostBreakdown(
  attributes: Record<string, unknown> | null | undefined,
): LlmCostBreakdown {
  return llmSpanCostEntries(attributes).cost;
}

/** Cost breakdown plus the exact keys it was read from. */
function llmSpanCostEntries(
  attributes: Record<string, unknown> | null | undefined,
): { cost: LlmCostBreakdown; keys: string[] } {
  if (!attributes) return { cost: { total: null, prompt: null, completion: null }, keys: [] };
  const total = firstStringAttributeEntry(attributes, COST_TOTAL_KEYS);
  const prompt = firstStringAttributeEntry(attributes, COST_PROMPT_KEYS);
  const completion = firstStringAttributeEntry(attributes, COST_COMPLETION_KEYS);
  return {
    cost: {
      total: total?.value ?? null,
      prompt: prompt?.value ?? null,
      completion: completion?.value ?? null,
    },
    keys: [total, prompt, completion]
      .filter((entry): entry is AttributePick<string> => entry != null)
      .map((entry) => entry.key),
  };
}

/** First recorded llm.cost.* value (total, then prompt, then completion). */
export function llmSpanCost(attributes: Record<string, unknown> | null | undefined): string | null {
  if (!attributes) return null;
  for (const key of COST_KEYS) {
    const text = attributeText(attributes[key]);
    if (text != null) return text;
  }
  return null;
}

/** Compact cost line when any llm.cost.* attribute is present. */
export function formatLlmCostSummary(cost: LlmCostBreakdown): string | null {
  const parts: string[] = [];
  if (cost.prompt != null) parts.push(`${cost.prompt} prompt`);
  if (cost.completion != null) parts.push(`${cost.completion} completion`);
  if (cost.total != null) parts.push(`${cost.total} total`);
  return parts.length ? parts.join(" · ") : null;
}

function parseInvocationJson(raw: unknown): LlmInvocationParam[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>)
      .map(([key, value]) => {
        const text = attributeText(value);
        return text != null ? { key, value: text } : null;
      })
      .filter((entry): entry is LlmInvocationParam => entry != null)
      .sort((a, b) => a.key.localeCompare(b.key));
  } catch {
    return [];
  }
}

export function llmSpanInvocationParams(
  attributes: Record<string, unknown> | null | undefined,
): LlmInvocationParam[] {
  return llmSpanInvocationParamsWithKeys(attributes).params;
}

/**
 * Invocation parameters plus the source attribute keys they rendered. A
 * `gen_ai.request.*` attribute that lost its short key to an earlier row, an
 * unparseable `llm.invocation_parameters` blob, and a value this parser rejects
 * all contribute no key — they stay in raw evidence instead of disappearing.
 */
function llmSpanInvocationParamsWithKeys(
  attributes: Record<string, unknown> | null | undefined,
): { params: LlmInvocationParam[]; consumedKeys: Set<string> } {
  const consumedKeys = new Set<string>();
  if (!attributes) return { params: [], consumedKeys };
  const params = parseInvocationJson(attributes[INVOCATION_JSON_KEY]);
  if (params.length > 0) consumedKeys.add(INVOCATION_JSON_KEY);
  const seen = new Set(params.map((param) => param.key));
  for (const key of ["gen_ai.system", "gen_ai.operation.name", ...GEN_AI_INVOCATION_CONTEXT_KEYS] as const) {
    const text = attributeText(attributes[key]);
    if (text == null || seen.has(key)) continue;
    params.push({ key, value: text });
    seen.add(key);
    consumedKeys.add(key);
  }
  const finishReasons = attributes["gen_ai.response.finish_reasons"];
  if (finishReasons != null && !seen.has("gen_ai.response.finish_reasons")) {
    const text = attributeText(finishReasons);
    if (text != null) {
      params.push({ key: "gen_ai.response.finish_reasons", value: text });
      seen.add("gen_ai.response.finish_reasons");
      consumedKeys.add("gen_ai.response.finish_reasons");
    }
  }
  for (const prefix of [GEN_AI_REQUEST_PREFIX, LLM_REQUEST_PREFIX]) {
    for (const key of Object.keys(attributes).sort()) {
      if (!key.startsWith(prefix)) continue;
      const shortKey = key.slice(prefix.length);
      if (shortKey === "model") continue;
      // The model has its own place in the header. Matched exactly, so a
      // parameter merely starting with "model" is still a parameter.
      if (shortKey === "model_name") continue;
      if (shortKey.startsWith("functions.")) continue;
      if (seen.has(shortKey)) continue;
      const text = attributeText(attributes[key]);
      if (text == null) continue;
      params.push({ key: shortKey, value: text });
      seen.add(shortKey);
      consumedKeys.add(key);
    }
  }
  return { params: params.sort((a, b) => a.key.localeCompare(b.key)), consumedKeys };
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function messageTabFromPrefix(
  attributes: Record<string, unknown>,
  prefix: string,
  id: "input" | "output",
  label: string,
): { tab: LlmMessageTab; keys: string[] } | null {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\.(\\d+)\\.(?:message\\.)?content$`);
  const messages: Array<{ index: number; role: string | null; content: string }> = [];
  const keys: string[] = [];
  for (const key of Object.keys(attributes)) {
    const match = pattern.exec(key);
    if (!match) continue;
    const text = attributeText(attributes[key]);
    if (text == null) continue;
    const base = key.slice(0, key.length - "content".length);
    const roleKey = `${base}role`;
    const role = attributeText(attributes[roleKey]);
    messages.push({ index: Number(match[1]), role, content: text });
    keys.push(key);
    if (role != null) keys.push(roleKey);
  }
  if (messages.length === 0) return null;
  messages.sort((a, b) => a.index - b.index);
  return {
    tab: {
      id,
      label,
      text: messages
        .map((message) => (message.role ? `${message.role}: ${message.content}` : message.content))
        .join("\n\n"),
      messages: messages.map(({ role, content }) => ({ role, content })),
    },
    keys,
  };
}

/** Supported ADK payloads only; malformed or unknown content remains in Attributes. */
function adkMessages(value: unknown, input: boolean): LlmMessage[] {
  let payload: unknown = value;
  try { if (typeof value === "string") payload = JSON.parse(value); } catch { return []; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const data = payload as Record<string, unknown>;
  const messages: LlmMessage[] = [];
  const append = (content: unknown, role?: string) => {
    if (typeof content === "string") {
      if (content.trim()) messages.push({ role: role ?? null, content });
      return;
    }
    if (!content || typeof content !== "object" || Array.isArray(content)) return;
    const item = content as Record<string, unknown>;
    if (!Array.isArray(item.parts)) return;
    const parts = item.parts.map(part => {
      if (!part || typeof part !== "object") return attributeText(part);
      const fields = part as Record<string, unknown>;
      return typeof fields.text === "string" && Object.keys(fields).length === 1
        ? fields.text : attributeText(fields);
    }).filter((part): part is string => part != null);
    if (parts.length) messages.push({ role: role ?? (typeof item.role === "string" ? item.role : null), content: parts.join("\n\n") });
  };
  if (input) {
    const config = data.config;
    if (config && typeof config === "object" && !Array.isArray(config)) append((config as Record<string, unknown>).system_instruction, "system");
    if (Array.isArray(data.contents)) data.contents.forEach(content => append(content));
  } else append(data.content);
  return messages;
}

/**
 * Message tabs plus the exact attribute keys they rendered. A convention that
 * loses the tab slot to an earlier one, and any shape this parser does not
 * understand, contributes no key — its attributes stay in raw evidence.
 */
function messageTabsWithKeys(
  attributes: Record<string, unknown> | null | undefined,
): { tabs: LlmMessageTab[]; consumedKeys: Set<string> } {
  const tabs: LlmMessageTab[] = [];
  const consumedKeys = new Set<string>();
  if (!attributes) return { tabs, consumedKeys };
  const seen = new Set<string>();
  for (const group of MESSAGE_TAB_GROUPS) {
    const found = messageTabFromPrefix(attributes, group.prefix, group.id, group.label);
    if (!found || seen.has(found.tab.id)) continue;
    tabs.push(found.tab);
    for (const key of found.keys) consumedKeys.add(key);
    seen.add(found.tab.id);
  }
  for (const id of ["input", "output"] as const) {
    if (seen.has(id)) continue;
    const key = id === "input" ? "gcp.vertex.agent.llm_request" : "gcp.vertex.agent.llm_response";
    const messages = adkMessages(attributes[key], id === "input");
    if (messages.length) tabs.push({ id, label: id === "input" ? "Input Messages" : "Output Messages", messages, text: messages.map(m => m.role ? `${m.role}: ${m.content}` : m.content).join("\n\n") });
  }
  return { tabs, consumedKeys };
}

export function llmSpanMessageTabs(
  attributes: Record<string, unknown> | null | undefined,
): LlmMessageTab[] {
  return messageTabsWithKeys(attributes).tabs;
}

/**
 * Attribute keys the structured pane rendered, and therefore the only ones the
 * raw-evidence block may drop.
 *
 * Every key here is one a renderer reported consuming — never a whole family of
 * alternatives, and never a prefix. An attribute that exists but was not shown
 * (a losing model spelling, a token key the chosen one shadowed, a value a
 * parser rejected, a `gen_ai.request.*` that collided on its short key) stays
 * in raw evidence, which is the only place the operator could still see it.
 */
function collectConsumedKeys(
  attributes: Record<string, unknown>,
  renderedKeys: ReadonlySet<string>,
): Set<string> {
  const omit = new Set<string>(["openinference.span.kind"]);

  // Promoted into the metadata band above this pane, on the same "only when it
  // renders" condition the band itself applies.
  for (const key of METADATA_PROMOTED_CONTEXT_KEYS) {
    if (attributeText(attributes[key]) != null) omit.add(key);
  }
  for (const key of renderedKeys) omit.add(key);

  return omit;
}

export function buildLlmSpanDetail(
  span: Pick<ArchivedTraceSpan, "attributes">,
): LlmSpanDetail {
  const attributes = span.attributes ?? {};
  const { tabs: messageTabs, consumedKeys } = messageTabsWithKeys(attributes);
  const fallback =
    messageTabs.length > 0
      ? { cards: [] as SpanContentCard[], consumedKeys: new Set<string>() }
      : spanContentExtraction(attributes);
  const model = firstStringAttributeEntry(attributes, MODEL_ATTRIBUTES);
  const tokens = llmSpanTokenCountEntries(attributes);
  const cost = llmSpanCostEntries(attributes);
  const invocation = llmSpanInvocationParamsWithKeys(attributes);

  const renderedKeys = new Set<string>([
    ...consumedKeys,
    ...fallback.consumedKeys,
    ...(model ? [model.key] : []),
    ...tokens.keys,
    ...cost.keys,
    ...invocation.consumedKeys,
  ]);

  return {
    model: model?.value ?? null,
    tokenCounts: tokens.counts,
    cost: cost.cost,
    invocationParams: invocation.params,
    messageTabs,
    fallbackCards: fallback.cards,
    omitFromRawAttributes: collectConsumedKeys(attributes, renderedKeys),
  };
}
