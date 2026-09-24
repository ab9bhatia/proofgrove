"use client";

import { PAGE_FRAME } from "@/lib/page-frame";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, Loader2, Plus, X } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { OverlayConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@evalai/shared/ui/label";
import { LegacyEvaluationRouteRedirect } from "@/components/legacy-evaluation-redirect";
import { GateBadge } from "@/components/gate-badge";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, LoadingState, TableSkeleton } from "@/components/page-state";
import { api, evaluationApi, type ExperimentSummary, type RunResult } from "@/lib/api";
import { canJoinExperiment, runComparisonKey } from "@/lib/chart-data";
import { userFacingError } from "@/lib/api-errors";
import { COLUMN_DEFS, deltaAgainstPrevious, tracesHrefForRun, presentRunEnd, presentRunStart } from "@/components/experiments-library";
import { gatedRunScore } from "@/lib/run-outcome";
import { runDetailsHref, runDisplayName, runScenarioTypeLabel } from "@/lib/run-recommendation";
import { formatDateTime } from "@/lib/format-time";
import { cn } from "@evalai/shared/utils";
import { SearchField, SegmentedControl } from "@/components/toolbar";
import { RunOutcomeBadge } from "@/components/run-outcome-badge";
import { runHistoryApi } from "@/lib/run-history";
import { middleTruncate } from "@/lib/truncate";

// Legacy `/experiments` route. The canonical home for this view is
// `/evaluations?tab=experiments`; the embedded `ExperimentsView` below is
// still rendered there. This route only forwards visitors to the canonical URL.
export default function ExperimentsPage() {
  return <LegacyEvaluationRouteRedirect />;
}

/** One server page of experiments, matching the Runs tab page size feel. */
const EXPERIMENTS_PER_PAGE = 20;

export function ExperimentsView({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const [tenantId, setTenantId] = useState("");
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  // Unpaged total, so the footer reports the whole list instead of letting one
  // window present itself as everything there is.
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const listRequest = useRef(0);
  const [runs, setRuns] = useState<RunResult[]>([]);
  const [runsTotal, setRunsTotal] = useState<number | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const loadMoreRuns = useCallback(async (tenantId: string, offset: number) => {
    setRunsLoading(true); setRunsError(null);
    try {
      const result = await runHistoryApi.list({tenant_id: tenantId, offset, limit: 100});
      setRuns((current) => offset ? [...current, ...result.items.filter((run) => !current.some((item) => item.run_id === run.run_id))] : result.items);
      setRunsTotal(result.total);
    } catch (reason) { setRunsError(userFacingError(reason, "Unable to load runs")); }
    finally { setRunsLoading(false); }
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<"active" | "archived">("active");
  const [query, setQuery] = useState("");
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const requestId = ++listRequest.current;
    setLoading(true);
    setError(null);
    try {
      const tenant = await api.tenant();
      if (requestId !== listRequest.current) return;
      const workspaceList = await evaluationApi.listExperimentWorkspaces(tenant.tenant_id, {
          includeDrafts: false,
          archived: lifecycle === "archived",
          query,
          limit: EXPERIMENTS_PER_PAGE,
          offset: (page - 1) * EXPERIMENTS_PER_PAGE,
        });
      if (requestId !== listRequest.current) return;
      setTenantId(tenant.tenant_id);
      setExperiments(workspaceList.items);
      setTotal(workspaceList.total);

      // The list shrank under us (a draft was absorbed into a workspace): fall
      // back to the first page instead of stranding the reader on an empty one.
      if (!workspaceList.items.length && page > 1) setPage(1);
    } catch (reason) {
      if (requestId === listRequest.current) setError(userFacingError(reason, "Unable to load experiments"));
    } finally {
      if (requestId === listRequest.current) setLoading(false);
    }
  }, [lifecycle, page, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      listRequest.current += 1;
    };
  }, [load, reloadKey]);


  useEffect(() => {
    if (!createOpen || !tenantId || runsTotal !== null) return;
    const timer = window.setTimeout(() => void loadMoreRuns(tenantId, 0), 0);
    return () => window.clearTimeout(timer);
  }, [createOpen, tenantId, runsTotal, loadMoreRuns]);

  // Archive, not delete: an experiment carries the runs, findings and decisions
  // taken against it, so removing it from the working set has to leave the
  // evidence readable. The Archived list is where it goes, and restore is the
  // way back.
  const setArchived = useCallback(
    async (experimentId: string, name: string, archived: boolean) => {
      setLifecycleError(null);
      try {
        if (archived) await evaluationApi.archiveExperiment(experimentId);
        else await evaluationApi.restoreExperiment(experimentId);
        setReloadKey((value) => value + 1);
      } catch (reason) {
        setLifecycleError(
          userFacingError(reason, `Unable to ${archived ? "archive" : "restore"} ${name}`),
        );
      }
    },
    [],
  );

  return (
    // Embedded in /evaluations, the host page owns the container: contributing a
    // second, narrower width here inset this view from the page title and tabs.
    <div className={cn(embedded ? "" : `${PAGE_FRAME}`)}>
      {!embedded ? (
        <PageHeader
          section="Evaluate"
          title="Experiments"
          description="Create a named hypothesis from compatible historical runs, choose a baseline, and compare model, prompt, agent, or tool variants without changing the recorded evaluation basis."
          actions={
            <>

              <Button type="button" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden="true" />
                New experiment
              </Button>
            </>
          }
        />
      ) : null}
      {embedded ? (
        <div className="panel overflow-hidden">
          <div className="border-b border-border px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <p className="eval-hub-eyebrow mb-1 text-[0.6875rem] text-evalai-purple">Hypothesis</p>
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Group compatible historical runs around a hypothesis, choose a baseline, and compare model, prompt, agent, or tool variants.
              </p>
            </div>
            {/* Same row as Run history and Datasets: a rule under the blurb, the
                search taking the slack, controls against the right edge. This
                row sat beside the blurb instead, so it never reached the card's
                width and the controls huddled in the middle. */}
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <SearchField
                    value={query}
                onChange={(event) => {
                  setPage(1);
                  setQuery(event.target.value);
                }}
                placeholder="Search experiments…"
                label="Search experiments"
              />
              {/* Archiving is how an experiment leaves this list, so the archive
                  has to be one click away or it is a one-way door. */}
              <SegmentedControl
                label="Experiment lifecycle"
                value={lifecycle}
                onChange={(view) => {
                  setPage(1);
                  setLifecycle(view);
                }}
                options={[
                  { value: "active" as const, label: "Active" },
                  { value: "archived" as const, label: "Archived" },
                ]}
              />

              <Button type="button" variant="default" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden="true" />
                New experiment
              </Button>
            </div>
          </div>
          {loading ? (
            <TableSkeleton label="Loading experiments…" rows={6} columns={6} />
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load()} className="border-0" />
          ) : experiments.length === 0 && query.trim() ? (
            <div className="space-y-3 px-5 py-10 text-center">
              <EmptyState title="No matching experiments" description="Try another search or clear it to see this list again." />
              <Button type="button" variant="outline" onClick={() => setQuery("")}>Clear search</Button>
            </div>
          ) : experiments.length === 0 && lifecycle === "archived" ? (
            <div className="px-5 py-10">
              <EmptyState
                title="No archived experiments"
                description="Archiving an experiment moves it here, out of the active list. Nothing has been archived yet."
              />
            </div>
          ) : experiments.length === 0 ? (
            <div className="space-y-4 px-5 py-10">
              <EmptyState
                title="No experiments yet"
                description="Create a workspace to compare evaluation runs and record what you learn. You can add runs now or later."
              />
              <div className="flex justify-center gap-3">
                <Button type="button" variant="default" onClick={() => setCreateOpen(true)}>New experiment</Button>

                  <Button type="button" variant="outline" onClick={() => router.push("/evaluate")}>Start an evaluation</Button>
              </div>
            </div>
          ) : (
            <ExperimentsTable
              embedded
              experiments={experiments}
              total={total}
              page={page}
              onPageChange={setPage}
              lifecycle={lifecycle}
              onSetArchived={setArchived}
            />
          )}
          {lifecycleError ? (
            <div role="alert" className="border-t border-border px-5 py-3 text-xs text-destructive">
              {lifecycleError}
            </div>
          ) : null}
        </div>
      ) : loading ? (
        <div className="panel overflow-hidden">
          <TableSkeleton label="Loading experiments…" rows={6} columns={6} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : experiments.length === 0 ? (
        <div className="space-y-4">
          <EmptyState
            title="No experiments yet"
            description="Create a workspace to compare evaluation runs and record what you learn. You can add runs now or later."
          />
          <div className="flex justify-center gap-3">
            <Button type="button" variant="default" onClick={() => setCreateOpen(true)}>New experiment</Button>

              <Button type="button" variant="outline" onClick={() => router.push("/evaluate")}>Start an evaluation</Button>
          </div>
        </div>
      ) : (
        <ExperimentsTable
          experiments={experiments}
          total={total}
          page={page}
          onPageChange={setPage}
          lifecycle={lifecycle}
          onSetArchived={setArchived}
        />
      )}
      {createOpen ? (
        <CreateFromRunsDialog
          runs={runs}
          runsTotal={runsTotal}
          runsLoading={runsLoading}
          runsError={runsError}
          onLoadMore={() => void loadMoreRuns(tenantId, runs.length)}
          tenantId={tenantId}
          onClose={() => setCreateOpen(false)}
          onCreated={(summary) => {
            setCreateOpen(false);
            void load();
            router.push(`/evaluations/${encodeURIComponent(summary.experiment.experiment_id || "")}`);
          }}
        />
      ) : null}

    </div>
  );
}

function experimentHref(summary: ExperimentSummary): string {
  return `/evaluations/${encodeURIComponent(summary.experiment.experiment_id || "")}`;
}

/**
 * The presented cells for one experiment. Every value is either recorded or
 * says plainly that it is not — no placeholder dashes standing in for data, and
 * no single absence ("no runs") restated four times across one row. The count
 * is a count even when it is zero; the three derived columns each name what
 * they specifically lack, in the vocabulary the rest of the app already uses.
 */
function experimentCells(summary: ExperimentSummary) {
  return {
    noRuns: summary.run_count === 0,
    runCount: String(summary.run_count),
    // "Not scored", not an em dash: this app names an absence rather than
    // printing a bare dash, and the redundancy with "Not gated" beside it is the
    // lesser cost. See app/experiments/page.test.ts, which pins both.
    score:
      summary.latest_score == null
        ? "Not scored"
        : `${Math.round(summary.latest_score * 100)}%`,
    lastRun: formatDateTime(summary.latest_completed_at),
  };
}

/**
 * A lineage draft is provisional, so its badge is dashed; a named workspace
 * carries its governance status in a solid one.
 */
function KindBadge({ summary }: { summary: ExperimentSummary }) {
  const badgeClass = "shrink-0 rounded-lg border px-2 py-0.5 text-[11px] font-medium text-muted-foreground";
  if (summary.kind === "draft") {
    return <span className={cn(badgeClass, "border-dashed")}>Draft</span>;
  }
  // Every status, not just "active": the old ternary capitalised that one and
  // passed the rest through raw, so an approved experiment read "approved" in
  // lower case beside a capitalised "Active" and "Draft".
  const status = (summary.experiment.status || "active").toLowerCase();
  return <span className={badgeClass}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}

function ExperimentName({ summary }: { summary: ExperimentSummary }) {
  const subtitle = summary.experiment.description || summary.experiment.objective || summary.experiment.hypothesis;
  return (
    <>
      {/* No per-row flask: every row on this list is an experiment, so the icon
          said nothing and took 24px from a name column that was already cutting
          the timestamp off the end. */}
      <span className="block min-w-0">
        <span className="block truncate font-semibold text-foreground" title={summary.experiment.name}>
          {middleTruncate(summary.experiment.name)}
        </span>
      </span>
      {subtitle ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{subtitle}</span> : null}
    </>
  );
}

/** Loaded state of one experiment's runs, fetched only when its row expands. */
type ExperimentRunsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; runs: RunResult[] };

/** DOM-safe id of the runs panel an experiment row discloses. */
function runsPanelId(experimentId: string): string {
  return `experiment-runs-${experimentId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** A run's identity inside its own experiment: its number, or when it began. */
function runIdentityLabel(run: RunResult): string {
  return run.run_number != null ? `Run ${run.run_number}` : `Run · ${formatDateTime(run.started_at)}`;
}

/**
 * The runs of one expanded experiment. Nothing is fetched until the row is
 * opened, and each of loading, failure and "genuinely no runs" is said out
 * loud rather than presented as an empty table.
 */
function ExperimentRunsPanel({
  experimentName,
  state,
  onRetry,
}: {
  experimentName: string;
  state: ExperimentRunsState | undefined;
  onRetry: () => void;
}) {
  if (!state || state.status === "loading") {
    return <LoadingState label={`Loading runs for ${experimentName}…`} className="min-h-24" />;
  }
  if (state.status === "error") {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <p className="text-xs text-destructive">{state.message}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (state.runs.length === 0) {
    return (
      <p className="px-5 py-4 text-xs text-muted-foreground">
        No runs are attached to this experiment yet.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] table-fixed text-left text-sm">
        <caption className="sr-only">Runs recorded for {experimentName}</caption>
        <colgroup>
          <col className="w-[38%]" />
          <col className="w-[10%]" />
          <col className="w-[13%]" />
          <col className="w-[19%]" />
          <col className="w-[20%]" />
        </colgroup>
        <thead className="border-b bg-muted/20 text-muted-foreground">
          <tr>
            <th scope="col" className="px-5 py-2.5 font-medium">Run</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Score</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Outcome</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Start</th>
            <th scope="col" className="px-5 py-2.5 font-medium">End</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {state.runs.map((run) => {
            const score = gatedRunScore(run);
            const end = presentRunEnd(run);
            return (
              <tr key={run.run_id} className="align-top transition-colors hover:bg-muted/15">
                <td className="px-5 py-3">
                  <Link
                    href={runDetailsHref(run.run_id)}
                    className="rounded-lg font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    {runIdentityLabel(run)}
                  </Link>
                </td>
                <td className={cn("px-3 py-3", score == null ? "text-xs text-muted-foreground" : "font-mono text-sm text-foreground")}>
                  {score == null ? "Not scored" : `${Math.round(score * 100)}%`}
                </td>
                <td className="px-3 py-3">
                  <RunOutcomeBadge run={run} />
                </td>
                <td className="px-3 py-3 text-xs text-muted-foreground">{presentRunStart(run)}</td>
                <td className="px-5 py-3 text-xs text-muted-foreground">{end.time ?? end.state}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One shared table for every experiment, so Runs and Experiments read as the
 * same product: identical column widths, header treatment, mobile card
 * fallback, disclosure rows, and paging footer as the run library.
 */
export function ExperimentsTable({
  experiments,
  total,
  page,
  onPageChange,
  lifecycle = "active",
  onSetArchived,
  embedded = false,
}: {
  experiments: ExperimentSummary[];
  /** Unpaged server total, for the honest "N–M of T" footer. */
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  lifecycle?: "active" | "archived";
  onSetArchived?: (experimentId: string, name: string, archived: boolean) => void;
  embedded?: boolean;
}) {
  const pageCount = Math.max(1, Math.ceil(total / EXPERIMENTS_PER_PAGE));
  const rangeStart = (page - 1) * EXPERIMENTS_PER_PAGE + 1;
  const rangeEnd = (page - 1) * EXPERIMENTS_PER_PAGE + experiments.length;
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [runsById, setRunsById] = useState<Record<string, ExperimentRunsState>>({});

  function loadRuns(experimentId: string) {
    setRunsById((current) => ({ ...current, [experimentId]: { status: "loading" } }));
    void evaluationApi.listExperimentRuns(experimentId).then(
      (runs) => setRunsById((current) => ({ ...current, [experimentId]: { status: "ready", runs } })),
      (reason) =>
        setRunsById((current) => ({
          ...current,
          [experimentId]: {
            status: "error",
            message: userFacingError(reason, "Unable to load runs for this experiment"),
          },
        })),
    );
  }

  /**
   * Runs are fetched one experiment at a time, on first expand — never for
   * every row of the page up front. A previous failure is retried on reopen.
   */
  function toggleExpanded(experimentId: string) {
    const next = new Set(expandedIds);
    if (next.has(experimentId)) next.delete(experimentId);
    else {
      next.add(experimentId);
      const state = runsById[experimentId];
      if (!state || state.status === "error") loadRuns(experimentId);
    }
    setExpandedIds(next);
  }

  return (
    <div className={cn(!embedded && "panel overflow-hidden")}>
      <div className="divide-y md:hidden">
        {experiments.map((summary) => {
          const cells = experimentCells(summary);
          const experimentId = summary.experiment.experiment_id || "";
          const expanded = expandedIds.has(experimentId);
          const panelId = runsPanelId(experimentId);
          return (
            <article key={experimentId}>
              <div className="flex items-start gap-2 p-4">
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  aria-label={`${expanded ? "Collapse" : "Expand"} runs for ${summary.experiment.name}`}
                  onClick={() => toggleExpanded(experimentId)}
                  className="flex min-h-11 min-w-0 flex-1 items-start gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronRight
                    className={cn(
                      "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                      expanded && "rotate-90",
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <ExperimentName summary={summary} />
                    <span className="mt-1 block pl-6 text-xs text-muted-foreground">
                      {cells.noRuns
                        ? "No runs yet"
                        : `${summary.run_count} run${summary.run_count === 1 ? "" : "s"} · ${cells.score} · last ${cells.lastRun}`}
                    </span>
                  </span>
                </button>
                {summary.latest_gate ? <GateBadge gate={summary.latest_gate} size="sm" /> : null}
                <Link
                  href={experimentHref(summary)}
                  aria-label={`Open ${summary.experiment.name}`}
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Link>
              </div>
              {expanded ? (
                <div id={panelId} className="border-t bg-muted/10">
                  <ExperimentRunsPanel
                    experimentName={summary.experiment.name}
                    state={runsById[experimentId]}
                    onRetry={() => loadRuns(experimentId)}
                  />
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      <div className="hidden md:block">
        <table className="w-full table-fixed text-left text-sm">
          <caption className="sr-only">Experiment workspaces, newest first</caption>
          <colgroup>
            <col className="w-[30%]" />
            <col className="w-[10%]" />
            <col className="w-[8%]" />
            <col className="w-[12%]" />
            <col className="w-[13%]" />
            <col className="w-[17%]" />
            <col className="w-[10%]" />
          </colgroup>
          <thead className="border-b border-border bg-muted/20 text-muted-foreground">
            <tr>
              <th scope="col" className="px-5 py-3 font-medium">Experiment</th>
              {/* Status is a column here as it is on Datasets. As a chip beside the
                  name the two lists disagreed about where the same fact lives. */}
              <th scope="col" className="px-3 py-3 font-medium">Status</th>
              {/* Numeric columns right-aligned with tabular figures, as the run
                  history table beside it does. The two lists were aligning the
                  same kind of value two different ways. */}
              <th scope="col" className="px-3 py-3 text-right font-medium tabular-nums">Runs</th>
              <th scope="col" className="px-3 py-3 text-right font-medium tabular-nums">Latest KPI composite</th>
              <th scope="col" className="px-3 py-3 font-medium">Latest outcome</th>
              <th scope="col" className="px-5 py-3 font-medium">Last run</th>
              <th scope="col" className="px-2 py-3 text-right font-medium" aria-label="Experiment actions">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {experiments.map((summary) => {
              const cells = experimentCells(summary);
              const experimentId = summary.experiment.experiment_id || "";
              const expanded = expandedIds.has(experimentId);
              const panelId = runsPanelId(experimentId);
              return (
                <Fragment key={experimentId}>
                <tr className={cn("transition-colors", expanded ? "bg-muted/30" : "bg-background hover:bg-muted/15")}>
                  <td className="px-5 py-3.5">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      aria-label={`${expanded ? "Collapse" : "Expand"} runs for ${summary.experiment.name}`}
                      onClick={() => toggleExpanded(experimentId)}
                      className="flex max-w-full items-start gap-2.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      <ChevronRight
                        className={cn(
                          "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                          expanded && "rotate-90",
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0">
                        <ExperimentName summary={summary} />
                      </span>
                    </button>
                  </td>
                  <td className="px-3 py-3.5">
                    <KindBadge summary={summary} />
                  </td>
                  <td className="px-3 py-3.5 text-right text-sm tabular-nums text-foreground">{cells.runCount}</td>
                  {/* tabular-nums only when the cell holds a number: it widens
                      the space glyph to a digit's width, which is what put the
                      gap in the middle of "Not scored". */}
                  <td className={cn("px-3 py-3.5 text-right", summary.latest_score == null ? "text-xs text-muted-foreground" : "font-mono text-sm tabular-nums text-foreground")}>
                    {cells.score}
                  </td>
                  <td className="px-3 py-3.5">
                    {summary.latest_gate ? (
                      <GateBadge gate={summary.latest_gate} size="sm" />
                    ) : (
                      <span className="text-xs font-medium text-muted-foreground">Not gated</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3.5 text-xs text-muted-foreground">{cells.lastRun}</td>
                  <td className="px-2 py-3.5">
                    <div className="flex items-center justify-end gap-0.5">
                      <Link
                        href={experimentHref(summary)}
                        aria-label={`Open ${summary.experiment.name}`}
                        className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ChevronRight className="size-4" aria-hidden="true" />
                      </Link>
                      {onSetArchived && experimentId ? (
                        <button
                          type="button"
                          onClick={() =>
                            onSetArchived(experimentId, summary.experiment.name, lifecycle !== "archived")
                          }
                          aria-label={`${lifecycle === "archived" ? "Restore" : "Archive"} ${summary.experiment.name}`}
                          title={lifecycle === "archived" ? "Restore experiment" : "Archive experiment"}
                          className={cn(
                            "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                            lifecycle === "archived"
                              ? "hover:bg-muted hover:text-foreground"
                              : "hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40 dark:hover:text-red-300",
                          )}
                        >
                          {lifecycle === "archived" ? (
                            <ArchiveRestore className="size-4" aria-hidden="true" />
                          ) : (
                            <Archive className="size-4" aria-hidden="true" />
                          )}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
                {expanded ? (
                  <tr id={panelId}>
                    {/* Spans every column. Adding the Status column made the table
                        seven wide while this stayed at six, leaving a white block
                        to the right of every expanded row. */}
                    <td colSpan={7} className="border-t bg-muted/20 p-0">
                      <ExperimentRunsPanel
                        experimentName={summary.experiment.name}
                        state={runsById[experimentId]}
                        onRetry={() => loadRuns(experimentId)}
                      />
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-3 border-t bg-muted/10 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          Showing <span className="font-medium text-foreground">{rangeStart}</span>–
          <span className="font-medium text-foreground">{rangeEnd}</span> of{" "}
          <span className="font-medium text-foreground">{total}</span> experiment{total === 1 ? "" : "s"}
        </p>
        <nav className="flex items-center gap-2" aria-label="Experiments pagination">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page === 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            <ChevronLeft className="mr-1 size-3.5" aria-hidden="true" />
            Previous
          </Button>
          <span className="min-w-20 text-center text-xs font-medium" aria-live="polite">
            Page {page} of {pageCount}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page === pageCount}
            onClick={() => onPageChange(Math.min(pageCount, page + 1))}
          >
            Next
            <ChevronRight className="ml-1 size-3.5" aria-hidden="true" />
          </Button>
        </nav>
      </div>
    </div>
  );
}

function CreateFromRunsDialog({
  tenantId,
  runs,
  runsTotal,
  runsLoading,
  runsError,
  onLoadMore,
  onClose,
  onCreated,
}: {
  tenantId: string;
  runs: RunResult[];
  runsTotal: number | null;
  runsLoading: boolean;
  runsError: string | null;
  onLoadMore: () => void;
  onClose: () => void;
  onCreated: (summary: ExperimentSummary) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [baseline, setBaseline] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runQuery, setRunQuery] = useState("");
  const [evaluationId, setEvaluationId] = useState("");
  const [runLimit, setRunLimit] = useState(40);
  const [nameConfirmed, setNameConfirmed] = useState("");
  const [existingWorkspace, setExistingWorkspace] = useState<ExperimentSummary | null>(null);
  const [useExisting, setUseExisting] = useState(true);
  // An evaluation change the user picked while runs were still selected. An
  // experiment holds runs from one evaluation, so switching discards the
  // selection — held here until the user confirms, so it is never silent.
  const [pendingEvaluationId, setPendingEvaluationId] = useState<string | null>(null);
  function applyEvaluation(next: string) {
    setEvaluationId(next);
    setExistingWorkspace(null);
    setSelected([]);
    setBaseline("");
    setRunLimit(40);
  }
  useEffect(() => {
    let active = true;
    if (!evaluationId) return;
    void evaluationApi.getExperimentSummary(evaluationId).then(async (source) => {
      const workspaceId = source.experiment.tags?.workspace_kind === "experiment" ? evaluationId : source.experiment.tags?.promoted_to;
      if (!workspaceId) return;
      const workspace = workspaceId === evaluationId ? source : await evaluationApi.getExperimentSummary(workspaceId);
      if (active && workspace.experiment.status !== "archived") {setExistingWorkspace(workspace); setUseExisting(true);}
    }).catch(() => { /* Optional suggestion; creation still validates its own request. */ });
    return () => {active = false;};
  }, [evaluationId]);
  const eligibleRuns = useMemo(() => runs.filter(canJoinExperiment), [runs]);
  const filteredRuns = useMemo(() => {
    const query = runQuery.trim().toLocaleLowerCase();
    return eligibleRuns.filter((run) => run.experiment?.experiment_id === evaluationId && (!query || [runDisplayName(run), run.run_id, run.experiment?.scenario].join(" ").toLocaleLowerCase().includes(query)));
  }, [eligibleRuns, runQuery, evaluationId]);
  const selectedRun = eligibleRuns.find((run) => run.run_id === selected[0]);
  const selectedBasis = selectedRun ? runComparisonKey(selectedRun) : null;
  const completedRuns = filteredRuns.slice(0, runLimit);

  function toggleRun(run: RunResult) {
    setSelected((current) => {
      if (current.includes(run.run_id)) {
        const next = current.filter((id) => id !== run.run_id);
        if (baseline === run.run_id) setBaseline(next[0] || "");
        return next;
      }
      if (current.length >= 4 || (selectedBasis && runComparisonKey(run) !== selectedBasis)) return current;
      const next = [...current, run.run_id];
      if (!baseline) setBaseline(run.run_id);
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    if (!name && !(selected.length && existingWorkspace && useExisting)) { setError("Enter an experiment name."); nameRef.current?.focus(); return; }
    if (selected.length && !baseline) { setError("Choose a baseline run."); return; }
    setSubmitting(true);
    setError(null);
    try {
      if (selected.length && existingWorkspace?.experiment.experiment_id && useExisting) {
        onCreated(await evaluationApi.attachExperimentRuns(existingWorkspace.experiment.experiment_id, tenantId, selected));
        return;
      }
      if (nameConfirmed !== name) {
        const matches = await evaluationApi.listExperimentWorkspaces(tenantId, {query: name, limit: 100});
        if (matches.items.some((item) => item.experiment.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
          setNameConfirmed(name);
          setError("An experiment already uses this name. Choose a different name, or submit again to confirm creating another.");
          return;
        }
      }
      if (!selected.length) {
        onCreated(await evaluationApi.createExperimentWorkspace({tenant_id: tenantId, name, description: String(form.get("objective") || "").trim() || undefined, hypothesis: String(form.get("hypothesis") || "").trim() || undefined, created_by: "user"}));
        return;
      }
      onCreated(await evaluationApi.createExperimentFromRuns({
        tenant_id: tenantId,
        name: String(form.get("name") || "").trim(),
        description: String(form.get("objective") || "").trim() || undefined,
        hypothesis: String(form.get("hypothesis") || "").trim() || undefined,
        run_ids: selected,
        baseline_run_id: baseline,
        created_by: "user",
      }));
    } catch (reason) {
      setError(userFacingError(reason, "Unable to create experiment"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      labelledBy="new-experiment-title"
      onClose={submitting ? () => undefined : onClose}
      scrimLabel="Dismiss new experiment overlay"
      initialFocusRef={nameRef}
      overlayClassName="z-[70]"
      scrimClassName="bg-black/45"
      width="w-[min(76rem,calc(100vw-2rem))]"
      className="max-h-[calc(100vh-2rem)] overflow-y-auto"
    >
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-6">
          <div><h2 id="new-experiment-title" className="text-lg font-semibold">New experiment</h2><p className="mt-1 text-sm text-muted-foreground">Describe the experiment. Optionally choose an evaluation and up to four compatible runs; otherwise add runs later.</p></div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} disabled={submitting} aria-label="Close new experiment dialog"><X className="size-4" aria-hidden="true" /></Button>
        </div>
        <form noValidate onSubmit={submit} className="p-5 sm:p-6">
          <fieldset disabled={submitting} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="experiment-name">Experiment name</Label><Input ref={nameRef} id="experiment-name" name="name" required placeholder="Enter an experiment name" autoComplete="off" /></div>
            <div className="space-y-2"><Label htmlFor="experiment-objective">Description</Label><textarea id="experiment-objective" name="objective" rows={3} className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring" /></div>
            <div className="space-y-2"><Label htmlFor="experiment-hypothesis">Hypothesis</Label><textarea id="experiment-hypothesis" name="hypothesis" rows={3} className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring" /></div>
          </fieldset>
          <div className="mt-6">
            <div className="flex items-end justify-between gap-3"><div><h3 className="text-sm font-semibold">Historical runs</h3><p className="mt-1 text-xs text-muted-foreground">The first run establishes the dataset, cases, evaluators, contract, gate composition, and evidence scope.</p></div><span className="text-xs text-muted-foreground">{selected.length}/4 selected</span></div>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><span role="status">{runsLoading ? "Loading run history…" : `${runs.length} of ${runsTotal ?? "unknown"} runs loaded. Only completed, comparable runs are offered below.`}</span>{runsError ? <span role="alert" className="text-destructive">{runsError}</span> : null}{runsError || runsTotal === null || runs.length < runsTotal ? <Button type="button" variant="outline" size="sm" disabled={runsLoading} onClick={onLoadMore}>{runsError ? "Retry loading runs" : "Load older runs"}</Button> : null}</div>
            <label className="mt-3 block text-sm">Evaluation
              <select aria-label="Choose evaluation for experiment" value={evaluationId} onChange={(event) => {const next = event.target.value; if (next === evaluationId) return; if (selected.length) {setPendingEvaluationId(next); return;} applyEvaluation(next);}} className="mt-1 block h-11 w-full rounded-lg border bg-background px-3">
                <option value="">No runs yet — add them later</option>
                {Array.from(new Map(eligibleRuns.filter((run) => run.experiment?.experiment_id).map((run) => [run.experiment!.experiment_id!, run])).entries()).map(([id, run]) => <option key={id} value={id}>{runDisplayName(run)} · {id.slice(0, 8)}</option>)}
              </select>
            </label>
            <SearchField containerClassName="mt-3 block" value={runQuery} onChange={(event) => {setRunQuery(event.target.value); setRunLimit(40);}} placeholder="Search run name or ID…" label="Search historical runs" />
            <p className="mt-2 text-xs text-muted-foreground">Showing {completedRuns.length} of {filteredRuns.length} matching runs{filteredRuns.length !== eligibleRuns.length ? ` · ${eligibleRuns.length} eligible in total` : ""}.</p>
            {selected.length ? <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => { setSelected([]); setBaseline(""); }}>Clear selection</Button> : null}
            <div className="mt-3 max-h-96 overflow-auto rounded-xl border">
              <table className="w-full min-w-[1100px] text-left text-sm">
                <caption className="sr-only">Choose runs from this evaluation, using the same columns as run history</caption>
                <thead className="sticky top-0 z-10 bg-card"><tr><th scope="col" className="px-3 py-3">Include</th><th scope="col" className="px-3 py-3">Baseline</th>{COLUMN_DEFS.map((column) => <th key={column.id} scope="col" className="px-3 py-3">{column.header}</th>)}</tr></thead>
                <tbody>{completedRuns.map((run) => {
                  const included = selected.includes(run.run_id);
                  const incompatible = Boolean(selectedBasis && runComparisonKey(run) !== selectedBasis);
                  const score = gatedRunScore(run);
                  const traceHref = tracesHrefForRun(run);
                  const position = eligibleRuns.indexOf(run);
                  const previous = eligibleRuns.slice(position + 1).find((candidate) => candidate.experiment?.experiment_id === evaluationId);
                  const delta = deltaAgainstPrevious(run, previous);
                  return <tr key={run.run_id} className={cn("border-t", included && "bg-brand/5")}>
                    <td className="px-3 py-3"><input type="checkbox" className="size-4 accent-[var(--brand-text)]" aria-label={`Include ${runDisplayName(run)} (${run.run_id})`} checked={included} aria-describedby={incompatible ? `run-basis-${run.run_id}` : undefined} disabled={submitting || incompatible || (!included && selected.length >= 4)} onChange={() => toggleRun(run)} /></td>
                    <td className="px-3 py-3"><input type="radio" name="baseline" className="size-4 accent-[var(--brand-text)]" aria-label={`Use run ${run.run_number ?? run.run_id.slice(0, 8)} as baseline`} checked={baseline === run.run_id} disabled={submitting || !included} onChange={() => setBaseline(run.run_id)} /></td>
                    <td className="min-w-48 px-3 py-3"><Link href={runDetailsHref(run.run_id)} target="_blank" rel="noreferrer" className="font-medium text-brand-text underline">{run.lineage?.source_run_id ? "Rescore" : "Run"} {run.run_number ?? run.run_id.slice(0, 8)}</Link><p className="mt-1 text-xs text-muted-foreground">{runScenarioTypeLabel(run)} · {run.experiment?.dataset_version}</p>{incompatible ? <p id={`run-basis-${run.run_id}`} className="mt-1 text-xs text-muted-foreground">Different comparison basis. Clear the selection to choose this run.</p> : null}</td>
                    <td className="px-3 py-3 font-mono text-xs" title={run.run_id}>{run.run_id.slice(0, 8)}</td>
                    <td className="px-3 py-3">{traceHref ? <Link href={traceHref} target="_blank" rel="noreferrer" className="text-brand-text underline">Open traces</Link> : "Not recorded"}</td>
                    <td className="px-3 py-3">{score == null ? "Not scored" : `${Math.round(score * 100)}%`}</td>
                    <td className="px-3 py-3">{delta.kind === "value" ? `${delta.delta > 0 ? "+" : ""}${(delta.delta * 100).toFixed(1)} pp` : delta.kind === "incomparable" ? delta.reason : "No earlier score"}</td>
                    <td className="px-3 py-3">{run.status}</td><td className="whitespace-nowrap px-3 py-3">{presentRunStart(run)}</td><td className="whitespace-nowrap px-3 py-3">{presentRunEnd(run).time ?? presentRunEnd(run).state ?? "Not recorded"}</td>
                  </tr>;
                })}</tbody>
              </table>
              {!completedRuns.length ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">{evaluationId ? "No matching completed runs. Clear the search or choose another evaluation." : "Choose an evaluation above to browse its runs."}</p> : null}
            </div>
          </div>
          {filteredRuns.length > runLimit ? <Button type="button" variant="outline" className="mt-3" onClick={() => setRunLimit((value) => value + 40)}>Show more runs</Button> : null}
          {existingWorkspace && selected.length ? <label className="mt-4 flex items-start gap-3 rounded-lg border border-primary/30 bg-muted/20 p-3 text-sm"><input type="checkbox" checked={useExisting} onChange={(event) => setUseExisting(event.target.checked)} className="mt-1 size-4" /><span>Add these runs to <strong>{existingWorkspace.experiment.name}</strong>, which already contains this evaluation. Uncheck to create a separate experiment. Its current description and baseline are preserved.</span></label> : null}
          {error ? <div role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div> : null}
          <div className="mt-6 flex justify-end gap-3 border-t pt-5"><Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button><Button type="submit" disabled={submitting}>{submitting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}{submitting ? "Saving…" : existingWorkspace && useExisting && selected.length ? "Add to existing experiment" : "Create experiment"}</Button></div>
        </form>
      {pendingEvaluationId !== null ? (
        <OverlayConfirmDialog
          tone="default"
          title="Switch evaluation and clear the selected runs?"
          description={`An experiment compares runs from one evaluation. Switching discards the ${selected.length} run${selected.length === 1 ? "" : "s"} you selected here.`}
          cancelLabel="Keep selection"
          confirmLabel="Switch and clear"
          onCancel={() => setPendingEvaluationId(null)}
          onConfirm={() => {
            applyEvaluation(pendingEvaluationId);
            setPendingEvaluationId(null);
          }}
        />
      ) : null}
    </Dialog>
  );
}
