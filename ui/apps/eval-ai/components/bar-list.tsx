/**
 * Ranked bar-in-row list (the Helicone/respan "top N" pattern): each row is a
 * label, a value, and a background bar sized to its share of the largest row.
 * Values render as text so the ranking is readable without the bars; the bars
 * are decorative emphasis, not the data channel.
 */
export type BarListRow = {
  key: string;
  label: string;
  value: number;
  valueLabel: string;
  secondaryLabel?: string;
};

type BarListProps = {
  title: string;
  rows: BarListRow[];
  /** Entries below the top-N cut — disclosed, never silently dropped. */
  others?: number;
  emptyText?: string;
  onSelect?: (key: string) => void;
};

export function BarList({ title, rows, others = 0, emptyText = "No data in this window", onSelect }: BarListProps) {
  const max = rows.reduce((acc, row) => Math.max(acc, row.value), 0);
  return (
    <section className="panel px-4 py-4" aria-label={title}>
      <h3 className="eval-hub-eyebrow text-[0.6875rem] text-muted-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ol className="mt-3 space-y-1.5">
          {rows.map((row) => (
            <li key={row.key} className="relative overflow-hidden rounded-md">
              <div
                aria-hidden
                className="absolute inset-y-0 left-0 bg-brand/10"
                style={{ width: max > 0 ? `${Math.max(2, (row.value / max) * 100)}%` : 0 }}
              />
              <div className="relative flex items-baseline justify-between gap-3 px-2.5 py-1.5">
                <span className="min-w-0 truncate font-mono text-xs" title={row.label}>
                  {onSelect ? (
                    <button type="button" onClick={() => onSelect(row.key)} aria-label={`Filter dashboard to ${row.label}`}
                      className="cursor-pointer rounded-sm py-1 text-left underline decoration-dotted underline-offset-4 hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {row.label}
                    </button>
                  ) : row.label}
                </span>
                <span className="shrink-0 text-xs tabular-nums">
                  {row.valueLabel}
                  {row.secondaryLabel ? (
                    <span className="ml-2 text-muted-foreground">{row.secondaryLabel}</span>
                  ) : null}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
      {others > 0 ? <p className="mt-2 text-[0.6875rem] text-muted-foreground">+ {others} more</p> : null}
    </section>
  );
}
