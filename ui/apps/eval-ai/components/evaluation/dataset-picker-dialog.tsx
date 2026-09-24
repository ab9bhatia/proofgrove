"use client";

import { useMemo, useRef, useState } from "react";
import { Check, Search, X } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@evalai/shared/utils";

import { fullName, type DatasetInfo } from "@/lib/api";
import {
  datasetIsUnusable,
  datasetMissingFields,
  missingFieldsLabel,
  type EvaluationKind,
} from "@/lib/evaluation-form";

/** Row compatibility the backend actually computed for this evaluation source. */
function coverage(dataset: DatasetInfo, kind: EvaluationKind): { label: string; usable: boolean } {
  const missing = datasetMissingFields(dataset);
  if (missing.length) return { label: `Missing ${missingFieldsLabel(missing)}`, usable: false };
  if (dataset.missing_row_fields == null) return { label: "Not computed", usable: true };
  if (kind === "provided" && dataset.missing_provided_response === true) {
    return { label: "No recorded response", usable: false };
  }
  if (kind === "provided" && dataset.missing_provided_response == null) {
    return { label: "Not computed", usable: true };
  }
  return { label: "Ready", usable: true };
}

export function filterDatasets(datasets: DatasetInfo[], query: string): DatasetInfo[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return datasets;
  return datasets.filter((dataset) =>
    [fullName(dataset), dataset.product_id].join(" ").toLocaleLowerCase().includes(normalized),
  );
}

/**
 * Choosing a dataset from a table rather than a dropdown.
 *
 * A `<select>` shows one line of text at a time, so at a hundred datasets the choice
 * becomes scrolling a list of names with none of the information the choice actually
 * depends on — how many rows, which version, whether the rows even carry both halves a
 * run needs. Those are columns here, and the unusable ones say so before selection
 * rather than failing at run time.
 */
export function DatasetPickerDialog({
  datasets,
  kind,
  selectedName,
  canLoadMore,
  loadingMore,
  onLoadMore,
  onSelect,
  onClose,
}: {
  datasets: DatasetInfo[];
  kind: EvaluationKind;
  selectedName: string | null;
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSelect: (dataset: DatasetInfo) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => filterDatasets(datasets, query), [datasets, query]);

  return (
    <Dialog
      variant="modal"
      labelledBy="dataset-picker-title"
      describedBy="dataset-picker-description"
      scrimLabel="Close dataset picker"
      onClose={onClose}
      initialFocusRef={searchRef}
      width="w-[min(48rem,calc(100vw-2rem))]"
    >
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
        <div>
          <h2 id="dataset-picker-title" className="text-lg font-semibold">Choose dataset</h2>
          <p id="dataset-picker-description" className="mt-0.5 text-xs text-muted-foreground">
            {kind === "provided"
              ? "Select published evidence where every row carries a recorded response — the answer to be scored, which is separate from the expected output it is scored against."
              : "Select published evidence with both a question and an expected output."}
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close dataset picker">
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="border-b px-5 py-3">
        <label className="relative block">
          <span className="sr-only">Search datasets</span>
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={searchRef}
            inputSize="sm"
            className="pl-9"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search datasets"
          />
        </label>
      </div>

      <div className="max-h-[55vh] overflow-y-auto">
        {shown.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            No published dataset matches “{query.trim()}”.
          </p>
        ) : (
          <>
            <ul className="divide-y">
              {shown.map((dataset) => {
                const name = fullName(dataset);
                const rows = coverage(dataset, kind);
                const selected = name === selectedName;
                const unusable = datasetIsUnusable(dataset, kind);
                return (
                  <li key={dataset.dataset_id}>
                    <button
                      type="button"
                      onClick={() => onSelect(dataset)}
                      disabled={unusable}
                      aria-current={selected ? "true" : undefined}
                      className={cn(
                        "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-l-2 border-transparent px-5 py-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        selected && "border-l-brand bg-brand/5",
                        unusable ? "cursor-not-allowed opacity-60" : "hover:bg-muted/40",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold" title={name}>{name}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span>{dataset.product_id}</span>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums">v{dataset.version_number}</span>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums">
                            {dataset.record_count == null ? "Rows not reported" : `${dataset.record_count} ${dataset.record_count === 1 ? "row" : "rows"}`}
                          </span>
                          {dataset.dqs == null ? null : (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="tabular-nums">Quality {Math.round(dataset.dqs * 100)}%</span>
                            </>
                          )}
                        </span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span
                          className={cn(
                            "text-xs font-medium",
                            rows.label === "Ready"
                              ? "text-success-text"
                              : rows.usable
                                ? "text-muted-foreground"
                                : "max-w-36 text-right text-destructive",
                          )}
                        >
                          {rows.label}
                        </span>
                        <span
                          className={cn(
                            "flex size-5 shrink-0 items-center justify-center rounded border",
                            selected ? "border-brand-text bg-brand text-brand-foreground" : "border-muted-foreground/40 bg-background",
                          )}
                          aria-hidden="true"
                        >
                          {selected ? <Check className="size-3.5" /> : null}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {canLoadMore ? (
        <div className="border-t px-5 py-3">
          <Button type="button" variant="outline" size="sm" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more datasets"}
          </Button>
        </div>
      ) : null}
    </Dialog>
  );
}
