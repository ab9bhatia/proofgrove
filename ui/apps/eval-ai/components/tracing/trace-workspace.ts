// Pure, framework-free logic for the Project workspace Traces tab and the trace
// inspector. Kept separate from the (unrenderable-in-node) React components so
// the honest paging, span-selection and partial-capture rules can be unit
// tested directly. No fabricated data: totals and cursors come straight from
// the backend envelope, and "N of M" only ever reflects what was actually
// loaded against the honest server-side total.

import type {
  ArchivedTraceSpan,
  CapturedTraceSummary,
  CapturedTracesPage,
  IndexedSpanSummary,
  IndexedSpansPage,
  TraceLifecycleState,
} from "@/lib/api";
import {
  formatLlmTokenSummary,
  isLlmSpan,
  llmSpanTokenCounts,
} from "@/components/tracing/llm-span-detail";

/**
 * Stable identity for a captured trace row (a trace may fan out per case).
 * Non-evaluation traces from the collector index carry no case id; the trace
 * id alone identifies them.
 */
export function traceRowKey(trace: Pick<CapturedTraceSummary, "trace_id" | "example_id">): string {
  return `${trace.trace_id}::${trace.example_id ?? ""}`;
}

/** Open captured traces whether or not they belong to an evaluation. */
export function traceOpenHref(
  projectId: string,
  trace: Pick<CapturedTraceSummary, "trace_id" | "run_id">,
): string | null {
  return `/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(trace.trace_id)}`;
}

/* ── Collector-confirmed lifecycle chip ────────────────────────── */

export type LifecycleChipTone = "pass" | "warn" | "fail" | "neutral";

export interface LifecycleChipSpec {
  label: string;
  tone: LifecycleChipTone;
  detail: string;
}

/**
 * Honest per-state copy for the collector-confirmed lifecycle chip. Returns
 * null when the row has no lifecycle (legacy projection path) so the caller
 * can fall back to the capture-state chip instead of inventing a state.
 */
export function traceLifecycleChip(
  state: TraceLifecycleState | null | undefined,
): LifecycleChipSpec | null {
  switch (state) {
    case "requested":
      return {
        label: "Requested",
        tone: "neutral",
        detail: "Trace ID recorded; the span archive has not been checked yet.",
      };
    case "pending_export":
      return {
        label: "Pending export",
        tone: "warn",
        detail: "The span archive was checked and no spans have landed yet.",
      };
    case "archive_confirmed":
      return {
        label: "Archived",
        tone: "pass",
        detail: "Spans were confirmed in the trace archive; counts are real.",
      };
    case "archive_unavailable":
      return {
        label: "Archive unavailable",
        tone: "fail",
        detail: "The last archive check failed; span presence is unknown.",
      };
    default:
      return null;
  }
}

export function traceSpanEmptyMessage(
  archiveMessage: string | null | undefined,
  summaryMessage: string | null | undefined,
): string {
  return archiveMessage || summaryMessage ||
    "No archived span is available to inspect. The associated evaluation evidence remains available.";
}

/** Accumulated state of the Traces tab across successive "Load more" pages. */
export interface TracesPageState {
  items: CapturedTraceSummary[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
  hiddenCount: number;
}

export function emptyTracesPageState(): TracesPageState {
  return { items: [], total: 0, nextCursor: null, hasMore: false, hiddenCount: 0 };
}

/**
 * Fold a freshly fetched server page into the accumulated state. `reset`
 * replaces the list (first load / retry); otherwise the page is appended and
 * de-duplicated by trace+case key so a stable keyset cursor that re-emits a
 * boundary row cannot inflate the visible count. `hasMore` trusts the backend:
 * a non-null cursor, or a total that still exceeds what we hold.
 */
export function appendTracesPage(
  prev: TracesPageState,
  page: CapturedTracesPage,
  reset = false,
): TracesPageState {
  const base = reset ? [] : prev.items;
  const seen = new Set(base.map(traceRowKey));
  const items = [...base];
  for (const trace of page.items) {
    const key = traceRowKey(trace);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(trace);
  }
  const hasMore = page.has_more || page.next_cursor != null || page.total > items.length;
  return {
    items,
    total: page.total,
    nextCursor: page.next_cursor,
    hasMore,
    hiddenCount: page.hidden_count ?? 0,
  };
}

/**
 * Honest "showing N of M" annotation for the toolbar. Always shows the count;
 * never caps silently. Returns the count even when everything is loaded so the
 * user always sees the true denominator.
 */
export function tracesCountLabel(loaded: number, total: number): string {
  const denominator = Math.max(total, loaded);
  return `Showing ${loaded} of ${denominator} trace${denominator === 1 ? "" : "s"}`;
}

/** Whether the "Load more" control should be enabled. */
export function canLoadMoreTraces(state: TracesPageState): boolean {
  return state.hasMore && state.nextCursor != null;
}

/* ── Master-detail drawer: trace selection in the list URL ─────── */

export interface TraceSelection {
  trace: string | null;
  span: string | null;
}

/**
 * Read the drawer selection back from the traces-list URL. A `span` param is
 * only meaningful while a trace is open, so a dangling span (no trace) is
 * dropped rather than trusted.
 */
export function readTraceSelection(params: { get(key: string): string | null }): TraceSelection {
  const trace = params.get("trace") || null;
  return { trace, span: trace ? params.get("span") || null : null };
}

/**
 * Query string that opens/closes the drawer, preserving unrelated params (the
 * list filters). Clearing the trace always clears the span too — Escape/close
 * leaves no dangling span selection behind.
 */
export function writeTraceSelection(current: string, selection: TraceSelection): string {
  const params = new URLSearchParams(current);
  if (selection.trace) params.set("trace", selection.trace);
  else params.delete("trace");
  if (selection.trace && selection.span) params.set("span", selection.span);
  else params.delete("span");
  return params.toString();
}

/* ── Spans tab: keyset paging over the span index ──────────────── */

/** Stable identity for an indexed span row. */
export function spanRowKey(span: Pick<IndexedSpanSummary, "trace_id" | "span_id">): string {
  return `${span.trace_id}::${span.span_id}`;
}

/** Accumulated state of the Spans tab across successive "Load more" pages. */
export interface SpansPageState {
  items: IndexedSpanSummary[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export function emptySpansPageState(): SpansPageState {
  return { items: [], total: 0, nextCursor: null, hasMore: false };
}

/** Same folding rules as `appendTracesPage`, keyed by trace+span. */
export function appendSpansPage(
  prev: SpansPageState,
  page: IndexedSpansPage,
  reset = false,
): SpansPageState {
  const base = reset ? [] : prev.items;
  const seen = new Set(base.map(spanRowKey));
  const items = [...base];
  for (const span of page.items) {
    const key = spanRowKey(span);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(span);
  }
  const hasMore = page.has_more || page.next_cursor != null || page.total > items.length;
  return { items, total: page.total, nextCursor: page.next_cursor, hasMore };
}

export function spansCountLabel(loaded: number, total: number): string {
  const denominator = Math.max(total, loaded);
  return `Showing ${loaded} of ${denominator} span${denominator === 1 ? "" : "s"}`;
}

export function canLoadMoreSpans(state: SpansPageState): boolean {
  return state.hasMore && state.nextCursor != null;
}

/* ── Evaluation name -> run ID grouping ───────────────────────────── */

export interface TracingGroupingIdentity {
  evaluation_name?: string | null;
  run_id?: string | null;
  run_number?: number | null;
}

export interface TracingRunGroup<T> {
  key: string;
  runId: string | null;
  runIdLabel: string;
  items: T[];
}

export interface TracingEvaluationGroup<T> {
  key: string;
  evaluationName: string;
  itemCount: number;
  runs: TracingRunGroup<T>[];
}

export const UNLINKED_EVALUATION_NAME = "Not linked to an evaluation";
export const UNLINKED_RUN_NAME = "Not linked to a run";

/**
 * Group loaded trace/span rows by their persisted evaluation identity and then
 * by run identity. Map insertion order preserves the backend's newest-first
 * ordering. Missing linkage gets an explicit bucket; it is never presented as
 * a made-up evaluation or run.
 */
export function groupTracingResults<T extends TracingGroupingIdentity>(
  items: T[],
): TracingEvaluationGroup<T>[] {
  const evaluations = new Map<
    string,
    { evaluationName: string; itemCount: number; runs: Map<string, TracingRunGroup<T>> }
  >();

  for (const item of items) {
    const evaluationName = item.evaluation_name?.trim() || UNLINKED_EVALUATION_NAME;
    const evaluationKey = item.evaluation_name?.trim()
      ? `evaluation:${evaluationName}`
      : "evaluation:unlinked";
    let evaluation = evaluations.get(evaluationKey);
    if (!evaluation) {
      evaluation = { evaluationName, itemCount: 0, runs: new Map() };
      evaluations.set(evaluationKey, evaluation);
    }
    evaluation.itemCount += 1;

    const runId = item.run_id?.trim() || null;
    const runIdLabel = runId || UNLINKED_RUN_NAME;
    const runKey = runId ? `run:${runId}` : "run:unlinked";
    let run = evaluation.runs.get(runKey);
    if (!run) {
      run = { key: runKey, runId, runIdLabel, items: [] };
      evaluation.runs.set(runKey, run);
    }
    run.items.push(item);
  }

  return [...evaluations.entries()].map(([key, evaluation]) => ({
    key,
    evaluationName: evaluation.evaluationName,
    itemCount: evaluation.itemCount,
    runs: [...evaluation.runs.values()],
  }));
}

/** Same-page URL for opening a span in the trace drawer. */
export function spanTraceHref(
  projectId: string,
  traceId: string,
  spanId: string,
  currentQuery = "",
): string {
  const query = writeTraceSelection(currentQuery, { trace: traceId, span: spanId });
  return `/projects/${encodeURIComponent(projectId)}/spans?${query}`;
}

/* ── Inspector: span selection ─────────────────────────────────── */

/**
 * Resolve the selected span from a URL-supplied id. Falls back to the root span
 * (no parent) and then the first span, so a reload with a stale/absent `span`
 * param still lands on a real span. Returns "" only when there are no spans.
 */
export function resolveSelectedSpanId(spans: ArchivedTraceSpan[], requested: string | null): string {
  if (requested && spans.some((span) => span.span_id === requested)) return requested;
  const root = spans.find((span) => !span.parent_span_id);
  return root?.span_id ?? spans[0]?.span_id ?? "";
}

/**
 * Query string that selects a span, preserving any existing params. This is
 * what drives (and restores) the selection from the URL.
 */
export function spanSelectionQuery(current: string, spanId: string): string {
  const query = new URLSearchParams(current);
  if (spanId) query.set("span", spanId);
  else query.delete("span");
  return query.toString();
}

/**
 * Honest label for the "Archived spans" datum. A real count (including a
 * truthful `0`) is only shown once the archive request has succeeded; while it
 * is in flight this reads "Checking…" and after a failure "Unavailable", so a
 * loading/failed archive is never misrepresented as an empty result.
 */
export function archivedSpanLabel(
  spanCount: number | null,
  loading: boolean,
  error: string | null,
): string {
  if (spanCount != null) return String(spanCount);
  if (loading) return "Checking…";
  if (error) return "Unavailable";
  return "Not recorded";
}

/** Nesting depth of a span within the tree, cycle- and depth-guarded. */
export function spanDepth(spans: ArchivedTraceSpan[], span: ArchivedTraceSpan): number {
  const byId = new Map(spans.map((entry) => [entry.span_id, entry]));
  let level = 0;
  let parent = span.parent_span_id;
  const seen = new Set<string>();
  while (parent && byId.has(parent) && !seen.has(parent) && level < 24) {
    seen.add(parent);
    level += 1;
    parent = byId.get(parent)?.parent_span_id ?? null;
  }
  return level;
}

/* ── Inspector: span-tree enrichment (latency bars, kind, status) ─ */

/** Percent geometry for a span's proportional latency bar. */
export interface SpanBarMetric {
  /** Left inset of the bar, as a percentage of the trace window. */
  offsetPct: number;
  /** Width of the bar, as a percentage of the trace window. */
  widthPct: number;
}

/**
 * OTLP nano timestamps exceed 2^53, so they are parsed as BigInt; only the
 * (small) differences are converted back to Number for exact percentages.
 */
function parseNano(value: string | null): bigint | null {
  if (value == null || value === "") return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

const clampPct = (value: number): number => Math.min(100, Math.max(0, value));

/**
 * Proportional latency-bar geometry per span, aligned by index with the input.
 * Primary source is the start/end nano timestamps against the trace window
 * (min start → max end of the timestamped spans). A span with missing or
 * malformed timestamps gets `null` — no bar is ever fabricated. Only when *no*
 * span carries timestamps do we fall back to duration-magnitude bars
 * (offset 0, width relative to the longest `duration_ms`), since without
 * timestamps a temporal position cannot honestly be placed.
 */
export function spanBarMetrics(spans: ArchivedTraceSpan[]): Array<SpanBarMetric | null> {
  const windows = spans.map((span) => {
    const start = parseNano(span.start_time_unix_nano);
    const end = parseNano(span.end_time_unix_nano);
    if (start == null || end == null || end < start) return null;
    return { start, end };
  });
  const timestamped = windows.filter((entry) => entry != null);
  if (timestamped.length > 0) {
    let traceStart = timestamped[0].start;
    let traceEnd = timestamped[0].end;
    for (const entry of timestamped) {
      if (entry.start < traceStart) traceStart = entry.start;
      if (entry.end > traceEnd) traceEnd = entry.end;
    }
    const window = Number(traceEnd - traceStart);
    return windows.map((entry) => {
      if (!entry) return null;
      if (window <= 0) return { offsetPct: 0, widthPct: 100 };
      return {
        offsetPct: clampPct((Number(entry.start - traceStart) / window) * 100),
        widthPct: clampPct((Number(entry.end - entry.start) / window) * 100),
      };
    });
  }
  const maxDuration = spans.reduce(
    (max, span) => (span.duration_ms != null && span.duration_ms > max ? span.duration_ms : max),
    0,
  );
  return spans.map((span) => {
    if (span.duration_ms == null || span.duration_ms < 0) return null;
    if (maxDuration <= 0) return { offsetPct: 0, widthPct: 0 };
    return { offsetPct: 0, widthPct: clampPct((span.duration_ms / maxDuration) * 100) };
  });
}

/** OTLP SpanKind enum → lowercase label. 0 (UNSPECIFIED) is honestly absent. */
const OTLP_SPAN_KINDS: Record<number, string> = {
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

/**
 * Label for the span-kind chip. Prefers the semantic OpenInference kind
 * attribute (LLM, CHAIN, TOOL, …) over the transport-level OTLP kind; returns
 * null (no chip) when neither is present rather than inventing a default.
 */
export function spanKindLabel(span: Pick<ArchivedTraceSpan, "kind" | "attributes">): string | null {
  const semantic = span.attributes?.["openinference.span.kind"];
  if (typeof semantic === "string" && semantic.trim()) return semantic.trim().toLowerCase();
  if (span.kind != null) return OTLP_SPAN_KINDS[span.kind] ?? null;
  return null;
}

/**
 * Whether a span reports an error: an OTLP error status code (numeric 2 or a
 * string containing ERROR, e.g. "STATUS_CODE_ERROR") or a recorded
 * `exception` event. Unset/ok/absent status stays quiet.
 */
export function spanHasError(span: Pick<ArchivedTraceSpan, "status" | "events">): boolean {
  const code = span.status?.["code"];
  if (typeof code === "number" && code === 2) return true;
  if (typeof code === "string" && (code === "2" || code.toUpperCase().includes("ERROR"))) return true;
  return (span.events ?? []).some(
    (event) => typeof event?.["name"] === "string" && (event["name"] as string).toLowerCase() === "exception",
  );
}

/**
 * Wall-clock span start, e.g. "08/26/2026, 04:32:44 PM". The nano string goes
 * through Number, whose ~200ns error at epoch scale is invisible at the second
 * resolution shown; a missing or unparseable timestamp yields null rather than
 * an invented time.
 */
export function formatSpanStartTime(startTimeUnixNano: string | null | undefined): string | null {
  if (!startTimeUnixNano || !startTimeUnixNano.trim()) return null;
  const milliseconds = Number(startTimeUnixNano) / 1e6;
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

const TOKEN_COUNT_ATTRIBUTES = ["gen_ai.usage.total_tokens", "llm.token_count.total"] as const;

/**
 * Per-span total token count from the common GenAI/OpenInference attributes.
 * Accepts a non-negative number or numeric string; anything else is null so
 * the tree never shows a fabricated count.
 */
export function spanTokenCount(span: Pick<ArchivedTraceSpan, "attributes">): number | null {
  for (const key of TOKEN_COUNT_ATTRIBUTES) {
    const raw = span.attributes?.[key];
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : null;
    if (value != null && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/**
 * Honest LLM token breakdown aggregated across archived spans. Returns null
 * when no LLM span carries prompt/completion/cached/total counts.
 *
 * Only the innermost LLM spans are summed: a wrapper span that repeats its
 * child's usage would otherwise double-count, and the nesting is checked over
 * the whole ancestor chain (LLM → chain → LLM nests just as much as LLM → LLM).
 * A `total` is reported only when the spans that recorded one are exactly the
 * spans that recorded prompt/completion, so the line can never read
 * "100 prompt · 50 completion · 3000 total". When some LLM calls recorded no
 * usage at all, the line says how many did rather than presenting a partial
 * sum as the whole.
 */
export function traceLlmTokenHint(spans: ReadonlyArray<ArchivedTraceSpan>): string | null {
  const llmSpanIds = new Set(
    spans.filter((span) => isLlmSpan(span)).map((span) => span.span_id),
  );
  if (llmSpanIds.size === 0) return null;

  const parentOf = new Map<string, string | null>(
    spans.map((span) => [span.span_id, span.parent_span_id ?? null]),
  );
  // Mark every LLM span that has an LLM descendant. Each node's ancestor chain
  // is walked at most once (`walked`), which also terminates on a cycle.
  const shadowed = new Set<string>();
  const walked = new Set<string>();
  for (const id of llmSpanIds) {
    let parent = parentOf.get(id) ?? null;
    while (parent && !walked.has(parent)) {
      walked.add(parent);
      if (llmSpanIds.has(parent)) shadowed.add(parent);
      parent = parentOf.get(parent) ?? null;
    }
  }

  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let total = 0;
  let hasPrompt = false;
  let hasCompletion = false;
  let hasCached = false;
  let hasTotal = false;
  let counted = 0;
  let reported = 0;
  let spansWithParts = 0;
  let spansWithTotal = 0;
  let spansWithBoth = 0;
  for (const span of spans) {
    if (!llmSpanIds.has(span.span_id) || shadowed.has(span.span_id)) continue;
    counted += 1;
    const counts = llmSpanTokenCounts(span.attributes);
    const hasParts = counts.prompt != null || counts.completion != null;
    if (!hasParts && counts.cached == null && counts.total == null) continue;
    reported += 1;
    if (counts.prompt != null) {
      prompt += counts.prompt;
      hasPrompt = true;
    }
    if (counts.completion != null) {
      completion += counts.completion;
      hasCompletion = true;
    }
    if (counts.cached != null) {
      cached += counts.cached;
      hasCached = true;
    }
    if (counts.total != null) {
      total += counts.total;
      hasTotal = true;
      spansWithTotal += 1;
    }
    if (hasParts) spansWithParts += 1;
    if (hasParts && counts.total != null) spansWithBoth += 1;
  }

  // A total drawn from a different set of spans than the parts describes a
  // different population; drop it rather than imply the parts add up to it.
  const totalComparable =
    spansWithParts === 0 || (spansWithTotal === spansWithBoth && spansWithParts === spansWithBoth);
  const summary = formatLlmTokenSummary({
    prompt: hasPrompt ? prompt : null,
    completion: hasCompletion ? completion : null,
    cached: hasCached ? cached : null,
    total: hasTotal && totalComparable ? total : null,
  });
  if (summary == null) return null;

  const notes: string[] = [];
  if (reported < counted) notes.push(`usage from ${reported} of ${counted} LLM calls`);
  if (hasTotal && !totalComparable) notes.push("totals not reported by every call");
  return notes.length ? `${summary} · ${notes.join(" · ")}` : summary;
}

/* ── Honest partial-capture band ───────────────────────────────── */

export type TraceWarningTone = "warning" | "error";

export interface TraceWarning {
  id: "capture" | "attestation" | "invocation" | "pagination" | "lifecycle" | "truncated";
  tone: TraceWarningTone;
  label: string;
  detail: string;
}

/**
 * Compact, honest capture/attestation/invocation warnings. Nothing is upgraded:
 * a `partial` capture stays partial, an `unknown` attestation is surfaced as
 * unverified, and a failed invocation is flagged. A clean, fully attested,
 * successful trace produces no warnings.
 */
/**
 * Axis-differentiated warnings for the row inspector's archived-evidence view.
 * `RunItemTraceEvidence` carries three completeness booleans; each failing axis
 * gets its own line rather than one collapsed sentence, through the same
 * CaptureBand the sibling trace surfaces use.
 */
export function traceEvidenceWarnings(evidence: {
  pagination_complete: boolean;
  lifecycle_complete: boolean;
  truncated: boolean;
  evidence_complete: boolean;
}): TraceWarning[] {
  if (evidence.evidence_complete) return [];
  const warnings: TraceWarning[] = [];
  if (!evidence.pagination_complete) {
    warnings.push({
      id: "pagination",
      tone: "warning",
      label: "Archive read incomplete",
      detail: "Not every archive object for this trace was read; spans may be missing.",
    });
  }
  if (!evidence.lifecycle_complete) {
    warnings.push({
      id: "lifecycle",
      tone: "warning",
      label: "Trace lifecycle unfinished",
      detail: "The trace has not reached a terminal root span; later spans may still arrive.",
    });
  }
  if (evidence.truncated) {
    warnings.push({
      id: "truncated",
      tone: "warning",
      label: "Bounded result",
      detail: "The archive read hit its bounds or a lost object; the spans shown are a subset.",
    });
  }
  return warnings;
}

export function traceWarnings(
  trace: Pick<CapturedTraceSummary, "capture_state" | "attestation_state" | "invocation_outcome">,
): TraceWarning[] {
  const warnings: TraceWarning[] = [];
  if (trace.capture_state !== "captured") {
    warnings.push({
      id: "capture",
      tone: "warning",
      label: trace.capture_state === "partial" ? "Partial capture" : "Capture unknown",
      detail:
        trace.capture_state === "partial"
          ? "Only part of the lifecycle was captured. Absent spans are not shown as empty."
          : "Whether the lifecycle was fully captured could not be determined.",
    });
  }
  if (trace.attestation_state !== "attested") {
    warnings.push({
      id: "attestation",
      tone: "warning",
      label: trace.attestation_state === "not_attested" ? "Not attested" : "Attestation unknown",
      detail:
        "Completeness was not independently attested. Captured spans do not, by themselves, prove a complete lifecycle.",
    });
  }
  if (trace.invocation_outcome === "error") {
    warnings.push({
      id: "invocation",
      tone: "error",
      label: "Invocation failed",
      detail: "The target execution reported an error, so downstream evidence may be incomplete.",
    });
  }
  return warnings;
}

/* ── Inspector layout ──────────────────────────────────────────── */

export type InspectorVariant = "flow" | "page";

/**
 * Tailwind classes for the master–detail trace inspector (tree + detail).
 *
 * "flow" (row inspector, and every viewport below lg in the drawer) keeps the
 * document scroll: tree stays capped so a long span list cannot dwarf the page,
 * and the detail pane flows at its natural height inside the host scroll.
 *
 * "page" (full trace route and trace drawer on lg) pins the grid to the
 * viewport and gives each pane its own scroll.
 */
export function inspectorLayout(variant: InspectorVariant): {
  grid: string;
  section: string;
  tree: string;
  detail: string;
} {
  if (variant === "page") {
    return {
      // A ceiling, not a height. This was `h-[calc(100vh-8rem)]` with a 30rem
      // floor, so a trace with two spans still stretched both panes down the
      // whole viewport and the reader scrolled past empty panes to reach
      // anything below them. Now the panes are as tall as their content and
      // only start scrolling when they would outgrow the screen.
      grid: "lg:max-h-[calc(100vh-8rem)]",
      section: "lg:flex lg:min-h-0 lg:flex-col lg:overflow-hidden",
      tree: "max-h-[28rem] overflow-auto lg:max-h-none lg:min-h-0 lg:flex-1",
      detail: "lg:min-h-0 lg:flex-1 lg:overflow-y-auto",
    };
  }
  return {
    grid: "",
    section: "",
    tree: "max-h-[28rem] overflow-auto",
    detail: "",
  };
}
