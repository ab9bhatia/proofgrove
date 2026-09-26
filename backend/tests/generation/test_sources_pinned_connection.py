"""The MCP grounding connection re-resolves and pins the address it validated.

The route validates ``grounding_url`` at submission; the worker connects later,
after the queue and semaphore wait, which is the window a DNS answer can change
in. ``fetch`` now resolves again, refuses a blocked address, and hands the MCP
client the checked literal address (Host header and SNI preserved) instead of a
name it would resolve once more on its own.
"""

import ipaddress

import pytest

from proofgrove.evaluation.target import catalog
from proofgrove.evaluation.target.catalog import AgentCatalogError
from proofgrove.generation import sources


class _OpenedError(Exception):
    def __init__(self, url, headers, factory):
        super().__init__(url)
        self.url, self.headers, self.factory = url, headers, factory


def _record_open(monkeypatch):
    import mcp.client.streamable_http as streamable

    def _open(url, headers=None, **kwargs):
        raise _OpenedError(url, headers, kwargs.get("httpx_client_factory"))

    monkeypatch.setattr(streamable, "streamablehttp_client", _open)


async def test_a_blocked_address_is_refused_before_any_connection(monkeypatch):
    _record_open(monkeypatch)

    async def resolve(_hostname, _port):
        return [ipaddress.ip_address("169.254.169.254")]

    monkeypatch.setattr(catalog, "resolve_endpoint_addresses", resolve)
    source = sources.McpToolGroundingSource(url="https://grounding.example.com/mcp")
    with pytest.raises(AgentCatalogError):
        await source.fetch("seed")


async def test_the_connection_is_pinned_to_the_validated_address(monkeypatch):
    _record_open(monkeypatch)

    async def resolve(_hostname, _port):
        return [ipaddress.ip_address("93.184.216.34")]

    monkeypatch.setattr(catalog, "resolve_endpoint_addresses", resolve)
    _catalog(monkeypatch, [("grounding", "https://grounding.example.com:8443/mcp", ["search"])])
    source = sources.McpToolGroundingSource(url="https://grounding.example.com:8443/mcp")
    with pytest.raises(_OpenedError) as opened:
        await source.fetch("seed")
    assert opened.value.url == "https://93.184.216.34:8443/mcp"
    assert opened.value.headers["Host"] == "grounding.example.com:8443"
    assert "Accept" not in opened.value.headers
    client = opened.value.factory()
    try:
        assert client.follow_redirects is False
        assert client.trust_env is False
        assert client._transport._sni_hostname == "grounding.example.com"
    finally:
        await client.aclose()


async def test_a_platform_memory_tool_is_refused_before_any_connection(monkeypatch):
    """``excluded_tool_names`` keeps memory-mcp tools out of discovery and the
    captured trace; grounding must not call them as the service identity."""
    from proofgrove.errors import EvaluationInputError

    _record_open(monkeypatch)
    source = sources.McpToolGroundingSource(url="https://grounding.example.com/mcp", tool="memory_search")
    with pytest.raises(EvaluationInputError, match="memory tool"):
        await source.fetch("seed")


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/mcp",  # cloud metadata literal
        "http://127.0.0.1/mcp",  # loopback literal
        "http://10.0.0.7:8000/mcp",  # private literal
        "http://tool.tenant-foreign.svc.cluster.local:8000/mcp",  # another tenant's service
    ],
)
async def test_blocked_literals_and_foreign_tenant_services_are_refused_before_any_connection(monkeypatch, url):
    """The pin helper passes IP literals through and allows private addresses
    for any cluster name; the literal/tenant validator has to run first. A
    job row is the only input the worker trusts, so this holds without the
    enqueue route."""
    from proofgrove.settings import settings

    _record_open(monkeypatch)
    monkeypatch.setattr(settings, "pod_namespace", "tenant-own")

    async def resolve(_hostname, _port):
        return [ipaddress.ip_address("10.10.10.10")]

    monkeypatch.setattr(catalog, "resolve_endpoint_addresses", resolve)
    source = sources.McpToolGroundingSource(url=url, tenant_namespace="tenant-own")
    with pytest.raises(AgentCatalogError):
        await source.fetch("seed")


async def test_the_tenants_own_service_is_still_allowed_and_pinned(monkeypatch):
    from proofgrove.settings import settings

    _record_open(monkeypatch)
    monkeypatch.setattr(settings, "pod_namespace", "tenant-own")

    async def resolve(_hostname, _port):
        return [ipaddress.ip_address("10.10.10.10")]

    monkeypatch.setattr(catalog, "resolve_endpoint_addresses", resolve)
    _catalog(monkeypatch, [("tool", "http://tool.tenant-own.svc.cluster.local:8000/mcp", ["search"])])
    source = sources.McpToolGroundingSource(url="http://tool.tenant-own.svc.cluster.local:8000/mcp", tenant_namespace="tenant-own")
    with pytest.raises(_OpenedError) as opened:
        await source.fetch("seed")
    assert opened.value.url == "http://10.10.10.10:8000/mcp"
    assert opened.value.headers["Host"] == "tool.tenant-own.svc.cluster.local:8000"


# --- tenant catalog only ------------------------------------------------------

_CATALOG_URL = "http://kensho-mcp.tenant-own.svc.cluster.local:8000/mcp"


def _catalog(monkeypatch, servers):
    """Stub discovery with a fixed tenant catalog (no kagent call)."""
    from proofgrove.evaluation.target import discovery
    from proofgrove.evaluation.target.discovery import ToolServerSummary

    async def listed(**kwargs):  # noqa: ARG001
        if isinstance(servers, Exception):
            raise servers
        return [ToolServerSummary(name=n, namespace="tenant-own", url=u, tools=t) for n, u, t in servers]

    monkeypatch.setattr(discovery, "list_tenant_tool_servers", listed)


def _own_tenant(monkeypatch):
    from proofgrove.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", "tenant-own")

    async def resolve(_hostname, _port):
        return [ipaddress.ip_address("10.10.10.10")]

    monkeypatch.setattr(catalog, "resolve_endpoint_addresses", resolve)


async def test_a_catalogued_pair_is_allowed_and_still_pinned(monkeypatch):
    _record_open(monkeypatch)
    _own_tenant(monkeypatch)
    _catalog(monkeypatch, [("kensho-mcp", _CATALOG_URL, ["search"])])
    source = sources.McpToolGroundingSource(url=_CATALOG_URL, tool="search", tenant_namespace="tenant-own")
    with pytest.raises(_OpenedError) as opened:
        await source.fetch("seed")
    assert opened.value.url == "http://10.10.10.10:8000/mcp"


async def test_an_endpoint_outside_the_tenant_catalog_is_refused_before_any_connection(monkeypatch):
    _record_open(monkeypatch)
    _own_tenant(monkeypatch)
    _catalog(monkeypatch, [("kensho-mcp", _CATALOG_URL, ["search"])])
    source = sources.McpToolGroundingSource(url="http://other-mcp.tenant-own.svc.cluster.local:8000/mcp", tool="search", tenant_namespace="tenant-own")
    with pytest.raises(AgentCatalogError, match="not a tool server in this tenant's catalog"):
        await source.fetch("seed")


async def test_a_tool_the_server_does_not_advertise_is_refused(monkeypatch):
    _record_open(monkeypatch)
    _own_tenant(monkeypatch)
    _catalog(monkeypatch, [("kensho-mcp", _CATALOG_URL, ["search"])])
    source = sources.McpToolGroundingSource(url=_CATALOG_URL, tool="admin_export", tenant_namespace="tenant-own")
    with pytest.raises(AgentCatalogError, match="not advertised"):
        await source.fetch("seed")


async def test_discovery_failure_means_no_connection(monkeypatch):
    import httpx

    _record_open(monkeypatch)
    _own_tenant(monkeypatch)
    _catalog(monkeypatch, httpx.ConnectError("kagent unreachable"))
    source = sources.McpToolGroundingSource(url=_CATALOG_URL, tool="search", tenant_namespace="tenant-own")
    with pytest.raises(httpx.ConnectError):
        await source.fetch("seed")


async def test_the_catalog_is_rechecked_at_connection_time_not_only_at_submission(monkeypatch):
    """A pair that was catalogued when the job was queued but is gone when the
    worker runs must not be called."""
    _record_open(monkeypatch)
    _own_tenant(monkeypatch)
    _catalog(monkeypatch, [("kensho-mcp", _CATALOG_URL, ["search"])])
    source = sources.McpToolGroundingSource(url=_CATALOG_URL, tool="search", tenant_namespace="tenant-own")
    _catalog(monkeypatch, [])  # the server was removed from the tenant catalog after queueing
    with pytest.raises(AgentCatalogError):
        await source.fetch("seed")


@pytest.mark.parametrize("tool", ["list_agents", "dispatch_to_agent", "create_agent"])
async def test_agent_control_tools_never_ground_generation_even_when_advertised(monkeypatch, tool):
    """A catalogued tenant server may advertise agent tools; grounding runs as the
    service identity, so those specific tools are refused before any connection.
    ``excluded_tool_names`` is untouched: it also shapes evidence and readiness."""
    from proofgrove.settings import settings

    _record_open(monkeypatch)
    _own_tenant(monkeypatch)
    _catalog(monkeypatch, [("agents-mcp", _CATALOG_URL, ["search", tool])])
    assert tool not in settings.excluded_tool_names
    source = sources.McpToolGroundingSource(url=_CATALOG_URL, tool=tool, tenant_namespace="tenant-own")
    with pytest.raises(AgentCatalogError, match="cannot ground generation"):
        await source.fetch("seed")
