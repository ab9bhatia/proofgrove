"use client";

import Link from "next/link";
import { AnnotationChip } from "@/components/tracing/annotation-chip";
import { ApiError } from "@/lib/api-errors";
import type { RunConfigurationSnapshot } from "@/lib/api";
import { useEffect, useRef, useState } from "react";
import { api, evaluationApi, spanScoringApi, type SpanScoreJob, type SpanScorePreview, type SpanScoreSelection } from "@/lib/api";
import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { groupByMetricFamily, metricDisplayName, nativeMetricValue } from "@/components/report/lib";
import { inputClass } from "@/components/evaluation/form-primitives";

export function SpanScoring({ projectId, selections, toolbar = false, annotationSummary = false }: { projectId: string; selections: SpanScoreSelection[]; toolbar?: boolean; annotationSummary?: boolean }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<SpanScorePreview | null>(null);
  const [tenant, setTenant] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [metrics, setMetrics] = useState<string[]>([]);
  const [expected, setExpected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewStale, setPreviewStale] = useState(false);
  const [showUnsupported, setShowUnsupported] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [job, setJob] = useState<SpanScoreJob | null>(null);
  const [history, setHistory] = useState<SpanScoreJob[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const firstField = useRef<HTMLSelectElement>(null);
  const first = selections[0];

  useEffect(() => {
    if (!first || selections.length !== 1 || toolbar || projectId === "unassigned") return;
    let active = true;
    api.tenant().then(async ({ tenant_id }) => {
      const result = await spanScoringApi.history(projectId, tenant_id, first.trace_id, first.span_id);
      if (active) { setHistory(result.jobs); setHistoryError(null); }
    }).catch((reason) => { if (active) setHistoryError(reason instanceof Error ? reason.message : "Scores could not be loaded."); }).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [projectId, first, selections.length, refresh, toolbar]);

  useEffect(() => {
    if (!job || !["pending", "running"].includes(job.status)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      spanScoringApi.job(projectId, tenant, job.job_id).then((result) => {
        if (active) { setJob(result); setRefresh((value) => value + 1); }
      }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Could not refresh scoring progress."); });
    }, 2500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [job, projectId, tenant, refresh]);

  useEffect(() => {
    if (!history.some((saved) => ["pending", "running"].includes(saved.status))) return;
    const timer = window.setTimeout(() => setRefresh((value) => value + 1), 2500);
    return () => window.clearTimeout(timer);
  }, [history]);

  async function loadPreview() {
    setBusy(true); setError(null);
    try {
      const { tenant_id } = await api.tenant();
      const selected = selections.map((item) => ({ ...item, expected_response: selections.length === 1 ? expected || null : item.expected_response }));
      const [result, catalogue] = await Promise.all([spanScoringApi.preview(projectId, tenant_id, selected), evaluationApi.listJudgeModels().catch(() => ({ models: [] as string[] }))]);
      setTenant(tenant_id); setPreview(result); setModels(catalogue.models);
      setPreviewStale(false);
      setModel((value) => catalogue.models.includes(value) ? value : catalogue.models[0] || "");
      setMetrics((values) => values.filter((id) => result.items.every((item) => item.checks.some((check) => check.metric_id === id && check.available))));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Evidence preview could not be loaded."); }
    finally { setBusy(false); }
  }

  async function start() {
    if (!preview) return;
    setBusy(true); setError(null);
    const body = {
      spans: preview.items.map((item) => ({ trace_id: item.trace_id, span_id: item.span_id, expected_response: item.expected_response })),
      preview_hash: preview.preview_hash, metric_ids: metrics, judge_model: model,
    };
    const signature = JSON.stringify(body);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    try { setJob(await spanScoringApi.start(projectId, tenant, { ...body, request_id: request.current.id })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Scoring could not start. Retry this submission."); }
    finally { setBusy(false); }
  }

  const allChecks = preview?.items[0]?.checks ?? [];
  const checks = showUnsupported ? allChecks : allChecks.filter((check) => !preview?.items.some((item) => item.checks.find((entry) => entry.metric_id === check.metric_id)?.unavailable_reason === "This check does not support the recorded span type."));
  const needsJudge = metrics.some((id) => !id.startsWith("ops."));
  const pending = [job, ...history].some((saved) => saved && ["pending", "running"].includes(saved.status));
  const latestResults = new Map<string, SpanScoreJob["results"][number]>();
  for (const saved of [job, ...history]) {
    for (const result of saved?.results ?? []) {
      const key = `${result.trace_id}:${result.span_id}:${result.metric_id}`;
      if (!latestResults.has(key)) latestResults.set(key, result);
    }
  }
  const visibleResults = [...latestResults.values()].filter(result =>
    (!result.metric_status || result.metric_status === "scored") && result.score != null,
  );
  if (projectId === "unassigned") return <p className="p-3 text-sm text-muted-foreground">Span scoring requires a project.</p>;
  return <div className={toolbar || annotationSummary ? "" : "border-t px-4 py-3"}>
    <div className="flex items-center justify-between gap-3">
      {!toolbar ? <h4 className="text-sm font-medium">{annotationSummary ? "This span" : "Span scores"}</h4> : null}
      {annotationSummary ? <Button size="sm" variant="ghost" onClick={() => setRefresh((value) => value + 1)}>Refresh scores</Button> : null}
      {!annotationSummary ? <Button size="sm" variant="outline" disabled={!selections.length} onClick={() => { if (!pending) { setJob(null); request.current = null; } setOpen(true); void loadPreview(); }}>{pending ? "View scoring progress" : `Score ${selections.length === 1 ? "span" : `${selections.length} spans`}`}</Button> : null}
    </div>
    {history.find(saved => saved.status === "failed") ? <p role="alert" className="mt-2 text-sm text-destructive">A scoring attempt failed. {history.find(saved => saved.status === "failed")?.error || "No result was saved for that attempt."}</p> : null}
    {historyError ? <p role="alert" className="mt-2 text-sm text-destructive">{historyError} <button className="underline" onClick={() => setRefresh((value) => value + 1)}>Retry</button></p> : null}
    {!toolbar && (!visibleResults.length ? <p className="mt-2 text-sm text-muted-foreground">{pending ? "Scoring is in progress." : historyLoading ? "Loading span scores…" : historyError ? "" : "No saved span scores."}</p> : <ul className="mt-3 flex flex-wrap gap-2">
      {visibleResults.map((result) => <li key={`${result.trace_id}:${result.span_id}:${result.metric_id}`} className="min-w-0 max-w-full">
        <AnnotationChip metricId={result.metric_id} name={metricDisplayName(result.metric_id)} value={result.score == null ? result.metric_status || "Unavailable" : `${nativeMetricValue(result.metric_id, result.score) ?? (result.normalised_score == null ? result.score : `${(result.normalised_score * 100).toFixed(1)}%`)}${result.threshold_result ? ` · ${result.threshold_result}` : ""}`} explanation={result.rationale || result.error_message} evaluator={result.judge_model || result.executed_scorer} />
      </li>)}
    </ul>)}
    {open ? <Dialog variant="modal" labelledBy="span-scoring-title" describedBy="span-scoring-hint" onClose={() => setOpen(false)} initialFocusRef={firstField} scrimLabel="Close span scoring" width="w-[min(64rem,calc(100vw-2rem))]">
      <div className="border-b px-6 py-5"><h2 id="span-scoring-title" className="font-display text-xl font-semibold">Score {selections.length === 1 ? "this span" : `${selections.length} spans`}</h2><p id="span-scoring-hint" className="mt-2 text-sm text-muted-foreground">Review the captured evidence and choose checks for these operations. Results are saved on the spans.</p></div>
      <div className="grid max-h-[65vh] gap-6 overflow-y-auto p-6 md:grid-cols-[minmax(0,1.2fr)_minmax(16rem,1fr)]">
        <section aria-label="Evidence preview" className="min-w-0 space-y-4">
          {busy && !preview ? <p role="status">Loading captured evidence…</p> : null}
          {preview?.items.map((item) => <details key={`${item.trace_id}:${item.span_id}`} open={preview.items.length === 1} className="rounded-lg border p-3">
            <summary className="cursor-pointer break-words text-sm font-medium">{item.name} · {item.span_kind || "Type not recorded"}</summary>
            <dl className="mt-3 space-y-3 text-sm">{[["Input", item.input], ["Output", item.output], ...(item.context?.length ? [["Retrieved documents", item.context.join("\n\n")]] : [])].map(([label, text]) => <div key={label}><dt className="font-medium">{label}</dt><dd className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words leading-6 text-muted-foreground">{text || "Not captured"}</dd></div>)}</dl>
          </details>)}
          {selections.length === 1 ? <div><label htmlFor="span-expected" className="text-sm font-medium">Expected response (optional)</label><textarea id="span-expected" className={`${inputClass} mt-2 min-h-24 w-full`} value={expected} maxLength={16384} disabled={!!job} onChange={(event) => { setExpected(event.target.value); setPreviewStale(true); }} /><p className="mt-1 text-xs text-muted-foreground">Write the expected output for this span. The case expectation is not used.</p><Button className="mt-2" variant="outline" size="sm" disabled={busy || !!job} onClick={() => void loadPreview()}>Update preview</Button></div> : null}
        </section>
        <section aria-label="Scoring checks" className="space-y-4">
          {needsJudge ? <div><label htmlFor="span-judge" className="text-sm font-medium">Judge model</label><select id="span-judge" ref={firstField} className={`${inputClass} mt-2 h-11 w-full`} value={model} disabled={!!job} onChange={(event) => setModel(event.target.value)}><option value="">Choose a model</option>{models.map((value) => <option key={value} value={value}>{value}</option>)}</select>{!models.length ? <p className="mt-1 text-sm text-muted-foreground">Judge models are unavailable. Recorded measurements can still be saved.</p> : null}</div> : null}
          {allChecks.length > checks.length || showUnsupported ? <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={showUnsupported} onChange={(event) => setShowUnsupported(event.target.checked)} />Show unsupported checks</label> : null}
          <fieldset disabled={!!job}><legend className="mb-2 text-sm font-medium">Checks</legend><div className="space-y-4">{groupByMetricFamily(checks, (check) => check.metric_id).map((group) => <div key={group.prefix}><h3 className="border-b pb-2 text-sm font-medium text-brand-text">{group.label}</h3>{group.items.map((check) => {
            const unavailable = preview?.items.find((item) => !item.checks.some((entry) => entry.metric_id === check.metric_id && entry.available));
            const reason = unavailable?.checks.find((entry) => entry.metric_id === check.metric_id)?.unavailable_reason;
            return <label key={check.metric_id} className="flex min-h-11 items-start gap-3 py-3 text-sm"><input type="checkbox" className="mt-1 size-4 accent-primary" disabled={!!unavailable} checked={metrics.includes(check.metric_id)} onChange={(event) => setMetrics((values) => event.target.checked ? [...values, check.metric_id] : values.filter((value) => value !== check.metric_id))} /><span><span className="font-medium">{check.name}</span><span className="mt-1 block leading-5 text-muted-foreground">{reason || check.description}</span></span></label>;
          })}</div>)}</div></fieldset>
          {job ? <div className="space-y-2"><p role="status" className="text-sm">Scoring: {job.status}{job.error ? ` — ${job.error}` : ""}</p>{job.status === "completed" ? <p className="text-sm text-muted-foreground">Saved {job.results.length} results. Close this dialog to inspect the span scores{toolbar ? " on each selected span" : " below"}.</p> : null}</div> : null}
          {error ? <div role="alert" className="text-sm text-destructive"><p>{error}</p><Button variant="outline" size="sm" onClick={() => job ? setRefresh((value) => value + 1) : void loadPreview()}>Retry refresh</Button></div> : null}
        </section>
      </div>
      <div className="flex justify-end gap-2 border-t px-6 py-4"><Button variant="outline" onClick={() => setOpen(false)}>Close</Button>{!job ? <Button disabled={busy || !preview || previewStale || (metrics.some((id) => !id.startsWith("ops.")) && !model) || !metrics.length} onClick={() => void start()}>{busy ? "Starting…" : `Score ${selections.length} ${selections.length === 1 ? "span" : "spans"}`}</Button> : null}</div>
    </Dialog> : null}
  </div>;
}

export function AutomaticSpanScoringStatus({ runId }: { runId: string }) {
  const [configuration, setConfiguration] = useState<RunConfigurationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    api.tenant().then(({ tenant_id }) => evaluationApi.getRunConfiguration(runId, tenant_id)).then((value) => {
      if (active) { setConfiguration(value); setError(null); }
    }).catch((reason) => {
      if (active && !(reason instanceof ApiError && reason.status === 404)) setError("Span scoring status could not be loaded.");
    });
    return () => { active = false; };
  }, [runId, refresh]);
  if (!configuration?.span_scoring_enabled && !error) return null;
  const counts = configuration?.span_scoring_counts ?? {};
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return <section aria-label="Automatic span scoring" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm">
    <div className="min-w-0">
      {error ? <p role="alert" className="text-destructive">{error}</p> : <p className="text-muted-foreground">{total ? `${counts.completed ?? 0} completed, ${(counts.pending ?? 0) + (counts.running ?? 0)} in progress, ${(counts.failed ?? 0) + (counts.cancelled ?? 0) + (counts.blocked ?? 0)} stopped or failed.` : "No span scores yet. Full execution checks run when matching operations reach the archive."} Missing recorded span types cannot be matched. Case scores are unchanged.</p>}
    </div>
    <div className="flex items-center gap-3"><Button size="sm" variant="outline" onClick={() => setRefresh((value) => value + 1)}>Refresh span status</Button>
      {configuration?.project_id ? <Link className="inline-flex min-h-11 items-center text-brand-text underline" href={`/projects/${encodeURIComponent(configuration.project_id)}/traces?run_id=${encodeURIComponent(runId)}`}>View spans in Tracing</Link> : null}
    </div>
  </section>;
}
