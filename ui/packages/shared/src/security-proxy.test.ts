import { NextRequest, NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintUserCookie, USER_COOKIE } from "./proxy";
import { passThrough, withSecurityHeaders } from "./security-proxy";

function request(url = "https://evalai-platform-ui.example.test/tenants") {
  return new NextRequest(new Request(url));
}

/**
 * `NextResponse.next({ request: { headers } })` encodes the rewritten request
 * headers onto the response for the Next.js server to unpack: the names go in
 * `x-middleware-override-headers` and each value in `x-middleware-request-*`.
 * Asserting on that encoding is deliberate — it is the only observable proof
 * that the nonce reaches the render pass, which is what makes Next.js stamp
 * `nonce="…"` onto its bootstrap scripts.
 */
function forwardedRequestHeader(
  response: NextResponse,
  name: string,
): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

describe("withSecurityHeaders", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets a nonce-based Content-Security-Policy on the response", () => {
    const csp = withSecurityHeaders(request()).headers.get(
      "Content-Security-Policy",
    );

    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
  });

  it("forwards the policy on the request so Next.js can read the nonce", () => {
    const response = withSecurityHeaders(request());

    expect(forwardedRequestHeader(response, "content-security-policy")).toBe(
      response.headers.get("Content-Security-Policy"),
    );
  });

  it("forwards the nonce on x-nonce for application code", () => {
    const response = withSecurityHeaders(request());
    const nonce = forwardedRequestHeader(response, "x-nonce");

    expect(nonce).toBeTruthy();
    expect(response.headers.get("Content-Security-Policy")).toContain(
      `'nonce-${nonce}'`,
    );
  });

  it("mints a fresh nonce per request", () => {
    const first = withSecurityHeaders(request());
    const second = withSecurityHeaders(request());

    expect(first.headers.get("Content-Security-Policy")).not.toBe(
      second.headers.get("Content-Security-Policy"),
    );
  });

  it("hands the security headers to the wrapped handler", () => {
    const handler = vi.fn(passThrough);
    withSecurityHeaders(request(), handler);

    const [, requestHeaders] = handler.mock.calls[0];
    expect(requestHeaders.get("x-nonce")).toBeTruthy();
    expect(requestHeaders.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
  });

  it("preserves incoming request headers", () => {
    const incoming = new NextRequest(
      new Request("https://evalai-platform-ui.example.test/", {
        headers: { cookie: "session=abc" },
      }),
    );

    expect(
      forwardedRequestHeader(withSecurityHeaders(incoming), "cookie"),
    ).toBe("session=abc");
  });

  it("still sets the policy when the handler short-circuits", () => {
    // tenant-ui's bootstrap guard answers with redirects and a 403 that never
    // reach the renderer; the policy must stay uniform across those too.
    const redirect = withSecurityHeaders(request(), () =>
      NextResponse.redirect("https://evalai-tenant-ui.example.test/sso"),
    );

    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("does not overwrite a handler's own response headers", () => {
    const response = withSecurityHeaders(request(), (_req, headers) => {
      const res = passThrough(_req, headers);
      res.headers.set("Cache-Control", "no-store");
      return res;
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("does not relax the policy outside development", () => {
    const csp =
      withSecurityHeaders(request()).headers.get("Content-Security-Policy") ??
      "";

    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("relaxes the policy for the dev server only", () => {
    vi.stubEnv("NODE_ENV", "development");

    const csp =
      withSecurityHeaders(request()).headers.get("Content-Security-Policy") ??
      "";

    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("leaves the static headers to next.config", () => {
    const response = withSecurityHeaders(request());

    expect(response.headers.get("Strict-Transport-Security")).toBeNull();
    expect(response.headers.get("X-Frame-Options")).toBeNull();
  });
});

/**
 * The real wiring used by agent-ui and platform-ui, and by tenant-ui once its
 * bootstrap guard falls through.
 *
 * These assertions are the regression guard for the load-bearing part of the
 * whole change. `mintUserCookie` has several return paths, and each one has to
 * build its response from the headers the security layer handed it. If any of
 * them goes back to a bare `NextResponse.next()`, the nonce never reaches the
 * render pass, Next.js stops stamping `nonce="…"` onto its inline bootstrap
 * scripts, and the app loads but never hydrates in a real browser. The
 * response still carries a perfectly valid-looking policy, so nothing else
 * here would fail.
 */
describe("withSecurityHeaders + mintUserCookie", () => {
  const DOCUMENT_HEADERS = {
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
  };

  function documentRequest(
    opts: { headers?: Record<string, string>; cookie?: string } = {},
  ): NextRequest {
    const headers = new Headers({ ...DOCUMENT_HEADERS, ...opts.headers });
    if (opts.cookie) headers.set("cookie", opts.cookie);
    return new NextRequest("https://evalai-platform-ui.example.test/tenants", {
      headers,
    });
  }

  /** The nonce the response advertises must be the one the renderer receives. */
  function expectNonceReachesRenderPass(response: NextResponse): void {
    const policy = response.headers.get("Content-Security-Policy");
    expect(policy).toContain("default-src 'self'");

    expect(forwardedRequestHeader(response, "content-security-policy")).toBe(
      policy,
    );

    const nonce = forwardedRequestHeader(response, "x-nonce");
    expect(nonce).toBeTruthy();
    expect(policy).toContain(`'nonce-${nonce}'`);
  }

  it("forwards the nonce when the user already has a cookie", () => {
    const response = withSecurityHeaders(
      documentRequest({ cookie: `${USER_COOKIE}=existing` }),
      mintUserCookie,
    );

    expect(response.cookies.get(USER_COOKIE)).toBeUndefined();
    expectNonceReachesRenderPass(response);
  });

  it("forwards the nonce when it mints a cookie for a new visitor", () => {
    const response = withSecurityHeaders(documentRequest(), mintUserCookie);

    expect(response.cookies.get(USER_COOKIE)?.value).toMatch(/^user-/);
    expectNonceReachesRenderPass(response);
  });

  it("forwards the nonce when the gateway asserts a different subject", () => {
    const response = withSecurityHeaders(
      documentRequest({
        headers: { "x-evalai-sub": "admin@corp.example" },
        cookie: `${USER_COOKIE}=stale-oidc-sub; other=keep`,
      }),
      mintUserCookie,
    );

    expect(response.cookies.get(USER_COOKIE)?.value).toBe("admin@corp.example");
    expectNonceReachesRenderPass(response);
    // The re-mint path rewrites the forwarded cookie; that must not clobber
    // the nonce headers sitting alongside it.
    expect(forwardedRequestHeader(response, "cookie")).toBe(
      `other=keep; ${USER_COOKIE}=admin@corp.example`,
    );
  });

  it("keeps the incoming request headers alongside the nonce", () => {
    const response = withSecurityHeaders(
      documentRequest({
        headers: { "accept-language": "en-GB" },
        cookie: `${USER_COOKIE}=existing`,
      }),
      mintUserCookie,
    );

    expect(forwardedRequestHeader(response, "accept-language")).toBe("en-GB");
    expectNonceReachesRenderPass(response);
  });

  it("still sets the policy on the post-login redirect, which never renders", () => {
    const response = withSecurityHeaders(
      documentRequest({
        headers: { referer: "https://evalai-auth-ui.example.test/callback" },
        cookie: `${USER_COOKIE}=existing`,
      }),
      mintUserCookie,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("does not reuse a nonce across requests", () => {
    const forCookie = (cookie: string) =>
      forwardedRequestHeader(
        withSecurityHeaders(documentRequest({ cookie }), mintUserCookie),
        "x-nonce",
      );

    expect(forCookie(`${USER_COOKIE}=a`)).not.toBe(
      forCookie(`${USER_COOKIE}=b`),
    );
  });
});
