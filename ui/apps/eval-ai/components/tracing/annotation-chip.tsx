"use client";

import { METRIC_FAMILY_LABELS } from "@/components/report/lib";
import { metricMeaning, type MetricMeaning } from "@/lib/metric-groups";

import { Popover, PopoverContent, PopoverTrigger } from "@evalai/shared/ui/popover";

const FAMILY_COLORS: Record<MetricMeaning, string> = {
  answer: "var(--series-1)",
  tools: "var(--series-2)",
  retrieval: "var(--series-3)",
  safety: "var(--series-4)",
  diagnostics: "var(--series-5)",
  performance: "var(--series-6)",
  other: "var(--border)",
};

export function AnnotationChip({ metricId, name, value, explanation, evaluator }: {
  metricId: string;
  name: string;
  value: string;
  explanation?: string | null;
  evaluator?: string | null;
}) {
  const family = /^(llm|agent|rag|safety|nlp|ops)\./.test(metricId)
    ? metricMeaning({ metric_id: metricId })
    : "other";
  const color = FAMILY_COLORS[family];
  const familyLabel = METRIC_FAMILY_LABELS[family];
  return <Popover>
    <PopoverTrigger asChild>
      <button type="button" aria-label={`${name}: ${value}`} title={familyLabel} style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, var(--card))`, borderColor: `color-mix(in srgb, ${color} 40%, var(--border))` }} className="inline-flex min-h-9 max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-left text-xs hover:brightness-95 dark:hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="min-w-0 break-words font-medium">{name}</span>
        <span className="min-w-0 break-words font-semibold tabular-nums text-foreground">{value}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] text-sm" aria-label={`${name} annotation`}>
      <p className="mb-1 text-xs text-muted-foreground">{familyLabel}</p>
      <p className="break-words font-semibold">{name} · {value}</p>
      <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words leading-6 text-muted-foreground">{explanation || "No explanation recorded."}</p>
      <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">Evaluator: {evaluator || "Not recorded"}</p>
    </PopoverContent>
  </Popover>;
}
