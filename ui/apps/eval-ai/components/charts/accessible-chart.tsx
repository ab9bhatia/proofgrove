import { useId, type ReactNode } from "react";
import { cn } from "@evalai/shared/utils";

export type ChartTableRow = {
  /** Stable identity for the row (e.g. the run id). */
  key: string;
  /** One string per column, in column order. */
  values: string[];
  /** Optional note surfaced to assistive tech (e.g. "diagnostic", "excluded"). */
  note?: string;
};

export type AccessibleChartFrameProps = {
  title: string;
  /** Plain-language description of the series (screen-reader + visible). */
  summary: string;
  /** Column headers for the table-equivalent. */
  columns: string[];
  /** One table row per data point. */
  rows: ChartTableRow[];
  /** The visual chart (Recharts). Hidden from assistive tech — the table is the
   * accessible equivalent. */
  children?: ReactNode;
  /** Extra context rendered under the title. */
  description?: ReactNode;
  /**
   * Keep the table-equivalent for assistive tech but stop painting it, for
   * callers that already render a richer visible table of the same data.
   * The a11y contract is unchanged — the table is still in the accessibility
   * tree; it is simply not drawn twice.
   */
  visuallyHideTable?: boolean;
  className?: string;
};

/**
 * The one accessible chart primitive reused by every chart in this slice.
 *
 * Every chart ships with two affordances so it is never a picture-only view:
 *  1. a text summary, wired to the figure via `aria-describedby`; and
 *  2. a semantic `<table>` table-equivalent of the exact same data — native
 *     table semantics let a keyboard/AT user navigate every point without
 *     turning each row into a redundant tab stop.
 *
 * The visual itself is `aria-hidden`; the table carries the data for AT.
 */
export function AccessibleChartFrame({
  title,
  summary,
  columns,
  rows,
  children,
  description,
  visuallyHideTable = false,
  className,
}: AccessibleChartFrameProps) {
  const baseId = useId();
  const summaryId = `${baseId}-summary`;
  const tableId = `${baseId}-table`;

  return (
    <figure
      role="group"
      aria-label={title}
      aria-describedby={summaryId}
      className={cn("m-0 rounded-xl border bg-card p-4", className)}
    >
      <figcaption className="mb-2 flex flex-col gap-1">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        {description ? (
          <span className="text-xs text-muted-foreground">{description}</span>
        ) : null}
      </figcaption>

      <p id={summaryId} className="mb-3 text-xs text-muted-foreground">
        {summary}
      </p>

      {children ? (
        <div className="mb-3" aria-hidden="true">
          {children}
        </div>
      ) : null}

      <div className={visuallyHideTable ? "sr-only" : "overflow-x-auto"}>
        <table
          id={tableId}
          className="w-full border-collapse text-left text-xs"
        >
          <caption className="sr-only">{title} — data table</caption>
          <thead className="border-b text-muted-foreground">
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col" className="px-2 py-1.5 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(1, columns.length)}
                  className="px-2 py-3 text-center text-muted-foreground"
                >
                  No data points
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.key}
                  aria-label={row.note ? `${row.values.join(", ")} (${row.note})` : undefined}
                >
                  {row.values.map((value, index) => (
                    <td key={`${row.key}-${columns[index] ?? index}`} className="px-2 py-1.5 tabular-nums">
                      {value}
                      {index === row.values.length - 1 && row.note ? (
                        <span className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                          · {row.note}
                        </span>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
