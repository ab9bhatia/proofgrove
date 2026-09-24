"use client";

import { forwardRef, type PropsWithChildren, type SelectHTMLAttributes } from "react";
import { Search } from "lucide-react";
import { Input, type InputProps } from "@/components/ui/input";
import { cn } from "@evalai/shared/utils";

/**
 * The list-filtering row that sits between a page header and its results.
 *
 * These three exports exist because the app had thirteen hand-written search
 * inputs at four different heights and four copies of the same select class
 * literal. They carry style only — debouncing, URL sync and filter state stay
 * in the page, which genuinely differ (traces debounces at 300ms, the catalog
 * toolbars filter as you type).
 */
export function Toolbar({ children, className }: PropsWithChildren<{ className?: string }>) {
  return <div className={cn("mb-4 flex flex-wrap items-center gap-2", className)}>{children}</div>;
}

/**
 * `label` is required, not optional: every search input in the app needs an
 * accessible name and the icon is decorative, so there is nothing else to name
 * it by. Making it a required prop means a call site cannot forget.
 */
export const SearchField = forwardRef<
  HTMLInputElement,
  Omit<InputProps, "type"> & { label: string; containerClassName?: string }
>(({ label, className, containerClassName, inputSize = "sm", ...props }, ref) => (
  // `inputSize` and `containerClassName` exist for the catalog toolbars, which sit
  // beside a 60px filter group and need the taller control to line up with it.
  // Everywhere else the compact 44px control is right, so that is the default.
  // `flex-1` only when the caller has not said how wide it wants to be:
  // `flex: 1 1 0%` beats a `w-44`, so defaulting it grew a control that asked
  // to stay fixed and squeezed the filters beside it.
  // Uncapped, and `basis-56` so it wraps before it gets unusable. `sm:max-w-xs`
  // stopped the field at 20rem, which left the tracing toolbar short of its
  // card's width while Datasets and Run history — which passed their own class
  // to opt out — filled theirs. One behaviour, no opt-out needed.
  <div className={cn("relative min-w-0", !containerClassName && "flex-1 basis-56", containerClassName)}>
    <Search
      className={cn(
        "pointer-events-none absolute top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground",
        inputSize === "sm" ? "left-3" : "left-4",
      )}
      aria-hidden="true"
    />
    <Input
      ref={ref}
      inputSize={inputSize}
      type="search"
      autoComplete="off"
      aria-label={label}
      // `type="search"` pulls in the OS-native search-field chrome in WebKit
      // (a pill, regardless of the `rounded-lg` token below) unless appearance
      // is turned off, so the 8px radius only wins with this set explicitly.
      className={cn("appearance-none", inputSize === "sm" ? "pl-9" : "pl-11", className)}
      {...props}
    />
  </div>
));
SearchField.displayName = "SearchField";

/**
 * Exported for form selects that already have a visible `<label htmlFor>`.
 * Those keep their own labelling and take the class alone, so they do not end
 * up announced twice.
 */
export const filterSelectClass =
  // Both background AND colour set explicitly: a native select with only one of
  // them inherits the other from the OS, which turns dark text onto a dark field
  // under Windows dark mode.
  "select-chevron h-11 rounded-lg border border-input bg-background px-3 pr-9 text-sm text-foreground outline-none transition focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/15";

export function FilterSelect({
  label,
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <select aria-label={label} className={cn(filterSelectClass, className)} {...props}>
      {children}
    </select>
  );
}

/**
 * The two-way lifecycle switch every catalog toolbar carries (Active/Archived,
 * Active/Retired). It existed three times, copied by hand, and the copies had
 * already drifted apart in height — so one of them sat 4px short of the search
 * field beside it. One component, one height, one focus treatment.
 *
 * `h-9` inside the wrapper's `p-1` is 44px overall, matching SearchField and
 * FilterSelect.
 */
export function SegmentedControl<Value extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
  className?: string;
}) {
  return (
    <div
      className={cn("grid rounded-lg border border-border bg-muted/30 p-1", className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-9 whitespace-nowrap rounded-lg px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The row every catalog list carries above its rows: search on the left taking
 * the slack, filters against the right edge, a rule under it, inside the same
 * card as the list.
 *
 * It existed three ways — Datasets and Run history built it inline, LLMs had a
 * separate bordered card floating above its list, Prompts had a bare full-width
 * field, and Agents had nothing at all. Same row, same heights, one place.
 */
export function CatalogToolbar({ children }: PropsWithChildren) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/10 px-4 py-3 sm:px-5">
      {children}
    </div>
  );
}
