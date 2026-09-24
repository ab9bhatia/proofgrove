"use client";

import { cn } from "@evalai/shared/utils";

export type FilterTabOption = {
  value: string;
  label: string;
  /** Shown beside the label when the caller knows how many rows match. */
  count?: number;
};

/**
 * One filter strip for the whole app.
 *
 * Datasets, Evaluations and Metrics each shipped their own version of this: the
 * same segmented shell and the same active/inactive treatment, differing only in
 * height, whether counts appeared, and whether the options navigated or set
 * state. Three implementations meant three chances to drift.
 *
 * Two modes, because the semantics genuinely differ. With `hrefFor` the options
 * are links that change the address — `aria-current="page"`, the correct role for
 * navigation. Without it they are buttons that set state — `aria-pressed`. A
 * filter that changes the URL is not the same control as one that does not, and
 * pretending otherwise breaks the back button or lies to a screen reader.
 */
export function FilterTabs({
  options,
  value,
  onChange,
  hrefFor,
  label,
  className,
}: {
  options: ReadonlyArray<FilterTabOption>;
  value: string;
  /** State mode. Ignored when `hrefFor` is given. */
  onChange?: (value: string) => void;
  /** Navigation mode: render links to these addresses instead of buttons. */
  hrefFor?: (value: string) => string;
  /** Names the group for assistive tech. */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex min-w-0 gap-1 overflow-x-auto rounded-lg bg-muted/50 p-1",
        className,
      )}
    >
      {options.map((option) => {
        const active = value === option.value;
        const content = (
          <>
            <span className="truncate">{option.label}</span>
            {option.count === undefined ? null : (
              <span
                className={cn(
                  "shrink-0 tabular-nums text-xs",
                  active ? "text-muted-foreground" : "text-muted-foreground/80",
                )}
              >
                {option.count}
              </span>
            )}
          </>
        );
        const shell = cn(
          "flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          active
            ? "bg-background text-foreground shadow-sm ring-1 ring-border"
            : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
        );

        return hrefFor ? (
          <a
            key={option.value || "all"}
            href={hrefFor(option.value)}
            aria-current={active ? "page" : undefined}
            className={shell}
          >
            {content}
          </a>
        ) : (
          <button
            key={option.value || "all"}
            type="button"
            aria-pressed={active}
            onClick={() => onChange?.(option.value)}
            className={shell}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
