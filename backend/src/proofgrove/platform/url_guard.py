"""Shared outbound-URL SSRF guard.

``evaluation.target.catalog.normalize_agent_endpoint`` already rejects
loopback / link-local / private / NAT64 literals and cross-tenant
``.svc.cluster.local`` names for onboarded agent endpoints -- but only by an
endpoint's literal form. A DNS name that *resolves* to one of those addresses
sails straight through the literal check, the same gap the A2A connectivity
path closes with a resolve+block pass at connect time
(``resolve_endpoint_addresses`` / ``is_blocked_address``). Every other
feature that persists a caller-supplied HTTP endpoint (dataset generation's
``grounding_url``, a custom LLM's ``endpoint``) needs the exact same guard, so
it is re-exported here under a name that does not imply "agent" rather than
duplicated.
"""

from __future__ import annotations

import ipaddress
from urllib.parse import urlparse

from proofgrove.evaluation.target.catalog import (
    AgentCatalogError,
    assert_endpoint_resolves_safely,
    normalize_agent_endpoint,
)


async def validate_outbound_url(endpoint: str, tenant_namespace: str) -> str:
    """Validate ``endpoint`` by literal form AND by what it actually resolves to."""

    normalized = normalize_agent_endpoint(endpoint, tenant_namespace)
    parsed = urlparse(normalized)
    hostname = (parsed.hostname or "").lower()
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        # Already an IP literal: normalize_agent_endpoint validated it directly.
        return normalized
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    allow_private = hostname.endswith(".svc.cluster.local")
    await assert_endpoint_resolves_safely(hostname, port, allow_private=allow_private)
    return normalized


__all__ = ["AgentCatalogError", "validate_outbound_url"]
