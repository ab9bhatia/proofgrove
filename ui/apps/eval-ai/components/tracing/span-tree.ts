// Pure, framework-free span-tree logic for the trace inspector: depth-first
// row ordering, expand/collapse state, the ARIA tree keyboard contract, the
// honest initial-render cap, and semantic kind chips. Kept out of the React
// component so every rule is unit-testable in node.

import type { ArchivedTraceSpan } from "@/lib/api";
import { spanHasError } from "@/components/tracing/trace-workspace";

/** Compact instrumentation namespaces while preserving the operation suffix. */
export function friendlySpanName(name: string): string {
  const parts = name.split(".");
  return parts.length > 3
    ? `${parts[0]}.…${parts.slice(-2).join(".")}`
    : name;
}

export interface SpanTreeRow {
  span: ArchivedTraceSpan;
  /** Nesting depth (0 = root). */
  depth: number;
  /** True when at least one child row renders beneath this one. */
  hasChildren: boolean;
  /** Parent span id, or null for (effective) roots. */
  parentId: string | null;
  /** True when no sibling follows this row under the same parent. */
  isLastChild: boolean;
}

/**
 * Depth-first rows for a flat archived-span list. Children render under their
 * parent in original array order. Orphans (parent id absent from the payload)
 * and self-parenting spans become roots rather than being dropped, and parent
 * cycles are broken by visiting each span exactly once — no span is ever lost
 * or duplicated.
 */
export function spanTreeRows(spans: ArchivedTraceSpan[]): SpanTreeRow[] {
  const byId = new Map<string, ArchivedTraceSpan>();
  for (const span of spans) if (!byId.has(span.span_id)) byId.set(span.span_id, span);

  const children = new Map<string, ArchivedTraceSpan[]>();
  const roots: ArchivedTraceSpan[] = [];
  for (const span of spans) {
    const parentId = span.parent_span_id;
    if (parentId && parentId !== span.span_id && byId.has(parentId)) {
      const list = children.get(parentId);
      if (list) list.push(span);
      else children.set(parentId, [span]);
    } else {
      roots.push(span);
    }
  }

  const rows: SpanTreeRow[] = [];
  const visited = new Set<ArchivedTraceSpan>();
  // Iterative DFS: archived traces can be arbitrarily deep chains.
  const walk = (root: ArchivedTraceSpan, rootParentId: string | null, rootIsLast: boolean) => {
    const stack: Array<{ span: ArchivedTraceSpan; depth: number; parentId: string | null; isLastChild: boolean }> = [
      { span: root, depth: 0, parentId: rootParentId, isLastChild: rootIsLast },
    ];
    while (stack.length > 0) {
      const { span, depth, parentId, isLastChild } = stack.pop()!;
      if (visited.has(span)) continue;
      visited.add(span);
      const kids = (children.get(span.span_id) ?? []).filter((kid) => !visited.has(kid));
      rows.push({ span, depth, hasChildren: kids.length > 0, parentId, isLastChild });
      for (let i = kids.length - 1; i >= 0; i -= 1) {
        stack.push({
          span: kids[i],
          depth: depth + 1,
          parentId: span.span_id,
          isLastChild: i === kids.length - 1,
        });
      }
    }
  };
  roots.forEach((root, index) => walk(root, null, index === roots.length - 1));
  // Cycle members reach no root; seed the first unvisited span as a root.
  for (const span of spans) if (!visited.has(span)) walk(span, null, true);
  return rows;
}

/** Depth threshold beneath which parents start collapsed by default. */
const DEFAULT_EXPANDED_DEPTH = 2;

/**
 * Default expansion: parents above depth 2 start open (so the tree shows three
 * levels), deeper parents start collapsed. Leaves never enter the set.
 */
export function defaultExpandedSpanIds(
  rows: SpanTreeRow[],
  depthLimit = DEFAULT_EXPANDED_DEPTH,
): Set<string> {
  const expanded = new Set<string>();
  for (const row of rows) {
    // Transport spans are never rendered, so an infra row here would be a
    // wrapper the tree already dropped.
    if (row.hasChildren && row.depth < depthLimit) {
      expanded.add(row.span.span_id);
    }
  }
  return expanded;
}

/** Immutable expand/collapse toggle. */
export function toggleSpanExpanded(expanded: ReadonlySet<string>, spanId: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(spanId)) next.delete(spanId);
  else next.add(spanId);
  return next;
}

/** Rows whose every ancestor is expanded, in tree order. */
export function visibleSpanRows(rows: SpanTreeRow[], expanded: ReadonlySet<string>): SpanTreeRow[] {
  const visibleIds = new Set<string>();
  const visible: SpanTreeRow[] = [];
  for (const row of rows) {
    if (row.parentId == null || (visibleIds.has(row.parentId) && expanded.has(row.parentId))) {
      visibleIds.add(row.span.span_id);
      visible.push(row);
    }
  }
  return visible;
}

/**
 * Expand every ancestor of `spanId` so a URL-restored selection is visible.
 * Returns the input set unchanged (same instance) when nothing needs opening,
 * so callers can use it directly in a state updater without churn.
 */
export function expandSpanAncestors(
  rows: SpanTreeRow[],
  expanded: Set<string>,
  spanId: string | null,
): Set<string> {
  if (!spanId) return expanded;
  const byId = new Map(rows.map((row) => [row.span.span_id, row]));
  const missing: string[] = [];
  let parentId = byId.get(spanId)?.parentId ?? null;
  while (parentId) {
    if (!expanded.has(parentId)) missing.push(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  if (missing.length === 0) return expanded;
  const next = new Set(expanded);
  for (const id of missing) next.add(id);
  return next;
}

export type SpanTreeKeyAction =
  | { type: "move"; index: number }
  | { type: "expand"; id: string }
  | { type: "collapse"; id: string }
  | { type: "none" };

/**
 * ARIA tree keyboard contract over the currently *visible* rows:
 * Up/Down move (clamped, no wrap), Home/End jump, ArrowRight expands a
 * collapsed parent then steps into the first child, ArrowLeft collapses an
 * expanded parent and otherwise jumps to the parent row.
 */
export function spanTreeKeyAction(
  visible: SpanTreeRow[],
  index: number,
  key: string,
  expanded: ReadonlySet<string>,
): SpanTreeKeyAction {
  const row = visible[index];
  if (!row) return { type: "none" };
  const move = (target: number): SpanTreeKeyAction =>
    target === index || target < 0 || target >= visible.length ? { type: "none" } : { type: "move", index: target };
  switch (key) {
    case "ArrowDown":
      return move(index + 1);
    case "ArrowUp":
      return move(index - 1);
    case "Home":
      return move(0);
    case "End":
      return move(visible.length - 1);
    case "ArrowRight": {
      if (!row.hasChildren) return { type: "none" };
      if (!expanded.has(row.span.span_id)) return { type: "expand", id: row.span.span_id };
      // Expanded parent: the first child is the next visible row.
      return move(index + 1);
    }
    case "ArrowLeft": {
      if (row.hasChildren && expanded.has(row.span.span_id)) {
        return { type: "collapse", id: row.span.span_id };
      }
      if (!row.parentId) return { type: "none" };
      const parentIndex = visible.findIndex((entry) => entry.span.span_id === row.parentId);
      return parentIndex === -1 ? { type: "none" } : { type: "move", index: parentIndex };
    }
    default:
      return { type: "none" };
  }
}

/**
 * How many rows render before the honest "Show all N spans" expander takes
 * over. No virtualisation — just a truthful cap with an explicit count.
 */
export const INITIAL_SPAN_RENDER_CAP = 150;

export function cappedSpanRows(
  rows: SpanTreeRow[],
  showAll: boolean,
  cap = INITIAL_SPAN_RENDER_CAP,
): { rows: SpanTreeRow[]; hiddenCount: number } {
  if (showAll || rows.length <= cap) return { rows, hiddenCount: 0 };
  // Never split an expanded parent from its children: an item advertising
  // aria-expanded=true whose first child sits past the cut would dead-end
  // ArrowRight. Retreat the cut to a subtree boundary — the next kept row must
  // not be deeper than the row before the cut.
  let cut = cap;
  while (cut > 1 && rows[cut].depth > rows[cut - 1].depth) {
    cut -= 1;
  }
  return { rows: rows.slice(0, cut), hiddenCount: rows.length - cut };
}

/* ── Kind chips ────────────────────────────────────────────────── */

export type SpanKindTone = "agent" | "llm" | "tool" | "chain" | "retriever" | "muted";

const SEMANTIC_KIND_TONES: Record<string, SpanKindTone> = {
  agent: "agent",
  llm: "llm",
  tool: "tool",
  chain: "chain",
  retriever: "retriever",
};

/** Tone for an already-resolved kind label (also used by the Spans tab index rows). */
export function spanKindTone(label: string): SpanKindTone {
  return SEMANTIC_KIND_TONES[label.trim().toLowerCase()] ?? "muted";
}

/**
 * Display the recorded OpenInference type. Untyped spans stay generic; their
 * names and OpenTelemetry transport kinds do not determine an AI type.
 */
export function spanKindChip(
  span: Pick<ArchivedTraceSpan, "name" | "kind" | "attributes">,
): { label: string; tone: SpanKindTone } | null {
  const semantic = semanticSpanKind(span);
  if (typeof semantic === "string" && semantic.trim()) {
    const label = semantic.trim().toLowerCase();
    return { label, tone: spanKindTone(label) };
  }
  return { label: "span", tone: "muted" };
}

/* ── Infra detection + span search/filter ──────────────────────── */

/** Native type takes precedence; compatibility is resolved once by the API. */
export function semanticSpanKind(span: Pick<ArchivedTraceSpan, "attributes" | "semantic_kind">): string | null {
  const recorded = span.attributes?.["openinference.span.kind"];
  return typeof recorded === "string" && recorded.trim() ? recorded.trim().toLowerCase() : span.semantic_kind ?? null;
}

export function isInfraSpan(row: SpanTreeRow, _allRows: ReadonlyArray<SpanTreeRow>): boolean {
  return semanticSpanKind(row.span) === null;
}

export type SpanRowFilter = {
  query?: string;
  /** Kind chip labels (semantic or OTLP), lowercased comparison. */
  kinds?: ReadonlyArray<string>;
  status?: "error" | "ok";
  minDurationMs?: number;
  /** When true, drop infra spans and rebuild so their children become roots. */
  hideInfra?: boolean;
};

function attributeHaystack(span: ArchivedTraceSpan): string {
  const parts: string[] = [span.name];
  for (const [key, value] of Object.entries(span.attributes ?? {})) {
    parts.push(key);
    if (value == null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
    }
  }
  return parts.join("\n").toLowerCase();
}

function rowMatchesFilter(row: SpanTreeRow, filter: SpanRowFilter): boolean {
  if (filter.query?.trim()) {
    const q = filter.query.trim().toLowerCase();
    if (!attributeHaystack(row.span).includes(q)) return false;
  }
  if (filter.kinds && filter.kinds.length > 0) {
    const chip = spanKindChip(row.span);
    const label = chip?.label ?? "";
    const wanted = new Set(filter.kinds.map((kind) => kind.trim().toLowerCase()).filter(Boolean));
    if (!wanted.has(label)) return false;
  }
  if (filter.status === "error" && !spanHasError(row.span)) return false;
  if (filter.status === "ok" && spanHasError(row.span)) return false;
  if (filter.minDurationMs != null) {
    if (row.span.duration_ms == null || row.span.duration_ms < filter.minDurationMs) return false;
  }
  return true;
}

function collectAncestors(rows: ReadonlyArray<SpanTreeRow>, spanId: string): string[] {
  const byId = new Map(rows.map((row) => [row.span.span_id, row]));
  const ancestors: string[] = [];
  let parentId = byId.get(spanId)?.parentId ?? null;
  while (parentId) {
    ancestors.push(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return ancestors;
}

export interface SpanRowFilterResult {
  rows: SpanTreeRow[];
  /** Primary matches present in ``rows`` (not ancestors). */
  matchCount: number;
  matchedIds: Set<string>;
  /** Network / transport spans the ``hideInfra`` toggle removed from the tree. */
  infraHiddenCount: number;
  /**
   * Primary matches of an *active* query/kind/status/duration filter that the
   * ``hideInfra`` toggle removed. They exist and satisfy the filter, so a count
   * that ignored them would report "0 match" for a span that is really there.
   * Zero when no such filter is active (every row matches trivially then).
   */
  matchesHiddenByInfra: number;
}

/**
 * Filter span-tree rows by query / kind / status / duration. Matching spans
 * keep their ancestor chain so the path stays visible; ancestors that are not
 * themselves matches are absent from ``matchedIds`` (UI dims them).
 * ``matchCount`` is the number of primary matches (not ancestors), and the
 * hidden counts report exactly what the transport toggle removed.
 */
export function filterSpanRows(
  rows: SpanTreeRow[],
  filter: SpanRowFilter = {},
): SpanRowFilterResult {
  const hasActive =
    Boolean(filter.query?.trim()) ||
    (filter.kinds?.length ?? 0) > 0 ||
    filter.status != null ||
    filter.minDurationMs != null;

  const matchedIds = new Set<string>();
  for (const row of rows) {
    if (!hasActive || rowMatchesFilter(row, filter)) matchedIds.add(row.span.span_id);
  }

  if (!filter.hideInfra) {
    const keep = new Set(matchedIds);
    for (const id of matchedIds) {
      for (const ancestorId of collectAncestors(rows, id)) keep.add(ancestorId);
    }
    return {
      rows: rows.filter((row) => keep.has(row.span.span_id)),
      matchCount: matchedIds.size,
      matchedIds,
      infraHiddenCount: 0,
      matchesHiddenByInfra: 0,
    };
  }

  const infraIds = new Set<string>();
  for (const row of rows) {
    if (isInfraSpan(row, rows)) infraIds.add(row.span.span_id);
  }
  // Only an explicit query/kind/status/duration filter produces "matches"; with
  // no filter every row matches trivially, and the infra count already says how
  // many rows went away.
  let matchesHiddenByInfra = 0;
  for (const id of infraIds) {
    if (matchedIds.delete(id) && hasActive) matchesHiddenByInfra += 1;
  }

  const keep = new Set(matchedIds);
  for (const id of matchedIds) {
    for (const ancestorId of collectAncestors(rows, id)) keep.add(ancestorId);
  }
  for (const id of infraIds) keep.delete(id);

  const spans = rows.filter((row) => keep.has(row.span.span_id)).map((row) => row.span);
  const byId = new Map(rows.map((row) => [row.span.span_id, row]));
  const original = new Map(spans.map((span) => [span.span_id, span]));
  const projected = spans.map((span) => {
    let parentId = byId.get(span.span_id)?.parentId ?? null;
    while (parentId && !keep.has(parentId)) parentId = byId.get(parentId)?.parentId ?? null;
    return { ...span, parent_span_id: parentId };
  });
  const rebuilt = spanTreeRows(projected).map((row) => ({ ...row, span: original.get(row.span.span_id)! }));
  const present = new Set(rebuilt.map((row) => row.span.span_id));
  const stillMatched = new Set([...matchedIds].filter((id) => present.has(id)));
  return {
    rows: rebuilt,
    matchCount: stillMatched.size,
    matchedIds: stillMatched,
    infraHiddenCount: infraIds.size,
    matchesHiddenByInfra,
  };
}

/**
 * Honest match-count line for the span tree toolbar. Hiding transport spans is
 * a filter like any other: whenever it removes rows the line states the shown
 * count against the full span count and names what it dropped, so the tree can
 * never render 120 rows under the caption "400 spans". When the transport
 * toggle swallowed spans the search itself matched, the line says how many —
 * "0 of 400 spans match" alone would deny a span the user can see exists.
 *
 * The total here is the same number the trace summary already states as
 * "Archived spans" one section up, so this says "archived" rather than a bare
 * "spans" — the same word in both places, instead of a reader having to work
 * out that "119" and "6 of 119" name the same total two different ways.
 */
export function spanMatchCountLabel(
  matchCount: number,
  totalSpans: number,
  filterActive: boolean,
  hidden: { infraHiddenCount?: number; matchesHiddenByInfra?: number } = {},
): string {
  const infraHidden = hidden.infraHiddenCount ?? 0;
  const matchesHidden = hidden.matchesHiddenByInfra ?? 0;
  const parts: string[] = [];
  if (filterActive) parts.push(`${matchCount} of ${totalSpans} spans match`);
  else if (infraHidden > 0) parts.push(`${matchCount} shown of ${totalSpans} archived`);
  else parts.push(`${totalSpans} spans`);
  if (infraHidden > 0) {
    const dropped = `${infraHidden} transport span${infraHidden === 1 ? "" : "s"} hidden`;
    parts.push(matchesHidden > 0 ? `${dropped}, ${matchesHidden} matching` : dropped);
  }
  return parts.join(" · ");
}

/**
 * Empty-tree copy. A search or kind/status/duration filter that matched nothing
 * is reported as such *first*: checking ``hideInfra`` before it would blame the
 * transport toggle for a query that simply has no hits. When the toggle really
 * did swallow the only matches, the copy names them and points at the switch.
 */
export function spanTreeEmptyLabel(opts: {
  filterActive: boolean;
  hideInfra: boolean;
  matchesHiddenByInfra?: number;
  emptyMessage: string;
}): string {
  if (opts.filterActive) {
    const hidden = opts.matchesHiddenByInfra ?? 0;
    if (hidden > 0) {
      const subject =
        hidden === 1 ? "1 matching unclassified span is" : `${hidden} matching unclassified spans are`;
      return `No spans match these filters among AI operations. ${subject} hidden — enable Show unclassified spans to see them.`;
    }
    return "No spans match these filters.";
  }
  if (opts.hideInfra) {
    return "No OpenInference span types were recorded. Show unclassified spans to inspect the captured steps.";
  }
  return opts.emptyMessage;
}

/**
 * Cap expander copy. When a filter is active, state filtered totals so the
 * 150-row cap never silently truncates the match set.
 */
export function spanCapExpandLabel(opts: {
  visibleCount: number;
  hiddenCount: number;
  matchCount: number;
  totalSpans: number;
  filterActive: boolean;
  infraHiddenCount?: number;
}): string | null {
  if (opts.hiddenCount <= 0) return null;
  if (opts.filterActive) {
    return `Show all ${opts.visibleCount} matching spans (${opts.hiddenCount} more of ${opts.matchCount} matches · ${opts.totalSpans} total)`;
  }
  if ((opts.infraHiddenCount ?? 0) > 0) {
    return `Show all ${opts.visibleCount} spans (${opts.hiddenCount} more of ${opts.matchCount} shown · ${opts.totalSpans} total)`;
  }
  return `Show all ${opts.visibleCount} spans (${opts.hiddenCount} more)`;
}
