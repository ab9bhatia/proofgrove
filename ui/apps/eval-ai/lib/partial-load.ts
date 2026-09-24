/**
 * Helpers for pages that load several independent panels at once.
 *
 * `Promise.all` fails the whole page when any one call fails, so a single sick
 * endpoint blanks panels that loaded perfectly well. `Promise.allSettled` plus
 * these two turns that into a degraded page instead.
 *
 * Naming the missing panel is the load-bearing half: an empty list that quietly
 * replaced a failure reads as "there is nothing here", which is a worse answer
 * than an error — it is wrong rather than incomplete.
 */

/** The settled value, or the fallback — recording the panel's name as missing. */
export function settledOr<T>(
  result: PromiseSettledResult<T>,
  fallback: T,
  label: string,
  missing: string[],
): T {
  if (result.status === "fulfilled") return result.value;
  missing.push(label);
  return fallback;
}

/** Sentence naming what failed to load, or null when everything arrived. */
export function partialLoadMessage(missing: readonly string[]): string | null {
  if (missing.length === 0) return null;
  const named =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `Could not load ${named}. Everything else on this page is current — refresh to try again.`;
}
