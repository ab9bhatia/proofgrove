"use client";

import { X } from "lucide-react";

import {
  METRIC_GROUPS,
  metricLockedByContract,
  metricMeaning,
} from "@/components/metric-selection-panel";
import type { EvidenceReadinessResult, MetricCatalogEntry } from "@/lib/api";

/**
 * What this run will actually score, as removable chips.
 *
 * Presentational; the workbench owns the selection. It exists beside the check
 * catalogue rather than inside it because the catalogue answers "what could I
 * score" and this answers "what am I scoring" — and the second question is the
 * one you re-read before launching.
 *
 * A check a rubric requires is shown but not removable: the run would be
 * rejected without it, so offering a control that cannot succeed is worse than
 * saying why it is fixed.
 */
export function ScoringSummary({
  metrics,
  selectedCount,
  offeredCount,
  readiness,
  onRemove,
  lockedByAssignment = false,
  loading = false,
  error = null,
}: {
  /** The selected checks, already filtered to those that score. */
  metrics: MetricCatalogEntry[];
  selectedCount: number;
  offeredCount: number;
  readiness: EvidenceReadinessResult | null;
  onRemove: (metricId: string) => void;
  lockedByAssignment?: boolean;
  loading?: boolean;
  error?: string | null;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-card px-5 py-4">
        <h3 id="run-scoring-title" className="text-sm font-semibold">Selected checks</h3>
        <span className="text-xs text-muted-foreground">
          {loading ? "Loading…" : lockedByAssignment ? `${selectedCount} fixed` : `${selectedCount} of ${offeredCount}`}
        </span>
      </div>
      <p className="px-5 pt-3 text-xs text-muted-foreground">{lockedByAssignment ? "These checks are fixed by the Assignment. Clear it to choose your own checks." : "Latency and token use are captured automatically. Removing a check excludes it from this run."}</p>
      <div className="flex-1">
        {error ? <p role="alert" className="px-5 py-4 text-sm text-destructive">{error}</p> : loading ? <p role="status" className="px-5 py-4 text-sm text-muted-foreground">Loading Assignment checks…</p> : metrics.length ? (
          <div className="space-y-5 px-5 py-4">
            {METRIC_GROUPS.map((group) => {
              const groupMetrics = metrics.filter((metric) => metricMeaning(metric) === group.id);
              if (!groupMetrics.length) return null;
              return (
                <div key={group.id}>
                  <p className="text-xs font-semibold text-brand-text">{group.label}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {groupMetrics.map((metric) => {
                      const locked = lockedByAssignment || metricLockedByContract(metric, readiness);
                      const lockReason = lockedByAssignment ? "Fixed by Assignment" : "Required by rubric";
                      return (
                        <button
                          key={metric.metric_id}
                          type="button"
                          disabled={locked}
                          onClick={() => onRemove(metric.metric_id)}
                          aria-label={locked ? `${metric.name}, ${lockReason.toLowerCase()}` : `Remove ${metric.name}`}
                          title={locked ? lockReason : `Remove ${metric.name}`}
                          className="inline-flex max-w-full items-center gap-2 rounded-full border bg-brand/5 px-3 py-1.5 text-left text-xs hover:bg-brand/10 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                        >
                          <span className="min-w-0 break-words">
                            {metric.name === "Safety (General)" ? "Safety" : metric.name}
                          </span>
                          {locked ? (
                            <span className="text-[10px] text-muted-foreground">{lockedByAssignment ? "Fixed" : "Required"}</span>
                          ) : (
                            <X className="size-3.5 shrink-0" aria-hidden="true" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-5 py-6">
            <p className="text-sm font-medium">No quality checks selected</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Latency, tokens, and cost will still be recorded, but this run will have no quality
              score. Add at least one check to run.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
