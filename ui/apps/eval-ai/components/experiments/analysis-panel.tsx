"use client";

import type { RunResult } from "@/lib/api";
import { cn } from "@evalai/shared/utils";
import { comparisonKey } from "@/lib/comparison-href";
import { isRunComplete } from "@/components/experiments-library";
import { assignRunDisplayLabels, dominantCohort, formatMeasureValue, measuresForRuns, type Measure, type AnalysisUrlState } from "@/lib/chart-data";
import { AccessibleChartFrame } from "@/components/charts/accessible-chart";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function isComparableCandidate(
  baseline: RunResult | null | undefined,
  candidate: RunResult,
): boolean {
  if (!baseline || baseline.run_id === candidate.run_id) return false;
  const baselineKey = comparisonKey(baseline);
  if (!baselineKey || !isRunComplete(baseline)) return false;
  return isRunComplete(candidate) && comparisonKey(candidate) === baselineKey;
}


/** Measures share the existing aggregation and unit formatting used by run charts. */
export function experimentMeasures(runs: RunResult[]): Measure[] {
  return measuresForRuns(runs).filter((measure) => measure.id !== "score" && measure.group !== "cases")
    .sort((a, b) => Number(!a.id.startsWith("metric:")) - Number(!b.id.startsWith("metric:")))
    .map((measure) => measure.group === "quality" && !measure.id.startsWith("metric:") ? { ...measure, label: `KPI composite · ${measure.label}` } : measure);
}

export function experimentMetricDelta(measure: Measure, run: RunResult, baseline: RunResult): string {
  if (run.run_id === baseline.run_id) return "Baseline";
  if (!isComparableCandidate(baseline, run)) return "Not comparable";
  const before = measure.value(baseline);
  const after = measure.value(run);
  if (before === null || after === null) return "Change unavailable";
  const delta = after - before;
  if (delta === 0) return "No change";
  const direction = delta > 0 ? "↑" : "↓";
  if (measure.group === "quality") return `${direction} ${Math.abs(delta * 100).toFixed(1)} pts vs baseline`;
  return `${direction} ${formatMeasureValue(measure, Math.abs(delta))} vs baseline`;
}

export function ExperimentAnalysisPanel({ name, runs, analysis, onAnalysisChange, baselineRunId, onBaselineChange }: {
  name: string;
  runs: RunResult[];
  analysis: AnalysisUrlState;
  onAnalysisChange: (patch: Partial<AnalysisUrlState>) => void;
  baselineRunId?: string;
  onBaselineChange?: (id: string) => void;
}) {
  const baseline = baselineRunId === undefined ? dominantCohort(runs).runs[0] : runs.find((run) => run.run_id === baselineRunId);
  const labels = assignRunDisplayLabels(runs);
  const cohort = [...runs].filter((run) => baseline && (run.run_id === baseline.run_id && isRunComplete(run) || isComparableCandidate(baseline, run)))
    .sort((a, b) => Date.parse(a.completed_at || a.started_at) - Date.parse(b.completed_at || b.started_at));
  const excluded = runs.filter((run) => !cohort.includes(run));
  const measures = experimentMeasures(cohort);
  const measure = measures.find((entry) => entry.id === analysis.kpi) ?? measures[0];
  const baselineValue = baseline && measure ? measure.value(baseline) : null;
  const data = cohort.map((run) => ({ run: labels.get(run.run_id) ?? run.run_id, value: measure?.value(run) ?? null }));
  const format = (value: number) => measure ? formatMeasureValue(measure, value) : String(value);
  const chartChildren = [
    <CartesianGrid key="grid" stroke="var(--border)" vertical={false} strokeDasharray="3 3" />,
    <XAxis key="x" dataKey="run" tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} interval={0} tickFormatter={(value: string) => value.length > 18 ? `${value.slice(0, 16)}…` : value} />,
    <YAxis key="y" domain={measure?.group === "quality" ? [0, 1] : [0, "auto"]} tickFormatter={format} width={76} tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} />,
    <Tooltip key="tooltip" formatter={(value) => typeof value === "number" ? format(value) : "Not recorded"} contentStyle={{ background: "var(--card)", borderColor: "var(--border)", color: "var(--foreground)" }} />,
    ...(baselineValue !== null ? [<ReferenceLine key="baseline" y={baselineValue} stroke="var(--muted-foreground)" strokeDasharray="5 4" />] : []),
  ];
  return <section aria-label={`Analysis for ${name}`} className="space-y-4 px-5 py-4">
    <div className="flex flex-wrap items-end gap-4">
      <label className="grid gap-1 text-sm"><span className="text-muted-foreground">Baseline</span><select aria-label="Analysis baseline" value={baseline?.run_id ?? ""} disabled={!onBaselineChange} onChange={(event) => onBaselineChange?.(event.target.value)} className="h-10 max-w-64 rounded-lg border bg-background px-3 focus-visible:ring-2 focus-visible:ring-ring"><option value="" disabled>Choose a completed run</option>{runs.filter((run) => isRunComplete(run) && comparisonKey(run)).map((run) => <option key={run.run_id} value={run.run_id}>{labels.get(run.run_id)}</option>)}</select></label>
      <label className="grid gap-1 text-sm"><span className="text-muted-foreground">Metric</span><select aria-label="Analysis metric" value={measure?.id ?? ""} disabled={!measure} onChange={(event) => onAnalysisChange({ kpi: event.target.value })} className="h-10 max-w-72 rounded-lg border bg-background px-3 focus-visible:ring-2 focus-visible:ring-ring">{!measure ? <option value="">No measurements recorded</option> : null}{measures.map((entry) => <option key={entry.id} value={entry.id}>{entry.id.startsWith("kpi:") ? `KPI composite · ${entry.label}` : entry.label}{entry.group === "ops" ? " · operational" : ""}</option>)}</select></label>
      <div role="group" aria-label="Analysis view" className="ml-auto flex rounded-lg bg-muted/60 p-1">{([["chart", "Compare variants"], ["trend", "Over iterations"]] as const).map(([view, label]) => <button key={view} type="button" aria-pressed={(analysis.view === "trend" ? "trend" : "chart") === view} onClick={() => onAnalysisChange({ view })} className={cn("min-h-10 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", (analysis.view === "trend" ? "trend" : "chart") === view ? "bg-brand-purple-soft text-brand-text" : "text-muted-foreground")}>{label}</button>)}</div>
    </div>
    <p className="text-sm text-muted-foreground">{cohort.length} of {runs.length} runs comparable to {baseline ? labels.get(baseline.run_id) : "the baseline"}. The dashed line marks its value. Inspect individual cases to understand the differences.</p>
    {excluded.length ? <details><summary className="cursor-pointer rounded text-sm text-state-caution focus-visible:ring-2 focus-visible:ring-ring">{excluded.length} runs excluded from this chart</summary><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{excluded.map((run) => <li key={run.run_id}>{labels.get(run.run_id)} — {isRunComplete(run) ? "Different or missing comparison basis" : `Run ${run.status || "not completed"}`}</li>)}</ul></details> : null}
    {measure && cohort.length ? <AccessibleChartFrame title={`${measure.label} across runs`} summary={analysis.view === "trend" ? "Runs in completion order. Lines show observed iterations, not a forecast; missing values remain gaps." : "Compare variants using the metric’s native values."} columns={["Run", measure.label, "Change from baseline"]} rows={cohort.map((run) => ({ key: run.run_id, values: [labels.get(run.run_id) ?? run.run_id, formatMeasureValue(measure, measure.value(run)), baseline ? experimentMetricDelta(measure, run, baseline) : "No baseline"] }))} visuallyHideTable className="rounded-none border-0 p-0">
      <div className="overflow-x-auto"><div style={{ height: 280, minWidth: Math.max(480, cohort.length * 90) }}><ResponsiveContainer width="100%" height="100%">{analysis.view === "trend" ? <LineChart data={data} margin={{ top: 12, right: 20, bottom: 8, left: 0 }}>{chartChildren}<Line dataKey="value" name={measure.label} stroke="var(--series-1)" strokeWidth={2} dot={{ r: 4 }} connectNulls={false} isAnimationActive={false} /></LineChart> : <BarChart data={data} margin={{ top: 12, right: 20, bottom: 8, left: 0 }}>{chartChildren}<Bar dataKey="value" name={measure.label} fill="var(--series-1)" maxBarSize={56} isAnimationActive={false} /></BarChart>}</ResponsiveContainer></div></div>
    </AccessibleChartFrame> : <p role="status" className="py-8 text-center text-muted-foreground">No comparable measurements recorded. Add a completed run or choose another baseline.</p>}
    {measure?.group === "quality" ? <p className="text-xs text-muted-foreground">Averages use recorded scores; case coverage may differ. Inspect cases before treating a difference as an improvement.</p> : null}
  </section>;
}
