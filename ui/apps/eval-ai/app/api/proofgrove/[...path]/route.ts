import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isSameOrigin } from "@evalai/otel-web/server";
import {
  publicApiError,
  publicApiErrorFromUpstream,
  type PublicApiErrorBody,
} from "@/lib/api-errors";
import { proofgroveBaseUrl } from "@/lib/proofgrove";
import { resolveTenant, TenantContextError } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ path: string[] }> };

// The first path segment every `@/lib/*` request helper actually calls
// through this proxy (grepped across api.ts, run-history.ts,
// review-collab.ts, and dataset-generation.ts — `/tenant` also resolves via
// the sibling static route at app/api/proofgrove/tenant/route.ts, kept here as
// defence in depth). This doubles as the allowlist gate below: an unknown
// first segment (e.g. Proofgrove's own `/docs`, `/redoc`, `/openapi.json`) is
// rejected before any upstream fetch, so those FastAPI pages can never be
// proxied onto this origin.
const RESOURCE_NAMES = new Set([
  "agents",
  "datasets",
  "evaluation",
  "platform",
  "tenant",
  "tracing",
]);

function requestResource(path: string[]): string {
  return RESOURCE_NAMES.has(path[0] ?? "") ? path[0] : "unknown";
}

// Next hands the catch-all segments already percent-decoded, so `%2e%2e`
// arrives as `..`; `encodeURIComponent` leaves dots alone, and the upstream
// URL parser then collapses `datasets/../docs` back into `/docs`, walking out
// of the allowlisted prefix. A segment can only be a literal path element:
// non-empty, not `.` or `..`, and never carrying a separator of its own.
function hasLiteralSegments(path: string[]): boolean {
  return path.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".." && !/[\/\\]/.test(segment),
  );
}

function errorResponse(
  status: number,
  requestId: string,
  body?: PublicApiErrorBody,
  additionalHeaders?: Record<string, string>,
): NextResponse {
  return NextResponse.json(body ?? publicApiError(status, requestId), {
    status,
    headers: {
      "cache-control": "no-store",
      "x-request-id": requestId,
      ...additionalHeaders,
    },
  });
}

function logProxyFailure(fields: {
  requestId: string;
  method: string;
  resource: string;
  status: number;
  durationMs: number;
  event: "proofgrove_proxy_rejected" | "proofgrove_proxy_unavailable";
}) {
  // Deliberately omit URL, query, request/response body, tenant, and resource
  // identifiers. Evaluation payloads must never enter frontend telemetry.
  console.error(
    JSON.stringify({
      severity: fields.status >= 500 ? "ERROR" : "WARN",
      event: fields.event,
      request_id: fields.requestId,
      method: fields.method,
      resource: fields.resource,
      status: fields.status,
      duration_ms: fields.durationMs,
    }),
  );
}

/**
 * Server-side BFF proxy for Proofgrove.
 *
 * The backend address and tenant authority stay server-side. Only a small
 * header allowlist is forwarded, raw upstream failures are never reflected to
 * the browser, and evaluation payloads are never written to logs.
 */
export async function proxy(req: Request, ctx: Ctx): Promise<Response> {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const { path } = await ctx.params;
  const resource = requestResource(path);

  if (resource === "unknown" || !hasLiteralSegments(path)) {
    return errorResponse(404, requestId);
  }

  // Same-origin check for every mutating method. The Proofgrove UI cookie is
  // `SameSite=Lax` (same-*site*, not same-*origin*) so a page on a sibling
  // origin under the same registrable domain can still drive a body-less
  // cross-origin POST/PUT/PATCH/DELETE here with the victim's cookies
  // attached. Reuses the exact check the telemetry relay already applies
  // (`@evalai/otel-web/server`'s `isSameOrigin`) rather than re-deriving it.
  if (req.method !== "GET" && req.method !== "HEAD" && !isSameOrigin(req)) {
    return errorResponse(403, requestId);
  }

  let tenant: string;
  try {
    tenant = resolveTenant();
  } catch (error) {
    if (!(error instanceof TenantContextError)) throw error;
    logProxyFailure({
      requestId,
      method: req.method,
      resource,
      status: 503,
      durationMs: Math.round(performance.now() - startedAt),
      event: "proofgrove_proxy_unavailable",
    });
    return errorResponse(503, requestId);
  }

  const search = new URL(req.url).search;
  const target = `${proofgroveBaseUrl()}/${path.map(encodeURIComponent).join("/")}${search}`;
  const headers = new Headers({
    accept: req.headers.get("accept") ?? "application/json",
    "x-evalai-tenant": tenant.slice("tenant-".length),
    "x-request-id": requestId,
  });
  // Envoy replaces this header from the external request with the authenticated
  // subject before the BFF is reached. Carry it over the direct ClusterIP hop
  // so Proofgrove can keep Phoenix-style per-client rate-limit buckets.
  const subject = req.headers.get("x-evalai-sub");
  if (subject) headers.set("x-evalai-sub", subject);
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const traceparent = req.headers.get("traceparent");
  if (traceparent) headers.set("traceparent", traceparent);
  const tracestate = req.headers.get("tracestate");
  if (tracestate) headers.set("tracestate", tracestate);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const init: RequestInit = {
    method: req.method,
    headers,
    cache: "no-store",
    ...(hasBody ? { body: await req.arrayBuffer() } : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    logProxyFailure({
      requestId,
      method: req.method,
      resource,
      status: 502,
      durationMs: Math.round(performance.now() - startedAt),
      event: "proofgrove_proxy_unavailable",
    });
    return errorResponse(502, requestId);
  }

  if (!upstream.ok) {
    // Read the body only to derive the bounded problem contract. Raw upstream
    // failures (SQL, stack traces, endpoints, evaluation payloads) are never
    // reflected: only allowlisted, truncated fields from FastAPI's `detail`
    // envelope pass through; anything else keeps the generic status copy.
    const failureBody = await upstream.text().catch(() => "");
    logProxyFailure({
      requestId,
      method: req.method,
      resource,
      status: upstream.status,
      durationMs: Math.round(performance.now() - startedAt),
      event: "proofgrove_proxy_rejected",
    });
    return errorResponse(
      upstream.status,
      requestId,
      publicApiErrorFromUpstream(upstream.status, failureBody, requestId),
      upstream.status === 429 && upstream.headers.get("retry-after")
        ? { "retry-after": upstream.headers.get("retry-after")! }
        : undefined,
    );
  }

  const responseHeaders = new Headers({
    "cache-control": "no-store",
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "x-request-id": requestId,
  });
  const contentDisposition = upstream.headers.get("content-disposition");
  if (contentDisposition) responseHeaders.set("content-disposition", contentDisposition);

  const body = upstream.status === 204 ? null : await upstream.arrayBuffer();
  return new NextResponse(body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
