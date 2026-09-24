"use client";

import type { ComponentType } from "react";

import { cn } from "@evalai/shared/utils";

import {
  handleRovingRadioKeyDown,
  rovingRadioTabIndex,
  rovingRadioTabStop,
} from "@/components/roving-radiogroup";

const COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
};

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** Read by assistive tech only; the visible row stays one line of labels. */
  hint?: string;
  icon?: ComponentType<{ className?: string }>;
};

/**
 * One choice from a short, exclusive set.
 *
 * Radios, not checkboxes: a checkbox that cannot be unchecked — which is what an
 * exclusive choice drawn as a checkbox becomes — reads as broken, and gives the
 * set no off state. Options carry their own `value`, so "none" is expressed as a
 * real option rather than as the absence of a selection.
 */
export function SegmentedChoice<T extends string>({
  options,
  value,
  onChange,
  label,
  idPrefix,
  disabled = false,
  className,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  /** `null` means nothing is chosen yet — no option renders as checked. */
  value: T | null;
  onChange: (value: T) => void;
  /** Names the group for assistive tech. */
  label: string;
  /**
   * Stable prefix for the per-option description ids. Defaults to a slug of
   * `label`, but pass it explicitly wherever the ids are referenced elsewhere —
   * deriving them from display text means rewording a label silently breaks the
   * `aria-describedby` wiring.
   */
  idPrefix?: string;
  disabled?: boolean;
  className?: string;
}) {
  // A radiogroup owns ONE tab stop and moves selection with the arrow keys.
  // Without this every option is separately tabbable and the arrows do nothing,
  // which is what the three hand-rolled groups this replaced all did.
  const values = options.map((option) => option.value);
  // With nothing chosen the group still needs one tab stop, so the first
  // option takes it without claiming to be selected.
  const tabStop = rovingRadioTabStop({ values, current: value ?? "" });

  return (
    <div
      // Literal class names: Tailwind cannot see `grid-cols-${n}`, so a computed
      // one is purged from the build and the row collapses to a single column.
      className={cn("grid w-full gap-1 rounded-lg bg-muted/50 p-1", COLUMNS[options.length] ?? "grid-cols-2", className)}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => {
        const active = value === option.value;
        const Icon = option.icon;
        const prefix = idPrefix ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const hintId = option.hint ? `${prefix}-${option.value}-description` : undefined;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-describedby={hintId}
            disabled={disabled}
            data-radio-value={option.value}
            tabIndex={rovingRadioTabIndex(option.value === tabStop)}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) =>
              handleRovingRadioKeyDown(event, {
                values,
                current: value ?? values[0]!,
                onSelect: (next) => onChange(next as T),
              })
            }
            className={cn(
              "flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-60",
              active
                ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
            )}
          >
            {Icon ? <Icon className="size-4 shrink-0" aria-hidden="true" /> : null}
            <span className="truncate">{option.label}</span>
            {option.hint ? (
              <span id={hintId} className="sr-only">
                {option.hint}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
