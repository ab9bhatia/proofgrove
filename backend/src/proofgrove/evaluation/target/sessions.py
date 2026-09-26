"""Capture an agent's tool calls from the kagent sessions API.

After invoking a declarative agent over A2A, the runtime persists the run as a
kagent session whose events are stringified Google ADK ``Event`` blobs. Each
event's ``content.parts`` may contain ``function_call`` (the tool the agent
invoked, with args) and ``function_response`` (the tool's output) entries. This
module fetches ``GET {kagent_url}/api/sessions/{session_id}`` using the invocation
identity and verifies session ownership before folding parts into ``ToolCall`` records.

Note: this is the declarative-agent path. BYO agents (e.g. kensho-grounding) run
their own loop and may not surface tool calls as ADK session events; that path is
handled additively in M3. When no trace is available the caller flags
``trace_unavailable`` rather than treating groundedness as passed.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import quote

import httpx

from proofgrove.evaluation.models import ToolCall

_SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,256}\Z")


def _decode_agent_id(agent_id: str) -> tuple[str, str] | None:
    """Reverse kagent's ``<namespace>__NS__<name>`` session agent_id encoding.

    kagent has been observed encoding the namespace half two ways -- with its
    hyphens turned to underscores, and left as-is -- while the name half is
    always underscore-encoded. Decoding both halves with the same `_` -> `-`
    replacement (mirroring kagent-sdk's ``decodeAgentId`` in
    services/ui/packages/kagent-sdk/src/types.ts) handles both: a namespace
    that was never encoded has no underscores to touch, so the replacement is
    a no-op and the literal value comes back unchanged. RFC1123 forbids
    underscores in Kubernetes names, so a real namespace/agent name never had
    one to begin with -- the decode cannot collide with a genuine value.

    Returns ``None`` when ``agent_id`` isn't in the expected two-part shape.
    """

    parts = agent_id.split("__NS__")
    if len(parts) != 2:
        return None
    return parts[0].replace("_", "-"), parts[1].replace("_", "-")


def parse_tool_calls_from_events(events: list[dict[str, Any]]) -> list[ToolCall]:
    """Fold kagent session events into ToolCall records (pure, testable).

    Each event carries a stringified ADK ``Event`` in ``data``. We walk
    ``content.parts`` collecting ``function_call`` entries (name + args) and match
    ``function_response`` entries (by call ``id`` when present, else by ``name``)
    to attach the tool output.
    """

    calls: list[ToolCall] = []
    # id/name -> index into `calls`, to attach responses to their call.
    by_id: dict[str, int] = {}
    by_name: dict[str, int] = {}

    for event in events:
        raw = event.get("data")
        if not isinstance(raw, str):
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        content = payload.get("content")
        if not isinstance(content, dict):
            continue
        parts = content.get("parts")
        if not isinstance(parts, list):
            continue
        for part in parts:
            if not isinstance(part, dict):
                continue
            fc = part.get("function_call")
            if isinstance(fc, dict) and isinstance(fc.get("name"), str):
                args = fc.get("args")
                call = ToolCall(
                    name=fc["name"],
                    args=args if isinstance(args, dict) else {},
                    result_captured=False,
                )
                calls.append(call)
                idx = len(calls) - 1
                call_id = fc.get("id")
                if isinstance(call_id, str) and call_id:
                    by_id[call_id] = idx
                by_name.setdefault(fc["name"], idx)
                continue
            fr = part.get("function_response")
            if isinstance(fr, dict) and isinstance(fr.get("name"), str):
                idx = None
                resp_id = fr.get("id")
                if isinstance(resp_id, str) and resp_id in by_id:
                    idx = by_id[resp_id]
                elif fr["name"] in by_name:
                    idx = by_name[fr["name"]]
                if idx is not None:
                    calls[idx].output = fr.get("response")
                    calls[idx].result_captured = True
    return calls


async def fetch_session_tool_calls(
    *,
    kagent_url: str,
    session_id: str,
    user_id: str,
    namespace: str,
    agent_name: str,
    timeout_seconds: float = 30.0,
) -> list[ToolCall]:
    """Fetch a kagent session and parse its tool calls.

    Returns an empty list when the session has no tool calls. Raises
    ``httpx.HTTPError`` on transport/HTTP failure; the caller decides whether to
    flag ``trace_unavailable``. Invalid identifiers or mismatched ownership raise
    ``ValueError`` and must likewise be treated as unavailable evidence.
    """

    if not _SESSION_ID.fullmatch(session_id) or not user_id or not namespace or not agent_name:
        raise ValueError("invalid session lookup identity")
    base = kagent_url.rstrip("/")
    url = f"{base}/api/sessions/{quote(session_id, safe='')}"
    async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=False) as client:
        response = await client.get(
            url, params={"user_id": user_id},
            headers={"Accept": "application/json", "X-User-ID": user_id},
        )
        response.raise_for_status()
        body = response.json()

    data = body.get("data") if isinstance(body, dict) else None
    session = data.get("session") if isinstance(data, dict) else None
    session_agent_id = session.get("agent_id") if isinstance(session, dict) else None
    decoded_agent = _decode_agent_id(session_agent_id) if isinstance(session_agent_id, str) else None
    if (
        not isinstance(session, dict)
        or (session.get("id"), session.get("user_id")) != (session_id, user_id)
        or decoded_agent != (namespace, agent_name)
    ):
        raise ValueError("session ownership does not match the invocation")
    events = data.get("events") if isinstance(data, dict) else None
    if not isinstance(events, list):
        raise ValueError("session returned no events array")
    return parse_tool_calls_from_events(events)
