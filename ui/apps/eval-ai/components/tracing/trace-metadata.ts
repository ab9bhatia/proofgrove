// Compact trace/span metadata extraction for the inspector summary band.
// Only surfaces values that genuinely exist — nothing is fabricated.

import type { ArchivedTraceSpan } from "@/lib/api";

export interface TraceMetadataField {
  /** Human-readable label for the summary band. */
  label: string;
  /** OTLP attribute key (used to omit from raw JSON when promoted). */
  key: string;
  value: string;
}

/** Ordered attribute keys promoted into the metadata band. */
const METADATA_SPECS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "session.id", label: "Session" },
  { key: "user.id", label: "User" },
  { key: "kagent.user_id", label: "User" },
  { key: "enduser.id_hash", label: "End user" },
  { key: "gen_ai.conversation.id", label: "Conversation" },
  { key: "gen_ai.task.id", label: "Task" },
  { key: "gen_ai.agent.name", label: "Agent" },
  { key: "ctx.tenant", label: "Tenant" },
  { key: "ctx.customer_org", label: "Customer org" },
];

function attributeText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function fieldFromAttributes(
  attributes: Record<string, unknown> | null | undefined,
  spec: { key: string; label: string },
): TraceMetadataField | null {
  if (!attributes) return null;
  const text = attributeText(attributes[spec.key]);
  if (text == null) return null;
  return { key: spec.key, label: spec.label, value: text };
}

/**
 * Metadata fields present on a single span (span attrs, then resource attrs).
 * Span attributes win over resource when both carry the same key. Two specs
 * can share a label (`user.id` and the vendor-specific `kagent.user_id` both
 * mean "User"), so dedup is by label, not key — otherwise a span carrying
 * both attributes would show "User" twice.
 */
export function spanMetadataFields(
  span: Pick<ArchivedTraceSpan, "attributes" | "resource_attributes">,
): TraceMetadataField[] {
  const seenLabels = new Set<string>();
  const fields: TraceMetadataField[] = [];
  const sources = [span.attributes ?? {}, span.resource_attributes ?? {}];
  for (const spec of METADATA_SPECS) {
    if (seenLabels.has(spec.label)) continue;
    for (const attrs of sources) {
      const field = fieldFromAttributes(attrs, spec);
      if (field) {
        fields.push(field);
        seenLabels.add(spec.label);
        break;
      }
    }
  }
  return fields;
}

/**
 * Trace-level metadata: first recorded value per key across all spans
 * (span attrs before resource attrs, earlier spans before later), then
 * collapsed to one field per label for the same reason as above — one span
 * recording `user.id` and another recording `kagent.user_id` must not produce
 * two "User" facts.
 */
export function traceMetadataFields(spans: ReadonlyArray<ArchivedTraceSpan>): TraceMetadataField[] {
  const byKey = new Map<string, TraceMetadataField>();
  for (const span of spans) {
    for (const field of spanMetadataFields(span)) {
      if (!byKey.has(field.key)) byKey.set(field.key, field);
    }
  }
  const seenLabels = new Set<string>();
  const fields: TraceMetadataField[] = [];
  for (const spec of METADATA_SPECS) {
    const field = byKey.get(spec.key);
    if (!field || seenLabels.has(spec.label)) continue;
    fields.push(field);
    seenLabels.add(spec.label);
  }
  return fields;
}

/** Attribute keys already rendered in the metadata band (for raw JSON omission). */
export function metadataOmitKeys(fields: ReadonlyArray<TraceMetadataField>): ReadonlySet<string> {
  return new Set(fields.map((field) => field.key));
}
