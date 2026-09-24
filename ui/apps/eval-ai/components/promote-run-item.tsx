"use client";

import { useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "@evalai/shared/utils";
import type { DatasetInfo, PromoteRunItemResult, RunItemDetail } from "@/lib/api";
import { pickTextEntry } from "./run-item-inspector";
import { CopyableId } from "./copyable-id";

/**
 * Key lists mirrored from the backend builder (`promoted_record` in
 * `api/v1/datasets.py`). They must match exactly: a source this panel offers
 * that the server cannot extract would 422 after the operator committed.
 */
export const PROMOTE_QUESTION_KEYS = ["question", "query", "prompt", "input"];
export const PROMOTE_ANSWER_KEYS = ["response", "answer", "output", "actual_output", "text"];
export const PROMOTE_EXPECTED_KEYS = [
  "expected_output",
  "expected_response",
  "expected_sql",
  "expected_answer",
  "answer",
  "response",
];

export type ExpectedSource = "output" | "expected" | "reviewer";
export type PromoteTargetMode = "existing" | "new";

/** Appended by the persistence layer to any string it cut short. */
export const TRUNCATION_MARKER = "[TRUNCATED]";

/**
 * Text the server will refuse: a truncated string is a proven mutilation of
 * the exact text being installed as ground truth, so no future run can match
 * it. Mirrored here so the radio is disabled with a reason rather than 422-ing
 * after the operator commits.
 */
export function isTruncated(text: string | null, limit: number | null): boolean {
  if (text === null) return false;
  // ``>`` not ``>=``: a string whose length equals the limit was kept intact.
  return text.endsWith(TRUNCATION_MARKER) || (limit !== null && text.length > limit);
}

/** The three texts promotion works from, extracted the way the server will. */
export function promotableTexts(item: RunItemDetail): {
  question: string | null;
  actual: string | null;
  expected: string | null;
  actualTruncated: boolean;
  expectedTruncated: boolean;
} {
  const limit = item.evidence_policy.max_persisted_string_size;
  const actual = pickTextEntry(item.output, PROMOTE_ANSWER_KEYS)?.text ?? null;
  const expected = pickTextEntry(item.expected, PROMOTE_EXPECTED_KEYS)?.text ?? null;
  return {
    question: pickTextEntry(item.input, PROMOTE_QUESTION_KEYS)?.text ?? null,
    actual,
    expected,
    actualTruncated: isTruncated(actual, limit),
    expectedTruncated: isTruncated(expected, limit),
  };
}

export function datasetDisplayName(dataset: DatasetInfo): string {
  return dataset.dataset_name ?? dataset.name ?? "";
}

/** True when the captured text deserves an operator-facing caveat. */
export function captureNeedsWarning(item: RunItemDetail): boolean {
  return item.capture_state !== "complete" || item.evidence_policy.redaction_enabled === true;
}

const TRACE_GATE_REASON =
  "Trace span promotion requires the allow-listed evidence path (#2662), which is not yet available. The archive is collector-redacted.";

export function PromoteRunItemPanel({
  item,
  onBack,
  datasets,
  datasetsLoading,
  hasMore,
  onLoadMore,
  selectedDatasetName,
  onSelectDataset,
  targetMode,
  onTargetModeChange,
  newDatasetName,
  onNewDatasetNameChange,
  expectedSource,
  onExpectedSourceChange,
  expectedText = "",
  onExpectedTextChange,
  createVersion,
  onCreateVersionChange,
  onCommit,
  busy = false,
  error = null,
  result = null,
}: {
  item: RunItemDetail;
  onBack: () => void;
  datasets: DatasetInfo[];
  datasetsLoading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  selectedDatasetName: string | null;
  onSelectDataset: (name: string) => void;
  targetMode: PromoteTargetMode;
  onTargetModeChange: (mode: PromoteTargetMode) => void;
  newDatasetName: string;
  onNewDatasetNameChange: (name: string) => void;
  expectedText?: string;
  onExpectedTextChange: (text: string) => void;
  expectedSource: ExpectedSource;
  onExpectedSourceChange: (source: ExpectedSource) => void;
  createVersion: boolean;
  onCreateVersionChange: (value: boolean) => void;
  onCommit: () => void;
  busy?: boolean;
  error?: string | null;
  result?: PromoteRunItemResult | null;
}) {
  // The view swap removed the trigger the user clicked; land focus here on
  // mount. An effect rather than the focus attribute, which the hardening
  // invariant bans because it also fires on server-rendered first paint.
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus();
  }, []);
  const texts = promotableTexts(item);
  const selectable = datasets.filter((dataset) => dataset.status !== "RETIRED");
  const selected =
    selectable.find((dataset) => datasetDisplayName(dataset) === selectedDatasetName) ?? null;
  const immutable = targetMode === "existing" && selected !== null && selected.status !== "DRAFT";
  const blocked = immutable && !createVersion;
  const chosenText = expectedSource === "reviewer" ? expectedText.trim() || null : expectedSource === "output" ? texts.actual : texts.expected;
  const chosenTruncated =
    expectedSource === "reviewer" ? false : expectedSource === "output" ? texts.actualTruncated : texts.expectedTruncated;
  const targetChosen =
    targetMode === "existing" ? selected !== null : newDatasetName.trim().length > 0;
  const canCommit =
    texts.question !== null &&
    chosenText !== null &&
    !chosenTruncated &&
    targetChosen &&
    !blocked &&
    !busy;

  return (
    <section aria-labelledby="promote-run-item-title" className="rounded-xl border bg-background">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <h3 id="promote-run-item-title" className="text-sm font-semibold">
          Promote to dataset
        </h3>
        <button
          type="button"
          ref={backRef}
          onClick={onBack}
          disabled={busy}
          className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          Back to case
        </button>
      </div>

      <div className="space-y-4 p-4">
        <fieldset>
          <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Source
          </legend>
          <div className="mt-2 space-y-1.5 text-sm">
            <p className="flex flex-wrap items-center gap-1 rounded-lg border bg-muted/20 px-3 py-2">
              Run item <CopyableId value={item.run_id} kind="run" valueClassName="text-muted-foreground" />
              <span className="font-mono text-xs text-muted-foreground">· {item.example_id}</span>
            </p>
            {/* aria-disabled keeps the row in the accessibility tree so the
                reason is announced; `disabled` would silence it. */}
            <p
              aria-disabled="true"
              title={TRACE_GATE_REASON}
              className="rounded-lg border border-dashed px-3 py-2 text-muted-foreground opacity-60"
            >
              Trace span — unavailable
              <span className="sr-only">{TRACE_GATE_REASON}</span>
            </p>
          </div>
        </fieldset>

        {captureNeedsWarning(item) ? (
          <p className="rounded-lg border border-state-caution/30 bg-state-caution-soft p-3 text-xs text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution">
            {item.evidence_policy.redaction_enabled
              ? "This item was captured with redaction enabled; the promoted text may be incomplete. "
              : ""}
            {item.capture_state !== "complete"
              ? `Capture state is ${item.capture_state}. `
              : ""}
            The promoted record will carry this caveat in its metadata.
          </p>
        ) : null}

        <fieldset>
          <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Expected output
          </legend>
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            {(
              [
                {
                  source: "output" as const,
                  label: "Use the actual answer",
                  text: texts.actual,
                  truncated: texts.actualTruncated,
                },
                {
                  source: "expected" as const,
                  label: "Keep the original expectation",
                  text: texts.expected,
                  truncated: texts.expectedTruncated,
                },
              ]
            ).map(({ source, label, text, truncated }) => (
              <label
                key={source}
                className={cn(
                  "flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg border p-3 text-sm",
                  expectedSource === source && "border-primary ring-1 ring-primary",
                  (text === null || truncated) && "cursor-not-allowed opacity-50",
                )}
              >
                <span className="flex items-center gap-2 font-medium">
                  <input
                    type="radio"
                    name="promote-expected-source"
                    checked={expectedSource === source}
                    disabled={text === null || truncated || busy}
                    onChange={() => onExpectedSourceChange(source)}
                  />
                  {label}
                </span>
                {text === null ? (
                  <span className="text-xs text-muted-foreground">
                    {source === "output"
                      ? "No output text was captured for this item."
                      : "This item carries no original expectation."}
                  </span>
                ) : truncated ? (
                  <span className="text-xs text-muted-foreground">
                    This text was truncated when it was persisted, so it cannot serve as an
                    expectation — no run could ever match it.
                  </span>
                ) : (
                  <span className="line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">{text}</span>
                )}
              </label>
            ))}
            <label className={cn("flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm font-medium lg:col-span-2", expectedSource === "reviewer" && "border-primary ring-1 ring-primary")}>
              <input type="radio" name="promote-expected-source" checked={expectedSource === "reviewer"} disabled={busy} onChange={() => onExpectedSourceChange("reviewer")} />
              Write the correct answer
            </label>
          </div>
          {expectedSource === "reviewer" ? (
            <div className="mt-3 space-y-2">
              <label htmlFor="reviewer-expected-output" className="block text-sm font-medium">Correct answer</label>
              <textarea id="reviewer-expected-output" value={expectedText} onChange={(event) => onExpectedTextChange(event.target.value)} disabled={busy} required rows={5} aria-describedby="reviewer-expected-help" className="w-full rounded-lg border bg-background px-3 py-2 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" />
              <p id="reviewer-expected-help" className="text-xs leading-5 text-muted-foreground">This becomes the dataset’s expected output for future evaluations. Write the answer the agent should give, not feedback or instructions for the judge.</p>
            </div>
          ) : null}
        </fieldset>

        <fieldset>
          <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Target dataset
          </legend>
          <div className="mt-2 flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="promote-target-mode"
                checked={targetMode === "existing"}
                disabled={busy}
                onChange={() => onTargetModeChange("existing")}
              />
              Existing dataset
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="promote-target-mode"
                checked={targetMode === "new"}
                disabled={busy}
                onChange={() => onTargetModeChange("new")}
              />
              New dataset
            </label>
          </div>

          {targetMode === "existing" ? (
            <div className="mt-2 max-h-56 overflow-auto rounded-lg border">
              {datasetsLoading && selectable.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">Loading datasets…</p>
              ) : selectable.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">
                  No datasets available in this workspace. Create a new one instead.
                </p>
              ) : (
                <ul className="divide-y text-sm">
                  {selectable.map((dataset) => {
                    const name = datasetDisplayName(dataset);
                    return (
                      <li key={name}>
                        <label className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/40">
                          <input
                            type="radio"
                            name="promote-target-dataset"
                            checked={selectedDatasetName === name}
                            disabled={busy}
                            onChange={() => onSelectDataset(name)}
                          />
                          <span className="min-w-0 flex-1 truncate">{name}</span>
                          <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {dataset.status}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {hasMore ? (
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={datasetsLoading || busy}
                  className="w-full border-t px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-40"
                >
                  {datasetsLoading ? "Loading…" : "Load more datasets"}
                </button>
              ) : null}
            </div>
          ) : (
            <input
              type="text"
              value={newDatasetName}
              disabled={busy}
              onChange={(event) => onNewDatasetNameChange(event.target.value)}
              placeholder="New dataset name"
              aria-label="New dataset name"
              className="mt-2 w-full rounded-lg border bg-background px-3 py-2 text-sm"
            />
          )}
        </fieldset>

        {immutable ? (
          <div className="rounded-lg border border-state-caution/30 bg-state-caution-soft p-3 text-xs text-state-caution dark:border-state-caution/30 dark:bg-state-caution-soft dark:text-state-caution">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={createVersion}
                disabled={busy}
                onChange={(event) => onCreateVersionChange(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                <strong>{selectedDatasetName}</strong> is {selected?.status}, so its records are
                immutable. Copy it into a new draft version and promote into that instead. The
                original is left untouched.
              </span>
            </label>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {result ? (
          <div role="status" className="rounded-lg border border-state-positive/30 bg-state-positive-soft p-3 text-xs text-state-positive dark:border-state-positive/30 dark:bg-state-positive-soft dark:text-state-positive">
            <p>
              {result.duplicate
                ? "Updated the existing record — this run item was already promoted here."
                : "Promoted into "}
              {result.duplicate ? null : <strong>{result.dataset_name}</strong>}
              {result.duplicate ? (
                <>
                  {" "}
                  (<strong>{result.dataset_name}</strong>)
                </>
              ) : null}
              . Record <span className="font-mono">{result.record_id}</span>.
            </p>
            {result.created_version ? (
              <p className="mt-1">
                The record landed on the new draft version <strong>{result.dataset_name}</strong>;
                take it through validate, approve and publish to use it.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-40"
        >
          Close
        </button>
        <button
          type="button"
          onClick={onCommit}
          disabled={!canCommit}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {createVersion && immutable ? "Create version and promote" : "Promote"}
        </button>
      </div>
    </section>
  );
}
