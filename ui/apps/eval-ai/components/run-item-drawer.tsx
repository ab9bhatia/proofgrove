"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@evalai/shared/utils";
import {
  api,
  evaluationApi,
  platformApi,
  type CaseReplay,
  type DatasetInfo,
  type EvaluationScope,
  type KpiResult,
  type PromoteRunItemResult,
  type PromptVersion,
  type RunConfigurationSnapshot,
  type RunItemDetail,
} from "@/lib/api";
import { validTraceId } from "@/lib/trace-identity";
import { userFacingError } from "@/lib/api-errors";
import { replayDisabledReason } from "@/lib/prompt-replay";
import { promptRef as promptVersionRef } from "@/lib/prompts";
import {
  PromoteRunItemPanel,
  type ExpectedSource,
  type PromoteTargetMode,
} from "./promote-run-item";
import { ReplayRunItemPanel } from "./replay-run-item";
import { RunItemCaseReview, RunItemInspector } from "./run-item-inspector";

function caseTitle(item: RunItemDetail | null, fallback: string): string {
  const input = item?.input;
  if (!input) return fallback;
  for (const key of ["query", "question", "prompt", "input"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

export function lockRunItemPageScroll(style: { overflow: string }): () => void {
  const previousOverflow = style.overflow;
  style.overflow = "hidden";
  return () => {
    style.overflow = previousOverflow;
  };
}

type RunItemDrawerProps = {
  exampleId: string;
  item: RunItemDetail | null;
  loading: boolean;
  error: string | null;
  position: number;
  total: number;
  kpis: KpiResult[];
  projectId?: string | null;
  evaluationScope?: EvaluationScope | null;
  onClose: () => void;
  onRetry?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  variant?: "drawer" | "dialog";
};

export function RunItemDrawer(props: RunItemDrawerProps) {
  const itemKey = `${props.item?.run_id ?? "loading"}:${props.item?.example_id ?? props.exampleId}`;
  return <RunItemDrawerContent key={itemKey} {...props} />;
}

function RunItemDrawerContent({
  exampleId,
  item,
  loading,
  error,
  position,
  total,
  kpis,
  projectId,
  evaluationScope,
  onClose,
  onRetry,
  onPrevious,
  onNext,
  variant = "drawer",
}: RunItemDrawerProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const recordedTraceId = validTraceId(item?.execution.trace_id);

  useEffect(() => {
    const pageScroller = document.getElementById("main-content");
    if (pageScroller) return lockRunItemPageScroll(pageScroller.style);
  }, []);

  // Promote-to-dataset state lives on the drawer so both variants get it. The
  // panel replaces the drawer body rather than opening a second Dialog — two
  // portalled dialogs fight over Escape and the focus trap.
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(false);
  const [datasetsCursor, setDatasetsCursor] = useState<string | null>(null);
  const [targetMode, setTargetMode] = useState<PromoteTargetMode>("existing");
  const [selectedDatasetName, setSelectedDatasetName] = useState<string | null>(null);
  const [newDatasetName, setNewDatasetName] = useState("");
  const [expectedSource, setExpectedSource] = useState<ExpectedSource>("output");
  const [expectedText, setExpectedText] = useState("");
  const [createVersion, setCreateVersion] = useState(false);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [promoteResult, setPromoteResult] = useState<PromoteRunItemResult | null>(null);
  // Separate counters: a commit must not invalidate an in-flight dataset page
  // load (whose `finally` would then never clear the loading flag), and vice
  // versa.
  const datasetsRequestRef = useRef(0);
  const promoteRequestRef = useRef(0);
  const promoteTriggerRef = useRef<HTMLButtonElement>(null);

  // Try-another-prompt state (#3317) — same shape as the promote flow: the
  // panel swaps into the drawer body, never a second Dialog.
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<CaseReplay | null>(null);
  const [replayPromptText, setReplayPromptText] = useState("");
  const [replayPromptRef, setReplayPromptRef] = useState<string | null>(null);
  const [savedPrompts, setSavedPrompts] = useState<PromptVersion[]>([]);
  const [previousReplays, setPreviousReplays] = useState<CaseReplay[]>([]);
  const [promptsError, setPromptsError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [configAttempt, setConfigAttempt] = useState(0);
  // The original run's launch configuration feeds both the disabled reason and
  // the panel's pre-flight display. null while loading; error makes the button
  // explain itself instead of failing after a click.
  const [runConfig, setRunConfig] = useState<RunConfigurationSnapshot | null>(null);
  const [runConfigError, setRunConfigError] = useState(false);
  const replayRequestRef = useRef(0);
  const replayTriggerRef = useRef<HTMLButtonElement>(null);

  const runId = item?.run_id ?? null;
  useEffect(() => {
    if (!runId) return;
    let stale = false;
    void api
      .tenant()
      .then(({ tenant_id }) => evaluationApi.getRunConfiguration(runId, tenant_id))
      .then((config) => {
        if (!stale) setRunConfig(config);
      })
      .catch(() => {
        if (!stale) setRunConfigError(true);
      });
    return () => {
      stale = true;
    };
  }, [runId, configAttempt]);

  const closeReplay = useCallback(() => {
    setReplayOpen(false);
    // The view swap removed the panel; hand focus back to the trigger once it
    // is rendered again.
    window.setTimeout(() => replayTriggerRef.current?.focus(), 0);
  }, []);

  const loadReplayPrompts = useCallback(() => {
    setPromptsLoading(true);
    setPromptsError(null);
    void platformApi.listPrompts()
      .then(setSavedPrompts)
      .catch((reason) => setPromptsError(userFacingError(reason, "Could not load saved prompts.")))
      .finally(() => setPromptsLoading(false));
  }, []);

  const loadReplayHistory = useCallback(() => {
    if (!item) return;
    setHistoryLoading(true);
    setHistoryError(null);
    void api.tenant()
      .then(({ tenant_id }) => evaluationApi.listRunItemReplays(item.run_id, item.example_id, tenant_id))
      .then((history) => setPreviousReplays((current) => {
        const records = new Map(history.map((replay) => [replay.replay_id, replay]));
        current.forEach((replay) => records.set(replay.replay_id, replay));
        return [...records.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
      }))
      .catch((reason) => setHistoryError(userFacingError(reason, "Could not load previous replays.")))
      .finally(() => setHistoryLoading(false));
  }, [item]);

  const openReplay = useCallback(() => {
    if (!item) return;
    setReplayOpen(true);
    setReplayError(null);
    loadReplayPrompts();
    loadReplayHistory();
  }, [item, loadReplayPrompts, loadReplayHistory]);

  const commitReplay = useCallback(() => {
    if (!item) return;
    const requested = ++replayRequestRef.current;
    setReplayBusy(true);
    setReplayError(null);
    setReplayResult(null);
    void (async () => {
      try {
        const { tenant_id } = await api.tenant();
        const replay = await evaluationApi.replayRunItem(item.run_id, item.example_id, tenant_id, {
          ...(replayPromptRef
            ? { prompt_version_ref: replayPromptRef }
            : { system_prompt: replayPromptText.trim() }),
        });
        if (replayRequestRef.current !== requested) return;
        setReplayResult(replay);
        setPreviousReplays((previous) => [replay, ...previous]);
      } catch (reason) {
        if (replayRequestRef.current !== requested) return;
        setReplayError(userFacingError(reason, "Could not replay the case."));
      } finally {
        if (replayRequestRef.current === requested) setReplayBusy(false);
      }
    })();
  }, [item, replayPromptRef, replayPromptText]);

  const loadDatasets = useCallback((cursor: string | null) => {
    const requested = ++datasetsRequestRef.current;
    setDatasetsLoading(true);
    void api
      .tenant()
      .then(({ tenant_id }) =>
        api.listDatasetsPage({ limit: 100, tenant_id, cursor: cursor ?? undefined }),
      )
      .then((page) => {
        if (datasetsRequestRef.current !== requested) return;
        setDatasets((previous) => (cursor ? [...previous, ...page.items] : page.items));
        setDatasetsCursor(page.next_cursor);
      })
      .catch((reason) => {
        if (datasetsRequestRef.current !== requested) return;
        setPromoteError(userFacingError(reason, "Could not load the dataset list."));
      })
      .finally(() => {
        if (datasetsRequestRef.current === requested) setDatasetsLoading(false);
      });
  }, []);

  // A changed target or source invalidates any prior outcome, and consent to
  // version one immutable dataset must not carry over to another.
  const selectDataset = useCallback((name: string) => {
    setSelectedDatasetName(name);
    setCreateVersion(false);
    setPromoteError(null);
    setPromoteResult(null);
  }, []);

  const changeTargetMode = useCallback((mode: PromoteTargetMode) => {
    setTargetMode(mode);
    setCreateVersion(false);
    setPromoteError(null);
    setPromoteResult(null);
  }, []);

  const changeNewDatasetName = useCallback((name: string) => {
    setNewDatasetName(name);
    setPromoteError(null);
    setPromoteResult(null);
  }, []);

  const changeExpectedSource = useCallback((source: ExpectedSource) => {
    setExpectedSource(source);
    setPromoteError(null);
    setPromoteResult(null);
  }, []);

  const closePromote = useCallback(() => {
    setPromoteOpen(false);
    // The view swap removed the panel; hand focus back to the trigger once it
    // is rendered again.
    window.setTimeout(() => promoteTriggerRef.current?.focus(), 0);
  }, []);

  const openPromote = useCallback(() => {
    setPromoteOpen(true);
    setPromoteError(null);
    setPromoteResult(null);
    setDatasets([]);
    setDatasetsCursor(null);
    loadDatasets(null);
  }, [loadDatasets]);

  const commitPromote = useCallback(() => {
    if (!item || (expectedSource === "reviewer" && !expectedText.trim())) return;
    const requested = ++promoteRequestRef.current;
    setPromoteBusy(true);
    setPromoteError(null);
    setPromoteResult(null);
    void (async () => {
      // Creating the dataset and promoting into it are two calls; if the
      // second fails the first has already left an empty dataset behind, and
      // the error has to say so rather than read as "nothing happened".
      let createdEmpty: string | null = null;
      try {
        const { tenant_id } = await api.tenant();
        let target = selectedDatasetName;
        if (targetMode === "new") {
          const created = await api.createDataset({
            dataset_name: newDatasetName.trim(),
            tenant_id,
            product_id: "eval-hub",
            created_by: "eval-hub-ui",
          });
          target = created.dataset_name ?? created.name ?? newDatasetName.trim();
          createdEmpty = target;
        }
        if (!target) return;
        const result = await api.promoteRunItem(target, {
          run_id: item.run_id,
          example_id: item.example_id,
          expected_source: expectedSource,
          ...(expectedSource === "reviewer" ? { expected_text: expectedText.trim() } : {}),
          create_version_if_immutable: createVersion,
          created_by: "eval-hub-ui",
        });
        if (promoteRequestRef.current !== requested) return;
        setPromoteResult(result);
      } catch (reason) {
        if (promoteRequestRef.current !== requested) return;
        const message = userFacingError(reason, "Could not promote the run item.");
        setPromoteError(
          createdEmpty
            ? `${message} The dataset "${createdEmpty}" was created and is empty; promote into it or delete it.`
            : message,
        );
      } finally {
        if (promoteRequestRef.current === requested) setPromoteBusy(false);
      }
    })();
  }, [item, targetMode, selectedDatasetName, newDatasetName, expectedSource, expectedText, createVersion]);

  const replayReason = replayDisabledReason(item, runConfig, runConfigError);

  return (
    <Dialog
      variant={variant === "dialog" ? "modal" : "drawer"}
      as="aside"
      labelledBy="run-item-drawer-title"
      scrimLabel="Close evidence inspector"
      onClose={onClose}
      initialFocusRef={titleRef}
      scrimClassName="bg-black/35 backdrop-blur-[1px]"
      width={
        variant === "dialog"
          ? "sm:w-[min(62rem,calc(100vw-3rem))]"
          : "sm:w-[88vw] lg:w-[72vw] xl:w-[900px]"
      }
      className={
        // Centred once. The shared modal variant already flex-centres its panel
        // (`items-center justify-center p-4`); adding absolute positioning and a
        // -50% translate on top took the panel out of that flow, so the padding
        // no longer balanced it and the panel sat off-centre with margin stranded
        // on one side.
        variant === "dialog"
          ? "animate-in fade-in zoom-in-95 max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] duration-150"
          : undefined
      }
    >
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {variant === "dialog"
                ? `Case ${position} of ${total}`
                : `Evidence inspector · ${item?.capture_state === "partial" ? "partial item" : item?.capture_state === "unknown" ? "capture not recorded" : "dataset row"} ${position} of ${total}`}
            </p>
            <h2
              ref={titleRef}
              id="run-item-drawer-title"
              tabIndex={-1}
              className={cn(
                "mt-1 text-sm font-semibold",
                variant === "dialog" ? "line-clamp-2 leading-5" : "truncate font-mono",
              )}
              title={variant === "dialog" ? caseTitle(item, `Case ${position}`) : exampleId}
            >
              {variant === "dialog" ? caseTitle(item, `Case ${position}`) : exampleId}
            </h2>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {runConfigError ? (
              <button type="button" onClick={() => { setRunConfigError(false); setConfigAttempt((attempt) => attempt + 1); }}
                className="min-h-11 rounded-lg border px-3 py-2 text-xs font-medium hover:bg-muted">
                Retry replay configuration
              </button>
            ) : null}
            {item && !promoteOpen && !replayOpen ? (
              <>
                <button
                  type="button"
                  ref={replayTriggerRef}
                  onClick={replayReason ? undefined : openReplay}
                  // aria-disabled, not disabled: the control stays focusable
                  // so the reason is reachable and announced.
                  aria-disabled={replayReason ? "true" : undefined}
                  aria-describedby={replayReason ? "replay-disabled-reason" : undefined}
                  title={replayReason ?? undefined}
                  className="min-h-11 rounded-lg border px-3 py-2 text-xs font-medium hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent"
                >
                  Try another prompt
                </button>
                {/* Beside the button, not inside it: inside, the text joins the
                    accessible name and the reason is announced twice. */}
                {replayReason ? (
                  <span id="replay-disabled-reason" className="sr-only">
                    {replayReason}
                  </span>
                ) : null}
                <button
                  type="button"
                  ref={promoteTriggerRef}
                  onClick={openPromote}
                  className="min-h-11 rounded-lg border px-3 py-2 text-xs font-medium hover:bg-muted"
                >
                  Promote to dataset
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={onPrevious}
              disabled={!onPrevious}
              aria-label="Previous case"
              className={cn(
                "rounded-lg border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40",
                variant === "dialog" ? "flex size-11 items-center justify-center" : "min-h-11 px-3 py-2 text-xs font-medium",
              )}
            >
              {variant === "dialog" ? <ChevronLeft className="size-4" aria-hidden="true" /> : "Previous"}
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={!onNext}
              aria-label="Next case"
              className={cn(
                "rounded-lg border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40",
                variant === "dialog" ? "flex size-11 items-center justify-center" : "min-h-11 px-3 py-2 text-xs font-medium",
              )}
            >
              {variant === "dialog" ? <ChevronRight className="size-4" aria-hidden="true" /> : "Next"}
            </button>
            <button
              type="button"
              aria-label="Close evidence inspector"
              onClick={onClose}
              className="ml-1 flex size-11 items-center justify-center rounded-lg border hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {variant === "dialog" ? <X className="size-4" aria-hidden="true" /> : <span aria-hidden="true">×</span>}
            </button>
          </div>
        </header>

        <div className={cn("min-h-0 flex-1 overscroll-contain overflow-y-auto", variant === "dialog" ? "bg-background p-4 sm:p-5" : "bg-muted/15 p-3 sm:p-5")}>
          {loading ? (
            <div role="status" className="flex min-h-56 items-center justify-center rounded-xl border bg-background">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
              <span className="sr-only">Loading run-item evidence</span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              <p>{error}</p>
              {onRetry ? <button type="button" onClick={onRetry} className="mt-3 min-h-11 rounded-lg border border-red-300 bg-background px-4 py-2 font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Retry</button> : null}
            </div>
          ) : item ? (
            <div className="space-y-3">
              {/* A status, not a field. Bordered and boxed, it read as an empty
                  input sitting at the top of the drawer. */}
              <div className="flex items-center justify-between gap-3 px-1 py-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      recordedTraceId ? "bg-success" : "bg-muted-foreground/40",
                    )}
                  />
                  {recordedTraceId ? "Trace ID recorded" : "Trace not captured"}
                </span>
                {projectId && recordedTraceId ? (
                  <Link
                    href={`/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(recordedTraceId!)}`}
                    className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Open trace in Projects <ExternalLink className="size-3" aria-hidden="true" />
                  </Link>
                ) : null}
              </div>
              {replayOpen && runConfig ? (
                <ReplayRunItemPanel
                  item={item}
                  config={runConfig}
                  savedPrompts={savedPrompts}
                  promptText={replayPromptText}
                  promptRef={replayPromptRef}
                  onPromptTextChange={(value) => {
                    setReplayPromptText(value);
                    // Editing the text clears the reference, so an edited
                    // prompt honestly reports no version.
                    setReplayPromptRef(null);
                    setReplayError(null);
                  }}
                  onStartFromSaved={(prompt) => {
                    setReplayPromptRef(promptVersionRef(prompt));
                    setReplayPromptText(prompt.content);
                    setReplayError(null);
                  }}
                  onCommit={commitReplay}
                  onBack={closeReplay}
                  busy={replayBusy}
                  error={replayError}
                  result={replayResult}
                  previousReplays={previousReplays}
                  onSelectReplay={setReplayResult}
                  promptsError={promptsError}
                  historyError={historyError}
                  promptsLoading={promptsLoading}
                  historyLoading={historyLoading}
                  onRetryPrompts={loadReplayPrompts}
                  onRetryHistory={loadReplayHistory}
                />
              ) : promoteOpen ? (
                <PromoteRunItemPanel
                  item={item}
                  onBack={closePromote}
                  datasets={datasets}
                  datasetsLoading={datasetsLoading}
                  hasMore={datasetsCursor !== null}
                  onLoadMore={() => loadDatasets(datasetsCursor)}
                  selectedDatasetName={selectedDatasetName}
                  onSelectDataset={selectDataset}
                  targetMode={targetMode}
                  onTargetModeChange={changeTargetMode}
                  newDatasetName={newDatasetName}
                  onNewDatasetNameChange={changeNewDatasetName}
                  expectedText={expectedText}
                  onExpectedTextChange={(text) => { setExpectedText(text); setPromoteError(null); setPromoteResult(null); }}
                  expectedSource={expectedSource}
                  onExpectedSourceChange={changeExpectedSource}
                  createVersion={createVersion}
                  onCreateVersionChange={setCreateVersion}
                  onCommit={commitPromote}
                  busy={promoteBusy}
                  error={promoteError}
                  result={promoteResult}
                />
              ) : variant === "dialog" ? (
                <RunItemCaseReview key={item.example_id} item={item} kpis={kpis} evaluationScope={evaluationScope} projectId={projectId} />
              ) : (
                <RunItemInspector key={item.example_id} item={item} kpis={kpis} evaluationScope={evaluationScope} projectId={projectId} />
              )}
            </div>
          ) : null}
        </div>
    </Dialog>
  );
}
