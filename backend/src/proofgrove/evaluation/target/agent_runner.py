"""Run a golden row against a live kagent agent and capture response + trace.

Ties together the A2A invocation (final answer + contextId) and the sessions-API
tool-call capture (groundedness). The engine/wiring calls :func:`run_agent_target`
per row; mapping into an ``EvaluationRow`` (response, tool_calls, context) lives in
the dataset bridge.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from uuid import uuid4

import httpx

from proofgrove.evaluation.enums import ProvenanceStatus
from proofgrove.evaluation.models import ToolCall, ToolResultArtifact
from proofgrove.evaluation.target.a2a_client import (
    AgentInvocationError,
    externalize_large_tool_results,
    invoke_agent,
)
from proofgrove.evaluation.target.external import (
    EXTERNAL_PREFIX,
    credential_headers,
    invocation_endpoint,
    resolve_external_target,
)
from proofgrove.evaluation.target.sessions import fetch_session_tool_calls
from proofgrove.platform.contracts import TargetVersion
from proofgrove.settings import Settings

logger = logging.getLogger(__name__)


@dataclass
class AgentRunOutput:
    """Everything captured from one live-agent row execution."""

    response: str
    invocation_id: str | None = None
    trace_id: str | None = None
    span_id: str | None = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_result_artifacts: list[ToolResultArtifact] = field(default_factory=list)
    latency_seconds: float = 0.0
    context_id: str | None = None
    target_usage: dict | None = None
    # True when we could not obtain a tool-call trace at all (no contextId, or the
    # session fetch failed) — distinct from "trace available, agent used no tools"
    # (which is a real, gradeable groundedness signal).
    trace_unavailable: bool = False
    tool_evidence_completion_attested: bool = False
    tool_evidence_provenance_status: ProvenanceStatus = ProvenanceStatus.UNAVAILABLE
    tool_evidence_source: str | None = None


def _parse_agent_target(target_endpoint: str, default_namespace: str) -> tuple[str, str]:
    """Resolve (namespace, agent_name) from a target endpoint.

    Accepts ``"<namespace>/<name>"`` (the evalai-agent-ui convention) or a bare
    ``"<name>"`` (scoped to the service's own tenant namespace).
    """

    ref = target_endpoint.strip()
    if "/" in ref:
        namespace, _, name = ref.partition("/")
        return namespace or default_namespace, name
    return default_namespace, ref


async def run_agent_target(
    *,
    settings: Settings,
    target_endpoint: str,
    query: str,
    invocation_id: str | None = None,
    trace_attributes: Mapping[str, str] | None = None,
    resolved_external_target: TargetVersion | None = None,
    resolved_local_model: dict[str, str] | None = None,
) -> AgentRunOutput:
    """Invoke the agent named by ``target_endpoint`` with ``query``.

    ``target_endpoint`` is ``"<namespace>/<name>"`` or ``"<name>"`` (defaults to
    ``settings.pod_namespace``). Returns the final answer, captured tool calls,
    latency, and a ``trace_unavailable`` flag.

    ``resolved_external_target``, when given, is used instead of re-resolving
    the ``external:<id>`` catalog reference. A run fans out many rows against
    the SAME target_endpoint concurrently; without this, every row opens its
    own DB session in ``resolve_external_target`` purely to look up a target
    that every other row already resolved to the identical row. Callers that
    fan out (``run_service._run_agent_rows``) resolve once up front and pass
    the result down.
    """

    # Local references are a fixed code-owned registry, never caller-supplied URLs.
    if target_endpoint.startswith("local:"):
        from proofgrove.evaluation.target.local_workflows import run_local_workflow

        return await run_local_workflow(
            settings=settings, target_endpoint=target_endpoint, query=query,
            invocation_id=invocation_id, trace_attributes=trace_attributes,
            resolved_local_model=resolved_local_model,
        )
    namespace, agent_name = _parse_agent_target(target_endpoint, settings.pod_namespace)
    external = target_endpoint.startswith(EXTERNAL_PREFIX)
    if not external and namespace != settings.pod_namespace:
        # target_endpoint is tenant-controlled (an experiment field), and
        # Proofgrove is deployed one instance per tenant. A "<namespace>/<name>"
        # spelling naming a DIFFERENT tenant's namespace must not reach
        # kagent — this service has no business invoking another tenant's
        # agents. External catalog targets are exempt: they're resolved by
        # id against this tenant's own catalog (resolve_external_target),
        # never by a caller-supplied namespace.
        raise AgentInvocationError(
            f"target namespace {namespace!r} does not match this tenant's namespace {settings.pod_namespace!r}"
        )
    external_options = {}
    if external:
        target = resolved_external_target or await resolve_external_target(target_endpoint, settings)
        namespace, agent_name = settings.pod_namespace, target.name
        endpoint = invocation_endpoint(target, namespace)
        external_options = {
            "external_endpoint": endpoint,
            "credential_headers": credential_headers(settings, target.configuration.get("credential_ref"), endpoint),
        }

    # Each invocation owns only its fresh kagent session, never a shared default user.
    session_user_id = None if external else f"proofgrove:{namespace}:{uuid4().hex}"
    invocation = await invoke_agent(
        kagent_url=settings.kagent_url,
        namespace=namespace,
        agent_name=agent_name,
        prompt=query,
        timeout_seconds=settings.agent_invocation_timeout_seconds,
        connect_timeout_seconds=settings.agent_connect_timeout_seconds,
        max_response_bytes=settings.agent_response_max_bytes,
        max_event_bytes=settings.agent_response_max_event_bytes,
        max_inline_tool_result_bytes=settings.agent_max_inline_tool_result_bytes,
        invocation_id=invocation_id,
        trace_attributes=trace_attributes,
        session_user_id=session_user_id,
        **external_options,
    )

    tool_calls: list[ToolCall] = []
    tool_result_artifacts = list(invocation.tool_result_artifacts)
    reported_inline = bool(invocation.tool_calls)
    trace_unavailable = False
    completion_attested = False
    evidence_status = ProvenanceStatus.UNAVAILABLE
    evidence_source: str | None = None
    if invocation.tool_calls:
        # BYO agent reported its tool calls inline via A2A metadata
        # (evalai.ai/tool-calls) — preferred, no sessions lookup needed.
        tool_calls = invocation.tool_calls
        evidence_status = ProvenanceStatus.SELF_REPORTED
        evidence_source = "target A2A metadata"
    elif invocation.context_id and not external:
        # Declarative agent: tool calls are persisted as kagent session events.
        try:
            tool_calls = await fetch_session_tool_calls(
                kagent_url=settings.kagent_url,
                session_id=invocation.context_id,
                user_id=session_user_id,
                namespace=namespace,
                agent_name=agent_name,
                timeout_seconds=settings.agent_connect_timeout_seconds,
            )
            evidence_status = ProvenanceStatus.SELF_REPORTED
            evidence_source = "kagent session events"
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning(
                "proofgrove: session tool-call fetch failed: %s",
                type(exc).__name__,
            )
            trace_unavailable = True
    else:
        # No inline tool calls and no session id — we cannot verify tool use
        # (e.g. a BYO agent that does not adopt the evalai.ai/tool-calls convention).
        trace_unavailable = True

    # Drop platform tools attached to every agent (memory-mcp): they are not under
    # test and must not count toward tool_selection or feed faithfulness context.
    tool_calls = _filter_excluded(tool_calls, settings.excluded_tool_names)
    if not reported_inline:
        tool_calls, fetched_artifacts = externalize_large_tool_results(
            tool_calls,
            max_inline_bytes=settings.agent_max_inline_tool_result_bytes,
        )
        tool_result_artifacts.extend(fetched_artifacts)

    return AgentRunOutput(
        response=invocation.text,
        invocation_id=invocation.invocation_id,
        trace_id=invocation.trace_id,
        span_id=invocation.span_id,
        tool_calls=tool_calls,
        tool_result_artifacts=tool_result_artifacts,
        latency_seconds=invocation.latency_seconds,
        context_id=invocation.context_id,
        target_usage=invocation.usage,
        trace_unavailable=trace_unavailable,
        tool_evidence_completion_attested=completion_attested,
        tool_evidence_provenance_status=evidence_status,
        tool_evidence_source=evidence_source,
    )


def _filter_excluded(tool_calls: list[ToolCall], excluded: list[str]) -> list[ToolCall]:
    """Remove tool calls whose name is in the excluded set (case-insensitive)."""

    if not excluded:
        return tool_calls
    blocked = {name.strip().lower() for name in excluded if name.strip()}
    return [tc for tc in tool_calls if tc.name.strip().lower() not in blocked]
