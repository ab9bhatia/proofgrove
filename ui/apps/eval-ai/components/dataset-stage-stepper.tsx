import { Check } from "lucide-react";
import { cn } from "@evalai/shared/utils";

const STEPS = [
  { api: "DRAFT", label: "Draft" },
  { api: "VALIDATED", label: "Validated" },
  { api: "APPROVED", label: "Approved" },
  { api: "PUBLISHED", label: "Published" },
] as const;

function currentStepIndex(status: string): number {
  if (status === "REJECTED") return 1;
  if (status === "DEPRECATED" || status === "RETIRED") return STEPS.length;
  const index = STEPS.findIndex((step) => step.api === status);
  return index >= 0 ? index : 0;
}

export function DatasetStageStepper({
  status,
  compact = false,
}: {
  status: string;
  compact?: boolean;
}) {
  const activeIndex = currentStepIndex(status);
  const rejected = status === "REJECTED";
  const terminal = status === "DEPRECATED" || status === "RETIRED";

  return (
    <div
      className={cn("w-full", compact && "max-w-md")}
      aria-label={`Dataset lifecycle. Current status: ${status}`}
    >
      <ol className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" aria-label="Lifecycle stages">
        {STEPS.map((step, index) => {
          const current = !terminal && index === activeIndex;
          const complete = terminal || index < activeIndex || (status === "PUBLISHED" && current);
          const rejectedAtReview = rejected && index === 1;

          return (
            <li
              key={step.api}
              aria-current={current ? "step" : undefined}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2",
                complete && "border-success/20 bg-success/10",
                current &&
                  !rejectedAtReview &&
                  "border-brand-text/50 bg-brand/10 text-brand-text dark:border-brand/50 dark:bg-brand/10 dark:text-brand",
                rejectedAtReview &&
                  "border-red-500/50 bg-red-50 text-red-800 dark:bg-red-950/35 dark:text-red-200",
                !complete && !current && "border-border/70 bg-muted/20 text-muted-foreground",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
                  complete && "border-success bg-success text-success-foreground",
                  current && !complete && !rejectedAtReview && "border-brand-text bg-background text-brand-text dark:border-brand dark:text-brand",
                  rejectedAtReview && "border-red-600 bg-background text-red-700",
                  !complete && !current && "border-border bg-background text-muted-foreground",
                )}
              >
                {complete ? <Check className="size-3" strokeWidth={2.5} aria-hidden="true" /> : index + 1}
              </span>
              <span className="truncate text-xs font-medium">{step.label}</span>
              {current ? <span className="sr-only">Current stage</span> : null}
            </li>
          );
        })}
      </ol>

      {rejected ? (
        <p className="mt-2 text-xs font-medium text-destructive">
          Changes requested during review
        </p>
      ) : null}
    </div>
  );
}
