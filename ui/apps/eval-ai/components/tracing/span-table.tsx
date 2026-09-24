"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import type { IndexedSpanSummary } from "@/lib/api";
import { KindChip, SpanKindIcon } from "@/components/tracing/span-tree-pane";
import { formatDateTime } from "@/lib/format-time";
import { friendlySpanName, spanKindTone } from "@/components/tracing/span-tree";
import { spanRowKey, spanTraceHref } from "@/components/tracing/trace-workspace";
import { CopyIdButton } from "@/components/copyable-id";
import { formatDuration } from "@/lib/format-duration";
import { formatUsd } from "@/lib/format-usd";

/**
 * Project-wide span index table for the Spans tab. One row per archived span,
 * carrying bounded previews of what the span was given and produced — full
 * payloads stay in the archive. Selecting a row opens the trace drawer without
 * replacing this list. Wide content scrolls inside its own container.
 */
export function SpanTable({
  spans,
  sort = "newest",
  onSort,
  projectId,
  currentQuery = "",
  onOpenSpan,
  selectedKeys,
  onToggleSelection,
}: {
  sort?: string;
  onSort?: (sort: string) => void;
  spans: IndexedSpanSummary[];
  projectId: string;
  currentQuery?: string;
  onOpenSpan?: (span: IndexedSpanSummary) => void;
  selectedKeys?: Set<string>;
  onToggleSelection?: (span: IndexedSpanSummary) => void;
}) {
  const sorted = useMemo(() => [...spans].sort((a, b) => {
    if (sort === "duration" || sort === "duration-asc") {
      if (a.duration_ms == null) return b.duration_ms == null ? 0 : 1;
      if (b.duration_ms == null) return -1;
      return (a.duration_ms - b.duration_ms) * (sort === "duration-asc" ? 1 : -1);
    }
    const delta = (Date.parse(b.started_at || "") || 0) - (Date.parse(a.started_at || "") || 0);
    return sort === "oldest" ? -delta : delta;
  }), [spans, sort]);
  return (
    <div className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain">
      <table className="w-full min-w-[1240px] text-left text-sm">
        <caption className="sr-only">
          Captured spans with kind, name, input and output previews, token counts,
          estimated cost, duration, status and start time.
        </caption>
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            {onToggleSelection ? <th scope="col" className="px-2"><span className="sr-only">Select for scoring</span></th> : null}
            <th scope="col" className="px-4 py-3 font-medium">Kind</th>
            <th scope="col" className="px-4 py-3 font-medium">Span</th>
            <th scope="col" className="px-4 py-3 font-medium">Input</th>
            <th scope="col" className="px-4 py-3 font-medium">Output</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Tokens</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Cost</th>
            <th scope="col" className="px-4 py-3 text-right font-medium" aria-sort={sort.startsWith("duration") ? (sort === "duration-asc" ? "ascending" : "descending") : "none"}>
              {onSort ? <button type="button" className="inline-flex min-h-11 items-center gap-1 rounded uppercase tracking-[0.08em] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSort(sort === "duration" ? "duration-asc" : "duration")} title="Sort displayed rows">
                Duration<span aria-hidden="true">{sort.startsWith("duration") ? (sort === "duration-asc" ? "↑" : "↓") : "↕"}</span>
              </button> : "Duration"}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">Status</th>
            <th scope="col" className="px-4 py-3 font-medium" aria-sort={sort === "newest" || sort === "oldest" ? (sort === "oldest" ? "ascending" : "descending") : "none"}>
              {onSort ? <button type="button" className="inline-flex min-h-11 items-center gap-1 rounded uppercase tracking-[0.08em] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSort(sort === "newest" ? "oldest" : "newest")} title="Sort displayed rows">
                Started<span aria-hidden="true">{sort === "newest" || sort === "oldest" ? (sort === "oldest" ? "↑" : "↓") : "↕"}</span>
              </button> : "Started"}
            </th>
            <th scope="col" className="w-14"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {sorted.map((span) => {
            const href = spanTraceHref(projectId, span.trace_id, span.span_id, currentQuery);
            // What the span did, not how it travelled. The endpoint lists
            // classified spans only, so this is always set.
            const kindLabel = span.semantic_kind?.toLowerCase() ?? null;
            return (
              <tr
                key={spanRowKey(span)}
                data-href={href}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("input,button,label")) return;
                  if (onOpenSpan && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                    event.preventDefault();
                    onOpenSpan(span);
                    return;
                  }
                  if ((event.target as HTMLElement).closest("a")) return;
                  event.currentTarget.querySelector<HTMLAnchorElement>("a")?.click();
                }}
                className="cursor-pointer even:bg-muted/20 hover:bg-muted/50"
              >
              {onToggleSelection ? <td className="px-2"><label className="flex size-11 cursor-pointer items-center justify-center"><input type="checkbox" className="size-4 accent-primary" aria-label={`Select ${span.name} for scoring`} checked={selectedKeys?.has(spanRowKey(span)) ?? false} disabled={!selectedKeys?.has(spanRowKey(span)) && (selectedKeys?.size ?? 0) >= 100} onChange={() => onToggleSelection(span)} /></label></td> : null}
              <td className="px-4 py-3">
                {kindLabel ? <KindChip label={kindLabel} tone={spanKindTone(kindLabel)} /> : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="max-w-80 px-4 py-3">
                <p title={span.name} className="flex items-center gap-1.5 text-sm font-medium">
                  {kindLabel ? <SpanKindIcon label={kindLabel} /> : null}
                  <span className="truncate">{friendlySpanName(span.name)}</span>
                </p>
                <span className="mt-1 flex min-w-0 items-center gap-1">
                  <Link
                    href={href}
                    className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {compact(span.trace_id)}
                  </Link>
                  <CopyIdButton value={span.trace_id} kind="trace" />
                </span>
              </td>
              <PreviewCell text={span.input_preview} />
              <PreviewCell text={span.output_preview} />
              <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-foreground">
                <TokenCount
                  prompt={span.llm_token_count_prompt}
                  completion={span.llm_token_count_completion}
                />
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-foreground">
                {formatUsd(span.estimated_cost_usd) ?? <span title="Not priced">—</span>}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-foreground">
                {formatDuration(span.duration_ms) ?? "Not recorded"}
              </td>
              <td className="px-4 py-3">
                <StatusChip status={span.status} />
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-foreground">{formatDateTime(span.started_at)}</td>
              <td className="pr-2">
                {/* Same trailing-arrow affordance as TraceTable: one icon for
                    "open a row" across both tables, not a second vocabulary. */}
                <Link
                  href={href}
                  aria-label={`Open span ${span.span_id}`}
                  className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_TONES: Record<IndexedSpanSummary["status"], string> = {
  ok: "border-gate-pass/30 bg-gate-pass-soft text-gate-pass",
  error: "border-gate-fail/30 bg-gate-fail-soft text-gate-fail",
  unset: "border-border bg-muted/30 text-muted-foreground",
};

function StatusChip({ status }: { status: IndexedSpanSummary["status"] }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${STATUS_TONES[status]}`}>
      {status}
    </span>
  );
}

/**
 * Previews are already bounded server-side; the clamp keeps rows uniform and
 * the title carries the whole preview. `max-w-0` is what makes line-clamp bind
 * inside a table cell — without it the cell grows to its content instead.
 */
function PreviewCell({ text }: { text: string | null }) {
  return (
    <td className="w-[22%] max-w-0 px-4 py-3">
      {text ? (
        <p title={text} className="line-clamp-2 break-words text-xs text-muted-foreground">
          {text}
        </p>
      ) : (
        <span title="Not recorded" className="text-xs text-muted-foreground">—</span>
      )}
    </td>
  );
}

/** Prompt and completion counts, or an em dash when the span recorded neither. */
function TokenCount({ prompt, completion }: { prompt: number | null; completion: number | null }) {
  // Same treatment as the preview cells: an em dash alone cannot distinguish
  // "recorded nothing" from "recorded zero".
  if (prompt == null && completion == null) return <span title="Not recorded">—</span>;
  return (
    <span title={`${prompt ?? "not recorded"} prompt, ${completion ?? "not recorded"} completion`}>
      {prompt ?? "—"}
      <span aria-hidden="true"> / </span>
      <span className="sr-only">prompt, </span>
      {completion ?? "—"}
      <span className="sr-only"> completion</span>
    </span>
  );
}

function compact(value: string) {
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}
