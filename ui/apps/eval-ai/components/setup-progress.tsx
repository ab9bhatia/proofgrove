import { Check } from "lucide-react";

import { cn } from "@evalai/shared/utils";

type StepState = "complete" | "active" | "upcoming";

/**
 * Availability is never derived here. A caller that makes steps selectable owns the
 * gate — the same one its click handler enforces — so the strip cannot offer a step
 * the handler refuses, or refuse one the handler would open. Callers with no handler
 * (the launcher) render plain text instead of dead buttons.
 */
type SetupProgressProps = {
  currentStep: number;
  completed: boolean[];
  steps: readonly string[];
  /** Names the flow for assistive tech; every guided flow has its own. */
  label?: string;
} & (
  | { onStepSelect: (step: number) => void; available: boolean[] }
  | { onStepSelect?: undefined; available?: undefined }
);

/** Name the earliest unfinished step so a locked step can say what blocks it. */
function blockingStepLabel(steps: readonly string[], completed: boolean[], index: number): string | null {
  for (let earlier = 0; earlier < index; earlier += 1) {
    if (!completed[earlier]) return steps[earlier] ?? null;
  }
  return null;
}

export function SetupProgress({
  currentStep,
  completed,
  steps,
  available,
  onStepSelect,
  label = "Setup progress",
}: SetupProgressProps) {
  return (
    <nav aria-label={label} className="overflow-hidden rounded-xl border bg-border">
      <ol className="grid grid-cols-2 gap-px sm:grid-cols-4">
        {steps.map((label, index) => {
          const step = index + 1;
          const state: StepState = currentStep === step
            ? "active"
            : completed[index]
              ? "complete"
              : "upcoming";
          const selectable = Boolean(onStepSelect) && (available?.[index] ?? false);
          const blockedBy = blockingStepLabel(steps, completed, index);
          const stateSuffix = state === "complete" ? ", complete" : state === "active" ? ", current" : "";
          const lockSuffix = onStepSelect && !selectable
            ? blockedBy
              ? `, locked — complete ${blockedBy} first`
              : ", locked"
            : "";
          const content = (
            <>
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors duration-200",
                  state === "complete" && "border-success bg-success text-success-foreground",
                  state === "active" && "border-brand-text bg-brand text-brand-foreground shadow-sm",
                  state === "upcoming" && "border-border bg-muted text-muted-foreground",
                )}
              >
                {state === "complete" ? <Check className="size-4" aria-hidden="true" /> : step}
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Step {step}
                </span>
                <span className={cn("block truncate text-sm font-medium", state === "active" && "text-brand-text")}>
                  {label}
                </span>
              </span>
            </>
          );
          const shellClass = cn(
            "flex min-h-16 w-full items-center gap-3 px-3 py-3 text-left transition-colors duration-200 sm:px-4",
            state === "active" && "bg-brand/5",
            state === "complete" && "bg-success/5",
            state === "upcoming" && !selectable && "opacity-60",
          );

          return (
            <li key={`${step}-${label}`} className="min-w-0 bg-card">
              {onStepSelect ? (
                <button
                  type="button"
                  disabled={!selectable}
                  aria-label={`Step ${step}: ${label}${stateSuffix}${lockSuffix}`}
                  className={cn(
                    shellClass,
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:cursor-not-allowed",
                    state === "upcoming" && selectable && "hover:bg-muted/40",
                  )}
                  onClick={() => onStepSelect(step)}
                  aria-current={state === "active" ? "step" : undefined}
                >
                  {content}
                </button>
              ) : (
                <span className={shellClass} aria-current={state === "active" ? "step" : undefined}>
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
