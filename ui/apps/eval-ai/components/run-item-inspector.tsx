"use client";

import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { datasetVersionLabel } from "@/lib/dataset-lineage";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { cn } from "@evalai/shared/utils";
import { userFacingError } from "@/lib/api-errors";
import {
  api,
  evaluationApi,
  platformApi,
  type EvaluationScope,
  type GateResult,
  type Finding,
  type JudgeAgreement,
  type KpiResult,
  type MetricResult,
  type RunItemDetail,
  type RunItemTraceEvidence,
  type ToolResultArtifactReference,
} from "@/lib/api";
import { SpanDetailPane } from "@/components/tracing/span-detail-pane";
import { SelectedAnnotationSummary } from "@/components/tracing/case-annotation";
import { semanticSpanKind } from "@/components/tracing/span-tree";
import { SpanTreePane } from "@/components/tracing/span-tree-pane";
import { CaptureBand } from "@/components/tracing/capture-band";
import { CopyIdButton } from "@/components/copyable-id";
import { JudgeAgreementNote } from "@/components/judge-agreement-note";
import {
  inspectorLayout,
  resolveSelectedSpanId,
  traceEvidenceWarnings,
  traceSpanEmptyMessage,
} from "@/components/tracing/trace-workspace";
import {
  evidenceDepthNotCapturedCopy,
  evidenceDepthNotConfiguredCopy,
  evidenceDepthNotRecordedCopy,
} from "@/components/evaluation/scope-selector";
import {
  isAgentOutputTooLarge,
  oversizedDiagnosticsFromOutput,
  oversizedOutputDescription,
  oversizedOutputReceivedLabel,
  oversizedOutputTitle,
} from "@/lib/invocation-errors";
import { EvidenceMarkdown } from "./evidence-markdown";
import { GateBadge } from "./gate-badge";
import { kpiLabel } from "./kpi-scorecard";
import { attentionLabel, groupByMetricFamily, isMeasurement, nativeMetricValue } from "@/components/report/lib";
import { formatDuration } from "@/lib/format-duration";

import { validSpanId, validTraceId } from "@/lib/trace-identity";

const NOT_CAPTURED = "Not captured for this run";

type InspectorSection = "answer" | "context" | "scores" | "trace" | "execution";

const SECTIONS: Array<{ id: InspectorSection; label: string }> = [
  { id: "answer", label: "Answer" },
  { id: "context", label: "Context & tools" },
  { id: "scores", label: "Scores" },
  { id: "trace", label: "Trace" },
  { id: "execution", label: "Execution" },
];

function TraceEvidencePanel({ item, projectId }: { item: RunItemDetail; projectId?: string | null }) {
  const traceId = validTraceId(item.execution.trace_id);
  const [trace, setTrace] = useState<RunItemTraceEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!traceId) return;
    setLoading(true);
    setError(null);
    void api.tenant()
      .then(({ tenant_id }) => evaluationApi.getRunItemTrace(item.run_id, item.example_id, tenant_id))
      .then(setTrace)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  }, [item.run_id, item.example_id, traceId]);

  useEffect(() => {
    const timer = window.setTimeout(load, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (!traceId) return <EmptyEvidence>No valid trace ID was recorded for this case.</EmptyEvidence>;
  if (loading) return <EmptyEvidence>Loading archived trace evidence…</EmptyEvidence>;
  if (error) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm dark:border-red-800 dark:bg-red-950">
        <p className="text-destructive">{error}</p>
        <button type="button" onClick={load} className="mt-3 rounded border bg-background px-3 py-1.5 text-xs font-medium">Retry</button>
      </div>
    );
  }
  if (!trace) return <EmptyEvidence>No archived trace evidence is available.</EmptyEvidence>;
  return <TraceEvidenceView evidence={trace} item={item} projectId={projectId} onRefresh={load} />;
}

/**
 * Presentational half of the trace tab: renders archived spans through the
 * same tree/detail panes as the full trace inspector, so the two surfaces
 * cannot disagree about what was captured.
 */
export function TraceEvidenceView({
  evidence,
  item,
  projectId,
  onRefresh,
}: {
  evidence: RunItemTraceEvidence;
  item: RunItemDetail;
  projectId?: string | null;
  onRefresh: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (evidence.state !== "available") {
    return (
      <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
        <p>{evidence.message || "No archived trace evidence is available."}</p>
        {evidence.state === "pending" ? (
          <button type="button" onClick={onRefresh} className="mt-3 rounded border bg-background px-3 py-1.5 text-xs font-medium text-foreground">Refresh</button>
        ) : null}
      </div>
    );
  }

  if (!validTraceId(evidence.trace_id)) {
    return <EmptyEvidence>No valid archived trace ID is available for this case.</EmptyEvidence>;
  }

  const layout = inspectorLayout("flow");
  // The CaptureBand below owns incompleteness disclosure; the panes keep the
  // neutral empty message so one archive message cannot render three times.
  const emptyMessage = traceSpanEmptyMessage(null, null);
  const aiSpans = evidence.spans.filter((span) => semanticSpanKind(span) !== null);
  const effectiveSelected = resolveSelectedSpanId(selectedId ? evidence.spans : aiSpans, selectedId);
  const selected = evidence.spans.find((span) => span.span_id === effectiveSelected) ?? null;

  const traceIdForLink = validTraceId(evidence.trace_id) ?? validTraceId(item.execution.trace_id);
  const traceIdLabel = validTraceId(evidence.trace_id) ?? "—";
  const projectsHref =
    projectId && traceIdForLink
      ? `/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceIdForLink)}`
      : null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <span><strong>{aiSpans.length}</strong> AI operations</span>
          {validTraceId(evidence.trace_id) ? (
            <span className="inline-flex items-center gap-1 font-mono text-muted-foreground">
              {traceIdLabel}<CopyIdButton value={evidence.trace_id!} kind="trace" />
            </span>
          ) : <span className="font-mono text-muted-foreground">{traceIdLabel}</span>}
        </div>
        {projectsHref ? (
          <Link
            href={projectsHref}
            className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open in Projects <ExternalLink className="size-3" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      <CaptureBand warnings={traceEvidenceWarnings(evidence)} />
      <div className="mt-4 grid gap-4 md:grid-cols-[minmax(12rem,0.75fr)_minmax(0,1.5fr)]">
        <section aria-label="Span tree" className="min-w-0 rounded-xl border">
          <h3 className="shrink-0 border-b px-4 py-3 text-sm font-medium">Span tree</h3>
          <SpanTreePane
            spans={evidence.spans}
            loading={false}
            error={null}
            onRetry={onRefresh}
            selectedId={effectiveSelected}
            onSelect={setSelectedId}
            emptyMessage={emptyMessage}
            scrollClassName={layout.tree}
          />
        </section>
        <section aria-label="Selected span" className="min-w-0 rounded-xl border">
          <h3 className="shrink-0 border-b px-4 py-3 text-sm font-medium">Span detail</h3>
          <SpanDetailPane
            loading={false}
            error={null}
            onRetry={onRefresh}
            span={selected}
            emptyMessage={emptyMessage}
            scrollClassName={layout.detail}
          />
          <section aria-label="Annotation summary" className="border-t p-4"><h3 className="mb-3 text-sm font-medium">Annotation summary</h3><SelectedAnnotationSummary item={item} span={selected} projectId={projectId ?? null} error={null} onRetry={onRefresh} /></section>
        </section>
      </div>
    </div>
  );
}

export function pickTextEntry(
  value: Record<string, unknown> | null,
  keys: string[],
): { key: string; text: string } | null {
  if (!value) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return { key, text: candidate };
    }
  }
  return null;
}

function additionalFields(
  value: Record<string, unknown> | null,
  renderedKey: string | undefined,
): Record<string, unknown> | null {
  if (!value) return null;
  const remaining = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== renderedKey),
  );
  return Object.keys(remaining).length > 0 ? remaining : null;
}

function EvidenceValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-sm text-muted-foreground">{NOT_CAPTURED}</span>;
  }
  if (typeof value === "string") {
    return <EvidenceMarkdown text={value} />;
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 text-xs leading-5">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function EvidenceField({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: unknown;
  emphasis?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border bg-card p-4",
        emphasis && "border-primary/30 bg-primary/[0.025] shadow-sm",
      )}
    >
      <h4 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </h4>
      <EvidenceValue value={value} />
    </div>
  );
}

function Reference({ label, value, idKind }: { label: string; value: string | null; idKind?: "run" | "trace" }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 flex items-center gap-1 break-all font-mono text-xs">
        {value || <span className="font-sans text-muted-foreground">{NOT_CAPTURED}</span>}
        {value && idKind ? <CopyIdButton value={value} kind={idKind} /> : null}
      </dd>
    </div>
  );
}

/**
 * Execution-evidence stat value. It renders in a one-line, truncating tile, so it stays
 * a terse status — the sentence explaining it belongs in the Execution section notice,
 * which every user can read rather than only those who can hover a title attribute.
 * Missing evidence only counts as "not captured" when the run asked for full execution;
 * a narrower depth never configured it, and an unrecorded depth claims neither.
 */
export function executionEvidenceSummary(args: {
  traceId: string | null;
  toolCallCount: number;
  evaluationScope: EvaluationScope | null | undefined;
}): string {
  const { traceId, toolCallCount, evaluationScope } = args;
  if (validTraceId(traceId)) return "Trace ID recorded";
  if (toolCallCount > 0) return "Tool interactions captured";
  if (!evaluationScope) return "Scope not recorded";
  return evaluationScope === "full_execution" ? "Not captured" : "Outside the evaluated depth";
}

/** The sentence behind an empty "Execution evidence" stat, shown where the evidence is. */
function ExecutionEvidenceNotice({
  traceId,
  toolCallCount,
  evaluationScope,
}: {
  traceId: string | null;
  toolCallCount: number;
  evaluationScope: EvaluationScope | null | undefined;
}) {
  if (validTraceId(traceId) || toolCallCount > 0) return null;
  if (evaluationScope === "full_execution") {
    return (
      <div className="mb-4 rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">
        <strong className="text-foreground">Not captured.</strong>{" "}
        {evidenceDepthNotCapturedCopy("full_execution")}
      </div>
    );
  }
  return <DepthNotice scope={evaluationScope} className="mb-4" />;
}

/**
 * Why an evidence layer is empty. The lede states which of the two situations applies —
 * a depth was chosen and excluded this evidence, or the run never recorded a depth at all.
 */
function DepthNotice({
  scope,
  className,
  children,
}: {
  scope: EvaluationScope | null | undefined;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground", className)}>
      <strong className="text-foreground">{scope ? "Not configured." : "Scope not recorded."}</strong>{" "}
      {scope ? evidenceDepthNotConfiguredCopy(scope) : evidenceDepthNotRecordedCopy()}
      {children ? <> {children}</> : null}
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card px-3 py-2.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold" title={value}>{value}</p>
    </div>
  );
}

function EmptyEvidence({ children }: { children: string }) {
  return (
    <p className="rounded-lg border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function ToolArtifactCard({
  runId,
  exampleId,
  artifact,
}: {
  runId: string;
  exampleId: string;
  artifact: ToolResultArtifactReference;
}) {
  const [content, setContent] = useState(artifact.preview);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (nextOffset === null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      const page = await evaluationApi.getToolResultArtifact(
        runId,
        exampleId,
        artifact.artifact_id,
        tenantId,
        nextOffset,
      );
      setContent((current) => (nextOffset === 0 ? page.content : current + page.content));
      setNextOffset(page.next_offset);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-state-caution/30 bg-state-caution-soft p-3.5 dark:border-state-caution/30 dark:bg-state-caution-soft">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs font-semibold text-primary">{artifact.tool_name}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {formatBytes(artifact.size_bytes)} · inline preview {formatBytes(artifact.preview_bytes)}
          </p>
        </div>
        <span className="rounded-full border bg-background px-2 py-0.5 text-[10px] font-medium">
          Stored as artifact
        </span>
      </div>
      <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border bg-background/70 p-3 font-mono text-[11px] leading-5">
        {content}
      </pre>
      <div className="mt-2 flex items-center gap-3">
        {nextOffset !== null ? (
          <button type="button" onClick={() => void load()} disabled={loading} className="rounded border bg-background px-2.5 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-60">
            {loading ? "Loading…" : nextOffset === 0 ? "Load full result" : "Load next 128 KB"}
          </button>
        ) : (
          <span className="text-[11px] font-medium text-state-positive">Full result loaded</span>
        )}
        {error ? <span className="text-[11px] text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}

function AdditionalEvidence({
  label,
  value,
}: {
  label: string;
  value: Record<string, unknown> | null;
}) {
  if (!value) return null;
  return (
    <details className="group/field rounded-lg border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3.5 text-xs font-semibold">
        {label}
        <span className="text-muted-foreground transition-transform group-open/field:rotate-180">▾</span>
      </summary>
      <AnimatedDetailsBody openClassName="group-open/field:grid-rows-[1fr]">
        <div className="border-t p-3.5">
          <EvidenceValue value={value} />
        </div>
      </AnimatedDetailsBody>
    </details>
  );
}

function AnimatedDetailsBody({
  children,
  openClassName,
}: {
  children: ReactNode;
  openClassName: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-standard motion-reduce:transition-none",
        openClassName,
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function worstGate(results: MetricResult[]): GateResult | null {
  const applicable = results.filter((result) => !isMeasurement(result.metric_id) && result.metric_applicability !== "not_applicable");
  if (
    applicable.length === 0 ||
    applicable.some(
      (result) =>
        (result.metric_status !== "scored" && !(
          result.metric_status == null &&
          result.normalised_score !== null &&
          result.threshold_result !== null
        )) || result.threshold_result === null,
    )
  ) {
    return null;
  }
  const rank: Record<GateResult, number> = { pass: 0, warn: 1, fail: 2 };
  const gates = applicable
    .map((result) => result.threshold_result)
    .filter((gate): gate is GateResult => gate !== null);
  if (gates.length === 0) return null;
  return gates.reduce<GateResult>(
    (worst, result) =>
      rank[result] > rank[worst] ? result : worst,
    "pass",
  );
}

function MetricState({ result }: { result: MetricResult }) {
  if (result.metric_applicability === "not_applicable") {
    return <span className="text-xs font-medium text-muted-foreground">Not applicable</span>;
  }
  if (result.metric_status === "technical_error") {
    return <span className="text-xs font-medium text-destructive">Technical error</span>;
  }
  if (result.metric_status === "unscored") {
    if (result.unscored_reason === "simulated") {
      return <span className="text-xs font-medium text-state-caution">Simulated - no real judge ran</span>;
    }
    return <span className="text-xs font-medium text-state-caution">Not scored</span>;
  }
  // Scored, but with no budget to be judged against — a measurement. Distinct from
  // the unscored branch above, which means required evidence was missing. Both read
  // "Not scored" for a moment, separated only by colour, which is not a distinction
  // a screen reader or a colour-blind reader can make.
  return !isMeasurement(result.metric_id) && result.threshold_result
    ? <GateBadge gate={result.threshold_result} size="sm" />
    : <span className="text-xs font-medium text-muted-foreground">No verdict</span>;
}

type ScorerGroup = {
  family: string;
  label: string;
  metrics: MetricResult[];
  relatedKpis: Array<{
    kpiId: string;
    label: string;
    runScore: number | null;
  }>;
  worstGate: GateResult | null;
  failingCount: number;
};

export function groupScorerResults(
  results: MetricResult[],
  kpis: KpiResult[],
): ScorerGroup[] {
  return groupByMetricFamily(results, (result) => result.metric_id).map(({prefix: family, label, items: metrics}) => {
    const metricIds = new Set(metrics.map((metric) => metric.metric_id));
    const relatedKpis = kpis
      .filter((kpi) =>
        kpi.constituent_scores.some((score) => metricIds.has(score.metric_id)),
      )
      .map((kpi) => ({
        kpiId: kpi.kpi_id,
        label: kpiLabel(kpi.kpi_id),
        runScore: kpi.composite_score,
      }));

    return {
      family,
      label,
      metrics,
      relatedKpis,
      worstGate: worstGate(metrics),
      failingCount: metrics.filter((metric) => !isMeasurement(metric.metric_id) && metric.threshold_result === "fail").length,
    };
  });
}

function ScorerResultCard({
  result,
  open,
  projectId,
}: {
  result: MetricResult;
  open: boolean;
  projectId?: string | null;
}) {
  return (
    <details className="group overflow-hidden rounded-lg border bg-card" open={open}>
      <summary className="grid cursor-pointer list-none items-center gap-3 p-3.5 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-semibold text-primary">
            {result.metric_id}
          </p>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {result.evaluator_id || result.evaluator_instance_id}
            {result.evaluator_version ? ` @ ${result.evaluator_version}` : ""}
          </p>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-[10px] uppercase text-muted-foreground">Score</p>
          <p className="font-mono text-xs font-semibold">
            {isMeasurement(result.metric_id) ? nativeMetricValue(result.metric_id, result.score) ?? "Not recorded" : result.normalised_score === null ? "Not scored" : `${(result.normalised_score * 100).toFixed(1)}%`}
          </p>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-[10px] uppercase text-muted-foreground">Threshold</p>
          <p className="font-mono text-xs font-semibold">
            {isMeasurement(result.metric_id) ? "Not applicable" : `${(result.threshold * 100).toFixed(1)}%`}
          </p>
        </div>
        <div className="flex items-center justify-between gap-2 sm:justify-end">
          <MetricState result={result} />
          <span className="text-xs text-muted-foreground transition-transform group-open:rotate-180">
            ▾
          </span>
        </div>
      </summary>

      <div className="border-t bg-muted/[0.14] p-4">
        <dl className="grid gap-3 sm:grid-cols-3">
          <Reference label="Raw score" value={result.score === null ? null : result.score.toFixed(3)} />
          <Reference label="Execution status" value={result.execution_status} />
          <Reference label="Requested scorer" value={result.requested_scorer || null} />
          <Reference label="Executed scorer" value={result.executed_scorer || null} />
          <Reference label="Prompt version" value={result.prompt_version || null} />
          <Reference label="Annotator kind" value={result.annotator_kind || null} />
          <Reference label="Evaluation ID" value={result.evaluation_identifier || null} />
        </dl>

        {projectId && validTraceId(result.evaluator_trace_id) ? (
          <Link
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            href={`/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(result.evaluator_trace_id!)}`}
          >
            View evaluator trace <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </Link>
        ) : null}

        <div className="mt-4 rounded-lg border bg-background p-3.5">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Rationale
          </p>
          {result.rationale ? (
            <EvidenceMarkdown text={result.rationale} className="text-xs leading-6" />
          ) : (
            <p className="text-xs text-muted-foreground">No scorer rationale was returned.</p>
          )}
        </div>

        <p className="mt-3 text-[10px] leading-5 text-muted-foreground">
          Judge {result.judge_model || "not captured"} · prompt {result.judge_prompt_tokens ?? "—"} · completion {result.judge_completion_tokens ?? "—"} · total {result.judge_total_tokens ?? "—"} tokens
        </p>
        {result.error_message && (
          <div className="mt-3 rounded border border-red-300 bg-red-50 p-2.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            Evaluator error: {result.error_message}
          </div>
        )}
      </div>
    </details>
  );
}

function metricLabel(metricId: string): string {
  const leaf = metricId.includes(".") ? metricId.split(".").pop()! : metricId;
  return leaf
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}



/** Focused review surface used by the report's case dialog. */
export function RunItemCaseReview({
  item,
  kpis = [],
  evaluationScope = null,
  projectId = null,
}: {
  item: RunItemDetail;
  kpis?: KpiResult[];
  evaluationScope?: EvaluationScope | null;
  projectId?: string | null;
}) {
  // Mounted only once the operator opens the trace section, so opening a case
  // does not fetch an archive nobody asked for.
  const [traceOpen, setTraceOpen] = useState(false);
  const extendedEvidenceRequired = evaluationScope === "tool_interactions" || evaluationScope === "full_execution";
  const { byMetric: agreement, failed: agreementFailed } = useJudgeAgreement();
  const alreadyInReview = useAlreadyInReview(item.run_id, item.example_id);
  const measurementCount = item.scorer_results.filter((result) => isMeasurement(result.metric_id)).length;
  const checkCount = item.scorer_results.length - measurementCount;
  const query = pickTextEntry(item.input, ["query", "question", "prompt", "input"]);
  const actual = pickTextEntry(item.output, ["response", "answer", "output", "actual_output", "text"]);
  const expected = pickTextEntry(item.expected, [
    "expected_response",
    "expected_answer",
    "expected_output",
    "ground_truth",
    "reference",
    "answer",
    "response",
  ]);
  // Measurements carry no verdict, so counting them in the denominator produced
  // "0 of 19 metrics passed" on a case with 14 judgements — a number the metric
  // table beneath, which drops measurements into a band of their own, disagreed with.
  // Judged means a verdict came back, not merely "is not a measurement". Filtering
  // by metric id alone kept unscored and technical-error results in the denominator,
  // so a case where nothing was judged still claimed "0 of 1 metrics passed".
  const judgedScores = item.scorer_results.filter(
    (result) => !isMeasurement(result.metric_id) && result.threshold_result !== null,
  );
  const passedScores = judgedScores.filter(
    (result) => result.threshold_result === "pass",
  ).length;
  const failingScores = judgedScores.filter(
    (result) => result.threshold_result === "fail",
  ).length;
  // Deliberately the full set, unlike the counts above: a scorer that crashed is
  // worth reporting whether or not the metric it was scoring gates anything.
  const technicalErrors = item.scorer_results.filter(
    (result) => result.metric_status === "technical_error",
  );
  const availableMetricIds = new Set(item.scorer_results.map((result) => result.metric_id));
  const expectedMetricIds = new Set(
    kpis.flatMap((kpi) => kpi.constituent_scores.map((score) => score.metric_id)),
  );
  const missingMetricIds = Array.from(expectedMetricIds).filter(
    (metricId) => !availableMetricIds.has(metricId),
  );
  // A crashed scorer withholds the verdict. `judgedScores` deliberately strips
  // rows with no `threshold_result`, which is exactly the shape a
  // `technical_error` row has — so filtering first removed the very rows
  // `worstGate` returns null for, and the dialog rendered a green Pass on a case
  // the list beside it renders as "Technical error". Two screens, one case,
  // contradictory verdicts.
  const gate =
    technicalErrors.length > 0 || judgedScores.length === 0 ? null : worstGate(judgedScores);
  const latency = formatDuration(item.execution.latency_ms);
  const hasArtifacts = item.tool_result_artifacts.length > 0;
  const additionalOutput = actual ? additionalFields(item.output, actual.key) : null;
  const additionalInput = query ? additionalFields(item.input, query.key) : null;
  const additionalExpected = expected ? additionalFields(item.expected, expected.key) : null;
  const additionalFieldGroups = [
    { label: "Output fields", value: additionalOutput },
    { label: "Input fields", value: additionalInput },
    { label: "Expectation fields", value: additionalExpected },
  ].filter(
    (group): group is { label: string; value: Record<string, unknown> } =>
      group.value !== null,
  );

  return (
    <article className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted/45 px-3.5 py-2.5 text-xs">
        {/* Same split the run list makes: nothing judgeable recorded is "Not recorded",
            recorded but ungraded is "Not scored". The dialog used to say "Not scored"
            for both, so one case was named two ways depending on where you read it. */}
        {gate ? (
          <GateBadge gate={gate} size="sm" />
        ) : (
          <span className="text-sm font-semibold">
            {judgedScores.length === 0 ? "Not recorded" : "Not scored"}
          </span>
        )}
        <span className="text-muted-foreground">
          {judgedScores.length > 0
            ? `${passedScores} of ${judgedScores.length} metrics passed`
            : "No metric results"}
        </span>
        {failingScores > 0 ? (
          <span className="font-medium text-destructive">
            {attentionLabel(failingScores)}
          </span>
        ) : null}
        {latency ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground">·</span>
            <span className="font-mono text-muted-foreground">{latency}</span>
          </>
        ) : null}
      </div>

      {hasArtifacts ? (
        <div className="rounded-lg border border-state-caution/30 bg-state-caution-soft px-3.5 py-3 text-xs leading-5 text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution">
          The response and scores are complete. Some large tool outputs are stored separately and remain available under More evidence.
        </div>
      ) : item.capture_state === "partial" ? (
        <div className="rounded-lg border border-state-caution/30 bg-state-caution-soft px-3.5 py-3 text-xs leading-5 text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution">
          This case contains partial evidence. Missing fields are not inferred.
        </div>
      ) : item.capture_state === "unknown" ? (
        <div className="rounded-lg border bg-muted/20 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
          Capture completeness was not recorded for this historical case. Missing fields are not inferred.
        </div>
      ) : null}

      {item.execution.invocation_error ? (
        <InvocationErrorBanner invocationError={item.execution.invocation_error} output={item.output} />
      ) : null}

      <section aria-labelledby="case-response-title">
        <div className="mb-2">
          <h3 id="case-response-title" className="text-sm font-semibold">Response review</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Compare what was asked, what the target returned, and the saved reference.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border bg-background">
          <div className="border-b bg-muted/15 px-4 py-3.5">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Prompt</p>
            <EvidenceValue value={query?.text ?? item.input} />
          </div>
          <div className="grid md:grid-cols-2 md:divide-x">
            <div className="min-w-0 border-b px-4 py-3.5 md:border-b-0">
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Actual response</p>
              <EvidenceValue value={actual?.text ?? item.output} />
            </div>
            <div className="min-w-0 px-4 py-3.5">
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Expected response</p>
              <EvidenceValue value={expected?.text ?? item.expected} />
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="case-metrics-title">
        <div className="mb-2 flex items-end justify-between gap-3">
          <div>
            <h3 id="case-metrics-title" className="text-sm font-semibold">Metric results</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Open a metric to see why it received its score.</p>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {checkCount} {checkCount === 1 ? "check" : "checks"}
            {measurementCount > 0 ? ` · ${measurementCount} ${measurementCount === 1 ? "measurement" : "measurements"}` : ""}
          </span>
        </div>

        {(missingMetricIds.length > 0 || technicalErrors.length > 0) ? (
          <div className="mb-2 rounded-lg border border-state-caution/30 bg-state-caution-soft px-3.5 py-3 text-xs leading-5 text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution">
            <strong>Evaluation coverage is incomplete.</strong>
            {missingMetricIds.length > 0 ? ` ${missingMetricIds.length} expected metric${missingMetricIds.length === 1 ? " is" : "s are"} missing.` : ""}
            {technicalErrors.length > 0 ? ` ${technicalErrors.length} scorer${technicalErrors.length === 1 ? " reported" : "s reported"} a technical error or fallback.` : ""}
          </div>
        ) : null}

        {item.scorer_results.length > 0 ? (
          <div className="overflow-hidden rounded-xl border bg-background">
            {groupByMetricFamily(item.scorer_results, (result) => result.metric_id).map((family) => (
            // Same families, same order as the run report and the creation
            // flow: one case's metrics must not be grouped differently from
            // the run's. Collapsible via plain <details>, no client state.
            <details key={family.prefix} open={family.items.some((result) => !isMeasurement(result.metric_id) && result.threshold_result === "fail")} className="group/family border-b last:border-b-0">
              <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 bg-muted/10 px-4 py-3 outline-none hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <span aria-hidden="true" className="text-xs text-muted-foreground transition-transform [details[open]>summary_&]:rotate-90">▸</span>
                <span className="text-sm font-semibold text-brand-text">{family.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  {family.items.length} {family.prefix === "performance" ? "measurement" : "check"}{family.items.length === 1 ? "" : "s"}
                  {family.items.some((result) => !isMeasurement(result.metric_id) && result.threshold_result === "fail") ? ` · ${family.items.filter((result) => result.threshold_result === "fail").length} failed` : ""}
                </span>
                {family.items.every((result) => result.metric_requirement === "optional") ? (
                  <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Diagnostic · does not gate
                  </span>
                ) : null}
                {family.note ? (
                  <span className="w-full text-[11px] leading-4 text-muted-foreground">{family.note}</span>
                ) : null}
              </summary>
            {family.items.map((result, index) => (
              <details
                key={`${result.metric_id}-${index}`}
                className="group/metric border-b last:border-b-0"
                open={!isMeasurement(result.metric_id) && result.threshold_result === "fail"}
              >
                <summary className="grid cursor-pointer list-none items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{metricLabel(result.metric_id)}</span>
                    {result.error_message ? (
                      <span className="mt-0.5 block text-[11px] text-destructive">Scorer error recorded</span>
                    ) : null}
                  </span>
                  {/* Same information model as the run report's Metric
                      averages: a metric with its own units leads with the
                      measurement, and the normalised score explains the gate
                      beside it. Showing "100.0%" for a token count in one place
                      and "1,593 tokens" in the other made the two surfaces
                      disagree about the same metric. */}
                  <span className="font-mono text-xs font-semibold">
                    {nativeMetricValue(
                      result.metric_id,
                      typeof result.score === "number" && (isMeasurement(result.metric_id) || result.score !== result.normalised_score)
                        ? result.score
                        : null,
                    ) ??
                      (result.normalised_score === null
                        ? "Not scored"
                        : `${(result.normalised_score * 100).toFixed(1)}%`)}
                  </span>
                  <MetricState result={result} />
                  <span aria-hidden="true" className="text-xs text-muted-foreground transition-transform group-open/metric:rotate-180">▾</span>
                </summary>
                <AnimatedDetailsBody openClassName="group-open/metric:grid-rows-[1fr]">
                  <div className="border-t bg-muted/10 px-4 py-3.5">
                    <p className="text-xs leading-5 text-foreground">
                      {result.rationale || "No scoring rationale was captured for this metric."}
                    </p>
                    {nativeMetricValue(
                      result.metric_id,
                      typeof result.score === "number" && (isMeasurement(result.metric_id) || result.score !== result.normalised_score)
                        ? result.score
                        : null,
                    ) && !isMeasurement(result.metric_id) && result.normalised_score !== null ? (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        Scores {(result.normalised_score * 100).toFixed(1)}% against its threshold
                      </p>
                    ) : null}
                    <p className="mt-2 text-[10px] leading-5 text-muted-foreground">
                      {/* Only where a threshold decided something. A metric
                          with no verdict was still showing "Threshold 80%" —
                          a default nobody configured, rendered as a percentage
                          of a latency in seconds. */}
                      {!isMeasurement(result.metric_id) && result.threshold_result
                        ? `Threshold ${(result.threshold * 100).toFixed(0)}% · `
                        : ""}
                      scorer {result.evaluator_id || result.evaluator_instance_id || "not captured"}
                      {result.evaluator_version ? ` · version ${result.evaluator_version}` : ""}
                      {result.judge_model ? ` · judge ${result.judge_model}` : ""}
                      {result.requested_scorer ? ` · Requested scorer ${result.requested_scorer}` : ""}
                      {result.executed_scorer ? ` · Executed scorer ${result.executed_scorer}` : ""}
                    </p>
                    {result.error_message ? (
                      // Red only when the scorer actually failed. A row that is
                      // merely unscored — no retrieval corpus to grade against,
                      // say — also carries an error_message, and rendering that
                      // in destructive red told the reader something broke when
                      // nothing did.
                      <p
                        className={cn(
                          "mt-2 text-xs",
                          result.execution_status === "error"
                            ? "text-destructive"
                            : "text-muted-foreground",
                        )}
                      >
                        {result.error_message}
                      </p>
                    ) : null}
                    {/* The fact and the response to it belong on one row: a
                        reviewer reads how far the judge is trusted here, then
                        acts on this same score. Stacks on narrow widths. */}
                    {/* Gated on a real VERDICT, not merely on `scored`. An
                        unscored metric has no judge opinion to review; so does
                        a measurement. Latency and token counts are recorded
                        facts — 1.007 seconds is not right or wrong — and
                        offering "Send to review" beside one produced a finding
                        that filed the reading as a CRITICAL failure. Agreement
                        is hidden here for the same reason: a reviewer's opinion
                        about a measurement is not evidence about the judge. */}
                    {!isMeasurement(result.metric_id) && result.metric_status === "scored" && result.threshold_result ? (
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-2.5">
                        <JudgeAgreementNote
                          entry={agreement[agreementKey(result.metric_id, result.executed_scorer)]}
                          unavailable={agreementFailed}
                        />
                        <ReviewThisScore
                          // Keyed to the target: this component holds "queued"
                          // in local state, and without a key React reuses the
                          // instance when the inspector moves to another row —
                          // leaving a case that was never sent showing as
                          // queued, and disabled.
                          key={`${item.example_id}:${result.metric_id}`}
                          result={result}
                          runId={item.run_id}
                          rowId={item.example_id}
                          existingFinding={alreadyInReview.get(result.metric_id)}
                        />
                      </div>
                    ) : null}
                  </div>
                </AnimatedDetailsBody>
              </details>
            ))}
            </details>
            ))}
          </div>
        ) : (
          <EmptyEvidence>No scorer results were recorded.</EmptyEvidence>
        )}
      </section>

      <details className="group/more overflow-hidden rounded-xl border bg-background">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 outline-none hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <span>
            <span className="block text-sm font-semibold">More evidence</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{extendedEvidenceRequired ? "Context, tools, execution, and record details" : evaluationScope ? evidenceDepthNotConfiguredCopy(evaluationScope) : evidenceDepthNotRecordedCopy()}</span>
          </span>
          <span aria-hidden="true" className="text-xs text-muted-foreground transition-transform group-open/more:rotate-180">▾</span>
        </summary>
        <AnimatedDetailsBody openClassName="group-open/more:grid-rows-[1fr]">
        <div className="space-y-5 border-t px-4 py-4">
          {!extendedEvidenceRequired ? <DepthNotice scope={evaluationScope}>Any recorded values below are shown only for inspection.</DepthNotice> : null}
          <section>
            <h4 className="mb-2 text-xs font-semibold">Context and tools</h4>
            {item.retrieval_snippets && item.retrieval_snippets.length > 0 ? (
              <div className="mb-3 space-y-2">
                {item.retrieval_snippets.map((snippet, index) => (
                  <div key={`${index}-${snippet.slice(0, 20)}`} className="rounded-lg bg-muted/30 px-3.5 py-3">
                    <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Context {index + 1}</p>
                    <EvidenceMarkdown text={snippet} className="text-xs leading-5" />
                  </div>
                ))}
              </div>
            ) : (
              <p className="mb-3 text-xs text-muted-foreground">Retrieval context: {item.retrieval_snippets === null ? NOT_CAPTURED : "No snippets recorded"}</p>
            )}
            {hasArtifacts ? (
              <div className="mb-3 space-y-2">
                {item.tool_result_artifacts.map((artifact) => (
                  <ToolArtifactCard key={artifact.artifact_id} runId={item.run_id} exampleId={item.example_id} artifact={artifact} />
                ))}
              </div>
            ) : null}
            {item.tool_calls && item.tool_calls.length > 0 ? (
              <div className="space-y-2">
                {item.tool_calls.map((tool, index) => (
                  <details key={`${tool.name}-${index}`} className="group/tool rounded-lg border">
                    <summary className="flex cursor-pointer list-none items-center justify-between px-3.5 py-3 text-xs font-medium">
                      <span>{tool.name}</span><span aria-hidden="true" className="transition-transform group-open/tool:rotate-180">▾</span>
                    </summary>
                    <AnimatedDetailsBody openClassName="group-open/tool:grid-rows-[1fr]">
                      <div className="grid gap-3 border-t p-3.5 md:grid-cols-2">
                        <EvidenceField label="Arguments" value={tool.args} />
                        <EvidenceField label="Output" value={tool.output} />
                      </div>
                    </AnimatedDetailsBody>
                  </details>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Tool activity: {item.tool_calls === null ? NOT_CAPTURED : "No tool calls recorded"}</p>
            )}
          </section>

          {additionalFieldGroups.length > 0 ? (
            <section>
              <h4 className="mb-2 text-xs font-semibold">Additional row fields</h4>
              <div
                className={cn(
                  "grid gap-2",
                  additionalFieldGroups.length === 2 && "md:grid-cols-2",
                  additionalFieldGroups.length >= 3 && "md:grid-cols-3",
                )}
              >
                {additionalFieldGroups.map((group) => (
                  <AdditionalEvidence key={group.label} label={group.label} value={group.value} />
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <h4 className="mb-2 text-xs font-semibold">Execution and record</h4>
            <dl className="grid gap-4 rounded-lg bg-muted/25 p-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <Reference label="Dataset" value={datasetVersionLabel(item.dataset_version)} />
              <Reference label="Case ID" value={item.example_id} />
              <Reference label="Invocation ID" value={item.execution.invocation_id} />
              <Reference label="Session ID" value={item.execution.kagent_session_id} />
              <Reference label="Trace ID" value={validTraceId(item.execution.trace_id)} idKind="trace" />
              <Reference label="Span ID" value={validSpanId(item.execution.span_id)} />
              <Reference label="Evidence reference" value={item.evidence_ref} />
              <Reference label="Capture" value={item.capture_state} />
              <Reference label="Latency" value={item.execution.latency_ms === null ? null : `${item.execution.latency_ms} ms`} />
            </dl>
            {item.execution.usage ? (
              <div className="mt-3">
                <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Target usage</p>
                <EvidenceValue value={item.execution.usage} />
              </div>
            ) : null}
          </section>
        </div>
        </AnimatedDetailsBody>
      </details>

      {/* The report opens cases in this dialog variant, so a trace drill-down
          that existed only in the drawer variant was unreachable from the
          surface operators actually use. Same panel both places — the two
          cannot disagree about what was captured. Collapsed by default and
          mounted only when opened, so opening a case does not fetch an archive
          nobody asked for. */}
      <details
        className="group/trace overflow-hidden rounded-xl border bg-background"
        onToggle={(event) => setTraceOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 outline-none hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <span>
            <span className="block text-sm font-semibold">Captured trace evidence</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {validTraceId(item.execution.trace_id)
                ? "Span tree for this case, read from the archive"
                : "No trace was recorded for this case"}
            </span>
          </span>
          <span aria-hidden="true" className="text-xs text-muted-foreground transition-transform group-open/trace:rotate-180">▾</span>
        </summary>
        <div className="border-t px-4 py-4">
          {traceOpen ? (
            <TraceEvidencePanel key={`${item.run_id}:${item.example_id}`} item={item} projectId={projectId} />
          ) : null}
        </div>
      </details>
    </article>
  );
}

/** Send this metric's score to review, whether the judge passed or failed it.
 *
 *  Findings are raised only for failures, so review on its own can only ever
 *  catch false alarms — a judge that passes everything scores a perfect
 *  agreement. This is how a reviewer says "it passed this and it should not
 *  have". It records no verdict: it puts the case in the queue, and the
 *  reviewer decides there through the normal agree/disagree flow.
 */
/** Metric keys on this run that already have a finding, so a case sent for
 *  review still reads as sent after a reload.
 *
 *  Send-now-decide-later is the actual usage pattern, and the button's state was
 *  in memory only: reloading brought back a plain "Send to review" with no sign
 *  the case was already queued. Reuses listFindings — no new endpoint. */
function useAlreadyInReview(runId?: string | null, rowId?: string | null): Map<string, Finding> {
  const [queued, setQueued] = useState<Map<string, Finding>>(new Map());
  useEffect(() => {
    if (!runId || !rowId) return;
    let active = true;
    void (async () => {
      try {
        const { tenant_id } = await api.tenant();
        const findings = await platformApi.listFindings(tenant_id, { run_id: runId });
        if (!active) return;
        setQueued(
          new Map(
            findings
              .filter((finding) => finding.row_id === rowId && finding.metric_ids.length === 1)
              .map((finding) => [finding.metric_ids[0], finding]),
          ),
        );
      } catch {
        // Diagnostic only: the button falls back to its default state, and the
        // endpoint behind it is idempotent, so a duplicate click is harmless.
      }
    })();
    return () => {
      active = false;
    };
  }, [runId, rowId]);
  return queued;
}


/** Key an agreement entry to the metric AND the scorer that produced it.
 *
 *  The score on screen was produced by one specific scorer. Looking the number
 *  up by metric alone would show a count built from a different implementation
 *  of the same metric, which is exactly the claim it must not make. */
function agreementKey(metricId: string, scorer: string | null | undefined): string {
  return `${metricId}::${scorer ?? ""}`;
}

/** Agreement per metric, fetched once for the whole case rather than per row.
 *
 *  Returns the load outcome alongside the counts. The note renders for every
 *  scored metric, so an undefined entry is not silence — it prints "nobody has
 *  reviewed this metric yet". Without distinguishing a failed fetch from a real
 *  absence, a dropped request would state review history as fact. */
function useJudgeAgreement(): {
  byMetric: Record<string, JudgeAgreement>;
  failed: boolean;
} {
  const [byMetric, setByMetric] = useState<Record<string, JudgeAgreement>>({});
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { tenant_id } = await api.tenant();
        const rows = await platformApi.judgeAgreement(tenant_id);
        if (!active) return;
        setByMetric(Object.fromEntries(rows.map((row) => [agreementKey(row.metric_id, row.executed_scorer), row])));
        setFailed(false);
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  return { byMetric, failed };
}


function ReviewThisScore({
  result,
  runId,
  rowId,
  existingFinding,
}: {
  result: MetricResult;
  runId?: string | null;
  rowId?: string | null;
  existingFinding?: Finding;
}) {
  const [state, setState] = useState<"idle" | "sending" | "queued" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);

  // Nothing to agree or disagree with unless a judge actually formed an opinion.
  // A crashed scorer produced no judgement, so a verdict on it says nothing
  // about the judge — the server refuses it too.
  if (result.metric_status !== "scored" || !runId || !rowId) return null;
  if (result.execution_status === "error") return null;

  const queued = Boolean(existingFinding) || state === "queued";
  if (existingFinding) return <Link className="ms-auto inline-flex min-h-9 items-center rounded-md border px-3 text-xs font-medium text-brand-text focus-visible:ring-2 focus-visible:ring-ring" href={`/reviews?finding=${encodeURIComponent(existingFinding.finding_id)}&status=all`}>View review · {existingFinding.status.replaceAll("_", " ")}</Link>;

  async function send() {
    setState("sending");
    try {
      const { created } = await platformApi.openCaseForReview({
        run_id: runId as string,
        row_id: rowId as string,
        metric_id: result.metric_id,
      });
      setState("queued");
      setMessage(created ? "In the review queue" : "Already in the review queue");
    } catch (reason) {
      setState("failed");
      setMessage(userFacingError(reason));
    }
  }

  return (
    // ms-auto, not the parent's justify-between: with no agreement note the row
    // has one child, and justify-between puts a lone child at flex-start — so
    // the button jumped to the left edge on every metric with no review history,
    // which is most of them.
    <div className="ms-auto flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={state === "sending" || queued}
        onClick={() => void send()}
      >
        {state === "sending" ? "Sending…" : queued ? "In the review queue" : "Send to review"}
      </Button>
      {message ? (
        <span
          role={state === "failed" ? "alert" : "status"}
          className={cn("text-[11px]", state === "failed" ? "text-destructive" : "text-muted-foreground")}
        >
          {message}
        </span>
      ) : null}
    </div>
  );
}


export function RunItemInspector({
  item,
  kpis = [],
  evaluationScope = null,
  projectId = null,
}: {
  item: RunItemDetail;
  kpis?: KpiResult[];
  evaluationScope?: EvaluationScope | null;
  projectId?: string | null;
}) {
  const [section, setSection] = useState<InspectorSection>("answer");
  const query = pickTextEntry(item.input, ["query", "question", "prompt", "input"]);
  const actual = pickTextEntry(item.output, ["response", "answer", "output", "text"]);
  const expected = pickTextEntry(item.expected, [
    "expected_response",
    "expected_answer",
    "answer",
    "response",
  ]);
  const usage = item.execution.usage;
  const traceId = validTraceId(item.execution.trace_id);
  const failingScores = item.scorer_results.filter(
    (result) => result.threshold_result === "fail",
  ).length;
  const scorerGroups = groupScorerResults(item.scorer_results, kpis);
  const firstFailingGroup = scorerGroups.findIndex((group) => group.failingCount > 0);
  const availableMetricIds = new Set(
    item.scorer_results.map((result) => result.metric_id),
  );
  const expectedMetricIds = new Set(
    kpis.flatMap((kpi) =>
      kpi.constituent_scores.map((score) => score.metric_id),
    ),
  );
  const missingMetricIds = Array.from(expectedMetricIds).filter(
    (metricId) => !availableMetricIds.has(metricId),
  );
  const technicalErrors = item.scorer_results.filter(
    (result) => result.metric_status === "technical_error",
  );
  const hasArtifacts = item.tool_result_artifacts.length > 0;

  const selectSectionFromKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % SECTIONS.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + SECTIONS.length) % SECTIONS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = SECTIONS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextSection = SECTIONS[nextIndex];
    setSection(nextSection.id);
    document.getElementById(`run-item-section-tab-${nextSection.id}`)?.focus();
  };

  return (
    <article className="overflow-hidden rounded-xl border bg-background">
      <header className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {hasArtifacts
                ? "Large output stored separately"
                : item.capture_state === "partial"
                ? "Partial evidence"
                : item.capture_state === "unknown"
                ? "Capture not recorded"
                : "Selected dataset row"}
            </p>
            <h3 className="mt-1 break-all font-mono text-sm font-semibold text-primary">
              {item.example_id}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Dataset {datasetVersionLabel(item.dataset_version) || NOT_CAPTURED} · position {item.sequence_position + 1}
            </p>
          </div>
          <span className="rounded-full border bg-muted/30 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide">
            {item.capture_state} capture
          </span>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryStat label="Scorers" value={`${item.scorer_results.length}`} />
          <SummaryStat label="Failing" value={`${failingScores}`} />
          <SummaryStat
            label="Latency"
            value={item.execution.latency_ms === null ? NOT_CAPTURED : `${item.execution.latency_ms} ms`}
          />
          <SummaryStat
            label="Execution evidence"
            value={executionEvidenceSummary({
              traceId,
              toolCallCount: item.tool_calls?.length ?? 0,
              evaluationScope,
            })}
          />
        </div>
      </header>

      {hasArtifacts ? (
        <div className="mx-4 mb-4 rounded-lg border border-state-caution/30 bg-state-caution-soft p-3 text-xs leading-5 text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution sm:mx-5">
          <strong>Large tool output stored separately.</strong> The artifact may still be complete; external storage does not by itself mean the trace is partial.
        </div>
      ) : item.capture_state === "partial" ? (
        <div className="mx-4 mb-4 rounded-lg border border-state-caution/30 bg-state-caution-soft p-3 text-xs leading-5 text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution sm:mx-5">
          Required evidence is missing. Only recorded fields are shown; missing fields are not inferred.
        </div>
      ) : item.capture_state === "unknown" ? (
        <div className="mx-4 mb-4 rounded-lg border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground sm:mx-5">
          Capture completeness was not recorded for this historical run. Only recorded fields are shown; missing fields are not inferred.
        </div>
      ) : null}

      <nav
        role="tablist"
        aria-label="Run-item evidence sections"
        className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-y bg-muted/95 px-3 py-2 backdrop-blur sm:px-5"
      >
        {SECTIONS.map((candidate, index) => (
          <button
            key={candidate.id}
            id={`run-item-section-tab-${candidate.id}`}
            type="button"
            role="tab"
            aria-selected={section === candidate.id}
            aria-controls="run-item-section-panel"
            tabIndex={section === candidate.id ? 0 : -1}
            onClick={() => setSection(candidate.id)}
            onKeyDown={(event) => selectSectionFromKeyboard(event, index)}
            className={cn(
              "min-h-11 shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition-colors",
              section === candidate.id
                ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
            )}
          >
            {candidate.label}
          </button>
        ))}
      </nav>

      <div
        id="run-item-section-panel"
        role="tabpanel"
        aria-labelledby={`run-item-section-tab-${section}`}
        className="p-4 sm:p-5"
      >
        {section === "answer" && (
          <section aria-labelledby="answer-section-title">
            <div className="mb-4">
              <h3 id="answer-section-title" className="text-sm font-semibold">
                Evaluated response
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                The generated answer is primary; input and reference remain close for comparison.
              </p>
            </div>
            <EvidenceField label="Actual answer" value={actual?.text ?? item.output} emphasis />
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <EvidenceField label="Query" value={query?.text ?? item.input} />
              <EvidenceField label="Expected answer" value={expected?.text ?? item.expected} />
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              <AdditionalEvidence
                label="Additional output fields"
                value={actual ? additionalFields(item.output, actual.key) : null}
              />
              <AdditionalEvidence
                label="Additional input fields"
                value={query ? additionalFields(item.input, query.key) : null}
              />
              <AdditionalEvidence
                label="Additional expectation fields"
                value={expected ? additionalFields(item.expected, expected.key) : null}
              />
            </div>
          </section>
        )}

        {section === "context" && (
          <section aria-labelledby="context-section-title">
            <div className="mb-4">
              <h3 id="context-section-title" className="text-sm font-semibold">
                Retrieved context and tool activity
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Evidence supplied to, or produced by, the evaluated target.
              </p>
            </div>

            {evaluationScope === "final_response" ? <DepthNotice scope="final_response" className="mb-4">Context and tool evidence stay hidden from scoring.</DepthNotice> : null}

            <div className="grid gap-5 xl:grid-cols-2">
              <div className="min-w-0">
                <h4 className="mb-3 text-xs font-semibold">Retrieval evidence</h4>
                {item.retrieval_snippets === null ? (
                  <EmptyEvidence>{NOT_CAPTURED}</EmptyEvidence>
                ) : item.retrieval_snippets.length === 0 ? (
                  <EmptyEvidence>No retrieval snippets recorded.</EmptyEvidence>
                ) : (
                  <div className="space-y-2">
                    {item.retrieval_snippets.map((snippet, index) => (
                      <div
                        key={`${index}-${snippet.slice(0, 20)}`}
                        className="rounded-lg border bg-card p-4"
                      >
                        <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Snippet {index + 1}
                        </p>
                        <EvidenceMarkdown text={snippet} className="text-xs leading-6" />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="min-w-0">
                <h4 className="mb-3 text-xs font-semibold">Tool evidence</h4>
                {hasArtifacts ? (
                  <div className="mb-3 space-y-2">
                    {item.tool_result_artifacts.map((artifact) => (
                      <ToolArtifactCard
                        key={artifact.artifact_id}
                        runId={item.run_id}
                        exampleId={item.example_id}
                        artifact={artifact}
                      />
                    ))}
                  </div>
                ) : null}
                {item.tool_calls === null ? (
                  <EmptyEvidence>{NOT_CAPTURED}</EmptyEvidence>
                ) : item.tool_calls.length === 0 ? (
                  <EmptyEvidence>No tool calls recorded.</EmptyEvidence>
                ) : (
                  <div className="space-y-2">
                    {item.tool_calls.map((tool, index) => (
                      <details
                        key={`${tool.name}-${index}`}
                        className="group rounded-lg border bg-card"
                      >
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3.5">
                          <span className="min-w-0 truncate font-mono text-xs font-semibold text-primary">
                            {tool.name}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {item.expected_tools?.some(
                              (expectedTool) =>
                                expectedTool.trim().toLowerCase() ===
                                tool.name.trim().toLowerCase(),
                            ) && (
                              <span className="rounded-full bg-state-positive-soft px-2 py-0.5 text-[10px] text-state-positive dark:bg-state-positive-soft dark:text-state-positive">
                                expected
                              </span>
                            )}
                            <span className="text-xs text-muted-foreground transition-transform group-open:rotate-180">
                              ▾
                            </span>
                          </span>
                        </summary>
                        <div className="space-y-3 border-t p-3.5">
                          <EvidenceField label="Arguments" value={tool.args} />
                          <EvidenceField label="Output" value={tool.output} />
                        </div>
                      </details>
                    ))}
                  </div>
                )}
                {item.expected_tools && item.expected_tools.length > 0 && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Expected tools: <span className="font-mono">{item.expected_tools.join(", ")}</span>
                  </p>
                )}
              </div>
            </div>

            {item.metadata && Object.keys(item.metadata).length > 0 && (
              <details className="group mt-5 rounded-lg border bg-card">
                <summary className="flex cursor-pointer list-none items-center justify-between p-3.5 text-xs font-semibold">
                  Row metadata
                  <span className="text-muted-foreground transition-transform group-open:rotate-180">▾</span>
                </summary>
                <div className="border-t p-3.5">
                  <EvidenceValue value={item.metadata} />
                </div>
              </details>
            )}
          </section>
        )}

        {section === "scores" && (
          <section aria-labelledby="scores-section-title">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 id="scores-section-title" className="text-sm font-semibold">
                  Scorer results
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Checks use the same groups as setup. Open a group to inspect its results.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                {failingScores} failing of {item.scorer_results.length}
              </p>
            </div>

            <div className="space-y-2">
              {(missingMetricIds.length > 0 || technicalErrors.length > 0) && (
                <div className="rounded-lg border border-state-caution/30 bg-state-caution-soft p-3 text-xs leading-5 text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution">
                  <strong>Evaluation coverage is incomplete.</strong>{" "}
                  {missingMetricIds.length > 0 && (
                    <span>
                      Missing KPI metrics: {missingMetricIds.join(", ")}.
                    </span>
                  )}{" "}
                  {technicalErrors.length > 0 && (
                    <span>
                      {technicalErrors.length} scorer{technicalErrors.length === 1 ? "" : "s"}{" "}
                      reported a technical error or fallback.
                    </span>
                  )}
                </div>
              )}
              {scorerGroups.map((group, groupIndex) => (
                <details
                  key={group.family}
                  className="group/scorers overflow-hidden rounded-lg border bg-card open:border-brand-text/40"
                  open={groupIndex === firstFailingGroup}
                >
                  <summary className="grid cursor-pointer list-none items-center gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-brand-text">
                        {group.label}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {group.metrics.length} {group.family === "performance" ? "measurement" : "check"}{group.metrics.length === 1 ? "" : "s"}
                        {group.failingCount > 0 && ` · ${group.failingCount} failing`}
                      </p>
                    </div>
                    <div className="min-w-0 text-left sm:text-right">
                      <p className="text-[10px] uppercase text-muted-foreground">Related run KPIs</p>
                      {group.relatedKpis.length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 sm:justify-end">
                          {group.relatedKpis.map((kpi) => (
                            <span key={kpi.kpiId} className="whitespace-nowrap text-[10px]">
                              {kpi.label}{" "}
                              <strong className="font-mono text-foreground">
                                {kpi.runScore === null ? "Not scored" : `${(kpi.runScore * 100).toFixed(1)}%`}
                              </strong>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground">Not mapped</p>
                      )}
                    </div>
                    {group.worstGate ? <GateBadge gate={group.worstGate} size="sm" /> : <span className="text-xs text-muted-foreground">—</span>}
                    <span className="text-xs text-muted-foreground">▾</span>
                  </summary>
                  <div className="space-y-2 border-t bg-muted/[0.14] p-3">
                    {group.metrics.map((result, metricIndex) => (
                      <ScorerResultCard
                        key={`${result.metric_id}-${metricIndex}`}
                        result={result}
                        projectId={projectId}
                        open={
                          groupIndex === firstFailingGroup &&
                          result.threshold_result === "fail" &&
                          group.metrics.findIndex(
                            (metric) => metric.threshold_result === "fail",
                          ) === metricIndex
                        }
                      />
                    ))}
                  </div>
                </details>
              ))}
              {item.scorer_results.length === 0 && (
                <EmptyEvidence>No scorer results were recorded.</EmptyEvidence>
              )}
            </div>
          </section>
        )}

        {section === "trace" && (
          <section aria-labelledby="trace-section-title">
            <div className="mb-4">
              <h3 id="trace-section-title" className="text-sm font-semibold">Captured trace evidence</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Archived runtime spans are shown only when the backend returns genuine trace records.
              </p>
            </div>
            {evaluationScope !== "full_execution" ? <DepthNotice scope={evaluationScope} className="mb-4" /> : null}
            <TraceEvidencePanel key={`${item.run_id}:${item.example_id}`} item={item} projectId={projectId} />
          </section>
        )}

        {section === "execution" && (
          <section aria-labelledby="execution-section-title">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 id="execution-section-title" className="text-sm font-semibold">
                  Target execution
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Runtime references are kept separate from archived trace evidence.
                </p>
              </div>
              {traceId && (
                <CopyIdButton value={traceId} kind="trace" className="border bg-card" />
              )}
            </div>

            <ExecutionEvidenceNotice
              traceId={traceId}
              toolCallCount={item.tool_calls?.length ?? 0}
              evaluationScope={evaluationScope}
            />

            <dl className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Reference label="Invocation ID" value={item.execution.invocation_id} />
              <Reference label="kagent session ID" value={item.execution.kagent_session_id} />
              <Reference label="Trace ID" value={traceId} idKind="trace" />
              <Reference label="Span ID" value={validSpanId(item.execution.span_id)} />
              <Reference
                label="Latency"
                value={item.execution.latency_ms === null ? null : `${item.execution.latency_ms} ms`}
              />
              <div className="sm:col-span-2 lg:col-span-3">
                <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Target usage
                </dt>
                <dd className="mt-1">
                  {usage ? (
                    <EvidenceValue value={usage} />
                  ) : (
                    <span className="text-xs text-muted-foreground">{NOT_CAPTURED}</span>
                  )}
                </dd>
              </div>
            </dl>

            {item.execution.invocation_error && (
              <InvocationErrorBanner
                invocationError={item.execution.invocation_error}
                output={item.output}
              />
            )}

            <div className="mt-6">
              <h4 className="mb-3 text-xs font-semibold">Evidence governance</h4>
              <dl className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
                <Reference label="Evidence reference" value={item.evidence_ref} />
                <Reference
                  label="Redaction"
                  value={
                    item.evidence_policy.redaction_enabled === null
                      ? null
                      : item.evidence_policy.redaction_enabled
                        ? "Enabled"
                        : "Disabled"
                  }
                />
                <Reference
                  label="Maximum persisted string"
                  value={
                    item.evidence_policy.max_persisted_string_size === null
                      ? null
                      : `${item.evidence_policy.max_persisted_string_size} characters`
                  }
                />
                <Reference label="Retention" value="Stored with the run lifecycle" />
              </dl>
            </div>
          </section>
        )}
      </div>
    </article>
  );
}

function InvocationErrorBanner({
  invocationError,
  output,
}: {
  invocationError: string;
  output: Record<string, unknown> | null;
}) {
  if (isAgentOutputTooLarge(invocationError, output)) {
    const diagnostics = oversizedDiagnosticsFromOutput(output);
    const partial =
      typeof output?.response === "string" && output.response.trim()
        ? output.response.trim()
        : null;
    return (
      <div className="mt-3 space-y-2 rounded-lg border border-state-caution/30 bg-state-caution-soft p-3 text-xs text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution">
        <p className="font-semibold">{oversizedOutputTitle()}</p>
        <p className="leading-5">{oversizedOutputDescription(diagnostics)}</p>
        <p className="font-mono text-[11px] text-state-caution/80 dark:text-state-caution/80">
          {oversizedOutputReceivedLabel(diagnostics)}
        </p>
        {partial ? (
          <details className="rounded border border-state-caution/30 bg-background/40 p-2 dark:border-state-caution/30">
            <summary className="cursor-pointer font-medium">View partial output</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
              {partial}
            </pre>
          </details>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
      <strong>Invocation error:</strong> {invocationError}
    </div>
  );
}
