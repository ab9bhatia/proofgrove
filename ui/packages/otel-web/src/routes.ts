// Route-template matching for browser telemetry.
//
// ADR-26-05-19 prohibits raw URLs in any field used for aggregation: every
// distinct value is a separate Prometheus series and a separate Kusto grouping
// key, so `/tenants/abc-123` and `/tenants/def-456` would be two series where
// there should be one. Every telemetry record therefore carries the Next App
// Router *template* (`/tenants/[id]`) rather than the pathname.
//
// Next exposes no client-side API for the matched template, so the app supplies
// its template list and this module resolves a pathname against it.

/** Emitted when no template matches, so unmatched traffic is visible but bounded. */
export const UNMATCHED_ROUTE = "/_unmatched";

/** Emitted when a pathname is syntactically unusable. */
export const INVALID_ROUTE = "/_invalid";

type SegmentKind = "static" | "dynamic" | "catchAll" | "optionalCatchAll";

interface Segment {
  kind: SegmentKind;
  value: string;
}

interface CompiledRoute {
  template: string;
  segments: Segment[];
  staticCount: number;
}

function classify(segment: string): Segment {
  if (segment.startsWith("[[...") && segment.endsWith("]]")) {
    return { kind: "optionalCatchAll", value: segment };
  }
  if (segment.startsWith("[...") && segment.endsWith("]")) {
    return { kind: "catchAll", value: segment };
  }
  if (segment.startsWith("[") && segment.endsWith("]")) {
    return { kind: "dynamic", value: segment };
  }
  return { kind: "static", value: segment };
}

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * Compile a list of Next App Router templates into a matcher.
 *
 * Route groups (`(marketing)`) are stripped because they don't appear in the
 * URL. Parallel/intercepting route markers (`@slot`, `(.)`) are dropped for the
 * same reason.
 */
export function compileRoutes(templates: readonly string[]): CompiledRoute[] {
  return templates
    .map((template) => {
      const segments = splitPath(template)
        .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
        .filter((s) => !s.startsWith("@"))
        .map(classify);
      return {
        template,
        segments,
        staticCount: segments.filter((s) => s.kind === "static").length,
      };
    })
    .sort((a, b) => b.staticCount - a.staticCount);
}

function matches(route: CompiledRoute, parts: readonly string[]): boolean {
  let i = 0;
  for (let s = 0; s < route.segments.length; s++) {
    const segment = route.segments[s];
    const isLast = s === route.segments.length - 1;

    if (segment.kind === "catchAll") {
      // Consumes one or more, and only ever appears last.
      return isLast && parts.length - i >= 1;
    }
    if (segment.kind === "optionalCatchAll") {
      return isLast;
    }
    if (i >= parts.length) return false;
    if (segment.kind === "static" && segment.value !== parts[i]) return false;
    i++;
  }
  return i === parts.length;
}

/**
 * Resolve a pathname to its route template.
 *
 * Templates are tried most-static-first so `/tenants/new` wins over
 * `/tenants/[id]` when both would match. Query strings and fragments are
 * stripped — they are unbounded and must never reach a label.
 */
export function makeRouteMatcher(
  templates: readonly string[],
): (pathname: string) => string {
  const compiled = compileRoutes(templates);

  return (pathname: string): string => {
    if (typeof pathname !== "string" || pathname.length === 0) {
      return INVALID_ROUTE;
    }
    const clean = pathname.split("?")[0].split("#")[0];
    const parts = splitPath(clean);

    for (const route of compiled) {
      if (matches(route, parts)) return route.template;
    }
    return UNMATCHED_ROUTE;
  };
}
