"""Unit tests for MCP tool argument binding from free-text seeds."""

import pytest

from evalhub.generation.sources import bind_tool_arguments


def test_prefers_query_when_present():
    schema = {
        "type": "object",
        "properties": {"query": {"type": "string"}, "top_k": {"type": "integer"}},
        "required": ["query"],
    }
    assert bind_tool_arguments(schema, "Apple revenue") == {"query": "Apple revenue"}


def test_single_string_property_city():
    schema = {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    }
    assert bind_tool_arguments(schema, "Dubai") == {"city": "Dubai"}


def test_two_numeric_args_from_seed():
    schema = {
        "type": "object",
        "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
        "required": ["a", "b"],
    }
    assert bind_tool_arguments(schema, "2 and 3") == {"a": 2.0, "b": 3.0}


def test_two_numeric_args_requires_two_numbers():
    schema = {
        "type": "object",
        "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
        "required": ["a", "b"],
    }
    with pytest.raises(ValueError, match="at least two numbers"):
        bind_tool_arguments(schema, "just text")


def test_empty_schema_sends_no_args():
    """No-arg tools (list_agents) set additionalProperties:false — never invent query."""
    assert bind_tool_arguments(None, "hello") == {}
    assert bind_tool_arguments({"type": "object", "additionalProperties": False}, "hello") == {}


def test_dispatch_style_two_string_required():
    schema = {
        "type": "object",
        "properties": {
            "agent_name": {"type": "string"},
            "prompt": {"type": "string"},
        },
        "required": ["agent_name", "prompt"],
        "additionalProperties": False,
    }
    assert bind_tool_arguments(schema, "What is the weather?") == {
        "prompt": "What is the weather?",
        "agent_name": "What is the weather?",
    }


async def test_grounding_fetch_enforces_configured_deadline(monkeypatch):
    import asyncio
    from contextlib import asynccontextmanager

    import mcp
    import mcp.client.streamable_http
    import pytest

    from evalhub.generation.sources import McpToolGroundingSource

    @asynccontextmanager
    async def transport(*args, **kwargs):
        yield None, None, None

    class StalledSession:
        def __init__(self, *args):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def initialize(self):
            await asyncio.Event().wait()

    monkeypatch.setattr(mcp.client.streamable_http, "streamablehttp_client", transport)
    monkeypatch.setattr(mcp, "ClientSession", StalledSession)
    # The grounding URL is a literal address here so the connect-time
    # resolve+pin step has nothing to look up.
    from evalhub.evaluation.target import discovery
    from evalhub.evaluation.target.discovery import ToolServerSummary

    async def catalogued(**kwargs):  # noqa: ARG001 — the pair is in the tenant catalog
        return [ToolServerSummary(name="mcp", namespace="tenant-test", url="http://93.184.216.34/mcp", tools=["search"])]

    monkeypatch.setattr(discovery, "list_tenant_tool_servers", catalogued)
    source = McpToolGroundingSource(url="http://93.184.216.34/mcp", timeout_seconds=0.01)
    task = asyncio.create_task(source.fetch("q"))
    try:
        await asyncio.sleep(0.03)
        assert task.done(), "Configured grounding deadline was ignored"
        with pytest.raises(TimeoutError):
            await task
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
