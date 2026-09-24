"use client";

import { useEffect, useMemo } from "react";
import { SelectedAnnotationSummary } from "@/components/tracing/case-annotation";
import { SpanDetailPane } from "@/components/tracing/span-detail-pane";
import { SpanTreePane } from "@/components/tracing/span-tree-pane";
import { TraceSummary } from "@/components/tracing/trace-summary";
import { semanticSpanKind } from "@/components/tracing/span-tree";
import {
  spanHasError,
  resolveSelectedSpanId,
  spanSelectionQuery,
  inspectorLayout,
  traceSpanEmptyMessage,
  type InspectorVariant,
} from "@/components/tracing/trace-workspace";
import type {
  CapturedTraceDetail,
  CapturedTraceSpans,
  RunItemDetail,
} from "@/lib/api";
import { cn } from "@evalai/shared/utils";

// Span selection is URL-driven and controls both detail and annotations.

export function TraceInspector({
  trace,
  spans: spansData,
  spansLoading,
  spansError,
  onRetrySpans,
  item,
  scoreError,
  onRetryScores,
  selectedSpanId,
  currentQuery,
  onSelectSpan,
  variant = "flow",
}: {
  trace: CapturedTraceDetail;
  spans: CapturedTraceSpans | null;
  spansLoading: boolean;
  spansError: string | null;
  onRetrySpans: () => void;
  item: RunItemDetail | null;
  scoreError: string | null;
  onRetryScores: () => void;
  selectedSpanId: string | null;
  currentQuery: string;
  onSelectSpan: (query: string) => void;
  variant?: InspectorVariant;
}) {
  const layout = inspectorLayout(variant);
  // Standalone project spans can have annotations without an evaluation case.
  const hasAnnotations = Boolean(scoreError || item || trace.project_id);
  const spans = useMemo(() => spansData?.spans ?? [], [spansData?.spans]);
  const emptySpanMessage = traceSpanEmptyMessage(
    spansData?.lifecycle_message,
    trace.lifecycle_message,
  );
  // Default to recorded AI operations, while preserving links to older untyped spans.
  const selectableSpans = useMemo(() => spans.filter((span) => semanticSpanKind(span) !== null), [spans]);
  const firstError = new URLSearchParams(currentQuery).has("errors") && !selectedSpanId ? selectableSpans.find(spanHasError)?.span_id : null;
  const effectiveSelected = firstError || resolveSelectedSpanId(spans.some((span) => span.span_id === selectedSpanId) ? spans : selectableSpans, selectedSpanId);
  const selected = spans.find((span) => span.span_id === effectiveSelected) ?? null;

  // Canonicalise the URL once the archive has loaded: a stale/absent `span`
  // param that resolved to a different real span is rewritten to the resolved
  // id (via router.replace), so the address bar reflects the actual selection.
  useEffect(() => {
    if (!spansData) return;
    if (effectiveSelected && effectiveSelected !== selectedSpanId) {
      onSelectSpan(spanSelectionQuery(currentQuery, effectiveSelected));
    }
  }, [spansData, effectiveSelected, selectedSpanId, currentQuery, onSelectSpan]);

  return (
    <div className="mt-5">
      <TraceSummary
        trace={trace}
        spans={spans}
        spanCount={spansData ? selectableSpans.length : null}
        spansLoading={spansLoading}
        spansError={spansError}
      />
      <div
        className={cn(
          "mt-5 grid gap-4",
          // The three-column case (tree + detail + annotation) only earns a
          // third column at xl (1280px): at lg its minmax floors alone (14rem
          // + 14rem) leave the detail pane under 200px in the trace drawer,
          // whose own width is capped below the viewport. Below xl it stays
          // two columns and the annotation section spans full width instead.
          hasAnnotations
            ? "md:grid-cols-[minmax(13rem,0.7fr)_minmax(0,1.6fr)] xl:grid-cols-[minmax(14rem,0.7fr)_minmax(0,1.9fr)_minmax(14rem,0.8fr)]"
            : "md:grid-cols-[minmax(14rem,0.75fr)_minmax(0,1.75fr)] lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,2fr)]",
          layout.grid,
        )}
      >
        <section aria-label="Span tree" className={cn("min-w-0 rounded-xl border bg-card", layout.section)}>
          <h3 className="shrink-0 border-b px-4 py-3 text-sm font-medium">Span tree</h3>
          <SpanTreePane
            spans={spans}
            loading={spansLoading}
            error={spansError}
            onRetry={onRetrySpans}
            selectedId={effectiveSelected}
            onSelect={(spanId) => onSelectSpan(spanSelectionQuery(currentQuery, spanId))}
            emptyMessage={emptySpanMessage}
            scrollClassName={layout.tree}
          />
        </section>

        <section aria-label="Selected span" className={cn("min-w-0 rounded-xl border bg-card", layout.section)}>
          <h3 className="shrink-0 border-b px-4 py-3 text-sm font-medium">Span detail</h3>
          <SpanDetailPane
            loading={spansLoading}
            error={spansError}
            onRetry={onRetrySpans}
            span={selected}
            emptyMessage={spans.length ? "Select a span to inspect its input, output and details." : emptySpanMessage}
            scrollClassName={layout.detail}
          />
        </section>

        {hasAnnotations ? (
          <section
            aria-label="Annotation summary"
            className={cn("min-w-0 rounded-xl border bg-card md:col-span-2 xl:col-span-1", layout.section)}
          >
            <h3 className="shrink-0 border-b px-4 py-3 text-sm font-medium">Annotation summary</h3>
            <div className={cn("p-4", layout.detail)}>
              <SelectedAnnotationSummary item={item} span={selected} projectId={trace.project_id} error={scoreError} onRetry={onRetryScores} />
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
