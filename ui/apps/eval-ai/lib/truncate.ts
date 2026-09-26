/**
 * Shorten a machine-generated name from the middle.
 *
 * Names like `Bakeoff — Example E2E Agent 20260814-151533_baseline` are
 * distinguished by their tail: the timestamp and suffix are the only part that
 * differs between two runs of the same evaluation. A trailing ellipsis therefore
 * cuts off exactly the characters a reader needs, and a column of them reads as
 * the same name repeated. Keeping both ends costs the middle, which is the part
 * they already share.
 *
 * CSS `truncate` still applies underneath as the width-aware backstop; this only
 * guarantees the tail survives when there is room for it. Pair either with a
 * `title` so the full value is always recoverable.
 */
export function middleTruncate(value: string, limit = 40): string {
  // Below three characters there is no room for an ellipsis and two sides, so
  // there is nothing useful to keep from the middle — a plain cut is honest.
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  if (limit < 3) return value.slice(0, limit);
  // Two thirds to the head: the leading words identify what the thing is, and
  // the tail only has to carry the timestamp or suffix that separates it. At
  // least one character stays on each side — `slice(-0)` returns the whole
  // string, so a zero-width tail silently defeated the truncation entirely.
  const head = Math.max(1, Math.min(limit - 2, Math.ceil(((limit - 1) * 2) / 3)));
  const tail = Math.max(1, limit - 1 - head);
  return `${value.slice(0, head).trimEnd()}…${value.slice(-tail)}`;
}
