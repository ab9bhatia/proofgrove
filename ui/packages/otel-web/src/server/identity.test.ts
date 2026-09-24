import { describe, expect, it } from "vitest";
import { hashSubject } from "./identity";

const SUB = "8f14e45f-ceea-467a-9575-0305e82c3301";
const SALT = "a".repeat(64);

describe("hashSubject", () => {
  it("produces a hex sha-256 digest", () => {
    expect(hashSubject(SUB, SALT)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same subject and salt", () => {
    expect(hashSubject(SUB, SALT)).toBe(hashSubject(SUB, SALT));
  });

  it("differs per subject", () => {
    expect(hashSubject(SUB, SALT)).not.toBe(hashSubject("other-subject", SALT));
  });

  it("differs per salt, so the same person hashes differently across tenants", () => {
    expect(hashSubject(SUB, SALT)).not.toBe(hashSubject(SUB, "b".repeat(64)));
  });

  it("never returns the raw subject", () => {
    expect(hashSubject(SUB, SALT)).not.toContain(SUB);
  });

  it("returns empty without a salt, rather than an unsalted hash", () => {
    // ADR-26-07-21: an unsalted sha256(sub) is rainbow-tableable and therefore
    // a raw identity leak. Absence is the correct degraded state.
    expect(hashSubject(SUB, "")).toBe("");
    expect(hashSubject(SUB, undefined as unknown as string)).toBe("");
  });

  it("returns empty without a subject", () => {
    expect(hashSubject("", SALT)).toBe("");
  });
});
