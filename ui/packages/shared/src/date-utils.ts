const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a strict YYYY-MM-DD into a local-midnight Date, or undefined. */
export function parseIsoDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = ISO_DATE.exec(value);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);

  // Reject rollovers (e.g. 2026-02-31) that Date normalizes silently.
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return undefined;
  }

  return parsed;
}

/** Format a Date as YYYY-MM-DD in local time. */
export function toIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Add days to an ISO date; returns undefined when input is invalid. */
export function addDaysToIsoDate(value: string, days: number): string | undefined {
  const parsed = parseIsoDate(value);
  if (!parsed) return undefined;
  parsed.setDate(parsed.getDate() + days);
  return toIsoDate(parsed);
}

/** Return today's local date in YYYY-MM-DD format. */
export function todayIsoDate(): string {
  return toIsoDate(new Date());
}
