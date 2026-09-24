"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { RunOutcomeBadge } from "@/components/run-outcome-badge";
import { runDetailsHref } from "@/lib/run-recommendation";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { RefreshCw } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccessibleChartFrame } from "@/components/charts/accessible-chart";
import { BarList } from "@/components/bar-list";
import { FilterTabs } from "@/components/filter-tabs";
import { EmptyState, ErrorState, LoadingState } from "@/components/page-state";
import { api, evaluationApi, type UsageOverview, type RunResult } from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import {
  USAGE_WINDOWS, type UsageWindow, type UsageDelta, costDelta, costLabel, deltaFor,
  failureRateDelta, failureRatePercent, tokensLabel, usageChartRows, usageTableRows, usdLabel,
} from "@/lib/usage";

const TABLE_COLUMNS = ["Bucket (UTC)", "Runs", "Failed launches", "Cases", "p50 ms", "p90 ms", "Input tokens", "Output tokens", "Est. cost", "Failure rate"];
const CHART_STYLE = "panel min-w-0 p-5 sm:p-6";
const TOOLTIP_STYLE = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)" };

function Headline({ value, delta }: { value: string; delta?: UsageDelta | null }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="font-display text-3xl font-medium tracking-tight text-foreground tabular-nums">{value}</span>
      {delta ? <span className="text-xs tabular-nums">{delta.text} · vs {delta.previousLabel} previous period</span> : null}
    </span>
  );
}

export function UsageDashboard({ qualityRuns = [], attention }: { qualityRuns?: RunResult[]; attention?: ReactNode }) {
  const [window_, setWindow] = useState<UsageWindow>("30d");
  const [model, setModel] = useState("");
  const [usage, setUsage] = useState<UsageOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    let stale = false;
    const id = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void api.tenant()
        .then(({ tenant_id }) => evaluationApi.getUsage(tenant_id, { window: window_, targetModel: model || null }))
        .then((next) => { if (!stale) { setUsage(next); setUpdatedAt(new Date()); } })
        .catch((reason) => { if (!stale) setError(userFacingError(reason, "Could not load evaluation activity.")); })
        .finally(() => { if (!stale) setLoading(false); });
    }, 0);
    return () => { stale = true; window.clearTimeout(id); };
  }, [window_, model, reloadKey]);

  const qualityByRun = new Map(qualityRuns.map((run) => [run.run_id, run]));
  const recentRuns = usage?.recent_runs.slice(0, 5) ?? [];
  const totals = usage?.totals;
  const previous = usage?.previous_totals;
  const rows = usage ? usageChartRows(usage.days, usage.bucket) : [];
  const tableRows = usage ? usageTableRows(usage.days) : [];
  const failureRate = totals ? failureRatePercent(totals) : null;
  const hasTokens = Boolean(totals && (totals.prompt_measured_cases > 0 || totals.completion_measured_cases > 0));
  const totalTokens = totals ? totals.prompt_tokens + totals.completion_tokens : 0;
  const windowNoun = usage?.bucket === "hour" ? "hour" : "day";
  const frame = (indices: number[]) => ({
    columns: indices.map((index) => TABLE_COLUMNS[index]),
    rows: tableRows.map((row, index) => {
      const rate = rows[index].failureRate;
      const values = [...row.values, rate === null ? "—" : `${rate}%`];
      return { ...row, values: indices.map((column) => values[column]) };
    }),
    visuallyHideTable: true,
    className: CHART_STYLE,
  });
  const axis = { tick: { fontSize: 11, fill: "var(--muted-foreground)" }, axisLine: false, tickLine: false };

  return (
    <section aria-labelledby="activity-title">
      <div className="mb-4"><h2 id="activity-title" className="text-lg font-semibold">Activity and usage</h2><p className="mt-1 text-sm text-muted-foreground">Filter the activity below by time and target model. Evaluation traffic only; other agent activity is not included.</p></div>
      <div className="panel mb-6 flex flex-wrap items-center justify-between gap-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-3">
          <FilterTabs options={[...USAGE_WINDOWS]} value={window_} onChange={(value) => setWindow(value as UsageWindow)} label="Time window" />
          <Select value={model || "all"} onValueChange={(value) => setModel(value === "all" ? "" : value)}>
            <SelectTrigger size="sm" aria-label="Filter by target model" className="w-56"><SelectValue placeholder="All target models" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All target models</SelectItem>
              {[...new Set([...(usage?.models ?? []), ...(model ? [model] : [])])].map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">UTC</span>
        </div>
        <div className="flex items-center gap-2">
          {updatedAt ? <span className="text-xs text-muted-foreground">Updated {updatedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC</span> : null}
          <Button variant="outline" size="sm" disabled={loading} onClick={() => setReloadKey((key) => key + 1)}><RefreshCw className="size-3.5" aria-hidden />Refresh</Button>
        </div>
      </div>

      {loading ? <LoadingState label="Loading evaluation activity…" /> : error ? (
        <ErrorState message={error} onRetry={() => setReloadKey((key) => key + 1)} />
      ) : usage && totals && totals.runs === 0 && totals.failed_runs === 0 && usage.top_datasets.rows.length === 0 ? (
        <EmptyState title="No evaluation activity in this window" description="Widen the time window, choose another model, or run an evaluation." />
      ) : usage && totals ? (
        <div className="flex flex-col gap-6">
          <AccessibleChartFrame {...frame([0, 1])} title="Evaluation runs"
            description={<Headline value={totals.runs.toLocaleString("en-US")} delta={previous ? deltaFor(totals.runs, previous.runs) : null} />}
            summary={`${totals.cases.toLocaleString("en-US")} recorded cases · runs by start ${windowNoun}. Failed launches are shown separately below.`}>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis dataKey="date" {...axis} minTickGap={45} /><YAxis {...axis} allowDecimals={false} width={45} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Line dataKey="runs" name="Runs" stroke="var(--series-1)" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 5 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </AccessibleChartFrame>

          <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
            <AccessibleChartFrame {...frame([0, 2, 9])} title="Launch failure rate"
              description={<Headline value={failureRate === null ? "No data" : `${failureRate}%`} delta={previous ? failureRateDelta(totals, previous) : null} />}
              summary={`${totals.failed_runs} failed or blocked launches out of ${totals.runs + totals.failed_runs} recorded runs and failed launches. Evaluation scores are separate.`}>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={rows}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="date" {...axis} minTickGap={45} /><YAxis {...axis} unit="%" width={50} domain={[0, "auto"]} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value) => [`${value}%`, "Launch failure rate"]} />
                  <Line dataKey="failureRate" name="Launch failure rate" stroke="var(--gate-fail)" strokeWidth={2} connectNulls={false} dot={{ r: 2 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </AccessibleChartFrame>

            <AccessibleChartFrame {...frame([0, 4, 5])} title="Case latency"
              description={<Headline value={totals.latency_ms_p50 === null ? "No data" : `${totals.latency_ms_p50} / ${totals.latency_ms_p90} ms`} />}
              summary="Median (p50) and slowest-decile boundary (p90) of recorded target execution latency. Missing measurements leave gaps.">
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={rows}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="date" {...axis} minTickGap={45} /><YAxis {...axis} width={55} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} /><Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                  <Line dataKey="p50" name="p50 · ms" stroke="var(--series-1)" strokeWidth={2} connectNulls={false} dot={{ r: 2 }} isAnimationActive={false} />
                  <Line dataKey="p90" name="p90 · ms" stroke="var(--series-2)" strokeDasharray="5 3" strokeWidth={2} connectNulls={false} dot={{ r: 2 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </AccessibleChartFrame>

            <AccessibleChartFrame {...frame([0, 6, 7])} title="Recorded target tokens"
              description={<Headline value={hasTokens ? tokensLabel(totalTokens) : "No data"} />}
              summary={`${totals.prompt_measured_cases} of ${totals.cases} cases report input tokens; ${totals.completion_measured_cases} report output tokens. Judge usage is not included.`}>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={rows}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="date" {...axis} minTickGap={45} /><YAxis {...axis} tickFormatter={tokensLabel} width={55} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} /><Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                  <Line dataKey="prompt" name="Input tokens" stroke="var(--series-1)" strokeWidth={2} connectNulls={false} dot={{ r: 2 }} isAnimationActive={false} />
                  <Line dataKey="completion" name="Output tokens" stroke="var(--series-2)" strokeDasharray="5 3" strokeWidth={2} connectNulls={false} dot={{ r: 2 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </AccessibleChartFrame>

            <AccessibleChartFrame {...frame([0, 8])} title="Estimated target cost · list rates"
              description={<Headline value={costLabel(totals) ?? "Unavailable"} delta={previous && totals.unpriced_cases === 0 && previous.unpriced_cases === 0 ? costDelta(totals, previous) : null} />}
              summary={`USD estimate for recorded target tokens, excluding judge usage. ${totals.unpriced_cases > 0 ? `${totals.unpriced_cases} of ${totals.cases} cases could not be priced; the estimate is partial.` : "Not a bill or invoiced spend."}`}>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={rows}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="date" {...axis} minTickGap={45} /><YAxis {...axis} width={70} tickFormatter={(value: number) => usdLabel(value) ?? "—"} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value) => [usdLabel(Number(value)), "List-rate estimate"]} />
                  <Line dataKey="cost" name="Estimated cost" stroke="var(--series-1)" strokeWidth={2} connectNulls={false} dot={{ r: 2 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </AccessibleChartFrame>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <BarList title="Models by cases · select to filter" onSelect={setModel} rows={usage.top_models.rows.map((row) => ({
              key: row.name, label: row.name, value: row.cases, valueLabel: `${row.cases} cases`,
              secondaryLabel: `${usdLabel(row.estimated_cost_usd) ?? "Cost unavailable"}${row.unpriced_cases > 0 ? ` · ${row.unpriced_cases} unpriced` : " · est."}`,
            }))} others={usage.top_models.others} />
            <section id="failed-launches" className="panel scroll-mt-6 p-4" aria-labelledby="failed-launches-title">
              <h2 id="failed-launches-title" className="text-sm font-semibold">Failed launches</h2>
              <p className="mt-1 text-xs text-muted-foreground">Open a launch to inspect its error and execution details.</p>
              {usage.failed_launches.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No failed launches in this selection.</p> : (
                <ul className="mt-3 divide-y divide-border">
                  {usage.failed_launches.map((run) => <li key={run.run_id} className="py-3">
                    <Link href={runDetailsHref(run.run_id)} className="block rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{run.name} →</Link>
                    <p className="mt-1 text-xs text-muted-foreground">{run.status} · {run.started_at.slice(0, 16).replace("T", " ")} UTC · {run.model ?? "Model not recorded"}</p>
                  </li>)}
                </ul>
              )}
              {totals.failed_runs > usage.failed_launches.length ? <p className="mt-2 text-xs text-muted-foreground">Latest {usage.failed_launches.length} of {totals.failed_runs} failed launches.</p> : null}
            </section>
          </div>
          <p className="text-xs text-muted-foreground">Activity charts and recent runs follow the selected time window and target model. Recorded measurements do not establish complete capture.</p>
        </div>
      ) : null}
      <div className="mt-6 grid items-start gap-6 xl:grid-cols-2">
        {attention}
        <section className="panel flex h-[26rem] min-w-0 flex-col overflow-hidden" aria-labelledby="recent-runs-title">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div><h2 id="recent-runs-title" className="text-base font-semibold">Recent recorded runs</h2><p className="mt-1 text-xs text-muted-foreground">{loading ? "Loading runs…" : error ? "Run activity unavailable." : `Latest ${recentRuns.length} of ${totals?.runs ?? 0} in the selected time window and model.`}</p></div>
            <Link href="/evaluations" className="shrink-0 text-xs font-medium text-brand-text hover:underline">All run history →</Link>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" tabIndex={0} role="region" aria-label="Recent run records">
          {!loading && !error && recentRuns.length > 0 ? (
            <ul className="divide-y divide-border">
              {recentRuns.map((run) => <li key={run.run_id}>
                <Link href={runDetailsHref(run.run_id)} className="flex min-h-16 items-center justify-between gap-4 px-5 py-3 hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <span className="min-w-0"><span className="block truncate text-sm font-medium">{run.name} →</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{run.model ?? "Model not recorded"} · {run.started_at.slice(0, 16).replace("T", " ")} UTC · {run.status}</span></span>
                  <span className="shrink-0">{qualityByRun.has(run.run_id) ? <RunOutcomeBadge run={qualityByRun.get(run.run_id)!} /> : <span className="text-xs text-muted-foreground">See report</span>}</span>
                </Link>
              </li>)}
            </ul>
          ) : !loading && !error ? <p className="px-5 py-4 text-sm text-muted-foreground">No recorded runs in this selection.</p> : null}
          </div>
        </section>
      </div>
    </section>
  );
}
