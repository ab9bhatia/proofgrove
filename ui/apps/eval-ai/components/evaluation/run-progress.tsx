import { Check, Loader2 } from "lucide-react";

import { cn } from "@evalai/shared/utils";
import { CopyIdButton } from "@/components/copyable-id";

type RunProgressStatus = "pending" | "running" | "failed" | string;

const PHASES = ["Queued", "Evaluating", "Report"] as const;

export function EvaluationRunProgress({
  status,
  runId,
  errorMessage,
  /** Heading text, when the card is one of several (a model comparison). */
  heading,
  /** Unique per card: several of these can share a page. */
  titleId = "run-progress-title",
}: {
  status: RunProgressStatus;
  runId: string;
  errorMessage?: string | null;
  heading?: string;
  titleId?: string;
}) {
  const normalized = status.trim().toLowerCase();
  const failed = normalized === "failed";
  const cancelled = normalized === "cancelled";
  const blocked = normalized === "blocked";
  const terminal = failed || cancelled || blocked;
  const awaitingTrace = normalized === "awaiting_trace";
  const activePhase = normalized === "running" || awaitingTrace ? 1 : 0;
  const title = cancelled
    ? "Stopped"
    : blocked
      ? "Blocked"
      : failed
        ? "Evaluation stopped"
        : awaitingTrace
          ? "Waiting for completed traces"
          : normalized === "running"
            ? "Evaluating dataset rows"
            : "Preparing the evaluation";
  const description = terminal
    ? errorMessage || (cancelled ? "The run was stopped." : blocked ? "The run was blocked and could not complete." : "The run could not be completed.")
    : awaitingTrace
      ? "The agent has finished. Scoring waits until the root span closes and the child-span trajectory is finalized in the archive."
      : normalized === "running"
        ? "The selected metrics are being scored. The report will open here automatically."
        : "The run is queued and will begin as soon as capacity is available.";

  return (
    <section
      aria-live="polite"
      aria-labelledby={titleId}
      className={cn(
        "overflow-hidden rounded-xl border bg-card shadow-sm",
        failed ? "border-destructive" : "border-border",
      )}
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full",
              failed ? "bg-destructive/10 text-destructive" : "bg-brand/10 text-brand-text",
            )}
            aria-hidden="true"
          >
            {terminal ? <span className="text-lg font-semibold">!</span> : <Loader2 className="size-5 animate-spin" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <p className="eval-hub-eyebrow text-[0.6875rem] text-evalai-purple">
              {heading ? title : "Evaluation progress"}
            </p>
            <h1 id={titleId} className="mt-1 text-xl font-semibold tracking-tight">
              {heading ?? title}
            </h1>
            <p className={cn("mt-1 text-sm leading-6", failed ? "text-destructive" : "text-muted-foreground") }>
              {description}
            </p>
          </div>
        </div>

        {!terminal ? (
          <div
            className="mt-6"
            role="progressbar"
            aria-label="Evaluation run progress"
            aria-valuetext={
              awaitingTrace
                ? "Waiting for completed traces"
                : normalized === "running"
                  ? "Evaluating dataset rows"
                  : "Queued"
            }
          >
            <div className="relative grid grid-cols-3">
              <div className="absolute left-[16.66%] right-[16.66%] top-3 h-px bg-border" aria-hidden="true" />
              <div
                className={cn(
                  "absolute left-[16.66%] top-3 h-px bg-brand-text transition-[right]",
                  activePhase === 1 ? "right-1/2" : "right-[83.34%]",
                )}
                aria-hidden="true"
              />
              {PHASES.map((phase, index) => {
                const complete = index < activePhase;
                const active = index === activePhase;
                return (
                  <div key={phase} className="relative flex flex-col items-center text-center">
                    <span
                      className={cn(
                        "z-10 flex size-6 items-center justify-center rounded-full border bg-background",
                        complete && "border-success bg-success text-success-foreground",
                        active && "border-brand-text bg-brand text-brand-foreground ring-4 ring-brand-text/10",
                        !complete && !active && "border-border text-muted-foreground",
                      )}
                      aria-hidden="true"
                    >
                      {complete ? <Check className="size-3.5" aria-hidden="true" /> : active ? <span className="size-1.5 rounded-full bg-current" /> : <span className="size-1.5 rounded-full bg-border" />}
                    </span>
                    <span className={cn("mt-2 text-xs font-medium", active ? "text-foreground" : "text-muted-foreground") }>
                      {phase}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <div className="border-t bg-muted/25 px-5 py-3 sm:px-6">
        <p className="flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground" title={runId}>
          <span className="truncate">Run {runId}</span><CopyIdButton value={runId} kind="run" />
        </p>
      </div>
    </section>
  );
}
