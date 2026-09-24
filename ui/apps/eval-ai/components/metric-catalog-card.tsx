import { cn } from "@evalai/shared/utils";

import type { MetricCatalogEntry } from "@/lib/api";

export function MetricCatalogCard({ metric }: { metric: MetricCatalogEntry }) {
  return (
    <article className="border-b last:border-b-0">
      <details className="group">
        <summary className="grid min-w-[700px] min-h-16 cursor-pointer list-none gap-3 px-5 py-3 hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring grid-cols-[minmax(0,2fr)_8rem_9rem_5rem] items-center">
          <h3 className="text-sm font-semibold">{metric.name}</h3>
          <ScenarioBadge scenario={metric.scenario} />
          <span className="text-sm capitalize"><span className="sr-only">Scoring: </span>{displayValue(metric.scoring_type, "Score")}</span>
          <span className="text-sm font-medium text-brand-text">Details <span aria-hidden="true" className="inline-block group-open:rotate-90">›</span></span>
        </summary>
        <div className="border-t bg-muted/15 px-5 py-4">
          <p className="max-w-3xl text-sm leading-6">{metric.description?.trim() || "No description provided."}</p>
          <dl className="mt-4 grid gap-4 grid-cols-3">
            <MetricFact label="Metric ID" value={metric.metric_id} />
            <MetricFact label="Ground truth" value={metric.requires_ground_truth ? "Required" : "Not required"} />
            <MetricFact label="Availability" value={metric.available_in_run === false ? "Batch only" : "Evaluation runs"} />
          </dl>
        </div>
      </details>
    </article>
  );
}

function ScenarioBadge({ scenario }: { scenario?: string | null }) {
  const label = scenarioLabel(scenario);

  return (
    <span
      aria-label={`Applies to ${label}`}
      className={cn(
        "inline-flex w-fit rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1",
        scenario === "llm_core" &&
          "bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950/50 dark:text-violet-300 dark:ring-violet-900",
        scenario === "rag" &&
          "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900",
        scenario === "agentic" &&
          "bg-state-caution-soft text-state-caution ring-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution dark:ring-state-caution/30",
        !scenario &&
          "bg-brand/10 text-brand-text ring-brand/25 dark:bg-brand/15 dark:text-brand dark:ring-brand/30",
      )}
    >
      {label}
    </span>
  );
}

function MetricFact({
  label,
  value,
  divided = false,
}: {
  label: string;
  value: string;
  divided?: boolean;
}) {
  return (
    <div className={cn("min-w-0", divided && "border-l")}>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-xs font-medium capitalize leading-4" title={value}>
        {value}
      </dd>
    </div>
  );
}

function scenarioLabel(value?: string | null) {
  if (!value) return "Shared";
  if (value === "llm_core") return "LLM";
  if (value === "rag") return "RAG";
  if (value === "agentic") return "Agent";
  return displayValue(value, "Shared");
}

function displayValue(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  return value.replaceAll("_", " ");
}
