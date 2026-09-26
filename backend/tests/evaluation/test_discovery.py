"""Tests for kagent agent discovery (tenant-scoped catalog)."""

import httpx
import pytest
import respx

from proofgrove.evaluation.target.discovery import (
    list_tenant_agents,
    list_tenant_tool_servers,
)


def _entry(name: str, namespace: str, *, ready: bool, agent_type: str = "Declarative") -> dict:
    return {
        "id": f"{namespace}/{name}",
        "agent": {
            "metadata": {"name": name, "namespace": namespace, "annotations": {"evalai.ai/display-name": name.title()}},
            "spec": {"description": f"{name} agent", "type": agent_type},
        },
        "deploymentReady": ready,
        "accepted": True,
        "model": "gpt-4.1-mini",
    }


@respx.mock
@pytest.mark.asyncio
async def test_list_filters_to_tenant_namespace():
    respx.get("http://kagent:8083/api/agents").mock(
        return_value=httpx.Response(
            200,
            json={
                "error": False,
                "message": "",
                "data": [
                    _entry("weather", "tenant-evalai", ready=True),
                    _entry("other", "tenant-acme", ready=True),  # different tenant
                ],
            },
        )
    )
    agents = await list_tenant_agents(kagent_url="http://kagent:8083", namespace="tenant-evalai")
    assert [a.id for a in agents] == ["tenant-evalai/weather"]
    assert agents[0].display_name == "Weather"
    assert agents[0].agent_type == "Declarative"
    assert agents[0].model == "gpt-4.1-mini"


@respx.mock
@pytest.mark.asyncio
async def test_list_ready_only_filter():
    respx.get("http://kagent:8083/api/agents").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    _entry("up", "tenant-evalai", ready=True),
                    _entry("down", "tenant-evalai", ready=False),
                ]
            },
        )
    )
    agents = await list_tenant_agents(kagent_url="http://kagent:8083", namespace="tenant-evalai", ready_only=True)
    assert [a.id for a in agents] == ["tenant-evalai/up"]


@pytest.mark.asyncio
async def test_list_empty_namespace_returns_empty():
    # No HTTP call expected when namespace is unset (outside a cluster).
    agents = await list_tenant_agents(kagent_url="http://kagent:8083", namespace="")
    assert agents == []


def _entry_with_tools(name: str, namespace: str, tool_names: list[str], *, server: str | None = None) -> dict:
    mcp: dict = {"toolNames": tool_names}
    if server:
        mcp["name"] = server
    return {
        "id": f"{namespace}/{name}",
        "agent": {
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "type": "Declarative",
                "declarative": {
                    "tools": [
                        {"type": "McpServer", "mcpServer": mcp},
                    ]
                },
            },
        },
        "deploymentReady": True,
        "accepted": True,
    }


@respx.mock
@pytest.mark.asyncio
async def test_declarative_tools_surfaced_minus_memory():
    respx.get("http://kagent:8083/api/agents").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    _entry_with_tools(
                        "kensho-search",
                        "tenant-evalai",
                        ["search", "memory_search", "memory_context", "fetch"],
                    )
                ]
            },
        )
    )
    agents = await list_tenant_agents(
        kagent_url="http://kagent:8083",
        namespace="tenant-evalai",
        excluded_tools=["memory_search", "memory_context", "memory_lookup"],
    )
    assert agents[0].tools == ["search", "fetch"]


@respx.mock
@pytest.mark.asyncio
async def test_grounding_url_derived_from_mcp_server_name():
    respx.get("http://kagent:8083/api/agents").mock(
        return_value=httpx.Response(
            200,
            json={"data": [_entry_with_tools("kensho-search", "tenant-evalai", ["search"], server="kensho-mcp")]},
        )
    )
    agents = await list_tenant_agents(kagent_url="http://kagent:8083", namespace="tenant-evalai")
    assert agents[0].grounding_url == "http://kensho-mcp.tenant-evalai.svc.cluster.local:8080/mcp"


@respx.mock
@pytest.mark.asyncio
async def test_grounding_url_none_when_no_server_name():
    respx.get("http://kagent:8083/api/agents").mock(
        return_value=httpx.Response(
            200,
            json={"data": [_entry_with_tools("t", "tenant-evalai", ["search"])]},
        )
    )
    agents = await list_tenant_agents(kagent_url="http://kagent:8083", namespace="tenant-evalai")
    assert agents[0].grounding_url is None


@respx.mock
@pytest.mark.asyncio
async def test_list_tool_servers_groups_filters_and_derives_url():
    respx.get("http://kagent:8083/api/tools").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    {"id": "search", "server_name": "tenant-evalai/kensho-mcp"},
                    {"id": "fetch", "server_name": "tenant-evalai/kensho-mcp"},
                    {"id": "memory_search", "server_name": "tenant-evalai/memory-mcp"},
                    {"id": "other", "server_name": "tenant-acme/other-mcp"},
                ]
            },
        )
    )
    servers = await list_tenant_tool_servers(
        kagent_url="http://kagent:8083",
        namespace="tenant-evalai",
        excluded_tools=["memory_search"],
    )
    # memory-mcp dropped (only excluded tools); other tenant filtered out
    assert [s.name for s in servers] == ["kensho-mcp"]
    assert servers[0].url == "http://kensho-mcp.tenant-evalai.svc.cluster.local:8080/mcp"
    assert set(servers[0].tools) == {"search", "fetch"}


@respx.mock
@pytest.mark.asyncio
async def test_byo_agent_has_no_tools():
    # BYO agents do not declare tools in the CR — tools must be empty.
    respx.get("http://kagent:8083/api/agents").mock(
        return_value=httpx.Response(
            200,
            json={"data": [_entry("kensho-grounding", "tenant-evalai", ready=True, agent_type="BYO")]},
        )
    )
    agents = await list_tenant_agents(kagent_url="http://kagent:8083", namespace="tenant-evalai")
    assert agents[0].tools == []
