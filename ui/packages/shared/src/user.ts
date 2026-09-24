import "server-only";
import { decodeJwt } from "jose";

/**
 * Current-user resolution for evalai BFFs.
 *
 * Envoy Gateway v1.7+ with `forwardAccessToken: true` forwards the raw Entra
 * ID access token as "Authorization: Bearer <token>" to the upstream BFF.
 * Envoy has already validated the token's signature and expiry before
 * forwarding, so we only need to decode (not verify) the JWT here.
 *
 * Claims used:
 *   given_name          → firstName
 *   family_name         → lastName
 *   email / upn         → email address surfaced to kagent as X-User-ID
 *   preferred_username  → email fallback
 *   sub                 → stable user id (used for evalai_uid cookie)
 *
 * When no access token is forwarded, identity falls back to the
 * `x-evalai-sub` header the authz-service sets on every allowed request.
 * Only a request that never passed a gateway (local dev) resolves to nothing.
 */

export const USER_COOKIE = "evalai_uid";
export const USER_EMAIL_DOMAIN = "local.evalai";

/**
 * Identity asserted by ext_authz on an allow decision, forwarded to the app via
 * `SecurityPolicy.HeadersToBackend`. Envoy replaces any same-named header the
 * client sent, so it cannot be spoofed. It carries the access token's `sub` in
 * OIDC mode and the bootstrap admin's email in bootstrap mode.
 */
export const GATEWAY_SUBJECT_HEADER = "x-evalai-sub";

export interface ResolvedUser {
  firstName: string;
  lastName: string;
  /**
   * Address of the signed-in user, or "" when nothing identified them. Callers
   * render this when there is no display name — a tenant in bootstrap mode
   * (e.g. straight after a platform admin resets SSO) has no OIDC token to
   * carry given/family names, but ext_authz still names the caller.
   */
  email: string;
}

export interface ResolvedUserId {
  id: string;
  email: string;
}

interface EntraClaims {
  sub?: string;
  /** Full display name — always present in Entra ID tokens. */
  name?: string;
  /** Not always present; depends on optional claims config on the app registration. */
  given_name?: string;
  family_name?: string;
  email?: string;
  upn?: string;
  preferred_username?: string;
}

function decodeBearer(req: Request): EntraClaims | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    return decodeJwt(auth.slice(7)) as EntraClaims;
  } catch {
    return null;
  }
}

/** Removes parenthetical annotations added by AD admins, e.g. "(E)" or "(Contractor)". */
function stripAnnotations(name: string): string {
  return name.replace(/\s*\([^)]*\)/g, "").trim();
}

export function resolveUser(req: Request): ResolvedUser {
  const claims = decodeBearer(req);
  const email = emailFromClaims(claims) || gatewayEmail(req);

  // Prefer explicit given_name/family_name if the app registration emits them.
  // Fall back to splitting the full `name` claim (always present in Entra ID).
  if (claims?.given_name || claims?.family_name) {
    return {
      firstName: stripAnnotations(claims.given_name?.trim() ?? ""),
      lastName: stripAnnotations(claims.family_name?.trim() ?? ""),
      email,
    };
  }

  const fullName = stripAnnotations(claims?.name?.trim() ?? "");
  const spaceIdx = fullName.lastIndexOf(" ");
  return spaceIdx > 0
    ? { firstName: fullName.slice(0, spaceIdx), lastName: fullName.slice(spaceIdx + 1), email }
    : { firstName: fullName, lastName: "", email };
}

function emailFromClaims(claims: EntraClaims | null): string {
  return (
    claims?.email?.trim() ||
    claims?.upn?.trim() ||
    claims?.preferred_username?.trim() ||
    ""
  );
}

/**
 * Address of the caller ext_authz vouched for, when no access token was
 * forwarded. Non-address subjects (an opaque OIDC `sub`) are ignored — they are
 * not something to show a human, and in OIDC mode the token is present anyway.
 */
function gatewayEmail(req: Request): string {
  const sub = req.headers.get(GATEWAY_SUBJECT_HEADER)?.trim() ?? "";
  return sub.includes("@") ? sub : "";
}

export class MissingUserIdError extends Error {
  constructor() {
    super(
      `request is missing the ${USER_COOKIE} cookie — middleware must mint one before any BFF route runs`,
    );
    this.name = "MissingUserIdError";
  }
}

export function resolveUserId(req: Request): ResolvedUserId {
  const id = readCookie(req.headers.get("cookie"), USER_COOKIE);
  if (!id) throw new MissingUserIdError();

  const claims = decodeBearer(req);
  const email = emailFromClaims(claims) || `${id}@${USER_EMAIL_DOMAIN}`;

  return { id, email };
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
