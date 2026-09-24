"""Tests for the shared outbound-URL SSRF guard."""

from __future__ import annotations

import ipaddress
from unittest.mock import patch

import pytest

from evalhub.platform.url_guard import AgentCatalogError, validate_outbound_url


@pytest.mark.asyncio
async def test_validate_outbound_url_accepts_a_public_endpoint():
    async def dns(host, port):
        assert (host, port) == ("public.example", 443)
        return [ipaddress.ip_address("93.184.216.34")]

    with patch("evalhub.evaluation.target.catalog.resolve_endpoint_addresses", dns):
        assert await validate_outbound_url("https://public.example/mcp", "eval-hub") == "https://public.example/mcp"


@pytest.mark.asyncio
async def test_validate_outbound_url_rejects_a_hostname_that_resolves_to_metadata():
    """A literal-form-only guard would let this through; DNS resolves it to the
    cloud metadata address, which must be rejected even though the literal
    hostname looks like an ordinary public name."""

    async def dns(host, port):
        return [ipaddress.ip_address("169.254.169.254")]

    with patch("evalhub.evaluation.target.catalog.resolve_endpoint_addresses", dns):
        with pytest.raises(AgentCatalogError, match="private or local"):
            await validate_outbound_url("https://metadata.internal/mcp", "eval-hub")


@pytest.mark.asyncio
async def test_validate_outbound_url_rejects_ip_literal_without_dns_lookup():
    with patch("evalhub.evaluation.target.catalog.resolve_endpoint_addresses") as dns:
        with pytest.raises(AgentCatalogError, match="private and local"):
            await validate_outbound_url("http://127.0.0.1/mcp", "eval-hub")
    dns.assert_not_called()


@pytest.mark.asyncio
async def test_validate_outbound_url_allows_same_tenant_cluster_service():
    async def dns(host, port):
        return [ipaddress.ip_address("10.0.0.5")]

    with patch("evalhub.evaluation.target.catalog.resolve_endpoint_addresses", dns):
        result = await validate_outbound_url(
            "http://mcp-tool.eval-hub.svc.cluster.local/mcp", "eval-hub"
        )
    assert result == "http://mcp-tool.eval-hub.svc.cluster.local/mcp"


@pytest.mark.asyncio
async def test_validate_outbound_url_rejects_cross_namespace_cluster_service():
    with patch("evalhub.evaluation.target.catalog.resolve_endpoint_addresses") as dns:
        with pytest.raises(AgentCatalogError, match="tenant namespace"):
            await validate_outbound_url(
                "http://mcp-tool.other-tenant.svc.cluster.local/mcp", "eval-hub"
            )
    dns.assert_not_called()
