// Ingest guard for the BFF telemetry relay.
//
// ADR-26-08-12 makes this validation load-bearing rather than optional.
// Everything arriving here came from a browser: the session is authenticated,
// but the payload is not trustworthy. Three risks are handled:
//
//  1. Forged attribution. The relay **discards the browser's payload structure
//     entirely** and rebuilds it. The resource is synthesised from values the
//     pod already knows; spans and data points are reconstructed from explicit
//     field allowlists. Nothing survives by default — an OTLP field this file
//     does not copy does not reach the collector. Filtering the client's
//     objects in place was tried first and failed review twice: once for
//     resource attributes, once for the nested channels (`status.message`,
//     `traceState`, exemplars) that in-place mutation silently forwarded.
//  2. Unbounded cardinality. Metric names, route labels and enum-valued
//     attributes are checked against allowlists. A browser holding the pen on
//     a Prometheus label is an unbounded-series generator.
//  3. Volume. Azure Monitor bills per GB. Payloads are bounded, and overage is
//     clamped and *counted* rather than silently dropped.

import {
  ALLOWED_METRIC_NAMES,
  ALLOWED_NAVIGATION_TYPES,
  ALLOWED_RECORD_ATTRIBUTES,
  ALLOWED_VITAL_RATINGS,
  ATTR_BROWSER_MOBILE,
  ATTR_BROWSER_NAME,
  ATTR_BROWSER_NAVIGATION_TYPE,
  ATTR_BROWSER_VERSION,
  ATTR_BROWSER_VITAL_RATING,
  ATTR_CTX_APP,
  ATTR_CTX_EMITTER_APP,
  ATTR_CTX_TENANT,
  ATTR_DEPLOYMENT_ENVIRONMENT,
  ATTR_HTTP_ROUTE,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_URL_FULL,
  ATTR_USER_HASH,
} from "../attributes";

/** OTLP signals the relay accepts. Anything else is rejected outright. */
export type IngestSignal = "traces" | "metrics" | "errors";

export const INGEST_SIGNALS: ReadonlySet<string> = new Set([
  "traces",
  "metrics",
  "errors",
]);

/** Every OTLP metric data shape. Omitting one is a silent bypass. */
const METRIC_SHAPES = [
  "gauge",
  "sum",
  "histogram",
  "exponentialHistogram",
  "summary",
] as const;

/** Caps on individual values, so one record can't be unbounded. */
const MAX_ATTRIBUTE_VALUE_CHARS = 512;
const MAX_SPAN_NAME_CHARS = 128;
const MAX_URL_CHARS = 512;
/** Structural bounds; generous multiples of what the SDK legitimately emits. */
const MAX_EVENTS_PER_SPAN = 32;
const MAX_LINKS_PER_SPAN = 8;
const MAX_HISTOGRAM_BUCKETS = 128;
const MAX_SUMMARY_QUANTILES = 16;

/** Units this pipeline emits. Anything else is browser-invented free text. */
const ALLOWED_UNITS: ReadonlySet<string> = new Set(["ms", "1", "s", "By"]);

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
/** OTLP/JSON encodes fixed64 as decimal strings; numbers appear from some SDKs. */
const UNIX_NANO_PATTERN = /^\d{1,20}$/;

/**
 * Payload ceilings.
 *
 * Sized against the producer configuration in `init.ts`: a compliant client
 * exports at most `maxExportBatchSize` (100) spans per request, and at most
 * six vitals × the app's route count in data points. The headroom absorbs a
 * `forceFlush` racing a scheduled flush.
 */
export interface IngestLimits {
  maxBodyBytes: number;
  maxSpans: number;
  maxMetricDataPoints: number;
  maxErrors: number;
}

export const DEFAULT_INGEST_LIMITS: IngestLimits = {
  maxBodyBytes: 256 * 1024,
  maxSpans: 150,
  maxMetricDataPoints: 100,
  maxErrors: 20,
};

/** Browser identification derived server-side from the User-Agent header. */
export interface BrowserInfo {
  name: string;
  version: string;
  mobile: boolean;
}

/** Everything the relay knows for itself and therefore never accepts. */
export interface RelayContext {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  app: string;
  emitterApp: string;
  tenant: string;
  browser: BrowserInfo;
  /**
   * Salted hash of the gateway-asserted subject, or "" when no salt is
   * available. Attached to traces and error records, never to metrics.
   */
  userHash: string;
  /** Resolves a client-supplied route to a known template, or the sentinel. */
  normalizeRoute: (route: string) => string;
}

/** What was dropped, so the response can report it instead of hiding it. */
export interface ClampReport {
  rejectedSpans: number;
  rejectedDataPoints: number;
  droppedAttributes: number;
}

export type GuardResult =
  | { ok: true; payload: Record<string, unknown>; clamped: ClampReport }
  | { ok: false; status: number; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringAttr(key: string, value: string): Record<string, unknown> {
  return { key, value: { stringValue: value } };
}

function boolAttr(key: string, value: boolean): Record<string, unknown> {
  return { key, value: { boolValue: value } };
}

/**
 * Build the resource from the relay's own knowledge.
 *
 * The browser's resource is discarded before this is called. This is the
 * control that makes tenant attribution trustworthy — stronger than filtering,
 * because there is no path by which a client value can survive.
 */
export function buildResource(
  ctx: RelayContext,
  includeIdentity: boolean,
): Record<string, unknown> {
  const attributes: Record<string, unknown>[] = [
    stringAttr(ATTR_SERVICE_NAME, ctx.serviceName),
    stringAttr(ATTR_SERVICE_VERSION, ctx.serviceVersion),
    stringAttr(ATTR_DEPLOYMENT_ENVIRONMENT, ctx.environment),
    stringAttr(ATTR_CTX_APP, ctx.app),
    stringAttr(ATTR_CTX_EMITTER_APP, ctx.emitterApp),
  ];
  if (ctx.tenant) attributes.push(stringAttr(ATTR_CTX_TENANT, ctx.tenant));
  if (ctx.browser.name) {
    attributes.push(stringAttr(ATTR_BROWSER_NAME, ctx.browser.name));
    attributes.push(stringAttr(ATTR_BROWSER_VERSION, ctx.browser.version));
    attributes.push(boolAttr(ATTR_BROWSER_MOBILE, ctx.browser.mobile));
  }
  // Identity goes on traces and errors, never on metrics: one series per user
  // is an unbounded dimension, and it would defeat the aggregation the metrics
  // exist for. Omitted entirely when no salt is available — an unsalted or
  // placeholder value would be worse than absence.
  if (includeIdentity && ctx.userHash) {
    attributes.push(stringAttr(ATTR_USER_HASH, ctx.userHash));
  }
  return { attributes };
}

/** Strip query string and fragment; they carry tokens and unbounded entropy. */
export function sanitizeUrl(raw: string): string {
  return raw.split("#")[0].split("?")[0].slice(0, MAX_URL_CHARS);
}

interface FilterState {
  dropped: number;
}

/**
 * Filter one attribute list against the allowlist, validating each value.
 *
 * Nested values (`kvlistValue`, `arrayValue`, `bytesValue`) are rejected
 * wholesale: they can hide disallowed keys a level down, and nothing the
 * browser instrumentation legitimately emits needs them.
 */
function filterAttributes(
  attributes: unknown,
  ctx: RelayContext,
  state: FilterState,
): unknown[] {
  const out: unknown[] = [];
  for (const attr of asArray(attributes)) {
    if (!isRecord(attr)) {
      state.dropped++;
      continue;
    }
    const key = attr.key;
    const value = attr.value;
    if (
      typeof key !== "string" ||
      !ALLOWED_RECORD_ATTRIBUTES.has(key) ||
      !isRecord(value) ||
      "kvlistValue" in value ||
      "arrayValue" in value ||
      "bytesValue" in value
    ) {
      state.dropped++;
      continue;
    }

    const text =
      typeof value.stringValue === "string" ? value.stringValue : undefined;

    if (key === ATTR_HTTP_ROUTE) {
      if (text === undefined) {
        state.dropped++;
        continue;
      }
      out.push(stringAttr(key, ctx.normalizeRoute(text)));
      continue;
    }
    if (key === ATTR_URL_FULL) {
      if (text === undefined) {
        state.dropped++;
        continue;
      }
      out.push(stringAttr(key, sanitizeUrl(text)));
      continue;
    }
    if (key === ATTR_BROWSER_VITAL_RATING) {
      if (text === undefined || !ALLOWED_VITAL_RATINGS.has(text)) {
        state.dropped++;
        continue;
      }
      out.push(stringAttr(key, text));
      continue;
    }
    if (key === ATTR_BROWSER_NAVIGATION_TYPE) {
      if (text === undefined || !ALLOWED_NAVIGATION_TYPES.has(text)) {
        state.dropped++;
        continue;
      }
      out.push(stringAttr(key, text));
      continue;
    }
    if (text !== undefined) {
      out.push(stringAttr(key, text.slice(0, MAX_ATTRIBUTE_VALUE_CHARS)));
      continue;
    }
    // Non-string primitives (ints, doubles, bools) for allowlisted keys such
    // as http.response.status_code pass through with only the known value
    // shapes copied.
    const rebuilt: Record<string, unknown> = {};
    if (typeof value.intValue === "string" || typeof value.intValue === "number") {
      rebuilt.intValue = value.intValue;
    } else if (typeof value.doubleValue === "number") {
      rebuilt.doubleValue = value.doubleValue;
    } else if (typeof value.boolValue === "boolean") {
      rebuilt.boolValue = value.boolValue;
    } else {
      state.dropped++;
      continue;
    }
    out.push({ key, value: rebuilt });
  }
  return out;
}

function boundName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, MAX_SPAN_NAME_CHARS) : "unknown";
}

function hexId(raw: unknown, pattern: RegExp): string | undefined {
  return typeof raw === "string" && pattern.test(raw) ? raw : undefined;
}

/** OTLP fixed64 timestamps: decimal string (canonical) or number. */
function unixNano(raw: unknown): string | number | undefined {
  if (typeof raw === "string" && UNIX_NANO_PATTERN.test(raw)) return raw;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  return undefined;
}

function finiteNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** int64 counts arrive as decimal strings or numbers. */
function intLike(raw: unknown): string | number | undefined {
  if (typeof raw === "string" && UNIX_NANO_PATTERN.test(raw)) return raw;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  return undefined;
}

function setIfDefined(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) target[key] = value;
}

/**
 * Rebuild one span from explicit fields. Anything not copied here — and that
 * is the point — does not exist downstream: `status.message`, span and link
 * `traceState`, and any key a client invents are all dropped by construction.
 * Status keeps only its code; free-text triage belongs to the errors channel,
 * which is sanitised.
 */
function rebuildSpan(
  span: Record<string, unknown>,
  ctx: RelayContext,
  state: FilterState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: boundName(span.name),
    attributes: filterAttributes(span.attributes, ctx, state),
  };
  setIfDefined(out, "traceId", hexId(span.traceId, TRACE_ID_PATTERN));
  setIfDefined(out, "spanId", hexId(span.spanId, SPAN_ID_PATTERN));
  setIfDefined(out, "parentSpanId", hexId(span.parentSpanId, SPAN_ID_PATTERN));
  setIfDefined(out, "startTimeUnixNano", unixNano(span.startTimeUnixNano));
  setIfDefined(out, "endTimeUnixNano", unixNano(span.endTimeUnixNano));
  if (
    typeof span.kind === "number" &&
    Number.isInteger(span.kind) &&
    span.kind >= 0 &&
    span.kind <= 5
  ) {
    out.kind = span.kind;
  }
  if (isRecord(span.status)) {
    const code = span.status.code;
    if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 2) {
      out.status = { code };
    }
  }

  const events: Record<string, unknown>[] = [];
  for (const event of asArray(span.events).slice(0, MAX_EVENTS_PER_SPAN)) {
    if (!isRecord(event)) continue;
    const rebuilt: Record<string, unknown> = {
      name: boundName(event.name),
      attributes: filterAttributes(event.attributes, ctx, state),
    };
    setIfDefined(rebuilt, "timeUnixNano", unixNano(event.timeUnixNano));
    events.push(rebuilt);
  }
  if (events.length > 0) out.events = events;

  const links: Record<string, unknown>[] = [];
  for (const link of asArray(span.links).slice(0, MAX_LINKS_PER_SPAN)) {
    if (!isRecord(link)) continue;
    const traceId = hexId(link.traceId, TRACE_ID_PATTERN);
    const spanId = hexId(link.spanId, SPAN_ID_PATTERN);
    // A link without valid ids references nothing; dropping it loses no data.
    if (!traceId || !spanId) continue;
    links.push({
      traceId,
      spanId,
      attributes: filterAttributes(link.attributes, ctx, state),
    });
  }
  if (links.length > 0) out.links = links;

  return out;
}

/**
 * Rebuild an OTLP traces payload: synthesised resource, reconstructed spans,
 * clamped to the limit.
 */
function processTraces(
  payload: Record<string, unknown>,
  ctx: RelayContext,
  limits: IngestLimits,
  report: ClampReport,
): Record<string, unknown> {
  const state: FilterState = { dropped: 0 };
  const spans: Record<string, unknown>[] = [];

  for (const resourceSpans of asArray(payload.resourceSpans)) {
    if (!isRecord(resourceSpans)) continue;
    for (const scopeSpans of asArray(resourceSpans.scopeSpans)) {
      if (!isRecord(scopeSpans)) continue;
      for (const span of asArray(scopeSpans.spans)) {
        if (!isRecord(span)) continue;
        if (spans.length >= limits.maxSpans) {
          report.rejectedSpans++;
          continue;
        }
        spans.push(rebuildSpan(span, ctx, state));
      }
    }
  }

  report.droppedAttributes += state.dropped;
  return {
    resourceSpans: [
      {
        resource: buildResource(ctx, true),
        // Scope attributes are dropped entirely; nothing needs them.
        scopeSpans: [{ scope: { name: "@evalai/otel-web" }, spans }],
      },
    ],
  };
}

/**
 * Rebuild one metric data point for a given shape. Exemplars are dropped
 * outright — their `filteredAttributes` are an unfiltered channel and nothing
 * in RUM consumes them.
 */
function rebuildDataPoint(
  shape: (typeof METRIC_SHAPES)[number],
  point: Record<string, unknown>,
  ctx: RelayContext,
  state: FilterState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    attributes: filterAttributes(point.attributes, ctx, state),
  };
  setIfDefined(out, "startTimeUnixNano", unixNano(point.startTimeUnixNano));
  setIfDefined(out, "timeUnixNano", unixNano(point.timeUnixNano));

  if (shape === "gauge" || shape === "sum") {
    setIfDefined(out, "asDouble", finiteNumber(point.asDouble));
    setIfDefined(out, "asInt", intLike(point.asInt));
    return out;
  }

  setIfDefined(out, "count", intLike(point.count));
  setIfDefined(out, "sum", finiteNumber(point.sum));
  setIfDefined(out, "min", finiteNumber(point.min));
  setIfDefined(out, "max", finiteNumber(point.max));

  if (shape === "histogram") {
    const bucketCounts = asArray(point.bucketCounts)
      .slice(0, MAX_HISTOGRAM_BUCKETS)
      .map(intLike)
      .filter((v): v is string | number => v !== undefined);
    const explicitBounds = asArray(point.explicitBounds)
      .slice(0, MAX_HISTOGRAM_BUCKETS)
      .map(finiteNumber)
      .filter((v): v is number => v !== undefined);
    if (bucketCounts.length > 0) out.bucketCounts = bucketCounts;
    if (explicitBounds.length > 0) out.explicitBounds = explicitBounds;
    return out;
  }

  if (shape === "exponentialHistogram") {
    setIfDefined(out, "scale", finiteNumber(point.scale));
    setIfDefined(out, "zeroCount", intLike(point.zeroCount));
    for (const side of ["positive", "negative"] as const) {
      const bucket = point[side];
      if (!isRecord(bucket)) continue;
      const counts = asArray(bucket.bucketCounts)
        .slice(0, MAX_HISTOGRAM_BUCKETS)
        .map(intLike)
        .filter((v): v is string | number => v !== undefined);
      const rebuilt: Record<string, unknown> = { bucketCounts: counts };
      setIfDefined(rebuilt, "offset", finiteNumber(bucket.offset));
      out[side] = rebuilt;
    }
    return out;
  }

  // summary
  const quantiles: Record<string, unknown>[] = [];
  for (const q of asArray(point.quantileValues).slice(0, MAX_SUMMARY_QUANTILES)) {
    if (!isRecord(q)) continue;
    const quantile = finiteNumber(q.quantile);
    const value = finiteNumber(q.value);
    if (quantile === undefined || value === undefined) continue;
    quantiles.push({ quantile, value });
  }
  if (quantiles.length > 0) out.quantileValues = quantiles;
  return out;
}

/**
 * Rebuild an OTLP metrics payload. Every data shape is walked — omitting
 * `exponentialHistogram` or `summary` silently exempts them from both the
 * attribute filter and the count — and each metric is reconstructed with only
 * the fields this function names. `description` is browser-controlled free
 * text on an allowlisted name and is not copied.
 */
function processMetrics(
  payload: Record<string, unknown>,
  ctx: RelayContext,
  limits: IngestLimits,
  report: ClampReport,
): Record<string, unknown> {
  const state: FilterState = { dropped: 0 };
  const metrics: Record<string, unknown>[] = [];
  let points = 0;

  for (const resourceMetrics of asArray(payload.resourceMetrics)) {
    if (!isRecord(resourceMetrics)) continue;
    for (const scopeMetrics of asArray(resourceMetrics.scopeMetrics)) {
      if (!isRecord(scopeMetrics)) continue;
      for (const metric of asArray(scopeMetrics.metrics)) {
        if (!isRecord(metric)) continue;
        if (
          typeof metric.name !== "string" ||
          !ALLOWED_METRIC_NAMES.has(metric.name)
        ) {
          state.dropped++;
          continue;
        }

        const rebuiltMetric: Record<string, unknown> = { name: metric.name };
        if (typeof metric.unit === "string" && ALLOWED_UNITS.has(metric.unit)) {
          rebuiltMetric.unit = metric.unit;
        }

        let kept = false;
        for (const shape of METRIC_SHAPES) {
          const body = metric[shape];
          if (!isRecord(body)) continue;
          const retained: unknown[] = [];
          for (const point of asArray(body.dataPoints)) {
            if (!isRecord(point)) continue;
            if (points >= limits.maxMetricDataPoints) {
              report.rejectedDataPoints++;
              continue;
            }
            retained.push(rebuildDataPoint(shape, point, ctx, state));
            points++;
          }
          if (retained.length === 0) continue;

          const rebuiltBody: Record<string, unknown> = { dataPoints: retained };
          // Temporality decides how the collector accumulates; DELTA (1) vs
          // CUMULATIVE (2) must survive the rebuild or every series is
          // misinterpreted.
          const temporality = body.aggregationTemporality;
          if (temporality === 1 || temporality === 2) {
            rebuiltBody.aggregationTemporality = temporality;
          }
          if (shape === "sum" && typeof body.isMonotonic === "boolean") {
            rebuiltBody.isMonotonic = body.isMonotonic;
          }
          rebuiltMetric[shape] = rebuiltBody;
          kept = true;
        }
        if (kept) metrics.push(rebuiltMetric);
      }
    }
  }

  report.droppedAttributes += state.dropped;
  return {
    resourceMetrics: [
      {
        resource: buildResource(ctx, false),
        scopeMetrics: [{ scope: { name: "@evalai/otel-web" }, metrics }],
      },
    ],
  };
}

/**
 * Validate, bound, and rebuild an inbound telemetry payload.
 *
 * Failure classes are separated because the OTLP JS exporter treats them
 * differently. Malformed input is **rejected** (400) — it is a client bug and
 * retrying will not help. Volume overage is **clamped** and reported, because
 * 400 and 413 are not retryable (`is-export-retryable.js` retries only
 * 429/502/503/504), so rejecting an oversize batch discards it permanently and
 * silently. Rate limiting belongs at the gateway, where a 429 carries
 * `Retry-After` and the SDK will actually back off.
 */
export function guardPayload(
  body: string,
  signal: string,
  ctx: RelayContext,
  limits: IngestLimits = DEFAULT_INGEST_LIMITS,
): GuardResult {
  if (!INGEST_SIGNALS.has(signal)) {
    return { ok: false, status: 404, reason: "unknown signal" };
  }

  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > limits.maxBodyBytes) {
    return {
      ok: false,
      status: 413,
      reason: `payload ${bytes}B exceeds limit ${limits.maxBodyBytes}B`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, reason: "payload is not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, status: 400, reason: "payload is not a JSON object" };
  }

  const report: ClampReport = {
    rejectedSpans: 0,
    rejectedDataPoints: 0,
    droppedAttributes: 0,
  };

  if (signal === "traces") {
    if (!Array.isArray(parsed.resourceSpans)) {
      return { ok: false, status: 400, reason: "expected resourceSpans" };
    }
    return {
      ok: true,
      payload: processTraces(parsed, ctx, limits, report),
      clamped: report,
    };
  }

  if (signal === "metrics") {
    if (!Array.isArray(parsed.resourceMetrics)) {
      return { ok: false, status: 400, reason: "expected resourceMetrics" };
    }
    return {
      ok: true,
      payload: processMetrics(parsed, ctx, limits, report),
      clamped: report,
    };
  }

  const errors = asArray(parsed.errors);
  if (errors.length > limits.maxErrors) {
    report.rejectedSpans = errors.length - limits.maxErrors;
    return {
      ok: true,
      payload: { errors: errors.slice(0, limits.maxErrors) },
      clamped: report,
    };
  }
  return { ok: true, payload: { errors }, clamped: report };
}
