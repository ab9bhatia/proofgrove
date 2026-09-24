import { NextResponse, type NextRequest } from "next/server";
import { decodeJwt } from "jose";

/**
 * Mint the `evalai_uid` cookie for stable per-browser session identity.
 *
 * In production (behind Envoy Gateway v1.7+ with forwardAccessToken: true),
 * the Authorization: Bearer header contains the raw Entra ID access token —
 * we extract the `sub` claim for use as the stable user id.
 *
 * In local dev (no Envoy), fall back to a random UUID so the app still works.
 *
 * The cookie is also written into `request.cookies` for the same request so
 * downstream route handlers see it immediately (otherwise the very first
 * request would 500 with `MissingUserIdError`).
 *
 * Each app re-exports this from its own `proxy.ts` so Next 16 picks it up.
 *
 * Also stamps document navigations with Cache-Control: no-store. These apps
 * sit behind Envoy Gateway's OIDC filter, which owns the session cookie
 * entirely (see resources_infra.go) — there is no app-level auth check.
 * Without no-store, browsers happily serve an authenticated page back out of
 * the disk cache or bfcache on Back/refresh, with no network round trip, so
 * a cleared session cookie never gets a chance to be noticed. no-store also
 * excludes the page from bfcache eligibility per spec, forcing Back/refresh
 * to hit the network and let Envoy re-validate. This is scoped to document
 * navigations (`Sec-Fetch-Dest: document`) only — the middleware matcher
 * already excludes `_next/static`/`_next/image`/`favicon.ico`, but it still
 * sees API routes, RSC data fetches, and other `/public` assets, and those
 * should keep their normal caching behavior.
 *
 * Also provides a best-effort redirect to `/` right after a fresh OIDC login.
 * The gateway session guard normally rewrites Envoy's saved return URL at the
 * successful callback, before this proxy runs. This check remains as a fallback
 * for environments that have not yet rolled out that Wasm module; it must not
 * be the primary signal because browsers can preserve the original page as the
 * Referer across the OIDC redirect chain.
 */

export const USER_COOKIE = "evalai_uid";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const AUTH_UI_HOST_PREFIX = "evalai-auth-ui.";
/** Identity ext_authz asserts on an allow decision — see shared/src/user.ts. */
const GATEWAY_SUBJECT_HEADER = "x-evalai-sub";

/**
 * Marks a response the browser must never reuse. Redirects that turn session
 * state over (an app's own middleware sending a de-authenticated browser to a
 * login or bootstrap screen) have to opt in explicitly — `mintUserCookie` only
 * stamps the document navigations it handles itself.
 */
export function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Pragma", "no-cache");
  return res;
}

/**
 * True for a top-level HTML document request (as opposed to an asset, API
 * call, or RSC data fetch that happens to route through this middleware).
 * `Sec-Fetch-Dest` is sent by every modern browser; the Accept-header check
 * is a fallback for the rare client that omits it.
 */
function isDocumentNavigation(req: NextRequest): boolean {
  const dest = req.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return (req.headers.get("accept") ?? "").includes("text/html");
}

/** True for the single top-level navigation that follows a fresh OIDC login. */
function justLoggedIn(req: NextRequest): boolean {
  if (req.method !== "GET") return false;
  if (req.nextUrl.pathname === "/") return false;
  if (req.headers.get("sec-fetch-mode") !== "navigate") {
    console.debug("[proxy] post-login redirect skipped: not a top-level navigation");
    return false;
  }
  const referer = req.headers.get("referer");
  if (!referer) {
    console.debug("[proxy] post-login redirect skipped: no Referer header");
    return false;
  }
  try {
    const isFromAuth = new URL(referer).hostname.startsWith(AUTH_UI_HOST_PREFIX);
    if (isFromAuth) {
      console.debug("[proxy] post-login redirect to / triggered", { referer });
    }
    return isFromAuth;
  } catch (err) {
    console.warn("[proxy] post-login redirect skipped: invalid Referer URL", { referer, err });
    return false;
  }
}

/**
 * @param baseRequestHeaders headers to forward to the render pass, defaulting
 * to the incoming ones. The security proxy passes the nonce headers in here;
 * forwarding them is the only way Next.js can stamp a nonce onto its scripts,
 * so every return path below goes through `NextResponse.next({ request })`.
 */
export function mintUserCookie(
  req: NextRequest,
  baseRequestHeaders?: Headers,
) {
  const home = justLoggedIn(req) ? NextResponse.redirect(new URL("/", req.url)) : null;
  const finalize = isDocumentNavigation(req) ? noStore : (res: NextResponse) => res;
  const forwarded = new Headers(baseRequestHeaders ?? req.headers);

  const existing = req.cookies.get(USER_COOKIE)?.value;
  const asserted = assertedSubject(req);

  // Keep the current id for as long as the gateway keeps vouching for the same
  // person — or, in local dev, for nobody at all. Re-mint the moment the
  // asserted identity changes: resetting a tenant's SSO swaps the credential
  // type outright (OIDC token → bootstrap magic link) and reconfiguring it can
  // swap the IDP, so a year-long cookie would otherwise pin the browser to a
  // session the platform has already invalidated.
  if (existing && (asserted === null || asserted === existing)) {
    return finalize(home ?? NextResponse.next({ request: { headers: forwarded } }));
  }

  const uid = asserted ?? mintFallbackId();
  const isSecure = req.nextUrl.protocol === "https:";

  // Make the new id visible to the in-flight request so handlers don't 500 —
  // and so a superseded id can't shadow it, since readers take the first match.
  const survivingCookies = (forwarded.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${USER_COOKIE}=`));
  forwarded.set("cookie", [...survivingCookies, `${USER_COOKIE}=${uid}`].join("; "));

  const res = finalize(home ?? NextResponse.next({ request: { headers: forwarded } }));
  res.cookies.set(USER_COOKIE, uid, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure,
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
  return res;
}

/**
 * Identity the gateway asserts for *this* request: the access token's `sub`
 * while the OIDC filter is active, otherwise the `x-evalai-sub` header
 * ext_authz sets on every allowed request. Null only when no gateway fronted
 * the request at all (local dev).
 */
function assertedSubject(req: NextRequest): string | null {
  return (
    extractSub(req.headers.get("authorization")) ??
    (req.headers.get(GATEWAY_SUBJECT_HEADER)?.trim() || null)
  );
}

function extractSub(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const claims = decodeJwt(authHeader.slice(7));
    return typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

function mintFallbackId(): string {
  const raw = crypto.randomUUID().replace(/-/g, "");
  return `user-${raw.slice(0, 10)}`;
}
