"""Agent Catalog connectivity and tenant-scoped persistence tests."""

import asyncio
import ipaddress
from unittest.mock import AsyncMock

import httpx
import pytest
import respx
from pydantic import SecretStr

from evalhub.api.v1 import agents as agent_routes
from evalhub.db.session import async_session
from evalhub.db.store import EvaluationStore
from evalhub.evaluation.target import catalog
from evalhub.evaluation.target.discovery import AgentSummary
from evalhub.platform import authz
from evalhub.settings import settings

# Hosts are pinned to the address they resolve to, so the mocked card URLs below are
# addresses rather than names. Public documentation range (RFC 5737 is loopback-free).
PUBLIC_ADDRESSES = {
    "agent.example": "93.184.216.34",
    "offline-agent.example": "93.184.216.35",
    "stable-agent.example": "93.184.216.36",
}


@pytest.fixture(autouse=True)
def stub_dns(monkeypatch):
    """Resolve test hosts without touching DNS; tests add their own mappings."""

    hosts = dict(PUBLIC_ADDRESSES)

    async def _resolve(hostname: str, port: int):  # noqa: ARG001
        literals = hosts.get(hostname)
        if not literals:
            raise catalog.AgentCatalogError("Agent System Endpoint host could not be resolved")
        return [ipaddress.ip_address(literal) for literal in _as_list(literals)]

    monkeypatch.setattr(catalog, "resolve_endpoint_addresses", _resolve)
    return hosts


def _as_list(value):
    return [value] if isinstance(value, str) else list(value)


@pytest.fixture(autouse=True)
def no_platform_agents(monkeypatch):
    """Keep manual-catalog tests offline unless a test opts into discovery."""

    async def _empty(**kwargs):  # noqa: ARG001
        return []

    monkeypatch.setattr(agent_routes, "list_tenant_agents", _empty)


def _card(name: str = "Research Agent", version: str = "1.2.0", url: str = "https://agent.example/a2a") -> dict:
    return {
        "name": name,
        "description": "Finds governed research evidence.",
        "url": url,
        "version": version,
        "protocolVersion": "0.3.0",
        "capabilities": {"streaming": True},
        "skills": [{"id": "research", "name": "Research"}],
    }


@respx.mock
def test_successful_connectivity_test_onboards_agent(client):
    respx.get("https://93.184.216.34/.well-known/agent.json").mock(return_value=httpx.Response(200, json=_card()))

    response = client.post(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-a"},
        json={"endpoint": "https://agent.example/"},
    )

    assert response.status_code == 201
    target = response.json()
    assert target["name"] == "Research Agent"
    assert target["version"] == "1.2.0"
    assert target["endpoint"] == "https://agent.example"
    assert target["target_type"] == "agent"
    assert target["tenant_id"] == "tenant-agent-catalog-a"
    assert target["configuration"]["connectivity"] == "verified"
    assert target["configuration"]["agent_card"]["skills"][0]["id"] == "research"

    listing = client.get(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-a"},
    )
    assert listing.status_code == 200
    assert [item["target_version_id"] for item in listing.json()] == [target["target_version_id"]]


@respx.mock
def test_connectivity_failure_does_not_persist_agent(client):
    respx.get("https://93.184.216.35/.well-known/agent.json").mock(return_value=httpx.Response(503, text="unavailable"))

    response = client.post(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-b"},
        json={"endpoint": "https://offline-agent.example"},
    )

    assert response.status_code == 422
    assert "HTTP 503" in response.json()["detail"]
    listing = client.get(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-b"},
    )
    assert listing.json() == []


@respx.mock
@pytest.mark.parametrize(
    "failure",
    [
        httpx.ConnectError("[Errno 61] Connection refused"),
        httpx.ConnectTimeout("timed out"),
    ],
)
def test_transport_failures_are_indistinguishable_to_the_caller(client, failure):
    """Distinguishing refused from timed out would make this a port-scan oracle."""

    respx.get("https://93.184.216.34/.well-known/agent.json").mock(side_effect=failure)

    response = client.post(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-transport"},
        json={"endpoint": "https://agent.example"},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "Could not connect to the A2A agent-card endpoint"
    assert "refused" not in response.text
    assert "timed out" not in response.text


@respx.mock
def test_repeated_successful_test_is_idempotent(client):
    route = respx.get("https://93.184.216.36/.well-known/agent.json").mock(return_value=httpx.Response(200, json=_card(name="Stable Agent", version="2.0.0", url="https://stable-agent.example/a2a")))
    headers = {"x-evalai-tenant": "tenant-agent-catalog-c"}

    first = client.post(
        "/agents/catalog",
        headers=headers,
        json={"endpoint": "https://stable-agent.example"},
    )
    second = client.post(
        "/agents/catalog",
        headers=headers,
        json={"endpoint": "https://stable-agent.example"},
    )

    assert first.status_code == 201
    assert second.status_code == 201
    assert second.json()["target_version_id"] == first.json()["target_version_id"]
    assert route.call_count == 2
    assert len(client.get("/agents/catalog", headers=headers).json()) == 1


@respx.mock
def test_external_catalog_authentication_and_selection_without_kagent(client, monkeypatch):
    monkeypatch.setattr(settings, "external_agent_credentials", {
        "research": {"origin": SecretStr("https://agent.example"), "Authorization": SecretStr("Bearer test-secret")},
    })
    route = respx.get("https://93.184.216.34/.well-known/agent.json").respond(200, json=_card())
    headers = {"x-evalai-tenant": "tenant-agent-catalog-external"}
    response = client.post("/agents/catalog", headers=headers, json={
        "endpoint": "https://agent.example", "credential_ref": "research",
    })
    assert response.status_code == 201
    assert route.calls[0].request.headers["authorization"] == "Bearer test-secret"
    assert "test-secret" not in response.text

    async def offline(**kwargs):
        raise httpx.ConnectError("kagent is not installed")

    monkeypatch.setattr(agent_routes, "list_tenant_agents", offline)
    agents = client.get("/agents", headers=headers)
    assert agents.status_code == 200
    assert agents.json()[0]["id"] == f"external:{response.json()['target_version_id']}"
    assert client.get("/agents/catalog", headers=headers).status_code == 200
    assert "test-secret" not in agents.text


@respx.mock
def test_catalog_rejects_agent_card_with_another_origin(client):
    respx.get("https://93.184.216.34/.well-known/agent.json").respond(
        200, json=_card(url="https://other.example/a2a"),
    )
    response = client.post("/agents/catalog", headers={"x-evalai-tenant": "tenant-agent-catalog-origin"},
                           json={"endpoint": "https://agent.example"})
    assert response.status_code == 422
    assert "origin" in response.json()["detail"]


@respx.mock
def test_catalog_discovers_modern_agent_card_location(client):
    respx.get("https://93.184.216.34/.well-known/agent.json").respond(404)
    modern = respx.get("https://93.184.216.34/.well-known/agent-card.json").respond(200, json=_card())
    response = client.post("/agents/catalog", headers={"x-evalai-tenant": "tenant-agent-catalog-modern"},
                           json={"endpoint": "https://agent.example"})
    assert response.status_code == 201
    assert modern.called
    assert response.json()["configuration"]["agent_card_url"].endswith("/agent-card.json")


@respx.mock
def test_catalog_does_not_send_another_origins_credentials(client, monkeypatch):
    monkeypatch.setattr(settings, "external_agent_credentials", {
        "research": {"origin": SecretStr("https://other.example"), "Authorization": SecretStr("Bearer test-secret")},
    })
    response = client.post("/agents/catalog", headers={"x-evalai-tenant": "tenant-agent-catalog-auth"},
                           json={"endpoint": "https://agent.example", "credential_ref": "research"})
    assert response.status_code == 422
    assert not respx.calls


def test_agent_catalog_is_tenant_isolated(client):
    response = client.get(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-other"},
    )
    assert response.status_code == 200
    assert response.json() == []


@respx.mock
def test_local_endpoint_is_rejected_without_network_call(client):
    response = client.post(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-d"},
        json={"endpoint": "http://127.0.0.1:8080"},
    )
    assert response.status_code == 422
    assert "private and local IP" in response.json()["detail"]
    assert respx.calls.call_count == 0


@respx.mock
@pytest.mark.parametrize(
    "endpoint",
    [
        "http://2130706433:8080",  # dotless decimal 127.0.0.1
        "http://0x7f000001:8080",  # hex 127.0.0.1
        "http://0177.0.0.1:8080",  # dotted octal 127.0.0.1
    ],
)
def test_obfuscated_loopback_endpoint_is_rejected_without_network_call(client, endpoint):
    """Resolvers accept these IPv4 literals even though ipaddress does not."""

    response = client.post(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-obfuscated"},
        json={"endpoint": endpoint},
    )
    assert response.status_code == 422
    assert "must be a DNS name or a public IP address" in response.json()["detail"]
    assert respx.calls.call_count == 0


@respx.mock
@pytest.mark.parametrize(
    "endpoint",
    [
        "http://[::ffff:127.0.0.1]:8080",  # IPv4-mapped loopback
        "http://[64:ff9b::7f00:1]:8080",  # NAT64 well-known prefix to 127.0.0.1
        "http://[64:ff9b:1::a9fe:a9fe]:8080",  # NAT64 local-use prefix to link-local
    ],
)
def test_tunnelled_ipv6_loopback_literal_is_rejected(client, endpoint):
    """IPv4 smuggled inside an IPv6 literal still lands on the local network."""

    response = client.post(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-tunnelled"},
        json={"endpoint": endpoint},
    )
    assert response.status_code == 422
    assert "private and local IP" in response.json()["detail"]
    assert respx.calls.call_count == 0


@respx.mock
@pytest.mark.parametrize(
    ("host", "resolves_to"),
    [
        ("127-0-0-1.nip.io", "127.0.0.1"),  # wildcard DNS to loopback
        ("localtest.me", "127.0.0.1"),
        ("metadata.google.internal", "169.254.169.254"),  # cloud metadata
        ("internal.example", "10.1.2.3"),  # private cluster address, non-cluster name
    ],
)
def test_dns_name_resolving_to_a_local_address_is_rejected(client, stub_dns, host, resolves_to):
    """A public-looking DNS name is only as safe as the address it resolves to."""

    stub_dns[host] = resolves_to

    response = client.post(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-rebind"},
        json={"endpoint": f"http://{host}"},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == (
        "Agent System Endpoint host resolves to a private or local address"
    )
    assert respx.calls.call_count == 0


@respx.mock
def test_dns_name_is_rejected_when_any_resolved_address_is_local(client, stub_dns):
    """One public answer must not launder a loopback answer in the same record set."""

    stub_dns["split.example"] = ["93.184.216.40", "127.0.0.1"]

    response = client.post(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-split"},
        json={"endpoint": "http://split.example"},
    )

    assert response.status_code == 422
    assert respx.calls.call_count == 0


@respx.mock
def test_public_endpoint_is_pinned_to_the_validated_address(client, stub_dns):
    """The fetch goes to the address that was checked, not to a fresh DNS answer."""

    stub_dns["agent-01.example"] = "93.184.216.41"
    route = respx.get("https://93.184.216.41/.well-known/agent.json").mock(
        return_value=httpx.Response(200, json=_card(name="Digit Label Agent", url="https://agent-01.example/a2a"))
    )

    response = client.post(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-pinned"},
        json={"endpoint": "https://agent-01.example"},
    )

    assert response.status_code == 201
    assert response.json()["endpoint"] == "https://agent-01.example"
    assert route.call_count == 1
    request = route.calls[0].request
    assert request.headers["host"] == "agent-01.example"
    assert request.extensions["sni_hostname"] == "agent-01.example"


@respx.mock
def test_tenant_cluster_endpoint_reaches_its_private_service_address(client, stub_dns):
    """In-cluster services are private by design and must stay supported."""

    host = "agent.tenant-agent-catalog-cluster.svc.cluster.local"
    stub_dns[host] = "10.42.0.7"
    route = respx.get("http://10.42.0.7:8080/.well-known/agent.json").mock(
        return_value=httpx.Response(200, json=_card(name="Cluster Agent", url=f"http://{host}:8080/a2a"))
    )

    response = client.post(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-cluster"},
        json={"endpoint": f"http://{host}:8080"},
    )

    assert response.status_code == 201
    assert response.json()["environment"] == "cluster"
    assert route.calls[0].request.headers["host"] == f"{host}:8080"


@respx.mock
def test_tenant_cluster_endpoint_resolving_to_metadata_is_still_rejected(client, stub_dns):
    """The in-cluster allowance covers private ranges only, not link-local metadata."""

    host = "agent.tenant-agent-catalog-meta.svc.cluster.local"
    stub_dns[host] = "169.254.169.254"

    response = client.post(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-meta"},
        json={"endpoint": f"http://{host}:8080"},
    )

    assert response.status_code == 422
    assert respx.calls.call_count == 0


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://[::1",  # unbalanced IPv6 bracket
        "http://ex\u2100ample.com",  # netloc that changes under NFKC normalization
    ],
)
def test_malformed_endpoint_is_rejected_without_leaking_the_exception(client, endpoint):
    """urlparse raises a bare ValueError on these; it must not escape as a 500."""

    response = client.post(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-malformed"},
        json={"endpoint": endpoint},
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail == "Agent System Endpoint is not a valid URL"
    assert "ValueError" not in response.text
    assert "NFKC" not in response.text


@respx.mock
def test_cross_tenant_cluster_endpoint_is_rejected(client):
    response = client.post(
        "/agents/catalog",
        headers={"x-evalai-tenant": "tenant-agent-catalog-e"},
        json={"endpoint": "http://agent.tenant-other.svc.cluster.local:8080"},
    )
    assert response.status_code == 422
    assert "this tenant namespace" in response.json()["detail"]
    assert respx.calls.call_count == 0


def _platform_agent(name: str, *, revision: str = "rev-1") -> AgentSummary:
    return AgentSummary(
        id=f"tenant-sync/{name}",
        name=name,
        namespace="tenant-sync",
        description=f"{name} description",
        ready=True,
        accepted=True,
        model="gpt-5.1",
        agent_type="Declarative",
        revision=revision,
        tools=["search"],
    )


def test_catalog_refresh_syncs_all_ready_platform_agents_idempotently(client, monkeypatch):
    async def _list(**kwargs):
        assert kwargs["namespace"] == "tenant-sync"
        assert kwargs["ready_only"] is True
        return [_platform_agent("agent-builder"), _platform_agent("research-agent")]

    monkeypatch.setattr(agent_routes, "list_tenant_agents", _list)
    headers = {"x-evalai-tenant": "tenant-sync"}

    first = client.get("/agents/catalog", headers=headers)
    second = client.get("/agents/catalog", headers=headers)

    assert first.status_code == 200
    assert second.status_code == 200
    assert {item["name"] for item in first.json()} == {"agent-builder", "research-agent"}
    assert {item["target_version_id"] for item in second.json()} == {item["target_version_id"] for item in first.json()}
    for item in second.json():
        assert item["tenant_id"] == "tenant-sync"
        assert item["configuration"]["catalog_source"] == "kagent_discovery"
        assert item["configuration"]["agent_ref"].startswith("tenant-sync/")
        assert item["endpoint"].endswith(f"/api/a2a/tenant-sync/{item['name']}/")


def test_catalog_reader_cannot_sync_but_can_read_saved_targets(client, monkeypatch):
    monkeypatch.setattr(settings, "platform_auth_required", True)
    monkeypatch.setattr(settings, "pod_namespace", "tenant-sync")
    granted = {authz.PERMISSION_EVALUATION_READ}

    async def check(request, permission):
        request.state.eval_hub_permissions = set(granted)
        return permission in granted

    monkeypatch.setattr(authz, "check_permission", check)
    monkeypatch.setattr(agent_routes, "check_permission", check, raising=False)
    discovery = AsyncMock(return_value=[_platform_agent("catalog-permission-check")])
    monkeypatch.setattr(agent_routes, "list_tenant_agents", discovery)
    headers = {"x-evalai-tenant": "sync", "x-evalai-sub": "synthetic-catalog-user"}

    async def snapshot():
        async with async_session() as session:
            store = EvaluationStore(session)
            project = await store.get_project(agent_routes._catalog_project_id("tenant-sync"), "tenant-sync")
            targets = await store.list_agent_targets("tenant-sync")
            events = await store.list_audit_events(tenant_id="tenant-sync")
            return (
                project.model_dump(mode="json") if project else None,
                [target.model_dump(mode="json") for target in targets],
                [event.model_dump(mode="json") for event in events],
            )

    before = asyncio.run(snapshot())
    reader = client.get("/agents/catalog", headers=headers)
    assert reader.status_code == 200, reader.text
    assert reader.json() == []
    discovery.assert_not_awaited()
    assert asyncio.run(snapshot()) == before

    granted.add(authz.PERMISSION_TARGET_MANAGE)
    manager = client.get("/agents/catalog", headers=headers)
    assert manager.status_code == 200, manager.text
    assert len(manager.json()) == 1
    discovery.assert_awaited_once()
    synced = asyncio.run(snapshot())
    assert synced[0] is not None and len(synced[1]) == 1
    assert any(event["action"] == "agent_catalog.synced" for event in synced[2])

    granted.remove(authz.PERMISSION_TARGET_MANAGE)
    discovery.reset_mock()
    discovery.side_effect = AssertionError("A reader must not refresh discovery")
    saved = client.get("/agents/catalog", headers=headers)
    assert saved.status_code == 200, saved.text
    assert saved.json() == synced[1]
    assert saved.json()[0]["target_version_id"] == manager.json()[0]["target_version_id"]
    discovery.assert_not_awaited()
    assert asyncio.run(snapshot()) == synced


def test_catalog_refresh_hides_platform_agent_that_is_no_longer_ready(client, monkeypatch):
    active = [_platform_agent("temporary-agent")]

    async def _list(**kwargs):  # noqa: ARG001
        return list(active)

    monkeypatch.setattr(agent_routes, "list_tenant_agents", _list)
    headers = {"x-evalai-tenant": "tenant-sync-stale"}
    # Match the test's discovery namespace to its tenant header.
    active[0] = active[0].model_copy(update={"id": "tenant-sync-stale/temporary-agent", "namespace": "tenant-sync-stale"})

    assert len(client.get("/agents/catalog", headers=headers).json()) == 1
    active.clear()
    assert client.get("/agents/catalog", headers=headers).json() == []


def test_catalog_rejects_tenant_header_outside_deployed_namespace(client):
    prior = settings.pod_namespace
    settings.pod_namespace = "tenant-evalai"
    try:
        response = client.get(
            "/agents/catalog",
            headers={"x-evalai-tenant": "tenant-other"},
        )
    finally:
        settings.pod_namespace = prior

    assert response.status_code == 403
    assert "Eval Hub namespace" in response.json()["detail"]


def test_catalog_accepts_gateway_slug_matching_deployed_namespace(client, monkeypatch):
    """Gateway injects x-evalai-tenant=<slug>; Eval Hub runs in tenant-<slug>."""

    async def _empty(**kwargs):  # noqa: ARG001
        return []

    monkeypatch.setattr(agent_routes, "list_tenant_agents", _empty)
    prior = settings.pod_namespace
    settings.pod_namespace = "tenant-evalai"
    try:
        response = client.get(
            "/agents/catalog",
            headers={"x-evalai-tenant": "evalai"},
        )
    finally:
        settings.pod_namespace = prior

    assert response.status_code == 200
    assert response.json() == []


@pytest.mark.parametrize(
    ("path", "seam"),
    [
        ("/agents", "list_tenant_agents"),
        ("/agents/mcp-servers", "list_tenant_tool_servers"),
        ("/agents/catalog", "list_tenant_agents"),
    ],
)
def test_discovery_failures_are_logged_by_type_only(client, monkeypatch, caplog, path, seam):
    """A kagent transport error echoes the request URL and can carry a token."""
    import logging

    async def boom(**kwargs):  # noqa: ARG001
        raise httpx.ConnectError("http://kagent.internal/api/agents?token=sentinel-token")

    monkeypatch.setattr(agent_routes, seam, boom)
    with caplog.at_level(logging.WARNING, logger="evalhub"):
        response = client.get(path, headers={"x-evalai-tenant": "tenant-agent-catalog-logs"})
    assert response.status_code == 502, response.text
    warnings = [record for record in caplog.records if record.name == "evalhub.api.v1.agents"]
    assert warnings and warnings[0].error_type == "ConnectError"
    for record in warnings:
        assert "sentinel-token" not in str(vars(record))
        assert "kagent.internal" not in str(vars(record))
