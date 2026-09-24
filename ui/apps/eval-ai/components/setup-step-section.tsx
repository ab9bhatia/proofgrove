import Link from "next/link";
import { Check, Pencil } from "lucide-react";

import { Button, buttonVariants } from "@evalai/shared/ui/button";
import { cn } from "@evalai/shared/utils";

export type SetupStepState = "complete" | "active" | "upcoming";

export function SetupStepSection({
  id,
  number,
  title,
  description,
  state,
  summary,
  onEdit,
  onInteract,
  actionLabel = "Edit",
  actionHref,
  onActionNavigate,
  children,
}: {
  id: string;
  number: string;
  title: string;
  description: string;
  state: SetupStepState;
  summary: string;
  onEdit: () => void;
  onInteract?: () => void;
  actionLabel?: string;
  actionHref?: string;
  /** Guard for the header link, so leaving the flow can confirm unsaved edits. */
  onActionNavigate?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  children?: React.ReactNode;
}) {
  const expanded = state === "active";

  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        "panel scroll-mt-6 p-5 transition-[border-color,box-shadow,background-color] duration-200 ease-standard sm:p-6",
        state === "active" && "ring-1 ring-inset ring-brand-text/35",
      )}
      onFocusCapture={expanded ? onInteract : undefined}
      onPointerDown={expanded ? onInteract : undefined}
    >
      <div className={cn("flex gap-4", expanded && "mb-5")}>
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-[border-color,box-shadow,background-color] duration-200 ease-standard",
            state === "complete" && "border-success bg-success text-success-foreground",
            state === "active" && "border-brand-text bg-brand text-brand-foreground shadow-sm",
            state === "upcoming" && "border-border bg-muted text-muted-foreground",
          )}
          aria-hidden="true"
        >
          {state === "complete" ? <Check className="size-4" aria-hidden="true" /> : number}
        </span>
        <div className="min-w-0 flex-1">
          <div>
            {/* The badge is decorative (aria-hidden), and the ring that marks the
                active step is colour alone, so without this a screen reader has
                no way to tell which step it is on. Not a visible eyebrow: the
                sticky dots already carry that signal, and the design caps
                progress indicators at two. */}
            {expanded ? <p className="sr-only">Current step</p> : null}
            <h2 id={`${id}-title`} className="font-display text-lg font-semibold tracking-tight">{title}</h2>
          </div>
          {expanded ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : (
            <p className="mt-1 truncate text-sm text-muted-foreground" title={summary}>
              {state === "complete" ? summary : "Finish the step above to unlock."}
            </p>
          )}
        </div>
        {state === "complete" ? (
          actionHref ? (
            <Link
              href={actionHref}
              onClick={onActionNavigate}
              className={buttonVariants({ variant: "outline" })}
              aria-label={actionLabel}
            >
              {actionLabel}
            </Link>
          ) : (
            <Button type="button" variant="outline" onClick={onEdit} aria-label={`${actionLabel} ${title}`}>
              <Pencil className="size-3.5" aria-hidden="true" />
              {actionLabel}
            </Button>
          )
        ) : null}
      </div>
      {expanded ? (
        <div className="motion-safe:transition-opacity motion-safe:duration-200">
          {children}
        </div>
      ) : null}
    </section>
  );
}
