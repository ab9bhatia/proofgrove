import { AlertCircle, Inbox, Loader2 } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";
import { cn } from "@evalai/shared/utils";

export function LoadingState({
  label = "Loading…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground",
        className,
      )}
    >
      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-primary" />
      <span>{label}</span>
    </div>
  );
}

/** Widths cycled across skeleton cells so rows read as content, not stripes. */
const SKELETON_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-3/5"] as const;

function SkeletonBar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block h-3 rounded bg-muted animate-pulse motion-reduce:animate-none",
        className,
      )}
    />
  );
}

/**
 * Structure-preserving placeholder for a tabular list while it loads: a muted
 * header band plus pulsing rows. Announces itself as busy; renders no fake data.
 */
export function TableSkeleton({
  label = "Loading…",
  rows = 6,
  columns = 5,
  showHeader = true,
  className,
}: {
  label?: string;
  rows?: number;
  columns?: number;
  showHeader?: boolean;
  className?: string;
}) {
  const template = `minmax(0,2fr) repeat(${Math.max(columns - 1, 0)}, minmax(0,1fr))`;
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={cn("w-full", className)}>
      <span className="sr-only">{label}</span>
      {showHeader ? (
        <div
          aria-hidden="true"
          className="grid gap-3 border-b bg-muted/30 px-5 py-3"
          style={{ gridTemplateColumns: template }}
        >
          {Array.from({ length: columns }, (_, column) => (
            <SkeletonBar key={column} className="h-2.5 w-2/3 bg-muted-foreground/20" />
          ))}
        </div>
      ) : null}
      <div aria-hidden="true" className="divide-y">
        {Array.from({ length: rows }, (_, row) => (
          <div
            key={row}
            className="grid items-center gap-3 px-5 py-3.5"
            style={{ gridTemplateColumns: template }}
          >
            {Array.from({ length: columns }, (_, column) => (
              <SkeletonBar
                key={column}
                className={SKELETON_WIDTHS[(row + column) % SKELETON_WIDTHS.length]}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Structure-preserving placeholder for a card/list surface while it loads:
 * stacked rows with a leading block and two text lines. No fake data.
 */
export function ListSkeleton({
  label = "Loading…",
  rows = 4,
  className,
}: {
  label?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={cn("w-full", className)}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="grid gap-3">
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="flex items-center gap-3 rounded-xl border bg-card p-5">
            <span className="size-8 shrink-0 rounded-lg bg-muted animate-pulse motion-reduce:animate-none" />
            <div className="min-w-0 flex-1 space-y-2">
              <SkeletonBar className={SKELETON_WIDTHS[row % SKELETON_WIDTHS.length]} />
              <SkeletonBar
                className={cn("h-2.5 bg-muted/70", SKELETON_WIDTHS[(row + 2) % SKELETON_WIDTHS.length])}
              />
            </div>
            <SkeletonBar className="h-5 w-16 shrink-0 rounded-full bg-muted/70" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ErrorState({
  title = "Unable to load this page",
  message,
  onRetry,
  className,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      aria-atomic="true"
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex min-w-0 gap-3">
        <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div>
          <p className="font-medium text-foreground">{title}</p>
          <p className="mt-1 text-muted-foreground">{message}</p>
        </div>
      </div>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  className,
}: {
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-32 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-6 py-8 text-center",
        className,
      )}
    >
      <Inbox aria-hidden="true" className="mb-3 h-5 w-5 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
