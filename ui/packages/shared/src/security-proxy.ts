import { NextResponse, type NextRequest } from "next/server";

import {
  NONCE_HEADER,
  buildContentSecurityPolicy,
  generateNonce,
} from "./security-headers";

/**
 * A Next 16 proxy handler that has been handed the request headers the
 * security layer wants forwarded.
 *
 * The second argument exists because of how Next.js nonces work: the *only*
 * way to change what the render pass sees is to pass headers through
 * `NextResponse.next({ request: { headers } })`. A handler that builds its own
 * response therefore has to start from these headers rather than from
 * `request.headers`, or the nonce is silently dropped.
 */
export type SecureProxyHandler = (
  request: NextRequest,
  requestHeaders: Headers,
) => NextResponse;

/** Handler for apps whose proxy exists only to apply security headers. */
export function passThrough(
  _request: NextRequest,
  requestHeaders: Headers,
): NextResponse {
  return NextResponse.next({ request: { headers: requestHeaders } });
}

/**
 * Wraps an app's proxy so every response carries a per-request, nonce-based
 * `Content-Security-Policy`.
 *
 * The nonce mechanism is indirect and easy to break, so it is worth stating
 * plainly: Next.js discovers the nonce by reading the
 * `Content-Security-Policy` header off the *request*, not from any API call.
 * Setting it on `requestHeaders` below is what makes Next.js stamp
 * `nonce="…"` onto its own bootstrap `<script>` tags. Remove that line and the
 * policy still looks correct to `curl -I`, while every script on the page is
 * blocked in a real browser.
 *
 * Handlers that short-circuit with a redirect or an error (tenant-ui's
 * bootstrap guard) never reach the renderer, so the nonce is irrelevant to
 * them — but they still get the response header, which keeps the policy
 * uniform across every response the proxy can produce.
 *
 * The static headers (`X-Content-Type-Options`, `Referrer-Policy`,
 * `X-Frame-Options`, `Strict-Transport-Security`) are not set here — they come
 * from `next.config.ts` so they also cover responses this proxy never sees,
 * such as static assets.
 */
export function withSecurityHeaders(
  request: NextRequest,
  handler: SecureProxyHandler = passThrough,
): NextResponse {
  const nonce = generateNonce();
  const contentSecurityPolicy = buildContentSecurityPolicy({
    nonce,
    isDevelopment: process.env.NODE_ENV === "development",
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  const response = handler(request, requestHeaders);
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);

  return response;
}
