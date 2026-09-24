"""Tests for POST /datasets/generate and GET /datasets/csv-template."""

import pytest
from httpx import ASGITransport, AsyncClient

from evalhub.datasets import generation_service
from evalhub.main import app

#: Generation attributes jobs to POD_NAMESPACE, which is unset under test and
#: falls back to "local"; the caller acts as that same tenant.
TENANT = "local"


@pytest.fixture(autouse=True)
def _offline_synthesis(monkeypatch):
    """Generation now runs as an in-process background task on enqueue;
    keep these endpoint-contract tests hermetic (no gateway / MCP calls)."""

    async def fake_synthesize(params):
        raise ValueError("offline test: synthesis disabled")

    monkeypatch.setattr(generation_service, "_synthesize_records", fake_synthesize)


@pytest.mark.asyncio
async def test_csv_template_is_question_expected_output_metadata():
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        response = await ac.get("/datasets/csv-template")
    assert response.status_code == 200
    template = response.json()
    assert list(template["columns"]) == ["Serial No", "Question", "Expected Output", "Metadata"]
    assert template["csv"].splitlines()[0] == "Serial No,Question,Expected Output,Metadata"


@pytest.mark.asyncio
async def test_csv_template_metadata_reaches_the_keys_the_bridge_reads():
    """The template's metadata blob parses into the stored dicts, unchanged.

    Expected actions and context live inside ``Metadata`` now; they must still
    land where ``dataset_bridge`` grades them.
    """
    from evalhub.datasets.csv_parser import parse_csv

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        template = (await ac.get("/datasets/csv-template")).json()

    rows = parse_csv(template["csv"])
    assert rows[0]["expectations"]["expected_actions"].startswith("search(")
    assert rows[0]["tags"]["risk"] == "Low"
    assert rows[1]["inputs"]["context"]


@pytest.mark.asyncio
async def test_generate_requires_seeds():
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        resp = await ac.post(
            "/datasets/generate",
            json={"dataset_name": "x", "grounding_url": "u", "seeds": []},
        )
        assert resp.status_code == 422


@pytest.mark.asyncio
async def test_generate_llms_enqueues_without_grounding():
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        resp = await ac.post(
            "/datasets/generate",
            json={
                "dataset_name": "llm_ds",
                "generation_method": "llms",
                "seeds": ["Create customer support evaluation cases"],
                "num_rows": 5,
                "model": "gpt-5.1",
                "domain": "support",
            },
        )
        assert resp.status_code == 202
        assert resp.json()["job_id"]
        assert resp.json()["dataset_name"] == "llm_ds"


@pytest.mark.asyncio
async def test_generate_llms_requires_num_rows_and_model():
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        missing_rows = await ac.post(
            "/datasets/generate",
            json={
                "dataset_name": "llm_ds",
                "generation_method": "llms",
                "seeds": ["Make cases"],
                "model": "gpt-5.1",
            },
        )
        assert missing_rows.status_code == 422

        missing_model = await ac.post(
            "/datasets/generate",
            json={
                "dataset_name": "llm_ds",
                "generation_method": "llms",
                "seeds": ["Make cases"],
                "num_rows": 3,
            },
        )
        assert missing_model.status_code == 422


@pytest.mark.asyncio
async def test_generate_refuses_a_platform_memory_tool_as_grounding():
    """``excluded_tool_names`` applies to grounding, not only to discovery."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test", headers={"x-evalai-tenant": TENANT}) as ac:
        resp = await ac.post(
            "/datasets/generate",
            json={"dataset_name": "x", "grounding_url": "https://grounding.example.com/mcp", "grounding_tool": "memory_search", "seeds": ["topic"]},
        )
    assert resp.status_code == 422, resp.text
    assert "memory tool" in resp.json()["detail"]


# --- tenant catalog only ------------------------------------------------------

_CATALOG_URL = "http://kensho-mcp.local.svc.cluster.local:8000/mcp"


def _catalog(monkeypatch, servers):
    """Stub discovery with a fixed tenant catalog and DNS with a private in-cluster address."""
    import ipaddress

    from evalhub.evaluation.target import catalog, discovery
    from evalhub.evaluation.target.discovery import ToolServerSummary

    async def resolve(_hostname, _port):
        return [ipaddress.ip_address("10.10.10.10")]

    monkeypatch.setattr(catalog, "resolve_endpoint_addresses", resolve)

    async def listed(**kwargs):  # noqa: ARG001
        if isinstance(servers, Exception):
            raise servers
        return [ToolServerSummary(name=n, namespace="local", url=u, tools=t) for n, u, t in servers]

    monkeypatch.setattr(discovery, "list_tenant_tool_servers", listed)


async def _generate(url: str, tool: str = "search"):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", headers={"x-evalai-tenant": TENANT}) as ac:
        return await ac.post("/datasets/generate", json={"dataset_name": "grounded", "grounding_url": url, "grounding_tool": tool, "seeds": ["topic"]})


@pytest.mark.asyncio
async def test_generate_accepts_a_catalogued_server_and_tool(monkeypatch):
    _catalog(monkeypatch, [("kensho-mcp", _CATALOG_URL, ["search"])])
    resp = await _generate(_CATALOG_URL)
    assert resp.status_code == 202, resp.text


@pytest.mark.asyncio
async def test_generate_refuses_a_server_outside_the_tenant_catalog(monkeypatch):
    _catalog(monkeypatch, [("kensho-mcp", _CATALOG_URL, ["search"])])
    resp = await _generate("http://other-mcp.local.svc.cluster.local:8000/mcp")
    assert resp.status_code == 422, resp.text
    assert "catalog" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_generate_refuses_a_tool_the_server_does_not_advertise(monkeypatch):
    _catalog(monkeypatch, [("kensho-mcp", _CATALOG_URL, ["search"])])
    resp = await _generate(_CATALOG_URL, tool="admin_export")
    assert resp.status_code == 422, resp.text
    assert "not advertised" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_generate_fails_closed_when_the_catalog_cannot_be_read(monkeypatch):
    import httpx

    _catalog(monkeypatch, httpx.ConnectError("kagent unreachable"))
    resp = await _generate(_CATALOG_URL)
    assert resp.status_code == 502, resp.text
    assert resp.json()["detail"] == "kagent tool listing failed"


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", ["list_agents", "dispatch_to_agent", "create_agent"])
async def test_generate_refuses_agent_control_tools_even_when_advertised(monkeypatch, tool):
    _catalog(monkeypatch, [("agents-mcp", _CATALOG_URL, ["search", tool])])
    resp = await _generate(_CATALOG_URL, tool=tool)
    assert resp.status_code == 422, resp.text
    assert "cannot ground generation" in resp.json()["detail"]
