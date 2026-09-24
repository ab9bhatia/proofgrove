/**
 * HTTP security response headers shared by every Proofgrove UI app.
 *
 * Closes VAPT finding #2721 ("Missing Security Headers") in two layers,
 * because the two kinds of header have different lifetimes:
 *
 * - `SECURITY_HEADERS` below is static and is wired into each app's
 *   `next.config.ts` `headers()`, so it covers *every* response including
 *   static assets and API routes.
 * - The `Content-Security-Policy` carries a per-request nonce, so it cannot
 *   be static. It is built by `buildContentSecurityPolicy()` and applied by
 *   the shared proxy in `./security-proxy`. Keeping it out of
 *   `SECURITY_HEADERS` is deliberate: emitting it in both places would put
 *   two `Content-Security-Policy` headers on the same response, and browsers
 *   enforce every policy they are sent, so the effective policy becomes the
 *   intersection of the two and stops being reviewable.
 *
 * Framing is still covered everywhere by `X-Frame-Options: DENY` here, and
 * reinforced on documents by `frame-ancestors 'none'` in the CSP.
 */
export interface SecurityHeader {
  key: string;
  value: string;
}

/**
 * One year, the common baseline.
 *
 * `includeSubDomains` is defence in depth here rather than broad coverage. Per
 * RFC 6797 the policy applies to the host that sent it and to hosts *beneath*
 * that host, not to siblings and not to the parent. Each app is served from
 * its own leaf host (`evalai-<app>-ui.<tenant>.<routing-domain>`), so this
 * directive does not reach the other app hosts; what covers each of them is
 * that each app sends the header itself. It is kept so any sub-host one of
 * these apps grows later is covered from the start.
 *
 * `preload` is deliberately omitted: submitting a domain to the browser
 * preload list is effectively irreversible on any useful timescale, and that
 * is a decision for the platform owners rather than a side effect of this
 * change.
 */
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains";

export const SECURITY_HEADERS: SecurityHeader[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: STRICT_TRANSPORT_SECURITY },
];

/**
 * Request header the middleware uses to hand the generated nonce to the React
 * render pass. Next.js separately reads the nonce back out of the
 * `Content-Security-Policy` *request* header to stamp its own bootstrap
 * `<script>` tags; this one exists so application code can nonce a script of
 * its own via `headers().get(NONCE_HEADER)` without re-parsing the policy.
 */
export const NONCE_HEADER = "x-nonce";

/**
 * 128 bits of CSPRNG output, base64-encoded — the floor the CSP spec
 * recommends, so a nonce cannot be guessed within the lifetime of a response.
 *
 * Uses Web Crypto and `btoa` rather than `node:crypto`/`Buffer` because
 * middleware runs on the Edge runtime, where those Node built-ins are absent.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

export interface ContentSecurityPolicyOptions {
  nonce: string;
  /**
   * Dev builds need two relaxations that must never reach a deployed
   * environment: React Fast Refresh evaluates code via `eval`, and the HMR
   * channel is a WebSocket. `upgrade-insecure-requests` is also dropped in
   * dev, because local development is served over plain HTTP on localhost and
   * upgrading those subresource requests to HTTPS would break the page.
   */
  isDevelopment?: boolean;
}

/**
 * Builds the per-request policy.
 *
 * `script-src 'self' 'nonce-…'` is the exact shape the issue asks for.
 * `'strict-dynamic'` is deliberately *not* used: it makes browsers ignore
 * `'self'`, so every Next.js chunk would then load only if the nonce
 * propagates correctly through the bootstrap script. Keeping `'self'`
 * authoritative for same-origin chunks costs little here — these apps serve
 * no user-supplied content from their own origin — and removes a whole class
 * of "passes CI, blank page in the browser" failure.
 *
 * `style-src` keeps `'unsafe-inline'` because it cannot be dropped today:
 * `next/font/google` emits an inline `@font-face` `<style>` block, and Radix
 * UI primitives plus the `Toaster` set inline `style` attributes at runtime.
 * Inline *styles* are a far weaker vector than inline scripts, and script
 * execution — the control this finding is actually about — stays strict.
 */
export function buildContentSecurityPolicy({
  nonce,
  isDevelopment = false,
}: ContentSecurityPolicyOptions): string {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`];
  const connectSrc = ["'self'"];

  if (isDevelopment) {
    scriptSrc.push("'unsafe-eval'");
    connectSrc.push("ws:", "wss:");
  }

  const directives: string[][] = [
    ["default-src", "'self'"],
    ["script-src", ...scriptSrc],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "blob:"],
    ["font-src", "'self'", "data:"],
    ["connect-src", ...connectSrc],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];

  if (!isDevelopment) {
    directives.push(["upgrade-insecure-requests"]);
  }

  return directives.map((directive) => directive.join(" ")).join("; ");
}
