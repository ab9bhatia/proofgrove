"use client";

import { isMeasurement, metricDisplayName, nativeMetricValue } from "@/components/report/lib";
import { ErrorState } from "@/components/page-state";
import { SpanScoring } from "@/components/tracing/span-scoring";
import type { ArchivedTraceSpan, RunItemDetail } from "@/lib/api";
import { AnnotationChip } from "@/components/tracing/annotation-chip";

/**
 * Case-level scores. Renders whenever there is something honest to say —
 * scores, or the fact that they could not be loaded — regardless of what the
 * span archive is doing.
 */
export function CaseAnnotationSummary({
  item,
  error,
  onRetry,
}: {
  item: RunItemDetail | null;
  error: string | null;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <ErrorState title="Trace scores unavailable" message={error} onRetry={onRetry} />
    );
  }
  const scoredResults = item?.scorer_results.filter(score =>
    (!score.metric_status || score.metric_status === "scored") &&
    score.metric_applicability !== "not_applicable" && score.unscored_reason !== "simulated" &&
    (score.score != null || score.normalised_score != null),
  ) ?? [];
  if (!scoredResults.length) {
    return (
      <p className="text-sm leading-6 text-muted-foreground">Scores not recorded for this captured case.</p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-muted-foreground">Whole case</p>
      </div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {scoredResults.map((score) => {
          const state = isMeasurement(score.metric_id)
            ? nativeMetricValue(score.metric_id, score.score) ?? String(score.score)
            : score.normalised_score != null
              ? `${Math.round(score.normalised_score * 100)}%`
              : String(score.score);
          return (
            <li key={score.metric_id} className="min-w-0 max-w-full">
              <AnnotationChip metricId={score.metric_id} name={metricDisplayName(score.metric_id)} value={state} explanation={score.rationale} evaluator={score.judge_model || score.executed_scorer} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Case metrics belong only to the recorded execution target, never an arbitrary parent. */
export function SelectedAnnotationSummary({ item, span, projectId, error, onRetry }: {
  item: RunItemDetail | null;
  span: ArchivedTraceSpan | null;
  projectId: string | null;
  error: string | null;
  onRetry: () => void;
}) {
  const isCaseTarget = span && item &&
    item.execution.trace_id === span.trace_id && item.execution.span_id === span.span_id;
  if (isCaseTarget || !span) {
    return <CaseAnnotationSummary item={item} error={error} onRetry={onRetry} />;
  }
  return projectId
    ? <SpanScoring key={`${span.trace_id}:${span.span_id}`} projectId={projectId} selections={[{ trace_id: span.trace_id, span_id: span.span_id }]} annotationSummary />
    : <p className="text-sm text-muted-foreground">Span scores require a linked project.</p>;
}
