"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ClipboardCheck,
  Database,
  FlaskConical,
  ScrollText,
} from "lucide-react";
import {
  api,
  evaluationApi,
  platformApi,
  type DatasetStats,
  type ExperimentDefinition,
  type Finding,
  type RunResult,
} from "@/lib/api";
import { UsageDashboard } from "@/components/usage-dashboard";
import { MetricCard } from "@/components/metric-card";
import { cn } from "@evalai/shared/utils";
import { EmptyState, ErrorState, LoadingState } from "@/components/page-state";
import { runScenarioTypeLabel } from "@/lib/run-recommendation";
import { RunOutcomeBadge } from "@/components/run-outcome-badge";
import { presentRunOutcome } from "@/lib/run-outcome";
import { runHistoryApi, sweepRunHistory } from "@/lib/run-history";
import { formatDateTime } from "@/lib/format-time";

const START_STEPS = [
  {
    number: "1",
    title: "Prepare evidence",
    description: "Create or import a dataset and publish the version you want to evaluate.",
    href: "/datasets",
    action: "Open datasets",
    icon: Database,
  },
  {
    number: "2",
    title: "Choose your checks",
    description: "Explore the available metrics, then select relevant checks when configuring an evaluation.",
    href: "/catalog/metrics",
    action: "Explore metrics",
    icon: ScrollText,
  },
  {
    number: "3",
    title: "Run an evaluation",
    description: "Choose published evidence, then configure only the relevant target and scoring.",
    href: "/evaluate",
    action: "Start evaluation",
    icon: FlaskConical,
  },
  {
    number: "4",
    title: "Review the evidence",
    description: "Inspect failed cases, record a human decision, and assign remediation.",
    href: "/reviews",
    action: "Open reviews",
    icon: ClipboardCheck,
  },
] as const;

import {
  ATTENTION_PREVIEW_LIMIT,
  attentionCoverageNote,
  latestCompletedRuns,
  runsNeedingAttention,
  type AttentionCoverage,
} from "@/lib/attention";

export { ATTENTION_PREVIEW_LIMIT, latestCompletedRuns, runsNeedingAttention };

export function OverviewDashboard() {
  const [runs, setRuns] = useState<RunResult[]>([]);
  const [runCoverage, setRunCoverage] = useState<AttentionCoverage>({ scanned: 0, total: 0 });
  const [datasetStats, setDatasetStats] = useState<DatasetStats | null>(null);
  const [experimentTotal, setExperimentTotal] = useState(0);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [availability, setAvailability] = useState({ runs: true, datasets: true, experiments: true, reviews: true });

  const load = useCallback(() => {
    const unavailable: string[] = [];
    setLoading(true);
    setError(null);
    api
      .tenant()
      .then(({ tenant_id }) =>
        Promise.all([
          // The same paginated sweep /reviews uses. The legacy unpaged run list
          // reads at most 50 rows, so the attention banner here would have
          // counted a different population from the review queue it links to.
          sweepRunHistory(runHistoryApi.list, { tenant_id }).catch(() => {
            unavailable.push("runs");
            return { runs: [] as RunResult[], total: 0, scanned: 0, complete: true };
          }),
          api.getDatasetStats({ tenant_id }).catch(() => {
            unavailable.push("datasets");
            return null as DatasetStats | null;
          }),
          evaluationApi.listExperimentWorkspaces(tenant_id, {limit: 1}).then((page) => page.total).catch(() => {
            unavailable.push("experiments");
            return 0;
          }),
          platformApi.listFindings(tenant_id).catch(() => {
            unavailable.push("reviews");
            return [] as Finding[];
          }),
        ]),
      )
      .then(([runSweep, nextDatasetStats, experimentList, findingList]) => {
        setRuns(runSweep.runs);
        setRunCoverage({ scanned: runSweep.scanned, total: runSweep.total });
        setDatasetStats(nextDatasetStats);
        setExperimentTotal(experimentList);
        setFindings(findingList);
        setAvailability({
          runs: !unavailable.includes("runs"),
          datasets: !unavailable.includes("datasets"),
          experiments: !unavailable.includes("experiments"),
          reviews: !unavailable.includes("reviews"),
        });
        if (unavailable.length > 0) {
          setError(`Some workspace data could not be loaded: ${unavailable.join(", ")}.`);
        }
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Load failed"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const id = window.setTimeout(load, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const latestByEvaluation = useMemo(() => latestCompletedRuns(runs), [runs]);

  const publishedCount = datasetStats?.by_status?.PUBLISHED ?? 0;
  const datasetTotal = datasetStats?.total ?? 0;
  const waitingFindings = findings.filter((finding) =>
    finding.status === "open" || finding.status === "in_review",
  );
  // Counted, not just rated. "40%" over five evaluations reads like a
  // measurement; "2 of 5" reads like what it is, and it says what the rate is
  // measured across without the reader having to work it out.
  const passedRunCount = latestByEvaluation.filter(
    (run) => presentRunOutcome(run).kind === "pass",
  ).length;
  const passRate = latestByEvaluation.length
    ? passedRunCount / latestByEvaluation.length
    : null;

  // The fixed-height list scrolls through all available attention items.
  const attentionAll = useMemo(() => runsNeedingAttention(latestByEvaluation), [latestByEvaluation]);
  const coverageNote = attentionCoverageNote(runCoverage);

  if (loading) {
    return <LoadingState label="Loading evaluation workspace…" className="min-h-48" />;
  }

  return (
    <section className="space-y-6">
      {error ? (
        <ErrorState title="Some workspace data is unavailable" message={error} onRetry={load} />
      ) : null}

      {/* No attention banner. It was driven by the same `attentionAll` array as
          the "Needs attention" panel below and linked to the same place, so the
          page opened by stating one fact twice before showing the rows. */}

      <div
        className="panel grid overflow-hidden sm:grid-cols-2 lg:grid-cols-4"
        aria-label="Workspace summary"
      >
        <MetricCard
          variant="strip"
          href="/evaluations?tab=experiments"
          label="Active experiments"
          value={availability.experiments ? String(experimentTotal) : "Unavailable"}
          hint={
            !availability.experiments
              ? "Experiment data could not be loaded"
              : "Saved comparison workspaces"
          }
          className="border-b border-border sm:border-b-0 sm:border-r lg:border-b-0"
        />
        <MetricCard
          variant="strip"
          href="/evaluations"
          label="Latest pass rate"
          value={!availability.runs ? "Unavailable" : passRate == null ? "—" : `${Math.round(passRate * 100)}%`}
          hint={
            !availability.runs
              ? "Run data could not be loaded"
              : latestByEvaluation.length
              ? `${passedRunCount} of ${latestByEvaluation.length} evaluations`
              : "No completed runs yet"
          }
          className="border-b border-border sm:border-b-0 lg:border-r"
        />
        <MetricCard
          variant="strip"
          href="/datasets?status=PUBLISHED"
          label="Published datasets"
          value={availability.datasets ? String(publishedCount) : "Unavailable"}
          hint={availability.datasets ? `${datasetTotal} total versions` : "Dataset data could not be loaded"}
          className="border-b border-border sm:border-r sm:border-b-0 lg:border-b-0"
        />
        <MetricCard
          variant="strip"
          href="/reviews"
          label="Awaiting review"
          value={availability.reviews ? String(waitingFindings.length) : "Unavailable"}
          hint={availability.reviews ? "Open or in-review findings" : "Review data could not be loaded"}
        />
      </div>

      <details className="panel overflow-hidden">
        <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-brand-text focus-visible:ring-2 focus-visible:ring-ring">Getting started</summary>
        <div className="border-b border-border px-5 py-4 sm:px-6">
          <p className="eval-hub-eyebrow mb-1.5 text-[0.6875rem] text-evalai-purple">Get started</p>
          <h2 id="start-title" className="font-display text-lg font-semibold tracking-tight">
            Evaluation workflow
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Follow the same four steps for a new system or return directly to the stage that needs attention.
          </p>
        </div>
        <ol className="grid sm:grid-cols-2 xl:grid-cols-4">
          {START_STEPS.map((step, index) => {
            const Icon = step.icon;
            const cellBorder =
              index === 0
                ? "border-b border-border sm:border-b-0 sm:border-r xl:border-b-0"
                : index === 1
                  ? "border-b border-border sm:border-b-0 xl:border-r"
                  : index === 2
                    ? "border-b border-border sm:border-r sm:border-b-0 xl:border-b-0"
                    : "";
            return (
              <li key={step.number} className={cn("min-w-0", cellBorder)}>
                <Link
                  href={step.href}
                  className="group flex h-full flex-col px-5 py-5 transition-colors duration-150 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:py-6"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="eval-hub-eyebrow text-[0.6875rem] text-evalai-purple">
                      Step {step.number}
                    </span>
                    <Icon
                      className="size-4 shrink-0 text-muted-foreground/70 transition-colors duration-150 group-hover:text-evalai-purple"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                  </div>
                  <h3 className="mt-3 font-display text-base font-medium tracking-tight">{step.title}</h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{step.description}</p>
                  <span className="mt-auto flex items-center gap-1 pt-4 text-xs font-medium text-brand-text transition-transform duration-150 dark:text-brand">
                    {step.action}
                    <ArrowRight
                      className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </details>

      <UsageDashboard qualityRuns={runs} attention={
        <section className="flex h-[26rem] min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm" aria-labelledby="attention-title">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b px-5 py-4">
            <div>
              <h2 id="attention-title" className="text-base font-semibold">Needs attention</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {attentionAll.length} evaluations · latest non-passing result per evaluation.
                {coverageNote ? ` ${coverageNote}` : ""}
              </p>
            </div>
            <Link href="/reviews" className="shrink-0 text-xs font-medium text-brand-text hover:underline dark:text-brand">
              Review queue
            </Link>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" tabIndex={0} role="region" aria-label="Evaluations needing attention">
          {!availability.runs ? (
            <ErrorState title="Runs unavailable" message="Attention status could not be calculated." onRetry={load} className="min-h-44 border-0 bg-transparent" />
          ) : attentionAll.length ? (
            <div className="divide-y">
              {attentionAll.map((run) => (
                <RunRow key={run.run_id} run={run} />
              ))}
            </div>
          ) : (
            <EmptyState
              title="No evaluations need attention"
              description="Warnings and failures from each evaluation’s latest completed run appear here."
              className="min-h-0 border-0 bg-transparent py-4"
            />
          )}
          </div>
        </section>
      } />

    </section>
  );
}

function RunRow({ run }: { run: RunResult }) {
  const name =
    run.experiment?.tags?.evaluation_name?.trim() ||
    run.experiment?.name ||
    "Evaluation run";
  return (
    <Link
      href={`/runs/${encodeURIComponent(run.run_id)}`}
      className="flex min-h-16 items-center justify-between gap-4 px-5 py-3 transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {runScenarioTypeLabel(run)} · {formatDateTime(run.completed_at || run.started_at)}
        </span>
      </span>
      <RunOutcomeBadge run={run} />
    </Link>
  );
}
