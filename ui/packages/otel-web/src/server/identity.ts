// Pseudonymisation of the end-user identity for browser telemetry.
//
// ADR-26-05-19 defines the hashed end-user id ("hashed or pseudonymized by
// default"); since its 2026-07-16 amendment the canonical key is OTel's
// `user.hash`, with `enduser.id_hash` a deprecated alias this package does not
// emit. The hash is computed at the relay, never in the browser, for two
// reasons: the salt must not be shipped to a client, and the subject must come
// from the gateway-asserted `x-evalai-sub` header rather than anything the
// client can choose.
//
// ADR-26-07-21 is explicit that an **unsalted** `sha256(sub)` is "effectively a
// raw identity leak" because it is trivially rainbow-tableable. So the salt is
// mandatory: without one, no identity attribute is emitted at all. That is the
// same fail-safe posture the OTel agent takes — drop the field rather than
// emit a reversible one.

import { createHash } from "node:crypto";

/**
 * Salted SHA-256 of the subject, hex-encoded.
 *
 * Returns an empty string when either input is missing, and callers must omit
 * the attribute entirely in that case rather than emitting a placeholder.
 */
export function hashSubject(sub: string, salt: string): string {
  if (!sub || !salt) return "";
  return createHash("sha256").update(salt).update(sub).digest("hex");
}
