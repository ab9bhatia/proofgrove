import React, { useId } from "react";
import { ArrowRight, Check, ChevronDown, Loader2 } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";
import { cn } from "@evalai/shared/utils";

export const inputClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/15";

/**
 * Labelled form field. Renders a real ``<label htmlFor>`` bound to its single child control by id,
 * and wires ``aria-describedby`` to the hint (and error, when present) so screen readers announce
 * both. ``focusFirstInvalid`` can then move focus to the first control marked ``aria-invalid``.
 */
export function Field({
  label,
  hint,
  hintId,
  error,
  errorId,
  id,
  children,
}: {
  label: string;
  hint: string;
  hintId?: string;
  error?: string | null;
  errorId?: string;
  id?: string;
  children: React.ReactNode;
}) {
  const generatedFieldId = useId();
  const generatedHintId = useId();
  const generatedErrorId = useId();
  const fieldId = id ?? generatedFieldId;
  const resolvedHintId = hintId ?? generatedHintId;
  const resolvedErrorId = errorId ?? generatedErrorId;
  const describedBy = [resolvedHintId, error ? resolvedErrorId : null].filter(Boolean).join(" ");

  let control = children;
  if (React.isValidElement(children)) {
    const childProps = children.props as Record<string, unknown>;
    control = React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
      id: childProps.id ?? fieldId,
      "aria-describedby": childProps["aria-describedby"] ?? (describedBy || undefined),
    });
  }

  return (
    <div className="space-y-2">
      <div>
        <label htmlFor={fieldId} className="block text-sm font-medium">{label}</label>
        <p id={resolvedHintId} className="mt-0.5 text-xs leading-5 text-muted-foreground">{hint}</p>
      </div>
      {control}
      {error ? <p id={resolvedErrorId} role="alert" className="text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

/** Move focus to the first control the form has flagged as invalid, if any. */
export function focusFirstInvalid(root?: HTMLElement | null): boolean {
  if (typeof document === "undefined") return false;
  const scope: ParentNode = root ?? document;
  const invalid = scope.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (invalid) {
    invalid.focus();
    return true;
  }
  return false;
}

/**
 * Toggle handler for a `<details>` whose open state React controls.
 *
 * A force-opened disclosure cannot simply re-render itself shut again: React's value is
 * already `true`, so a user closing the element leaves the DOM closed while React sees no
 * change to reconcile — and the error the force-open exists to reveal disappears. Reopening
 * the node directly is what actually holds it open.
 */
export function detailsToggleHandler(forceOpen: boolean, onOpenChange: (open: boolean) => void) {
  return (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    const element = event.currentTarget;
    if (forceOpen && !element.open) {
      element.open = true;
      return;
    }
    onOpenChange(element.open);
  };
}

/**
 * An optional cluster that starts closed, so the primary path is what the page shows first.
 *
 * ``summary`` puts the current value on the closed trigger — a collapsed control that is
 * set must still say so, or the disclosure hides state the user cannot see they configured.
 *
 */
export function Disclosure({
  label,
  summary = null,
  children,
}: React.PropsWithChildren<{
  label: string;
  summary?: string | null;
}>) {
  return (
    <details className="group mt-4 border-t">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block">{label}</span>
          {summary ? (
            <span className="mt-0.5 block truncate text-xs font-normal leading-5 text-muted-foreground group-open:hidden">{summary}</span>
          ) : null}
        </span>
        <ChevronDown className="size-4 shrink-0 transition-transform motion-reduce:transition-none group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="pb-4">{children}</div>
    </details>
  );
}

export function SelectedDetail({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt>{label}</dt><dd className="truncate" title={value}>{value}</dd></div>;
}

export function Toggle({ checked, onChange, label, description, compact = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description: string; compact?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={cn("flex w-full items-center justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary", compact ? "rounded-lg" : "rounded-lg border border-border/70 bg-transparent p-3")}><span><span className="block text-sm font-medium">{label}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span></span><span className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-primary" : "bg-muted-foreground/30")}><span className={cn("absolute top-1 size-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-6" : "translate-x-1")} /></span></button>;
}

export function CheckOption({ checked, onChange, title, description, meta, disabled = false, disabledReason }: { checked: boolean; onChange: () => void; title: string; description: string; meta?: string; disabled?: boolean; /** Why this option cannot be chosen. Callers differ, so it is never assumed. */ disabledReason?: string }) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-disabled={disabled}
      data-selected={checked}
      onClick={() => { if (!disabled) onChange(); }}
      className={cn(
        "eval-setup-choice flex gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border", checked ? "border-brand-text bg-brand text-brand-foreground" : "border-muted-foreground/40")}>
        {checked && <Check className="size-3.5" aria-hidden="true" />}
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{title}</span>
          {meta ? <span className="text-[11px] text-muted-foreground">{meta}</span> : null}
        </span>
        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
        {disabled && disabledReason ? <span className="mt-1 block text-xs font-medium text-foreground">{disabledReason}</span> : null}
      </span>
    </button>
  );
}

export type StepRequirement = { label: string; met: boolean };

export function unmetStepRequirements(requirements: readonly StepRequirement[]): StepRequirement[] {
  return requirements.filter((requirement) => !requirement.met);
}

export function StepContinue({
  disabled,
  label,
  onClick,
  requirements = [],
}: {
  disabled: boolean;
  label: string;
  onClick: () => void;
  requirements?: readonly StepRequirement[];
}) {
  const unmet = disabled ? unmetStepRequirements(requirements) : [];
  const requirementsId = useId();
  // A `disabled` button leaves the tab order, so the reason next to it can never be
  // reached by keyboard or announced. aria-disabled keeps it focusable and described.
  return (
    <div className="mt-5 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-start sm:justify-end sm:gap-4">
      {unmet.length > 0 ? (
        <div id={requirementsId} className="min-w-0 flex-1 text-xs text-muted-foreground sm:text-right">
          <p className="font-medium text-foreground">To continue:</p>
          <ul aria-label="Unmet requirements" className="mt-1 space-y-1">
            {unmet.map((requirement) => (
              <li key={requirement.label}>{requirement.label}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Button
        type="button"
        variant={disabled ? "outline" : "brand"}
        aria-disabled={disabled || undefined}
        aria-describedby={unmet.length > 0 ? requirementsId : undefined}
        onClick={() => { if (!disabled) onClick(); }}
        className={cn("shrink-0 self-end", disabled && "cursor-not-allowed opacity-40 hover:border-input hover:bg-transparent")}
      >
        {label}
        <ArrowRight className="ml-2 size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "error" }) {
  return <div role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} className={cn("rounded-xl border px-4 py-3 text-sm", tone === "error" ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" : "border-primary/20 bg-primary/5 text-foreground")}>{children}</div>;
}

export function Loading() { return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" /><span>Loading…</span></p>; }

export function Empty({ children }: { children: React.ReactNode }) { return <div className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{children}</div>; }
