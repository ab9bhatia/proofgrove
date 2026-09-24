import { decodeJwt } from "jose";

export const BOOTSTRAP_PARAM = "_bootstrap";
export const BOOTSTRAP_COOKIE = "_bootstrap_token";
export const BOOTSTRAP_SCOPE = "bootstrap";
export const BOOTSTRAP_UI_APP = "evalai-tenant-ui";
/** Keep in sync with authz-service `_BOOTSTRAP_TENANT_MISMATCH_DETAIL`. */
export const BOOTSTRAP_TENANT_MISMATCH_DETAIL =
  "Bootstrap token is not valid for this tenant";

export interface ParsedAppHost {
  app: string;
  tenant: string;
}

/** Strip a trailing numeric port from a host header value. */
function stripNumericPort(host: string): string {
  return host.replace(/:\d+$/, "");
}

/**
 * Parse `<app>.<tenant>.<routingDomain>` from a Host header value (port optional).
 * Must stay aligned with authz-service `_HOSTNAME_PATTERN` / ROUTING_DOMAIN.
 */
export function parseAppHost(
  hostHeader: string,
  routingDomain: string,
): ParsedAppHost | null {
  const host = stripNumericPort(hostHeader.trim().toLowerCase());
  const domain = routingDomain.trim().toLowerCase();
  if (!host || !domain) return null;

  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return null;

  const prefix = host.slice(0, -suffix.length);
  const segments = prefix.split(".");
  if (segments.length !== 2) return null;
  const [app, tenant] = segments;
  if (!app || !tenant) return null;

  return { app, tenant };
}

/**
 * Result of an unsigned bootstrap JWT tenant check.
 *
 * - `match` — well-formed bootstrap JWT for the expected tenant, or no
 *   expected tenant (local dev; rely on ext_authz).
 * - `mismatch` — well-formed bootstrap JWT (`scope=bootstrap`, non-empty
 *   `tenant`) whose tenant claim differs from the expected tenant ID.
 * - `invalid` — not a well-formed bootstrap JWT (malformed, wrong scope,
 *   missing tenant). Callers should strip/clear and continue, not hard-deny.
 *
 * Signature verification remains the authz-service's responsibility.
 */
export type BootstrapTokenTenantCheck = "match" | "mismatch" | "invalid";

export function checkBootstrapTokenTenant(
  rawToken: string,
  expectedTenantId: string | undefined,
): BootstrapTokenTenantCheck {
  if (!expectedTenantId?.trim()) {
    // Local dev without gateway-injected tenant — rely on ext_authz only.
    return "match";
  }

  let payload: ReturnType<typeof decodeJwt>;
  try {
    payload = decodeJwt(rawToken);
  } catch {
    return "invalid";
  }

  const tenant = payload.tenant;
  const scope = payload.scope;
  if (typeof tenant !== "string" || !tenant) return "invalid";
  if (scope !== BOOTSTRAP_SCOPE) return "invalid";
  return tenant === expectedTenantId.trim() ? "match" : "mismatch";
}

/** True when {@link checkBootstrapTokenTenant} returns `match`. */
export function bootstrapTokenMatchesTenant(
  rawToken: string,
  expectedTenantId: string | undefined,
): boolean {
  return checkBootstrapTokenTenant(rawToken, expectedTenantId) === "match";
}
