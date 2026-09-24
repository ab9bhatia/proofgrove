// Server-side User-Agent reduction.
//
// The OTel document-load instrumentation stamps `user_agent.original` — the
// full UA string — which is a recognised fingerprinting vector and, combined
// with a client IP and a timestamp in the same workspace, is identifying. The
// relay drops that attribute and derives these bounded fields instead.
//
// Two properties matter and both follow from doing this at the relay rather
// than in the browser: the values are low-entropy by construction (a browser
// family and a major version, nothing more), and they are taken from the
// request header rather than accepted as a browser-asserted attribute.

import type { BrowserInfo } from "./guard";

export const UNKNOWN_BROWSER: BrowserInfo = {
  name: "",
  version: "",
  mobile: false,
};

/**
 * Ordered because UA strings lie by design: Edge contains "Chrome", Chrome
 * contains "Safari", and nearly everything contains "Mozilla". First match
 * wins, most specific first.
 */
const BROWSER_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["edge", /Edg(?:e|A|iOS)?\/(\d+)/],
  ["opera", /OPR\/(\d+)/],
  ["samsung", /SamsungBrowser\/(\d+)/],
  ["firefox", /(?:Firefox|FxiOS)\/(\d+)/],
  ["chrome", /(?:Chrome|CriOS)\/(\d+)/],
  ["safari", /Version\/(\d+).*Safari/],
];

const MAX_VERSION_CHARS = 4;

/**
 * Reduce a User-Agent header to a browser family, major version, and form
 * factor.
 *
 * Returns `UNKNOWN_BROWSER` for anything unrecognised rather than falling back
 * to the raw string — an unparsed UA is exactly the high-entropy value this
 * function exists to avoid emitting.
 */
export function parseUserAgent(header: string | null | undefined): BrowserInfo {
  if (!header || typeof header !== "string") return UNKNOWN_BROWSER;
  // Bound the work: a hostile client can send a very long header.
  const ua = header.slice(0, 512);

  for (const [name, pattern] of BROWSER_PATTERNS) {
    const match = ua.match(pattern);
    if (match) {
      return {
        name,
        version: match[1].slice(0, MAX_VERSION_CHARS),
        mobile: /Mobi|Android|iPhone|iPad/.test(ua),
      };
    }
  }
  return UNKNOWN_BROWSER;
}
