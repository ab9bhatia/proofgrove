import type { MetricCatalogEntry } from "@/lib/api";

export type MetricMeaning = "answer" | "tools" | "retrieval" | "safety" | "performance" | "diagnostics" | "other";

export interface MetricGroupDefinition {
  id: MetricMeaning;
  label: string;
  description: string;
}

export const METRIC_GROUPS: readonly MetricGroupDefinition[] = [
  { id: "answer", label: "LLM quality", description: "Correctness, relevance, coherence, fluency, policy" },
  { id: "tools", label: "Agent behavior", description: "Tool choice, arguments, results, task completion" },
  { id: "retrieval", label: "RAG quality", description: "Context quality, coverage, groundedness" },
  { id: "safety", label: "Safety", description: "Harmful, ungrounded, or policy-sensitive output" },
  { id: "diagnostics", label: "NLP diagnostics", description: "Reference-overlap measures for benchmarks" },
  { id: "other", label: "Other checks", description: "Additional configured checks" },
];

export function metricMeaning(metric: Pick<MetricCatalogEntry, "metric_id" | "required_evidence_categories">): MetricMeaning {
  if (metric.metric_id.startsWith("ops.")) return "performance";
  if (metric.metric_id.startsWith("safety.")) return "safety";
  if (metric.metric_id.startsWith("rag.")) return "retrieval";
  if (metric.metric_id.startsWith("nlp.")) return "diagnostics";
  if (metric.metric_id.startsWith("agent.tool_") || metric.required_evidence_categories?.some((category) => category === "tool_calls" || category === "tool_results")) return "tools";
  return "answer";
}
