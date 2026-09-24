"use client";

import { FilterSelect, SegmentedControl } from "@/components/toolbar";

export const DATASET_STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "VALIDATED", label: "Validated" },
  { value: "APPROVED", label: "Approved" },
  { value: "PUBLISHED", label: "Published" },
  { value: "DEPRECATED", label: "Deprecated" },
  { value: "RETIRED", label: "Retired" },
  { value: "REJECTED", label: "Rejected" },
] as const;

const RETIRED = "RETIRED";

/**
 * Dataset lifecycle + status, in one control.
 *
 * Two questions, not one: "active or retired" (101 of 117 datasets are
 * retired, so that split dominates), then "which status within that bucket".
 * The segmented control answers the first exactly like the Evaluations
 * lifecycle toggle (`experiments-library.tsx`'s Active/Archived); the dropdown
 * answers the second and only ever offers statuses that (a) have a dataset in
 * them and (b) belong to the bucket currently selected — a status nothing is
 * in, or one that lives in the other bucket, cannot filter anything.
 */
export function DatasetStatusFilters({
  status,
  counts,
  activeCount,
  retiredCount,
  onStatusChange,
}: {
  status: string;
  /**
   * Rows each choice would show, counted the way the table counts them: filter
   * first, then group into lineages. Deriving Active as "total minus retired"
   * over per-status counts double-counted a lineage holding versions in two
   * states, so the strip and the table below disagreed.
   */
  counts: Record<string, number>;
  activeCount: number;
  retiredCount: number;
  onStatusChange: (status: string) => void;
}) {
  const lifecycle: "active" | "retired" = status === RETIRED ? "retired" : "active";

  const statusOptions = DATASET_STATUS_FILTERS.filter(
    (option) => option.value && option.value !== RETIRED && (counts[option.value] ?? 0) > 0,
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        label="Dataset lifecycle"
        value={lifecycle}
        onChange={(view) => onStatusChange(view === "retired" ? RETIRED : "")}
        options={[
          { value: "active" as const, label: `Active (${activeCount})` },
          { value: "retired" as const, label: `Retired (${retiredCount})` },
        ]}
      />
      <FilterSelect
        label="Filter by status"
        value={lifecycle === "retired" ? RETIRED : status}
        onChange={(event) => onStatusChange(event.target.value)}
        disabled={lifecycle === "retired"}
      >
        <option value="">Any status</option>
        {statusOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label} ({counts[option.value] ?? 0})
          </option>
        ))}
        {lifecycle === "retired" ? <option value={RETIRED}>Retired ({retiredCount})</option> : null}
      </FilterSelect>
    </div>
  );
}
