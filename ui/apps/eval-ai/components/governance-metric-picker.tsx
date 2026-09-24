"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@evalai/shared/utils";
import type { MetricCatalogEntry } from "@/lib/api";
import { METRIC_GROUPS, metricMeaning } from "@/components/metric-selection-panel";
import { SearchField } from "@/components/toolbar";

/**
 * The grouped check picker from the evaluation workbench, in the shape a governance
 * author needs.
 *
 * The workbench's own MetricGroup is built around a live run's readiness — which
 * metrics are applicable to this dataset, which the backend has resolved as
 * required, which are blocked by missing evidence. None of that exists when you
 * are defining a reusable Profile, so this reuses the parts that do transfer
 * (METRIC_GROUPS and metricMeaning, the single source of grouping) rather than
 * threading fake readiness through a component that would then have to ignore it.
 */
export function GovernanceMetricPicker({
  metrics,
  selected,
  hardFail,
  onToggle,
  onToggleHardFail,
}: {
  metrics: MetricCatalogEntry[];
  selected: string[];
  hardFail: string[];
  onToggle: (metricId: string) => void;
  onToggleHardFail: (metricId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<string[]>([METRIC_GROUPS[0]!.id]);

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return METRIC_GROUPS.map((group) => ({
      group,
      metrics: metrics.filter(
        (metric) =>
          metricMeaning(metric) === group.id &&
          (!needle ||
            metric.name.toLowerCase().includes(needle) ||
            metric.metric_id.toLowerCase().includes(needle)),
      ),
    })).filter((entry) => entry.metrics.length > 0);
  }, [metrics, query]);

  const selectedSet = new Set(selected);
  const hardFailSet = new Set(hardFail);
  // While searching, collapsed groups would hide the matches the search just found.
  const searching = query.trim().length > 0;

  return (
    <div className="grid gap-2">
      <SearchField
        inputSize="sm"
        containerClassName="block"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search checks"
        label="Search checks"
      />
      <div className="max-h-[45vh] divide-y overflow-y-auto rounded-lg border">
        {grouped.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            No checks match this search. Checks you already picked stay selected.
          </p>
        ) : (
          grouped.map(({ group, metrics: groupMetrics }) => {
            const open = searching || openGroups.includes(group.id);
            const selectedCount = groupMetrics.filter((metric) =>
              selectedSet.has(metric.metric_id),
            ).length;
            const panelId = `governance-metric-group-${group.id}`;
            const allSelected = selectedCount === groupMetrics.length;
            return (
              <div key={group.id}>
                <div className={cn("flex items-center gap-3 px-3", selectedCount > 0 && "bg-brand/5")}>
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() =>
                      setOpenGroups((current) =>
                        current.includes(group.id)
                          ? current.filter((id) => id !== group.id)
                          : [...current, group.id],
                      )
                    }
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 transition-transform motion-reduce:transition-none",
                        open && "rotate-180",
                      )}
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-1 items-baseline gap-3">
                      <span className="shrink-0 text-sm font-medium">{group.label}</span>
                      <span className="truncate text-xs text-muted-foreground">{group.description}</span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-xs",
                        selectedCount > 0 ? "bg-brand/20 text-brand-text" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {selectedCount} of {groupMetrics.length}
                    </span>
                  </button>
                  {open ? (
                    <button
                      type="button"
                      className="shrink-0 text-xs font-medium text-brand-text underline-offset-4 hover:underline"
                      onClick={() =>
                        groupMetrics.forEach((metric) => {
                          const isSelected = selectedSet.has(metric.metric_id);
                          if (allSelected ? isSelected : !isSelected) onToggle(metric.metric_id);
                        })
                      }
                    >
                      {allSelected ? "Clear all" : "Select all"}
                    </button>
                  ) : null}
                </div>
                <div id={panelId} hidden={!open} className="divide-y border-t">
                  {groupMetrics.map((metric) => {
                    const isSelected = selectedSet.has(metric.metric_id);
                    return (
                      <div key={metric.metric_id} className="flex items-start gap-3 px-3 py-2.5">
                        <label className="flex min-w-0 flex-1 items-start gap-3 text-sm">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4 shrink-0"
                            checked={isSelected}
                            aria-label={metric.name}
                            onChange={() => onToggle(metric.metric_id)}
                          />
                          <span className="min-w-0">
                            <span className="block font-medium">{metric.name}</span>
                            {metric.description ? (
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                {metric.description}
                              </span>
                            ) : null}
                          </span>
                        </label>
                        {/* Replaces a second free-text box that asked the author to
                            retype metric ids they had already ticked above. */}
                        {isSelected ? (
                          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              className="size-3.5"
                              checked={hardFailSet.has(metric.metric_id)}
                              aria-label={`Hard fail on ${metric.name}`}
                              onChange={() => onToggleHardFail(metric.metric_id)}
                            />
                            Hard fail
                          </label>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Evidence a set of checks needs, in the catalogue's own vocabulary. */
export function derivedEvidence(metrics: MetricCatalogEntry[], selected: string[]): string[] {
  const chosen = new Set(selected);
  const evidence = new Set<string>();
  for (const metric of metrics) {
    if (!chosen.has(metric.metric_id)) continue;
    for (const category of metric.required_evidence_categories ?? []) evidence.add(category);
  }
  return [...evidence].sort();
}

/** A stable, readable id from the author's name, with a short suffix for uniqueness. */
export function profileIdFromName(name: string, suffix: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "profile"}-${suffix}`;
}
