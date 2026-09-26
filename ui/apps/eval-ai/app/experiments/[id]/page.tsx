"use client";

import { PAGE_FRAME } from "@/lib/page-frame";
import { datasetVersionLabel } from "@/lib/dataset-lineage";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useId, useMemo, useState } from "react";
import { ArrowLeft, GitCompareArrows, Plus, Undo2 } from "lucide-react";
import { Button, buttonVariants } from "@evalai/shared/ui/button";
import { ProofgroveGate } from "@/components/proofgrove-gate";
import { LegacyEvaluationRouteRedirect } from "@/components/legacy-evaluation-redirect";
import { PageHeader } from "@/components/page-header";
import { formatDateTime } from "@/lib/format-time";
import { EmptyState, ErrorState, LoadingState } from "@/components/page-state";
import { AddRunsDialog } from "@/components/experiments/add-runs-dialog";
import { ExperimentOutcome } from "@/components/experiments/experiment-outcome";
import { isRunComplete, latestComparableRuns } from "@/components/experiments-library";
import { comparisonKey } from "@/lib/comparison-href";
import { api, evaluationApi, type BaselineChange, type ExperimentSummary, type RunResult } from "@/lib/api";
import { ApiError, userFacingError } from "@/lib/api-errors";
import type { AttachRunsError } from "@/components/experiments/add-runs-dialog";
import {
  assignRunDisplayLabels,
  formatMeasureValue,
  readAnalysisUrlState,
  writeAnalysisSearchParams,
  type AnalysisUrlState,
  type MeasureGroup,
} from "@/lib/chart-data";
import { loadRunHistoryPage, runHistoryApi } from "@/lib/run-history";
import { runDisplayName, runInvokesTarget } from "@/lib/run-recommendation";
import { cn } from "@evalai/shared/utils";
import { EVALUATION_SCOPE_LABELS } from "@/components/evaluation/scope-selector";
import { ExperimentAnalysisPanel, experimentMeasures, experimentMetricDelta, isComparableCandidate } from "@/components/experiments/analysis-panel";
export { ExperimentAnalysisPanel, experimentMeasures, experimentMetricDelta, isComparableCandidate } from "@/components/experiments/analysis-panel";
import { RunOutcomeBadge } from "@/components/run-outcome-badge";

// Shared implementation, rendered at the canonical `/evaluations/:id` route.
export function ExperimentDetailPage() {
  return (
    <ProofgroveGate>
      <Suspense fallback={<LoadingState label="Loading experiment…" className="min-h-[60vh] border-0" />}>
        <ExperimentDetail />
      </Suspense>
    </ProofgroveGate>
  );
}

// Legacy `/experiments/:id` route → forwards to `/evaluations/:id`.
export default function ExperimentDetailRedirect() {
  return <LegacyEvaluationRouteRedirect />;
}

const MAX_CANDIDATES = 3;
const MIN_COMPARISON_RUNS = 2;

/**
 * Whether `candidate` may legally be compared against `baseline`. Mirrors the
 * backend `store.compare_runs` rule (same recorded comparison basis) so the
 * page never offers a selection the server would reject.
 */

/**
 * The runs in `candidateIds` that may legally be compared against `baseline`,
 * in run-history order.
 *
 * Single source of truth for the candidate selection: the counter, the
 * checkboxes, the compare href and the 3-candidate cap all read this set, so an
 * id that survived in state but is no longer comparable (a baseline change, a
 * re-run that moved the comparison basis) can never occupy a cap slot while
 * being invisible in the list.
 */
export function comparableCandidateRuns(
  runs: RunResult[],
  baseline: RunResult | null | undefined,
  candidateIds: string[],
): RunResult[] {
  return runs.filter(
    (run) => candidateIds.includes(run.run_id) && isComparableCandidate(baseline, run),
  );
}

/**
 * Implicit baseline when the experiment has no pinned `baseline_run_id`: the
 * anchor of the comparable cohort, never simply the first listed run — an
 * incomplete or lone-basis run cannot anchor a comparison, so pinning it
 * silently would only produce compare links the backend rejects.
 */
export function fallbackBaselineRun(runs: RunResult[]): RunResult | null {
  return latestComparableRuns({ runs })[0] ?? null;
}

/** Why Compare selected is disabled, or null when the CTA may navigate. */
export function experimentCompareDisabledReason(
  baseline: RunResult | null | undefined,
  candidates: RunResult[],
): string | null {
  if (!baseline) return "Pin a baseline";
  // One stated minimum: a comparison needs MIN_COMPARISON_RUNS runs, and the
  // baseline is the first of them — so the candidate floor is derived, not a
  // second independently-worded rule.
  if (candidates.length < MIN_COMPARISON_RUNS - 1) return "Select at least one candidate";
  if (!isRunComplete(baseline)) return "Pin a completed run as the baseline";
  if (!comparisonKey(baseline)) return "The baseline recorded no comparison basis";
  if (candidates.some((candidate) => !isComparableCandidate(baseline, candidate))) {
    return "Every candidate must share the baseline's comparison basis";
  }
  return null;
}

/** Compare deep link for the current baseline + candidate selection. */
export function experimentCompareHref(
  experimentId: string,
  baseline: RunResult | null | undefined,
  candidates: RunResult[],
): string | null {
  if (!baseline || experimentCompareDisabledReason(baseline, candidates)) return null;
  const query = new URLSearchParams({ baseline_run_id: baseline.run_id });
  for (const candidate of candidates) query.append("candidate_run_id", candidate.run_id);
  return `/evaluations/${encodeURIComponent(experimentId)}/compare?${query.toString()}`;
}

/**
 * Checkbox state for one run in the run-history list. A run the backend would
 * refuse to compare against the pinned baseline is disabled with the reason
 * named, rather than selectable into a comparison that only fails later.
 */
export function candidateSelectability(
  run: RunResult,
  baseline: RunResult | null | undefined,
  opts: { selected: boolean; candidateCount: number },
): { disabled: boolean; reason: string | null; label: string } {
  if (baseline && baseline.run_id === run.run_id) {
    return { disabled: true, reason: null, label: "Baseline" };
  }
  if (!baseline) {
    return { disabled: true, reason: "Pin a baseline first", label: "Candidate" };
  }
  if (!isRunComplete(baseline) || !comparisonKey(baseline)) {
    return { disabled: true, reason: "The baseline cannot anchor a comparison", label: "Candidate" };
  }
  if (!isComparableCandidate(baseline, run)) {
    return {
      disabled: true,
      reason: isRunComplete(run)
        ? "Different comparison basis from the baseline"
        : "Only completed runs can be compared",
      label: "Not comparable",
    };
  }
  if (!opts.selected && opts.candidateCount >= MAX_CANDIDATES) {
    return { disabled: true, reason: "Limit 3 candidates reached", label: "Candidate" };
  }
  return { disabled: false, reason: null, label: "Candidate" };
}

export function selectionCounterLabel(candidateCount: number, hasBaseline = true): string {
  // The baseline half was the literal "1 baseline" whether or not one was
  // pinned, so the counter claimed a baseline directly above rows reading
  // "Pin a baseline first".
  // "1 of 3 candidate selected" — in this phrasing the noun agrees with the total,
  // not with how many are picked, and the total is fixed at three.
  const baseline = hasBaseline ? "1 baseline" : "No baseline";
  return `${baseline} · ${candidateCount} of ${MAX_CANDIDATES} candidates selected`;
}

export function candidateLimitHint(candidateCount: number): string | null {
  if (candidateCount >= MAX_CANDIDATES) return "Limit 3 candidates reached";
  return null;
}

/** Toggle a candidate id, respecting the max-candidate cap (silent no-op at limit). */
export function nextCandidateIds(
  current: string[],
  runId: string,
  baselineRunId: string,
): string[] {
  if (current.includes(runId)) return current.filter((id) => id !== runId);
  if (current.filter((id) => id !== baselineRunId).length >= MAX_CANDIDATES) return current;
  return [...current, runId];
}

/**
 * Honest framing for the multi-run analysis charts: name the comparable cohort
 * explicitly so a partially comparable run history is never presented as one
 * uniform trend.
 */
export function analysisCohortNote(runs: RunResult[]): string {
  const completedRunCount = runs.filter(isRunComplete).length;
  const comparableRuns = latestComparableRuns({ runs });
  if (comparableRuns.length >= MIN_COMPARISON_RUNS) {
    return `${comparableRuns.length} of ${completedRunCount} completed runs share the same comparison basis.`;
  }
  if (completedRunCount >= MIN_COMPARISON_RUNS) {
    return "The completed runs use different datasets, metrics, contracts, evaluators, or evidence scopes, so they cannot be compared safely.";
  }
  return "Complete at least two runs of this experiment to chart a comparable trend.";
}

/**
 * Displayed evidence scope for the experiment header. Manually created
 * experiments often have no experiment-level `evaluation_scope` even though
 * every attached run recorded a resolved scope in its lineage — in that case
 * the scope is derived from the runs and labelled honestly as such. Mixed
 * scopes across runs are named, never collapsed into one. "Not recorded" is
 * reserved for when neither the experiment nor any run carries a scope.
 */
/**
 * Who was under test, with the model the platform actually resolved.
 *
 * `resolved_target_provenance` is typed as an open record, so the model is read
 * behind a guard rather than asserted: an attested `gpt-5.1` is worth showing
 * beside the endpoint, a missing one is not worth inventing.
 */
/**
 * The model that actually answered, wherever it was recorded.
 *
 * On an LLM experiment the target *is* a model, so the endpoint carries it; on
 * an agent it comes off the run's resolved provenance.
 */
export function experimentTargetModel(
  experiment: ExperimentSummary["experiment"],
  runs: RunResult[],
): string {
  // Every recorded model, not the first run that happened to carry lineage.
  // Runs in one experiment may target different revisions, so reading run[0]
  // made the header depend on array order and misdescribe the rest.
  const models = new Set<string>();
  for (const run of runs) {
    const provenance = run.lineage?.resolved_target_provenance;
    const model =
      (typeof provenance?.model === "string" ? provenance.model.trim() : "") ||
      run.lineage?.model_version?.trim() ||
      "";
    if (model) models.add(model);
  }
  if (models.size === 1) return [...models][0]!;
  if (models.size > 1) return "Mixed across runs";
  return experiment.target_version?.trim() || experiment.target_endpoint?.trim() || "";
}

export function experimentTargetLabel(
  experiment: ExperimentSummary["experiment"],
  runs: RunResult[],
): string {
  // Reading runs[0] made the header depend on array order and misdescribe the
  // rest: one experiment can hold both an invoked run and a stored-response one.
  if (
    (runs.length && runs.every((run) => runInvokesTarget(run) === false)) ||
    (!runs.length && experiment.target_endpoint?.startsWith("golden-dataset:"))
  ) {
    return "Not invoked";
  }
  const endpoint = experiment.target_version || experiment.target_endpoint || "";
  // The resolved model lives on run lineage, not on the experiment: the
  // experiment records what was asked for, the run records what answered.
  const model = experimentTargetModel(experiment, runs);
  if (!endpoint) return model || "Not recorded";
  // An LLM target *is* its model, so the resolved model repeats the endpoint
  // verbatim — "gpt-4.1-mini · gpt-4.1-mini" says it twice and means it once.
  if (!model || model === endpoint) return endpoint;
  return `${endpoint} · ${model}`;
}

/** How many runs this experiment holds, and when the newest one landed. */
export function runCountLabel(runs: RunResult[]): string {
  if (runs.length === 0) return "None yet";
  const newest = [...runs].sort(
    (a, b) =>
      new Date(b.completed_at || b.started_at).getTime() -
      new Date(a.completed_at || a.started_at).getTime(),
  )[0]!;
  const count = `${runs.length} run${runs.length === 1 ? "" : "s"}`;
  const when = formatDateTime(newest.completed_at || newest.started_at);
  return when ? `${count} · last ${when}` : count;
}

export function experimentEvidenceScope(
  experimentScope: string | null | undefined,
  runs: RunResult[],
): string {
  // The shared label map, not replaceAll("_", " "): that wrote "full execution"
  // here while every other surface writes "Full execution".
  const scopeName = (scope: string) =>
    (EVALUATION_SCOPE_LABELS as Record<string, string>)[scope] ?? scope.replaceAll("_", " ");
  const recorded = experimentScope?.trim();
  if (recorded) return scopeName(recorded);
  const scopes = new Set<string>();
  for (const run of runs) {
    const scope =
      run.lineage?.resolved_evaluation_scope || run.lineage?.evaluation_scope || null;
    if (scope) scopes.add(scope);
  }
  if (scopes.size === 0) return "Not recorded";
  const names = [...scopes].sort().map(scopeName);
  if (names.length === 1) return `${names[0]} (from runs)`;
  return `Mixed across runs (${names.join(", ")})`;
}


function ExperimentDetail() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  const experimentId = decodeURIComponent(params.id);
  const [summary, setSummary] = useState<ExperimentSummary | null>(null);
  const [runs, setRuns] = useState<RunResult[]>([]);
  // Candidates are tracked separately from the pinned baseline. The baseline is
  // never a candidate, so it is deliberately excluded from this list.
  const [candidateIds, setCandidateIds] = useState<string[]>([]);
  // Latest audited baseline change made from this page; drives the Undo affordance.
  const [lastBaselineChange, setLastBaselineChange] = useState<BaselineChange | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachError, setAttachError] = useState<AttachRunsError | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // URL state is the shareable source of truth for the analytical view.
  const analysis = useMemo(
    () => readAnalysisUrlState(new URLSearchParams(searchParamsString)),
    [searchParamsString],
  );
  const updateAnalysis = useCallback(
    (patch: Partial<AnalysisUrlState>) => {
      const query = writeAnalysisSearchParams(searchParamsString, { ...analysis, ...patch });
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [analysis, pathname, router, searchParamsString],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSummary, nextRuns] = await Promise.all([
        evaluationApi.getExperimentSummary(experimentId),
        evaluationApi.listExperimentRuns(experimentId),
      ]);
      setSummary(nextSummary);
      setRuns(nextRuns);
      const baseline =
        nextSummary.baseline_run_id || fallbackBaselineRun(nextRuns)?.run_id || "";
      const baselineRun = nextRuns.find((run) => run.run_id === baseline) ?? null;
      // Keep only candidates that still exist AND are still comparable against
      // the (possibly changed) baseline, so the selected count, the checkboxes
      // and the 3-candidate cap always reconcile to the same set.
      setCandidateIds((current) =>
        comparableCandidateRuns(nextRuns, baselineRun, current).map((run) => run.run_id),
      );
    } catch (reason) {
      setError(userFacingError(reason, "Unable to load experiment"));
    } finally {
      setLoading(false);
    }
  }, [experimentId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // The Add-runs search is answered by the server-paged run-history endpoint, so
  // the box really does reach every run in the tenant rather than filtering a
  // first page held in memory.
  const searchRuns = useCallback(async (query: string) => {
    const { tenant_id } = await api.tenant();
    const page = await loadRunHistoryPage(runHistoryApi.list, {
      tenant_id,
      limit: 40,
      ...(query ? { search: query } : {}),
    });
    return { items: page.items, hasMore: page.hasMore };
  }, []);

  // Stable prefix for the ids that wire disabled CTAs to their visible reason.
  const reasonBaseId = useId();
  // Display order is oldest-first so the list reads in the same direction as
  // the charts. It stays a copy, and stays downstream: `latestComparableRuns`
  // groups by insertion order and the page reads `cohort[0]` as the implicit
  // baseline, so sorting the array it consumes would silently repin the
  // baseline to the oldest run.
  const orderedRuns = useMemo(
    () =>
      [...runs].sort(
        (a, b) =>
          new Date(a.completed_at || a.started_at).getTime() -
          new Date(b.completed_at || b.started_at).getTime(),
      ),
    [runs],
  );
  const runLabels = useMemo(() => assignRunDisplayLabels(runs), [runs]);
  const comparableRuns = useMemo(() => latestComparableRuns({ runs }), [runs]);
  const latestRun = orderedRuns[orderedRuns.length - 1] ?? null;
  const canCompare = comparableRuns.length >= MIN_COMPARISON_RUNS;
  const pinnedBaselineRunId = summary?.baseline_run_id ?? "";
  const baselineRun = useMemo(
    () => runs.find((run) => run.run_id === pinnedBaselineRunId) ?? fallbackBaselineRun(runs),
    [pinnedBaselineRunId, runs],
  );
  const baselineRunId = baselineRun?.run_id ?? "";
  const analysisMeasures = experimentMeasures(runs.filter((run) => baselineRun && (run.run_id === baselineRunId || isComparableCandidate(baselineRun, run))));
  const analysisMeasure = analysisMeasures.find((measure) => measure.id === analysis.kpi) ?? analysisMeasures[0];
  // Only runs the backend would accept against this baseline stay selected, so
  // the counter, the checkboxes and the CTA all describe one legal comparison.
  const selectedCandidates = useMemo(
    () => comparableCandidateRuns(runs, baselineRun, candidateIds),
    [baselineRun, candidateIds, runs],
  );
  const effectiveCandidateIds = useMemo(
    () => selectedCandidates.map((run) => run.run_id),
    [selectedCandidates],
  );
  const candidateCount = effectiveCandidateIds.length;
  const compareHref = useMemo(
    () => experimentCompareHref(experimentId, baselineRun, selectedCandidates),
    [baselineRun, selectedCandidates, experimentId],
  );
  const compareDisabledReason = useMemo(
    () => experimentCompareDisabledReason(baselineRun, selectedCandidates),
    [baselineRun, selectedCandidates],
  );
  const limitHint = useMemo(
    () => candidateLimitHint(candidateCount),
    [candidateCount],
  );

  function renderCompareSelectedCta(slot: string, className?: string) {
    if (compareHref) {
      return (
        <Link href={compareHref} className={cn(buttonVariants(), className)}>
          <GitCompareArrows className="size-4" aria-hidden="true" /> Compare selected
        </Link>
      );
    }
    const reason = compareDisabledReason ?? "Compare is unavailable";
    const reasonId = `${reasonBaseId}-${slot}-compare-reason`;
    return (
      <>
        {/*
          `aria-disabled` rather than `disabled`: a disabled control leaves the
          tab order and its `title` is never announced, so keyboard and screen
          reader users would get "Compare, dimmed" with no reason. The click is
          no-op'd instead, and the reason is wired up with `aria-describedby`.
        */}
        <button
          type="button"
          aria-disabled="true"
          aria-describedby={reasonId}
          onClick={(event) => event.preventDefault()}
          title={reason}
          className={cn(
            buttonVariants(),
            "aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
            className,
          )}
        >
          <GitCompareArrows className="size-4" aria-hidden="true" /> Compare selected
        </button>
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      </>
    );
  }

  function toggleCandidate(runId: string) {
    // Toggle against the set the counter renders, never the raw state: a stale
    // id must not silently consume one of the three candidate slots.
    setCandidateIds(nextCandidateIds(effectiveCandidateIds, runId, baselineRunId));
  }

  async function makeBaseline(runId: string) {
    // Promoting a candidate to the baseline must drop it from the candidate set.
    setCandidateIds((current) => current.filter((id) => id !== runId));
    try {
      // Baseline moves go through the audited endpoint, never the legacy role promotion.
      const change = await evaluationApi.promoteBaseline(experimentId, runId);
      setLastBaselineChange(change);
      await load();
    } catch (reason) {
      setError(userFacingError(reason, "Unable to change the baseline"));
    }
  }

  async function undoBaselineChange() {
    try {
      await evaluationApi.undoBaseline(experimentId);
      setLastBaselineChange(null);
      await load();
    } catch (reason) {
      setError(userFacingError(reason, "Unable to undo the baseline change"));
    }
  }

  if (loading) return <LoadingState label="Loading experiment…" className="min-h-[60vh] border-0" />;
  if (error && !summary) return <div className={PAGE_FRAME}><ErrorState message={error} onRetry={() => void load()} /></div>;
  if (!summary) return null;

  const experiment = summary.experiment;
  return (
    <div className={PAGE_FRAME}>
      <Link href="/evaluations?tab=experiments" className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft className="size-4" aria-hidden="true" /> Experiments</Link>
      <PageHeader
        section="Evaluate"
        title={experiment.name}
        description={experiment.objective || undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* One Compare button, in the section that owns the selection it
                acts on. The header carried a second copy of the same control,
                disabled for the same reason, at every run count. */}
            <Button type="button" variant="outline" onClick={() => { setAttachError(null); setAttachOpen(true); }}>
              <Plus className="size-4" aria-hidden="true" /> Add runs
            </Button>
          </div>
        }
      />
      {error ? <ErrorState className="mb-4" message={error} onRetry={() => void load()} /> : null}
      {/* What was tested, in the order a reader asks it. The strip used to
          lead with a hypothesis nobody had written and never named the target
          at all — the one fact that says what this experiment is about. An
          unrecorded hypothesis is omitted rather than printed as an absence. */}
      <div className="mb-5 rounded-xl border bg-muted/15">
        <dl className="grid gap-x-6 gap-y-3 p-4 sm:grid-cols-3">
          <Detail label="Target" value={experimentTargetLabel(experiment, runs)} />
          <Detail label="Dataset" value={datasetVersionLabel(experiment.dataset_version) || "Not selected"} />
          <Detail label="Runs" value={runCountLabel(runs)} />
        </dl>
        <details className="border-t px-4 py-2">
          <summary className="w-fit cursor-pointer rounded py-1 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Experiment setup</summary>
          <dl className="grid gap-4 py-3 sm:grid-cols-2">
            <Detail label="Judge" value={experiment.judge_model || "Not recorded"} note={experiment.judge_model && experiment.judge_model === experimentTargetModel(experiment, runs) ? "Same model as the target" : undefined} />
            <Detail label="Evidence scope" value={experimentEvidenceScope(experiment.evaluation_scope, runs)} />
            {experiment.hypothesis ? <Detail label="Hypothesis" value={experiment.hypothesis} /> : null}
          </dl>
        </details>
      </div>
      {/* Nothing to trend: one run, or several that share no comparison basis.
          Charting either draws axes around a single dot, so the page says what
          the run did instead. Gated on the cohort, not on `runs.length` — two
          runs that cannot be compared have as little to plot as one. */}
      {comparableRuns.length < MIN_COMPARISON_RUNS && latestRun ? (
        <ExperimentOutcome
          run={latestRun}
          failedKpiIds={summary.failed_kpis_latest ?? []}
          label={runLabels.get(latestRun.run_id) ?? runDisplayName(latestRun)}
        />
      ) : null}
      {runs.length >= MIN_COMPARISON_RUNS ? (
        <section className="mb-5 rounded-xl border bg-card">
          <div className="border-b px-5 py-4">
            <h2 className="text-lg font-semibold">Analysis</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {/* How this experiment's own runs relate to each other. The
                  tenant-wide run-history total used to sit here too, measuring
                  against a population nobody on this page asked about — and
                  costing a request to fetch it. */}
              Compare run variants and follow metric changes against one baseline.
            </p>
          </div>
          <ExperimentAnalysisPanel
            name={experiment.name}
            baselineRunId={baselineRunId}
            onBaselineChange={(id) => void makeBaseline(id)}
            runs={runs}
            analysis={analysis}
            onAnalysisChange={updateAnalysis}
          />
        </section>
      ) : null}
      {/* A single run is already named, scored and linked in the outcome block
          above, so the history list would be the same row twice. It returns as
          soon as there is more than one run to list. */}
      {runs.length === 1 ? null : (
      <section className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold">Run comparison</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {canCompare
                ? "Select up to three candidates to compare their cases against the baseline above."
                : "Add compatible runs to compare variants."}
            </p>
            {limitHint ? (
              <p role="status" className="mt-2 text-xs font-medium text-state-caution">
                {limitHint}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {/* Baseline and candidate controls only exist once a comparison can
                succeed. Below that they were five affordances for an action with
                nothing to act on, each explaining why it was disabled. */}
            {canCompare ? (
              <>
                <span className="text-xs text-muted-foreground">{selectionCounterLabel(candidateCount, Boolean(baselineRunId))}</span>
                {renderCompareSelectedCta("history", "min-h-8")}
              </>
            ) : null}
            {lastBaselineChange?.previous_baseline_run_id ? (
              <button
                type="button"
                onClick={() => void undoBaselineChange()}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Undo the last baseline change"
              >
                <Undo2 className="size-3.5" aria-hidden="true" />
                Undo baseline change
              </button>
            ) : null}
          </div>
        </div>
        {runs.length === 0 ? <EmptyState className="m-5" title="No runs linked" description="Add completed compatible runs to begin this experiment." /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <caption className="sr-only">Run comparison for {experiment.name}</caption>
              <thead className="border-b bg-muted/20 text-xs text-muted-foreground"><tr>
                <th scope="col" className="px-5 py-3">Compare</th>
                <th scope="col" className="px-5 py-3">Run / configuration</th>
                <th scope="col" aria-sort={analysis.sort === "score" ? analysis.order === "asc" ? "ascending" : "descending" : "none"} className="px-5 py-3 text-right"><button type="button" onClick={() => updateAnalysis({ sort: "score", order: analysis.sort === "score" && analysis.order === "desc" ? "asc" : "desc" })} className="rounded py-2 text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{analysisMeasure?.label ?? "Measurement"} {analysis.sort === "score" ? analysis.order === "asc" ? "↑" : "↓" : "↕"}</button></th>
                <th scope="col" className="px-5 py-3">Change from baseline</th>
                <th scope="col" className="px-5 py-3">Outcome</th>
              </tr></thead>
              <tbody className="divide-y">{[...orderedRuns].sort((a, b) => {
                if (analysis.sort !== "score" || !analysisMeasure) return 0;
                const left = analysisMeasure.value(a), right = analysisMeasure.value(b);
                if (left === null) return right === null ? 0 : 1;
                if (right === null) return -1;
                return (left - right) * (analysis.order === "asc" ? 1 : -1);
              }).map((run, index) => {
                const selectability = candidateSelectability(run, baselineRun, { selected: effectiveCandidateIds.includes(run.run_id), candidateCount });
                const rowReasonId = `${reasonBaseId}-candidate-${index}-reason`;
                const label = runLabels.get(run.run_id) ?? runDisplayName(run);
                const targetPrompt = run.lineage?.target_prompt_ref || run.lineage?.target_prompt_version;
                return <tr key={run.run_id} className={run.run_id === baselineRunId ? "bg-brand-purple-soft/30" : "hover:bg-muted/20"}>
                  <td className="px-5 py-4 align-top"><input type="checkbox" className="size-4 aria-disabled:cursor-not-allowed aria-disabled:opacity-50" checked={effectiveCandidateIds.includes(run.run_id)} aria-disabled={selectability.disabled || undefined} aria-describedby={selectability.reason ? rowReasonId : undefined} aria-label={`Add ${label} as a candidate`} onChange={() => { if (!selectability.disabled) toggleCandidate(run.run_id); }} /></td>
                  <th scope="row" className="max-w-sm px-5 py-4 align-top font-normal"><Link href={`/runs/${encodeURIComponent(run.run_id)}`} className="rounded font-medium text-brand-text hover:underline focus-visible:ring-2 focus-visible:ring-ring">{label}</Link>{run.run_id === baselineRunId ? <span className="ml-2 rounded bg-brand-purple-soft px-2 py-1 text-xs text-brand-text">Baseline</span> : null}<p className="mt-1 break-words text-xs text-muted-foreground">{run.experiment?.target_version || run.experiment?.target_endpoint || "Target not recorded"}</p>{targetPrompt ? <p className="mt-1 break-words text-xs text-muted-foreground">Prompt: {targetPrompt}</p> : null}<p className="mt-1 text-xs text-muted-foreground">{formatDateTime(run.completed_at || run.started_at)}</p>{selectability.reason ? <p id={rowReasonId} className="mt-1 text-xs text-muted-foreground">{selectability.reason}</p> : null}</th>
                  <td className="px-5 py-4 text-right align-top tabular-nums">{analysisMeasure ? formatMeasureValue(analysisMeasure, analysisMeasure.value(run)) : "Not recorded"}</td>
                  <td className="px-5 py-4 align-top text-xs text-muted-foreground">{analysisMeasure && baselineRun ? experimentMetricDelta(analysisMeasure, run, baselineRun) : "Change unavailable"}</td>
                  <td className="px-5 py-4 align-top"><RunOutcomeBadge run={run} /></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
      </section>
      )}
      {attachOpen ? (
        <AddRunsDialog
          workspaceRuns={runs}
          searchRuns={searchRuns}
          attaching={attaching}
          error={attachError}
          onClose={() => { if (!attaching) setAttachOpen(false); }}
          onAttach={async (runIds) => {
            setAttaching(true);
            setAttachError(null);
            try {
              const tenant = summary.experiment.tenant_id || (await api.tenant()).tenant_id;
              await evaluationApi.attachExperimentRuns(experimentId, tenant, runIds);
              setAttachOpen(false);
              await load();
            } catch (reason) {
              if (reason instanceof ApiError) {
                setAttachError({
                  message: userFacingError(reason, "Unable to attach runs"),
                  details: reason.details,
                });
              } else {
                setAttachError({ message: userFacingError(reason, "Unable to attach runs") });
              }
            } finally {
              setAttaching(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function Detail({ label, value, note }: { label: string; value: string; note?: string }) {
  // No `capitalize`: it was there to tidy lowercase enum values, but it also
  // retitles real sentences — "Not recorded" rendered as "Not Recorded", a
  // spelling that exists nowhere in the vocabulary. Values arrive already
  // written the way they should read.
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{value}</dd>
      {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
