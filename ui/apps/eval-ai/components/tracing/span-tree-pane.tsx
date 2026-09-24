"use client";

import { Bot, BrainCircuit, ChevronRight, GitBranch, Layers, ListFilter, Search, ShieldCheck, Sparkles, Wrench, type LucideIcon } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ErrorState, LoadingState } from "@/components/page-state";
import {
  cappedSpanRows,
  defaultExpandedSpanIds,
  expandSpanAncestors,
  filterSpanRows,
  isInfraSpan,
  friendlySpanName,
  spanCapExpandLabel,
  spanKindChip,
  spanTreeEmptyLabel,
  spanTreeKeyAction,
  spanTreeRows,
  toggleSpanExpanded,
  visibleSpanRows,
  type SpanKindTone,
} from "@/components/tracing/span-tree";
import {
  spanBarMetrics,
  spanHasError,
  spanTokenCount,
  type SpanBarMetric,
} from "@/components/tracing/trace-workspace";
import type { ArchivedTraceSpan } from "@/lib/api";
import { formatDuration } from "@/lib/format-duration";
import { cn } from "@evalai/shared/utils";

export function SpanTreePane({
  spans,
  loading,
  error,
  onRetry,
  selectedId,
  onSelect,
  emptyMessage,
  scrollClassName,
}: {
  spans: ArchivedTraceSpan[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  selectedId: string;
  onSelect: (spanId: string) => void;
  emptyMessage: string;
  scrollClassName: string;
}) {
  // Roving tabindex: the tree is a single tab stop (only the selected treeitem
  // is tabbable); ArrowUp/Down move, ArrowLeft/Right collapse/expand per the
  // ARIA tree pattern, Home/End jump to the ends.
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const allRows = useMemo(() => spanTreeRows(spans), [spans]);
  const [showOther, setShowOther] = useState(false);
  const selectedOther = allRows.some((row) => row.span.span_id === selectedId && isInfraSpan(row, allRows));
  const includeOther = showOther || selectedOther;
  const { rows } = useMemo(() => filterSpanRows(allRows, { hideInfra: !includeOther }), [allRows, includeOther]);
  const aiCount = allRows.filter((row) => !isInfraSpan(row, allRows)).length;
  const otherCount = allRows.length - aiCount;

  const [expanded, setExpanded] = useState<Set<string>>(() =>
    expandSpanAncestors(
      rows,
      defaultExpandedSpanIds(rows),
      selectedId,
    ),
  );
  const [showAll, setShowAll] = useState(false);

  // Render-time state adjustment (the documented "derive state from props"
  // pattern, not an effect): a new span set / filter re-seeds the default
  // expansion, and a URL-restored selection change opens its ancestors so the
  // selected row is always visible.
  const [seenRows, setSeenRows] = useState(rows);
  const [seenSelected, setSeenSelected] = useState(selectedId);
  if (seenRows !== rows) {
    setSeenRows(rows);
    setSeenSelected(selectedId);
    setExpanded(
      expandSpanAncestors(
        rows,
        defaultExpandedSpanIds(rows),
        selectedId,
      ),
    );
    setShowAll(false);
  } else if (seenSelected !== selectedId) {
    setSeenSelected(selectedId);
    setExpanded((prev) => expandSpanAncestors(rows, prev, selectedId));
  }

  const visible = useMemo(() => visibleSpanRows(rows, expanded), [rows, expanded]);
  const { rows: rendered, hiddenCount } = cappedSpanRows(visible, showAll);
  const barBySpan = useMemo(() => {
    const metrics = spanBarMetrics(spans);
    return new Map<ArchivedTraceSpan, SpanBarMetric | null>(spans.map((span, index) => [span, metrics[index] ?? null]));
  }, [spans]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const action = spanTreeKeyAction(rendered, index, event.key, expanded);
    if (action.type === "none") return;
    event.preventDefault();
    if (action.type === "move") {
      itemRefs.current[action.index]?.focus();
      const target = rendered[action.index];
      if (target) onSelect(target.span.span_id);
    } else if (action.type === "expand" || action.type === "collapse") {
      setExpanded((prev) => toggleSpanExpanded(prev, action.id));
    }
  };

  if (error) {
    return (
      <div className="p-4">
        <ErrorState title="Captured spans unavailable" message={error} onRetry={onRetry} />
      </div>
    );
  }
  if (loading) return <LoadingState label="Loading spans…" className="min-h-40" />;
  if (spans.length === 0) {
    return (
      <p className="p-4 text-sm leading-6 text-muted-foreground">
        {emptyMessage}
      </p>
    );
  }

  const selectedRendered = rendered.some((row) => row.span.span_id === selectedId);
  const totalSpans = rows.length;
  const matchLabel = `${aiCount} AI operation${aiCount === 1 ? "" : "s"}${includeOther ? ` · ${otherCount} unclassified spans` : ""}`;
  const capLabel = spanCapExpandLabel({
    visibleCount: visible.length,
    hiddenCount,
    matchCount: rows.length,
    totalSpans,
    filterActive: false,
  });

  return (
    <div className={cn("flex flex-col gap-2 p-2", scrollClassName)}>
      {/* Count the AI operations represented in the tree. */}
      <p aria-live="polite" className="border-b pb-2 text-xs text-muted-foreground">
        {matchLabel}
        {otherCount > 0 && !selectedOther ? (
          <button type="button" aria-pressed={showOther} className="ml-2 min-h-9 rounded px-2 font-medium text-brand-text focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setShowOther((value) => !value)}>
            {showOther ? "Hide unclassified spans" : `Show unclassified spans (${otherCount})`}
          </button>
        ) : null}
      </p>

      {rendered.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-6 text-sm leading-6 text-muted-foreground">
          {spanTreeEmptyLabel({ filterActive: false, hideInfra: true, emptyMessage })}
        </p>
      ) : (
      <div role="tree" aria-label="Captured spans (waterfall)">
        {rendered.map((row, index) => {
          const { span, depth, hasChildren } = row;
          const isSelected = span.span_id === selectedId;
          const isExpanded = hasChildren && expanded.has(span.span_id);
          const bar = barBySpan.get(span) ?? null;
          const kind = spanKindChip(span);
          const hasError = spanHasError(span);
          const tokens = spanTokenCount(span);
          return (
            <button
              type="button"
              key={`${span.span_id}-${index}`}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={isSelected}
              aria-expanded={hasChildren ? isExpanded : undefined}
              aria-current={isSelected ? "true" : undefined}
              tabIndex={isSelected || (!selectedRendered && index === 0) ? 0 : -1}
              onClick={(event) => {
                if (hasChildren && (event.target as HTMLElement).closest("[data-tree-toggle]")) {
                  setExpanded((prev) => toggleSpanExpanded(prev, span.span_id));
                  return;
                }
                onSelect(span.span_id);
              }}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={cn(
                "mb-1 grid min-h-11 w-full grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-2 rounded-lg border px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isSelected ? "border-foreground bg-muted/40" : "border-transparent hover:bg-muted/30",
              )}
            >
              {/* The indent guides, toggle and kind chip are the fixed overhead
                  of this row; the name is the one thing that must never lose
                  its fair share of what's left. The kind chip used to sit
                  beside the name (a shrink-0 label competing with it for
                  space) and each depth level cost 1.25rem — at depth 6+ inside
                  the narrower tree pane that left only a handful of
                  characters for the name, however wide the panel around it
                  was. Depth now costs less per level, and the chip moved down
                  to the meta line where it isn't fighting the name for room. */}
              <span className="flex min-w-0 items-stretch">
                {Array.from({ length: Math.min(depth, 8) }, (_, level) => (
                  level === Math.min(depth, 8) - 1 ? (
                    <span
                      key={level}
                      aria-hidden="true"
                      data-connector={row.isLastChild ? "last" : "mid"}
                      className="relative ml-1.5 w-2 shrink-0"
                    >
                      <span className={cn("absolute left-0 top-0 border-l border-border/60", row.isLastChild ? "h-1/2" : "bottom-0")} />
                      <span className="absolute left-0 top-1/2 w-full border-t border-border/60" />
                    </span>
                  ) : (
                    <span key={level} aria-hidden="true" className="ml-1.5 w-2 shrink-0 border-l border-border/60" />
                  )
                ))}
                <span
                  data-tree-toggle={hasChildren ? "true" : undefined}
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center self-start rounded",
                    hasChildren && "hover:bg-muted",
                  )}
                >
                  {hasChildren ? (
                    <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", isExpanded && "rotate-90")} aria-hidden="true" />
                  ) : null}
                </span>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {hasError ? (
                      <>
                        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                        <span className="sr-only">Error status.</span>
                      </>
                    ) : null}
                    {kind ? <SpanKindIcon label={kind.label} /> : null}
                    <span title={span.name} className="min-w-0 truncate text-sm font-medium">
                      {friendlySpanName(span.name)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-xs tabular-nums text-muted-foreground">
                    {kind ? <KindChip label={kind.label} tone={kind.tone} /> : null}
                    <span className="truncate">
                      {formatDuration(span.duration_ms) ?? "Duration not recorded"}
                      {tokens != null ? ` · ${tokens} tokens` : ""}
                      {hasChildren && !isExpanded ? " · collapsed" : ""}
                    </span>
                  </span>
                </span>
              </span>
              <span aria-hidden="true" className="block h-1.5 w-full self-center overflow-hidden rounded-full bg-muted/60">
                {bar ? (
                  <span
                    className={cn("block h-full rounded-full", hasError ? "bg-destructive/70" : "bg-foreground/40")}
                    style={{ marginLeft: `${bar.offsetPct}%`, width: `${Math.max(bar.widthPct, 1.5)}%` }}
                  />
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      )}
      {capLabel ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 w-full rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {capLabel}
        </button>
      ) : null}
    </div>
  );
}

const KIND_CHIP_TONES: Record<SpanKindTone, string> = {
  agent: "border-indigo-300 bg-indigo-500/10 text-indigo-700 dark:border-indigo-800 dark:text-indigo-300",
  llm: "border-purple-300 bg-purple-500/10 text-purple-700 dark:border-purple-800 dark:text-purple-300",
  tool: "border-sky-300 bg-sky-500/10 text-sky-700 dark:border-sky-800 dark:text-sky-300",
  chain: "border-state-positive/30 bg-state-positive-soft text-state-positive dark:border-state-positive/30 dark:text-state-positive",
  retriever: "border-state-caution/30 bg-state-caution-soft text-state-caution dark:border-state-caution/30 dark:text-state-caution",
  muted: "border-border text-muted-foreground",
};

const SPAN_ICONS: Record<string, LucideIcon> = { agent: Bot, llm: BrainCircuit, tool: Wrench, chain: GitBranch, retriever: Search, embedding: Layers, reranker: ListFilter, guardrail: ShieldCheck, evaluator: ShieldCheck, prompt: Sparkles };

export function SpanKindIcon({ label }: { label: string }) {
  const Icon = SPAN_ICONS[label.toLowerCase()];
  return Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null;
}

export function KindChip({ label, tone }: { label: string; tone: SpanKindTone }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded border px-1 py-px text-[10px] uppercase leading-4 tracking-wide",
        KIND_CHIP_TONES[tone],
      )}
    >
      {label}
    </span>
  );
}
