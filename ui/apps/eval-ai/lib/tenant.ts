import "server-only";

const TENANT_NAMESPACE_PREFIX = "tenant-";
const SYSTEM_NAMESPACES = new Set([
  "argocd",
  "evalai-authz",
  "evalai-platform",
  "default",
  "kagent",
  "kube-public",
  "kube-system",
]);

export class TenantContextError extends Error {
  constructor(message = "Trusted tenant context is unavailable") {
    super(message);
    this.name = "TenantContextError";
  }
}

function isDnsLabel(value: string): boolean {
  return (
    value.length <= 63 &&
    /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value)
  );
}

/** Convert a tenant slug to the namespace form used by Proofgrove storage. */
export function namespaceForTenant(tenant: string): string {
  const value = tenant.trim();
  const slug = value.startsWith(TENANT_NAMESPACE_PREFIX)
    ? value.slice(TENANT_NAMESPACE_PREFIX.length)
    : value;

  if (!isDnsLabel(slug) || SYSTEM_NAMESPACES.has(value) || SYSTEM_NAMESPACES.has(slug)) {
    throw new TenantContextError();
  }

  return `${TENANT_NAMESPACE_PREFIX}${slug}`;
}

/**
 * Resolve the authoritative tenant namespace for Proofgrove API calls.
 *
 * Proofgrove UI is deployed once per tenant. The pod namespace supplied by the
 * Kubernetes downward API is therefore the tenant authority. Request headers,
 * query parameters, cookies, and browser state are deliberately ignored: they
 * are client-controlled inputs and cannot select another tenant.
 *
 * Local development remains explicit through POD_NAMESPACE (documented in
 * .env.local.example). Missing or malformed context fails closed rather than
 * silently falling back to a shared sample tenant.
 */
export function resolveTenant(
  env?: { POD_NAMESPACE?: string },
): string {
  const source = env ?? (process.env as { POD_NAMESPACE?: string });
  const namespace = source.POD_NAMESPACE?.trim();
  if (!namespace || !namespace.startsWith(TENANT_NAMESPACE_PREFIX)) {
    throw new TenantContextError();
  }

  const resolved = namespaceForTenant(namespace);
  if (resolved !== namespace) throw new TenantContextError();
  return resolved;
}
