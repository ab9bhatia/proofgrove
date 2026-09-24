"use client";

import { PAGE_FRAME } from "@/lib/page-frame";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { EvalHubGate } from "@/components/eval-hub-gate";
import { EvaluationRunProgress } from "@/components/evaluation/run-progress";
import { AutomaticSpanScoringStatus } from "@/components/tracing/span-scoring";
import { ReportView } from "@/components/report/view";
import Link from "next/link";
import { ErrorState, LoadingState } from "@/components/page-state";
import { api, evaluationApi, type JobStatus, type RunResult } from "@/lib/api";
import { ApiError, userFacingError } from "@/lib/api-errors";

const ACTIVE_STATUSES = new Set(["pending", "running", "awaiting_trace"]);
const POLL_MS = 3000;

/**
 * URL contract of the run report page: `/runs/{id}?item={caseId}&caseFilter=…`.
 *
 * `rawId` is the route segment as Next delivers it (percent-encoded), so the
 * run id is decoded here exactly once; `item` values arrive already decoded
 * from the search params. This is the counterpart of the reviews page's
 * `runEvidenceHref` — the two must round-trip, which the regression tests pin.
 */
export function runReportRequest(
  rawId: string,
  searchParams: { get(name: string): string | null },
): { runId: string; itemId: string | null; caseFilter: "all" | "attention" | "passed" } {
  const requestedCaseFilter = searchParams.get("caseFilter");
  return {
    runId: decodeURIComponent(rawId),
    itemId: searchParams.get("item")?.trim() || null,
    caseFilter:
      requestedCaseFilter === "attention" || requestedCaseFilter === "passed"
        ? requestedCaseFilter
        : "all",
  };
}

/**
 * Honest failure copy for the run read. Run reads are tenant-scoped, so a 404
 * usually means the run is real but not readable in this workspace (recorded
 * under another tenant, or persisted before workspace scoping existed) — the
 * review queue can still reference such runs. The generic "requested item"
 * copy hid that, which read as a broken deep link.
 */
export function runLoadErrorMessage(reason: unknown, deepLinkedItemId: string | null): string {
  if (reason instanceof ApiError && reason.status === 404) {
    return deepLinkedItemId
      ? "This case's run report is not readable in this workspace. The linked run was recorded under another workspace or before workspace scoping, so its evidence cannot be opened from here."
      : "This run was not found in this workspace. It may belong to another workspace or may have been removed.";
  }
  return userFacingError(reason, "Unable to load this run");
}

export default function RunDetailPage() {
  return (
    <EvalHubGate>
      <RunDetail />
    </EvalHubGate>
  );
}

function RunDetail() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const {
    runId,
    itemId: requestedItemId,
    caseFilter: initialCaseFilter,
  } = runReportRequest(params.id, searchParams);
  const [run, setRun] = useState<RunResult | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    async function refresh() {
      try {
        const { tenant_id: tenantId } = await api.tenant();
        const result = await evaluationApi.getRun(runId, tenantId);
        if (!active) return;
        if ("metric_results" in result && Array.isArray(result.metric_results)) {
          setRun(result);
          setJob(null);
          setError(null);
          return;
        }
        setRun(null);
        setJob(result);
        setError(null);
        if (ACTIVE_STATUSES.has((result.status || "").toLowerCase())) {
          timer = window.setTimeout(() => {
            void refresh();
          }, POLL_MS);
        }
      } catch (reason) {
        if (active) {
          setError(runLoadErrorMessage(reason, requestedItemId));
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void refresh();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [reloadKey, runId, requestedItemId]);

  if (loading) {
    return <LoadingState label="Loading evaluation run…" className="min-h-[60vh] border-0" />;
  }

  return (
    <div className={PAGE_FRAME}>
      {error ? (
        <>
          <ErrorState
            message={error}
            onRetry={() => {
              setLoading(true);
              setError(null);
              setReloadKey((value) => value + 1);
            }}
          />
          {/* A run that cannot be opened left the user with nothing but Retry,
              which cannot help when the run belongs to another workspace. Same
              way out the dataset page already offers. */}
          <p className="mt-4 text-center text-sm">
            <Link href="/evaluations" className="text-primary hover:underline">
              Back to the evaluations library
            </Link>
          </p>
        </>
      ) : run ? (
        <><AutomaticSpanScoringStatus runId={runId} /><ReportView
          run={run}
          initialCaseId={requestedItemId}
          initialCaseFilter={initialCaseFilter}
        /></>
      ) : (
        <EvaluationRunProgress
          status={job?.status || "pending"}
          runId={runId}
          errorMessage={job?.error_message}
        />
      )}
    </div>
  );
}
