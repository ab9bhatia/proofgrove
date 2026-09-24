import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { mintUserCookie, USER_COOKIE } from "./proxy";

function makeRequest(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    cookie?: string;
  } = {},
): NextRequest {
  const headers = new Headers(opts.headers);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return new NextRequest(url, { method: opts.method ?? "GET", headers });
}

const DOCUMENT_HEADERS = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };

describe("mintUserCookie", () => {
  it("stamps no-store on a document navigation", () => {
    const req = makeRequest("http://localhost/tenants", { headers: DOCUMENT_HEADERS });
    const res = mintUserCookie(req);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("does not stamp no-store on a non-document request (asset/API/RSC)", () => {
    const req = makeRequest("http://localhost/api/user", {
      headers: { "sec-fetch-dest": "empty" },
      cookie: `${USER_COOKIE}=existing`,
    });
    const res = mintUserCookie(req);
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("pragma")).toBeNull();
  });

  it("falls back to the Accept header when Sec-Fetch-Dest is absent", () => {
    const req = makeRequest("http://localhost/tenants", {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    const res = mintUserCookie(req);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("mints a fallback cookie when none is present", () => {
    const req = makeRequest("http://localhost/tenants", { headers: DOCUMENT_HEADERS });
    const res = mintUserCookie(req);
    expect(res.cookies.get(USER_COOKIE)?.value).toMatch(/^user-/);
  });

  it("passes through unchanged when the cookie already exists and it's not a post-login navigation", () => {
    const req = makeRequest("http://localhost/tenants", {
      headers: { ...DOCUMENT_HEADERS, referer: "https://evalai-platform-ui.example.com/tenants" },
      cookie: `${USER_COOKIE}=existing`,
    });
    const res = mintUserCookie(req);
    expect(res.status).not.toBe(307);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("redirects to / for the navigation immediately following an OIDC login", () => {
    const req = makeRequest("http://localhost/tenants/123", {
      headers: { ...DOCUMENT_HEADERS, referer: "https://evalai-auth-ui.example.com/callback" },
      cookie: `${USER_COOKIE}=existing`,
    });
    const res = mintUserCookie(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not redirect when already on / after login", () => {
    const req = makeRequest("http://localhost/", {
      headers: { ...DOCUMENT_HEADERS, referer: "https://evalai-auth-ui.example.com/callback" },
      cookie: `${USER_COOKIE}=existing`,
    });
    const res = mintUserCookie(req);
    expect(res.status).not.toBe(307);
  });

  it("does not redirect for a non-navigation request even with an auth Referer", () => {
    const req = makeRequest("http://localhost/tenants/123", {
      headers: { referer: "https://evalai-auth-ui.example.com/callback" },
      cookie: `${USER_COOKIE}=existing`,
    });
    const res = mintUserCookie(req);
    expect(res.status).not.toBe(307);
  });

  it("does not redirect when the Referer is not the auth UI", () => {
    const req = makeRequest("http://localhost/tenants/123", {
      headers: { ...DOCUMENT_HEADERS, referer: "https://evalai-platform-ui.example.com/somewhere" },
      cookie: `${USER_COOKIE}=existing`,
    });
    const res = mintUserCookie(req);
    expect(res.status).not.toBe(307);
  });

  it("does not redirect and does not throw on a malformed Referer", () => {
    const req = makeRequest("http://localhost/tenants/123", {
      headers: { ...DOCUMENT_HEADERS, referer: "not-a-valid-url" },
      cookie: `${USER_COOKIE}=existing`,
    });
    const res = mintUserCookie(req);
    expect(res.status).not.toBe(307);
  });

  // Issue #2742: a reset (or reconfigured) SSO swaps the credential behind a
  // browser that still holds a year-long cookie from the previous identity.
  it("re-mints the cookie when the gateway asserts a different subject", async () => {
    const req = makeRequest("http://localhost/", {
      headers: { ...DOCUMENT_HEADERS, "x-evalai-sub": "admin@corp.example" },
      cookie: `${USER_COOKIE}=stale-oidc-sub`,
    });
    const res = mintUserCookie(req);
    expect(res.cookies.get(USER_COOKIE)?.value).toBe("admin@corp.example");
  });

  it("re-mints the cookie when the access token carries a different sub", async () => {
    const token = await new SignJWT({ sub: "new-sub" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("test-secret"));
    const req = makeRequest("http://localhost/", {
      headers: { ...DOCUMENT_HEADERS, authorization: `Bearer ${token}` },
      cookie: `${USER_COOKIE}=old-sub`,
    });
    const res = mintUserCookie(req);
    expect(res.cookies.get(USER_COOKIE)?.value).toBe("new-sub");
  });

  it("keeps the cookie when the gateway asserts the same subject", () => {
    const req = makeRequest("http://localhost/", {
      headers: { ...DOCUMENT_HEADERS, "x-evalai-sub": "admin@corp.example" },
      cookie: `${USER_COOKIE}=admin@corp.example`,
    });
    const res = mintUserCookie(req);
    expect(res.cookies.get(USER_COOKIE)).toBeUndefined();
  });

  it("keeps the cookie when no gateway asserts an identity (local dev)", () => {
    const req = makeRequest("http://localhost/", {
      headers: DOCUMENT_HEADERS,
      cookie: `${USER_COOKIE}=user-abc123`,
    });
    const res = mintUserCookie(req);
    expect(res.cookies.get(USER_COOKIE)).toBeUndefined();
  });

  it("does not let a superseded id shadow the new one on the in-flight request", () => {
    const req = makeRequest("http://localhost/", {
      headers: { ...DOCUMENT_HEADERS, "x-evalai-sub": "admin@corp.example" },
      cookie: `${USER_COOKIE}=stale-oidc-sub; other=keep`,
    });
    const res = mintUserCookie(req);
    const forwarded = res.headers.get("x-middleware-override-headers") ?? "";
    expect(forwarded).toContain("cookie");
    const cookie = res.headers.get("x-middleware-request-cookie") ?? "";
    expect(cookie).toBe(`other=keep; ${USER_COOKIE}=admin@corp.example`);
  });
});
