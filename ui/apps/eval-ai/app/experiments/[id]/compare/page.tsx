"use client";

import { PAGE_FRAME } from "@/lib/page-frame";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GitCompareArrows,
  Loader2,
  Wrench,
  X,
} from "lucide-react";
import { ProofgroveGate } from "@/components/proofgrove-gate";
import { CopyableId } from "@/components/copyable-id";
import { Dialog } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs";
import { LegacyEvaluationRouteRedirect } from "@/components/legacy-evaluation-redirect";
import { userFacingError } from "@/lib/api-errors";
import {
  api,
  evaluationApi,
  type MetricResult,
  type RunComparison,
  type RunItemDetail,
  type RunItemSummary,
  type RunResult,
} from "@/lib/api";
import { gatedRunScore, presentRunOutcome } from "@/lib/run-outcome";
import { runDetailsHref, runInvokesTarget, runLabel } from "@/lib/run-recommendation";
import { datasetVersionLabel } from "@/lib/dataset-lineage";
import { cn } from "@evalai/shared/utils";
import { SearchField } from "@/components/toolbar";
import { formatDuration } from "@/lib/format-duration";
import { metricResultIsScored } from "@/components/report/lib";

import { EvaluatorComparisonTable } from "@/components/experiments/evaluator-comparison-table";
export { EvaluatorComparisonTable } from "@/components/experiments/evaluator-comparison-table";

import { ExperimentAnalysisPanel } from "@/components/experiments/analysis-panel";
import { readAnalysisUrlState, writeAnalysisSearchParams, type AnalysisUrlState } from "@/lib/chart-data";

type Tab = "overview" | "samples" | "configuration";
type SampleFilter = "all" | "improved" | "regressed" | "failed";

const MAX_COMPARISON_RUNS = 4;
const RUN_LABELS = ["Baseline", "Candidate 1", "Candidate 2", "Candidate 3"] as const;

function comparisonTargetLabel(run: RunResult): string {
  const invoked = runInvokesTarget(run);
  if (invoked === false) return "Not invoked";
  if (invoked === null) return "Not recorded";
  return run.experiment?.target_version || run.experiment?.target_endpoint || "Not recorded";
}

// Shared implementation, rendered at the canonical `/evaluations/:id/compare` route.
export function ExperimentComparePage() {
  return (
    <ProofgroveGate>
      <Suspense fallback={<PageLoader />}>
        <CompareView />
      </Suspense>
    </ProofgroveGate>
  );
}

// Legacy `/experiments/:id/compare` route → forwards to `/evaluations/:id/compare`.
/** Every operational metric either run measured, in a stable order. */
function measurementMetricIds(comparisons: RunComparison[]): string[] {
  const ids = new Set<string>();
  for (const comparison of comparisons) {
    for (const measurement of comparison.measurement_deltas ?? []) {
      if (measurement.base != null || measurement.candidate != null) ids.add(measurement.metric_id);
    }
  }
  return [...ids].sort();
}

export default function ExperimentCompareRedirect() {
  return <LegacyEvaluationRouteRedirect />;
}

function PageLoader() {
  return (
    <div className="flex justify-center py-24">
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>
  );
}

function isRunResult(value: Awaited<ReturnType<typeof evaluationApi.getRun>>): value is RunResult {
  return "metric_results" in value && Array.isArray(value.metric_results);
}

/** The run ids the URL explicitly names: baseline first, then candidates, deduped and capped. */
export function requestedComparisonRunIds(searchParams: {
  get(name: string): string | null;
  getAll(name: string): string[];
}): string[] {
  return [
    searchParams.get("baseline_run_id") ?? searchParams.get("base"),
    ...(
      searchParams.getAll("candidate_run_id").length
        ? searchParams.getAll("candidate_run_id")
        : searchParams.getAll("candidate")
    ),
  ]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, MAX_COMPARISON_RUNS);
}

/**
 * Resolve the URL's requested run ids against the runs that actually exist.
 * Renders exactly what the user asked for: unknown ids are dropped and NO
 * additional runs are ever auto-filled — a short selection stays short and the
 * page asks the user to pick more instead of silently mutating their intent.
 */
export function resolveComparisonSelection(requestedIds: string[], runs: RunResult[]): string[] {
  return requestedIds
    .filter((value, index, all) => all.indexOf(value) === index)
    .filter((id) => runs.some((run) => run.run_id === id))
    .slice(0, MAX_COMPARISON_RUNS);
}

/** Analysis view state mirrored to the URL so a comparison session is shareable. */
export type CompareViewState = {
  tab: Tab;
  sampleFilter: SampleFilter;
  metricFilter: string;
  sampleQuery: string;
  selectedSample: string | null;
};

export function readCompareViewState(params: { get(name: string): string | null }): CompareViewState {
  const tab = params.get("tab");
  const sampleFilter = params.get("sampleFilter");
  return {
    tab: tab === "samples" || tab === "configuration" ? tab : "overview",
    sampleFilter:
      sampleFilter === "improved" || sampleFilter === "regressed" || sampleFilter === "failed"
        ? sampleFilter
        : "all",
    metricFilter: params.get("metric") || "all",
    sampleQuery: params.get("q") ?? "",
    selectedSample: params.get("sample"),
  };
}

export function writeCompareViewState(current: string, state: CompareViewState): string {
  const params = new URLSearchParams(current);
  const set = (key: string, value: string) => (value ? params.set(key, value) : params.delete(key));
  set("tab", state.tab === "overview" ? "" : state.tab);
  set("sampleFilter", state.sampleFilter === "all" ? "" : state.sampleFilter);
  set("metric", state.metricFilter === "all" ? "" : state.metricFilter);
  set("q", state.sampleQuery.trim());
  set("sample", state.selectedSample ?? "");
  return params.toString();
}

function CompareView() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const experimentId = decodeURIComponent(params.id);

  const initialView = readCompareViewState(searchParams);
  const [analysis, setAnalysis] = useState(() => readAnalysisUrlState(searchParams));
  const updateAnalysis = (patch: Partial<AnalysisUrlState>) => {
    setAnalysis(current => ({ ...current, ...patch }));
  };
  // Drawer, tab and filter changes must not reload the selected runs.
  const requestedRunIdsKey = JSON.stringify(requestedComparisonRunIds(searchParams));
  const [runs, setRuns] = useState<RunResult[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [itemsByRun, setItemsByRun] = useState<Record<string, RunItemSummary[]>>({});
  const [detailsByRun, setDetailsByRun] = useState<Record<string, RunItemDetail | null>>({});
  const [comparisons, setComparisons] = useState<RunComparison[]>([]);
  const [incompatibleIds, setIncompatibleIds] = useState<string[]>([]);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>(initialView.tab);
  const [sampleFilter, setSampleFilter] = useState<SampleFilter>(initialView.sampleFilter);
  const [metricFilter, setMetricFilter] = useState(initialView.metricFilter);
  const [sampleQuery, setSampleQuery] = useState(initialView.sampleQuery);
  const [selectedSample, setSelectedSample] = useState<string | null>(initialView.selectedSample);
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-hydrate local view state when the router navigates to a different query
  // (e.g. client-side nav to a shared link) so the URL stays authoritative.
  const lastNavQuery = useRef(searchParams.toString());
  useEffect(() => {
    const current = searchParams.toString();
    if (current === lastNavQuery.current) return;
    lastNavQuery.current = current;
    const next = readCompareViewState(searchParams);
    setAnalysis(readAnalysisUrlState(searchParams));
    setActiveTab(next.tab);
    setSampleFilter(next.sampleFilter);
    setMetricFilter(next.metricFilter);
    setSampleQuery(next.sampleQuery);
    setSelectedSample(next.selectedSample);
  }, [searchParams]);

  // Mirror the analysis view to the URL (preserving baseline/candidate params)
  // so a comparison session survives reload and can be shared. Also tracked in
  // lastNavQuery so our own router write is never mistaken for a navigation.
  useEffect(() => {
    const current = searchParams.toString();
    const query = writeCompareViewState(writeAnalysisSearchParams(current, analysis), {
      tab: activeTab,
      sampleFilter,
      metricFilter,
      sampleQuery,
      selectedSample,
    });
    if (query === current) return;
    lastNavQuery.current = query;
    router.replace(query ? `?${query}` : window.location.pathname, { scroll: false });
  }, [activeTab, analysis, metricFilter, router, sampleFilter, sampleQuery, searchParams, selectedSample]);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const requestedIds = JSON.parse(requestedRunIdsKey) as string[];
      const { tenant_id: tenantId } = await api.tenant();
      const [experimentRuns, requestedResults] = await Promise.all([
        evaluationApi.listExperimentRuns(experimentId),
        Promise.all(requestedIds.map((runId) => evaluationApi.getRun(runId, tenantId))),
      ]);
      const list = [...requestedResults.filter(isRunResult), ...experimentRuns].filter(
        (run, index, all) => all.findIndex((candidate) => candidate.run_id === run.run_id) === index,
      );
      setRuns(list);
      // Exactly the runs the URL requested — never auto-fill extra runs.
      setSelectedIds(resolveComparisonSelection(requestedIds, list));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [experimentId, requestedRunIdsKey]);

  useEffect(() => {
    // Loading remote run state is the effect's synchronization boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (selectedIds.length === 0) return;
    let cancelled = false;
    Promise.all(
      selectedIds.map(async (runId) => {
        try {
          const { tenant_id: tenantId } = await api.tenant();
          return [runId, await evaluationApi.listRunItems(runId, tenantId)] as const;
        } catch {
          return [runId, []] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setItemsByRun(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedIds]);

  const selectedRuns = useMemo(
    () => selectedIds.map((runId) => runs.find((run) => run.run_id === runId)).filter(Boolean) as RunResult[],
    [runs, selectedIds],
  );

  useEffect(() => {
    if (selectedRuns.length < 2) return;
    let cancelled = false;
    // Comparison results are remote state synchronized to the selected runs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setComparisonLoading(true);
    setError(null);
    setIncompatibleIds([]);
    const baseline = selectedRuns[0]!;
    const candidates = selectedRuns.slice(1);
    // The route identifies the experiment workspace that owns the comparison.
    // Attached historical runs retain their original evaluation IDs, which are
    // intentionally different and cannot authorize a workspace comparison.
    const backendExperimentId = experimentId;
    // Compare each candidate independently so one incompatible run can be
    // identified precisely instead of poisoning the whole comparison.
    void api
      .tenant()
      .then(({ tenant_id: tenantId }) =>
        Promise.allSettled(
          candidates.map((candidate) =>
            evaluationApi.compareRuns(
              backendExperimentId,
              baseline.run_id,
              candidate.run_id,
              tenantId,
              metricFilter === "all" ? undefined : metricFilter,
            ),
          ),
        ),
      )
      .then((results) => {
        if (cancelled) return;
        const failedIds = candidates
          .filter((_, index) => results[index]!.status === "rejected")
          .map((candidate) => candidate.run_id);
        if (failedIds.length) {
          // Never render authoritative numbers over an error: drop every
          // comparison and surface the incompatible runs for removal.
          setComparisons([]);
          setIncompatibleIds(failedIds);
          const firstRejection = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          const reason = firstRejection?.reason;
          setError(reason instanceof Error ? reason.message : "These runs cannot be compared safely");
        } else {
          setComparisons(
            results.map((result) => (result as PromiseFulfilledResult<RunComparison>).value),
          );
          setIncompatibleIds([]);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        // The chain starts at `api.tenant()`, which rejects when the workspace
        // cannot be resolved (503). Without this the spinner would clear onto an
        // empty comparison and the rejection would go unhandled.
        setComparisons([]);
        setIncompatibleIds([]);
        setError(userFacingError(reason, "This comparison could not be loaded. Try again."));
      })
      .finally(() => {
        if (!cancelled) setComparisonLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [experimentId, metricFilter, selectedRuns]);

  const metrics = useMemo(() => {
    const all = new Set<string>();
    selectedRuns.forEach((run) => run.kpi_results.forEach((kpi) => all.add(kpi.kpi_id)));
    return [...all];
  }, [selectedRuns]);

  const samples = useMemo(
    () => buildBackendSampleRows(selectedRuns, itemsByRun, comparisons),
    [selectedRuns, itemsByRun, comparisons],
  );

  const filteredSamples = useMemo(() => {
    const query = sampleQuery.trim().toLowerCase();
    return samples.filter((sample) => {
      if (query && !`${sample.name} ${sample.exampleId}`.toLowerCase().includes(query)) return false;
      if (sampleFilter === "improved" && !sample.candidateResults.includes("Improved")) return false;
      if (sampleFilter === "regressed" && !sample.candidateResults.includes("Regressed")) return false;
      if (sampleFilter === "failed" && !sample.failed) return false;
      return true;
    });
  }, [samples, sampleFilter, sampleQuery]);

  const summary = useMemo(
    () => buildSummary(selectedRuns, samples, comparisons),
    [selectedRuns, samples, comparisons],
  );

  function updateRun(index: number, runId: string) {
    setSelectedIds((current) => {
      const next = [...current];
      next[index] = runId;
      return next.filter((value, valueIndex, all) => all.indexOf(value) === valueIndex);
    });
    setSelectedSample(null);
    setDetailsByRun({});
  }

  function removeRun(runId: string) {
    setSelectedIds((current) => current.filter((id) => id !== runId));
    setSelectedSample(null);
    setDetailsByRun({});
  }

  async function openSample(exampleId: string) {
    setSelectedSample(exampleId);
    setDetailsLoading(true);
    setDetailsByRun({});
    const { tenant_id: tenantId } = await api.tenant();
    const entries = await Promise.all(
      selectedRuns.map(async (run) => {
        const item = (itemsByRun[run.run_id] ?? []).find((candidate) => candidate.example_id === exampleId);
        if (!item) return [run.run_id, null] as const;
        try {
          return [run.run_id, await evaluationApi.getRunItem(run.run_id, exampleId, tenantId)] as const;
        } catch {
          return [run.run_id, null] as const;
        }
      }),
    );
    setDetailsByRun(Object.fromEntries(entries));
    setDetailsLoading(false);
  }

  const closeSample = useCallback(() => {
    setSelectedSample(null);
    setDetailsByRun({});
  }, []);

  if (loading) return <PageLoader />;

  return (
    <div className={`${PAGE_FRAME} lg:px-8`}>
      <Link
        href="/evaluations"
        className="mb-5 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Back to evaluations
      </Link>

      {/* The eyebrow said "Compare runs" directly above an H1 that said
          "Compare runs". One of them was decoration. The identity pill now sits
          on the H1's baseline, right-aligned to the content column, the way the
          experiment detail page carries its facts. */}
      <header className="mb-7">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Compare runs</h1>
          <p className="text-xs text-muted-foreground">
            {selectedRuns.length} runs selected
          </p>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Use the baseline as your reference. Compare each candidate’s metrics in Overview, inspect the same input across runs in Samples, and check what changed in Configuration.
        </p>
      </header>

      {error && incompatibleIds.length === 0 ? (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      ) : null}

      {runs.length < 2 ? (
        <EmptyComparison />
      ) : selectedRuns.length < 2 ? (
        <IncompleteSelection experimentId={experimentId} />
      ) : incompatibleIds.length > 0 ? (
        <>
          <RunSelector runs={runs} selectedRuns={selectedRuns} onChange={updateRun} />
          <IncompatibleComparison
            runs={selectedRuns}
            incompatibleIds={incompatibleIds}
            reason={error}
            onRemove={removeRun}
          />
        </>
      ) : (
        <>
          <RunSelector runs={runs} selectedRuns={selectedRuns} onChange={updateRun} />

          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as Tab)} variant="underline">
            <TabsList aria-label="Comparison views" className="mb-6 mt-8 flex-nowrap overflow-x-auto">
              {(["overview", "samples", "configuration"] as Tab[]).map((tab) => (
                <TabsTrigger
                  key={tab}
                  id={`comparison-tab-${tab}`}
                  value={tab}
                  aria-controls="comparison-tabpanel"
                  className="whitespace-nowrap px-4 capitalize"
                >
                  {tab}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsPanel id="comparison-tabpanel" aria-labelledby={`comparison-tab-${activeTab}`}>
              {activeTab === "overview" ? (
                <OverviewTab
                  analysis={analysis}
                  onAnalysisChange={updateAnalysis}
                  runs={selectedRuns}
                  comparisons={comparisons}
                  summary={summary}
                  loading={comparisonLoading}
                  onShowSamples={() => setActiveTab("samples")}
                />
              ) : null}

              {activeTab === "samples" ? (
                <SamplesTab
                  runs={selectedRuns}
                  rows={filteredSamples}
                  filter={sampleFilter}
                  onFilterChange={setSampleFilter}
                  metricFilter={metricFilter}
                  metrics={metrics}
                  onMetricChange={setMetricFilter}
                  query={sampleQuery}
                  onQueryChange={setSampleQuery}
                  onOpenSample={openSample}
                />
              ) : null}

              {activeTab === "configuration" ? <ConfigurationTab runs={selectedRuns} /> : null}
            </TabsPanel>
          </Tabs>

          {selectedSample ? (
            <TraceComparisonDialog
              runs={selectedRuns}
              sample={samples.find((row) => row.exampleId === selectedSample) ?? null}
              /* The filtered list, not every sample: paging out of the set the
                 reader filtered to would answer a question they did not ask. */
              siblings={filteredSamples}
              details={detailsByRun}
              loading={detailsLoading}
              onClose={closeSample}
              onOpenSample={openSample}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Honest empty state when the URL names fewer than two valid runs. We render
 * exactly the requested selection and ask the user to choose more — we never
 * silently add runs the user did not ask to compare.
 */
export function IncompleteSelection({ experimentId }: { experimentId: string }) {
  return (
    <div className="rounded-xl border bg-card px-6 py-16 text-center shadow-sm">
      <GitCompareArrows className="mx-auto mb-4 size-9 text-muted-foreground/50" aria-hidden="true" />
      <h2 className="text-lg font-semibold">Select at least one more run to compare</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        This link names fewer than two runs. Choose a baseline and at least one candidate — runs are
        never added to a comparison automatically.
      </p>
      <Link
        href={`/evaluations/${encodeURIComponent(experimentId)}`}
        className="mt-5 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Choose runs to compare
      </Link>
    </div>
  );
}

function EmptyComparison() {
  return (
    <div className="rounded-xl border bg-card px-6 py-16 text-center shadow-sm">
      <GitCompareArrows className="mx-auto mb-4 size-9 text-muted-foreground/50" aria-hidden="true" />
      <h2 className="text-lg font-semibold">Two runs are needed to compare</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Complete another evaluation run for this comparison, then return here to inspect the differences.
      </p>
      <Link
        href="/evaluations"
        className="mt-5 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Return to evaluations
      </Link>
    </div>
  );
}

export function IncompatibleComparison({
  runs,
  incompatibleIds,
  reason,
  onRemove,
}: {
  runs: RunResult[];
  incompatibleIds: string[];
  reason: string | null;
  onRemove: (runId: string) => void;
}) {
  const incompatibleRuns = runs.filter((run) => incompatibleIds.includes(run.run_id));
  return (
    <section
      aria-label="Incompatible comparison"
      className="mt-8 rounded-xl border border-state-caution/30 bg-state-caution-soft p-6 shadow-sm dark:border-state-caution/30 dark:bg-state-caution-soft"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-state-caution-soft text-state-caution dark:bg-state-caution-soft dark:text-state-caution">
          <AlertTriangle className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold">These runs cannot be compared safely</h2>
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">
            {reason || "One or more selected runs use a different dataset, metric, contract, evaluator, or evidence scope than the baseline."}{" "}
            Analytical tables are hidden until the incompatible run is removed — the numbers would not describe a like-for-like comparison.
          </p>
        </div>
      </div>
      <ul className="mt-5 space-y-2">
        {incompatibleRuns.map((run) => (
          <li
            key={run.run_id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background px-4 py-3"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">{runDisplayName(run)}</span>
              <CopyableId value={run.run_id} kind="run" className="max-w-full" valueClassName="truncate text-[10px] text-muted-foreground" />
            </span>
            <button
              type="button"
              onClick={() => onRemove(run.run_id)}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border bg-background px-3 text-xs font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30"
              aria-label={`Remove incompatible run ${runDisplayName(run)}`}
            >
              <X className="size-3.5" aria-hidden="true" />
              Remove incompatible run
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RunSelector({
  runs,
  selectedRuns,
  onChange,
}: {
  runs: RunResult[];
  selectedRuns: RunResult[];
  onChange: (index: number, runId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const candidateCount = Math.max(0, selectedRuns.length - 1);

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex flex-col gap-4 px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold">Comparison setup</h2>
            <span className="text-xs text-muted-foreground">
              {selectedRuns.length} runs · 1 baseline · {candidateCount} candidate{candidateCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {selectedRuns.map((run, index) => (
              <span
                key={run.run_id}
                className={cn(
                  "inline-flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs",
                  index === 0 ? "border-brand/30 bg-brand/10 dark:border-brand/40 dark:bg-brand/10" : "bg-muted/25",
                )}
              >
                <span className="font-semibold">{RUN_LABELS[index]}</span>
                <span className="text-muted-foreground">{runDisplayName(run)}</span>
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls="comparison-setup-details"
          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 self-start rounded-lg border bg-background px-3 text-xs font-medium outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/30 lg:self-end"
        >
          {expanded ? "Hide run selection" : "Change runs"}
          <ChevronDown
            className={cn("size-3.5 transition-transform duration-200 motion-reduce:transition-none", expanded && "rotate-180")}
            aria-hidden="true"
          />
        </button>
      </div>

      <div
        id="comparison-setup-details"
        inert={!expanded}
        className={cn(
          "grid border-t transition-[grid-template-rows] duration-200 motion-reduce:transition-none",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr] border-t-transparent",
        )}
      >
        <div className="overflow-hidden">
          <div
            className={cn(
              "grid gap-3 bg-muted/15 p-4 sm:p-5",
              selectedRuns.length === 4
                ? "md:grid-cols-2 xl:grid-cols-4"
                : selectedRuns.length === 3
                  ? "md:grid-cols-3"
                  : "md:grid-cols-2",
            )}
          >
            {selectedRuns.map((run, index) => (
              /* The baseline carries the same tint as its chip above, so the
                 reference column is identifiable without reading the labels —
                 two identical panels side by side said nothing about which was
                 which, or that they matched at all. */
              <article
                key={run.run_id}
                className={cn(
                  "min-w-0 rounded-xl border p-4",
                  index === 0
                    ? "border-brand/30 bg-brand/5 dark:border-brand/40 dark:bg-brand/10"
                    : "bg-background",
                )}
              >
                <label className="block">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {RUN_LABELS[index]}
                    {index === 0 ? " · reference" : null}
                  </span>
                  <select
                    value={run.run_id}
                    onChange={(event) => onChange(index, event.target.value)}
                    className="mt-2 h-9 w-full rounded-lg border bg-background px-2.5 text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/15"
                    aria-label={`Select ${RUN_LABELS[index].toLowerCase()} run`}
                  >
                    {runs.map((option) => (
                      <option
                        key={option.run_id}
                        value={option.run_id}
                        disabled={selectedRuns.some(
                          (selected, selectedIndex) =>
                            selectedIndex !== index && selected.run_id === option.run_id,
                        )}
                      >
                        {runDisplayName(option)} · {presentRunOutcome(option).label}
                      </option>
                    ))}
                  </select>
                </label>
                <dl className="mt-4 divide-y text-xs">
                  {/* Values identical to the baseline are greyed on a candidate
                      panel, so what differs is what stands out. */}
                  <RunMetadata
                    label="Judge model"
                    value={run.experiment?.judge_model || "Not recorded"}
                    sameAsBaseline={
                      index > 0 &&
                      (run.experiment?.judge_model || "Not recorded") ===
                        (selectedRuns[0]?.experiment?.judge_model || "Not recorded")
                    }
                  />
                  <RunMetadata
                    label="Target prompt"
                    value={run.lineage?.target_prompt_ref || run.lineage?.target_prompt_version || "Not recorded"}
                    sameAsBaseline={false}
                  />
                  <RunMetadata
                    label="Dataset"
                    value={datasetVersionLabel(run.experiment?.dataset_version) || "Not recorded"}
                    sameAsBaseline={
                      index > 0 &&
                      (run.experiment?.dataset_version || "Not recorded") ===
                        (selectedRuns[0]?.experiment?.dataset_version || "Not recorded")
                    }
                  />
                  <RunMetadata
                    label="Target"
                    value={comparisonTargetLabel(run)}
                    sameAsBaseline={
                      index > 0 &&
                      comparisonTargetLabel(run) === comparisonTargetLabel(selectedRuns[0]!)
                    }
                  />
                  {/* No Temperature row. The backend pins judge temperature at
                      0.0 (settings.judge_temperature) and nothing in the UI can
                      change it, so on a card built to show what differs between
                      runs it read 0.0 down every column. */}
                </dl>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function RunMetadata({
  label,
  value,
  sameAsBaseline = false,
}: {
  label: string;
  value: string;
  sameAsBaseline?: boolean;
}) {
  return (
    // 7rem label column and a left-aligned value, matching the experiment
    // detail page's metadata block. Hard-right values left ~500px of gap
    // between a label and the thing it labelled.
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 first:pt-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn("truncate font-medium", sameAsBaseline && "font-normal text-muted-foreground")}
        title={sameAsBaseline ? `${value} — same as baseline` : value}
      >
        {value}
      </dd>
    </div>
  );
}

export type SampleRow = {
  exampleId: string;
  name: string;
  scores: Array<number | null>;
  deltas: Array<number | null>;
  candidateResults: CandidateResult[];
  delta: number | null;
  result: RowResult;
  failed: boolean;
};

type CandidateResult = "Improved" | "Regressed" | "Same" | "Unavailable";
type RowResult = "Improved" | "Regressed" | "Mixed" | "Same" | "Unavailable";

export function OverviewTab({
  analysis = readAnalysisUrlState(new URLSearchParams()),
  onAnalysisChange = () => undefined,
  runs,
  comparisons,
  summary,
  loading = false,
  onShowSamples,
}: {
  runs: RunResult[];
  comparisons: RunComparison[];
  analysis?: AnalysisUrlState;
  onAnalysisChange?: (patch: Partial<AnalysisUrlState>) => void;
  summary: ReturnType<typeof buildSummary>;
  loading?: boolean;
  onShowSamples: () => void;
}) {
  return (
    <div className="space-y-7">
      <div className="rounded-xl border bg-card">
        <ExperimentAnalysisPanel name="selected runs" runs={runs} baselineRunId={runs[0]?.run_id} analysis={analysis} onAnalysisChange={onAnalysisChange} />
      </div>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Evaluator results</h2>
        <p className="text-sm text-muted-foreground">Compare each evaluator independently. A high average on one check does not cancel a failure on another.</p>
        <EvaluatorComparisonTable runs={runs} />
        <button type="button" onClick={onShowSamples} className="rounded text-sm font-medium text-brand-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Review samples</button>
      </section>
      <details className="space-y-4">
        <summary className="w-fit cursor-pointer rounded py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Composite summary</summary>
      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:p-6">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand-text dark:bg-brand/15 dark:text-brand">
            <GitCompareArrows className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Comparison overview
            </div>
            <h2 className="text-base font-semibold">{loading ? "Confirming run comparability…" : summary.title}</h2>
            <p className="mt-1.5 max-w-4xl text-sm leading-6 text-muted-foreground">{summary.body}</p>
          </div>
          <button
            type="button"
            onClick={onShowSamples}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 self-start rounded-lg border bg-background px-3 text-xs font-medium outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            Review samples
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <dl className="grid border-t bg-muted/10 sm:grid-cols-3 sm:divide-x">
          <SummaryStat label="Best run score" value={summary.bestQualityLabel ?? "Not available"} detail={summary.bestQualityDetail} />
          <SummaryStat label="Fastest run" value={summary.fastestLabel ?? "Not available"} detail={summary.fastestDetail} />
          {/* Regression is measured from quality scores alone; latency is summarised
              separately. An unqualified "Regressions: None" beside a candidate that
              got materially slower claims more than the number knows. */}
          <SummaryStat
            label="Sample regressions"
            value={summary.regressionCandidates.length === 0 ? "None" : `${summary.regressionCandidates.length} candidate${summary.regressionCandidates.length === 1 ? "" : "s"}`}
            detail={summary.regressionDetail}
            tone={summary.regressionCandidates.length > 0 ? "warning" : "neutral"}
          />
        </dl>
      </section>

      {/* No "By candidate" cards. Quality, Samples and Latency per candidate is
          the same three facts the summary row above already states and the
          results table below states again, per run and in more detail. Three
          tellings of one story, and the table is the one that scales past a
          single candidate. */}

      </details>
      <section>
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Operational measurements</h2>
            <p className="mt-1 text-xs text-muted-foreground">Latency and resource use in their original units, separate from evaluator scores.</p>
          </div>
        </div>
        <ResultsTable runs={runs} comparisons={comparisons} measurementsOnly />
      </section>
    </div>
  );
}


function SummaryStat({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "warning";
}) {
  return (
    <div className="min-w-0 px-5 py-4 sm:px-6">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 text-sm font-semibold", tone === "warning" && "text-destructive")}>
        {value}
      </dd>
      <p className="mt-0.5 truncate text-xs text-muted-foreground" title={detail}>{detail}</p>
    </div>
  );
}

export function ResultsTable({ runs, comparisons, measurementsOnly = false }: { runs: RunResult[]; comparisons: RunComparison[]; measurementsOnly?: boolean }) {
  const metricIds = [...new Set(runs.flatMap((run) => run.kpi_results.map((kpi) => kpi.kpi_id)))];
  // Two grains, named as two grains. "KPI composite" is the mean of the KPI
  // composites; "Sample mean" is the per-sample mean the Samples tab reports.
  // They are different numbers by construction, and the page used to print the
  // first one twice — once as "Overall Score" and again as the only KPI's own
  // row — while never naming the second at all.
  const runScoreDetail =
    metricIds.length === 0
      ? null
      : `Mean of ${metricIds.length} KPI${metricIds.length === 1 ? "" : "s"}: ${metricIds
          .map((metricId) => humanize(metricId))
          .join(", ")}. Shown only for runs with a conclusive verdict.`;
  const sampleMeans = runs.map((run, index) =>
    index === 0
      ? average(
          (comparisons[0]?.sample_deltas ?? [])
            .map((sample) => sample.base_score)
            .filter((score): score is number => score !== null),
        )
      : average(
          (comparisons[index - 1]?.sample_deltas ?? [])
            .map((sample) => sample.candidate_score)
            .filter((score): score is number => score !== null),
        ),
  );
  const rows = [
    {
      label: "KPI composite",
      // Never dropped by the all-null filter below. Withholding the number for a
      // non-conclusive run is the honest answer; removing the whole row would
      // hide that there was a score question at all, which is a different lie
      // from the one this change fixes.
      alwaysShow: true,
      detail: runScoreDetail,
      // `gatedRunScore`, not a raw average. This row reimplemented the mean
      // without the conclusive-verdict guard every other score surface applies,
      // so an inconclusive or diagnostic-only candidate rendered a clean number
      // here and got ranked and colour-coded against the baseline exactly as if
      // it were governed — on the one screen whose whole job is "did this get
      // better". A run with no honest score now shows an em dash instead.
      values: runs.map((run) => gatedRunScore(run)),
      lowerIsBetter: false,
      format: formatScore,
    },
    {
      label: "Sample mean",
      detail: "Mean score across evaluated samples",
      values: sampleMeans,
      lowerIsBetter: false,
      format: formatScore,
    },
    // A single KPI's row *is* the run score, to the digit. Listed only when
    // there is more than one, where the breakdown says something the mean does
    // not.
    ...(metricIds.length > 1
      ? metricIds.map((metricId) => ({
          label: humanize(metricId),
          detail: null,
          values: runs.map((run) => run.kpi_results.find((kpi) => kpi.kpi_id === metricId)?.composite_score ?? null),
          lowerIsBetter: false,
          format: formatScore,
        }))
      : []),
    {
      label: "Avg. Latency",
      detail: null,
      values: [comparisons[0]?.base_latency_ms ?? null, ...comparisons.map((comparison) => comparison.candidate_latency_ms)],
      lowerIsBetter: true,
      format: formatLatency,
    },
    // Operational measurements, compared on what was captured. They carry no
    // verdict and so no normalised score, which is why the score comparison
    // omits them — and why "did this run cost more tokens" had no answer here.
    // ops.latency is already the row above; showing it twice would just
    // disagree with itself on rounding.
    ...measurementMetricIds(comparisons)
      .filter((id) => id !== "ops.latency")
      .map((id) => ({
        label: humanize(id.replace(/^ops\./, "")),
        // Carried so the delta mapper below can find this row's backend delta.
        // Without it the row fell through to "Not recorded" beside two numbers
        // that plainly differ — the same misread the Sample mean row guards.
        measurementId: id,
        detail: null,
        values: [
          comparisons[0]?.measurement_deltas?.find((m) => m.metric_id === id)?.base ?? null,
          ...comparisons.map(
            (comparison) =>
              comparison.measurement_deltas?.find((m) => m.metric_id === id)?.candidate ?? null,
          ),
        ],
        // Direction, not judgement: spending fewer tokens and less time is the
        // better outcome, and efficiency reads the other way. Neither is a pass
        // or a fail — these metrics do not have one.
        lowerIsBetter: id !== "ops.token_efficiency",
        format: (value: number | null) =>
          value == null
            ? "—"
            : id.endsWith("_token_count")
              ? `${Math.round(value).toLocaleString()} tokens`
              : value.toLocaleString(undefined, { maximumSignificantDigits: 3 }),
      })),
  ]
    .filter((row) => !measurementsOnly || row.label === "Avg. Latency" || "measurementId" in row)
    .filter((row) => ("alwaysShow" in row && row.alwaysShow) || row.values.some((value) => value != null))
    .map((row) => ({
      ...row,
      // As a percentage, like latency. The absolute form runs through a
      // score-shaped formatter that multiplies by 100 and writes "pts", so
      // 927 -> 927.5 tokens read as "up 50.0 pts". A percent change carries
      // across units without inventing any.
      backendDeltas: "measurementId" in row && row.measurementId
        ? comparisons.map((comparison) => {
            const measured = comparison.measurement_deltas?.find(
              (m) => m.metric_id === (row as { measurementId: string }).measurementId,
            );
            if (!measured || measured.base == null || measured.candidate == null || measured.base === 0) {
              return null;
            }
            return ((measured.candidate - measured.base) / Math.abs(measured.base)) * 100;
          })
        : row.label === "Avg. Latency"
        ? comparisons.map((comparison) => comparison.latency_delta_percent)
        : row.label === "KPI composite"
          ? comparisons.map((comparison) => comparison.quality_delta)
        : row.label === "Sample mean"
          // Both numbers are on the row, so the comparison is derivable — a
          // "Not recorded" beside 0.97 and 0.94 reads as missing evidence.
          ? sampleMeans
              .slice(1)
              .map((value) =>
                value == null || sampleMeans[0] == null ? null : value - sampleMeans[0]!,
              )
          : comparisons.map((comparison) =>
              comparison.kpi_deltas.find((delta) => humanize(delta.kpi_id) === row.label)?.delta ?? null,
            ),
    }));

  return (
    <>
      <section
        className="overflow-hidden rounded-xl border bg-card shadow-sm xl:hidden"
        aria-label="Run-level metric comparison"
      >
        <div className="divide-y">
          {rows.map((row) => (
            <article key={row.label} className="p-4">
              <h3 className="text-sm font-semibold">{row.label}</h3>
              {row.detail ? <p className="mt-0.5 text-xs text-muted-foreground">{row.detail}</p> : null}
              <dl className="mt-3 grid grid-cols-2 gap-2">
                {row.values.map((value, index) => (
                  <div key={runs[index]?.run_id ?? index} className="min-w-0 rounded-lg bg-muted/35 px-3 py-2.5">
                    <dt><RunIdentity run={runs[index]} index={index} /></dt>
                    <dd className="mt-1 font-mono text-sm font-semibold">{row.format(value)}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3 border-t pt-3">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Comparison
                </p>
                <ComparisonDeltaBadges
                  deltas={row.backendDeltas}
                  lowerIsBetter={row.lowerIsBetter}
                  isLatency={row.label === "Avg. Latency" || Boolean((row as { measurementId?: string }).measurementId)}
                />
              </div>
            </article>
          ))}
        </div>
      </section>

      <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm xl:block">
        <table className="w-full min-w-[720px] text-left text-sm">
          <caption className="sr-only">Run-level metric comparison</caption>
          <thead className="bg-muted/35 text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-semibold">Metric</th>
              {runs.map((run, index) => <th key={run.run_id} className="px-4 py-3 font-semibold"><RunIdentity run={run} index={index} /></th>)}
              <th className="px-4 py-3 text-right font-semibold">Comparison</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t">
                <td className="px-5 py-3.5 font-medium">
                  {row.label}
                  {row.detail ? (
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{row.detail}</span>
                  ) : null}
                </td>
                {row.values.map((value, index) => (
                  <td key={index} className="px-4 py-3.5 font-mono text-xs tabular-nums">
                    {row.format(value)}
                  </td>
                ))}
                <td className="px-4 py-3.5 text-right text-xs font-medium">
                  <ComparisonDeltaBadges
                    deltas={row.backendDeltas}
                    lowerIsBetter={row.lowerIsBetter}
                    isLatency={row.label === "Avg. Latency" || Boolean((row as { measurementId?: string }).measurementId)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ComparisonDeltaBadges({
  deltas,
  lowerIsBetter,
  isLatency,
}: {
  deltas: Array<number | null>;
  lowerIsBetter: boolean;
  isLatency: boolean;
}) {
  return (
    // Plain text, right-aligned, in the same words the Every-measure table
    // uses. A bordered pill per row made a column of chips out of what is one
    // number, and the border carried no meaning the colour did not.
    <span className="flex flex-col items-end gap-1 text-right tabular-nums">
      {deltas.length
        ? deltas.map((delta, index) => (
            <span
              key={RUN_LABELS[index + 1]}
              className={cn(
                "text-xs font-medium",
                // Colour only where direction has an agreed meaning; no change
                // is grey rather than a colour with nothing to say.
                delta == null || delta === 0
                  ? "text-muted-foreground"
                  : (lowerIsBetter ? delta < 0 : delta > 0)
                    ? "text-state-positive"
                    : "text-destructive",
              )}
            >
              {/* No run label with a single candidate: it repeated "Candidate 1"
                  on every row, and the column header already names whose number
                  this is. */}
              {deltas.length > 1 ? `${RUN_LABELS[index + 1]} ` : ""}
              {formatBackendDelta(delta, isLatency, lowerIsBetter)}
            </span>
          ))
        : <span className="text-xs text-muted-foreground">Awaiting backend comparison</span>}
    </span>
  );
}

/**
 * Oxford-style list join for run labels: "A", "A and B",
 * "A, B, and C" — never the run-on "A and B and C".
 */
export function joinRunLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

export function rankComparisonValues(
  values: Array<number | null>,
  lowerIsBetter: boolean,
): { status: "none" | "only" | "tie" | "unique"; indexes: number[] } {
  const valid = values
    .map((value, index) => ({ value, index }))
    .filter((entry): entry is { value: number; index: number } => entry.value != null);
  if (valid.length === 0) return { status: "none", indexes: [] };
  if (valid.length === 1) return { status: "only", indexes: [valid[0].index] };

  const bestValue = lowerIsBetter
    ? Math.min(...valid.map((entry) => entry.value))
    : Math.max(...valid.map((entry) => entry.value));
  const tolerance = Math.max(1e-9, Math.abs(bestValue) * 1e-6);
  const indexes = valid
    .filter((entry) => Math.abs(entry.value - bestValue) <= tolerance)
    .map((entry) => entry.index);
  return { status: indexes.length > 1 ? "tie" : "unique", indexes };
}

function SamplesTab({
  runs,
  rows,
  filter,
  onFilterChange,
  metricFilter,
  metrics,
  onMetricChange,
  query,
  onQueryChange,
  onOpenSample,
}: {
  runs: RunResult[];
  rows: SampleRow[];
  filter: SampleFilter;
  onFilterChange: (filter: SampleFilter) => void;
  metricFilter: string;
  metrics: string[];
  onMetricChange: (metric: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  onOpenSample: (id: string) => void;
}) {
  return (
    <section>
      <div className="mb-5 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Sample comparison</h2>
          <p className="mt-1 text-xs text-muted-foreground">Select a sample to compare outputs, execution steps, and evaluator evidence.</p>
        </div>
        {/* One height across the row. The search is h-11 to stay a real touch
            target, so its neighbours match it rather than the search shrinking. */}
        <div className="flex flex-wrap items-center gap-2">
          <SearchField containerClassName="w-56 shrink-0" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search samples" label="Search comparison samples" />
          <select aria-label="Filter samples by metric" value={metricFilter} onChange={(event) => onMetricChange(event.target.value)} className="h-11 rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring">
            <option value="all">All metrics</option>
            {metrics.map((metric) => <option key={metric} value={metric}>{humanize(metric)}</option>)}
          </select>
          <div className="flex h-11 items-center rounded-lg border bg-background p-1">
            {(["all", "improved", "regressed", "failed"] as SampleFilter[]).map((option) => (
              <button key={option} type="button" onClick={() => onFilterChange(option)} className={cn("rounded-lg px-3 py-1.5 text-xs font-medium capitalize text-muted-foreground", filter === option && "bg-primary text-primary-foreground shadow-sm")}>
                {option}
              </button>
            ))}
          </div>
        </div>
      </div>
      <SampleTable runs={runs} rows={rows} onOpenSample={onOpenSample} />
    </section>
  );
}

export function SampleTable({ runs, rows, onOpenSample }: { runs: RunResult[]; rows: SampleRow[]; onOpenSample: (id: string) => void }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <table className="hidden w-full table-fixed text-left text-sm md:table">
        <caption className="sr-only">Sample-level comparison results</caption>
        <colgroup>
          <col className="w-[28%]" />
          {runs.map((run) => <col key={run.run_id} />)}
          <col className="w-[16%]" />
        </colgroup>
        <thead className="bg-muted/35 text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-semibold">Sample</th>
            {runs.map((run, index) => (
              <th key={run.run_id} className="px-3 py-3 font-semibold">
                <RunIdentity run={run} index={index} />
                <span className="mt-0.5 block text-[9px] font-medium normal-case tracking-normal text-muted-foreground/80">
                  {index === 0 ? "Reference" : "vs baseline"}
                </span>
              </th>
            ))}
            <th className="px-3 py-3 font-semibold">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row) => (
            <tr key={row.exampleId} className="border-t transition hover:bg-muted/35">
              <td className="px-4 py-3.5">
                <button
                  type="button"
                  onClick={() => onOpenSample(row.exampleId)}
                  className="block w-full rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                  aria-label={`Inspect evidence for ${row.name}`}
                >
                  <span className="line-clamp-2 font-medium leading-5" title={row.name}>{row.name}</span>
                  <span
                    className="mt-0.5 block font-mono text-[10px] text-muted-foreground"
                    title={row.exampleId}
                  >
                    {row.exampleId.slice(0, 12)}
                  </span>
                </button>
              </td>
              {row.scores.slice(0, runs.length).map((score, index) => {
                const delta = row.deltas[index];
                return (
                  <td key={index} className="px-3 py-3.5 align-top">
                    <SampleScore score={score} delta={delta} index={index} />
                  </td>
                );
              })}
              <td className="px-3 py-3.5 align-top">
                <span className="flex items-center gap-1.5">
                  <ResultBadge result={row.result} />
                  <button
                    type="button"
                    onClick={() => onOpenSample(row.exampleId)}
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
                    aria-label={`Open comparison evidence for ${row.name}`}
                  >
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </button>
                </span>
              </td>
            </tr>
          )) : (
            <tr><td colSpan={runs.length + 2} className="px-5 py-12 text-center text-sm text-muted-foreground">No samples match these filters.</td></tr>
          )}
        </tbody>
      </table>
      <div className="divide-y md:hidden">
        {rows.length ? rows.map((row) => (
          <article key={row.exampleId} className="p-4">
            <button
              type="button"
              onClick={() => onOpenSample(row.exampleId)}
              className="block w-full rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              aria-label={`Inspect evidence for ${row.name}`}
            >
              <span className="block font-medium leading-5">{row.name}</span>
              <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground" title={row.exampleId}>
                {row.exampleId.slice(0, 12)}
              </span>
            </button>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {row.scores.slice(0, runs.length).map((score, index) => (
                <div key={index} className="min-w-0 rounded-lg border bg-muted/15 p-2.5">
                  <div className="mb-1"><RunIdentity run={runs[index]} index={index} /></div>
                  <SampleScore score={score} delta={row.deltas[index]} index={index} />
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <ResultBadge result={row.result} />
              <button
                type="button"
                onClick={() => onOpenSample(row.exampleId)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background px-3 text-xs font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30"
              >
                Evidence
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </article>
        )) : (
          <p className="px-5 py-12 text-center text-sm text-muted-foreground">No samples match these filters.</p>
        )}
      </div>
    </div>
  );
}

function RunIdentity({ run, index }: { run: RunResult; index: number }) {
  const label = runLabel(run).trim();
  const role = RUN_LABELS[index] ?? `Candidate ${index}`;
  return (
    <span className="flex flex-wrap items-center gap-1.5 normal-case tracking-normal">
      <span className="break-words text-xs font-semibold text-foreground">{label || role}</span>
      {label ? <span className="rounded-full border px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">{role}</span> : null}
    </span>
  );
}

function SampleScore({ score, delta, index }: { score: number | null; delta: number | null; index: number }) {
  return (
    <>
      <span className="font-mono text-xs font-medium">{formatScore(score)}</span>
      <span
        className={cn(
          "mt-1 block break-words text-[10px] leading-4",
          index === 0 || delta == null
            ? "text-muted-foreground"
            : delta > 0.005
              ? "text-state-positive"
              : delta < -0.005
                ? "text-destructive"
                : "text-muted-foreground",
        )}
      >
        {index === 0
          ? null
          : score == null
            ? "Not recorded"
            : delta == null
              ? "Baseline unavailable"
              : `${delta > 0 ? "+" : ""}${delta.toFixed(2)} vs baseline`}
      </span>
    </>
  );
}

function ResultBadge({ result }: { result: RowResult }) {
  return (
    <span className={cn(
      "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold",
      result === "Improved" && "bg-state-positive-soft text-state-positive dark:bg-state-positive-soft dark:text-state-positive",
      result === "Regressed" && "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
      result === "Mixed" && "bg-state-caution-soft text-state-caution dark:bg-state-caution-soft dark:text-state-caution",
      result === "Same" && "bg-muted text-muted-foreground",
      result === "Unavailable" && "border bg-background text-muted-foreground",
    )}>{result}</span>
  );
}

export function TraceComparisonDialog({
  runs,
  sample,
  siblings = [],
  details,
  loading,
  onClose,
  onOpenSample,
}: {
  runs: RunResult[];
  sample: SampleRow | null;
  /** The samples currently listed, in the order they are listed. */
  siblings?: SampleRow[];
  details: Record<string, RunItemDetail | null>;
  loading: boolean;
  onClose: () => void;
  onOpenSample?: (exampleId: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  if (!sample) return null;

  const firstDetail = runs.map((run) => details[run.run_id]).find(Boolean);
  const position = siblings.findIndex((row) => row.exampleId === sample.exampleId);
  const previous = position > 0 ? siblings[position - 1] : null;
  const next = position >= 0 && position < siblings.length - 1 ? siblings[position + 1] : null;
  return (
    <Dialog
      labelledBy="trace-comparison-title"
      describedBy="trace-comparison-description"
      onClose={onClose}
      scrimLabel="Close evidence comparison"
      initialFocusRef={closeRef}
      scrimClassName="bg-black/45 backdrop-blur-[1px]"
      overlayClassName="sm:p-6"
      width="w-[min(92rem,calc(100vw-2rem))] sm:w-[min(92rem,calc(100vw-3rem))]"
      className="max-h-[calc(100vh-2rem)] sm:max-h-[calc(100vh-3rem)]"
    >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b bg-background px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Evidence comparison</div>
            <h2 id="trace-comparison-title" className="truncate text-base font-semibold">{sample.name}</h2>
            <p id="trace-comparison-description" className="mt-1 text-xs text-muted-foreground">
              Responses, tool calls, evaluator rationale, and capture status remain aligned by run.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
            aria-label="Close evidence comparison"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex min-h-72 items-center justify-center" role="status">
              <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">Loading comparison evidence</span>
            </div>
          ) : (
            <>
              <div className="border-b bg-muted/20 px-5 py-4 sm:px-6">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Input</div>
                <p className="max-w-4xl text-sm leading-6">{extractText(firstDetail?.input) || sample.name}</p>
              </div>
              <div
                className={cn(
                  "grid divide-y lg:divide-x lg:divide-y-0",
                  runs.length === 4
                    ? "lg:grid-cols-2 xl:grid-cols-4"
                    : runs.length === 3
                      ? "lg:grid-cols-3"
                      : "lg:grid-cols-2",
                )}
              >
                {runs.map((run, index) => (
                  <div key={run.run_id} className="min-w-0">
                    <Link href={runDetailsHref(run.run_id)} className="mx-5 mt-4 inline-flex min-h-9 items-center rounded text-sm font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring">Open {RUN_LABELS[index].toLowerCase()} report</Link>
                  <TraceColumn
                    role={RUN_LABELS[index]}
                    run={run}
                    detail={details[run.run_id] ?? null}
                    score={sample.scores[index]}
                    /* The baseline is the thing every other column is a diff
                       against; it has nothing to differ from itself. */
                    against={index === 0 ? null : details[runs[0]!.run_id]?.scorer_results ?? null}
                  />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* A modal that can only be closed makes the reader re-find their place
            in the list to read the next sample. Paging stays inside the set
            they filtered to, and the run report is the way out to full
            evidence. No trace link: that needs a project id, which most
            experiments here do not record. */}
        {position >= 0 && siblings.length > 1 ? (
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t bg-background px-5 py-3 sm:px-6">
            <p className="text-xs text-muted-foreground">
              Sample <span className="font-medium text-foreground tabular-nums">{position + 1}</span> of{" "}
              <span className="font-medium text-foreground tabular-nums">{siblings.length}</span>
            </p>
            <div className="flex flex-wrap items-center gap-2">

              <button
                type="button"
                disabled={!previous || !onOpenSample}
                onClick={() => previous && onOpenSample?.(previous.exampleId)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background px-3 text-xs font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-40"
              >
                <ChevronLeft className="size-3.5" aria-hidden="true" />
                Previous
              </button>
              <button
                type="button"
                disabled={!next || !onOpenSample}
                onClick={() => next && onOpenSample?.(next.exampleId)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background px-3 text-xs font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-40"
              >
                Next
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </footer>
        ) : null}
    </Dialog>
  );
}

function TraceColumn({
  role,
  run,
  detail,
  score,
  against,
}: {
  role: string;
  run: RunResult;
  detail: RunItemDetail | null;
  score: number | null;
  against?: MetricResult[] | null;
}) {
  const label = runLabel(run).trim() || role;
  if (!detail) return <div className="flex min-h-56 items-center justify-center p-6 text-center text-sm text-muted-foreground">Evidence is not available for {label}.</div>;
  const response = extractText(detail.output) || "No response captured.";
  // Only gated metrics can pass, so only they belong in the denominator: "4/8"
  // counted four ungated counters as failures-in-waiting.
  const gated = detail.scorer_results.filter((result) => result.threshold_result != null);
  const passedMetrics = gated.filter((result) => result.passed).length;
  const ungatedCount = detail.scorer_results.length - gated.length;
  const metricSummary = gated.length
    ? `${passedMetrics}/${gated.length} gated metrics passed${ungatedCount ? `, ${ungatedCount} not gated` : ""}`
    : "No metric evidence";
  return (
    <article className="min-w-0 p-5 sm:p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
            <span>{label}</span>
            {label !== role ? <span className="rounded-full border px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">{role}</span> : null}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{runDisplayName(run)}</div>
        </div>
        <span className="rounded-full bg-muted px-2.5 py-1 font-mono text-xs font-semibold">{formatScore(score)}</span>
      </div>

      <section className="rounded-xl border bg-muted/15 p-4">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Response</h3>
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{response}</p>
      </section>

      <div className="my-4 flex flex-wrap items-center gap-x-2 gap-y-2 border-y py-3 text-[10px] font-medium text-muted-foreground">
        {[
          metricSummary,
          formatLatency(detail.execution.latency_ms),
          detail.capture_state === "complete"
            ? "Complete evidence"
            : detail.capture_state === "partial"
              ? "Partial evidence"
              : "Capture not recorded",
        ].map((fact, index) => (
          <span key={fact} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden="true" className="text-border">·</span> : null}
            {fact}
          </span>
        ))}
      </div>

      {detail.tool_calls?.length ? (
        <TraceSection title={`Tool activity · ${detail.tool_calls.length}`} icon={Wrench}>
          <div className="space-y-2">{detail.tool_calls.map((call, index) => <div key={`${call.name}-${index}`} className="rounded-lg border bg-muted/20 p-3"><div className="font-mono text-xs font-semibold">{call.name}</div><pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-[10px] leading-4 text-muted-foreground">{JSON.stringify(call.args, null, 2)}</pre></div>)}</div>
        </TraceSection>
      ) : null}

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Evaluator results</h3>
          {/* Instruction, not an action: it sat in the position and weight of a
              link while doing nothing when clicked. */}
          {detail.scorer_results.length ? (
            <span className="text-[10px] font-normal italic text-muted-foreground">
              Open a metric to read its rationale
            </span>
          ) : null}
        </div>
        {detail.scorer_results.length ? (
          <EvaluatorResults results={detail.scorer_results} against={against ?? null} />
        ) : <p className="rounded-xl border border-dashed p-4 text-xs text-muted-foreground">No evaluator results were captured.</p>}
      </section>
    </article>
  );
}



/**
 * The evaluator results as a diff, not a list.
 *
 * Sixteen rows across two panels with a single differing value gave that one
 * row exactly the weight of the fifteen that matched. Rows identical to the
 * baseline collapse behind one line; anything that moved stays out in the open.
 * The baseline column has nothing to compare against, so it lists everything.
 */
function EvaluatorResults({
  results,
  against,
}: {
  results: MetricResult[];
  against: MetricResult[] | null;
}) {
  if (!against) {
    return (
      <div className="overflow-hidden rounded-xl border">
        {results.map((result) => (
          <EvaluatorResult key={`${result.metric_id}-${result.evaluator_instance_id}`} result={result} />
        ))}
      </div>
    );
  }

  // Keyed by metric AND evaluator instance: one metric can be scored by more
  // than one evaluator, and keying on metric_id alone silently overwrote all
  // but the last of them.
  const keyOf = (result: MetricResult) => `${result.metric_id}::${result.evaluator_instance_id ?? ""}`;
  const baselineByKey = new Map(against.map((result) => [keyOf(result), result]));
  const same = (result: MetricResult) => {
    const other = baselineByKey.get(keyOf(result));
    if (!other) return false;
    return other.normalised_score === result.normalised_score
      && other.score === result.score
      && other.threshold_result === result.threshold_result;
  };

  const differing = results.filter((result) => !same(result));
  const identical = results.filter((result) => same(result));
  // A metric the baseline scored and this run did not is a difference, and
  // iterating the candidate alone made it vanish instead.
  const candidateKeys = new Set(results.map(keyOf));
  const missing = against.filter((result) => !candidateKeys.has(keyOf(result)));
  const missingMetrics = missing.filter((result) => !results.some((candidate) => candidate.metric_id === result.metric_id));

  return (
    <div className="overflow-hidden rounded-xl border">
      {differing.map((result) => (
        <EvaluatorResult key={`${result.metric_id}-${result.evaluator_instance_id}`} result={result} />
      ))}
      {missingMetrics.length ? (
        <div className="border-t px-3 py-2.5 text-xs text-muted-foreground">
          Not scored on this run: {missingMetrics.map((result) => humanize(result.metric_id)).join(", ")}.
        </div>
      ) : null}
      {identical.length ? (
        <details className="border-t first:border-t-0">
          <summary className="cursor-pointer px-3 py-2.5 text-xs text-muted-foreground outline-none hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30">
            {identical.length} metric{identical.length === 1 ? "" : "s"} identical to the baseline
          </summary>
          <div className="border-t">
            {identical.map((result) => (
              <EvaluatorResult key={`${result.metric_id}-${result.evaluator_instance_id}`} result={result} />
            ))}
          </div>
        </details>
      ) : null}
      {differing.length === 0 && identical.length === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">No evaluator results were captured.</p>
      ) : null}
    </div>
  );
}

/**
 * Whether a metric was gated, and how it went.
 *
 * `passed` is false for a metric that has no threshold at all, so an ungated
 * operational counter rendered in red as "Review" — which reads as "a human
 * must look at this" for a metric that simply has nothing to fail against.
 * Absence of a verdict is its own state.
 */
type MetricGateState = "passed" | "failed" | "ungated";

function metricGateState(result: MetricResult): MetricGateState {
  if (result.threshold_result == null) return "ungated";
  return result.passed ? "passed" : "failed";
}

const GATE_LABEL: Record<MetricGateState, string> = {
  passed: "Passed",
  failed: "Failed",
  ungated: "Not gated",
};
const GATE_TEXT: Record<MetricGateState, string> = {
  passed: "text-gate-pass",
  failed: "text-destructive",
  ungated: "text-muted-foreground",
};
const GATE_DOT: Record<MetricGateState, string> = {
  // Solid, not the pale surface token: a 6px #ecfdf5 dot on a white card is
  // invisible, which is the same defect fixed in six other files.
  passed: "bg-gate-pass",
  failed: "bg-destructive",
  ungated: "bg-muted-foreground/40",
};

/**
 * The metric's value, in whatever form it was recorded.
 *
 * Operational counters carry a raw `score` and no `normalised_score`, so
 * reading only the normalised field printed a dash for latency and token counts
 * the run had measured and the analysis page was already showing.
 */
function metricResultValue(result: MetricResult): string {
  if (result.normalised_score != null) return formatScore(result.normalised_score);
  if (result.score == null) return "Not captured";
  if (result.metric_id === "ops.latency") return `${Math.round(result.score * 1000)} ms`;
  return Number.isInteger(result.score) ? String(result.score) : result.score.toFixed(2);
}

function EvaluatorResult({ result }: { result: RunItemDetail["scorer_results"][number] }) {
  const gateState = metricGateState(result);
  const [expanded, setExpanded] = useState(false);
  const resultId = useId();
  const rationale = result.rationale || result.label || "No written rationale was captured.";

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3 py-3 text-left outline-none transition-colors hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
        aria-expanded={expanded}
        aria-controls={resultId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", GATE_DOT[gateState])} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={humanize(result.metric_id)}>{humanize(result.metric_id)}</span>
        <span className={cn("shrink-0 text-[10px] font-medium", GATE_TEXT[gateState])}>{GATE_LABEL[gateState]}</span>
        <span className="w-14 shrink-0 text-right font-mono text-[10px] font-semibold">{metricResultValue(result)}</span>
        <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", expanded && "rotate-180")} aria-hidden="true" />
      </button>
      <div id={resultId} className={cn("grid transition-[grid-template-rows] duration-200 ease-standard", expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden">
          <p className="border-t bg-muted/15 px-4 py-3 text-xs leading-5 text-muted-foreground">{rationale}</p>
        </div>
      </div>
    </div>
  );
}

function TraceSection({ title, icon: Icon, children }: { title: string; icon?: typeof Wrench; children: React.ReactNode }) {
  return <div className="mb-5"><h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{Icon ? <Icon className="size-3" /> : null}{title}</h3>{children}</div>;
}

export function ConfigurationTab({ runs }: { runs: RunResult[] }) {
  const [showMatching, setShowMatching] = useState(false);
  const excludedKeys = new Set([
    "description",
    "objective",
    "hypothesis",
    "tags",
    "experiment_id",
    "created_at",
    "created_by",
    "tenant_id",
    "product_id",
    "owner",
    "status",
    "run_manifest_id",
  ]);
  const keys = [...new Set(runs.flatMap((run) => Object.keys(run.experiment ?? {})))].filter((key) => !excludedKeys.has(key));
  const settings = keys
    .map((key) => ({
      key,
      values: runs.map((run) =>
        // The dataset version is composed name + version and can repeat its own
        // suffix on runs recorded before that was fixed at the source; runs are
        // immutable, so it collapses on the way out.
        key === "dataset_version"
          ? datasetVersionLabel(String(run.experiment?.dataset_version ?? "")) || "—"
          : key === "target_endpoint" && runInvokesTarget(run) === false
            ? "Not invoked"
          : formatValue(run.experiment?.[key as keyof typeof run.experiment]),
      ),
    }))
    .filter((setting) => setting.values.some((value) => value !== "—"));
  const differences = settings.filter((setting) => new Set(setting.values).size > 1);
  const matching = settings.filter((setting) => new Set(setting.values).size === 1);

  return (
    <section aria-labelledby="configuration-title">
      {/* Sameness was stated four times over: a "0 differences" pill, an
          empty-state card, that card's subtitle, and "17 unchanged" on the
          disclosure below. The card says it; the pill is gone; the disclosure
          counts settings rather than repeating the verdict. */}
      <div className="mb-5">
        <h2 id="configuration-title" className="text-lg font-semibold tracking-tight">Configuration differences</h2>
        <p className="mt-1 text-xs text-muted-foreground">Settings that changed from the baseline are shown first.</p>
      </div>

      {runs.slice(1).map((run, index) => {
        const baseline = runs[0]?.lineage?.target_prompt_ref?.match(/^(.+)@(\d+)$/);
        const candidate = run.lineage?.target_prompt_ref?.match(/^(.+)@(\d+)$/);
        if (!baseline || !candidate || baseline[1] !== candidate[1] || baseline[2] === candidate[2]) return null;
        return <Link key={run.run_id} href={`/catalog/prompts/${encodeURIComponent(baseline[1])}?compare=${baseline[2]}&candidate=${candidate[2]}`} className="mb-4 mr-4 inline-flex min-h-9 items-center rounded text-sm font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring">Compare prompt text: baseline and candidate {index + 1}</Link>;
      })}

      {differences.length ? (
        <div className="space-y-3">
          {differences.map((setting) => (
            <ConfigurationDifference key={setting.key} setting={setting} runs={runs} />
          ))}
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-xl border bg-card p-5 shadow-sm">
          <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-state-positive-soft text-state-positive dark:bg-state-positive-soft dark:text-state-positive">
            <Check className="size-3.5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">No configuration differences</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">These runs use the same recorded experiment settings.</p>
          </div>
        </div>
      )}

      {matching.length ? (
        <div className="mt-4 overflow-hidden rounded-xl border bg-card shadow-sm">
          <button
            type="button"
            onClick={() => setShowMatching((current) => !current)}
            aria-expanded={showMatching}
            aria-controls="matching-configuration-settings"
            className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left outline-none transition-colors hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
          >
            <span>
              <span className="block text-sm font-semibold">Settings ({matching.length})</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">Recorded the same on every selected run</span>
            </span>
            <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none", showMatching && "rotate-180")} aria-hidden="true" />
          </button>
          <div
            id="matching-configuration-settings"
            className={cn("grid transition-[grid-template-rows] duration-200 ease-standard motion-reduce:transition-none", showMatching ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
          >
            <div className="overflow-hidden">
              <dl className="border-t px-5 py-2">
                {matching.map((setting) => (
                  <div key={setting.key} className="grid gap-1 border-b py-3 last:border-b-0 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)] sm:gap-5">
                    <dt className="text-xs font-medium">{humanize(setting.key)}</dt>
                    <dd className="break-words font-mono text-xs text-muted-foreground">{setting.values[0]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ConfigurationDifference({
  setting,
  runs,
}: {
  setting: { key: string; values: string[] };
  runs: RunResult[];
}) {
  const baseline = setting.values[0];
  return (
    <article className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{humanize(setting.key)}</h3>
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-state-caution">Changed</span>
      </div>
      <div className={cn(
        "grid gap-2",
        runs.length === 4
          ? "md:grid-cols-2 xl:grid-cols-4"
          : runs.length === 3
            ? "md:grid-cols-3"
            : "sm:grid-cols-2",
      )}>
        {runs.map((run, index) => {
          const changed = index > 0 && setting.values[index] !== baseline;
          return (
            <div key={run.run_id} className={cn("min-w-0 rounded-xl border bg-background p-3", changed && "border-state-caution/30 bg-state-caution-soft dark:border-state-caution/30 dark:bg-state-caution-soft")}>
              <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                <RunIdentity run={run} index={index} />
                {changed ? <span className="normal-case tracking-normal text-state-caution">Different</span> : null}
              </div>
              <div className="break-words font-mono text-xs leading-5" title={setting.values[index]}>{setting.values[index]}</div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function buildBackendSampleRows(runs: RunResult[], itemsByRun: Record<string, RunItemSummary[]>, comparisons: RunComparison[]): SampleRow[] {
  if (runs.length < 2 || comparisons.length === 0) return [];
  const ids = new Set(comparisons.flatMap((comparison) => comparison.sample_deltas.map((sample) => sample.row_id)));
  return [...ids].map((exampleId) => {
    const items = runs.map((run) => (itemsByRun[run.run_id] ?? []).find((item) => item.example_id === exampleId));
    const candidateSamples = comparisons.map((comparison) => comparison.sample_deltas.find((sample) => sample.row_id === exampleId));
    const baseScore = candidateSamples.find(Boolean)?.base_score ?? null;
    const scores = [baseScore, ...candidateSamples.map((sample) => sample?.candidate_score ?? null)];
    const deltas = [null, ...candidateSamples.map((sample) => sample?.delta ?? null)];
    const candidateResults = candidateSamples.map<CandidateResult>((sample) => sample ? humanizeResult(sample.result) : "Unavailable");
    const comparable = candidateResults.filter((result) => result !== "Unavailable");
    const hasImprovement = comparable.includes("Improved");
    const hasRegression = comparable.includes("Regressed");
    const result: RowResult = comparable.length === 0
      ? "Unavailable"
      : hasImprovement && hasRegression
        ? "Mixed"
        : hasRegression
          ? "Regressed"
          : hasImprovement
            ? "Improved"
            : "Same";
    return {
      exampleId,
      name: items.find(Boolean)?.query || humanize(exampleId),
      scores,
      deltas,
      candidateResults,
      delta: deltas[1] ?? null,
      result,
      failed: items.some((item) => item?.worst_gate === "fail" || (item?.failing_count ?? 0) > 0),
    };
  }).sort((a, b) => Math.max(...b.deltas.map((delta) => Math.abs(delta ?? 0))) - Math.max(...a.deltas.map((delta) => Math.abs(delta ?? 0))));
}

export type CandidateSummary = {
  label: string;
  qualityDelta: number | null;
  qualityText: string;
  qualityDetail: string;
  improved: number;
  regressed: number;
  sampleText: string;
  latencyDelta: number | null;
  latencyText: string;
  latencyDetail: string;
  qualityScore: number | null;
  latencyMs: number | null;
  regressed_flag: boolean;
};

function candidateLabel(index: number): string {
  return RUN_LABELS[index + 1] ?? `Candidate ${index + 1}`;
}

function qualityDeltaText(delta: number | null): string {
  if (delta == null) return "Not available";
  if (Math.abs(delta) < 0.0005) return "No change";
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta * 100).toFixed(1)} points`;
}

function latencyDeltaText(latencyDelta: number | null): string {
  if (latencyDelta == null) return "Not available";
  if (Math.abs(latencyDelta) < 1) return "No meaningful change";
  return `${Math.abs(latencyDelta).toFixed(0)}% ${latencyDelta < 0 ? "faster" : "slower"}`;
}

function summariseCandidate(comparison: RunComparison, index: number): CandidateSummary {
  const label = candidateLabel(index);
  const improved = comparison.sample_counts.improved;
  const regressed = comparison.sample_counts.regressed;
  return {
    label,
    qualityDelta: comparison.quality_delta,
    qualityText: qualityDeltaText(comparison.quality_delta),
    qualityDetail: `${label} versus baseline`,
    improved,
    regressed,
    sampleText: improved === 0 && regressed === 0 ? "No changes" : `${improved} improved · ${regressed} regressed`,
    latencyDelta: comparison.latency_delta_percent,
    latencyText: latencyDeltaText(comparison.latency_delta_percent),
    latencyDetail:
      comparison.base_latency_ms == null || comparison.candidate_latency_ms == null
        ? "Recorded latency is incomplete"
        : `${formatLatency(comparison.base_latency_ms)} → ${formatLatency(comparison.candidate_latency_ms)}`,
    qualityScore: comparison.candidate_quality_score,
    latencyMs: comparison.candidate_latency_ms,
    regressed_flag: regressed > 0,
  };
}

export function buildSummary(
  runs: RunResult[],
  samples: SampleRow[],
  comparisons: RunComparison[],
) {
  // One summary per selected candidate — never just comparisons[0].
  const candidateSummaries = comparisons.map((comparison, index) =>
    summariseCandidate(comparison, index),
  );

  // Quality winner across ALL candidates plus the baseline.
  const averages = [comparisons[0]?.base_quality_score ?? null, ...comparisons.map((comparison) => comparison.candidate_quality_score)];
  const validAverages = averages
    .map((value, index) => ({ value, index }))
    .filter((entry): entry is { value: number; index: number } => entry.value != null);
  const bestValue = validAverages.length
    ? Math.max(...validAverages.map((entry) => entry.value))
    : null;
  const bestIndexes = bestValue == null
    ? []
    : validAverages
        .filter((entry) => Math.abs(entry.value - bestValue) < 0.0005)
        .map((entry) => entry.index);

  // Fastest run across ALL candidates plus the baseline (lower latency wins).
  const latencyValues = [comparisons[0]?.base_latency_ms ?? null, ...comparisons.map((comparison) => comparison.candidate_latency_ms)];
  const fastestRank = rankComparisonValues(latencyValues, true);
  const fastestLabel = fastestRank.status === "none"
    ? null
    : fastestRank.indexes.map((index) => RUN_LABELS[index]).join(" & ");
  const fastestMs = fastestRank.status === "none"
    ? null
    : latencyValues[fastestRank.indexes[0]!] ?? null;

  // Regressions across ALL candidates, not just the first.
  const regressionCandidates = candidateSummaries
    .filter((candidate) => candidate.regressed_flag)
    .map((candidate) => candidate.label);
  const regressedTotal = candidateSummaries.reduce((sum, candidate) => sum + candidate.regressed, 0);
  const improvedTotal = candidateSummaries.reduce((sum, candidate) => sum + candidate.improved, 0);

  // A "best" naming both entrants is not an answer, and a bare "Level" under
  // the heading "Best run score" reads as a broken value rather than a tie. Say
  // it is tied, and let the detail carry the score they tied on.
  const bestQualityLabel = bestIndexes.length === 0
    ? null
    : bestIndexes.length > 1
      ? "Tied"
      : RUN_LABELS[bestIndexes[0]];

  // First-candidate fields are retained for the single-candidate wording.
  const firstComparison = comparisons[0];
  const improved = firstComparison?.sample_counts.improved ?? 0;
  const regressed = firstComparison?.sample_counts.regressed ?? 0;
  const delta = firstComparison?.quality_delta ?? null;
  const latencies = [firstComparison?.base_latency_ms ?? null, firstComparison?.candidate_latency_ms ?? null];
  const latencyDelta = firstComparison?.latency_delta_percent ?? null;

  /*
   * One verdict, reconciling the two grains out loud.
   *
   * The page used to open with "tied on aggregate quality" directly above
   * "QUALITY REGRESSIONS — 1 candidate". Both were true and neither was wrong:
   * the run score is the mean of the run's KPI composites, while a regression
   * is counted per sample from the mean of that sample's metric scores. A run
   * can hold its score while one sample inside it gets worse. Stated separately
   * and unqualified, that reads as the page contradicting itself — so it is now
   * a single sentence that says both, and names which is which.
   */
  const sampleTotal = samples.length;
  const qualityClause = delta == null
    ? "has no comparable run score"
    : Math.abs(delta) < 0.0005
      ? "matches the baseline run score"
      : `scores ${Math.abs(delta * 100).toFixed(1)} points ${delta > 0 ? "higher" : "lower"} than the baseline`;
  const latencyClause = latencyDelta == null
    ? null
    : Math.abs(latencyDelta) < 0.5
      ? "runs at the same speed"
      : `is ${Math.abs(latencyDelta).toFixed(0)}% ${latencyDelta < 0 ? "faster" : "slower"}`;
  const sampleClause = sampleTotal === 0
    ? null
    : regressed > 0
      ? `regressed on ${regressed} of ${sampleTotal} sample${sampleTotal === 1 ? "" : "s"}`
      : improved > 0
        ? `improved on ${improved} of ${sampleTotal} sample${sampleTotal === 1 ? "" : "s"}`
        : `held every one of ${sampleTotal} sample${sampleTotal === 1 ? "" : "s"}`;

  const singleVerdict = [
    `Candidate 1 ${qualityClause}`,
    latencyClause,
    sampleClause ? `${regressed > 0 ? "but " : "and "}${sampleClause}` : null,
  ]
    .filter(Boolean)
    .join(" and ")
    .replace(" and but ", " but ")
    .replace(" and and ", " and ") + ".";

  const title = comparisons.length === 1
    ? singleVerdict
    : bestIndexes.length === 0
      ? "Aggregate quality is not available."
      : bestIndexes.length > 1
        ? `${joinRunLabels(bestIndexes.map((index) => RUN_LABELS[index]))} are tied on run score.`
        : bestIndexes[0] === 0
          ? "The baseline has the highest run score."
          : `${RUN_LABELS[bestIndexes[0]]} has the highest run score.`;

  const qualitySentence = delta == null
    ? "A baseline-to-candidate quality delta cannot be calculated from the recorded KPI results."
    : Math.abs(delta) < 0.0005
      ? "The run score is the mean of each run's KPI results; a sample score is the mean of that sample's metric results, so one can move while the other holds."
      : `The run score is the mean of each run's KPI results.`;
  const sampleSentence = sampleTotal === 0
    ? "No shared sample-level evidence is available."
    : improved === 0 && regressed === 0
      ? `No sample score changed across ${sampleTotal} shared sample${sampleTotal === 1 ? "" : "s"}.`
      : `${improved} sample${improved === 1 ? "" : "s"} improved and ${regressed} regressed against the baseline.`;

  // Cross-candidate wording once more than one candidate is compared.
  const multiQualitySentence = bestIndexes.length === 0
    ? "Aggregate quality is not available across the candidates."
    : bestIndexes.length > 1
      ? `Across ${candidateSummaries.length} candidates, ${joinRunLabels(bestIndexes.map((index) => RUN_LABELS[index]))} are tied for the highest run score.`
      : bestIndexes[0] === 0
        ? `Across ${candidateSummaries.length} candidates, the baseline retains the highest run score.`
        : `Across ${candidateSummaries.length} candidates, ${RUN_LABELS[bestIndexes[0]]} reaches the highest run score.`;
  const multiSampleSentence = regressionCandidates.length === 0
    ? "No candidate regressed on the shared samples."
    : `Sample regressions were recorded for ${regressionCandidates.join(", ")}.`;

  const body = comparisons.length > 1
    ? `${multiQualitySentence} ${multiSampleSentence}`
    : `${qualitySentence} ${sampleSentence}`;

  return {
    title,
    body,
    improved,
    regressed,
    improvedTotal,
    regressedTotal,
    candidateSummaries,
    bestQualityLabel,
    bestQualityDetail:
      bestValue == null
        ? "Aggregate quality unavailable"
        : bestIndexes.length > 1
          ? `${bestIndexes.length === 2 ? "Both runs" : `All ${bestIndexes.length} runs`} scored ${formatScore(bestValue)}`
          : "Highest recorded quality score",
    fastestLabel,
    fastestDetail: fastestMs == null ? "Recorded latency is incomplete" : `${formatLatency(fastestMs)} average latency`,
    regressionCandidates,
    regressionDetail: regressionCandidates.length === 0
      ? "No candidate regressed on shared samples"
      : `${regressionCandidates.join(", ")} regressed on shared samples`,
    qualityText: qualityDeltaText(delta),
    qualityDetail: "Candidate 1 versus baseline",
    sampleText: samples.length === 0 ? "Not available" : improved === 0 && regressed === 0 ? "No changes" : `${improved} improved · ${regressed} regressed`,
    sampleDetail: samples.length === 0 ? "No shared evidence" : `${samples.length} shared sample${samples.length === 1 ? "" : "s"}`,
    latencyText: latencyDeltaText(latencyDelta),
    latencyDetail: latencies[0] == null || latencies[1] == null
      ? "Recorded latency is incomplete"
      : `${formatLatency(latencies[0])} → ${formatLatency(latencies[1])}`,
  };
}

function runName(run: RunResult) {
  return run.run_number != null ? `exp_${String(run.run_number).padStart(3, "0")}` : run.run_id.slice(0, 8);
}

function runDisplayName(run: RunResult) {
  const timestamp = run.completed_at || run.started_at;
  const runLabel = run.run_number != null ? `Run ${run.run_number}` : run.run_id.slice(0, 8);
  if (!timestamp) return runLabel;
  return `${runLabel} · ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp))}`;
}

/**
 * A metric or KPI id as a person would say it.
 *
 * The family prefix is ours, not the reader's: "Llm.Coherence" and
 * "Kpi.Response Quality" leaked the namespace into the label and title-cased it
 * on the way out. The leaf is the name; the family is already the context.
 */
function humanize(value: string) {
  const leaf = value.includes(".") ? value.slice(value.indexOf(".") + 1) : value;
  const words = leaf.replace(/[-_.]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function humanizeResult(value: RunComparison["sample_deltas"][number]["result"]): CandidateResult {
  return value.charAt(0).toUpperCase() + value.slice(1) as CandidateResult;
}

/**
 * The delta with its meaning attached.
 *
 * "−42%" leaves the reader to work out whether down is good, and the answer
 * differs by row: less latency is better, a lower score is not. The word says
 * which; the number says how much.
 */
function formatBackendDelta(value: number | null, percentage: boolean, lowerIsBetter = false) {
  if (value == null || Number.isNaN(value)) return "Not recorded";
  if (Math.abs(value) < (percentage ? 1 : 0.0005)) return "No change";
  const magnitude = percentage ? Math.abs(value).toFixed(0) : (Math.abs(value) * 100).toFixed(1);
  // One vocabulary across both tables in this flow. "Every measure" says
  // up/down; this said higher/lower/faster/slower, so the same movement read
  // two ways depending on which table you were looking at.
  const size = `${magnitude}${percentage ? "%" : " pts"}`;
  return `${value > 0 ? "up" : "down"} ${size}`;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function formatScore(value: number | null) {
  if (value == null || Number.isNaN(value)) return "—";
  return value <= 1 ? value.toFixed(2) : value.toFixed(1);
}

function formatLatency(value: number | null) {
  return formatDuration(value) ?? "—";
}

function formatValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function extractText(value: Record<string, unknown> | null | undefined): string {
  if (!value) return "";
  const preferred = ["response", "output", "answer", "content", "query", "input", "prompt"];
  for (const key of preferred) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  const first = Object.values(value).find((candidate) => typeof candidate === "string" && candidate.trim());
  return typeof first === "string" ? first : JSON.stringify(value, null, 2);
}
