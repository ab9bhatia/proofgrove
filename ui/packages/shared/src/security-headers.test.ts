import { describe, expect, it } from "vitest";
import {
  NONCE_HEADER,
  SECURITY_HEADERS,
  STRICT_TRANSPORT_SECURITY,
  buildContentSecurityPolicy,
  generateNonce,
} from "./security-headers";

describe("SECURITY_HEADERS", () => {
  function valueFor(key: string): string | undefined {
    return SECURITY_HEADERS.find((h) => h.key === key)?.value;
  }

  it("sets X-Content-Type-Options to nosniff", () => {
    expect(valueFor("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets Referrer-Policy to strict-origin-when-cross-origin", () => {
    expect(valueFor("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("sets X-Frame-Options to DENY", () => {
    expect(valueFor("X-Frame-Options")).toBe("DENY");
  });

  it("sets HSTS to one year including subdomains", () => {
    expect(valueFor("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(STRICT_TRANSPORT_SECURITY).toBe(valueFor("Strict-Transport-Security"));
  });

  it("does not preload HSTS, which is effectively irreversible", () => {
    expect(STRICT_TRANSPORT_SECURITY).not.toContain("preload");
  });

  it("does not carry a Content-Security-Policy, which the middleware owns", () => {
    // Emitting it here too would put two CSP headers on every document and
    // browsers enforce both, making the effective policy their intersection.
    expect(valueFor("Content-Security-Policy")).toBeUndefined();
  });

  it("has no duplicate header keys", () => {
    const keys = SECURITY_HEADERS.map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("generateNonce", () => {
  it("returns valid base64", () => {
    expect(generateNonce()).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("carries 128 bits of entropy", () => {
    expect(atob(generateNonce())).toHaveLength(16);
  });

  it("does not repeat across a large sample", () => {
    const nonces = new Set(Array.from({ length: 1000 }, generateNonce));
    expect(nonces.size).toBe(1000);
  });
});

describe("buildContentSecurityPolicy", () => {
  function directives(csp: string): Map<string, string> {
    return new Map(
      csp.split("; ").map((directive) => {
        const [name, ...values] = directive.split(" ");
        return [name, values.join(" ")];
      }),
    );
  }

  const production = buildContentSecurityPolicy({ nonce: "test-nonce" });
  const development = buildContentSecurityPolicy({
    nonce: "test-nonce",
    isDevelopment: true,
  });

  it("matches the policy shape the finding asks for", () => {
    const d = directives(production);
    expect(d.get("default-src")).toBe("'self'");
    expect(d.get("script-src")).toBe("'self' 'nonce-test-nonce'");
    expect(d.get("object-src")).toBe("'none'");
    expect(d.get("frame-ancestors")).toBe("'none'");
  });

  it("locks down base-uri and form-action", () => {
    const d = directives(production);
    expect(d.get("base-uri")).toBe("'self'");
    expect(d.get("form-action")).toBe("'self'");
  });

  it("never allows inline or eval'd script in production", () => {
    const scriptSrc = directives(production).get("script-src") ?? "";
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("keeps 'self' authoritative by not using strict-dynamic", () => {
    // 'strict-dynamic' makes browsers ignore 'self', so Next.js chunks would
    // load only while nonce propagation stays intact. See module doc comment.
    expect(production).not.toContain("strict-dynamic");
  });

  it("allows inline style, which next/font and Radix require", () => {
    expect(directives(production).get("style-src")).toBe("'self' 'unsafe-inline'");
  });

  it("upgrades insecure requests in production only", () => {
    expect(production).toContain("upgrade-insecure-requests");
    expect(development).not.toContain("upgrade-insecure-requests");
  });

  it("relaxes eval and websockets for dev tooling only", () => {
    const dev = directives(development);
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.get("connect-src")).toBe("'self' ws: wss:");

    const prod = directives(production);
    expect(prod.get("connect-src")).toBe("'self'");
  });

  it("embeds the nonce it is given", () => {
    const nonce = generateNonce();
    expect(buildContentSecurityPolicy({ nonce })).toContain(`'nonce-${nonce}'`);
  });
});

describe("NONCE_HEADER", () => {
  it("is lowercase so Headers lookups match", () => {
    expect(NONCE_HEADER).toBe(NONCE_HEADER.toLowerCase());
  });
});
