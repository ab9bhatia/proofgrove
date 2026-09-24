"use client";

import { PAGE_FRAME } from "@/lib/page-frame";
import Link from "next/link";
import { pickText } from "@/components/report/lib";
import { OverlayConfirmDialog } from "@/components/ui/confirm-dialog";
import { FINDINGS_PER_PAGE } from "@/lib/pagination";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  FlaskConical,
  Loader2,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  Wrench,
  X,
} from "lucide-react";
import { Button, buttonVariants } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@evalai/shared/ui/label";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@evalai/shared/utils";
import { CopyIdButton } from "@/components/copyable-id";
import { EvalHubGate } from "@/components/eval-hub-gate";
import { PageHeader } from "@/components/page-header";
import { ErrorState, LoadingState, TableSkeleton } from "@/components/page-state";
import { useUIState } from "@/components/ui-state";
import {
  api,
  platformApi,
  evaluationApi,
  type RunItemDetail,
  type Finding,
  type RegressionCase,
  type Remediation,
  type ReviewDecisionRecord,
  type ReviewTask,
  type RunResult,
} from "@/lib/api";
import {
  attentionCountLabel,
  attentionCoverageNote,
  attentionRunHref,
  latestCompletedRuns,
  runsNeedingAttention,
  type AttentionCoverage,
} from "@/lib/attention";
import { runHistoryApi, sweepRunHistory } from "@/lib/run-history";
import { RunOutcomeBadge } from "@/components/run-outcome-badge";
import { CopyButton } from "@/components/copy-button";
import { runScenarioTypeLabel } from "@/lib/run-recommendation";
import { GateBadge } from "@/components/gate-badge";
import { userFacingError } from "@/lib/api-errors";
import { formatDate, formatDateTime } from "@/lib/format-time";
import { SearchField } from "@/components/toolbar";
import {
  commentToActivityEvent,
  commentValidationError,
  relativeTimeLabel,
  reviewCollabApi,
  type ActivityEvent,
  type ActivityKind,
} from "@/lib/review-collab";

type ReviewTab = "queue" | "regressions";

/**
 * Deep link from a review finding to its run report with the case dialog
 * opened. Finding.`row_id` is the case identifier — the same value domain as
 * `RunItemSummary.example_id` — so the URL contract is
 * `/runs/{id}?item={example_id}`. Must round-trip with `runReportRequest`,
 * with both identifiers percent-encoded exactly once.
 */
export function runEvidenceHref(finding: Pick<Finding, "run_id" | "row_id">): string {
  // row_id ≡ example_id for review findings (persisted from the evaluated row).
  return `/runs/${encodeURIComponent(finding.run_id)}?item=${encodeURIComponent(finding.row_id)}`;
}

/**
 * A review is only recordable once the reviewer makes an explicit decision and
 * supplies a rationale. There is intentionally no default outcome so a reviewer
 * cannot "confirm" a finding by simply clicking save.
 */
export function reviewDecisionError(
  outcome: string | null | undefined,
  rationale: string,
): string | null {
  if (!outcome) return "Select a decision before saving.";
  if (!rationale.trim()) return "Add a reviewer note before saving.";
  return null;
}

/**
 * A governance decision is an audit event, so it must carry a real reviewer
 * identity. While the current-user identity is unresolved (the ui-state
 * placeholder is in effect), recording is blocked rather than attributing the
 * decision to a placeholder actor.
 */
export function reviewIdentityError(identityResolved: boolean): string | null {
  return identityResolved ? null : "Sign-in identity required to record a governance decision.";
}
type StatusFilter = "active" | "resolved" | "all";
const PAGE_SIZE = FINDINGS_PER_PAGE;
const SEVERITY_ORDER: Record<Finding["severity"], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * The reviewer-facing decision vocabulary. Both the decision form and the
 * decision-history log render from this single source so a recorded outcome is
 * never shown under a different label than the one the reviewer picked.
 */
type DecisionOutcomeOption = { value: ReviewDecisionRecord["outcome"]; label: string };

/**
 * A finding raised by a failure. "Confirm" means the failure is real, which is
 * agreement with the judge.
 */
export const DECISION_OUTCOMES: DecisionOutcomeOption[] = [
  { value: "agree", label: "Confirm finding" },
  { value: "disagree", label: "Reject finding" },
  { value: "abstain", label: "Need more context" },
];

/**
 * A case the judge PASSED, sent for a second opinion rather than raised by a
 * failure. The wording above inverts here: throughout this workflow "finding"
 * means a problem, so a reviewer shown "Confirm finding" on a passing case
 * reads it as "yes, there is a problem" — and the store would record that as
 * AGREEING with the judge, the exact opposite of what they meant. Since
 * measuring false passes is half the reason this flow exists, the labels have
 * to name the judge's call, not the finding.
 */
export const DECISION_OUTCOMES_PASSED: DecisionOutcomeOption[] = [
  { value: "agree", label: "Judge was right to pass" },
  { value: "disagree", label: "Should have failed" },
  { value: "abstain", label: "Need more context" },
];

export function decisionOutcomes(gateResult?: string | null): DecisionOutcomeOption[] {
  return gateResult === "pass" ? DECISION_OUTCOMES_PASSED : DECISION_OUTCOMES;
}

export function decisionOutcomeLabel(outcome: string, gateResult?: string | null): string {
  return decisionOutcomes(gateResult).find((option) => option.value === outcome)?.label ?? humanize(outcome);
}

export type ReviewDrawerState = "loading" | "details-error" | "decision" | "completed";

/**
 * Decide what the drawer's decision area renders. The "completed" state is
 * reachable ONLY once review-task loading has succeeded (`detailsLoaded`) with
 * no active task — a load failure or an unresolved load must never render as a
 * completed/decided review.
 */
export function reviewDrawerState(input: {
  detailsLoading: boolean;
  detailsLoaded: boolean;
  detailsError: string | null;
  hasActiveTask: boolean;
}): ReviewDrawerState {
  if (input.detailsLoading || (!input.detailsLoaded && !input.detailsError)) return "loading";
  if (input.detailsError) return "details-error";
  if (input.hasActiveTask) return "decision";
  return "completed";
}

/** Keep a requested page within the available range so ?page=N can't point past data. */
export function pageWithinBounds(page: number, pageCount: number): number {
  const upperBound = Math.max(1, pageCount);
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, upperBound);
}

type FindingDetails = {
  tasks: ReviewTask[];
  remediations: Remediation[];
  decisions: ReviewDecisionRecord[];
  /** Set when the decision-history read failed; the audit trail is unknown, not empty. */
  decisionsError?: string;
};

export default function ReviewsPage() {
  return (
    <EvalHubGate>
      <Suspense fallback={<LoadingState label="Loading review workspace…" className="min-h-48" />}>
        <ReviewsView />
      </Suspense>
    </EvalHubGate>
  );
}

function ReviewsView() {
  const { fullName, identityResolved } = useUIState();
  const searchParams = useSearchParams();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [attentionRuns, setAttentionRuns] = useState<RunResult[]>([]);
  const [attentionCoverage, setAttentionCoverage] = useState<AttentionCoverage>({
    scanned: 0,
    total: 0,
  });
  const [details, setDetails] = useState<Record<string, FindingDetails>>({});
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsReloadToken, setDetailsReloadToken] = useState(0);
  const [regressions, setRegressions] = useState<RegressionCase[]>([]);
  const [regressionsLoading, setRegressionsLoading] = useState(true);
  const [regressionsError, setRegressionsError] = useState<string | null>(null);
  const [tab, setTab] = useState<ReviewTab>(() => searchParams.get("tab") === "regressions" ? "regressions" : "queue");
  const [status, setStatus] = useState<StatusFilter>(() => {
    const requested = searchParams.get("status");
    return requested === "resolved" || requested === "all" ? requested : "active";
  });
  const [query, setQuery] = useState(() => searchParams.get("query") || "");
  const [severity, setSeverity] = useState(() => searchParams.get("severity") || "");
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get("finding"));
  const [page, setPage] = useState(() => {
    const requested = Number(searchParams.get("page"));
    return Number.isInteger(requested) && requested > 0 ? requested : 1;
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams();
    if (tab !== "queue") params.set("tab", tab);
    if (status !== "active") params.set("status", status);
    if (query) params.set("query", query);
    if (severity) params.set("severity", severity);
    if (selectedId) params.set("finding", selectedId);
    if (page > 1) params.set("page", String(page));
    const search = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
  }, [page, query, selectedId, severity, status, tab]);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const tenant = await api.tenant();
      // Tenant-scoped so every listed finding's run deep-link is readable.
      // Attention runs come from the paginated run history, not the legacy
      // `listRuns` list: that endpoint's store caps at 50 rows, which would
      // silently drop evaluations from the governance queue and its count.
      const [findingList, runSweep] = await Promise.all([
        platformApi.listFindings(tenant.tenant_id),
        sweepRunHistory(runHistoryApi.list, { tenant_id: tenant.tenant_id }),
      ]);
      const runNames = new Map(runSweep.runs.map((run) => [run.run_id, run.experiment?.tags?.evaluation_name || run.experiment?.name || run.experiment?.experiment_id]));
      setFindings(findingList.map((finding) => ({...finding, evidence: {...finding.evidence, evaluation_name: runNames.get(finding.run_id) || finding.evidence?.evaluation_name}})));
      setAttentionRuns(runsNeedingAttention(latestCompletedRuns(runSweep.runs)));
      setAttentionCoverage({ scanned: runSweep.scanned, total: runSweep.total });
      setLoading(false);
      setRegressionsLoading(true);
      setRegressionsError(null);
      try {
        const regressionList = await platformApi.listRegressions(tenant.tenant_id);
        setRegressions(regressionList);
      } catch (reason) {
        setRegressionsError(userFacingError(reason, "Unable to load the regression library"));
      } finally {
        setRegressionsLoading(false);
      }
    } catch (reason) {
      setError(userFacingError(reason, "Unable to load the review queue"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId || details[selectedId]) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setDetailsLoading(true);
      setDetailsError(null);
      Promise.all([
        platformApi.listReviewTasks(selectedId),
        platformApi.listRemediations(selectedId),
        // A history failure must not blank the tasks/remediations, but it also
        // must not masquerade as an empty audit trail — surface it explicitly.
        platformApi
          .listReviewDecisionHistory(selectedId)
          .then((decisions) => ({ decisions, decisionsError: undefined as string | undefined }))
          .catch((reason) => ({
            decisions: [] as ReviewDecisionRecord[],
            decisionsError: userFacingError(reason, "Unable to load decision history"),
          })),
      ])
      .then(([tasks, remediations, history]) => {
        if (active)
          setDetails((current) => ({
            ...current,
            [selectedId]: { tasks, remediations, decisions: history.decisions, decisionsError: history.decisionsError },
          }));
      })
      .catch((reason) => {
        if (active) setDetailsError(userFacingError(reason, "Unable to load review details"));
      })
      .finally(() => { if (active) setDetailsLoading(false); });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [details, selectedId, detailsReloadToken]);

  const retryDetails = useCallback(() => {
    setDetailsError(null);
    // Re-run the details effect; details[selectedId] is still absent after a
    // failure, so bumping the token re-triggers the fetch.
    setDetailsReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const filtered = useMemo(
    () => sortFindings(filterFindings(findings, { status, query, severity })),
    [findings, query, severity, status],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = pageWithinBounds(page, pageCount);
  // When a filter shrinks the result set below the active page (or a deep-linked
  // ?page=N points past the data), reset the page state itself — and, via the
  // URL-sync effect, ?page=N — instead of only clamping for display. Adjusting
  // state during render is React's recommended alternative to an effect here.
  // Guarded on !loading so a deep-linked page isn't clobbered while findings are
  // still empty (pageCount would momentarily be 1 before data arrives).
  if (!loading && currentPage !== page) {
    setPage(currentPage);
  }
  const pageFindings = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selected = findings.find((finding) => finding.finding_id === selectedId) ?? null;
  // Position in the filtered queue, so a reviewer can work straight down it. With
  // ten findings and no next control, the only way through was to close the sheet
  // and reopen it ten times. Ordered by the same sort the list shows, so "3 of 10"
  // means the third row down.
  const selectedIndex = selected ? filtered.findIndex((item) => item.finding_id === selected.finding_id) : -1;
  const stepQueue = useCallback(
    (delta: number) => {
      const next = filtered[selectedIndex + delta];
      if (next) setSelectedId(next.finding_id);
    },
    [filtered, selectedIndex],
  );
  const openCount = findings.filter((finding) => finding.status === "open").length;
  const inReviewCount = findings.filter((finding) => finding.status === "in_review").length;
  const completedCount = findings.filter((finding) =>
    ["resolved", "waived", "promoted"].includes(finding.status),
  ).length;

  async function refreshAndClose() {
    // Drop the cached details for the finding just decided, so reopening it
    // refetches and shows the newly appended (superseding) decision history
    // instead of the stale cache.
    setDetails((current) => {
      if (!selectedId || !(selectedId in current)) return current;
      const next = { ...current };
      delete next[selectedId];
      return next;
    });
    setSelectedId(null);
    await load(true);
  }

  return (
    <div className={`${PAGE_FRAME} lg:px-8`}>
      <PageHeader
        section="Review"
        title="Reviews"
        description="Triage flagged cases, confirm the evidence, and turn verified failures into follow-up work."
        actions={
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => void load(true)}
            disabled={loading || refreshing}
            aria-label="Refresh review queue"
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden="true" />
          </Button>
        }
      />

      {error ? (
        <div
          role="alert"
          className="mb-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {(!error || findings.length > 0) ? <section aria-label="Review workspace">
        {error ? <p role="status" className="border-b px-5 py-3 text-sm text-muted-foreground">Showing previously loaded findings. Refresh failed; counts may be out of date.</p> : null}
          <Tabs value={tab} onValueChange={(value) => setTab(value as ReviewTab)} variant="pill">
            <TabsList
              aria-label="Review workspace"
              className="workspace-switcher"
            >
              <TabsTrigger
                value="queue"
                id="review-tab-queue"
                aria-controls="review-panel"
                className="font-display text-sm font-semibold tracking-tight"
              >
                Review queue
                <span className="ml-2 tabular-nums text-muted-foreground">{openCount + inReviewCount}</span>
              </TabsTrigger>
              <TabsTrigger
                value="regressions"
                id="review-tab-regressions"
                aria-controls="review-panel"
                className="font-display text-sm font-semibold tracking-tight"
              >
                Regression library
                <span className="ml-2 tabular-nums text-muted-foreground">{regressions.length}</span>
              </TabsTrigger>
            </TabsList>

        <div className="mt-5 overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b px-5 py-3 text-xs">
            <QueueCount label="Open" value={openCount} tone="critical" />
            <QueueCount label="In review" value={inReviewCount} tone="attention" />
            <QueueCount label="Completed" value={completedCount} tone="complete" />
          </div>

        {tab === "queue" ? (
          <TabsPanel id="review-panel" aria-labelledby="review-tab-queue">
            <ReviewToolbar
              query={query}
              status={status}
              severity={severity}
              onQueryChange={(value) => {
                setQuery(value);
                setPage(1);
              }}
              onStatusChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              onSeverityChange={(value) => {
                setSeverity(value);
                setPage(1);
              }}
            />

              {/* One line, not a second table. These are runs while the table
                  below holds findings, so they cannot be merged into it — but a
                  full list of rows above the real table read as a competing one.
                  Collapsed by default; the runs are one click away. */}
            {attentionRuns.length > 0 || attentionCoverage.scanned < attentionCoverage.total ? (
              <details
                aria-labelledby="runs-needing-attention-heading"
                className="group border-b bg-state-caution-soft px-4 py-3 sm:px-5 dark:bg-state-caution-soft"
              >
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0">
                    <span id="runs-needing-attention-heading" className="block text-sm font-semibold text-state-caution">
                      Runs needing attention
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-state-caution/80 dark:text-state-caution/70">
                      {attentionCoverageNote(attentionCoverage) ??
                        "Open a run to review its failing cases."}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-state-caution/80 dark:text-state-caution/70">
                    {attentionCountLabel(attentionRuns.length, attentionCoverage)}
                    <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
                  </span>
                </summary>
                <div className="mt-3">
                {attentionRuns.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-state-caution/30 bg-background px-3 py-4 text-sm leading-6 text-muted-foreground dark:border-state-caution/30">
                    Nothing in the scanned runs needs attention. Older evaluations were
                    not read, so this is not a clean bill of health for the whole history.
                  </p>
                ) : (
                <ul className="space-y-2">
                  {attentionRuns.map((run) => {
                    const name =
                      run.experiment?.tags?.evaluation_name?.trim() ||
                      run.experiment?.name?.trim() ||
                      run.run_id;
                    return (
                      <li key={run.run_id} className="flex items-center gap-1 rounded-lg border border-state-caution/30/80 bg-background pr-2 dark:border-state-caution/30/60">
                        <Link
                          href={attentionRunHref(run.run_id)}
                          className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{name}</span>
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {runScenarioTypeLabel(run)} · {run.run_id}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <RunOutcomeBadge run={run} />
                            <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
                          </span>
                        </Link>
                        <CopyIdButton value={run.run_id} kind="run" />
                      </li>
                    );
                  })}
                </ul>
                )}
                </div>
              </details>
            ) : null}

            <div className="flex items-center justify-between gap-4 border-b bg-muted/15 px-4 py-3 sm:px-5">
              <div>
                <h2 className="text-sm font-semibold">
                  {status === "active" ? "Needs your decision" : status === "resolved" ? "Completed reviews" : "All findings"}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {status === "active" ? "Highest severity and newest findings appear first." : "Open a case to inspect its evidence and history."}
                </p>
              </div>
              <span
                aria-live="polite"
                className="shrink-0 text-xs tabular-nums text-muted-foreground"
              >
                {filtered.length} finding{filtered.length === 1 ? "" : "s"}
              </span>
            </div>

            {loading ? (
              <TableSkeleton label="Loading review evidence…" columns={5} rows={6} className="min-h-72" />
            ) : pageFindings.length === 0 ? (
              <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
                <CheckCircle2 className="size-8 text-state-positive" aria-hidden="true" />
                <h2 className="mt-3 text-sm font-semibold">Nothing needs review here</h2>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  Try another filter, or return when an evaluation flags a case for human review.
                </p>
              </div>
            ) : (
              <FindingList
                findings={pageFindings}
                onOpen={(id) => {
                  // Clear any error left from a previously opened finding so a
                  // freshly opened (or cached) case never inherits its state.
                  setDetailsError(null);
                  setSelectedId(id);
                }}
              />
            )}

            {!loading && filtered.length > 0 ? (
              <Pagination
                page={currentPage}
                pageCount={pageCount}
                total={filtered.length}
                onChange={setPage}
              />
            ) : null}
          </TabsPanel>
        ) : (
          <TabsPanel id="review-panel" aria-labelledby="review-tab-regressions">
            <RegressionLibrary
              regressions={regressions}
              loading={regressionsLoading}
              loadError={regressionsError}
              findings={findings}
              reviewer={fullName}
              onChanged={() => load(true)}
            />
          </TabsPanel>
        )}
        </div>
          </Tabs>
      </section> : null}

      {selected ? (
        <FindingDrawer
          // Remount per finding. The drawer's decision form is uncontrolled —
          // `defaultValue` applies on mount only — so Prev/Next swapped the
          // finding while React reused the instance, and the outcome radios,
          // severity select and rationale kept the previous finding's DOM
          // values. Submitting then posted this finding's id with the last
          // one's decision, writing a wrong attributed record into an
          // append-only governance log. Also clears stale error/invalidField.
          key={selected.finding_id}
          finding={selected}
          details={details[selected.finding_id] ?? { tasks: [], remediations: [], decisions: [] }}
          detailsLoaded={Boolean(details[selected.finding_id])}
          detailsLoading={detailsLoading}
          detailsError={detailsError}
          onRetryDetails={retryDetails}
          reviewer={fullName}
          identityResolved={identityResolved}
          queuePosition={selectedIndex >= 0 ? selectedIndex + 1 : null}
          queueTotal={filtered.length}
          onPrevious={selectedIndex > 0 ? () => stepQueue(-1) : null}
          onNext={selectedIndex >= 0 && selectedIndex < filtered.length - 1 ? () => stepQueue(1) : null}
          onClose={() => setSelectedId(null)}
          onChanged={refreshAndClose}
        />
      ) : null}
    </div>
  );
}

function ReviewToolbar({
  query,
  status,
  severity,
  onQueryChange,
  onStatusChange,
  onSeverityChange,
}: {
  query: string;
  status: StatusFilter;
  severity: string;
  onQueryChange: (value: string) => void;
  onStatusChange: (value: StatusFilter) => void;
  onSeverityChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2 border-b px-4 py-3 sm:px-5 md:grid-cols-[minmax(15rem,1fr)_12rem_11rem]">
      <SearchField
        containerClassName="block"
        name="review-query"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search case, metric, run, or rationale…"
        label="Search review findings"
      />
      <select
        value={status}
        onChange={(event) => onStatusChange(event.target.value as StatusFilter)}
        aria-label="Review status"
        className="h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
      >
        <option value="active">Needs review</option>
        <option value="resolved">Completed</option>
        <option value="all">All statuses</option>
      </select>
      <select
        value={severity}
        onChange={(event) => onSeverityChange(event.target.value)}
        aria-label="Finding severity"
        className="h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
      >
        <option value="">All priorities</option>
        <option value="critical">Critical</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>
    </div>
  );
}

function QueueCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "critical" | "attention" | "complete";
}) {
  return (
    <span className="inline-flex items-center gap-2 text-muted-foreground">
      <span
        className={cn(
          "size-2 rounded-full",
          tone === "critical" && "bg-destructive",
          tone === "attention" && "bg-state-caution",
          tone === "complete" && "bg-state-positive",
        )}
        aria-hidden="true"
      />
      {label}
      <strong className="font-semibold tabular-nums text-foreground">{value}</strong>
    </span>
  );
}

function FindingList({
  findings,
  onOpen,
}: {
  findings: Finding[];
  onOpen: (id: string) => void;
}) {
  return (
    <div>
      <div
        className="hidden grid-cols-[minmax(12rem,1.6fr)_minmax(8rem,1fr)_7rem_8rem_6rem_6rem_5rem] gap-4 border-b px-5 py-2.5 text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-muted-foreground lg:grid"
        aria-hidden="true"
      >
        <span>Case</span>
        <span>Flagged by</span>
        <span>Case ID</span>
        <span>Review date</span>
        <span>Priority</span>
        <span>Status</span>
        <span />
      </div>
      <div className="divide-y">
        {findings.map((finding) => {
          const title = findingTitle(finding);
          return (
            <div key={finding.finding_id} className="relative">
              <button
                type="button"
                onClick={() => onOpen(finding.finding_id)}
                className="group grid min-w-0 w-full gap-3 px-4 py-4 text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5 lg:grid-cols-[minmax(12rem,1.6fr)_minmax(8rem,1fr)_7rem_8rem_6rem_6rem_5rem] lg:items-center lg:gap-4"
                aria-label={"Review case: " + title}
              >
              <span className="min-w-0">
                <span className="line-clamp-2 text-sm font-medium leading-5">{title}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">{evidenceText(finding.evidence, "evaluation_name") || `Run ${shortIdentifier(finding.run_id)}`}</span>

              </span>

              <span className="min-w-0">
                <span className="block truncate text-sm">
                  {finding.metric_ids.slice(0, 2).map(humanizeMetric).join(", ")}
                </span>
                {finding.metric_ids.length > 2 ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    +{finding.metric_ids.length - 2} more metrics
                  </span>
                ) : (
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    Run {shortIdentifier(finding.run_id)}
                  </span>
                )}
              </span>

              <span className="text-xs text-muted-foreground">{shortIdentifier(finding.row_id)}</span>
              <span className="text-xs text-muted-foreground">{formatDateTime(finding.created_at)}</span>
              <span className="flex items-center justify-between gap-2 lg:block">
                <span className="text-xs text-muted-foreground lg:hidden">Priority</span>
                <SeverityBadge severity={finding.severity} />
              </span>

              <span className="flex items-center justify-between gap-2 lg:block">
                <span className="text-xs text-muted-foreground lg:hidden">Status</span>
                <StatusBadge status={finding.status} />
              </span>

              {/* Bare, like every other row-open hint. The bordered circle made this
                  one list announce the same affordance in a third way. */}
              <span className="hidden size-8 items-center justify-center text-muted-foreground transition-colors group-hover:text-foreground lg:flex">
                <ChevronRight className="size-4" aria-hidden="true" />
              </span>
              </button>
              <CopyIdButton value={finding.run_id} kind="run" className="absolute right-3 top-1/2 -translate-y-1/2" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FindingDrawer({
  finding,
  details,
  detailsLoaded,
  detailsLoading,
  detailsError,
  onRetryDetails,
  reviewer,
  identityResolved,
  queuePosition,
  queueTotal,
  onPrevious,
  onNext,
  onClose,
  onChanged,
}: {
  finding: Finding;
  details: FindingDetails;
  detailsLoaded: boolean;
  detailsLoading: boolean;
  detailsError: string | null;
  onRetryDetails: () => void;
  reviewer: string;
  identityResolved: boolean;
  queuePosition: number | null;
  queueTotal: number;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const outcomeRef = useRef<HTMLInputElement>(null);
  const rationaleRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<"outcome" | "rationale" | null>(null);
  // F6 activity timeline: fetched per finding; `null` means still loading.
  const [activity, setActivity] = useState<ActivityEvent[] | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [postingComment, setPostingComment] = useState(false);
  const [revising, setRevising] = useState(false);
  const [followUp, setFollowUp] = useState<{title: string; description: string; run: () => Promise<void>} | null>(null);
  const [caseEvidence, setCaseEvidence] = useState<RunItemDetail | null>(null);
  const [caseEvidenceError, setCaseEvidenceError] = useState<string | null>(null);
  const activeTask = details.tasks.find((task) => task.status === "open" || task.status === "in_review") ?? (revising ? details.tasks[0] : undefined);
  const drawerState = reviewDrawerState({
    detailsLoading,
    detailsLoaded,
    detailsError,
    hasActiveTask: Boolean(activeTask),
  });
  const evidence = finding.evidence ?? {};
  const query = evidenceText(evidence, "query") || "Input was not captured for this finding.";
  const response = evidenceText(evidence, "response") || "Output was not captured for this finding.";
  const rationale = evidenceText(evidence, "rationale") || "No automated rationale was recorded.";
  const failingDetails = failingMetricDetails(evidence);

  const identityError = reviewIdentityError(identityResolved);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setCaseEvidence(null);
      setCaseEvidenceError(null);
      api.tenant().then(({tenant_id}) => evaluationApi.getRunItem(finding.run_id, finding.row_id, tenant_id))
        .then((item) => { if (active) setCaseEvidence(item); })
        .catch((reason) => { if (active) setCaseEvidenceError(userFacingError(reason, "Reference evidence unavailable")); });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [finding.run_id, finding.row_id]);


  useEffect(() => {
    let active = true;
    // Deferred like the details effect above so state resets don't run
    // synchronously inside the effect body (react-hooks/set-state-in-effect).
    const timer = window.setTimeout(() => {
      setActivity(null);
      setActivityError(null);
      setCommentBody("");
      setCommentError(null);
      reviewCollabApi
        .listActivity(finding.finding_id)
        .then((events) => {
          if (active) setActivity(events);
        })
        .catch((reason) => {
          if (active) setActivityError(userFacingError(reason, "Unable to load activity for this finding"));
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [finding.finding_id]);

  async function postComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Comments are attributed collaboration records — never post one for the
    // placeholder identity (same gate as governance decisions).
    if (identityError) {
      setCommentError(identityError);
      return;
    }
    const validationError = commentValidationError(commentBody);
    if (validationError) {
      setCommentError(validationError);
      return;
    }
    setPostingComment(true);
    setCommentError(null);
    try {
      const saved = await reviewCollabApi.postComment(finding.finding_id, {
        author: reviewer,
        body: commentBody,
      });
      // Append only once the server confirmed the comment — never speculate.
      setActivity((current) => [...(current ?? []), commentToActivityEvent(saved)]);
      setCommentBody("");
    } catch (reason) {
      setCommentError(userFacingError(reason, "Unable to post the comment"));
    } finally {
      setPostingComment(false);
    }
  }

  async function recordDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeTask) return;
    // Never attribute a governance decision to the placeholder identity.
    if (identityError) {
      setError(identityError);
      return;
    }
    const form = new FormData(event.currentTarget);
    const outcome = form.get("outcome") ? String(form.get("outcome")) : null;
    const rationale = String(form.get("rationale") || "");
    const validationError = reviewDecisionError(outcome, rationale);
    if (validationError) {
      const field = !outcome ? "outcome" : "rationale";
      setInvalidField(field);
      setError(validationError);
      if (field === "outcome") outcomeRef.current?.focus();
      else rationaleRef.current?.focus();
      return;
    }
    setInvalidField(null);
    setBusy("decision");
    setError(null);
    try {
      await platformApi.recordReviewDecision({
        finding_id: finding.finding_id,
        task_id: activeTask.task_id,
        reviewer,
        outcome: outcome as "agree" | "disagree" | "abstain",
        rationale,
        severity: String(form.get("severity")) as Finding["severity"],
      });
      await onChanged();
      setRevising(false);
    } catch (reason) {
      setError(userFacingError(reason, "Unable to record the review"));
    } finally {
      setBusy(null);
    }
  }

  async function assignRemediation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy("remediation");
    setError(null);
    try {
      await platformApi.createRemediation(finding.finding_id, {
        finding_id: finding.finding_id,
        owner: String(form.get("owner")),
        description: String(form.get("description")),
        due_at: String(form.get("due_at")) || undefined,
      });
      await onChanged();
    } catch (reason) {
      setError(userFacingError(reason, "Unable to create remediation"));
    } finally {
      setBusy(null);
    }
  }

  async function promote() {
    setBusy("promote");
    setError(null);
    try {
      await platformApi.promoteRegression(finding.finding_id);
      await onChanged();
      setFollowUp(null);
    } catch (reason) {
      setError(userFacingError(reason, "Unable to promote this finding"));
    } finally {
      setBusy(null);
    }
  }

  async function updateRemediation(item: Remediation, status: Remediation["status"]) {
    setBusy(item.remediation_id);
    setError(null);
    try {
      await platformApi.updateRemediation(item.remediation_id, status);
      await onChanged();
      setFollowUp(null);
    } catch (reason) {
      setError(userFacingError(reason, "Unable to update remediation"));
    } finally {
      setBusy(null);
    }
  }

  // 820px stretched a one-line input and a one-line model output across the full
  // width and left the rest of the sheet empty. This is a reading surface with one
  // short form on it, so it takes a reading width.
  return (
    <>
    <Dialog
      variant="drawer"
      as="aside"
      labelledBy="review-drawer-title"
      scrimLabel="Close review"
      onClose={onClose}
      initialFocusRef={titleRef}
      width="sm:w-[92vw] lg:w-[58vw] xl:w-[660px]"
    >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Review finding
            </p>
            <h2
              ref={titleRef}
              id="review-drawer-title"
              tabIndex={-1}
              className="mt-1 line-clamp-2 text-lg font-semibold leading-6 outline-none"
            >
              {findingFailureSummary(finding)}
            </h2>
            {/* The case question is context for the finding, not the finding. It
                keeps its place here and is not repeated as a boxed field below. */}
            <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground" title={query}>
              {query}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              <span>Case</span>
              <span className="font-mono" translate="no">{shortIdentifier(finding.row_id)}</span>
              <CopyButton value={finding.row_id} subject="case id" className="h-6 px-1.5" />
              <span aria-hidden="true">·</span>
              <span>Run</span>
              <span className="font-mono" translate="no">{shortIdentifier(finding.run_id)}</span>
              <CopyButton value={finding.run_id} subject="run id" className="h-6 px-1.5" />
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {queuePosition ? (
              <>
                <button
                  type="button"
                  aria-label="Previous finding"
                  onClick={() => onPrevious?.()}
                  disabled={!onPrevious}
                  className="flex size-9 items-center justify-center rounded-lg border outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </button>
                <span className="px-1 text-xs tabular-nums text-muted-foreground" aria-live="polite">
                  {queuePosition} of {queueTotal}
                </span>
                <button
                  type="button"
                  aria-label="Next finding"
                  onClick={() => onNext?.()}
                  disabled={!onNext}
                  className="flex size-9 items-center justify-center rounded-lg border outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </button>
              </>
            ) : null}
            <button
              type="button"
              aria-label="Close review"
              onClick={onClose}
              className="ml-1 flex size-9 items-center justify-center rounded-lg border outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {/* The verdict, once. Gate, severity and status were previously stated in
              four places and never together — a badge here, the severity only inside
              the Priority select, and "gate fail" buried in an activity log line. */}
          <div className="border-b bg-muted/15 px-4 py-3 sm:px-6">
            <div className="flex flex-wrap items-center gap-2">
              <GateBadge gate={finding.gate_result} size="sm" />
              <SeverityBadge severity={finding.severity} />
              <StatusBadge status={finding.status} />
              <span className="text-xs text-muted-foreground">
                {finding.metric_ids.length} metric{finding.metric_ids.length === 1 ? "" : "s"}{" "}
                {finding.gate_result === "pass" ? "under review" : "failed"}
              </span>
              <Link
                href={runEvidenceHref(finding)}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-auto")}
              >
                Open run evidence
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            </div>
          </div>

          {error ? (
            <div role="alert" className="mx-4 mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800 sm:mx-6">
              {error}
            </div>
          ) : null}

          {/* Failure first. This led with a raw captured value — "ops.input_token_count:
              889 tokens", a number with no threshold beside it — while the part a
              reviewer needs, which metrics failed, sat under it as small grey text.
              The model output is the answer being judged, so it stays; the input is
              already in the header and is not repeated as a boxed field. */}
          <section className="px-4 py-5 sm:px-6" aria-labelledby="review-evidence-title">
            <h3 id="review-evidence-title" className="text-sm font-semibold">
              {finding.gate_result === "pass" ? "What was scored" : "What failed"}
            </h3>
            {/* Score against threshold, where the run recorded it. "Groundedness
                failed" does not say whether it missed by a hair or by everything,
                and that is the difference a reviewer is being asked to judge.
                Findings written before the run captured this show the name alone. */}
            <ul className="mt-3 divide-y rounded-lg border">
              {finding.metric_ids.map((metricId) => {
                const detail = failingDetails.find((entry) => entry.metric_id === metricId);
                return (
                  <li key={metricId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2 text-xs">
                    <span className="font-medium text-destructive">{humanizeMetric(metricId)}</span>
                    {detail?.normalised_score != null ? (
                      <span className="tabular-nums text-foreground">
                        scored {formatScore(detail.normalised_score)}
                        {detail.threshold != null ? ` · needed ${formatScore(detail.threshold)}` : ""}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">score not recorded</span>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* One rationale is stored for the whole finding — the backend saves
                `failing[0].rationale` — so it is named as the first one rather than
                implying it explains every metric listed. */}
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              First recorded reason: {rationale}
            </p>

            <div className="mt-5 space-y-4">
              {/* The question the answer is being judged against. It was clipped
                  to two lines in the header with no expansion while the answer
                  below it scrolled freely — so on any RAG or multi-turn input the
                  reviewer decided on partial context. Same treatment as the
                  output, because the pair is the evidence. */}
              <EvidenceBlock label="Case input" value={query} constrained />
              <EvidenceBlock label="Model output" value={response} constrained />
              {caseEvidenceError ? <p role="alert" className="text-sm text-destructive">{caseEvidenceError}</p> : caseEvidence ? <EvidenceBlock label="Reference answer" value={pickText(caseEvidence.expected, ["expected_response", "expected_answer", "expected_output", "ground_truth", "reference", "answer", "response"]) || "No reference answer was captured."} constrained /> : <p role="status" className="text-xs text-muted-foreground">Loading reference evidence…</p>}
              <p className="text-xs text-muted-foreground">Recorded checks: {finding.metric_ids.map(humanizeMetric).join(", ")}. Thresholds and the recorded rationale are shown above; a separate rubric was not captured in this finding.</p>
            </div>
          </section>

          {!detailsLoading && details.decisionsError ? (
            <section className="border-t px-4 py-5 sm:px-6" aria-labelledby="review-history-title">
              <SectionHeading tone="alert" title="Decision history" description="The decision audit trail could not be loaded." id="review-history-title" />
              <div
                role="alert"
                className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{details.decisionsError}</span>
              </div>
            </section>
          ) : null}

          {!detailsLoading && !details.decisionsError && details.decisions.length > 0 ? (
            <section className="border-t px-4 py-5 sm:px-6" aria-labelledby="review-history-title">
              <SectionHeading title="Decision history" description="Newest first; the current decision supersedes earlier ones." id="review-history-title" />
              <ol className="mt-4 space-y-2">
                {[...details.decisions].reverse().map((entry) => (
                  <li
                    key={entry.decision_id}
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-xs",
                      entry.is_current ? "border-brand-text/40 bg-brand/5" : "opacity-80",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{decisionOutcomeLabel(entry.outcome, finding.gate_result)}</span>
                      <span className="text-muted-foreground">by {entry.actor}</span>
                      {entry.is_current ? (
                        <span className="rounded-full border border-brand-text/40 px-1.5 py-0.5 text-[10px] font-semibold text-brand-text dark:text-brand">
                          Current
                        </span>
                      ) : (
                        <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                          Superseded
                        </span>
                      )}
                      <span className="ml-auto text-muted-foreground">{formatDateTime(entry.timestamp)}</span>
                    </div>
                    {entry.rationale ? (
                      <p className="mt-1.5 leading-5 text-muted-foreground">{entry.rationale}</p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {drawerState === "loading" ? (
            <div role="status" aria-live="polite" className="flex min-h-40 items-center justify-center gap-2 border-t text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading review tasks and remediations…
            </div>
          ) : drawerState === "details-error" ? (
            // Truthfulness: the review task/remediation load failed, so we cannot
            // know whether a decision is still owed. Never imply the review is
            // complete — surface the failure and offer a retry instead.
            <section className="border-t px-4 py-5 sm:px-6" aria-labelledby="review-details-error-title">
              <SectionHeading tone="alert" title="Couldn't load review details" description="The review tasks and remediations for this finding didn't load, so its status can't be confirmed." id="review-details-error-title" />
              <div
                role="alert"
                className="mt-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/20 dark:text-red-200"
              >
                <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                <span>{detailsError}</span>
              </div>
              <div className="mt-4 flex justify-end">
                <Button type="button" variant="outline" onClick={onRetryDetails}>
                  <RefreshCw className="size-4" aria-hidden="true" />
                  Retry review details
                </Button>
              </div>
            </section>
          ) : drawerState === "decision" ? (
            <form className="border-t px-4 py-5 sm:px-6" onSubmit={recordDecision}>
              <SectionHeading title="Record your decision" />
              <fieldset
                className="mt-4"
                aria-invalid={invalidField === "outcome" || undefined}
                onChange={() => setInvalidField((current) => (current === "outcome" ? null : current))}
              >
                <legend className="sr-only">Review decision</legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {decisionOutcomes(finding.gate_result).map((option, index) => (
                    <label
                      key={option.value}
                      className="flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm has-[:checked]:border-brand-text has-[:checked]:bg-brand/10 dark:has-[:checked]:border-brand dark:has-[:checked]:bg-brand/10"
                    >
                      <input
                        ref={index === 0 ? outcomeRef : undefined}
                        type="radio"
                        name="outcome"
                        value={option.value}
                        aria-label={option.label}
                        className="accent-brand"
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="mt-5 flex flex-col gap-5">
                <div>
                  {/* This is the reviewer's output, not a readout: it posts with the
                      decision. Pre-filled from the automated severity, which made it
                      ambiguous whether it was stating the system's verdict or asking
                      for one — so it says which, and the badge above states the
                      current value. */}
                  <Label htmlFor={"severity-" + finding.finding_id}>Set priority</Label>
                  <select
                    id={"severity-" + finding.finding_id}
                    name="severity"
                    defaultValue={finding.severity}
                    className="select-chevron mt-1 block h-10 w-full max-w-48 rounded-lg border bg-background px-3 pr-9 text-sm"
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Starts at the automated severity; change it if your review disagrees.
                  </p>
                </div>
                <div>
                  <Label htmlFor={"rationale-" + finding.finding_id}>Reviewer note <span className="text-xs font-normal text-muted-foreground">(required)</span></Label>
                  <textarea
                    ref={rationaleRef}
                    id={"rationale-" + finding.finding_id}
                    name="rationale"
                    required
                    rows={3}
                    aria-invalid={invalidField === "rationale" || undefined}
                    onChange={() => setInvalidField((current) => (current === "rationale" ? null : current))}
                    placeholder="What does the evidence confirm…"
                    className="mt-1 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 aria-[invalid]:border-red-400 aria-[invalid]:focus:border-red-400"
                  />
                </div>
              </div>
              <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t pt-4">
                {identityError ? (
                  <p role="alert" className="mr-auto inline-flex items-center gap-1.5 text-xs text-destructive">
                    <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />
                    {identityError}
                  </p>
                ) : null}
                <Button type="submit" disabled={busy !== null || Boolean(identityError)}>
                  {busy === "decision" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <ClipboardCheck className="size-4" aria-hidden="true" />}
                  Save decision
                </Button>
              </div>
            </form>
          ) : (
            <section className="border-t px-4 py-5 sm:px-6" aria-labelledby="review-follow-up-title">
              <SectionHeading title="Review completed" id="review-follow-up-title" />
              {details.tasks.length > 0 && !["promoted", "waived"].includes(finding.status) ? <Button type="button" variant="outline" className="mt-3" onClick={() => setRevising(true)}>Revise decision</Button> : <p className="mt-2 text-xs text-muted-foreground">This review cannot be revised from its current state.</p>}
              <p className="mt-2 text-xs text-muted-foreground">Earlier decisions remain in the history when a new decision is recorded.</p>
              <div className="mt-4 flex items-start gap-3 rounded-xl border bg-state-positive-soft p-4 dark:bg-state-positive-soft">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-state-positive" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium">Human decision recorded</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Remediation and regression actions now preserve the confirmed review trail.
                  </p>
                </div>
              </div>

              <div className="mt-6 border-t pt-5">
                <SectionHeading title="Follow-up" />
                {details.remediations.length ? (
                  <ul className="mt-4 divide-y rounded-xl border">
                    {details.remediations.map((item) => (
                      <li key={item.remediation_id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{item.description}</span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {item.owner}{item.due_at ? " · Due " + formatDate(item.due_at) : ""}
                          </span>
                        </span>
                        <label className="shrink-0">
                          <span className="sr-only">Remediation status</span>
                          <select
                            value={item.status}
                            disabled={busy !== null}
                            onChange={(event) => {
                              const next = event.target.value as Remediation["status"];
                              setFollowUp({title: `Change remediation to ${next.replaceAll("_", " ")}?`, description: next === "cancelled" ? "This marks the follow-up as abandoned. You can change its status again later." : "This status change will be recorded in the activity history.", run: () => updateRemediation(item, next)});
                            }}
                            className="h-8 rounded-lg border bg-background px-2 text-xs font-medium"
                          >
                            <option value="open">Open</option>
                            <option value="in_progress">In progress</option>
                            <option value="completed">Completed</option>
                            <option value="cancelled">Cancelled</option>
                          </select>
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <details className="group mt-4 rounded-xl border">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
                    <span className="inline-flex items-center gap-2">
                      <Wrench className="size-4 text-muted-foreground" aria-hidden="true" />
                      Add remediation
                    </span>
                    <span className="text-xs font-normal text-muted-foreground group-open:hidden">Optional</span>
                  </summary>
                  <form className="grid gap-3 border-t p-4 sm:grid-cols-2" onSubmit={assignRemediation}>
                    <div>
                      <Label htmlFor={"owner-" + finding.finding_id}>Owner</Label>
                      <Input id={"owner-" + finding.finding_id} name="owner" required placeholder="Team or person" className="mt-1" />
                    </div>
                    <div>
                      <Label htmlFor={"due-" + finding.finding_id}>Due date <span className="font-normal text-muted-foreground">(optional)</span></Label>
                      <Input id={"due-" + finding.finding_id} name="due_at" type="datetime-local" className="mt-1" />
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor={"action-" + finding.finding_id}>Action</Label>
                      <textarea
                        id={"action-" + finding.finding_id}
                        name="description"
                        required
                        rows={2}
                        placeholder="Describe the change and how it will be verified…"
                        className="mt-1 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm"
                      />
                    </div>
                    <div className="sm:col-span-2 flex justify-end">
                      <Button type="submit" variant="outline" disabled={busy !== null}>
                        {busy === "remediation" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                        Assign remediation
                      </Button>
                    </div>
                  </form>
                </details>

                {finding.status === "resolved" ? (
                  <div className="mt-4 flex justify-end">
                    <Button type="button" onClick={() => setFollowUp({title: "Add to regression library?", description: "Preserve this finding as a regression case. The recorded human decision and history remain available.", run: promote})} disabled={busy !== null}>
                      {busy === "promote" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <ShieldAlert className="size-4" aria-hidden="true" />}
                      Add to regression library
                    </Button>
                  </div>
                ) : null}
              </div>
            </section>
          )}

          <details className="group border-t px-4 py-5 sm:px-6">
            <summary id="review-activity-title" className="cursor-pointer text-sm font-semibold text-brand-text">Activity and discussion</summary>
            <p className="mt-2 text-xs text-muted-foreground">Decisions and comments are preserved in the history.</p>

            {activityError ? (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{activityError}</span>
              </div>
            ) : activity === null ? (
              <div role="status" aria-live="polite" className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Loading activity…
              </div>
            ) : activity.length === 0 ? (
              <p className="mt-4 text-xs text-muted-foreground">No activity has been recorded for this finding yet.</p>
            ) : (
              <ol className="mt-4 space-y-2">
                {activity.map((entry) => (
                  <li
                    key={entry.kind + "-" + entry.reference_id + "-" + entry.timestamp}
                    className="flex items-start gap-3 rounded-lg border px-3 py-2.5 text-xs"
                  >
                    <ActivityGlyph kind={entry.kind} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{entry.actor}</span>
                        <span className="ml-auto text-muted-foreground" title={formatDateTime(entry.timestamp)}>
                          {relativeTimeLabel(entry.timestamp)}
                        </span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words leading-5 text-muted-foreground">
                        {entry.summary}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}

            <form className="mt-4" onSubmit={postComment}>
              <Label htmlFor={"comment-" + finding.finding_id}>Add a comment</Label>
              <textarea
                id={"comment-" + finding.finding_id}
                name="comment"
                value={commentBody}
                rows={2}
                disabled={Boolean(identityError)}
                onChange={(event) => {
                  setCommentBody(event.target.value);
                  setCommentError(null);
                }}
                placeholder="Share context for other reviewers — @mention teammates to record them on the finding…"
                aria-invalid={commentError ? true : undefined}
                aria-describedby={commentError ? `comment-error-${finding.finding_id}` : undefined}
                className="mt-1 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-60 aria-[invalid]:border-red-400 aria-[invalid]:focus:border-red-400"
              />
              {commentError ? (
                <p id={`comment-error-${finding.finding_id}`} role="alert" className="mt-1.5 text-xs text-destructive">
                  {commentError}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center justify-end gap-3">
                {identityError ? (
                  <p role="alert" className="mr-auto inline-flex items-center gap-1.5 text-xs text-destructive">
                    <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />
                    {identityError}
                  </p>
                ) : (
                  <p className="mr-auto text-[11px] text-muted-foreground">
                    Mentions are recorded with the comment; no notifications are sent.
                  </p>
                )}
                <Button type="submit" variant="outline" size="sm" disabled={postingComment || Boolean(identityError)}>
                  {postingComment ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <MessageSquare className="size-4" aria-hidden="true" />
                  )}
                  Post comment
                </Button>
                <span className="sr-only" role="status" aria-live="polite">
                  {postingComment ? "Posting comment" : ""}
                </span>
              </div>
            </form>
          </details>
        </div>
    </Dialog>
    {followUp ? <OverlayConfirmDialog tone="default" title={followUp.title} description={<div><p>{followUp.description}</p>{error ? <p role="alert" className="mt-2 text-destructive">{error}</p> : null}</div>} confirmLabel="Confirm" pending={busy !== null} onCancel={() => setFollowUp(null)} onConfirm={() => void followUp.run()} /> : null}
    </>
  );
}

/** Icon per activity kind so the timeline scans by event type at a glance. */
function ActivityGlyph({ kind }: { kind: ActivityKind }) {
  const Icon =
    kind === "review_decision"
      ? ClipboardCheck
      : kind === "remediation_created"
        ? Wrench
        : kind === "remediation_status_changed"
          ? RefreshCw
          : kind === "waiver_granted"
            ? ShieldAlert
            : kind === "comment"
              ? MessageSquare
              : AlertTriangle;
  return (
    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
      <Icon className="size-3.5" aria-hidden="true" />
    </span>
  );
}

/**
 * A section of the finding sheet.
 *
 * These carried a numbered circle — 1, 2, 3 — which read as a wizard the reviewer
 * had to walk in order. It never was one: the same badge was also handed "•" for
 * Activity and "!" for load failures, and the numbering shifted depending on
 * whether the finding was already decided, so "2" meant two different sections on
 * two different findings. A reviewer reads the evidence and records one decision;
 * the sections are places, not steps. Alert marks the one case that is genuinely
 * an exception rather than a stage.
 */
function SectionHeading({
  title,
  description,
  id,
  tone = "default",
}: {
  title: string;
  /** Only where it tells the reviewer something the heading does not. */
  description?: string;
  id?: string;
  tone?: "default" | "alert";
}) {
  return (
    <div className="flex items-start gap-2">
      {tone === "alert" ? (
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      ) : null}
      <div className="min-w-0">
        <h3 id={id} className={cn("text-sm font-semibold", tone === "alert" && "text-destructive")}>
          {title}
        </h3>
        {description ? (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

function EvidenceBlock({
  label,
  value,
  constrained = false,
}: {
  label: string;
  value: string;
  constrained?: boolean;
}) {
  return (
    <div className="rounded-xl border bg-background p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className={cn("mt-2 whitespace-pre-wrap break-words text-sm leading-6", constrained && "max-h-52 overflow-y-auto pr-2")}>
        {value}
      </p>
    </div>
  );
}

function RegressionLibrary({
  regressions,
  loading,
  loadError,
  findings,
  reviewer,
  onChanged,
}: {
  regressions: RegressionCase[];
  loading: boolean;
  loadError: string | null;
  findings: Finding[];
  reviewer: string;
  onChanged: () => Promise<void>;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function replay(item: RegressionCase) {
    const finding = findings.find((candidate) => candidate.finding_id === item.finding_id);
    if (!finding) return;
    setBusyId(item.regression_case_id);
    setError(null);
    try {
      const result = await platformApi.replayRegression(item.regression_case_id, {
        experiment_id: finding.experiment_id,
        created_by: reviewer,
        dry_run: true,
      });
      // Route to the replay run so the reviewer lands on its evidence instead of
      // the run id being silently discarded.
      if (result?.run_id) {
        router.push(`/runs/${encodeURIComponent(result.run_id)}`);
        return;
      }
      await onChanged();
    } catch (reason) {
      setError(userFacingError(reason, "Unable to replay this regression"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="border-b bg-muted/15 px-5 py-3">
        <h2 className="text-sm font-semibold">Regression library</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Verified cases preserved for repeatable checks.
        </p>
      </div>
      {error ? (
        <div role="alert" className="m-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
          {error}
        </div>
      ) : null}
      {loading ? (
        <TableSkeleton label="Loading regression cases…" columns={2} rows={5} showHeader={false} className="min-h-80" />
      ) : loadError ? (
        <ErrorState title="Regression library unavailable" message={loadError} className="min-h-80 border-0" />
      ) : regressions.length === 0 ? (
        <div className="flex min-h-80 flex-col items-center justify-center px-6 text-center">
          <FlaskConical className="size-8 text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-3 text-sm font-semibold">No regression cases yet</h2>
          <p className="mt-1 max-w-lg text-sm leading-6 text-muted-foreground">
            Confirm a finding, track its fix, then preserve the case when it belongs in the permanent test suite.
          </p>
        </div>
      ) : (
        <div className="divide-y">
          {regressions.map((item) => {
            const finding = findings.find((candidate) => candidate.finding_id === item.finding_id);
            return (
              <article key={item.regression_case_id} className="grid gap-4 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-sm font-semibold">
                      {finding ? findingTitle(finding) : "Regression case " + shortIdentifier(item.regression_case_id)}
                    </h2>
                    <span className="rounded-full border px-2 py-0.5 text-[10px] font-semibold">
                      {humanize(item.kind)}
                    </span>
                  </div>
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    Run {shortIdentifier(item.source_run_id)} <CopyIdButton value={item.source_run_id} kind="run" />
                    · Promoted {formatDate(item.created_at)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={"/runs/" + encodeURIComponent(item.source_run_id)}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Source evidence
                  </Link>
                  <Button type="button" size="sm" onClick={() => void replay(item)} disabled={!finding || busyId !== null}>
                    {busyId === item.regression_case_id ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}
                    Replay safely
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function filterFindings(
  findings: Finding[],
  filters: { status: StatusFilter; query: string; severity: string },
): Finding[] {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase();
  return findings.filter((finding) => {
    if (filters.status === "active" && !["open", "in_review"].includes(finding.status)) return false;
    if (filters.status === "resolved" && !["resolved", "waived", "promoted"].includes(finding.status)) return false;
    if (filters.severity && finding.severity !== filters.severity) return false;
    if (!normalizedQuery) return true;
    const text = [
      finding.row_id,
      finding.run_id,
      finding.experiment_id,
      finding.root_cause_category,
      ...finding.metric_ids,
      evidenceText(finding.evidence, "evaluation_name"),
      evidenceText(finding.evidence, "query"),
      evidenceText(finding.evidence, "response"),
      evidenceText(finding.evidence, "rationale"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return text.includes(normalizedQuery);
  });
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((left, right) => {
    const severityDifference = SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity];
    if (severityDifference !== 0) return severityDifference;
    return timestamp(right.created_at) - timestamp(left.created_at);
  });
}

const FAMILY_LABELS: Record<string, string> = {
  ops: "tokens & latency",
  llm: "response quality",
  rag: "retrieval",
  agent: "agent behaviour",
  safety: "safety",
  quality: "quality contract",
};

/**
 * How a finding is named in the queue: by the case it came from.
 *
 * The list pairs this with a "Flagged by" column carrying the metrics, so the
 * question is what distinguishes one row from another there. The drawer is a
 * different problem — see findingFailureSummary.
 */
export function findingTitle(finding: Finding): string {
  return evidenceText(finding.evidence, "query") || "Case " + shortIdentifier(finding.row_id);
}

/**
 * What the finding is, for the sheet that exists to explain it.
 *
 * The drawer used the question as its heading and then repeated it verbatim in an
 * Input box below, so the largest line on the sheet told the reviewer nothing and
 * said it twice. Here the heading names the failure and the question moves to a
 * secondary line — the queue keeps the opposite emphasis, and both are right for
 * what they are.
 *
 * Families rather than six metric names: "tokens & latency" is the level a
 * reviewer triages at, and the names are listed in full underneath.
 */
export function findingFailureSummary(finding: Finding): string {
  const metricIds = finding.metric_ids ?? [];
  if (metricIds.length === 0) return "Finding with no recorded metrics";
  // A case can reach review because it failed, or because someone sent a
  // PASSING one to be checked. Saying "failed" beside a Pass badge on the same
  // line is the review sheet contradicting itself at the moment a reviewer is
  // deciding whether to trust it.
  const failed = finding.gate_result !== "pass";
  if (metricIds.length === 1) {
    return failed
      ? `${humanizeMetric(metricIds[0])} failed`
      : `${humanizeMetric(metricIds[0])} passed · sent for review`;
  }
  const families = [...new Set(metricIds.map((id) => (id.includes(".") ? id.split(".")[0] : "metric")))];
  const familyLabel = families.map((family) => FAMILY_LABELS[family] ?? humanize(family)).join(" & ");
  return failed
    ? `${metricIds.length} metrics failed · ${familyLabel}`
    : `${metricIds.length} metrics passed · sent for review · ${familyLabel}`;
}

function SeverityBadge({ severity }: { severity: Finding["severity"] }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold",
        severity === "critical" && "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300",
        severity === "high" && "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950/30 dark:text-orange-300",
        severity === "medium" && "border-state-caution/30 bg-state-caution-soft text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution",
        severity === "low" && "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300",
      )}
    >
      {humanize(severity)}
    </span>
  );
}

function StatusBadge({ status }: { status: Finding["status"] }) {
  return (
    <span className="inline-flex rounded-full border bg-background px-2 py-1 text-[10px] font-semibold text-muted-foreground">
      {humanize(status)}
    </span>
  );
}

function Pagination({
  page,
  pageCount,
  total,
  onChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const start = (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground sm:px-5">
      <span>Showing {start}–{end} of {total}</span>
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">Page {page} of {pageCount}</span>
        <Button type="button" variant="outline" size="icon-sm" onClick={() => onChange(page - 1)} disabled={page === 1} aria-label="Previous findings">
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>
        <Button type="button" variant="outline" size="icon-sm" onClick={() => onChange(page + 1)} disabled={page === pageCount} aria-label="Next findings">
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function evidenceText(evidence: Record<string, unknown>, key: string): string {
  const value = evidence[key];
  return typeof value === "string" ? value.trim() : "";
}

export interface FailingMetricDetail {
  metric_id: string;
  score: number | null;
  normalised_score: number | null;
  threshold: number | null;
  threshold_result: "pass" | "warn" | "fail" | null;
}

/**
 * Per-metric scores from the finding's evidence blob.
 *
 * Tolerant on purpose: findings written before the run recorded this carry no
 * such key, and the sheet falls back to naming the metric alone rather than
 * showing an invented score.
 */
export function failingMetricDetails(evidence: Record<string, unknown>): FailingMetricDetail[] {
  const raw = evidence.failing_metric_details;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is FailingMetricDetail =>
      typeof entry === "object" && entry !== null && typeof (entry as FailingMetricDetail).metric_id === "string",
  );
}

/** Scores are 0-1; a reviewer reads percentages. */
function formatScore(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function shortIdentifier(value: string): string {
  return value.length > 12 ? value.slice(0, 8) : value;
}

function humanize(value: string): string {
  return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function humanizeMetric(value: string): string {
  return humanize(value.split(".").at(-1) || value);
}


function timestamp(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
