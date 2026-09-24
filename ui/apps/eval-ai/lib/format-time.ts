/**
 * One way to write a timestamp.
 *
 * There were eight of these across the app — `formatWhen`, `formatDate`,
 * `formatDateTime`, `formatTimestamp` — and between them six different things
 * to say when the value was missing: "—", "Not recorded", "not recorded",
 * "Time not recorded", "Time unavailable" and "date unavailable". The same
 * absent timestamp read differently depending on which page you were on.
 *
 * "Not recorded" is the app's existing vocabulary for a fact the system never
 * captured, which is what a missing timestamp is. An unparseable value gets the
 * same answer: from the reader's side there is nothing to show either way.
 */
const MISSING = "Not recorded";

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const DATE_ONLY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A timestamp with its time of day — for anything a reader might correlate. */
export function formatDateTime(value: string | null | undefined): string {
  const date = parse(value);
  return date ? DATE_TIME.format(date) : MISSING;
}

/**
 * The same timestamp, or null.
 *
 * For the callers that branch on absence rather than printing it — a run with no
 * end time is still running, which is a different thing to say than "Not
 * recorded". They were reaching for `toLocaleString()` to get the null, which
 * quietly gave those cells a different format from every other timestamp.
 */
export function formatDateTimeOrNull(value: string | null | undefined): string | null {
  const date = parse(value);
  return date ? DATE_TIME.format(date) : null;
}

/** A calendar date, for spans of days where the time of day is noise. */
export function formatDate(value: string | null | undefined): string {
  const date = parse(value);
  return date ? DATE_ONLY.format(date) : MISSING;
}
