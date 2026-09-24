"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { ErrorState, LoadingState } from "@/components/page-state";
import { TraceInspector } from "@/components/tracing/trace-inspector";
import { traceWarnings } from "@/components/tracing/trace-workspace";
import { CaptureBand } from "@/components/tracing/capture-band";
import { api, evaluationApi, type CapturedTraceDetail, type CapturedTraceSpans, type RunItemDetail } from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import {
  RunLineageCta,
  readabilityForTrace,
  resolveRunReadability,
  type ResolvedTraceReadability,
} from "@/components/tracing/run-lineage-cta";

export default function TraceDetailPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading captured trace…" className="min-h-[60vh]" />}>
      <TraceDetail />
    </Suspense>
  );
}

function TraceDetail() {
  const params = useParams<{ projectId: string; traceId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = decodeURIComponent(params.projectId);
  const traceId = decodeURIComponent(params.traceId);

  const [trace, setTrace] = useState<CapturedTraceDetail | null>(null);
  const [item, setItem] = useState<RunItemDetail | null>(null);
  const [spansData, setSpansData] = useState<CapturedTraceSpans | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [spansLoading, setSpansLoading] = useState(true);
  const [spansError, setSpansError] = useState<string | null>(null);
  // Run readability is stamped with the trace it was resolved against, so a
  // result carried over from a previously opened trace is never reused, and a
  // transient scores failure never masquerades as a workspace boundary.
  const [readability, setReadability] = useState<ResolvedTraceReadability>(null);

  // Summary (+ scores) never touches the span archive, so the header, the
  // partial-capture band and the Scores rail render even when the archive 503s.
  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    setReadability(null);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      const detail = await api.getProjectTraceSummary(projectId, traceId, tenantId);
      setTrace(detail);
      setItem(null);
      setScoreError(null);
      if (!detail.run_id || !detail.example_id) return;
      try {
        setScoreError(null);
        setItem(await evaluationApi.getRunItem(detail.run_id, detail.example_id, tenantId));
        setReadability({ traceId, readable: true });
      } catch (reason) {
        setItem(null);
        setScoreError(userFacingError(reason, "Unable to load trace scores"));
        // A 404 here can mean either "another workspace" or "this case is gone
        // from a readable run", so it is settled against the run endpoint; a
        // 500/503/network failure leaves readability unresolved.
        const resolved = await resolveRunReadability(reason, detail.run_id, tenantId);
        setReadability(resolved == null ? null : { traceId, readable: resolved });
      }
    } catch (reason) {
      setError(userFacingError(reason, "Unable to load this trace"));
    } finally {
      setLoading(false);
    }
  }, [projectId, traceId]);

  // Spans load independently; a 503 here breaks only the span panes.
  const loadSpans = useCallback(async () => {
    setSpansLoading(true);
    setSpansError(null);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      setSpansData(await api.getProjectTraceSpans(projectId, traceId, tenantId));
    } catch (reason) {
      setSpansData(null);
      setSpansError(userFacingError(reason, "Unable to load archived spans"));
    } finally {
      setSpansLoading(false);
    }
  }, [projectId, traceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSummary();
      void loadSpans();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSummary, loadSpans]);

  const selectedSpanId = searchParams.get("span");
  const selectSpan = useCallback(
    (query: string) => {
      router.replace(query ? `?${query}` : "?", { scroll: false });
    },
    [router],
  );

  const warnings = useMemo(() => (trace ? traceWarnings(trace) : []), [trace]);

  if (loading) return <LoadingState label="Loading captured trace…" className="min-h-[60vh]" />;
  if (error || !trace) {
    return <ErrorState message={error || "Trace not found"} onRetry={() => void loadSummary()} />;
  }

  return (
    <div>
      <Link
        href={`/projects/${encodeURIComponent(projectId)}/traces`}
        className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> Captured traces
      </Link>

      <div className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-balance text-xl font-semibold tracking-tight sm:text-2xl">{trace.evaluation_name || trace.root_span_name || "Captured trace"}</h2>

        </div>
        <RunLineageCta
          runId={trace.run_id}
          exampleId={trace.example_id}
          readable={readabilityForTrace(traceId, readability)}
        />
      </div>

      <CaptureBand warnings={warnings} />

      <TraceInspector
        trace={trace}
        spans={spansData}
        spansLoading={spansLoading}
        spansError={spansError}
        onRetrySpans={() => void loadSpans()}
        item={item}
        scoreError={scoreError}
        onRetryScores={() => void loadSummary()}
        selectedSpanId={selectedSpanId}
        currentQuery={searchParams.toString()}
        onSelectSpan={selectSpan}
        variant="page"
      />
    </div>
  );
}
