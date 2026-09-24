// Pure extraction of recognisable LLM content (input/output/prompt/completion/
// messages) from archived OTLP span attributes, for the formatted cards above
// the raw-JSON accordion. Only keys that genuinely exist produce cards —
// nothing is fabricated; unrecognised attributes stay in the raw JSON view.

export interface SpanContentCard {
  /** Stable identity for React keys — unique per card. */
  key: string;
  label: string;
  text: string;
}

/** Direct string-valued attribute keys, in display order. */
const DIRECT_KEYS: ReadonlyArray<readonly [key: string, label: string]> = [
  ["input.value", "Input"],
  ["output.value", "Output"],
  ["gen_ai.prompt", "Prompt"],
  ["gen_ai.completion", "Completion"],
];

/**
 * Indexed message conventions: `{prefix}.{i}.content` (+ sibling `role`) for
 * gen_ai, `{prefix}.{i}.message.content` (+ `message.role`) for OpenInference.
 */
const MESSAGE_GROUPS: ReadonlyArray<{ prefix: string; label: string }> = [
  ["llm.input_messages", "Input Messages"],
  ["llm.output_messages", "Output Messages"],
  ["gen_ai.input.messages", "Input Messages"],
  ["gen_ai.output.messages", "Output Messages"],
  ["gen_ai.prompt", "Prompt"],
  ["gen_ai.completion", "Completion"],
].map(([prefix, label]) => ({ prefix, label }));

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Honest text form of an attribute value; null when there is nothing to show. */
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

export interface SpanContentExtraction {
  cards: SpanContentCard[];
  /**
   * The attribute keys actually rendered into a card — never a whole prefix.
   * Callers hiding "already shown" attributes must use exactly these, so an
   * unparsed sibling (e.g. `…messages.0.parts.0.text`) stays visible.
   */
  consumedKeys: Set<string>;
}

/**
 * Formatted content cards for a span's attributes plus the exact keys they
 * consumed. Direct keys first (input → output → prompt → completion), then
 * indexed message groups, each rendered as one card with `role: content` lines
 * sorted by message index.
 */
export function spanContentExtraction(
  attributes: Record<string, unknown> | null | undefined,
): SpanContentExtraction {
  const cards: SpanContentCard[] = [];
  const consumedKeys = new Set<string>();
  if (!attributes) return { cards, consumedKeys };

  for (const [key, label] of DIRECT_KEYS) {
    const text = attributeText(attributes[key]);
    if (text == null) continue;
    cards.push({ key, label, text });
    consumedKeys.add(key);
  }

  for (const group of MESSAGE_GROUPS) {
    const pattern = new RegExp(`^${escapeRegExp(group.prefix)}\\.(\\d+)\\.(?:message\\.)?content$`);
    const messages: Array<{ index: number; line: string }> = [];
    const groupKeys: string[] = [];
    for (const key of Object.keys(attributes)) {
      const match = pattern.exec(key);
      if (!match) continue;
      const text = attributeText(attributes[key]);
      if (text == null) continue;
      const base = key.slice(0, key.length - "content".length);
      const roleKey = `${base}role`;
      const role = attributeText(attributes[roleKey]);
      messages.push({ index: Number(match[1]), line: role ? `${role}: ${text}` : text });
      groupKeys.push(key);
      if (role != null) groupKeys.push(roleKey);
    }
    if (messages.length === 0) continue;
    messages.sort((a, b) => a.index - b.index);
    cards.push({
      key: `${group.prefix}.*`,
      label: group.label,
      text: messages.map((message) => message.line).join("\n\n"),
    });
    for (const key of groupKeys) consumedKeys.add(key);
  }

  return { cards, consumedKeys };
}

/** Formatted content cards for a span's attributes. */
export function spanContentCards(
  attributes: Record<string, unknown> | null | undefined,
): SpanContentCard[] {
  return spanContentExtraction(attributes).cards;
}
