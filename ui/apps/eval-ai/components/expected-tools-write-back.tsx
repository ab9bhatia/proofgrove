"use client";

import { Check, LoaderCircle, X } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@evalai/shared/utils";
import type { DatasetRecord, WriteExpectedToolsResult } from "@/lib/api";

/** Read the row's question for display, whatever key the dataset used. */
export function recordQuestion(record: DatasetRecord): string {
  const inputs = record.inputs ?? {};
  for (const key of ["question", "query", "prompt", "input"]) {
    const value = inputs[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "(no question)";
}

/** The expected tools a row already declares, parsed the way the scorer does. */
export function recordExpectedTools(record: DatasetRecord): string[] {
  const expectations = record.expectations ?? {};
  for (const key of ["expected_actions", "expected_tool_calls", "actions"]) {
    const raw = expectations[key];
    if (typeof raw === "string" && raw.trim()) {
      return raw
        .split(";")
        .map((action) => action.split("(")[0].trim())
        .filter(Boolean);
    }
  }
  return [];
}

export function ExpectedToolsWriteBack({
  open,
  onOpenChange,
  datasetName,
  datasetStatus,
  tools,
  records,
  selectedRecordIds,
  onToggleRecord,
  onToggleAll,
  createVersion,
  onCreateVersionChange,
  onCommit,
  busy = false,
  error = null,
  result = null,
  onPublishVersion,
  publishing = false,
  publishSteps = [],
  publishState = "idle",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasetName: string;
  datasetStatus: string | null;
  tools: string[];
  records: DatasetRecord[];
  selectedRecordIds: string[];
  onToggleRecord: (recordId: string) => void;
  onToggleAll: (selectAll: boolean) => void;
  createVersion: boolean;
  onCreateVersionChange: (value: boolean) => void;
  onCommit: () => void;
  busy?: boolean;
  error?: string | null;
  result?: WriteExpectedToolsResult | null;
  /** Runs validate → approve → publish on the created draft, then retargets the run. */
  onPublishVersion?: () => void;
  publishing?: boolean;
  /** One entry per governed step attempted, in order, with the first refusal last. */
  publishSteps?: Array<{ label: string; ok: boolean; detail?: string }>;
  publishState?: "idle" | "published";
}) {
  const selectable = records.filter((record) => record.dataset_record_id);
  const selected = new Set(selectedRecordIds);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.dataset_record_id!));
  // Only DRAFT is mutable; anything else needs an explicit branch to a new version.
  const immutable = Boolean(datasetStatus) && datasetStatus !== "DRAFT";
  const blocked = immutable && !createVersion;
  const canCommit = tools.length > 0 && selectedRecordIds.length > 0 && !blocked && !busy;

  if (!open) return null;

  return (
    <Dialog
      labelledBy="expected-tools-write-back-title"
      onClose={busy ? () => undefined : () => onOpenChange(false)}
      scrimLabel="Close expected tools dialog"
      width="w-[min(48rem,calc(100vw-2rem))]"
      className="flex-none"
    >
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-6">
        <h2 id="expected-tools-write-back-title" className="text-lg font-semibold">
          {/* Editing language on a finished outcome read as though the write
              had not happened yet. */}
          {!result
            ? "Set expected tools on dataset rows"
            : publishState === "published"
              ? "Expected tools are live for this run"
              : "Expected tools written — one step left"}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close expected tools dialog"
          onClick={() => onOpenChange(false)}
          disabled={busy}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-col gap-3 px-5 py-4 sm:px-6">
        <p className="text-xs leading-5 text-muted-foreground">
          This writes an expectation onto the rows you pick — that they should call{" "}
          {tools.length > 0 ? (
            <span className="font-mono">{tools.join(", ")}</span>
          ) : (
            "the selected tools"
          )}
          . It is a different claim from scoping this run, which only decides what gets
          scored. Rows you leave unticked are not changed.
        </p>

        {/* The editing surface exists only until a write lands. Leaving it up
            afterwards showed a picker for the ORIGINAL dataset beside a success
            message about a new draft — three contradictory things at once. */}
        {result ? null : (
          <>
        {tools.length === 0 ? (
          <p className="rounded-lg border border-state-caution/30 bg-state-caution-soft px-3 py-2 text-xs leading-5">
            No tools are selected, so there is no expectation to write. Pick the tools above
            first.
          </p>
        ) : null}

        {immutable ? (
          <div className="rounded-lg border border-state-caution/30 bg-state-caution-soft px-3 py-2">
            <p className="text-xs leading-5">
              <span className="font-medium">{datasetName}</span> is {datasetStatus} and cannot
              be edited. Published and approved datasets are immutable.
            </p>
            <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs leading-5">
              <input
                type="checkbox"
                className="mt-0.5 size-3.5 accent-primary"
                checked={createVersion}
                onChange={(event) => onCreateVersionChange(event.target.checked)}
              />
              <span>
                Copy it into a new draft version and annotate that instead. The original is
                left untouched.
              </span>
            </label>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold">
            Rows to annotate
            <span className="ml-1.5 font-normal text-muted-foreground">
              {selectedRecordIds.length} of {selectable.length} selected
            </span>
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={selectable.length === 0 || busy}
            onClick={() => onToggleAll(!allSelected)}
          >
            {allSelected ? "Clear all" : "Select all"}
          </Button>
        </div>

        {selectable.length === 0 ? (
          <p className="rounded-lg border px-3 py-2 text-xs leading-5 text-muted-foreground">
            This dataset has no rows to annotate.
          </p>
        ) : (
          <div className="max-h-72 min-w-0 overflow-auto rounded-lg border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-muted/60">
                <tr>
                  <th scope="col" className="w-9 px-2 py-1.5" aria-label="Select row" />
                  <th scope="col" className="px-2 py-1.5 font-medium">Question</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Currently expects</th>
                </tr>
              </thead>
              <tbody>
                {selectable.map((record) => {
                  const id = record.dataset_record_id!;
                  const existing = recordExpectedTools(record);
                  return (
                    <tr key={id} className={cn("border-t", selected.has(id) && "bg-primary/5")}>
                      <td className="px-2 py-1.5 align-top">
                        <input
                          type="checkbox"
                          className="size-3.5 accent-primary"
                          aria-label={`Annotate row ${recordQuestion(record)}`}
                          checked={selected.has(id)}
                          disabled={busy}
                          onChange={() => onToggleRecord(id)}
                        />
                      </td>
                      <td className="min-w-0 px-2 py-1.5 align-top">
                        <span className="line-clamp-2">{recordQuestion(record)}</span>
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        {existing.length > 0 ? (
                          <span className="font-mono text-muted-foreground">
                            {existing.join(", ")}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            nothing — tool metrics not gradeable
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
          </>
        )}

        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs leading-5">
            {error}
          </p>
        ) : null}

        {result ? (
          <div className="rounded-lg border border-state-positive/30 bg-state-positive-soft px-3 py-3 text-xs leading-5">
            <p className="text-sm font-medium">
              {result.created_version
                ? `Created draft version ${result.dataset_name}`
                : `Updated ${result.dataset_name}`}
            </p>
            <p className="mt-1 text-muted-foreground">
              {result.annotated} row{result.annotated === 1 ? "" : "s"} now declare these expected
              tools
              {result.created_version ? `. ${datasetName} is unchanged.` : "."}
            </p>
            {result.created_version ? (
              <div
                role="status"
                aria-live="polite"
                className="mt-3 border-t border-state-positive/30 pt-3"
              >
                {publishState === "published" ? (
                  <p>
                    <span className="font-medium">Published.</span> This run now evaluates{" "}
                    <span className="font-medium">{result.dataset_name}</span>, so it will score
                    against the expectations you just set.
                  </p>
                ) : (
                  <>
                    <p className="text-muted-foreground">
                      A draft cannot be evaluated yet. Publishing takes it through validate,
                      approve and publish, then points this run at it — you stay here.
                    </p>
                    {publishSteps.length > 0 ? (
                      <ul className="mt-2 space-y-1">
                        {publishSteps.map((step) => (
                          <li key={step.label} className="flex items-start gap-2">
                            {step.ok ? (
                              <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                            ) : (
                              <X className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                            )}
                            {/* The tick and the colour are both invisible to a
                                screen reader, so the outcome has to be a word
                                too — otherwise a refusal reads as a plain
                                statement of what was attempted. */}
                            <span className="sr-only">{step.ok ? "Passed:" : "Failed:"}</span>
                            <span className={step.ok ? "" : "text-destructive"}>
                              {step.label}
                              {step.detail ? ` — ${step.detail}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {onPublishVersion ? (
                      <Button
                        type="button"
                        size="sm"
                        className="mt-3"
                        disabled={publishing}
                        aria-busy={publishing}
                        onClick={onPublishVersion}
                      >
                        {publishing ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                        {publishSteps.some((step) => !step.ok)
                          ? "Try publishing again"
                          : "Publish this version and use it for this run"}
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || publishing}
            onClick={() => onOpenChange(false)}
          >
            {/* Closing on an unpublished draft abandons the work mid-flow, so
                the label says what closing would mean rather than pretending
                the two outcomes are equivalent. */}
            {result && result.created_version && publishState !== "published"
              ? "Close without publishing"
              : "Close"}
          </Button>
          {/* Once a write has landed this dialog is terminal: offering another
              write here forked the dataset a second time and left a
              "Write to 0 rows" button contradicting the success message. */}
          {result ? null : (
            <Button type="button" size="sm" disabled={!canCommit} onClick={onCommit}>
              {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              {createVersion && immutable
                ? "Create version and write"
                : `Write to ${selectedRecordIds.length} row${selectedRecordIds.length === 1 ? "" : "s"}`}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
