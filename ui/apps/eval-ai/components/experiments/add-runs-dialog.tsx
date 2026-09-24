"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { canJoinExperiment, runComparisonKey } from "@/lib/chart-data";
import type { ApiErrorDetail } from "@/lib/api-errors";
import type { RunResult } from "@/lib/api";
import { runDisplayName } from "@/lib/run-recommendation";
import { CopyableId } from "@/components/copyable-id";
import { SearchField } from "@/components/toolbar";

export type AttachRunsError = {
  message: string;
  details?: ApiErrorDetail[];
};

/** One server page of runs matching the dialog's query. */
export type RunSearchPage = {
  items: RunResult[];
  /** More runs matched the query than this page carries. */
  hasMore: boolean;
};

/** Runs from one server search page that may actually join this workspace.
 *
 * The page is already limited by the server, so this never truncates further —
 * a run missing from the list is genuinely ineligible, not merely off the end
 * of a client-side slice. */
export function attachableCandidates(
  matches: RunResult[],
  workspaceRuns: RunResult[],
): RunResult[] {
  const linked = new Set(workspaceRuns.map((run) => run.run_id));
  const basisRun = workspaceRuns.find(canJoinExperiment) || workspaceRuns[0];
  const basis = basisRun ? runComparisonKey(basisRun) : null;
  return matches
    .filter(canJoinExperiment)
    .filter((run) => !linked.has(run.run_id))
    .filter((run) => !basis || runComparisonKey(run) === basis);
}

export function AddRunsDialog({
  workspaceRuns,
  searchRuns,
  attaching,
  error,
  onClose,
  onAttach,
}: {
  workspaceRuns: RunResult[];
  /** Server-paged run search. The query is pushed down so the box can reach
   * every run in the tenant, not just a first page held in memory. */
  searchRuns: (query: string) => Promise<RunSearchPage>;
  attaching: boolean;
  error: AttachRunsError | string | null;
  onClose: () => void;
  onAttach: (runIds: string[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<RunResult[]>([]);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<RunResult[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      searchRuns(query.trim())
        .then((page) => {
          if (cancelled) return;
          setMatches(page.items);
          setHasMore(page.hasMore);
          setSearchFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setMatches([]);
          setHasMore(false);
          setSearchFailed(true);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, searchRuns]);

  const candidates = useMemo(
    () => attachableCandidates(matches, workspaceRuns),
    [matches, workspaceRuns],
  );

  const basisRun = workspaceRuns.find(canJoinExperiment) ?? selected[0];
  const selectedBasis = basisRun ? runComparisonKey(basisRun) : null;

  const errorMessage = typeof error === "string" ? error : error?.message ?? null;
  const errorDetails = typeof error === "string" ? [] : error?.details ?? [];

  return (
    <Dialog
      labelledBy="add-runs-title"
      onClose={attaching ? () => undefined : onClose}
      scrimLabel="Close add runs dialog"
      overlayClassName="z-[70]"
      scrimClassName="bg-black/45"
      width="w-[min(40rem,calc(100vw-2rem))]"
      className="max-h-[calc(100vh-2rem)] overflow-y-auto"
    >
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
        <div>
          <h2 id="add-runs-title" className="text-lg font-semibold">Add runs</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Only completed runs that share this experiment&apos;s comparison basis are listed.
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} disabled={attaching} aria-label="Close add runs dialog">
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="space-y-3 p-5">
        <SearchField
          containerClassName="block"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search runs…"
          label="Search runs to attach"
        />
        {hasMore ? (
          <p className="text-xs text-muted-foreground">
            More runs match this search than are listed. Refine the search to narrow it down.
          </p>
        ) : null}
        <div className="max-h-72 overflow-y-auto rounded-xl border">
          {searchFailed ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Unable to search runs. Try again.
            </p>
          ) : candidates.length ? (
            candidates.map((run) => {
              const incompatible = Boolean(selectedBasis && runComparisonKey(run) !== selectedBasis);
              return (
                <label key={run.run_id} className="flex items-start gap-3 border-b px-4 py-3 last:border-b-0">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={selected.some((item) => item.run_id === run.run_id)}
                    disabled={attaching || incompatible}
                    aria-describedby={incompatible ? `attach-basis-${run.run_id}` : undefined}
                    onChange={() =>
                      setSelected((current) =>
                        current.some((item) => item.run_id === run.run_id)
                          ? current.filter((item) => item.run_id !== run.run_id)
                          : [...current, run],
                      )
                    }
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{runDisplayName(run)}</span>
                    {incompatible ? <span id={`attach-basis-${run.run_id}`} className="block text-xs text-muted-foreground">Different comparison basis. Clear the selection to choose this run.</span> : null}
                    <CopyableId value={run.run_id} kind="run" className="mt-1" valueClassName="text-muted-foreground" />
                  </span>
                </label>
              );
            })
          ) : (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {searching ? "Searching runs…" : "No compatible runs available to attach."}
            </p>
          )}
        </div>
        {errorMessage ? (
          <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <p>{errorMessage}</p>
            {errorDetails.length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5">
                {errorDetails.map((detail) => (
                  <li key={`${detail.field ?? ""}:${detail.message}`}>
                    {detail.field ? (
                      <>
                        <span className="font-mono">{detail.field}</span>
                        {": "}
                      </>
                    ) : null}
                    {detail.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div className="flex justify-end gap-3 border-t pt-4">
          {selected.length ? <Button type="button" variant="ghost" onClick={() => setSelected([])} disabled={attaching}>Clear selection</Button> : null}
          <Button type="button" variant="outline" onClick={onClose} disabled={attaching}>
            Cancel
          </Button>
          <Button type="button" disabled={attaching || selected.length === 0} onClick={() => void onAttach(selected.map((run) => run.run_id))}>
            {attaching ? "Attaching…" : `Attach${selected.length ? ` ${selected.length}` : ""}`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
