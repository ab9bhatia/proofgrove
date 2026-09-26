"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { FilterSelect } from "@/components/toolbar";
import { groupTracingResults, type TracingGroupingIdentity } from "@/components/tracing/trace-workspace";

const GROUPING_KEY = "proofgrove.tracing.group-by";
export type Grouping = "none" | "evaluation" | "run";

export function useTracingGrouping() {
  const [grouping, setGrouping] = useState<Grouping>("none");
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        const saved = window.localStorage.getItem(GROUPING_KEY);
        if (saved === "evaluation" || saved === "run") setGrouping(saved);
      } catch { /* Storage is optional; the flat list remains usable. */ }
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  function changeGrouping(value: Grouping) {
    setGrouping(value);
    try { window.localStorage.setItem(GROUPING_KEY, value); } catch { /* Session choice still works. */ }
  }
  return [grouping, changeGrouping] as const;
}

export function GroupingSelect({ value, onChange }: { value: Grouping; onChange: (value: Grouping) => void }) {
  return (
    <FilterSelect label="Group by" value={value} onChange={(event) => onChange(event.target.value as Grouping)}>
      <option value="none">Group by: none</option>
      <option value="evaluation">Group by: evaluation</option>
      <option value="run">Group by: run</option>
    </FilterSelect>
  );
}

/** Grouping changes only presentation of loaded rows, never filters or selection. */
export function EvaluationRunGroups<T extends TracingGroupingIdentity>({
  items, itemNoun, renderItems, grouping,
}: {
  items: T[];
  itemNoun: "trace" | "span";
  renderItems: (items: T[]) => ReactNode;
  grouping: Grouping;
}) {
  const groups = new Map<string, { name: string; rows: T[] }>();
  if (grouping === "evaluation") {
    for (const group of groupTracingResults(items)) {
      groups.set(group.key, { name: group.evaluationName, rows: group.runs.flatMap((run) => run.items) });
    }
  } else if (grouping === "run") {
    for (const item of items) {
      const id = item.run_id?.trim();
      const key = id ? `run:${id}` : "unlinked";
      const group = groups.get(key) ?? { name: id || "Not linked to a run", rows: [] };
      group.rows.push(item);
      groups.set(key, group);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      {grouping === "none" ? <div className="panel overflow-hidden">{renderItems(items)}</div> : [...groups].map(([key, { name, rows }]) => (
        <details key={`${grouping}:${key}`} open className="group/tracing panel overflow-hidden">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 bg-muted/20 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <ChevronRight className="size-4 shrink-0 text-brand-text transition-transform group-open/tracing:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={name}>{name}</h2>
            <span className="text-xs tabular-nums text-muted-foreground">{rows.length} {itemNoun}{rows.length === 1 ? "" : "s"}</span>
          </summary>
          {renderItems(rows)}
        </details>
      ))}
    </div>
  );
}
