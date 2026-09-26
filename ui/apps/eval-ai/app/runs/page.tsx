"use client";

import { PAGE_FRAME } from "@/lib/page-frame";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { ProofgroveGate } from "@/components/proofgrove-gate";
import { ExperimentsLibrary } from "@/components/experiments-library";
import { PageHeader } from "@/components/page-header";
import { LoadingState } from "@/components/page-state";
import type { RunResult } from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import { hasActiveRunStatus, loadRunsWithLiveStatus } from "@/lib/live-runs";
import { cn } from "@evalai/shared/utils";

const POLL_MS = 2000;

export default function RunsPage() {
  return (
    <ProofgroveGate>
      <Suspense fallback={<LoadingState label="Loading runs…" className="min-h-[60vh] border-0" />}>
        <RunsList />
      </Suspense>
    </ProofgroveGate>
  );
}

export function RunsList({ embedded = false }: { embedded?: boolean }) {
  const searchParams = useSearchParams();
  // `run` retains the historical deep-link behaviour (open the run drawer).
  // `highlight` keeps the complete history visible while drawing attention to
  // a newly launched run.
  const highlightRunId =
    searchParams.get("highlight")?.trim() || searchParams.get("run")?.trim() || "";
  const [runs, setRuns] = useState<RunResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoaded = useRef(false);

  const load = useCallback(async (opts?: { quiet?: boolean; manual?: boolean }) => {
    if (opts?.manual) setRefreshing(true);
    else if (!opts?.quiet || !hasLoaded.current) setLoading(true);
    if (!opts?.quiet) setError(null);
    try {
      setRuns(await loadRunsWithLiveStatus({ highlightRunId }));
      hasLoaded.current = true;
    } catch (reason) {
      if (!opts?.quiet) {
        setRuns([]);
        setError(userFacingError(reason, "Unable to load runs"));
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [highlightRunId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (!hasActiveRunStatus(runs, highlightRunId)) return;
    const timer = window.setInterval(() => void load({ quiet: true }), POLL_MS);
    return () => window.clearInterval(timer);
  }, [runs, highlightRunId, load]);

  return (
    <div className={cn(embedded ? "" : `${PAGE_FRAME}`)}>
      {!embedded ? (
        <PageHeader
          section="Evaluate"
          title="Evaluation runs"
          description="Inspect immutable evaluation executions, including work in progress, evidence coverage, verdicts, and quality outcomes."
          actions={
            <Button type="button" variant="outline" size="sm" onClick={() => void load({ manual: true })} disabled={refreshing || loading}>
              <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden="true" />
              Refresh
            </Button>
          }
        />
      ) : null}
      {error ? <div role="alert" className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div> : null}
      <ExperimentsLibrary
        runs={runs}
        loading={loading && runs.length === 0}
        highlightRunId={highlightRunId}
        embedded={embedded}
        refreshing={refreshing}
        onManualRefresh={() => void load({ manual: true })}
        onRefresh={() => load({ quiet: true })}
      />
    </div>
  );
}
