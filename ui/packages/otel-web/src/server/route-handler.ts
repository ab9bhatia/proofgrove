// The BFF telemetry relay.
//
// Browsers cannot reach `evalai-collector` — it is in-cluster and the Azure
// backends behind it are private-link only. Per ADR-26-08-12 the browser posts
// same-origin to this handler, which validates the payload and forwards it.
// The hop is what makes tenant attribution trustworthy: this pod knows its own
// namespace, so the relay synthesises the resource rather than trusting the
// client's.
//
// Traces and metrics are forwarded as OTLP. Client errors are not: the
// collector declares no logs pipeline, so errors are written as structured
// JSON to stdout and collected by the node-level OTel agent.

import {
  ATTR_BROWSER_SESSION_ID,
  ATTR_CTX_APP,
  ATTR_CTX_TENANT,
  ATTR_USER_HASH,
  ATTR_ERROR_TYPE,
  ATTR_EVENT_NAME,
  ATTR_HTTP_ROUTE,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  EVENT_BROWSER_ERROR,
} from "../attributes";
import { UNMATCHED_ROUTE, makeRouteMatcher } from "../routes";
import { sanitizeErrorType, sanitizeMessage, sanitizeStack } from "../sanitize";
import {
  DEFAULT_INGEST_LIMITS,
  guardPayload,
  type ClampReport,
  type IngestLimits,
  type RelayContext,
} from "./guard";
import { hashSubject } from "./identity";
import { parseUserAgent } from "./user-agent";

export const ENV_COLLECTOR_ENDPOINT = "OTEL_EXPORTER_OTLP_ENDPOINT";
export const ENV_POD_NAMESPACE = "POD_NAMESPACE";
/**
 * Per-tenant salt for `user.hash`. Optional by design: without it the
 * identity attribute is omitted rather than emitted unsalted, which
 * ADR-26-07-21 classifies as a raw identity leak.
 */
export const ENV_RUM_HASH_SALT = "EVALAI_RUM_HASH_SALT";
export const ENV_RUM_ENABLED = "EVALAI_RUM_ENABLED";
export const ENV_ENVIRONMENT = "DEPLOYMENT_ENVIRONMENT";
export const ENV_APP_VERSION = "APP_VERSION";

/** Header the gateway stamps on every authorised request. */
const HEADER_EVALAI_SUB = "x-evalai-sub";

const DEFAULT_COLLECTOR_TIMEOUT_MS = 2_000;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

export interface TelemetryHandlerOptions {
  /** `service.name` of the hosting app, e.g. `evalai-agent-ui`. */
  serviceName: string;
  /** `ctx.app` stamped on every record. */
  app: string;
  /** Next App Router templates, used to bound `http.route`. */
  routeTemplates: readonly string[];
  /** Overrides for the ingest ceilings. */
  limits?: IngestLimits;
  /**
   * Upper bound on the collector hop, milliseconds. The relay shares its
   * event loop and connection pool with the pages it serves, so a stalled
   * collector must fail this request quickly rather than accumulate pending
   * exports until an observability outage becomes a user-facing one.
   * Telemetry is discardable; the in-cluster hop is normally milliseconds.
   */
  collectorTimeoutMs?: number;
  /** Injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. Receives one structured JSON line. */
  logLine?: (line: string) => void;
}

/**
 * Derive the tenant slug from the pod's namespace.
 *
 * Tenant workloads run in `tenant-<slug>`. Anything else (the platform
 * namespace, local dev outside a cluster) yields an empty string, and the
 * relay then forwards without a tenant rather than guessing one.
 */
export function tenantFromNamespace(namespace: string | undefined): string {
  if (!namespace) return "";
  return namespace.startsWith("tenant-")
    ? namespace.slice("tenant-".length)
    : "";
}

/** Normalise `/api/telemetry/v1/traces` → `traces`. */
function signalFromSegments(segments: string[] | undefined): string {
  if (!segments || segments.length === 0) return "";
  return segments[segments.length - 1];
}

interface BrowserErrorRecord {
  message?: unknown;
  stack?: unknown;
  name?: unknown;
  route?: unknown;
  traceId?: unknown;
  sessionId?: unknown;
}

function isEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env[ENV_RUM_ENABLED] ?? "").toLowerCase() === "true";
}

/**
 * Reject cross-origin submissions.
 *
 * The OIDC cookies are `SameSite=Lax`, which is same-*site*, not same-*origin*
 * — a script on a sibling tenant origin can still drive this endpoint. Modern
 * browsers send `Sec-Fetch-Site`; when absent, fall back to `Origin`.
 *
 * Exported so other same-origin-authenticated BFF routes (e.g. the Proofgrove
 * mutating proxy) can reuse this exact check instead of re-deriving it.
 */
export function isSameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";

  const origin = request.headers.get("origin");
  if (!origin) return true; // sendBeacon on some browsers omits both
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/**
 * Read the body with a hard ceiling, without buffering the whole thing first.
 *
 * `await request.text()` materialises the entire payload before any size check
 * can run, so a single very large POST would exhaust the pod's heap. Returns
 * `null` when the cap is exceeded.
 */
async function readBounded(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared && Number.parseInt(declared, 10) > maxBytes) return null;

  const body = request.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Create the POST handler for `app/api/telemetry/[...signal]/route.ts`.
 *
 * Success is 200 with an OTLP-shaped `partialSuccess` body when anything was
 * clamped, and 204 when nothing was. Reporting the clamp is what keeps a
 * volume limit from becoming a silent blind spot.
 */
export function createTelemetryHandler(options: TelemetryHandlerOptions) {
  const {
    serviceName,
    app,
    routeTemplates,
    limits = DEFAULT_INGEST_LIMITS,
    collectorTimeoutMs = DEFAULT_COLLECTOR_TIMEOUT_MS,
    env = process.env,
    fetchImpl = fetch,
    logLine = (line: string) => console.log(line),
  } = options;

  const matchRoute = makeRouteMatcher(routeTemplates);
  const knownRoutes = new Set(routeTemplates);
  // A client-supplied route is only trusted if it is already a known template;
  // otherwise it is matched as a path, and failing that collapsed to the
  // sentinel. A browser must never mint a new label value.
  const normalizeRoute = (raw: string): string =>
    knownRoutes.has(raw) ? raw : matchRoute(raw);

  return async function POST(
    request: Request,
    context: { params: Promise<{ signal?: string[] }> },
  ): Promise<Response> {
    if (!isEnabled(env)) {
      return jsonError(503, "telemetry disabled");
    }
    const endpoint = env[ENV_COLLECTOR_ENDPOINT];
    if (!endpoint) {
      return jsonError(503, "telemetry not configured");
    }
    if (!isSameOrigin(request)) {
      return jsonError(403, "cross-origin telemetry rejected");
    }
    // Envoy replaces any client-supplied copy of this header on an allow
    // decision, so its presence is a reliable signal that the request came
    // through the gateway rather than straight at the pod.
    if (!request.headers.get(HEADER_EVALAI_SUB)) {
      return jsonError(401, "unauthenticated");
    }

    const { signal: segments } = await context.params;
    const signal = signalFromSegments(segments);

    const body = await readBounded(request, limits.maxBodyBytes);
    if (body === null) {
      return jsonError(413, "payload too large");
    }

    const ctx: RelayContext = {
      serviceName,
      serviceVersion: env[ENV_APP_VERSION] ?? "unknown",
      environment: env[ENV_ENVIRONMENT] ?? "unknown",
      app,
      emitterApp: "evalai",
      tenant: tenantFromNamespace(env[ENV_POD_NAMESPACE]),
      browser: parseUserAgent(request.headers.get("user-agent")),
      // Subject comes from the gateway-asserted header, never from the body:
      // Envoy replaces any client-supplied copy on an allow decision.
      userHash: hashSubject(
        request.headers.get(HEADER_EVALAI_SUB) ?? "",
        env[ENV_RUM_HASH_SALT] ?? "",
      ),
      normalizeRoute,
    };

    const guarded = guardPayload(body, signal, ctx, limits);
    if (!guarded.ok) {
      return jsonError(guarded.status, guarded.reason);
    }

    if (signal === "errors") {
      emitErrors(guarded.payload, ctx, normalizeRoute, logLine);
      return partialSuccess(guarded.clamped);
    }

    try {
      const upstream = await fetchImpl(
        `${endpoint.replace(/\/$/, "")}/v1/${signal}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(guarded.payload),
          signal: AbortSignal.timeout(collectorTimeoutMs),
        },
      );
      if (!upstream.ok) {
        // Log the upstream status, don't reflect it to the client.
        logLine(
          JSON.stringify({
            severity: "ERROR",
            [ATTR_EVENT_NAME]: "browser.relay.upstream_error",
            [ATTR_SERVICE_NAME]: serviceName,
            status: upstream.status,
          }),
        );
        return jsonError(502, "telemetry backend unavailable");
      }
    } catch {
      // Unreachable and stalled collectors land here alike (the abort above
      // rejects the fetch). Either way it is an observability outage, not a
      // user-facing one, and the SDK drops the batch.
      return jsonError(502, "telemetry backend unavailable");
    }

    return partialSuccess(guarded.clamped);
  };
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Report clamping in OTLP's own `partialSuccess` shape.
 *
 * The OTLP spec defines `partialSuccess` only on a 2xx, and the JS exporter
 * logs it as a warning — so the loss is visible on both ends instead of being
 * a silent gap.
 */
function partialSuccess(report: ClampReport): Response {
  const rejected = report.rejectedSpans + report.rejectedDataPoints;
  if (rejected === 0 && report.droppedAttributes === 0) {
    return new Response(null, { status: 204 });
  }
  return new Response(
    JSON.stringify({
      partialSuccess: {
        rejectedDataPoints: report.rejectedDataPoints,
        rejectedSpans: report.rejectedSpans,
        errorMessage: `dropped ${report.droppedAttributes} disallowed attributes`,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Write each browser error as one structured JSON line on stdout. */
function emitErrors(
  payload: Record<string, unknown>,
  ctx: RelayContext,
  normalizeRoute: (raw: string) => string,
  logLine: (line: string) => void,
): void {
  const records = Array.isArray(payload.errors) ? payload.errors : [];
  for (const raw of records) {
    const record = (raw ?? {}) as BrowserErrorRecord;

    const route =
      typeof record.route === "string"
        ? normalizeRoute(record.route)
        : UNMATCHED_ROUTE;
    const sessionId =
      typeof record.sessionId === "string" && UUID_PATTERN.test(record.sessionId)
        ? record.sessionId
        : "";
    const traceId =
      typeof record.traceId === "string" && TRACE_ID_PATTERN.test(record.traceId)
        ? record.traceId
        : "";

    const line: Record<string, unknown> = {
      severity: "ERROR",
      [ATTR_EVENT_NAME]: EVENT_BROWSER_ERROR,
      [ATTR_ERROR_TYPE]: sanitizeErrorType(record),
      message: sanitizeMessage(record.message),
      stack: sanitizeStack(record.stack),
      [ATTR_HTTP_ROUTE]: route,
      [ATTR_SERVICE_NAME]: ctx.serviceName,
      [ATTR_SERVICE_VERSION]: ctx.serviceVersion,
      [ATTR_CTX_APP]: ctx.app,
      "browser.name": ctx.browser.name,
      "browser.version": ctx.browser.version,
    };
    if (sessionId) line[ATTR_BROWSER_SESSION_ID] = sessionId;
    if (ctx.userHash) line[ATTR_USER_HASH] = ctx.userHash;
    if (ctx.tenant) line[ATTR_CTX_TENANT] = ctx.tenant;
    if (traceId) line.trace_id = traceId;
    logLine(JSON.stringify(line));
  }
}
