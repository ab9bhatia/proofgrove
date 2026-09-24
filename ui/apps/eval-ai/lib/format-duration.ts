/**
 * One way to write a duration.
 *
 * Five formatters had drifted apart, so the same 1.73 second latency rendered as
 * `1.7s`, `1.73s`, `1.7 s` or `1730 ms` depending on which table you were looking
 * at, and sub-second values kept two decimals in one place and none in another.
 * A reader comparing two numbers should not have to work out whether the
 * difference is the measurement or the formatting.
 *
 * Returns null rather than a placeholder: what to show for "no value" is the
 * caller's decision, and the report and the trace tables word it differently.
 */
export function formatDuration(milliseconds: number | null | undefined): string | null {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return null;
  if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(1)}s`;
  // Spans are routinely sub-millisecond, and rounding a 0.4 ms span to "0ms" makes
  // it indistinguishable from one that genuinely took no time.
  if (milliseconds < 10) return `${Number(milliseconds.toFixed(2))}ms`;
  return `${Math.round(milliseconds)}ms`;
}
