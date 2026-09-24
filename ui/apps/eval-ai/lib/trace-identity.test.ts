import { describe, expect, it } from "vitest";
import { validSpanId, validTraceId } from "./trace-identity";

describe("recorded trace identity", () => {
  it("rejects disabled OTel sentinels and malformed identifiers", () => {
    for (const id of [null, undefined, "", "0".repeat(32), "trace-123", "g".repeat(32), "a".repeat(16), "a".repeat(33)]) expect(validTraceId(id)).toBeNull();
    for (const id of [null, "0".repeat(16), "span-1", "z".repeat(16)]) expect(validSpanId(id)).toBeNull();
  });
  it("preserves valid recorded identities without inventing replacements", () => {
    expect(validTraceId("0123456789abcdef0123456789abcdef")).toBe("0123456789abcdef0123456789abcdef");
    expect(validSpanId("0123456789abcdef")).toBe("0123456789abcdef");
  });
});
