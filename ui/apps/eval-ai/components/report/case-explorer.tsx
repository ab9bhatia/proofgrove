"use client";

import { useCallback, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { cn } from "@evalai/shared/utils";
import {
  type MetricResult,
  type RunItemDetail,
  type RunItemSummary,
  type RunResult,
} from "@/lib/api";
import { GateBadge } from "@/components/gate-badge";
import { CopyIdButton } from "@/components/copyable-id";
import { ExportMenu } from "@/components/export-menu";
import { metricHasVerdict, metricScoreLabel, presentCaseOutcome } from "@/lib/run-outcome";
import { formatDuration } from "@/lib/format-duration";
import {
  attentionLabel,
  caseEvidencePresentation,
  formatPlainEnglish,
  humanizeKey,
  metricDisplayName,
  parseJson,
  pickText,
  scoreColor,
  summarizeMetricScores,
  metricResultIsScored,
  nativeMetricValue,
  groupByMetricFamily,
  isMeasurement,
  metricMeasurements,
  metricsNeedingAttention,
  metricTone,
  toneTextClass,
  toneBarClass,
  type CaseEvidencePresentation,
  type CaseScoreSummary,
} from "./lib";

export type CaseFilter = "all" | "attention" | "passed";

/** A case needs attention whenever its presented outcome is anything but Pass. */
export function caseNeedsAttention(item: RunItemSummary): boolean {
  return presentCaseOutcome(item).kind !== "pass";
}

/**
 * The case a reader should land on when they open a run without asking for a
 * particular one.
 *
 * Opening a run used to show a list with nothing selected, so the first thing
 * anyone did on a run that failed was hunt for the case that failed. Returns
 * null when every case passed — there is nothing to answer for, and opening an
 * arbitrary case would be noise rather than a head start.
 */
export function firstCaseNeedingAttention(items: RunItemSummary[]): string | null {
  return items.find(caseNeedsAttention)?.example_id ?? null;
}

/** Filter the run items to the active case filter, preserving order. */
export function filterCases(items: RunItemSummary[], filter: CaseFilter): RunItemSummary[] {
  if (filter === "attention") return items.filter(caseNeedsAttention);
  if (filter === "passed") return items.filter((item) => !caseNeedsAttention(item));
  return items;
}

/**
 * Resolve the id to navigate to from a selected case, staying within the
 * currently filtered/sorted set so prev/next never jump to a hidden case.
 */
export function adjacentCaseId(
  filteredItems: RunItemSummary[],
  selectedId: string | null,
  direction: -1 | 1,
): string | null {
  if (!selectedId) return null;
  const index = filteredItems.findIndex((item) => item.example_id === selectedId);
  if (index === -1) return null;
  return filteredItems[index + direction]?.example_id ?? null;
}

export function EvaluatorOverview({ run, totalCases }: { run: RunResult; totalCases: number }) {
  const summaries = summarizeMetricScores(run, totalCases).filter((metric) => !isMeasurement(metric.id));
  const metrics = [...summaries].sort((a, b) => (b.failingCount + b.errorCount) - (a.failingCount + a.errorCount) || a.label.localeCompare(b.label));
  if (!metrics.length) return <p className="text-sm text-muted-foreground">No evaluator results recorded. Operational measurements are available in Metrics when captured.</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Each evaluator measures a different property. Average scores do not imply that every case passed.</p>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-left text-sm" aria-label="Evaluator outcomes">
          <thead className="border-b bg-muted/20"><tr>
            <th scope="col" className="px-4 py-3">Evaluator</th>
            <th scope="col" className="px-4 py-3">Average</th>
            <th scope="col" className="px-4 py-3">Passed / judged</th>
            <th scope="col" className="px-4 py-3">Scored / cases</th>
            <th scope="col" className="px-4 py-3">Errors</th>
          </tr></thead>
          <tbody className="divide-y">{metrics.map((metric) => {
            const scored = metric.results.filter((row) => metricResultIsScored(row) && row.normalised_score !== null && row.metric_applicability !== "not_applicable");
            const judged = scored.filter((row) => row.threshold_result != null);
            const passed = judged.filter((row) => row.threshold_result === "pass").length;
            const average = metric.mean;
            const notApplicable = metric.results.filter((row) => row.metric_applicability === "not_applicable").length;
            return <tr key={metric.id}>
              <th scope="row" className="px-4 py-3 font-medium capitalize">{metric.label}</th>
              <td className="px-4 py-3 tabular-nums">{average == null ? "Not scored" : `${(average * 100).toFixed(1)}%`}</td>
              <td className="px-4 py-3 tabular-nums">{judged.length ? `${passed} / ${judged.length}` : "No verdict"}</td>
              <td className="px-4 py-3 tabular-nums">{scored.length} / {metric.totalCases || "—"}{notApplicable ? <span className="block text-xs text-muted-foreground">{notApplicable} not applicable</span> : null}</td>
              <td className={cn("px-4 py-3 tabular-nums", metric.errorCount > 0 && "font-medium text-destructive")}>{metric.errorCount}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">Passed / judged excludes cases without a verdict. Errors and unavailable evidence are not counted as a zero score. Open Metrics for thresholds and per-case scoring evidence.</p>
    </div>
  );
}

export function EmbeddedMetricSummary({
  run,
  totalCases,
  items = [],
}: {
  run: RunResult;
  totalCases: number;
  items?: RunItemSummary[];
}) {
  const [expandedMetricIds, setExpandedMetricIds] = useState<Set<string>>(new Set());
  const allMetrics = summarizeMetricScores(run, totalCases);
  // Measurements are not judgements, so they do not belong in a table whose
  // columns are Average score, Case coverage and Outcome. They get a band of
  // their own above it.
  const metrics = allMetrics.filter((metric) => !isMeasurement(metric.id));
  const measurements = metricMeasurements(run);
  // Grouped the way the creation flow groups them, so the report reads in the
  // same shape the operator chose the metrics in. A flat alphabetical list put
  // text-overlap diagnostics between two gating quality metrics.
  const metricFamilies = groupByMetricFamily(metrics, (metric) => metric.id);
  const itemsById = new Map(items.map((item) => [item.example_id, item]));
  if (metrics.length === 0 && measurements.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No metrics were recorded for this run.
      </p>
    );
  }

  const fullyCovered = metrics.filter(
    (metric) => metric.totalCases > 0 && metric.caseCount === metric.totalCases,
  ).length;
  const knownCaseCount = Math.max(totalCases, ...metrics.map((metric) => metric.totalCases));
  const attentionCount = metricsNeedingAttention(metrics).length;
  const coverageSummary =
    knownCaseCount === 0
      ? "Case coverage unavailable"
      : fullyCovered === metrics.length
        ? `Complete coverage across ${knownCaseCount} case${knownCaseCount === 1 ? "" : "s"}`
        : `Complete coverage: ${fullyCovered} of ${metrics.length} metrics`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">{metrics.length} metrics</span>
          {` · ${coverageSummary}`}
        </p>
        <div className="flex items-center gap-3">
          <p>{attentionCount > 0 ? attentionLabel(attentionCount) : "All metrics met their thresholds"}</p>
          <ExportMenu run={run} scope="metrics" label="Export" />
        </div>
      </div>

      {measurements.length > 0 ? (
        // One line, not a grid of boxes: these are readings, and four bordered
        // cards gave plumbing the same visual weight as the judged metrics
        // below. Scrolls horizontally rather than wrapping into rows.
        <section
          aria-label="Operational measurements"
          // Distributed across the width rather than bunched at the left: at
          // four readings the row was a cluster with dead space beside it.
          className="flex flex-wrap justify-between gap-x-6 gap-y-3 rounded-xl border bg-muted/10 px-4 py-3"
        >
          {measurements.map((measurement) => (
            <div key={measurement.id} className="min-w-0 flex-1 basis-32">
              <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground" title={measurement.id}>
                {measurement.label}
              </p>
              <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">
                {measurement.value}
                {measurement.worst ? (
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    ({measurement.worst} worst)
                  </span>
                ) : null}
              </p>
            </div>
          ))}
        </section>
      ) : null}

      {metrics.length > 0 ? (
      <div className="overflow-hidden rounded-xl border bg-background">
        <div className="hidden border-b bg-muted/15 px-4 py-2.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground md:grid md:grid-cols-[minmax(12rem,1.3fr)_minmax(10rem,1fr)_minmax(8rem,.7fr)_minmax(10rem,.8fr)] md:gap-5">
          <span>Metric</span>
          <span>Average score</span>
          <span>Case coverage</span>
          {/* Not a verdict on the average beside it: the badge is the worst
              case's gate. A mean of 81% over an 80% threshold sat next to a red
              FAIL and read as one contradictory claim. */}
          <span className="text-right">Worst case</span>
        </div>
        {metricFamilies.map((family) => (
          // A plain <details> so a family collapses without any client state,
          // and stays collapsible when JavaScript has not hydrated yet.
          <details key={family.prefix} open className="group/family">
            <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 border-b bg-muted/10 px-4 py-3 outline-none hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <span aria-hidden="true" className="text-xs text-muted-foreground transition-transform [details[open]>summary_&]:rotate-90">
                ▸
              </span>
              <h4 className="text-xs font-semibold uppercase tracking-[0.08em]">{family.label}</h4>
              <span className="text-[11px] text-muted-foreground">
                {family.items.length} {family.items.length === 1 ? "metric" : "metrics"}
              </span>
              {family.items.every((metric) => !metric.gating) ? (
                <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Diagnostic · does not gate
                </span>
              ) : null}
              {family.note ? (
                <span className="w-full text-[11px] leading-4 text-muted-foreground">{family.note}</span>
              ) : null}
            </summary>
            {family.items.map((metric) => {
          const open = expandedMetricIds.has(metric.id);
          const pct = metric.mean == null ? null : metric.mean * 100;
          const native = nativeMetricValue(metric.id, metric.nativeMean);
          // Judged against this metric's own threshold, not a global cutoff:
          // 75% under an 80% threshold is a failure and must not read green.
          const tone = metricTone(metric.worstGate, metric.mean, metric.threshold);
          const scoredCount = metric.results.filter((row) => metricResultIsScored(row) && row.normalised_score !== null && row.metric_applicability !== "not_applicable").length;
          const coveragePct =
            metric.totalCases > 0 ? (metric.caseCount / metric.totalCases) * 100 : null;
          const thresholdLabel = metric.thresholdVaries
            ? "Threshold varies by case"
            : metric.threshold != null
              ? `Threshold ${(metric.threshold * 100).toFixed(0)}% per case`
              : "No threshold recorded";
          const outcomeDetail =
            metric.errorCount > 0
              ? `${metric.errorCount} technical error${metric.errorCount === 1 ? "" : "s"}`
              : metric.failingCount > 0
                ? `${metric.failingCount} failed case${metric.failingCount === 1 ? "" : "s"}`
                : metric.warningCount > 0
                  ? `${metric.warningCount} warning${metric.warningCount === 1 ? "" : "s"}`
                  : metric.worstGate === null
                    ? humanizeKey(metric.state)
                    : null;

          return (
            <div
              key={metric.id}
              id={`report-metric-${metric.id}`}
              tabIndex={-1}
              className="border-b last:border-b-0"
            >
              <div className="grid gap-4 px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:grid-cols-[minmax(12rem,1.3fr)_minmax(10rem,1fr)_minmax(8rem,.7fr)_minmax(10rem,.8fr)] md:items-center md:gap-5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium capitalize" title={metric.id}>
                    {metric.label}
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground md:sr-only">
                      Average
                    </span>
                    <span
                      className={cn(
                        "font-mono text-sm font-semibold",
                        toneTextClass(tone),
                      )}
                    >
                      {/* The measurement leads where the metric has its own
                          units: "9.10 s" is what an operator acts on, and the
                          normalised score only explains the chip beside it. */}
                      {native ?? (pct == null ? "Not scored" : `${pct.toFixed(1)}%`)}
                    </span>
                  </div>
                  {native && pct != null ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Scores {pct.toFixed(1)}% against its threshold
                    </p>
                  ) : null}
                  <div
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
                    role={pct == null ? undefined : "progressbar"}
                    aria-label={pct == null ? undefined : `${metric.label} average score`}
                    aria-valuemin={pct == null ? undefined : 0}
                    aria-valuemax={pct == null ? undefined : 100}
                    aria-valuenow={pct == null ? undefined : Math.round(pct)}
                  >
                    {pct != null ? (
                      <div
                        className={cn("h-full rounded-full", toneBarClass(tone))}
                        style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }}
                      />
                    ) : null}
                  </div>
                  <p className="mt-1.5 text-[10px] text-muted-foreground">{thresholdLabel}</p>
                </div>

                <div>
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground md:sr-only">
                    Case coverage
                  </p>
                  <p className="mt-1 text-sm font-medium md:mt-0">
                    {metric.caseCount}/{metric.totalCases || "—"}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">cases</span>
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {/* "100% observed" beside "Not scored" read as a contradiction:
                        coverage counts cases that produced a result, and a result
                        can carry no score. Saying so is shorter than the footnote
                        that used to explain it away. */}
                    {coveragePct == null
                      ? "No cases recorded"
                      : `${coveragePct.toFixed(0)}% attempted · ${scoredCount} scored`}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-3 md:justify-end md:text-right">
                  <div>
                    {metric.worstGate ? (
                      <GateBadge gate={metric.worstGate} size="sm" />
                    ) : (
                      <span className="text-[10px] font-medium text-muted-foreground">
                        {humanizeKey(metric.state)}
                      </span>
                    )}
                    {outcomeDetail ? (
                      <p
                        className={cn(
                          "mt-1 text-[11px]",
                          metric.failingCount > 0 || metric.errorCount > 0
                            ? "text-destructive"
                            : "text-muted-foreground",
                        )}
                      >
                        {outcomeDetail}
                      </p>
                    ) : null}
                  </div>
                  {metric.results.length > 0 ? (
                    <button
                      type="button"
                      aria-label={`${open ? "Hide" : "View"} scoring details for ${metric.label}`}
                      aria-expanded={open}
                      aria-controls={`metric-scoring-${metric.id}`}
                      onClick={() =>
                        setExpandedMetricIds((current) => {
                          const next = new Set(current);
                          if (next.has(metric.id)) next.delete(metric.id);
                          else next.add(metric.id);
                          return next;
                        })
                      }
                      title={`${open ? "Hide" : "View"} scoring details`}
                      className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronDown
                        className={cn("size-4 transition-transform", open && "rotate-180")}
                        aria-hidden="true"
                      />
                    </button>
                  ) : null}
                </div>
              </div>

              <div
                className={cn(
                  "grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-standard motion-reduce:transition-none",
                  open && "grid-rows-[1fr]",
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  <div
                    id={`metric-scoring-${metric.id}`}
                    className="border-t bg-muted/15 px-4 py-4"
                    aria-hidden={!open}
                  >
                    <div className="mb-3">
                      <p className="text-sm font-semibold">Case scoring evidence</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        The average is the mean of {metric.results.length} recorded normalized case score
                        {metric.results.length === 1 ? "" : "s"}. Each rationale below comes from the scorer result saved with the run.
                      </p>
                    </div>
                    {/* No card border here: this panel already sits inside the
                        metric's own bordered row, inside the metrics table's
                        border, inside the section card — a fourth box added
                        nothing a divider and the muted tint don't already say.
                        Matches the Quality controls rationale panel, which uses
                        the same divide-y-on-tint treatment for the same job. */}
                    <div className="divide-y">
                      {metric.results.map((result, index) => {
                        const caseItem = itemsById.get(result.row_id);
                        const scorerName = result.evaluator_id || result.evaluator_instance_id;
                        const scorerVersion = result.evaluator_version || result.prompt_version;
                        return (
                          <div
                            key={`${result.metric_id}-${result.row_id}-${index}`}
                            className="grid gap-3 px-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto]"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">
                                {caseItem?.query || `Case ${index + 1}`}
                              </p>
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                {result.rationale || "No scoring rationale was captured for this case."}
                              </p>
                              <p className="mt-2 text-[10px] text-muted-foreground">
                                Scorer {scorerName || "not captured"}
                                {scorerVersion ? ` · version ${scorerVersion}` : ""}
                                {result.judge_model ? ` · judge ${result.judge_model}` : ""}
                              </p>
                            </div>
                            <div className="flex items-start justify-between gap-3 sm:justify-end">
                              <div className="text-right">
                                {/* Coloured by this metric's own gate, which
                                    is rendered immediately beside it — a global
                                    cutoff made the two disagree on one row. */}
                                <p className={cn("font-mono text-sm font-semibold tabular-nums", toneTextClass(metricTone(result.threshold_result ?? null, result.normalised_score, result.threshold)))}>
                                  {metricScoreLabel(result)}
                                </p>
                                <p className="text-[10px] tabular-nums text-muted-foreground">
                                  threshold {(result.threshold * 100).toFixed(0)}%
                                </p>
                              </div>
                              {result.threshold_result && metricHasVerdict(result) ? <GateBadge gate={result.threshold_result} size="sm" /> : <span className="text-xs text-muted-foreground">—</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
            })}
          </details>
        ))}
      </div>
      ) : null}

      {metrics.length > 0 ? (
        <p className="text-[11px] leading-5 text-muted-foreground">
          Coverage shows cases with a recorded result for each metric. It does not infer why a metric was missing.
        </p>
      ) : null}
    </div>
  );
}

function CaseEvidenceState({
  presentation,
}: {
  presentation: CaseEvidencePresentation;
}) {
  return (
    <span className="hidden min-w-0 md:block">
      <span
        className={cn(
          "inline-flex max-w-full rounded-full border px-2 py-0.5 text-[10px] font-medium",
          presentation.captureTone === "positive" &&
            "border-state-positive/30 bg-state-positive-soft text-state-positive dark:border-state-positive/30 dark:bg-state-positive-soft dark:text-state-positive",
          presentation.captureTone === "attention" &&
            "border-state-caution/30 bg-state-caution-soft text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution",
          presentation.captureTone === "neutral" && "border-border bg-muted/50 text-muted-foreground",
        )}
      >
        {presentation.captureLabel}
      </span>
      {presentation.evaluationLabel ? (
        <span
          className={cn(
            "mt-1 block text-[10px] leading-4",
            presentation.evaluationTone === "negative" && "text-destructive",
            presentation.evaluationTone === "attention" && "text-state-caution",
            presentation.evaluationTone === "neutral" && "text-muted-foreground",
          )}
        >
          {presentation.evaluationLabel}
        </span>
      ) : null}
    </span>
  );
}

export function CaseDetailsSection({
  items,
  loading,
  error,
  embedded = false,
  expanded,
  detailsById,
  detailLoading,
  detailErrors = {},
  onToggle,
  onExpandAll,
  onInspect,
  onRetry,
  onRetryDetail,
  scoresById = {},
  filter: filterProp,
  onFilterChange,
  highlightId = null,
}: {
  items: RunItemSummary[];
  loading: boolean;
  error: string | null;
  embedded?: boolean;
  expanded: Set<string>;
  detailsById: Record<string, RunItemDetail>;
  detailLoading: Set<string>;
  /** Per-case detail load errors, keyed by example id (already user-facing). */
  detailErrors?: Record<string, string>;
  onToggle: (exampleId: string) => void;
  onExpandAll: () => void;
  onInspect?: (exampleId: string) => void;
  /** Retry a failed case-list load. */
  onRetry?: () => void;
  /** Retry a failed per-case detail load. */
  onRetryDetail?: (exampleId: string) => void;
  scoresById?: Record<string, CaseScoreSummary>;
  /** The case worth looking at first, marked rather than opened.
   *
   *  Opening it put a drawer over the report before the reader had seen the
   *  report. Marking the row points at the failure and leaves them in charge of
   *  when to look at it. */
  highlightId?: string | null;
  /** Controlled filter; when omitted the section manages its own state. */
  filter?: CaseFilter;
  onFilterChange?: (filter: CaseFilter) => void;
}) {
  const [localFilter, setLocalFilter] = useState<CaseFilter>("all");
  const filter = filterProp ?? localFilter;
  const setFilter = useCallback(
    (next: CaseFilter) => {
      if (onFilterChange) onFilterChange(next);
      else setLocalFilter(next);
    },
    [onFilterChange],
  );
  const attentionCount = items.filter(caseNeedsAttention).length;
  const passedCount = items.length - attentionCount;
  const visibleItems = filterCases(items, filter);

  if (loading) {
    return (
      <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" aria-hidden="true" />
        <span className="sr-only">Loading evaluation cases…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="space-y-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/20 dark:text-red-100">
        <p className="font-medium">{"Couldn't load cases for this run."}</p>
        <p className="text-xs leading-5 opacity-90">{error}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg border border-red-300 bg-background px-3 py-1.5 text-xs font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring dark:border-red-800"
          >
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No evaluated cases for this run.</p>;
  }

  // Two layouts, one component: the standalone report returns below, and
  // everything after that return is the embedded one. Each branch used to also
  // carry `embedded ? :` ternaries whose other half could never run, which read
  // as far more nesting and conditional behaviour than actually exists.
  if (!embedded) {
    return (
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{items.length} cases</span>
            {passedCount === items.length ? " · All passed" : ` · ${attentionLabel(attentionCount)}`}
          </p>
          <div
            role="group"
            aria-label="Filter evaluation cases"
            className="grid w-full grid-cols-3 gap-1 rounded-lg bg-muted/70 p-1 sm:w-auto sm:min-w-[25rem]"
          >
            {(
              [
                ["all", `All (${items.length})`],
                ["attention", `Needs attention (${attentionCount})`],
                ["passed", `Passed (${passedCount})`],
              ] as Array<[CaseFilter, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  "min-h-8 rounded-lg px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  filter === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border bg-background">
          <div className="hidden grid-cols-[minmax(0,1fr)_6.5rem_8rem_7rem_6.5rem_2rem] items-center gap-3 border-b bg-muted/30 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground md:grid">
            <span>Case</span>
            <span>Outcome</span>
            <span>Evidence</span>
            <span>Average score</span>
            <span>Latency</span>
            <span className="sr-only">Open</span>
          </div>
          <div className="divide-y">
            {visibleItems.map((item) => {
              const caseOutcome = presentCaseOutcome(item);
              const query = item.query || `Case ${item.sequence_position + 1}`;
              const score = scoresById[item.example_id];
              const evidence = caseEvidencePresentation(item);
              return (
                <button
                  key={item.example_id}
                  id={`report-case-${item.example_id}`}
                  type="button"
                  aria-haspopup="dialog"
                  onClick={() => (onInspect ?? onToggle)(item.example_id)}
                  className="grid w-full gap-3 px-4 py-3.5 text-left outline-none transition-colors hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:grid-cols-[minmax(0,1fr)_6.5rem_8rem_7rem_6.5rem_2rem] md:items-center md:gap-3"
                >
                  <span className="flex min-w-0 items-start gap-3 md:items-center">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-xs font-medium text-muted-foreground">
                      {String(item.sequence_position + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0">
                      <span className="line-clamp-2 block text-sm font-medium leading-5">{query}</span>
                      <span className="mt-1 block text-[11px] text-muted-foreground md:hidden">
                        {score ? `${(score.mean * 100).toFixed(1)}% average · ` : ""}
                        {item.metric_count} metrics
                        {item.latency_ms != null ? ` · ${formatDuration(item.latency_ms)}` : ""}
                        {` · ${evidence.captureLabel}`}
                        {evidence.evaluationLabel ? ` · ${evidence.evaluationLabel}` : ""}
                      </span>
                    </span>
                  </span>
                  <span className="flex items-center justify-between gap-3 md:block">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground md:hidden">
                      Outcome
                    </span>
                    {caseOutcome.gate ? (
                      <GateBadge gate={caseOutcome.gate} size="sm" />
                    ) : (
                      <span className="text-[11px] font-medium text-muted-foreground">{caseOutcome.label}</span>
                    )}
                  </span>
                  <CaseEvidenceState presentation={evidence} />
                  <span className="hidden text-xs text-muted-foreground md:block">
                    {score ? (
                      <>
                        <span className={cn("block font-mono font-semibold tabular-nums", scoreColor(score.mean * 100))}>
                          {(score.mean * 100).toFixed(1)}%
                        </span>
                        <span className="mt-0.5 block text-[10px]">
                          {`${score.count} checks scored · average`}
                        </span>
                      </>
                    ) : (
                      <span className="text-[11px]">Not available</span>
                    )}
                  </span>
                  <span className="hidden font-mono text-xs text-muted-foreground md:block">
                    {formatDuration(item.latency_ms) ?? "Not captured"}
                  </span>
                  <ChevronRight className="hidden size-4 text-muted-foreground md:block" aria-hidden="true" />
                </button>
              );
            })}
          </div>
          {visibleItems.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              No cases match this filter.
            </p>
          ) : null}
        </div>
        <p className="text-[11px] leading-5 text-muted-foreground">
          Select a case to inspect its saved output, context, scorer rationale, and execution evidence.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{items.length} cases</span>
            {passedCount === items.length ? " · All passed" : ` · ${attentionLabel(attentionCount)}`}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={onExpandAll}
          >
            Expand all
          </Button>
        </div>
        <div
          role="group"
          aria-label="Filter evaluation cases"
          className="grid grid-cols-3 gap-1 rounded-lg bg-muted/70 p-1"
        >
          {(
            [
              ["all", `All (${items.length})`],
              ["attention", `Needs attention (${attentionCount})`],
              ["passed", `Passed (${passedCount})`],
            ] as Array<[CaseFilter, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                "min-h-8 rounded-lg px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filter === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="divide-y overflow-hidden rounded-xl border bg-background">
      {visibleItems.map((item) => {
        const open = expanded.has(item.example_id);
        const detail = detailsById[item.example_id];
        const detailError = detailErrors[item.example_id];
        const scoredResults = (detail?.scorer_results ?? []).filter(
          (row): row is MetricResult & { normalised_score: number } => row.normalised_score !== null,
        );
        const avg = scoredResults.length
          ? scoredResults.reduce((sum, row) => sum + row.normalised_score, 0) / scoredResults.length
          : null;
        const caseOutcome = presentCaseOutcome(item);
        const query =
          item.query ||
          pickText(detail?.input, ["query", "question", "prompt", "input"]) ||
          item.example_id;
        const actual =
          pickText(detail?.output, ["response", "answer", "output", "actual_output", "text"]) ||
          (detail?.output ? JSON.stringify(detail.output, null, 2) : "");
        const expected =
          pickText(detail?.expected, [
            "response",
            "expected_response",
            "expected_output",
            "expected",
            "answer",
            "ground_truth",
            "reference",
          ]) || (detail?.expected ? JSON.stringify(detail.expected, null, 2) : "");

        const highlighted = highlightId === item.example_id;

        return (
          <div
            key={item.example_id}
            ref={
              highlighted
                ? (node) =>
                    node?.scrollIntoView({ block: "nearest", behavior: "smooth" })
                : undefined
            }
            className={cn(
              "overflow-hidden bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring",
              // A rule in the accent colour, on the row that earned attention.
              // Loud enough to find at a glance, quiet enough not to read as a
              // second verdict beside the OUTCOME column.
              highlighted && "border-s-2 border-evalai-green bg-evalai-green/[0.04]",
            )}
          >
            <button
              type="button"
              onClick={() => onToggle(item.example_id)}
              className="grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              aria-expanded={open}
            >
              <span className="flex size-8 items-center justify-center rounded-lg bg-muted font-mono text-xs font-medium text-muted-foreground">
                {String(item.sequence_position + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm font-medium leading-5">{query}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{item.metric_count} metrics</span>
                  <span aria-hidden="true">·</span>
                  <span className={cn(item.failing_count > 0 && "font-medium text-destructive")}>
                    {item.failing_count > 0 ? `${item.failing_count} failing` : "No failures"}
                  </span>
                  {/* Said plainly, and not in the failure's voice. A diagnostic
                      below its threshold is worth knowing about; it is not a
                      reason the case failed, and colouring it like one is how a
                      run came to read Pass while all ten of its cases read
                      Fail. */}
                  {(item.failing_optional_count ?? 0) > 0 ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>
                        {item.failing_optional_count} diagnostic
                        {item.failing_optional_count === 1 ? "" : "s"} below threshold
                      </span>
                    </>
                  ) : null}
                  {item.latency_ms != null ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{formatDuration(item.latency_ms)}</span>
                    </>
                  ) : null}
                  {avg != null ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className={cn("font-medium", scoreColor(avg * 100))}>
                        {(avg * 100).toFixed(1)}% avg
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
              <span className="flex items-center gap-2 pt-0.5">
                {caseOutcome.gate ? (
                  <GateBadge gate={caseOutcome.gate} size="sm" />
                ) : (
                  <span className="whitespace-nowrap text-[10px] font-medium text-muted-foreground">
                    {caseOutcome.label}
                  </span>
                )}
                {open ? (
                  <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                )}
              </span>
            </button>

            {open ? (
              <div className="space-y-4 border-t px-4 py-4">
                {detailLoading.has(item.example_id) && !detail ? (
                  <div role="status" className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-primary" aria-hidden="true" />
                    <span className="sr-only">Loading case evidence…</span>
                  </div>
                ) : detailError && !detail ? (
                  <div
                    role="alert"
                    className="space-y-3 rounded-lg border border-red-200 bg-red-50 px-4 py-4 text-sm dark:border-red-900 dark:bg-red-950/30"
                  >
                    <div>
                      <p className="font-medium text-red-800 dark:text-red-200">
                        We couldn&apos;t load this case&apos;s evidence
                      </p>
                      <p className="mt-1 text-xs leading-5 text-destructive">
                        {detailError}
                      </p>
                    </div>
                    {onRetryDetail ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onRetryDetail(item.example_id)}
                      >
                        Try again
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <div className="grid gap-3 md:grid-cols-2">
                      <OutputCard label="Actual output" text={actual || "Not captured for this run"} />
                      <ExpectedOutputCard
                        expected={detail?.expected ?? null}
                        plainText={expected || "Not captured for this run"}
                      />
                    </div>
                    <dl className="grid grid-cols-2 overflow-hidden rounded-lg border bg-muted/15 text-xs sm:grid-cols-4">
                      <EvidenceStat
                        label="Latency"
                        value={
                          formatDuration(detail?.execution?.latency_ms ?? item.latency_ms) ??
                          "Not captured"
                        }
                      />
                      <EvidenceStat
                        label="Judge tokens"
                        value={String(
                          detail?.scorer_results?.reduce(
                            (sum, row) => sum + (row.judge_total_tokens || 0),
                            0,
                          ) || "Not captured",
                        )}
                      />
                      <EvidenceStat
                        label="Evidence"
                        value={item.capture_state === "complete" ? "Complete" : item.capture_state === "partial" ? "Partial" : "Not recorded"}
                      />
                      <EvidenceStat
                        label="Trace"
                        mono={Boolean(detail?.execution?.trace_id)}
                        idKind={detail?.execution?.trace_id ? "trace" : undefined}
                        value={
                          detail?.execution?.trace_id
                            ? detail.execution.trace_id
                            : item.trace_available
                              ? detail
                                ? "Captured — ID not recorded"
                                : "Captured"
                              : "Not captured"
                        }
                      />
                    </dl>
                    <div className="overflow-hidden rounded-lg border">
                      <div className="flex items-center justify-between gap-3 bg-muted/30 px-3 py-2.5">
                        <p className="text-xs font-semibold">Scorer results</p>
                        <span className="text-[11px] text-muted-foreground">
                          {detail?.scorer_results?.length || 0} metrics
                        </span>
                      </div>
                      {(detail?.scorer_results || []).length === 0 ? (
                        <p className="border-t px-3 py-4 text-sm text-muted-foreground">
                          No judge scores captured for this case.
                        </p>
                      ) : (
                        <div className="divide-y">
                          {detail!.scorer_results.map((row) => (
                            <div
                              key={`${row.metric_id}-${row.row_id}`}
                              className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-medium capitalize">
                                  {metricDisplayName(row.metric_id)}
                                </p>
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                  {row.rationale || "No rationale captured."}
                                </p>
                              </div>
                              <div className="flex items-center justify-between gap-3 sm:justify-end">
                                <div className="text-right">
                                  <p className={cn("font-mono text-sm font-semibold tabular-nums", !metricHasVerdict(row) ? "text-muted-foreground" : scoreColor(row.normalised_score! * 100))}>
                                    {metricScoreLabel(row)}
                                  </p>
                                  <p className="text-[10px] tabular-nums text-muted-foreground">
                                    threshold {(row.threshold * 100).toFixed(0)}%
                                  </p>
                                </div>
                                {row.threshold_result && metricHasVerdict(row) ? <GateBadge gate={row.threshold_result} size="sm" /> : <span className="text-xs text-muted-foreground">—</span>}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
      {visibleItems.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          No cases match this filter.
        </p>
      ) : null}
      </div>
    </div>
  );
}

function EvidenceStat({
  label,
  value,
  mono = false,
  title,
  idKind,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
  idKind?: "run" | "trace";
}) {
  return (
    <div className="border-b px-3 py-2.5 odd:border-r sm:border-b-0 sm:border-r sm:last:border-r-0">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      {/* A trace id is only useful whole — it gets copied into a query or a
          log search — so the mono variant wraps instead of eliding. */}
      <dd
        title={title}
        className={`mt-1 items-center gap-1 font-medium text-foreground${idKind ? " flex" : ""}${mono ? " break-all font-mono text-[11px] leading-4" : " truncate"}`}
      >
        {value}{idKind ? <CopyIdButton value={value} kind={idKind} /> : null}
      </dd>
    </div>
  );
}


function OutputCard({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      <p className="whitespace-pre-wrap text-sm leading-6">{text}</p>
    </div>
  );
}

export function ExpectedOutputCard({
  expected,
  plainText,
}: {
  expected: Record<string, unknown> | null;
  plainText: string;
}) {
  const [showJson, setShowJson] = useState(false);
  const parsedPlainText = parseJson(plainText);
  const plainEnglish = parsedPlainText === null ? plainText : formatPlainEnglish(parsedPlainText);
  const jsonValue = expected ?? parsedPlainText ?? plainText;

  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Expected response
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          aria-pressed={showJson}
          onClick={() => setShowJson((visible) => !visible)}
        >
          {showJson ? "Response" : "JSON"}
        </Button>
      </div>
      {showJson ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border bg-background p-3 font-mono text-xs leading-5">
          {JSON.stringify(jsonValue, null, 2)}
        </pre>
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-6">{plainEnglish}</p>
      )}
    </div>
  );
}
