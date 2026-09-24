"""A2A client for invoking a kagent ``Agent`` as an evaluation target.

Mirrors ``services/workflow-worker``'s ``invoke_agent`` activity — the platform
precedent for calling kagent from Python: hand-rolled ``httpx`` + ``httpx-sse``,
POST JSON-RPC ``message/stream`` to
``{kagent_url}/api/a2a/<namespace>/<agent>/``, no auth (the in-cluster gateway is
keyless; the agent itself reaches the AI Gateway via its ModelConfig). The
status/artifact SSE frames are aggregated into a single reply using the same
v0.9-aware two-buffer model as the worker.

Differences from the worker: no Temporal heartbeat/ApplicationError plumbing, and
we additionally surface the ``contextId`` from the stream so the caller can fetch
the session's tool-call events afterwards (groundedness).
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx
from httpx_sse import aconnect_sse

from evalhub.errors import TenantVisibleError
from evalhub.evaluation.models import ToolCall, ToolResultArtifact
from evalhub.evaluation.openinference import content_attributes
from evalhub.evaluation.target.catalog import normalize_agent_endpoint, resolve_agent_card_request
from evalhub.evaluation.target.invocation_span import (
    GEN_AI_OPERATION_NAME,
    OPENINFERENCE_SPAN_KIND,
    evaluation_root_span,
)

# A2A message metadata key a BYO agent uses to report the tool calls it made, so
# Eval Hub can score groundedness for agents whose tool calls are not visible via
# the kagent sessions API (declarative-only). Raw extension key — not namespaced
# through get_kagent_metadata_key.
TOOL_CALLS_METADATA_KEY = "evalai.ai/tool-calls"


class AgentInvocationError(RuntimeError, TenantVisibleError):
    """Raised when an agent invocation fails (transport, HTTP, or JSON-RPC error).

    Tenant-visible: every message here is authored. Transport failures carry
    the exception type, never ``str(exc)`` (an httpx message can echo the URL
    and connection detail); upstream response bodies are reduced to a status.
    """


class AgentOutputTooLargeError(AgentInvocationError):
    """Bounded-resource failure: the A2A/SSE stream exceeded the response budget.

    Non-retryable. Callers should mark the row ``AGENT_OUTPUT_TOO_LARGE`` and
    continue the experiment rather than aborting the whole run.
    """

    error_type = "AGENT_OUTPUT_TOO_LARGE"
    retryable = False

    def __init__(
        self,
        *,
        limit_bytes: int,
        received_bytes: int,
        partial_text: str = "",
        context_id: str | None = None,
        last_event_type: str | None = None,
        frames_collected: int = 0,
    ) -> None:
        self.limit_bytes = limit_bytes
        self.received_bytes = received_bytes
        self.partial_text = partial_text
        self.context_id = context_id
        self.last_event_type = last_event_type
        self.frames_collected = frames_collected
        limit_mib = limit_bytes / (1024 * 1024)
        super().__init__(
            "AGENT_OUTPUT_TOO_LARGE: Agent transport exceeded the "
            f"{limit_mib:.1f} MiB safety envelope."
        )

    def to_diagnostics(self) -> dict[str, Any]:
        """Structured diagnostics suitable for row ``output_data`` / tags."""

        return {
            "status": "failed",
            "error_type": self.error_type,
            "limit_bytes": self.limit_bytes,
            "received_bytes": self.received_bytes,
            "stage": "agent_transport",
            "retryable": self.retryable,
            "partial_output_available": bool(self.partial_text.strip()),
            "last_event_type": self.last_event_type,
            "frames_collected": self.frames_collected,
        }


@dataclass
class AgentInvocation:
    """Result of invoking an agent over A2A.

    Attributes
    ----------
    text : str
        The agent's final answer (artifact body, or aggregated status text).
    context_id : str | None
        The A2A ``contextId`` (kagent session id) observed in the stream, used to
        fetch the session's tool-call events for groundedness. ``None`` if the
        agent runtime did not emit one.
    latency_seconds : float
        Wall-clock time spent consuming the stream (feeds ``ops.latency``).
    bytes_read : int
        Total SSE payload bytes read (diagnostic).
    """

    text: str
    invocation_id: str = ""
    trace_id: str | None = None
    span_id: str | None = None
    context_id: str | None = None
    latency_seconds: float = 0.0
    bytes_read: int = 0
    # Tool calls the agent reported inline via A2A metadata (BYO agents that adopt
    # the evalai.ai/tool-calls convention). Empty for agents whose tool calls are
    # only visible via the kagent sessions API (declarative) — the runner falls
    # back to that path.
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_result_artifacts: list[ToolResultArtifact] = field(default_factory=list)
    usage: dict[str, Any] | None = None
    tags: dict[str, Any] = field(default_factory=dict)


def kagent_a2a_url(base: str, namespace: str, agent: str) -> str:
    """Build the kagent ``/api/a2a/<ns>/<agent>/`` URL.

    Mirrors ``services/workflow-worker/.../_clients.py``. The trailing slash is
    required by kagent's router; path segments are URL-escaped as defence against
    a malformed reference.
    """

    base_trimmed = base.rstrip("/")
    ns_escaped = quote(namespace, safe="")
    agent_escaped = quote(agent, safe="")
    return f"{base_trimmed}/api/a2a/{ns_escaped}/{agent_escaped}/"


def _extract_text_parts(parts: Any) -> list[str]:
    """Return the text segments from an A2A ``parts`` array."""

    if not isinstance(parts, list):
        return []
    out: list[str] = []
    for part in parts:
        if isinstance(part, dict) and part.get("kind") == "text":
            text = part.get("text")
            if isinstance(text, str) and text:
                out.append(text)
    return out


@dataclass
class _ParsedFrame:
    artifact_chunks: list[str]
    status_chunks: list[str]
    status_partial: bool | None
    context_id: str | None
    error: dict[str, Any] | None
    usage: dict[str, Any] | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)


def _parse_event(raw_data: str) -> _ParsedFrame:
    """Decode one SSE ``data:`` payload.

    ``status_partial`` reflects the status message's
    ``metadata.kagent_adk_partial`` flag — ``True`` for a streamed delta,
    ``False`` for the per-step aggregate that repeats the step's full text, and
    ``None`` when absent (pre-0.9 runtimes, or frames with no agent status
    message). Unparseable frames and ``[DONE]`` sentinels yield empty chunks.
    Mirrors workflow-worker's ``_parse_event`` and additionally surfaces
    ``result.contextId``.
    """

    empty = _ParsedFrame([], [], None, None, None)
    payload = raw_data.strip()
    if not payload or payload == "[DONE]":
        return empty
    try:
        envelope = json.loads(payload)
    except json.JSONDecodeError:
        return empty
    if not isinstance(envelope, dict):
        return empty
    if isinstance(envelope.get("error"), dict):
        return _ParsedFrame([], [], None, None, envelope["error"])
    result = envelope.get("result")
    if not isinstance(result, dict):
        return empty

    context_id = result.get("contextId")
    if not isinstance(context_id, str) or not context_id:
        context_id = None

    artifact_chunks: list[str] = []
    status_chunks: list[str] = []
    status_partial: bool | None = None
    result_metadata = result.get("metadata")
    usage = _usage_metadata(result_metadata)

    tool_calls: list[dict[str, Any]] = []
    artifact = result.get("artifact")
    if isinstance(artifact, dict):
        artifact_chunks.extend(_extract_text_parts(artifact.get("parts")))
    status = result.get("status")
    if isinstance(status, dict):
        message = status.get("message")
        if isinstance(message, dict) and message.get("role") != "user":
            status_chunks.extend(_extract_text_parts(message.get("parts")))
            metadata = message.get("metadata")
            if isinstance(metadata, dict):
                usage = usage or _usage_metadata(metadata)
                if isinstance(metadata.get("kagent_adk_partial"), bool):
                    status_partial = metadata["kagent_adk_partial"]
                # BYO agents report their tool calls here (evalai.ai/tool-calls).
                reported = metadata.get(TOOL_CALLS_METADATA_KEY)
                if isinstance(reported, list):
                    tool_calls = [tc for tc in reported if isinstance(tc, dict)]
    return _ParsedFrame(
        artifact_chunks,
        status_chunks,
        status_partial,
        context_id,
        None,
        usage,
        tool_calls,
    )


def _aggregate(
    frames: list[_ParsedFrame],
) -> tuple[str, str | None, list[ToolCall]]:
    """Fold parsed frames into (final_text, context_id, tool_calls).

    Prefers the accumulated artifact body; falls back to the v0.9-aware status
    text (committed per-step aggregates + trailing in-flight deltas), matching
    workflow-worker so a status-only reply is not doubled. Tool calls reported via
    A2A metadata (BYO agents) are collected across frames.
    """

    artifact_parts: list[str] = []
    status_committed = ""
    status_current = ""
    context_id: str | None = None
    raw_tool_calls: list[dict[str, Any]] = []

    for frame in frames:
        if frame.context_id:
            context_id = frame.context_id
        if frame.tool_calls:
            raw_tool_calls.extend(frame.tool_calls)
        artifact_parts.extend(frame.artifact_chunks)
        status_chunk = "".join(frame.status_chunks)
        if frame.status_partial is False and status_chunk:
            status_committed += status_chunk
            status_current = ""
        elif status_chunk:
            status_current += status_chunk

    status_text = status_committed + status_current
    text = "".join(artifact_parts) if artifact_parts else status_text
    return text, context_id, _to_tool_calls(raw_tool_calls)


def _to_tool_calls(raw: list[dict[str, Any]]) -> list[ToolCall]:
    """Convert evalai.ai/tool-calls metadata dicts into ToolCall records."""

    out: list[ToolCall] = []
    for item in raw:
        name = item.get("name")
        if not isinstance(name, str) or not name:
            continue
        args = item.get("args")
        result_present = "result" in item or "output" in item
        result = item.get("result") if "result" in item else item.get("output")
        out.append(
            ToolCall(
                name=name,
                args=args if isinstance(args, dict) else {},
                output=result,
                result_captured=result_present,
            )
        )
    return out


def externalize_large_tool_results(
    tool_calls: list[ToolCall], *, max_inline_bytes: int
) -> tuple[list[ToolCall], list[ToolResultArtifact]]:
    """Replace oversized outputs with previews and first-class artifact refs."""

    bounded_calls: list[ToolCall] = []
    artifacts: list[ToolResultArtifact] = []
    for index, tool_call in enumerate(tool_calls):
        content_type = (
            "text/plain" if isinstance(tool_call.output, str) else "application/json"
        )
        content = (
            tool_call.output
            if isinstance(tool_call.output, str)
            else json.dumps(tool_call.output, ensure_ascii=False, default=str)
        )
        encoded = content.encode("utf-8")
        if len(encoded) <= max_inline_bytes:
            bounded_calls.append(tool_call)
            continue

        artifact_id = str(uuid.uuid4())
        artifact_ref = f"artifact://tool-results/{artifact_id}"
        preview = _utf8_prefix(encoded, max_inline_bytes)
        preview_bytes = len(preview.encode("utf-8"))
        artifacts.append(
            ToolResultArtifact(
                artifact_id=artifact_id,
                artifact_ref=artifact_ref,
                tool_name=tool_call.name,
                tool_call_index=index,
                content_type=content_type,
                content=content,
                size_bytes=len(encoded),
                preview=preview,
                preview_bytes=preview_bytes,
            )
        )
        bounded_calls.append(
            ToolCall(
                name=tool_call.name,
                args=tool_call.args,
                output={
                    "type": "artifact_reference",
                    "artifact_ref": artifact_ref,
                    "content_type": content_type,
                    "size_bytes": len(encoded),
                    "inline_preview": preview,
                    "inline_preview_bytes": preview_bytes,
                    "truncated": True,
                },
                result_captured=tool_call.result_captured,
            )
        )
    return bounded_calls, artifacts


def _utf8_prefix(value: bytes, limit: int) -> str:
    """Return at most ``limit`` bytes without splitting a UTF-8 code point."""

    if limit <= 0:
        return ""
    return value[:limit].decode("utf-8", errors="ignore")


def _usage_metadata(metadata: Any) -> dict[str, Any] | None:
    if not isinstance(metadata, dict):
        return None
    usage = metadata.get("kagent_usage_metadata")
    return usage if isinstance(usage, dict) else None


def _aggregate_usage(frames: list[_ParsedFrame]) -> dict[str, Any] | None:
    """Aggregate distinct model-call usage records without double-counting final repeats."""
    records: list[dict[str, int | None]] = []
    for frame in frames:
        usage = frame.usage
        if not usage:
            continue
        prompt_tokens = _token_count(
            usage.get("promptTokenCount", usage.get("prompt_token_count"))
        )
        output_tokens = _token_count(
            usage.get("candidatesTokenCount", usage.get("candidates_token_count"))
        )
        total_tokens = _token_count(
            usage.get("totalTokenCount", usage.get("total_token_count"))
        )
        if prompt_tokens is None and output_tokens is None and total_tokens is None:
            continue
        if total_tokens is None and prompt_tokens is not None and output_tokens is not None:
            total_tokens = prompt_tokens + output_tokens
        record = {
            "prompt_tokens": prompt_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
        }
        # kagent repeats the final usage record on the terminal status frame.
        # Only collapse adjacent identical usage records; separate calls with the
        # same token counts remain representable if another record appears between.
        if not records or records[-1] != record:
            records.append(record)
    if not records:
        return None
    totals: dict[str, Any] = {"records": records}
    for key in ("prompt_tokens", "output_tokens", "total_tokens"):
        values = [record[key] for record in records]
        totals[key] = None if None in values else sum(value for value in values if value is not None)
    return totals


def _token_count(value: Any) -> int | None:
    """Return a non-negative token count, or None for optional malformed data."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str) and value.isdecimal():
        return int(value)
    return None


async def invoke_agent(
    *,
    kagent_url: str,
    namespace: str,
    agent_name: str,
    prompt: str,
    timeout_seconds: float = 300.0,
    connect_timeout_seconds: float = 30.0,
    max_response_bytes: int = 8_388_608,
    max_event_bytes: int = 5_242_880,
    max_inline_tool_result_bytes: int = 131_072,
    context_id: str | None = None,
    invocation_id: str | None = None,
    trace_id: str | None = None,
    trace_attributes: Mapping[str, str] | None = None,
    external_endpoint: str | None = None,
    credential_headers: Mapping[str, str] | None = None,
    session_user_id: str | None = None,
) -> AgentInvocation:
    """Invoke a kagent ``Agent`` over A2A and aggregate the reply.

    Parameters mirror the workflow-worker wire format. ``context_id``, when given,
    is passed as the message ``contextId`` (multi-turn / session correlation);
    it is otherwise assigned by the runtime and returned on the result.

    Raises
    ------
    AgentOutputTooLargeError
        When aggregated SSE payload bytes exceed ``max_response_bytes``. The
        stream is stopped cleanly; ``partial_text`` may contain content read so
        far. This is non-retryable — callers should fail the row and continue.
    AgentInvocationError
        On transport failure, a non-2xx response, or a JSON-RPC error frame.
    """

    if not agent_name:
        raise AgentInvocationError("agent_name must be non-empty")
    if not prompt or not prompt.strip():
        raise AgentInvocationError("prompt must be a non-empty string")
    if credential_headers and external_endpoint is None:
        # Every call site resolves credential_headers together with
        # external_endpoint (see agent_runner.run_agent_target's
        # external_options). A caller that supplies one without the other has
        # a bug worth failing loudly on — the silent alternative is these
        # headers getting dropped and the request going out unauthenticated.
        raise AgentInvocationError("credential_headers requires an external_endpoint")

    url = kagent_a2a_url(kagent_url, namespace, agent_name)
    external_headers: dict[str, str] = {}
    request_extensions: dict[str, Any] = {}
    if external_endpoint is not None:
        endpoint = normalize_agent_endpoint(external_endpoint, namespace)
        # Revalidate and pin DNS on every invocation, not only at registration.
        url, external_headers, request_extensions = await resolve_agent_card_request(endpoint)
        external_headers.update(credential_headers or {})
    message_id = invocation_id or _new_id()
    message: dict[str, Any] = {
        "role": "user",
        "parts": [{"kind": "text", "text": prompt}],
        "messageId": message_id,
    }
    if context_id:
        message["contextId"] = context_id
    payload = {
        "jsonrpc": "2.0",
        "id": message_id,
        "method": "message/stream",
        "params": {"message": message},
    }
    # ``trace_id`` is accepted for API compatibility; the exported root span
    # is the source of truth so downstream spans hang under a recorded parent.
    _ = trace_id
    span_attrs = {
        OPENINFERENCE_SPAN_KIND: "AGENT",
        GEN_AI_OPERATION_NAME: "invoke_agent",
        "gen_ai.agent.name": agent_name,
        "ctx.agent_run_id": message_id,
        **content_attributes(input_value=prompt, input_mime_type="text/plain"),
        **dict(trace_attributes or {}),
    }
    with evaluation_root_span(name="eval_hub.invoke_agent", attributes=span_attrs) as invocation_span:
        result = await _invoke_agent_stream(
            url=url,
            payload=payload,
            headers={
                **external_headers,
                **({"X-User-ID": session_user_id} if session_user_id and external_endpoint is None else {}),
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                **invocation_span.headers,
                "X-Ctx-Agent-Run-Id": message_id,
            },
            message_id=message_id,
            evaluation_trace_id=invocation_span.trace_id,
            evaluation_span_id=invocation_span.span_id,
            context_id=context_id,
            timeout_seconds=timeout_seconds,
            connect_timeout_seconds=connect_timeout_seconds,
            max_response_bytes=max_response_bytes,
            max_event_bytes=max_event_bytes,
            max_inline_tool_result_bytes=max_inline_tool_result_bytes,
            agent_name=agent_name,
            namespace=namespace,
            **({"request_extensions": request_extensions, "external": True} if external_endpoint else {}),
        )
        invocation_span.set_output(result.text, mime_type="text/plain")
        return result


async def _invoke_agent_stream(
    *,
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    message_id: str,
    evaluation_trace_id: str | None,
    evaluation_span_id: str | None,
    context_id: str | None,
    timeout_seconds: float,
    connect_timeout_seconds: float,
    max_response_bytes: int,
    max_event_bytes: int,
    max_inline_tool_result_bytes: int,
    agent_name: str,
    namespace: str,
    request_extensions: dict[str, Any] | None = None,
    external: bool = False,
) -> AgentInvocation:
    frames: list[_ParsedFrame] = []
    bytes_read = 0
    last_event_type: str | None = None
    timeout = httpx.Timeout(timeout=timeout_seconds, connect=connect_timeout_seconds)
    started = time.monotonic()

    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False) as client:
            async with aconnect_sse(
                client, "POST", url, json=payload, headers=headers,
                **({"extensions": request_extensions} if request_extensions else {}),
            ) as event_source:
                response = event_source.response
                if response.status_code == 404:
                    raise AgentInvocationError(
                        f"agent {agent_name!r} not found in namespace {namespace!r}"
                    )
                if response.status_code >= 400:
                    if external:
                        raise AgentInvocationError(f"External A2A endpoint returned HTTP {response.status_code}")
                    raise AgentInvocationError(f"kagent /api/a2a returned HTTP {response.status_code}")
                async for event in event_source.aiter_sse():
                    event_bytes = len(event.data.encode("utf-8"))
                    bytes_read += event_bytes
                    if event_bytes > max_event_bytes:
                        text, observed_context, _tool_calls = _aggregate(frames)
                        raise AgentOutputTooLargeError(
                            limit_bytes=max_event_bytes,
                            received_bytes=event_bytes,
                            partial_text=text,
                            context_id=observed_context or context_id,
                            last_event_type="event",
                            frames_collected=len(frames),
                        )
                    frame = _parse_event(event.data)
                    last_event_type = _frame_event_type(event.data) or last_event_type
                    if frame.error is not None:
                        code = frame.error.get("code")
                        msg = frame.error.get("message", "remote error")
                        raise AgentInvocationError(
                            f"agent returned JSON-RPC error code={code}: {msg}"
                        )
                    # Keep the frame that crossed the budget so partial diagnostics
                    # include content we already received, then stop the stream.
                    frames.append(frame)
                    if bytes_read > max_response_bytes:
                        text, observed_context, _tool_calls = _aggregate(frames)
                        raise AgentOutputTooLargeError(
                            limit_bytes=max_response_bytes,
                            received_bytes=bytes_read,
                            partial_text=text,
                            context_id=observed_context or context_id,
                            last_event_type=last_event_type,
                            frames_collected=len(frames),
                        )
    except AgentInvocationError:
        raise
    except httpx.HTTPError as exc:
        raise AgentInvocationError(f"agent invocation transport error: {type(exc).__name__}") from exc

    latency = time.monotonic() - started
    text, observed_context, tool_calls = _aggregate(frames)
    tool_calls, tool_result_artifacts = externalize_large_tool_results(
        tool_calls,
        max_inline_bytes=max_inline_tool_result_bytes,
    )
    return AgentInvocation(
        text=text,
        invocation_id=message_id,
        trace_id=evaluation_trace_id,
        span_id=evaluation_span_id,
        context_id=observed_context or context_id,
        latency_seconds=latency,
        bytes_read=bytes_read,
        tool_calls=tool_calls,
        tool_result_artifacts=tool_result_artifacts,
        usage=_aggregate_usage(frames),
    )


def _frame_event_type(raw_data: str) -> str | None:
    """Best-effort A2A result kind for oversized-stream diagnostics."""

    payload = raw_data.strip()
    if not payload or payload == "[DONE]":
        return None
    try:
        envelope = json.loads(payload)
    except json.JSONDecodeError:
        return None
    if not isinstance(envelope, dict):
        return None
    result = envelope.get("result")
    if isinstance(result, dict):
        kind = result.get("kind")
        if isinstance(kind, str) and kind:
            return kind
        if isinstance(result.get("artifact"), dict):
            return "artifact"
        if isinstance(result.get("status"), dict):
            return "status"
    if isinstance(envelope.get("error"), dict):
        return "error"
    return None


def _new_id() -> str:
    return str(uuid.uuid4())
