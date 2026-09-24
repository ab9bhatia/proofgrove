"use client";

import { CopyIdButton } from "@/components/copyable-id";
import { useMemo } from "react";
import { MetadataBand, Datum } from "@/components/tracing/trace-facts";
import { traceMetadataFields } from "@/components/tracing/trace-metadata";
import { archivedSpanLabel, traceLlmTokenHint } from "@/components/tracing/trace-workspace";
import type { ArchivedTraceSpan, CapturedTraceDetail } from "@/lib/api";
import { formatDuration } from "@/lib/format-duration";
import { formatUsd } from "@/lib/format-usd";

/**
 * What this trace is, above the master-detail panes.
 *
 * This was a bordered card wrapping a second bordered band, which put two
 * raised surfaces above the two panes that are the actual subject. It is a
 * header strip now: a rule separates it, nothing boxes it, and the tree and
 * detail panes are left as the only cards on the screen.
 */
export function TraceSummary({
  trace,
  spans,
  spanCount,
  spansLoading,
  spansError,
}: {
  trace: CapturedTraceDetail;
  spans: ArchivedTraceSpan[];
  spanCount: number | null;
  spansLoading: boolean;
  spansError: string | null;
}) {
  const metadata = useMemo(() => traceMetadataFields(spans), [spans]);
  const llmTokenHint = useMemo(() => traceLlmTokenHint(spans), [spans]);
  const tokensValue =
    trace.total_tokens != null
      ? llmTokenHint && llmTokenHint !== `${trace.total_tokens} total`
        ? `${trace.total_tokens} (${llmTokenHint})`
        : String(trace.total_tokens)
      : llmTokenHint ?? "Not recorded";

  return (
    <section aria-label="Trace summary" className="border-b pb-5">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Datum label="Latency" value={formatDuration(trace.latency_ms) ?? "Not recorded"} />
        <Datum label="Tokens" value={tokensValue} />
        <Datum label="Cost" value={formatUsd(trace.cost) ?? "Not priced"} />
        <Datum label="AI operations" value={archivedSpanLabel(spanCount, spansLoading, spansError)} />
      </dl>
      <details className="mt-3 border-t pt-1">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Trace identifiers & metadata
        </summary>
        <div className="flex min-w-0 items-center gap-2 py-2 text-xs">
          <span className="break-all font-mono">Trace {trace.trace_id}</span>
          <CopyIdButton value={trace.trace_id} kind="trace" />
        </div>
        <dl className="grid gap-4 py-3 sm:grid-cols-3">
          {trace.trace_provider ? <Datum label="Provider" value={trace.trace_provider} /> : null}
          {trace.run_id ? <Datum label="Run ID" value={trace.run_id} mono /> : null}
          {trace.example_id ? <Datum label="Case" value={trace.example_id} mono /> : null}
        </dl>
        {metadata.length ? <MetadataBand fields={metadata} className="pb-3" /> : null}
      </details>
    </section>
  );
}
