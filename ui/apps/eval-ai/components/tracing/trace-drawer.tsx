"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { ErrorState, LoadingState } from "@/components/page-state";
import { CaptureBand } from "@/components/tracing/capture-band";
import { TraceInspector } from "@/components/tracing/trace-inspector";
import { traceWarnings } from "@/components/tracing/trace-workspace";
import {
  api,
  evaluationApi,
  type CapturedTraceDetail,
  type CapturedTraceSpans,
  type RunItemDetail,
} from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import {
  RunLineageCta,
  readabilityForTrace,
  resolveRunReadability,
  type ResolvedTraceReadability,
} from "@/components/tracing/run-lineage-cta";
import { Dialog } from "@/components/ui/dialog";

/**
 * Master-detail drawer for the Traces tab (lg+): renders the same
 * TraceInspector as the full trace page inline over the list, so the list
 * stays mounted and keeps its scroll position. Driven by the `?trace=` /
 * `?span=` URL params owned by the caller; the full page at
 * /projects/{id}/traces/{traceId} remains the deep-link and <lg surface.
 *
 * Data loading mirrors the trace detail page: the summary (+ scores) never
 * touches the span archive, so a spans 503 degrades only the span panes.
 */
export function TraceDrawer({
  projectId,
  traceId,
  selectedSpanId,
  currentQuery,
  onSelectSpan,
  onClose,
}: {
  projectId: string;
  traceId: string;
  selectedSpanId: string | null;
  /** Current query string, so span selection preserves the list's params. */
  currentQuery: string;
  /** Receives the full query string that selects a span. */
  onSelectSpan: (query: string) => void;
  onClose: () => void;
}) {
  const [trace, setTrace] = useState<CapturedTraceDetail | null>(null);
  const [item, setItem] = useState<RunItemDetail | null>(null);
  const [spansData, setSpansData] = useState<CapturedTraceSpans | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [spansLoading, setSpansLoading] = useState(true);
  const [spansError, setSpansError] = useState<string | null>(null);
  // Unlike the full trace page, the drawer keeps its header mounted while the
  // next trace loads, so run readability is stamped with the trace it was
  // resolved for. A flag left over from the previous trace must never render a
  // run link for the trace now loading.
  const [readability, setReadability] = useState<ResolvedTraceReadability>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  // Cancellation token. The drawer stays mounted across trace switches, so a
  // late-resolving request for an earlier trace would otherwise win the
  // setState race and render trace A's summary, warnings and spans under trace
  // B's header. Every write is gated on still being the current request.
  const requestId = useRef(0);

  const loadSummary = useCallback(async (token: number) => {
    const cancelled = () => token !== requestId.current;
    setLoading(true);
    setError(null);
    setReadability(null);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      const detail = await api.getProjectTraceSummary(projectId, traceId, tenantId);
      if (cancelled()) return;
      setTrace(detail);
      setItem(null);
      setScoreError(null);
      if (!detail.run_id || !detail.example_id) return;
      try {
        setScoreError(null);
        const item = await evaluationApi.getRunItem(detail.run_id, detail.example_id, tenantId);
        if (cancelled()) return;
        setItem(item);
        setReadability({ traceId, readable: true });
      } catch (reason) {
        if (cancelled()) return;
        setItem(null);
        setScoreError(userFacingError(reason, "Unable to load trace scores"));
        // A 404 on the item is settled against the run endpoint before any
        // workspace claim; a transient failure leaves readability unresolved so
        // the CTA renders nothing. The extra await is another chance for this
        // trace to be superseded, so cancellation is re-checked after it.
        const resolved = await resolveRunReadability(reason, detail.run_id, tenantId);
        if (cancelled()) return;
        setReadability(resolved == null ? null : { traceId, readable: resolved });
      }
    } catch (reason) {
      if (cancelled()) return;
      setError(userFacingError(reason, "Unable to load this trace"));
    } finally {
      if (!cancelled()) setLoading(false);
    }
  }, [projectId, traceId]);

  const loadSpans = useCallback(async (token: number) => {
    const cancelled = () => token !== requestId.current;
    setSpansLoading(true);
    setSpansError(null);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      const spans = await api.getProjectTraceSpans(projectId, traceId, tenantId);
      if (cancelled()) return;
      setSpansData(spans);
    } catch (reason) {
      if (cancelled()) return;
      setSpansData(null);
      setSpansError(userFacingError(reason, "Unable to load archived spans"));
    } finally {
      if (!cancelled()) setSpansLoading(false);
    }
  }, [projectId, traceId]);

  useEffect(() => {
    const token = ++requestId.current;
    const timer = window.setTimeout(() => {
      void loadSummary(token);
      void loadSpans(token);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSummary, loadSpans]);

  const warnings = useMemo(() => (trace ? traceWarnings(trace) : []), [trace]);
  // null until the currently requested trace has resolved its own readability.
  const runLinkReadable = readabilityForTrace(traceId, readability);
  const fullPageHref = `/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}${selectedSpanId ? `?span=${encodeURIComponent(selectedSpanId)}` : ""}`;

  return (
    <Dialog
      variant="drawer"
      as="aside"
      labelledBy="trace-drawer-title"
      scrimLabel="Close trace"
      onClose={onClose}
      initialFocusRef={titleRef}
      // Wide enough for tree beside span detail, but still a drawer over the
      // list: at 96vw it read as a second page and lost the sense that the
      // trace list is still behind it.
      // Narrower than a full page, but never narrower than the width below the
      // breakpoint — dropping at lg made the detail pane smaller on a bigger
      // screen, which is the opposite of the point.
      width="sm:w-[94vw] lg:w-[86vw] xl:w-[76rem]"
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Captured trace
          </p>
          <h2
            ref={titleRef}
            id="trace-drawer-title"
            tabIndex={-1}
            className="mt-1 line-clamp-2 text-lg font-semibold leading-6 outline-none"
          >
            {trace?.evaluation_name || trace?.root_span_name || "Captured trace"}
          </h2>

        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href={fullPageHref}
            className="inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Full page <ExternalLink className="size-3.5" aria-hidden="true" />
          </Link>
          {trace && runLinkReadable != null ? (
            <div className="hidden sm:block">
              <RunLineageCta
                runId={trace.run_id}
                exampleId={trace.example_id}
                readable={runLinkReadable}
              />
            </div>
          ) : null}
          <button
            type="button"
            aria-label="Close trace"
            onClick={onClose}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg border outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* The body scrolls at every width. The pane grid is sized for a
          standalone page (a viewport-height calculation), so inside a drawer
          the summary and capture band above it push the grid past the bottom
          edge — clipping it here left that overflow unreachable. Panes still
          own their own scroll on lg, so this only moves what they overflow. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pb-6 sm:px-6">
        {loading ? (
          <LoadingState label="Loading captured trace…" className="min-h-[40vh]" />
        ) : error || !trace ? (
          <ErrorState message={error || "Trace not found"} onRetry={() => void loadSummary(requestId.current)} />
        ) : (
          <>
            <CaptureBand warnings={warnings} />
            <TraceInspector
              trace={trace}
              spans={spansData}
              spansLoading={spansLoading}
              spansError={spansError}
              onRetrySpans={() => void loadSpans(requestId.current)}
              item={item}
              scoreError={scoreError}
              onRetryScores={() => void loadSummary(requestId.current)}
              selectedSpanId={selectedSpanId}
              currentQuery={currentQuery}
              onSelectSpan={onSelectSpan}
              variant="page"
            />
          </>
        )}
      </div>
    </Dialog>
  );
}
