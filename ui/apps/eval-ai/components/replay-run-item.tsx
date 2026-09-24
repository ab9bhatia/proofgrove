"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import { cn } from "@evalai/shared/utils";
import type { CaseReplay, PromptVersion, RunConfigurationSnapshot, RunItemDetail } from "@/lib/api";
import { formatDuration } from "@/lib/format-duration";
import { replayQuestionText } from "@/lib/prompt-replay";
import { SystemPromptPanel } from "./evaluation/system-prompt-panel";
import { CopyableId } from "./copyable-id";
import { PROMOTE_ANSWER_KEYS } from "./promote-run-item";
import { pickTextEntry } from "./run-item-inspector";

function tokenCount(usage: Record<string, unknown> | null, key: string): number | null {
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageLine(usage: Record<string, unknown> | null): string | null {
  const prompt = tokenCount(usage, "prompt_tokens");
  const completion = tokenCount(usage, "completion_tokens");
  if (prompt === null && completion === null) return null;
  return `${prompt ?? "—"} prompt · ${completion ?? "—"} completion tokens`;
}

/**
 * The "Try another prompt" flow inside the case drawer (#3317).
 *
 * Mirrors `PromoteRunItemPanel`: swapped into the drawer body (never a second
 * Dialog), busy/error/result state owned by the drawer, Back returns focus to
 * the trigger. Before anything runs, the original input, model configuration
 * and prompt version are shown — the replay reproduces them exactly except
 * for the prompt. The replay output is deliberately not scored; scoring
 * re-enters only through a full evaluation run.
 */
export function ReplayRunItemPanel({
  item,
  config,
  savedPrompts,
  promptText,
  promptRef,
  onPromptTextChange,
  onStartFromSaved,
  onCommit,
  onBack,
  busy = false,
  error = null,
  result = null,
  previousReplays = [],
  onSelectReplay,
  promptsError = null,
  historyError = null,
  promptsLoading = false,
  historyLoading = false,
  onRetryPrompts,
  onRetryHistory,
}: {
  item: RunItemDetail;
  config: RunConfigurationSnapshot;
  savedPrompts: PromptVersion[];
  promptText: string;
  promptRef: string | null;
  onPromptTextChange: (value: string) => void;
  onStartFromSaved: (prompt: PromptVersion) => void;
  onCommit: () => void;
  onBack: () => void;
  busy?: boolean;
  error?: string | null;
  result?: CaseReplay | null;
  previousReplays?: CaseReplay[];
  onSelectReplay?: (replay: CaseReplay) => void;
  promptsError?: string | null;
  historyError?: string | null;
  promptsLoading?: boolean;
  historyLoading?: boolean;
  onRetryPrompts?: () => void;
  onRetryHistory?: () => void;
}) {
  // The view swap removed the trigger the user clicked; land focus here on
  // mount (same invariant as the promote panel — no autofocus attribute).
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  const question = replayQuestionText(item.input);
  const originalAnswer = pickTextEntry(item.output, PROMOTE_ANSWER_KEYS)?.text ?? null;
  const originalUsage = usageLine(item.execution.usage);
  const judged = item.scorer_results.filter((r) => r.passed !== null);
  const passed = judged.filter((r) => r.passed === true);
  const versionSeparator = result?.prompt_version_ref?.lastIndexOf("@") ?? -1;
  const promptLink = result?.prompt_version_ref && versionSeparator > 0
    ? `/catalog/prompts/${encodeURIComponent(result.prompt_version_ref.slice(0, versionSeparator))}?compare=${encodeURIComponent(result.prompt_version_ref.slice(versionSeparator + 1))}`
    : null;
  const canCommit = !busy && (promptRef !== null || promptText.trim().length > 0);

  return (
    <section aria-labelledby="replay-run-item-title" className="rounded-xl border bg-background">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <h3 id="replay-run-item-title" className="text-sm font-semibold">
          Try another prompt
        </h3>
        <button
          type="button"
          ref={backRef}
          onClick={onBack}
          disabled={busy}
          className="min-h-11 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          Back to case
        </button>
      </div>

      <div className="space-y-4 p-4">
        <fieldset>
          <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            What the replay reproduces
          </legend>
          <div className="mt-2 space-y-1.5 text-sm">
            {question ? (
              <details className="rounded-lg border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">Original input</summary>
                <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm leading-6">{question}</p>
                {item.evidence_policy.redaction_enabled ? <p className="mt-2 text-xs text-muted-foreground">Replays use the recorded text, including any redaction.</p> : null}
              </details>
            ) : null}
            <details className="rounded-lg border px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">Original configuration</summary>
            <p className="mt-3 flex flex-wrap items-center gap-1">
              Case <CopyableId value={item.run_id} kind="run" valueClassName="text-muted-foreground" />
              <span className="font-mono text-xs text-muted-foreground">· {item.example_id}</span>
            </p>
            <div className="mt-2 break-words text-sm leading-6 text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">Model</span>{" "}
                <span className="font-mono">{config.target_model}</span>
                {config.target_endpoint ? <span className="font-mono"> · {config.target_endpoint}</span> : null}
              </p>
              <p className="mt-1">
                <span className="font-medium text-foreground">Original prompt</span>{" "}
                {config.prompt_version_ref ? (
                  <span className="font-mono">{config.prompt_version_ref}</span>
                ) : config.system_prompt ? (
                  "unsaved text, recorded on the run"
                ) : (
                  "none — the question was sent alone"
                )}
              </p>
              {config.system_prompt ? (
                <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded border bg-background px-2 py-1.5 font-mono">
                  {config.system_prompt}
                </pre>
              ) : null}
            </div>
            </details>
          </div>
        </fieldset>

        <fieldset disabled={busy}>
          <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Replay with
          </legend>
          {promptsLoading ? <p role="status" className="mt-2 text-sm text-muted-foreground">Loading saved prompts…</p> : null}
          {promptsError ? <p role="alert" className="mt-2 text-sm text-destructive">{promptsError} <button type="button" onClick={onRetryPrompts} className="min-h-11 underline">Retry saved prompts</button></p> : null}
          <SystemPromptPanel
            required
            value={promptText}
            reference={promptRef}
            savedPrompts={savedPrompts}
            saving={busy}
            canSave={false}
            saveError={null}
            onChange={onPromptTextChange}
            onStartFrom={onStartFromSaved}
            onSave={() => {}}
          />
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onCommit}
            disabled={!canCommit}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            {busy ? "Replaying…" : "Run replay"}
          </button>
          <span className="text-xs text-muted-foreground">
            Invokes the model once for this case. The original run is never changed.
          </span>
        </div>

        {error ? (
          <p role="alert" className="text-xs font-medium text-destructive">
            {error}
          </p>
        ) : null}

        <p role="status" className="sr-only">{busy ? "Replay in progress." : result ? "Replay result available below." : ""}</p>
        {result ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Original</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                {originalAnswer ?? "No output text was captured for this case."}
              </p>
              <dl className="mt-3 space-y-1 border-t pt-2 text-xs text-muted-foreground">
                {judged.length > 0 ? (
                  <div>
                    <dt className="sr-only">Scores</dt>
                    <dd>{passed.length} of {judged.length} judged checks passed</dd>
                  </div>
                ) : null}
                {item.execution.latency_ms !== null ? <div><dt className="sr-only">Latency</dt><dd>Latency {formatDuration(item.execution.latency_ms)}</dd></div> : null}
                {originalUsage ? <div><dt className="sr-only">Tokens</dt><dd>{originalUsage}</dd></div> : null}
              </dl>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Replay — not scored
              </p>
              {result.invocation_error ? (
                <p role="alert" className="mt-2 text-sm leading-6 text-destructive">
                  The invocation failed and was recorded: {result.invocation_error}
                </p>
              ) : (
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{result.response}</p>
              )}
              <details className="mt-3 rounded-lg border px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium">Recorded replay prompt</summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">{result.system_prompt ?? "No prompt text recorded."}</pre>
              </details>
              {promptLink ? <Link href={promptLink} className="mt-2 inline-flex min-h-11 items-center text-sm text-primary underline">Compare prompt version</Link> : null}
              <dl className="mt-3 space-y-1 border-t pt-2 text-xs text-muted-foreground">
                <div>
                  <dt className="sr-only">Prompt</dt>
                  <dd>
                    Prompt{" "}
                    {result.prompt_version_ref ? (
                      <span className="font-mono">{result.prompt_version_ref}</span>
                    ) : (
                      "edited text"
                    )}
                    {result.prompt_hash ? <span className="font-mono"> · {result.prompt_hash.slice(0, 12)}…</span> : null}
                  </dd>
                </div>
                {result.latency_ms !== null ? <div><dt className="sr-only">Latency</dt><dd>Latency {formatDuration(result.latency_ms)}</dd></div> : null}
                {usageLine(result.target_usage) ? <div><dt className="sr-only">Tokens</dt><dd>{usageLine(result.target_usage)}</dd></div> : null}
                <div>
                  <dt className="sr-only">Cost</dt>
                  <dd>
                    {result.estimated_cost_usd === null
                      ? "Cost unavailable for this model"
                      : result.estimated_cost_usd > 0 && result.estimated_cost_usd < 0.00005
                        ? "Estimated cost < $0.0001 (list rate)"
                        : `Estimated cost $${result.estimated_cost_usd.toFixed(4)} (list rate)`}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                Replays are recorded as separate evidence and never appear in run results.
              </p>
            </div>
          </div>
        ) : null}

        {historyLoading ? <p role="status" className="text-sm text-muted-foreground">Loading replay history…</p> : null}
        {historyError ? <p role="alert" className="text-sm text-destructive">{historyError} <button type="button" onClick={onRetryHistory} className="min-h-11 underline">Retry replay history</button></p> : null}
        {previousReplays.length > 0 ? (
          <details className="rounded-lg border">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
              Previous replays ({previousReplays.length})
            </summary>
            <ul className="divide-y border-t">
              {previousReplays.map((replay) => (
                <li key={replay.replay_id} className={cn("px-3 py-2 text-xs", replay.invocation_error && "text-destructive")}>
                  <button type="button" disabled={busy} onClick={() => onSelectReplay?.(replay)}
                    aria-pressed={result?.replay_id === replay.replay_id}
                    className="min-h-11 w-full rounded px-2 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">
                  <span className="font-mono">
                    {replay.prompt_version_ref ?? (replay.prompt_hash ? `${replay.prompt_hash.slice(0, 12)}…` : "no prompt recorded")}
                  </span>
                  <span className="text-muted-foreground"> · {new Date(replay.created_at).toLocaleString()}</span>
                  {replay.invocation_error ? " · failed" : null}
                  <span className="ml-2 text-primary underline">View result</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}
