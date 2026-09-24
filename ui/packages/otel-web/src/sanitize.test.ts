import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_CHARS,
  MAX_STACK_FRAMES,
  sanitizeErrorType,
  sanitizeMessage,
  sanitizeStack,
} from "./sanitize";

describe("sanitizeMessage", () => {
  it("passes through an ordinary message", () => {
    expect(sanitizeMessage("Cannot read property 'id' of undefined")).toBe(
      "Cannot read property 'id' of undefined",
    );
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl";
    const out = sanitizeMessage(`token rejected: ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("[redacted]");
  });

  it("redacts a bearer token", () => {
    const out = sanitizeMessage("Authorization: Bearer abc123.def-456");
    expect(out).not.toContain("abc123.def-456");
  });

  it("redacts email addresses", () => {
    const out = sanitizeMessage("login failed for alice@example.com");
    expect(out).not.toContain("alice@example.com");
  });

  it("redacts sensitive query parameters but keeps the parameter name", () => {
    const out = sanitizeMessage("GET /cb?code=SECRETVALUE&state=xyz failed");
    expect(out).not.toContain("SECRETVALUE");
    expect(out).toContain("code=");
    expect(out).toContain("state=xyz");
  });

  it("bounds an unbounded message", () => {
    const out = sanitizeMessage("x".repeat(50_000));
    expect(out.length).toBeLessThan(MAX_MESSAGE_CHARS + 32);
  });

  it("keeps Error messages but never serialises arbitrary thrown objects", () => {
    expect(sanitizeMessage(new Error("boom"))).toBe("Error: boom");
    // The object at the point of failure may hold prompt or document content,
    // so only its type is recorded.
    expect(sanitizeMessage({ prompt: "customer confidential text" })).toBe(
      "[Object]",
    );
  });

  it("redacts GUIDs, which are Entra subject identifiers", () => {
    const out = sanitizeMessage("user 3f2504e0-4f89-11d3-9a0c-0305e82c3301 denied");
    expect(out).not.toContain("3f2504e0");
    expect(out).toContain("[redacted]");
  });

  it("redacts tokens in a URL fragment, not just a query string", () => {
    const out = sanitizeMessage("redirect #access_token=SECRETVALUE&state=x");
    expect(out).not.toContain("SECRETVALUE");
  });

  it("redacts long opaque high-entropy blobs", () => {
    const out = sanitizeMessage(`session ${"A1b2C3d4".repeat(6)} expired`);
    expect(out).toContain("[redacted]");
  });

  it("survives cyclic input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => sanitizeMessage(cyclic)).not.toThrow();
  });

  it("returns empty string for nullish input", () => {
    expect(sanitizeMessage(null)).toBe("");
    expect(sanitizeMessage(undefined)).toBe("");
  });
});

describe("sanitizeStack", () => {
  it("keeps only the top frames", () => {
    const stack = Array.from({ length: 100 }, (_, i) => `  at fn${i} (a.js:1)`).join("\n");
    const out = sanitizeStack(stack);
    expect(out.split("\n").length).toBeLessThanOrEqual(MAX_STACK_FRAMES);
    expect(out).toContain("fn0");
    expect(out).not.toContain("fn99");
  });

  it("redacts tokens embedded in stack URLs", () => {
    const out = sanitizeStack("  at load (https://app/x.js?access_token=LEAK)");
    expect(out).not.toContain("LEAK");
  });

  it("returns empty string for a missing stack", () => {
    expect(sanitizeStack(undefined)).toBe("");
  });
});

describe("sanitizeErrorType", () => {
  it("uses the error name", () => {
    expect(sanitizeErrorType(new TypeError("x"))).toBe("TypeError");
  });

  it("falls back to Error for exotic throws", () => {
    expect(sanitizeErrorType("just a string")).toBe("Error");
  });

  it("strips characters that would break grouping", () => {
    expect(sanitizeErrorType({ name: "Bad Name\n{}" })).toBe("BadName");
  });
});
