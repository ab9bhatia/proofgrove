"""Discover the Proofgrove/kagent agents a user can evaluate.

Mirrors evalai-agent-ui's catalog view: GET ``{kagent_url}/api/agents`` (keyless,
like ``@evalai/kagent-sdk``) and filter to the service's own tenant namespace
(``POD_NAMESPACE``). Agent-agnostic — every ready agent in the tenant is a
candidate target; nothing is hardcoded to a specific agent.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, Field

from evalhub.evaluation.target.catalog import AgentCatalogError

logger = logging.getLogger(__name__)


class AgentSummary(BaseModel):
    """A selectable evaluation target agent.

    ``id`` is the ``"<namespace>/<name>"`` reference used as an experiment's
    ``target_endpoint`` (the evalai-agent-ui convention).
    """

    id: str
    name: str
    namespace: str
    display_name: str | None = None
    description: str = ""
    ready: bool = False
    accepted: bool = False
    model: str | None = None
    agent_type: str | None = None  # "Declarative" | "BYO"
    # Stable fingerprint of the discovered Agent generation/spec. Eval Hub uses
    # this to create a new immutable catalog target only when the platform agent
    # actually changes; repeated page refreshes remain idempotent.
    revision: str
    # MCP tool names declared on the agent, minus platform tools (memory-mcp). Only
    # populated for Declarative agents (BYO agents do not declare tools in the CR),
    # and used as hints when the user picks a grounding tool for generation.
    tools: list[str] = Field(default_factory=list)
    # Derived in-cluster MCP endpoint of the agent's first non-memory tool server,
    # used to pre-fill the grounding URL for synthetic dataset generation. Built by
    # the RemoteMCPServer convention (see _grounding_url). None for BYO agents
    # (no declared tools) — the user supplies it manually there.
    grounding_url: str | None = None
    # Tenant *system* Project bound to this logical target (+ environment), when a
    # TargetProjectBinding exists. Lets the evaluate flow infer a system Project
    # from the selected agent. None when unbound — the caller must choose a Project
    # explicitly rather than defaulting to the internal catalog_registry Project.
    system_project_id: str | None = None


# Proofgrove RemoteMCPServer convention: <server>.<ns>.svc.cluster.local:8080/mcp
# (e.g. kensho-mcp chart stamps exactly this). Used to pre-fill the generation
# grounding URL; it is editable in the UI for any server that diverges.
_MCP_PORT = 8080
_MCP_PATH = "/mcp"


def _declarative_tools(spec: dict[str, Any], excluded: set[str]) -> tuple[list[str], str | None]:
    """Extract (tool names, grounding server name) from a Declarative agent's spec.

    kagent shape: spec.declarative.tools[].mcpServer.{name, toolNames[]}. Returns
    the non-excluded tool names (order-preserving, de-duplicated) and the name of
    the first MCP server that contributes any non-excluded tool (the memory-mcp
    server is skipped because all its tools are excluded). BYO agents have no
    spec.declarative, so this returns ([], None).
    """

    declarative = spec.get("declarative")
    if not isinstance(declarative, dict):
        return [], None
    names: list[str] = []
    grounding_server: str | None = None
    for tool in declarative.get("tools") or []:
        if not isinstance(tool, dict):
            continue
        mcp = tool.get("mcpServer")
        if not isinstance(mcp, dict):
            continue
        kept = [t for t in (mcp.get("toolNames") or []) if isinstance(t, str) and t.lower() not in excluded]
        if kept and grounding_server is None:
            server = mcp.get("name")
            if isinstance(server, str) and server:
                grounding_server = server
        for tool_name in kept:
            if tool_name not in names:
                names.append(tool_name)
    return names, grounding_server


def _grounding_url(server: str | None, namespace: str) -> str | None:
    if not server:
        return None
    return f"http://{server}.{namespace}.svc.cluster.local:{_MCP_PORT}{_MCP_PATH}"


class ToolServerSummary(BaseModel):
    """An MCP tool server available in the tenant, as a grounding source.

    ``url`` is the in-cluster MCP endpoint (RemoteMCPServer convention) used to
    pre-fill synthetic-generation grounding; ``tools`` are its non-excluded tool
    names. Lets the UI offer a grounding-server picker that works for any agent
    (including BYO agents, whose grounding source is a tenant MCP server rather
    than something declared on the agent).
    """

    name: str
    namespace: str
    url: str
    tools: list[str] = Field(default_factory=list)


async def list_tenant_tool_servers(
    *,
    kagent_url: str,
    namespace: str,
    excluded_tools: list[str] | None = None,
    timeout_seconds: float = 30.0,
) -> list[ToolServerSummary]:
    """List MCP tool servers in ``namespace`` via kagent ``GET /api/tools``.

    Groups the flat (server, tool) list by server, drops excluded tools (memory),
    and omits servers left with no tools (e.g. the memory-mcp server). Returns an
    empty list when ``namespace`` is unset. Raises ``httpx.HTTPError`` on failure.
    """

    if not namespace:
        return []
    excluded = {t.strip().lower() for t in (excluded_tools or []) if t.strip()}
    base = kagent_url.rstrip("/")
    async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=False) as client:
        response = await client.get(f"{base}/api/tools", headers={"Accept": "application/json"})
        response.raise_for_status()
        body = response.json()

    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, list):
        return []

    by_server: dict[str, list[str]] = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        server_name = item.get("server_name")
        tool_id = item.get("id")
        if not isinstance(server_name, str):
            continue
        ns, server = server_name.split("/", 1) if "/" in server_name else ("", server_name)
        if ns != namespace or not server:
            continue
        tools = by_server.setdefault(server, [])
        if isinstance(tool_id, str) and tool_id and tool_id.lower() not in excluded and tool_id not in tools:
            tools.append(tool_id)

    servers: list[ToolServerSummary] = []
    for server, tools in sorted(by_server.items()):
        if not tools:  # e.g. the memory-mcp server (all tools excluded)
            continue
        url = f"http://{server}.{namespace}.svc.cluster.local:{_MCP_PORT}{_MCP_PATH}"
        servers.append(ToolServerSummary(name=server, namespace=namespace, url=url, tools=tools))
    return servers


def _same_endpoint(left: str, right: str) -> bool:
    """Scheme, host, port and path equal after the normalization both sides get."""
    a, b = urlsplit(left.strip()), urlsplit(right.strip())

    def port(u):
        return u.port or (443 if u.scheme == "https" else 80)

    return (a.scheme.lower(), (a.hostname or "").lower().rstrip("."), port(a), a.path.rstrip("/")) == (
        b.scheme.lower(), (b.hostname or "").lower().rstrip("."), port(b), b.path.rstrip("/")
    )


#: Tools a tenant tool server may advertise that must never ground generation:
#: they create, enumerate or drive the tenant's agents, and grounding runs as the Eval
#: Hub workload with no user identity. Specific to grounding on purpose --
#: ``excluded_tool_names`` also shapes evaluation evidence and readiness.
GROUNDING_BLOCKED_TOOLS = frozenset({"list_agents", "dispatch_to_agent", "create_agent"})


async def resolve_catalogued_grounding(
    *,
    kagent_url: str,
    namespace: str,
    excluded_tools: list[str] | None,
    url: str,
    tool: str,
) -> ToolServerSummary:
    """The tenant catalog entry that advertises ``(url, tool)``, or refuse.

    Grounding may only call a tool server the tenant's own catalog lists
    (``list_tenant_tool_servers``: this namespace, memory tools already
    dropped) and only a tool that server advertises. A supplied URL or tool
    name is not permission on its own. Raises ``AgentCatalogError`` for a pair
    the catalog does not contain and lets a discovery failure propagate, so a
    caller that cannot verify the pair does not connect.
    """
    if tool in GROUNDING_BLOCKED_TOOLS:
        raise AgentCatalogError(f"MCP tool {tool!r} creates, dispatches or enumerates agents and cannot ground generation")
    servers = await list_tenant_tool_servers(kagent_url=kagent_url, namespace=namespace, excluded_tools=excluded_tools)
    for server in servers:
        if _same_endpoint(server.url, url):
            if tool in server.tools:
                return server
            raise AgentCatalogError(f"MCP tool {tool!r} is not advertised by the tenant tool server {server.name!r}")
    raise AgentCatalogError("grounding_url is not a tool server in this tenant's catalog")


def _map_entry(entry: dict[str, Any], excluded: set[str]) -> AgentSummary | None:
    """Map one kagent ``/api/agents`` data entry to an AgentSummary."""

    agent = entry.get("agent")
    if not isinstance(agent, dict):
        return None
    metadata = agent.get("metadata")
    if not isinstance(metadata, dict):
        return None
    name = metadata.get("name")
    namespace = metadata.get("namespace")
    if not isinstance(name, str) or not isinstance(namespace, str):
        return None
    spec = agent.get("spec") if isinstance(agent.get("spec"), dict) else {}
    annotations = metadata.get("annotations") if isinstance(metadata.get("annotations"), dict) else {}
    tools, grounding_server = _declarative_tools(spec, excluded)
    revision_payload = {
        "uid": metadata.get("uid"),
        "generation": metadata.get("generation"),
        "spec": spec,
    }
    revision = hashlib.sha256(json.dumps(revision_payload, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()[:16]
    return AgentSummary(
        id=f"{namespace}/{name}",
        name=name,
        namespace=namespace,
        display_name=annotations.get("evalai.ai/display-name"),
        description=entry.get("description") or spec.get("description") or "",
        ready=bool(entry.get("deploymentReady")),
        accepted=bool(entry.get("accepted")),
        model=entry.get("model"),
        agent_type=spec.get("type"),
        revision=revision,
        tools=tools,
        grounding_url=_grounding_url(grounding_server, namespace),
    )


async def list_tenant_agents(
    *,
    kagent_url: str,
    namespace: str,
    ready_only: bool = False,
    excluded_tools: list[str] | None = None,
    timeout_seconds: float = 30.0,
) -> list[AgentSummary]:
    """List agents in ``namespace`` via the kagent controller REST API.

    ``excluded_tools`` are dropped from each agent's ``tools`` (the memory-mcp
    tools attached to every agent). Returns an empty list when ``namespace`` is
    unset (e.g. outside a cluster). Raises ``httpx.HTTPError`` on failure.
    """

    if not namespace:
        logger.warning("eval-hub: agent discovery skipped — POD_NAMESPACE is unset")
        return []

    excluded = {t.strip().lower() for t in (excluded_tools or []) if t.strip()}
    base = kagent_url.rstrip("/")
    async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=False) as client:
        response = await client.get(f"{base}/api/agents", headers={"Accept": "application/json"})
        response.raise_for_status()
        body = response.json()

    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, list):
        return []

    agents: list[AgentSummary] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        summary = _map_entry(entry, excluded)
        if summary is None or summary.namespace != namespace:
            continue
        if ready_only and not summary.ready:
            continue
        agents.append(summary)
    return agents
