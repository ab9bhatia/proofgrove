"use client";

import { TablePagination } from "@/components/table-pagination";

import { formatDateTime } from "@/lib/format-time";
import { COLUMN_HEADER } from "@/lib/page-frame";
import { ROWS_PER_PAGE } from "@/lib/pagination";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Download,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@evalai/shared/ui/dropdown-menu";
import { OverlayConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@evalai/shared/ui/sonner";
import { cn } from "@evalai/shared/utils";
import { api, fullName, type DatasetInfo } from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/page-state";
import {
  datasetSourceLabel,
  groupDatasetsByLineage,
  nameVersionSuffix,
  type DatasetLineageGroup,
} from "@/lib/dataset-lineage";
import { downloadTextFile, recordsToCsvString } from "@/lib/dataset-csv";
import { filterDatasetsByQuery } from "@/lib/dataset-search";
import { FilterSelect, SearchField } from "@/components/toolbar";
import { DATASET_STATUS_FILTERS, DatasetStatusFilters } from "@/components/dataset-status-filters";

export type DatasetSortKey = "updated" | "cases";
export type DatasetSortDir = "asc" | "desc";

// Sized to their content, with the name taking the slack. Cases sits right of
// Source rather than hard against Updated, which read as one crowded pair.
// Both trailing columns end at their own right edge, so the space between them is
// the gap itself rather than whatever the date's length leaves over. gap-6, not
// gap-3: a right-aligned number beside a left-aligned date read as one field.
const GRID_COLS = "grid-cols-[minmax(14rem,1fr)_7rem_9rem_4rem_11rem_2.75rem]";
const VALID_STATUSES = new Set<string>(
  DATASET_STATUS_FILTERS.map((option) => option.value).filter(Boolean),
);

type LibraryState = {
  query: string;
  status: string;
  product: string;
  sortKey: DatasetSortKey;
  sortDir: DatasetSortDir;
  page: number;
};

/** Read the library's URL state. Owned here (not lib/library-url-state.ts) —
 * the library is self-contained, like ExperimentsLibrary. */
export function readLibraryState(params: URLSearchParams): LibraryState {
  const status = (params.get("status") ?? "").trim().toUpperCase();
  const page = Number(params.get("page"));
  return {
    query: params.get("q") ?? "",
    status: VALID_STATUSES.has(status) ? status : "",
    product: params.get("product") ?? "",
    sortKey: params.get("sort") === "cases" ? "cases" : "updated",
    sortDir: params.get("dir") === "asc" ? "asc" : "desc",
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function setOrDelete(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}

export function writeLibrarySearchParams(current: string, state: LibraryState): string {
  const params = new URLSearchParams(current);
  setOrDelete(params, "q", state.query);
  setOrDelete(params, "status", state.status.toLowerCase());
  setOrDelete(params, "product", state.product);
  setOrDelete(params, "sort", state.sortKey === "updated" ? "" : state.sortKey);
  setOrDelete(params, "dir", state.sortDir === "desc" ? "" : state.sortDir);
  setOrDelete(params, "page", state.page > 1 ? String(state.page) : "");
  return params.toString();
}

function matchesStatus(ds: DatasetInfo, status: string): boolean {
  // No specific status picked means "any active status" — the Active tab's
  // 16 datasets span Draft, Published and Rejected, and the backend has no
  // "not retired" filter, so "not retired" is the rule, not a listed value.
  if (status) return ds.status === status;
  return ds.status !== "RETIRED";
}

function sortValue(ds: DatasetInfo, key: DatasetSortKey): number | null {
  if (key === "cases") return ds.record_count ?? null;
  return ds.updated_at ? Date.parse(ds.updated_at) : null;
}

/** Missing values sink to the bottom regardless of direction — an unknown
 * update time or case count is not "the oldest" or "the smallest", it's unknown. */
export function sortDatasetGroups(
  groups: DatasetLineageGroup[],
  key: DatasetSortKey,
  dir: DatasetSortDir,
): DatasetLineageGroup[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...groups].sort((a, b) => {
    const av = sortValue(a.latest, key);
    const bv = sortValue(b.latest, key);
    if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1;
    return (av - bv) * sign;
  });
}

export function DatasetLibrary({
  datasets,
  loading,
  error,
  onChanged,
}: {
  /** The whole tenant library, unpaginated — small enough (117 rows today) to
   * filter, sort and page entirely on the client, the same way ExperimentsLibrary
   * handles runs. */
  datasets: DatasetInfo[];
  loading: boolean;
  error?: string | null;
  onChanged?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const state = readLibraryState(searchParams);

  const [busyName, setBusyName] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DatasetInfo | null>(null);

  function navigate(patch: Partial<LibraryState>) {
    const query = writeLibrarySearchParams(searchParams.toString(), { ...state, ...patch });
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  // Counted exactly as the table counts: filter to the choice, then group into
  // lineages. Counting raw rows counted every version — the strip said
  // "Active (16)" over a table of 9 — and grouping before filtering miscounted
  // any lineage holding versions in more than one state.
  const lineagesMatching = useCallback(
    (predicate: (dataset: DatasetInfo) => boolean): number =>
      groupDatasetsByLineage(datasets.filter(predicate)).length,
    [datasets],
  );
  const activeCount = useMemo(
    () => lineagesMatching((ds) => ds.status !== "RETIRED"),
    [lineagesMatching],
  );
  const retiredCount = useMemo(
    () => lineagesMatching((ds) => ds.status === "RETIRED"),
    [lineagesMatching],
  );
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const status of new Set(datasets.map((ds) => ds.status))) {
      counts[status] = lineagesMatching((ds) => ds.status === status);
    }
    return counts;
  }, [datasets, lineagesMatching]);

  const productOptions = useMemo(
    () => [...new Set(datasets.map((ds) => ds.product_id).filter(Boolean))].sort(),
    [datasets],
  );

  const groups = useMemo(() => {
    const lifecycleFiltered = datasets.filter((ds) => matchesStatus(ds, state.status));
    const productFiltered = state.product
      ? lifecycleFiltered.filter((ds) => ds.product_id === state.product)
      : lifecycleFiltered;
    const searched = filterDatasetsByQuery(productFiltered, state.query);
    return sortDatasetGroups(groupDatasetsByLineage(searched), state.sortKey, state.sortDir);
  }, [datasets, state.status, state.product, state.query, state.sortKey, state.sortDir]);

  const pageCount = Math.max(1, Math.ceil(groups.length / ROWS_PER_PAGE));
  const currentPage = Math.min(state.page, pageCount);
  const pageStart = (currentPage - 1) * ROWS_PER_PAGE;
  const pageGroups = groups.slice(pageStart, pageStart + ROWS_PER_PAGE);

  const lifecycleLabel =
    (state.status
      ? DATASET_STATUS_FILTERS.find((option) => option.value === state.status)?.label
      : "Active") ?? "Matching";

  function handleSort(key: DatasetSortKey) {
    if (state.sortKey === key) navigate({ sortKey: key, sortDir: state.sortDir === "asc" ? "desc" : "asc" });
    else navigate({ sortKey: key, sortDir: "desc" });
  }

  async function exportDataset(ds: DatasetInfo, format: "csv" | "json") {
    const name = fullName(ds);
    setBusyName(`${name}:${format}`);
    try {
      const records = await api.getRecords(name);
      if (format === "csv") {
        downloadTextFile(`${name}.csv`, recordsToCsvString(records), "text/csv;charset=utf-8");
      } else {
        downloadTextFile(
          `${name}.json`,
          JSON.stringify(records, null, 2),
          "application/json;charset=utf-8",
        );
      }
    } catch (reason) {
      toast.error("Dataset export failed", {
        description: userFacingError(reason, "Try the export again."),
      });
    } finally {
      setBusyName(null);
    }
  }

  async function deleteLatest(ds: DatasetInfo) {
    const name = fullName(ds);
    setBusyName(`${name}:delete`);
    try {
      await api.deleteDataset(name);
      setPendingDelete(null);
      toast.success("Latest dataset version deleted", { description: name });
      onChanged?.();
    } catch (reason) {
      toast.error("Dataset deletion failed", {
        description: userFacingError(reason, "Try again or refresh the dataset library."),
      });
    } finally {
      setBusyName(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="border-b px-5 py-4">
        <h2 className="text-xl font-semibold tracking-tight">Dataset library</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Latest versions are shown first. Open a dataset for records, validation, and full history.
        </p>
      </div>

      {/* Wraps rather than overflowing: four controls plus a count did not fit one
          line and the last dropdown was clipped at the card edge. The search takes
          the slack, the rest keep their own width. */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/10 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <SearchField
            value={state.query}
            onChange={(event) => navigate({ query: event.target.value, page: 1 })}
            placeholder="Search datasets…"
            label="Search datasets"
          />
          <DatasetStatusFilters
            status={state.status}
            counts={statusCounts}
            activeCount={activeCount}
            retiredCount={retiredCount}
            onStatusChange={(status) => navigate({ status, page: 1 })}
          />
          <FilterSelect
            label="Filter by product"
            value={state.product}
            onChange={(event) => navigate({ product: event.target.value, page: 1 })}
          >
            <option value="">All products</option>
            {productOptions.map((product) => (
              <option key={product} value={product}>
                {product}
              </option>
            ))}
          </FilterSelect>
        </div>
      </div>

      {loading ? (
        <TableSkeleton label="Loading datasets…" columns={6} rows={6} className="min-h-48" />
      ) : error ? (
        <ErrorState title="Unable to load datasets" message={error} onRetry={onChanged} className="m-5" />
      ) : groups.length === 0 ? (
        <EmptyState
          title={
            state.query
              ? "No datasets match your search"
              : `No ${lifecycleLabel.toLowerCase()} datasets`
          }
          description={
            state.query
              ? "Try a different name, status, or product."
              : "Choose another status or product to see the rest of the dataset library."
          }
          className="m-5 min-h-48"
        />
      ) : (
        <div className="max-w-full overflow-x-auto">
          <div className={cn("grid min-w-[900px] items-center gap-6", GRID_COLS, COLUMN_HEADER)}>
            <span>Dataset</span>
            <span>Status</span>
            <span>Source</span>
            <SortHeader label="Cases" sortKey="cases" state={state} onSort={handleSort} align="right" />
            <SortHeader label="Updated" sortKey="updated" state={state} onSort={handleSort} align="right" />
            <span className="sr-only">Actions</span>
          </div>
          <div role="list" aria-label="Dataset library" className="divide-y">
            {pageGroups.map((group) => (
              <GroupRow
                key={group.rootName}
                group={group}
                busyName={busyName}
                onExport={(ds, format) => void exportDataset(ds, format)}
                onDelete={setPendingDelete}
                onReload={() => onChanged?.()}
              />
            ))}
          </div>
        </div>
      )}

      {!loading && !error && groups.length > 0 ? (
        <TablePagination total={groups.length} page={currentPage} onPageChange={(page) => navigate({ page })} label={`${lifecycleLabel.toLowerCase()} datasets`} />
      ) : null}

      {pendingDelete ? (
        <OverlayConfirmDialog
          icon={Trash2}
          title="Delete latest dataset version?"
          description={
            <>
              <span className="font-medium text-foreground">{fullName(pendingDelete)}</span>{" "}
              will be permanently removed. Earlier versions remain available.
            </>
          }
          confirmLabel="Delete version"
          pendingLabel="Deleting…"
          pending={busyName === `${fullName(pendingDelete)}:delete`}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void deleteLatest(pendingDelete)}
        />
      ) : null}
    </section>
  );
}

function SortHeader({
  label,
  sortKey,
  state,
  onSort,
  align,
}: {
  label: string;
  sortKey: DatasetSortKey;
  state: LibraryState;
  onSort: (key: DatasetSortKey) => void;
  /** Must match the alignment of the cells beneath it, or the column reads as skewed. */
  align: "left" | "right";
}) {
  const active = state.sortKey === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      // uppercase/tracking restated rather than inherited: Edge and Firefox do not
      // inherit text-transform into a button, and Tailwind v4's preflight dropped
      // the normalize rule that used to correct it — so these two headers were the
      // only ones in the app rendering in sentence case.
      className={cn(
        "inline-flex w-full items-center gap-1 rounded uppercase tracking-[0.08em] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        align === "right" ? "justify-end" : "justify-start",
      )}
      aria-label={`Sort by ${label.toLowerCase()}${active ? `, currently ${state.sortDir === "asc" ? "ascending" : "descending"}` : ""}`}
    >
      {label}
      {active ? (
        state.sortDir === "asc" ? (
          <ChevronUp className="size-3" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-3" aria-hidden="true" />
        )
      ) : (
        <ChevronsUpDown className="size-3 opacity-50" aria-hidden="true" />
      )}
    </button>
  );
}

function GroupRow({
  group,
  busyName,
  onExport,
  onDelete,
  onReload,
}: {
  group: DatasetLineageGroup;
  busyName: string | null;
  onExport: (ds: DatasetInfo, format: "csv" | "json") => void;
  onDelete: (ds: DatasetInfo) => void;
  onReload: () => void;
}) {
  const { latest, previous } = group;
  const name = fullName(latest);
  const href = `/datasets/${encodeURIComponent(name)}`;
  const totalVersions = previous.length + 1;
  const nameSuffix = nameVersionSuffix(name);
  const forkedFrom = nameSuffix != null && nameSuffix !== latest.version_number ? nameSuffix : null;

  return (
    <article role="listitem" className="group relative">
      {/* One anchor covering the row, painted beneath the cells. The cells are
          plain text and do not intercept the click; only the actions menu opts
          into its own stacking context above it. */}
      <Link
        href={href}
        aria-label={`Open ${name}`}
        className="absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
      />
      <div
        className={cn(
          "grid min-w-[900px] items-center gap-6 px-4 py-3 transition-colors group-hover:bg-muted/25 sm:px-5",
          GRID_COLS,
        )}
      >

        <div className="min-w-0">
          <span className="block min-w-0 truncate text-sm font-semibold text-foreground" title={name}>
            {name}
          </span>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>v{latest.version_number} latest</span>
            {previous.length > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                {/* The older versions themselves, not a link to an event log. The
                    in-row expansion this replaced nested a table inside a paginated
                    table; a menu keeps each version openable without doing that. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="relative z-10 rounded underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {totalVersions} versions
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-56">
                    <DropdownMenuLabel>Older versions</DropdownMenuLabel>
                    {previous.map((version) => (
                      <DropdownMenuItem key={fullName(version)} asChild>
                        <Link href={`/datasets/${encodeURIComponent(fullName(version))}`}>
                          v{version.version_number}
                          <span className="ml-auto text-xs text-muted-foreground">
                            {version.record_count ?? "—"} cases
                          </span>
                        </Link>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : null}
            {forkedFrom != null ? (
              <>
                <span aria-hidden="true">·</span>
                <span
                  title={`Named "${name}"; the current version is v${latest.version_number}, not v${forkedFrom}.`}
                >
                  forked from v{forkedFrom}
                </span>
              </>
            ) : null}
          </p>
        </div>

        <div className="min-w-0">
          <StatusBadge status={latest.status} />
        </div>

        <div className="min-w-0 text-xs">
          <span className="block truncate text-muted-foreground">{datasetSourceLabel(latest)}</span>
        </div>

        <div className="text-right text-sm font-semibold tabular-nums text-foreground">
          {latest.record_count ?? "—"}
        </div>

        <div className="min-w-0 text-right text-xs">
          <span className="block truncate text-muted-foreground" title={latest.updated_at ?? undefined}>
            {latest.updated_at ? formatDateTime(latest.updated_at) : "—"}
          </span>
        </div>

        <div className="relative z-10 flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={`More actions for ${name}`}
              >
                <MoreHorizontal aria-hidden="true" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuLabel>Export version</DropdownMenuLabel>
              <DropdownMenuItem disabled={busyName === `${name}:csv`} onSelect={() => onExport(latest, "csv")}>
                {busyName === `${name}:csv` ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-4" aria-hidden="true" />
                )}
                Export CSV
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busyName === `${name}:json`} onSelect={() => onExport(latest, "json")}>
                {busyName === `${name}:json` ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-4" aria-hidden="true" />
                )}
                Export JSON
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onReload}>
                <RefreshCw className="size-4" aria-hidden="true" />
                Refresh library
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busyName === `${name}:delete`}
                onSelect={() => onDelete(latest)}
                className="text-destructive focus:text-destructive"
              >
                {busyName === `${name}:delete` ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 className="size-4" aria-hidden="true" />
                )}
                Delete latest version
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </article>
  );
}
