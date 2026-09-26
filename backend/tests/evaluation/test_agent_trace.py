"""Tests for kagent session tool-call parsing (groundedness trace capture)."""

import json

import pytest
import respx

from proofgrove.evaluation.target.sessions import fetch_session_tool_calls, parse_tool_calls_from_events


def _event(parts: list[dict]) -> dict:
    """Wrap ADK content parts in a stringified session event (as kagent stores it)."""
    return {"data": json.dumps({"author": "agent", "content": {"parts": parts}})}


def test_parse_function_call_and_response_matched_by_id():
    events = [
        _event([{"function_call": {"id": "c1", "name": "search", "args": {"q": "AAPL"}}}]),
        _event([{"function_response": {"id": "c1", "name": "search", "response": {"hits": 3}}}]),
    ]
    calls = parse_tool_calls_from_events(events)
    assert len(calls) == 1
    assert calls[0].name == "search"
    assert calls[0].args == {"q": "AAPL"}
    assert calls[0].output == {"hits": 3}
    assert calls[0].result_captured is True


def test_parse_matches_response_by_name_when_no_id():
    events = [
        _event([{"function_call": {"name": "lookup", "args": {}}}]),
        _event([{"function_response": {"name": "lookup", "response": "done"}}]),
    ]
    calls = parse_tool_calls_from_events(events)
    assert len(calls) == 1
    assert calls[0].name == "lookup"
    assert calls[0].output == "done"


def test_parse_multiple_calls_and_ignores_text_parts():
    events = [
        _event([{"text": "thinking..."}]),
        _event([{"function_call": {"name": "search", "args": {"q": "a"}}}]),
        _event([{"function_call": {"name": "search", "args": {"q": "b"}}}]),
    ]
    calls = parse_tool_calls_from_events(events)
    assert [c.name for c in calls] == ["search", "search"]
    assert calls[0].output is None  # no response part
    assert calls[0].result_captured is False


def test_parse_preserves_captured_json_null_response():
    events = [
        _event([{"function_call": {"id": "c1", "name": "delete", "args": {}}}]),
        _event([{"function_response": {"id": "c1", "name": "delete", "response": None}}]),
    ]

    calls = parse_tool_calls_from_events(events)

    assert calls[0].output is None
    assert calls[0].result_captured is True


def test_parse_tolerates_malformed_events():
    events = [
        {"data": "not-json"},
        {"data": json.dumps({"content": {}})},
        {"nope": "no-data-key"},
        _event([{"function_call": {"name": "ok", "args": {}}}]),
    ]
    calls = parse_tool_calls_from_events(events)
    assert [c.name for c in calls] == ["ok"]


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_field", [None, "id", "user_id", "agent_id", "missing_session", "missing_events"])
@respx.mock
async def test_session_lookup_checks_ownership_before_reading_events(bad_field):
    session = {"id": "session-1", "user_id": "proofgrove:tenant-a:random", "agent_id": "tenant_a__NS__my_agent"}
    data = {"session": session, "events": [_event([{"function_call": {"name": "search", "args": {}}}])]}
    if bad_field in session:
        session[bad_field] = "foreign"
    elif bad_field == "missing_session":
        data.pop("session")
    elif bad_field == "missing_events":
        data.pop("events")
    route = respx.get("http://kagent/api/sessions/session-1", params={"user_id": "proofgrove:tenant-a:random"}).respond(200, json={"data": data})
    args = dict(kagent_url="http://kagent", session_id="session-1", user_id="proofgrove:tenant-a:random", namespace="tenant-a", agent_name="my-agent")
    if bad_field:
        with pytest.raises(ValueError):
            await fetch_session_tool_calls(**args)
    else:
        assert [call.name for call in await fetch_session_tool_calls(**args)] == ["search"]
    assert route.calls.last.request.headers["X-User-ID"] == "proofgrove:tenant-a:random"


@pytest.mark.asyncio
@pytest.mark.parametrize("session_id", ["../foreign", "..", "other?user_id=foreign", "other#fragment", "a%2fb", "", "a" * 257])
@respx.mock
async def test_session_lookup_rejects_unsafe_ids_before_http(session_id):
    with pytest.raises(ValueError, match="invalid session lookup identity"):
        await fetch_session_tool_calls(kagent_url="http://kagent", session_id=session_id, user_id="owner", namespace="tenant-a", agent_name="agent")
    assert not respx.calls


# kagent has been observed encoding the session agent_id two ways: the whole
# "namespace/name" string with every hyphen turned to underscore (R5's
# original behaviour), and a mixed form where only the name half is
# underscore-encoded and the namespace keeps its hyphens. Ownership must
# accept both -- and still reject a foreign agent, a foreign namespace, and
# an agent_id with no "__NS__" separator at all.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("agent_id", "namespace", "agent_name", "should_match"),
    [
        # 1. underscore-namespace encoding (namespace hyphens -> underscores too)
        ("tenant_a__NS__my_agent", "tenant-a", "my-agent", True),
        # 2. hyphen-namespace encoding (namespace hyphens kept as-is)
        ("tenant-contoso1__NS__expense_coach", "tenant-contoso1", "expense-coach", True),
        # 3. foreign agent name rejected
        ("tenant_a__NS__other_agent", "tenant-a", "my-agent", False),
        # 4. foreign namespace rejected
        ("tenant_other__NS__my_agent", "tenant-a", "my-agent", False),
        ("tenant-other__NS__my_agent", "tenant-a", "my-agent", False),
        # 6. missing "__NS__" separator rejected
        ("tenant_a-my_agent", "tenant-a", "my-agent", False),
    ],
)
@respx.mock
async def test_session_lookup_agent_id_ownership_decodes_both_encodings(agent_id, namespace, agent_name, should_match):
    session = {"id": "session-1", "user_id": "owner", "agent_id": agent_id}
    data = {"session": session, "events": [_event([{"function_call": {"name": "search", "args": {}}}])]}
    respx.get("http://kagent/api/sessions/session-1", params={"user_id": "owner"}).respond(200, json={"data": data})
    args = dict(kagent_url="http://kagent", session_id="session-1", user_id="owner", namespace=namespace, agent_name=agent_name)
    if should_match:
        assert [call.name for call in await fetch_session_tool_calls(**args)] == ["search"]
    else:
        with pytest.raises(ValueError, match="session ownership does not match the invocation"):
            await fetch_session_tool_calls(**args)
