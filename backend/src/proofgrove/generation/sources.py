"""Grounding sources for synthetic dataset generation.

A ``GroundingSource`` fetches real context material for a seed query. The
generator prompts an LLM with that material so generated golden rows are grounded
in actual data (not hallucinated). Agent-agnostic: the MCP source can call any
agent tool; Kensho ``search`` is just the first adapter.
"""

from __future__ import annotations

import asyncio
import json
import re
from functools import partial
from typing import Any, Protocol, runtime_checkable

import httpx

from proofgrove.errors import EvaluationInputError
from proofgrove.evaluation.target.catalog import resolve_agent_card_request
from proofgrove.evaluation.target.discovery import resolve_catalogued_grounding
from proofgrove.platform.url_guard import validate_outbound_url
from proofgrove.settings import settings


class _PinnedTransport(httpx.AsyncHTTPTransport):
    """Negotiate TLS for the DNS name while connecting to the pinned address.

    The card fetch passes ``sni_hostname`` per request; the MCP client owns its
    requests, so the extension is applied here instead.
    """

    def __init__(self, sni_hostname: str | None) -> None:
        super().__init__()
        self._sni_hostname = sni_hostname

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self._sni_hostname:
            request.extensions.setdefault("sni_hostname", self._sni_hostname)
        return await super().handle_async_request(request)


def _pinned_mcp_http_client(
    headers: dict[str, str] | None = None,
    timeout: httpx.Timeout | None = None,
    auth: httpx.Auth | None = None,
    *,
    extensions: dict[str, Any],
) -> httpx.AsyncClient:
    """The MCP client's ``httpx_client_factory``, minus redirects and proxies.

    A redirect could send the pinned connection anywhere, so it is refused as
    it is for the agent-card fetch; ``trust_env=False`` keeps an operator proxy
    variable from re-routing the tenant's endpoint.
    """
    return httpx.AsyncClient(
        headers=headers,
        timeout=timeout if timeout is not None else httpx.Timeout(30.0, read=300.0),
        auth=auth,
        follow_redirects=False,
        trust_env=False,
        transport=_PinnedTransport(extensions.get("sni_hostname")),
    )


@runtime_checkable
class GroundingSource(Protocol):
    """Fetches context material used to ground generated golden rows."""

    @property
    def tool_name(self) -> str:
        """The tool an agent is expected to call to answer questions from this
        source (recorded in each row's expected_actions). Empty for non-tool
        sources (e.g. a corpus)."""
        ...

    async def fetch(self, query: str) -> str:
        """Return context material for ``query`` as text."""
        ...


class McpToolGroundingSource:
    """Grounding via an MCP tool (e.g. kensho-mcp ``search``).

    Mirrors ``services/workflow-worker`` ``invoke_mcp_tool``: connect to the MCP
    server over Streamable HTTP and call the tool. Requires the ``generation``
    extra (``mcp`` package), imported lazily so the core service does not depend
    on it.

    Tool arguments are bound from the seed using the tool's ``inputSchema`` so
    mock-mcp tools (``city``, ``a``/``b``, …) work — not only Kensho's ``query``.
    """

    def __init__(
        self,
        *,
        url: str,
        tool: str = "search",
        arg_name: str = "query",
        tenant_namespace: str | None = None,
        extra_args: dict[str, Any] | None = None,
        timeout_seconds: float = 120.0,
    ) -> None:
        self._url = url
        # The namespace the job belongs to; decides which ``.svc.cluster.local``
        # names are the tenant's own. Empty falls back to the pod's.
        self._tenant_namespace = tenant_namespace or settings.pod_namespace or ""
        self._tool = tool
        self._arg_name = arg_name
        self._extra_args = extra_args or {}
        self._timeout = timeout_seconds

    @property
    def tool_name(self) -> str:
        return self._tool

    async def fetch(self, query: str) -> str:
        # Lazy imports: the mcp client is an optional (generation) dependency.
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        # The platform memory tools are attached to every in-tenant MCP surface
        # and are excluded from evaluation everywhere else (discovery, the
        # captured trace). Grounding calls the tool as the Proofgrove workload
        # with no user identity, so it must not be a way to read or write
        # tenant memories either. Checked here, not only at the API, because a
        # job row is the only input this worker trusts.
        if self._tool in settings.excluded_tool_names:
            raise EvaluationInputError(f"MCP tool {self._tool!r} is a platform memory tool and cannot ground generation")
        # A job row is the only input this worker trusts, so the URL is judged
        # here in full, not only where a route enqueued it: the literal form
        # and tenant namespace first (``validate_outbound_url`` -- private and
        # metadata literals, another tenant's ``.svc.cluster.local`` name),
        # then a fresh resolve-and-block. The pin helper assumes that first
        # step already ran: it passes IP literals through and allows private
        # addresses for any cluster name. Connecting to the checked address
        # rather than letting the client resolve the name again closes the
        # window between the check and the connection -- the same pattern the
        # agent-card fetch uses (``resolve_agent_card_request`` / ``pinned_request_url``).
        normalized = await validate_outbound_url(self._url, tenant_namespace=self._tenant_namespace)
        # Catalog membership is checked again here, after queueing: the pair
        # must be a tool server in this tenant's catalog and a tool it
        # advertises at the moment of connection, not only at submission.
        # A discovery failure propagates -- an unverifiable pair is not called.
        await resolve_catalogued_grounding(
            kagent_url=settings.kagent_url,
            namespace=self._tenant_namespace,
            excluded_tools=settings.excluded_tool_names,
            url=normalized,
            tool=self._tool,
        )
        request_url, headers, extensions = await resolve_agent_card_request(normalized)
        headers.pop("Accept", None)  # the MCP client sets its own Accept
        async with asyncio.timeout(self._timeout):
            async with streamablehttp_client(
                request_url,
                headers=headers,
                httpx_client_factory=partial(_pinned_mcp_http_client, extensions=extensions),
            ) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    listed = await session.list_tools()
                    tool_meta = next((t for t in listed.tools if t.name == self._tool), None)
                    if tool_meta is None:
                        available = sorted(t.name for t in listed.tools)
                        raise EvaluationInputError(
                            f"MCP tool {self._tool!r} not found at {self._url}; "
                            f"available: {available or '(none)'}"
                        )
                    schema = getattr(tool_meta, "inputSchema", None) or {}
                    arguments = {
                        **bind_tool_arguments(schema, query, preferred_arg=self._arg_name),
                        **self._extra_args,
                    }
                    result = await session.call_tool(self._tool, arguments=arguments)

        if getattr(result, "isError", False):
            # The server's text is foreign to this service: not tenant evidence.
            raise ValueError(f"MCP tool {self._tool!r} returned an error: {_tool_result_to_text(result)}")
        return _tool_result_to_text(result)




# Property names that usually carry the free-text seed / user question.
_SEED_ARG_NAMES = frozenset(
    {"query", "prompt", "message", "text", "city", "q", "question", "input"}
)


def bind_tool_arguments(
    input_schema: dict[str, Any] | None,
    seed: str,
    *,
    preferred_arg: str = "query",
) -> dict[str, Any]:
    """Map a free-text seed onto an MCP tool's JSON-schema arguments.

    Heuristics (in order):
    1. No properties → ``{}`` (no-arg tools like ``list_agents``; do **not**
       invent a ``query`` field — many schemas set ``additionalProperties: false``).
    2. Prefer ``preferred_arg`` when that property exists (Kensho ``query``).
    3. Single required/available property → coerce seed into that type.
    4. Two numeric properties → parse two numbers from the seed (``2 and 3``).
    5. Put the seed in the best string property (prompt/query/city/…); fill any
       other required string properties with the same seed so the call is valid.
    """

    schema = input_schema or {}
    props: dict[str, Any] = dict(schema.get("properties") or {})
    required: list[str] = [str(r) for r in (schema.get("required") or []) if r]

    if not props:
        return {}

    if preferred_arg in props:
        return {preferred_arg: _coerce_value(seed, props[preferred_arg])}

    keys = required or list(props.keys())
    if len(keys) == 1:
        key = keys[0]
        return {key: _coerce_value(seed, props.get(key, {}))}

    if len(keys) >= 2 and all(_is_number_schema(props.get(k, {})) for k in keys[:2]):
        nums = _parse_numbers(seed)
        if len(nums) < 2:
            raise EvaluationInputError(
                f"tool expects numeric args {keys[:2]}; "
                f"seed {seed!r} must contain at least two numbers (e.g. '2 and 3')"
            )
        return {keys[0]: nums[0], keys[1]: nums[1]}

    seed_key = next(
        (k for k in keys if k.lower() in _SEED_ARG_NAMES and _is_string_schema(props.get(k, {}))),
        next((k for k in keys if _is_string_schema(props.get(k, {}))), None),
    )
    if seed_key is None:
        first = keys[0]
        return {first: _coerce_value(seed, props.get(first, {}))}

    bound: dict[str, Any] = {seed_key: seed}
    # Satisfy additional required string fields (e.g. dispatch_to_agent's agent_name)
    # so the MCP call is schema-valid; the LLM still sees whatever the tool returns.
    for key in required:
        if key in bound:
            continue
        prop = props.get(key, {})
        if _is_string_schema(prop):
            bound[key] = seed
    return bound


def _is_number_schema(prop: dict[str, Any]) -> bool:
    t = prop.get("type")
    if isinstance(t, list):
        return "number" in t or "integer" in t
    return t in ("number", "integer")


def _is_string_schema(prop: dict[str, Any]) -> bool:
    t = prop.get("type")
    if t is None:
        return True
    if isinstance(t, list):
        return "string" in t
    return t == "string"


def _coerce_value(seed: str, prop: dict[str, Any]) -> Any:
    if _is_number_schema(prop):
        nums = _parse_numbers(seed)
        if not nums:
            raise EvaluationInputError(f"expected a number in seed {seed!r}")
        if prop.get("type") == "integer" or (
            isinstance(prop.get("type"), list) and "integer" in prop["type"] and "number" not in prop["type"]
        ):
            return int(nums[0])
        return nums[0]
    return seed


def _parse_numbers(seed: str) -> list[float]:
    return [float(m) for m in re.findall(r"[-+]?\d+(?:\.\d+)?", seed)]


def _tool_result_to_text(result: Any) -> str:
    """Render an MCP CallToolResult into text for the generator prompt.

    Prefers structured content; falls back to concatenated text content blocks.
    """

    try:
        dumped = result.model_dump(mode="json", by_alias=True)
    except AttributeError:
        return str(result)

    structured = dumped.get("structuredContent")
    if structured is not None:
        return json.dumps(structured, ensure_ascii=False, default=str)

    chunks: list[str] = []
    for block in dumped.get("content", []) or []:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            chunks.append(block["text"])
    if chunks:
        return "\n".join(chunks)
    return json.dumps(dumped, ensure_ascii=False, default=str)
