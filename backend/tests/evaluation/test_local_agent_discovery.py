"""A standalone lab has no Kubernetes catalog; that is not an API outage."""

from unittest.mock import AsyncMock

import httpx
import pytest

from proofgrove.api.v1 import agents
from proofgrove.db.store import EvaluationStore
from proofgrove.platform.contracts import TargetType, TargetVersion
from proofgrove.settings import settings

TENANT = "local-classroom"


def saved_target(source="a2a_agent_card"):
    return TargetVersion(
        target_id="saved-agent", project_id="catalog", tenant_id="tenant-local-classroom",
        name="Existing endpoint", version="1", endpoint="https://example.com/a2a",
        target_type=TargetType.AGENT, environment="external",
        configuration={"catalog_source": source, "agent_card": {
            "name": "Existing endpoint", "description": "Previously onboarded target",
            "url": "https://example.com/a2a", "version": "1", "capabilities": {}, "skills": [],
        }},
    )


@pytest.mark.parametrize("mode", ["offline", "local", "live"])
@pytest.mark.parametrize("with_external", [False, True])
def test_local_catalog_includes_workflows_and_saved_external_agents(client, monkeypatch, mode, with_external):
    monkeypatch.setenv("PROOFGROVE_MODE", mode)
    monkeypatch.setattr(settings, "app_env", "dev")
    monkeypatch.setattr(settings, "evaluation_runtime", "local")
    monkeypatch.setattr(settings, "pod_namespace", "tenant-local-classroom")
    from proofgrove.evaluation.target import local_workflows
    monkeypatch.setattr(local_workflows, "provider_snapshot", AsyncMock(return_value={"default": {
        "provider": "ollama", "model_id": "test-model", "endpoint": "http://127.0.0.1:11434/v1",
    }}))
    discovery = AsyncMock(side_effect=AssertionError("Local lab must not contact Kagent"))
    tools = AsyncMock(side_effect=AssertionError("Local lab must not contact Kagent"))
    monkeypatch.setattr(agents, "list_tenant_agents", discovery)
    monkeypatch.setattr(agents, "list_tenant_tool_servers", tools)
    external = saved_target()
    saved = [saved_target("kagent_discovery"), *([external] if with_external else [])]
    monkeypatch.setattr(EvaluationStore, "list_agent_targets", AsyncMock(return_value=saved))
    monkeypatch.setattr(EvaluationStore, "target_system_projects", AsyncMock(return_value={("saved-agent", "external"): "real-system-project"}))

    listing = client.get("/agents?ready_only=true")
    catalog = client.get("/agents/catalog")
    mcp = client.get("/agents/mcp-servers")
    assert listing.status_code == catalog.status_code == mcp.status_code == 200
    assert len(listing.json()) == (0 if mode == "offline" else 6) + int(with_external)
    assert len(catalog.json()) == 6 + int(with_external)
    assert mcp.json() == []
    if with_external:
        assert listing.json()[-1]["system_project_id"] == "real-system-project"
        assert catalog.json()[-1]["target_version_id"] == external.target_version_id
    discovery.assert_not_awaited()
    tools.assert_not_awaited()


@pytest.mark.parametrize("route", ["/agents", "/agents/catalog", "/agents/mcp-servers"])
def test_nonlocal_discovery_errors_remain_visible(client, monkeypatch, route):
    monkeypatch.setenv("PROOFGROVE_MODE", "offline")
    monkeypatch.setattr(settings, "pod_namespace", "tenant-other")
    client.headers["x-evalai-tenant"] = "other"
    monkeypatch.setattr(agents, "list_tenant_agents", AsyncMock(side_effect=httpx.ConnectError("Unavailable")))
    monkeypatch.setattr(agents, "list_tenant_tool_servers", AsyncMock(side_effect=httpx.ConnectError("Unavailable")))
    monkeypatch.setattr(EvaluationStore, "list_agent_targets", AsyncMock(return_value=[]))
    response = client.get(route)
    assert response.status_code == 502
