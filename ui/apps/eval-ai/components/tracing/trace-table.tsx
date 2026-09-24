"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import type { CapturedTraceSummary } from "@/lib/api";
import { formatDateTime } from "@/lib/format-time";
import { Chip, ToneBadge, type BadgeTone } from "@/components/status-badge";
import { friendlySpanName } from "@/components/tracing/span-tree";
import { traceOpenHref, traceRowKey } from "@/components/tracing/trace-workspace";
import { formatDuration } from "@/lib/format-duration";
import { formatUsd } from "@/lib/format-usd";
import { CopyIdButton } from "@/components/copyable-id";

/**
 * Two tiers per row, seven columns.
 *
 * This was eleven columns in which every cell was muted, so nothing anchored a
 * row and the table needed 1150px and a whole parallel card layout to survive
 * a narrow viewport. Related facts now pair vertically — the id and root span
 * under the input, the error count under the span count, the evaluation state
 * under the start time — which fits the table in a 720px column and lets one
 * markup serve every width.
 *
 * The identity line is the only text at full contrast and the outcome badge is
 * the only colour, apart from a non-zero error count. The surface belongs to
 * the run group around this table, not to the table.
 */
export function TraceTable({
  traces,
  sort = "newest",
  onSort,
  projectId,
  onOpenTrace,
  onToggleHidden,
  visibilityBusyId,
}: {
  sort?: string;
  onSort?: (sort: string) => void;
  traces: CapturedTraceSummary[];
  projectId: string;
  /**
   * When provided, selecting a row opens the master-detail drawer instead of
   * navigating. The hrefs stay real, so modified clicks (new tab) keep
   * full-page navigation as the deep link.
   */
  onOpenTrace?: (trace: CapturedTraceSummary) => void;
  onToggleHidden?: (trace: CapturedTraceSummary) => void;
  visibilityBusyId?: string | null;
}) {
  const sorted = useMemo(() => [...traces].sort((a, b) => {
    if (sort === "duration" || sort === "duration-asc") {
      if (a.latency_ms == null) return b.latency_ms == null ? 0 : 1;
      if (b.latency_ms == null) return -1;
      return (a.latency_ms - b.latency_ms) * (sort === "duration-asc" ? 1 : -1);
    }
    const delta = (Date.parse(b.captured_at || "") || 0) - (Date.parse(a.captured_at || "") || 0);
    return sort === "oldest" ? -delta : delta;
  }), [traces, sort]);
  return (
    <div className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain">
      <table className="w-full min-w-[680px] text-left text-sm">
        <caption className="sr-only">
          Captured traces. Each row shows the recorded input with its trace id and root span, the
          invocation outcome, span and error counts, latency, tokens, estimated cost, and the
          start time with evaluation state.
        </caption>
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">Trace</th>
            <th scope="col" className="px-4 py-3 font-medium">Status</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">AI operations</th>
            <th scope="col" className="px-4 py-3 text-right font-medium" aria-sort={sort.startsWith("duration") ? (sort === "duration-asc" ? "ascending" : "descending") : "none"}>
              {onSort ? <button type="button" className="inline-flex min-h-11 items-center gap-1 rounded uppercase tracking-[0.08em] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSort(sort === "duration" ? "duration-asc" : "duration")} title="Sort displayed rows">
                Latency<span aria-hidden="true">{sort.startsWith("duration") ? (sort === "duration-asc" ? "↑" : "↓") : "↕"}</span>
              </button> : "Latency"}
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Tokens</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Cost</th>
            <th scope="col" className="px-4 py-3 font-medium" aria-sort={sort === "newest" || sort === "oldest" ? (sort === "oldest" ? "ascending" : "descending") : "none"}>
              {onSort ? <button type="button" className="inline-flex min-h-11 items-center gap-1 rounded uppercase tracking-[0.08em] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSort(sort === "newest" ? "oldest" : "newest")} title="Sort displayed rows">
                Started<span aria-hidden="true">{sort === "newest" || sort === "oldest" ? (sort === "oldest" ? "↑" : "↓") : "↕"}</span>
              </button> : "Started"}
            </th>
            <th scope="col" className="w-20"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {sorted.map((trace) => {
            const href = traceOpenHref(projectId, trace);
            return (
              <tr
                key={traceRowKey(trace)}
                data-href={href ?? undefined}
                onClick={(event) => {
                  if (!href) return;
                  // Drawer mode: plain clicks (row or its links) open the
                  // inline inspector; modified clicks fall through to the
                  // real hrefs so "open in new tab" still works.
                  if (onOpenTrace && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                    event.preventDefault();
                    onOpenTrace(trace);
                    return;
                  }
                  // Whole-row navigation by delegating to the row's own Next
                  // Link (keeps client-side routing without a router hook).
                  // Clicks landing on an anchor are already handled by it.
                  if ((event.target as HTMLElement).closest("a")) return;
                  event.currentTarget.querySelector<HTMLAnchorElement>("a")?.click();
                }}
                className={`align-top even:bg-muted/20 hover:bg-muted/50 ${href ? "cursor-pointer" : ""} ${trace.hidden ? "opacity-70" : ""}`}
              >
                <td className="max-w-sm px-4 py-3">
                  <p className="truncate font-medium text-foreground">
                    {trace.input_summary || trace.root_span_name || trace.evaluation_name || "Input not recorded"}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      {href ? (
                        <Link className="font-mono hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={href}>
                          {compact(trace.trace_id)}
                        </Link>
                      ) : (
                        <span className="font-mono">{compact(trace.trace_id)}</span>
                      )}
                      <CopyIdButton value={trace.trace_id} kind="trace" />
                    </span>
                    {trace.root_span_name ? (
                      <span className="truncate font-mono" title={trace.root_span_name}>
                        <span className="sr-only">Root span: </span>
                        {friendlySpanName(trace.root_span_name)}
                      </span>
                    ) : null}
                    {trace.root_span_kind ? <Chip className="text-[10px] uppercase tracking-wide">{trace.root_span_kind.toLowerCase()}</Chip> : null}
                    {trace.hidden ? <span className="font-medium">Hidden</span> : null}
                  </p>
                </td>
                <td className="px-4 py-3">
                  <ToneBadge tone={outcomeTone(trace.invocation_outcome)}>
                    {trace.invocation_outcome.replaceAll("_", " ")}
                  </ToneBadge>
                </td>
                <td className="px-4 py-3 text-right">
                  <p className="tabular-nums text-foreground">{trace.span_count ?? "—"}</p>
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                    <span className="sr-only">Errors: </span>
                    {trace.error_count && href ? <Link href={`${href}${href.includes("?") ? "&" : "?"}errors=1`} onClick={(event) => event.stopPropagation()} className="inline-flex min-h-8 items-center text-accent-foreground underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring">{trace.error_count} error{trace.error_count === 1 ? "" : "s"}</Link> : trace.error_count == null ? "Not checked" : "0 errors"}
                  </p>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-foreground">{formatLatency(trace.latency_ms)}</td>
                <td className="px-4 py-3 text-right">
                  <p className="tabular-nums text-foreground">{formatTokens(trace.total_tokens)}</p>
                  {/* Only when the trace carries one. "No revision" printed
                      under every token count on every row, which is a line of
                      type that never says anything. */}
                  {trace.target_revision ? (
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      <span className="sr-only">Target revision: </span>
                      {trace.target_revision}
                    </p>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-foreground">
                  {formatUsd(trace.cost) ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <p className="text-foreground">{formatDateTime(trace.captured_at)}</p>
                  <p className="mt-1 text-xs capitalize text-muted-foreground">
                    <span className="sr-only">Evaluation: </span>
                    {(trace.evaluation_status || "not_evaluated").replaceAll("_", " ")}
                  </p>
                </td>
                <td className="pr-2"><div className="flex items-center justify-end gap-1">
                  {href ? (
                    /* Real affordance, not decoration: a focusable link so the
                       arrow works for keyboard and assistive tech too. */
                    <Link
                      href={href}
                      aria-label={`Open trace ${trace.trace_id}`}
                      className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ArrowRight className="size-4" aria-hidden="true" />
                    </Link>
                  ) : null}
                  {trace.lifecycle_state && onToggleHidden ? (
                    <VisibilityButton
                      trace={trace}
                      busy={visibilityBusyId === trace.trace_id}
                      onToggle={onToggleHidden}
                    />
                  ) : null}
                </div></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VisibilityButton({
  trace,
  busy,
  onToggle,
  className = "",
}: {
  trace: CapturedTraceSummary;
  busy: boolean;
  onToggle: (trace: CapturedTraceSummary) => void;
  className?: string;
}) {
  const hidden = Boolean(trace.hidden);
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={`${hidden ? "Unhide" : "Hide"} trace ${trace.trace_id}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(trace);
      }}
      className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border px-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${className}`}
    >
      {hidden ? <Eye className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
      <span className={className ? "" : "sr-only"}>{hidden ? "Unhide" : "Hide"}</span>
    </button>
  );
}

/**
 * The invocation outcome, and nothing else.
 *
 * A green "succeeded" beside a red "2 errors" reads as a contradiction, but the
 * two describe different things: the call returned, and some spans inside it
 * recorded errors. Repainting the status amber whenever any span errored was the
 * wrong half to soften — it makes almost every row amber and calls a successful
 * invocation questionable. The count is the detail, so the count is what stops
 * shouting.
 */
function outcomeTone(value: string): BadgeTone {
  const normalized = value.toLowerCase();
  if (["error", "failed"].includes(normalized)) return "fail";
  if (["partial", "not_attested"].includes(normalized)) return "warn";
  if (["captured", "attested", "succeeded", "evaluated", "complete"].includes(normalized)) return "pass";
  return "neutral";
}

function compact(value: string) { return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value; }
function formatLatency(value: number | null) { return formatDuration(value) ?? "—"; }
// Fixed locale: this renders on the server too, and a locale-dependent
// separator would differ between the server and client passes.
function formatTokens(value: number | null) { return value == null ? "—" : value.toLocaleString("en-US"); }
