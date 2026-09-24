/** Format an estimated or recorded USD amount for tracing tables. */
export function formatUsd(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(4)}`.replace(/0+$/, "").replace(/\.$/, "");
}
