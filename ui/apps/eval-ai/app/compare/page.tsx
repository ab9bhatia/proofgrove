"use client";

import { formatDate } from "@/lib/format-time";
import { datasetVersionLabel } from "@/lib/dataset-lineage";
import { PAGE_FRAME } from "@/lib/page-frame";
import Link from "next/link";
import { CARDS_PER_PAGE } from "@/lib/pagination";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  GitCompareArrows,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { Button, buttonVariants } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@evalai/shared/ui/dropdown-menu";
import { ProofgroveGate } from "@/components/proofgrove-gate";
import { LegacyEvaluationRouteRedirect } from "@/components/legacy-evaluation-redirect";
import { api, evaluationApi, type ExperimentDefinition, type RunResult } from "@/lib/api";
import {
  formatRunScore,
  runDisplayName,
  runInvokesTarget,
  runScenarioTypeLabel,
  scenarioTypeLabel,
} from "@/lib/run-recommendation";
import { cn } from "@evalai/shared/utils";
import { SearchField } from "@/components/toolbar";
import { RunOutcomeBadge } from "@/components/run-outcome-badge";

type LifecycleFilter = "active" | "archived";
type ExperimentAction = "run" | "archive" | "restore";
const EXPERIMENTS_PAGE_SIZE = CARDS_PER_PAGE;

export interface ExperimentGroup {
  key: string;
  name: string;
  definitions: ExperimentDefinition[];
  runs: RunResult[];
  latest: ExperimentDefinition;
  typeLabel: string;
  targetLabel: string;
  archived: boolean;
  lastActivity: string | null;
}

// Shared implementation retained for its exported helpers/components and tests.
// The `/compare` route itself now forwards to the canonical evaluations library.
export function ExperimentsPage() {
  return (
    <ProofgroveGate>
      <Suspense
        fallback={
          <div className="flex justify-center py-24">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
        }
      >
        <ExperimentsView />
      </Suspense>
    </ProofgroveGate>
  );
}

// Legacy `/compare` route → forwards to `/evaluations?tab=experiments`.
export default function CompareRedirect() {
  return <LegacyEvaluationRouteRedirect />;
}

function ExperimentsView() {
  const router = useRouter();
  const [experiments, setExperiments] = useState<ExperimentDefinition[]>([]);
  const [runs, setRuns] = useState<RunResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [lifecycle, setLifecycle] = useState<LifecycleFilter>("active");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [experimentAction, setExperimentAction] = useState<{
    action: ExperimentAction;
    group: ExperimentGroup;
  } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const closeExperimentAction = useCallback(() => {
    setExperimentAction(null);
    setActionError(null);
  }, []);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const { tenant_id: tenantId } = await api.tenant();
      const [experimentList, runList] = await Promise.all([
        evaluationApi.listExperiments(),
        evaluationApi.listRuns(tenantId),
      ]);
      setExperiments(experimentList);
      setRuns(runList);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load experiments");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const groups = useMemo(() => buildExperimentGroups(experiments, runs), [experiments, runs]);
  const activeCount = groups.filter((group) => !group.archived).length;
  const archivedCount = groups.filter((group) => group.archived).length;
  const visibleGroups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return groups.filter((group) => {
      if (lifecycle === "active" ? group.archived : !group.archived) return false;
      if (!normalized) return true;
      const searchable = [
        group.name,
        datasetVersionLabel(group.latest.dataset_version),
        group.targetLabel,
        group.latest.target_version,
        group.latest.judge_model,
        group.typeLabel,
        // "Mixed" describes the group but matches no query a reader would type,
        // so search on the kinds the runs actually are as well.
        ...group.runs.map(runScenarioTypeLabel),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return searchable.includes(normalized);
    });
  }, [groups, lifecycle, query]);
  const pageCount = Math.max(1, Math.ceil(visibleGroups.length / EXPERIMENTS_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedGroups = visibleGroups.slice(
    (currentPage - 1) * EXPERIMENTS_PAGE_SIZE,
    currentPage * EXPERIMENTS_PAGE_SIZE,
  );

  async function confirmExperimentAction() {
    if (!experimentAction || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      if (experimentAction.action === "run") {
        const experimentId = experimentAction.group.latest.experiment_id;
        const sourceRunId = experimentAction.group.runs[0]?.run_id;
        if (!experimentId) throw new Error("The latest saved configuration has no experiment id.");
        if (!sourceRunId) throw new Error("No saved run evidence is available to rescore.");
        const result = await evaluationApi.createExperimentRescore(experimentId, {
          source_run_id: sourceRunId,
          created_by: "user",
        });
        setExperimentAction(null);
        router.push(`/runs/${encodeURIComponent(result.run_id)}`);
        return;
      }

      const experimentIds = experimentLifecycleIds(
        experimentAction.group,
        experimentAction.action,
      );
      for (const experimentId of experimentIds) {
        if (experimentAction.action === "archive") {
          await evaluationApi.archiveExperiment(experimentId);
        } else {
          await evaluationApi.restoreExperiment(experimentId);
        }
      }
      setExperimentAction(null);
      setExpandedKey(null);
      await load(true);
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : experimentAction.action === "run"
            ? "Unable to run the experiment again"
            : `Unable to ${experimentAction.action} the experiment`,
      );
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className={PAGE_FRAME}>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b pb-6">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand-text dark:bg-brand/15 dark:text-brand">
            <GitCompareArrows className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold leading-none tracking-tight">Experiments</h1>
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
              Revisit evaluation setups, inspect their configuration, and open the runs they produced.
            </p>
          </div>
        </div>
        <Button
          type="button"
          className="shrink-0"
          onClick={() => router.push("/evaluate")}
        >
          <Plus className="size-4" aria-hidden="true" />
          New evaluation
        </Button>
      </header>

      {error ? (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Your experiments</h2>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Each row groups persisted evaluation configurations sharing the same evaluation name.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg bg-muted p-1 text-xs" aria-label="Experiment lifecycle">
              <button
                type="button"
                onClick={() => {
                  setLifecycle("active");
                  setPage(1);
                  setExpandedKey(null);
                }}
                className={cn(
                  "rounded-lg px-3 py-1.5 font-medium transition-colors",
                  lifecycle === "active" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                )}
              >
                Active ({activeCount})
              </button>
              <button
                type="button"
                onClick={() => {
                  setLifecycle("archived");
                  setPage(1);
                  setExpandedKey(null);
                }}
                className={cn(
                  "rounded-lg px-3 py-1.5 font-medium transition-colors",
                  lifecycle === "archived" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                )}
              >
                Archived ({archivedCount})
              </button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9 shrink-0"
              onClick={() => void load(true)}
              disabled={loading || refreshing}
              aria-label="Refresh experiments"
              title="Refresh experiments"
            >
              <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div className="border-b px-5 py-3">
            <SearchField
              containerClassName="block max-w-lg"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
                setExpandedKey(null);
              }}
              placeholder="Search by name, dataset, target, or judge"
              label="Search experiments"
            />
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading experiments…
          </div>
        ) : visibleGroups.length === 0 ? (
          <EmptyExperiments
            lifecycle={lifecycle}
            hasQuery={Boolean(query.trim())}
            onCreate={() => router.push("/evaluate")}
          />
        ) : (
          <ExperimentLibrary
            groups={pagedGroups}
            expandedKey={expandedKey}
            onToggle={(key) => setExpandedKey((current) => (current === key ? null : key))}
            onRunAgain={(group) => {
              setActionError(null);
              setExperimentAction({ action: "run", group });
            }}
            onLifecycle={(action, group) => {
              setActionError(null);
              setExperimentAction({ action, group });
            }}
          />
        )}
        {!loading && visibleGroups.length > 0 ? (
          <ExperimentPagination
            page={currentPage}
            pageCount={pageCount}
            total={visibleGroups.length}
            pageSize={EXPERIMENTS_PAGE_SIZE}
            onPageChange={(nextPage) => {
              setPage(nextPage);
              setExpandedKey(null);
            }}
          />
        ) : null}
      </section>
      {experimentAction ? (
        <ExperimentActionDialog
          action={experimentAction.action}
          group={experimentAction.group}
          busy={actionBusy}
          error={actionError}
          onCancel={closeExperimentAction}
          onConfirm={() => void confirmExperimentAction()}
        />
      ) : null}
    </div>
  );
}

export function ExperimentPagination({
  page,
  pageCount,
  total,
  pageSize,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-xs text-muted-foreground">
      <span>
        Showing {start}–{end} of {total} experiment{total === 1 ? "" : "s"}
      </span>
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">Page {page} of {pageCount}</span>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          aria-label="Previous experiments"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={() => onPageChange(Math.min(pageCount, page + 1))}
          disabled={page >= pageCount}
          aria-label="Next experiments"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export function ExperimentLibrary({
  groups,
  expandedKey,
  onToggle,
  onRunAgain,
  onLifecycle,
}: {
  groups: ExperimentGroup[];
  expandedKey: string | null;
  onToggle: (key: string) => void;
  onRunAgain?: (group: ExperimentGroup) => void;
  onLifecycle?: (action: "archive" | "restore", group: ExperimentGroup) => void;
}) {
  return (
    <div>
      <table className="hidden w-full table-fixed text-left text-sm md:table">
        <caption className="sr-only">Experiments available for comparison</caption>
        <colgroup>
          <col className="w-[30%]" />
          <col className="w-[16%]" />
          <col className="w-[24%]" />
          <col className="w-[14%]" />
          <col className="w-[12%]" />
          <col className="w-[4%]" />
        </colgroup>
        <thead className="bg-muted/35 text-muted-foreground">
          <tr>
            <th className="px-5 py-3 font-medium">Experiment</th>
            <th className="px-3 py-3 font-medium">Type</th>
            <th className="px-3 py-3 font-medium">Dataset</th>
            <th className="px-3 py-3 font-medium">History</th>
            <th className="px-3 py-3 font-medium">Last activity</th>
            <th aria-label="Expand" />
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const expanded = expandedKey === group.key;
            return (
              <ExperimentDesktopRows
                key={group.key}
                group={group}
                expanded={expanded}
                onToggle={() => onToggle(group.key)}
                onRunAgain={onRunAgain}
                onLifecycle={onLifecycle}
              />
            );
          })}
        </tbody>
      </table>

      <div className="divide-y md:hidden">
        {groups.map((group) => {
          const expanded = expandedKey === group.key;
          return (
            <article key={group.key} className="px-4 py-4">
              <button
                type="button"
                onClick={() => onToggle(group.key)}
                aria-expanded={expanded}
                className="flex w-full items-start justify-between gap-3 text-left"
              >
                <span className="min-w-0">
                  <span className="block font-semibold leading-5">{group.name}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {group.typeLabel} · {group.runs.length} run{group.runs.length === 1 ? "" : "s"}
                  </span>
                </span>
                <ChevronDown className={cn("mt-0.5 size-4 shrink-0 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
              </button>
              <dl className="mt-3 grid grid-cols-2 gap-3 rounded-lg border bg-muted/15 p-3 text-xs">
                <Detail label="Dataset" value={datasetVersionLabel(group.latest.dataset_version)} />
                <Detail label="Target" value={group.targetLabel} />
                <Detail label="Configurations" value={String(group.definitions.length)} />
                <Detail label="Last activity" value={formatDate(group.lastActivity)} />
              </dl>
              {expanded ? (
                <ExperimentDetails
                  group={group}
                  className="mt-3"
                  onRunAgain={onRunAgain}
                  onLifecycle={onLifecycle}
                />
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ExperimentDesktopRows({
  group,
  expanded,
  onToggle,
  onRunAgain,
  onLifecycle,
}: {
  group: ExperimentGroup;
  expanded: boolean;
  onToggle: () => void;
  onRunAgain?: (group: ExperimentGroup) => void;
  onLifecycle?: (action: "archive" | "restore", group: ExperimentGroup) => void;
}) {
  return (
    <>
      <tr className={cn("border-t transition-colors hover:bg-muted/20", expanded && "bg-muted/35")}>
        <td className="px-5 py-4">
          <button type="button" onClick={onToggle} aria-expanded={expanded} className="block w-full min-w-0 text-left">
            <span className="block truncate font-semibold">{group.name}</span>
            <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
              {group.latest.experiment_id}
            </span>
          </button>
        </td>
        <td className="px-3 py-4 text-xs">{group.typeLabel}</td>
        <td className="px-3 py-4">
          <p className="truncate text-xs font-medium" title={datasetVersionLabel(group.latest.dataset_version)}>{datasetVersionLabel(group.latest.dataset_version)}</p>
          <p className="mt-1 truncate text-[11px] text-muted-foreground" title={group.targetLabel}>{group.targetLabel}</p>
        </td>
        <td className="px-3 py-4 text-xs">
          <p>{group.runs.length} run{group.runs.length === 1 ? "" : "s"}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {group.definitions.length} configuration{group.definitions.length === 1 ? "" : "s"}
          </p>
        </td>
        <td className="px-3 py-4 text-xs text-muted-foreground">{formatDate(group.lastActivity)}</td>
        <td className="pr-4 text-right">
          <button type="button" onClick={onToggle} aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name}`} className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
            <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr className="border-t bg-muted/10">
          <td colSpan={6} className="px-5 py-4">
            <ExperimentDetails
              group={group}
              onRunAgain={onRunAgain}
              onLifecycle={onLifecycle}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ExperimentDetails({
  group,
  className,
  onRunAgain,
  onLifecycle,
}: {
  group: ExperimentGroup;
  className?: string;
  onRunAgain?: (group: ExperimentGroup) => void;
  onLifecycle?: (action: "archive" | "restore", group: ExperimentGroup) => void;
}) {
  const recentRuns = group.runs.slice(0, 3);
  return (
    <div className={cn("grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,1fr)]", className)}>
      <div className="rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Latest configuration</p>
            <p className="mt-1 text-xs text-muted-foreground">Use this saved setup without rebuilding it.</p>
          </div>
          {onRunAgain || onLifecycle ? (
            <div className="flex shrink-0 items-center gap-2">
              {onRunAgain ? (
                <Button type="button" size="sm" onClick={() => onRunAgain(group)}>
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  Rescore saved evidence
                </Button>
              ) : null}
              {onLifecycle ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label={`More actions for ${group.name}`}
                    >
                      <MoreHorizontal className="size-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    <DropdownMenuItem
                      onSelect={() => onLifecycle(group.archived ? "restore" : "archive", group)}
                      className={cn(!group.archived && "text-destructive focus:text-destructive")}
                    >
                      {group.archived ? (
                        <RotateCcw className="size-4" aria-hidden="true" />
                      ) : (
                        <Archive className="size-4" aria-hidden="true" />
                      )}
                      {group.archived ? "Restore experiment" : "Archive experiment"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          ) : null}
        </div>
        <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
          <Detail label="Dataset" value={datasetVersionLabel(group.latest.dataset_version)} />
          <Detail label="Target" value={group.targetLabel} />
          <Detail label="Judge" value={group.latest.judge_model || "Not assigned"} />
          <Detail label="Created" value={formatDate(group.latest.created_at ?? null)} />
        </dl>
      </div>
      <div className="rounded-lg border bg-background p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Recent runs</p>
            <p className="mt-1 text-xs text-muted-foreground">Open a run to inspect its report and evidence.</p>
          </div>
          <Link href="/evaluations" className={buttonVariants({ variant: "outline", size: "sm" })}>
            All runs
          </Link>
        </div>
        {recentRuns.length ? (
          <div className="mt-3 divide-y rounded-lg border">
            {recentRuns.map((run) => (
              <Link key={run.run_id} href={`/runs/${encodeURIComponent(run.run_id)}`} className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-muted/30">
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{runDisplayName(run)}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{formatDate(run.completed_at || run.started_at)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-xs">{formatRunScore(run)}</span>
                  <RunOutcomeBadge run={run} />
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-3 rounded-lg border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">No runs are available for this experiment.</p>
        )}
      </div>
    </div>
  );
}

function EmptyExperiments({
  lifecycle,
  hasQuery,
  onCreate,
}: {
  lifecycle: LifecycleFilter;
  hasQuery: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-brand/10 text-brand-text dark:bg-brand/15 dark:text-brand">
        <FlaskConical className="size-5" aria-hidden="true" />
      </span>
      <h3 className="mt-4 text-sm font-semibold">
        {hasQuery ? "No matching experiments" : lifecycle === "archived" ? "No archived experiments" : "No experiments yet"}
      </h3>
      <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">
        {hasQuery
          ? "Try a different name, dataset, target, or judge."
          : lifecycle === "archived"
            ? "Archived experiments will remain available here with their run history."
            : "Start an evaluation to create a persisted experiment and its first run."}
      </p>
      {!hasQuery && lifecycle === "active" ? (
        <Button type="button" className="mt-5" onClick={onCreate}>
          Start evaluation
        </Button>
      ) : null}
    </div>
  );
}

export function ExperimentActionDialog({
  action,
  group,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  action: ExperimentAction;
  group: ExperimentGroup;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const running = action === "run";
  const restoring = action === "restore";
  const Icon = running ? RefreshCw : restoring ? RotateCcw : Archive;

  const title = running
    ? "Rescore saved evidence?"
    : restoring
      ? "Restore experiment?"
      : "Archive experiment?";
  const confirmLabel = running
    ? "Start diagnostic rescore"
    : restoring
      ? "Restore experiment"
      : "Archive experiment";

  return (
    <Dialog
      labelledBy="experiment-action-title"
      describedBy="experiment-action-description"
      onClose={busy ? () => undefined : onCancel}
      scrimLabel={`Cancel ${action} experiment`}
      initialFocusRef={cancelRef}
      overlayClassName="z-[60]"
      scrimClassName="bg-black/45 backdrop-blur-[1px]"
      width="w-[min(28rem,calc(100vw-2rem))]"
      className="shrink-0 overflow-y-auto p-5 sm:p-6"
    >
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-foreground">
          <Icon className={cn("size-4.5", busy && running && "animate-spin")} aria-hidden="true" />
        </div>
        <h2 id="experiment-action-title" className="mt-4 text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <p id="experiment-action-description" className="mt-2 text-sm leading-6 text-muted-foreground">
          {running
            ? `The latest immutable evidence for “${group.name}” will be scored again. The target will not be invoked, and the result is diagnostic only with no release verdict or gate.`
            : restoring
              ? `“${group.name}” will return to Active experiments with its saved configurations and ${group.runs.length} historical run${group.runs.length === 1 ? "" : "s"}.`
              : `“${group.name}” will be removed from Active experiments. Its ${group.runs.length} historical run${group.runs.length === 1 ? "" : "s"}, reports, and evidence will remain available in Archived.`}
        </p>
        {error ? (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn("w-full sm:w-auto", action === "archive" && "bg-red-700 text-white hover:bg-red-800")}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {busy ? (running ? "Rescoring…" : restoring ? "Restoring…" : "Archiving…") : confirmLabel}
          </Button>
        </div>
    </Dialog>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-medium leading-5">{value}</dd>
    </div>
  );
}

export function buildExperimentGroups(
  experiments: ExperimentDefinition[],
  runs: RunResult[],
): ExperimentGroup[] {
  const grouped = new Map<string, ExperimentDefinition[]>();
  for (const experiment of experiments) {
    const name = experiment.tags?.evaluation_name?.trim() || experiment.name.trim() || "Untitled experiment";
    const key = name.toLocaleLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), experiment]);
  }

  return [...grouped.entries()]
    .map(([key, definitions]) => {
      const sortedDefinitions = [...definitions].sort(
        (a, b) => timestamp(b.created_at) - timestamp(a.created_at),
      );
      const ids = new Set(sortedDefinitions.map((item) => item.experiment_id).filter(Boolean));
      const relatedRuns = runs
        .filter((run) => {
          const experimentId = run.experiment?.experiment_id;
          return Boolean(experimentId && ids.has(experimentId));
        })
        .sort((a, b) => runTimestamp(b) - runTimestamp(a));
      const latest = sortedDefinitions[0]!;
      const runLabels = new Set(relatedRuns.map(runScenarioTypeLabel));
      const lastActivityTimestamp = Math.max(
        timestamp(latest.created_at),
        ...relatedRuns.map(runTimestamp),
      );
      return {
        key,
        name: latest.tags?.evaluation_name?.trim() || latest.name,
        definitions: sortedDefinitions,
        runs: relatedRuns,
        latest,
        // Both labels describe the whole group, so neither can be read off the
        // newest run alone: a group whose most recent run is an existing-responses
        // one showed "Not invoked" for siblings that did hit a real endpoint, and
        // dropped that endpoint from the search index with it.
        typeLabel: runLabels.size === 1 ? [...runLabels][0]! : runLabels.size ? "Mixed" : scenarioTypeLabel(latest.scenario),
        targetLabel:
          relatedRuns.length && relatedRuns.every((run) => runInvokesTarget(run) === false)
            ? "Not invoked"
            : targetLabel(latest),
        archived: sortedDefinitions.every((item) => item.status === "archived"),
        lastActivity: lastActivityTimestamp > 0 ? new Date(lastActivityTimestamp).toISOString() : null,
      };
    })
    .sort((a, b) => timestamp(b.lastActivity) - timestamp(a.lastActivity));
}

export function experimentLifecycleIds(
  group: ExperimentGroup,
  action: "archive" | "restore",
): string[] {
  return group.definitions
    .filter((definition) =>
      action === "archive" ? definition.status !== "archived" : definition.status === "archived",
    )
    .map((definition) => definition.experiment_id)
    .filter((id): id is string => Boolean(id));
}

function targetLabel(experiment: ExperimentDefinition): string {
  if (experiment.target_version?.trim()) return experiment.target_version.trim();
  const endpoint = experiment.target_endpoint.trim();
  try {
    const url = new URL(endpoint);
    return url.hostname;
  } catch {
    return endpoint.split("/").filter(Boolean).at(-1) || endpoint;
  }
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function runTimestamp(run: RunResult): number {
  return timestamp(run.completed_at || run.started_at);
}
