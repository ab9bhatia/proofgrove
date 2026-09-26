"use client";

import Link from "next/link";
import { ArrowRight, Play } from "lucide-react";

import { buttonVariants } from "@evalai/shared/ui/button";
import { cn } from "@evalai/shared/utils";
import { RunOutcomeBadge } from "@/components/run-outcome-badge";
import { kpiLabel } from "@/components/kpi-scorecard";
import { caseCountsFromMetrics } from "@/components/report/lib";
import { runLatencyMs } from "@/lib/chart-data";
import { formatDateTime } from "@/lib/format-time";
import { formatDuration } from "@/lib/format-duration";
import { runScoreLabel } from "@/lib/run-outcome";
import { evaluateHrefFromRun, runDetailsHref } from "@/lib/run-recommendation";
import type { RunResult } from "@/lib/api";

/**
 * What a single run actually did.
 *
 * The experiment page rendered two trend charts whenever it held any runs at
 * all, so the majority of experiments — 26 of the 49 a person can open — got
 * ~60% of the viewport spent on two hollow dots, under a header explaining that
 * two runs are needed to compare. None of it said what the run did, even though
 * the summary already knows which KPIs failed.
 *
 * This replaces the charts when there is nothing to trend. The caller decides
 * that on cohort size, not on `runs.length`: two runs that cannot be compared
 * have as little to plot as one.
 *
 * Deliberately pure. Everything except the three props derives from `run`, so
 * this renders identically in a test and on the page, and the label is passed
 * in rather than computed so the chart axis and this block can never disagree
 * about what a run is called.
 */
export function ExperimentOutcome({
  run,
  failedKpiIds,
  label,
}: {
  /** The cohort's only — or latest — run. */
  run: RunResult;
  /** `summary.failed_kpis_latest`, already carrying the `kpi.` prefix. */
  failedKpiIds: string[];
  /** Shared run label, e.g. "Run 1", from `assignRunDisplayLabels`. */
  label: string;
}) {
  const when = run.completed_at || run.started_at;
  const latency = formatDuration(runLatencyMs(run));
  const cases = caseCountsFromMetrics(run);
  const capture = run.evidence_capture_status;

  return (
    <section className="panel mb-5 overflow-hidden" aria-labelledby="experiment-outcome-title">
      <div className="border-b border-border px-5 py-4 sm:px-6">
        <p className="proofgrove-eyebrow mb-1 text-[0.6875rem] text-evalai-purple">Outcome</p>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="experiment-outcome-title" className="font-display text-lg font-semibold tracking-tight">
              <Link
                href={runDetailsHref(run.run_id)}
                // text-brand-text, not text-primary: --primary is Slate in light
                // mode, so the link rendered as plain body ink — the exact
                // "invisible as a link" defect this page is being fixed for.
                // #3f7000 is the darkened green the app uses for links on light
                // (5.95:1), swapping to the raw accent on dark.
                className="rounded-lg text-brand-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-brand"
              >
                {label}
              </Link>
            </h2>
            {when ? (
              <p className="mt-1 text-sm text-muted-foreground">{formatDateTime(when)}</p>
            ) : null}
          </div>
          <RunOutcomeBadge run={run} />
        </div>
      </div>

      <dl className="grid gap-4 px-5 py-4 sm:grid-cols-4 sm:gap-0 sm:divide-x sm:px-6">
        <Fact
          label="Score"
          /* The basis travels with the number: a run with no gate still has an
             observed score, and printing it bare was what let the chart say 0%
             while the row beside it said nothing at all. */
          value={runScoreLabel(run)}
        />
        <Fact
          label="Cases"
          value={cases ? `${cases.passed}/${cases.total} passed` : "Not recorded"}
          detail={
            cases && cases.failed + cases.warned + cases.notScored > 0
              ? [
                  cases.failed ? `${cases.failed} failed` : null,
                  cases.warned ? `${cases.warned} warned` : null,
                  cases.notScored ? `${cases.notScored} not scored` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : undefined
          }
        />
        <Fact label="Latency" value={latency ?? "Not recorded"} />
        {/* Its own fact, not a footnote under Latency. How completely the
            evidence was captured has nothing to do with how fast the run was. */}
        <Fact label="Evidence" value={capture ? CAPTURE_LABELS[capture] ?? capture : "Not recorded"} />
      </dl>

      {failedKpiIds.length ? (
        <div className="border-t border-border px-5 py-4 sm:px-6">
          {/* The one thing the page knew and never said. */}
          <p className="text-sm font-medium">
            {failedKpiIds.length === 1 ? "1 quality check failed" : `${failedKpiIds.length} quality checks failed`}
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {failedKpiIds.map((kpiId) => (
              <li
                key={kpiId}
                className="rounded-full border border-gate-fail/30 bg-gate-fail-soft px-2 py-0.5 text-xs font-medium text-gate-fail"
              >
                {kpiLabel(kpiId)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3 sm:px-6">
        <Link href={runDetailsHref(run.run_id)} className={cn(buttonVariants({ variant: "default" }), "h-11")}>
          Open run report
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
        <Link href={evaluateHrefFromRun(run)} className={cn(buttonVariants({ variant: "outline" }), "h-11")}>
          <Play className="size-4" aria-hidden="true" />
          Run again
        </Link>
      </div>
    </section>
  );
}

const CAPTURE_LABELS: Record<string, string> = {
  complete: "complete",
  partial: "partial",
  not_captured: "not captured",
  unknown: "not recorded",
};

function Fact({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 sm:px-5 sm:first:pl-0 sm:last:pr-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-base font-semibold tracking-tight text-foreground">{value}</dd>
      {detail ? <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}
