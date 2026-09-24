"""Read explicit legacy operation markers without rewriting archived telemetry."""

from collections.abc import Mapping
from typing import Any

_OPERATIONS = {
    "chat": "llm", "completion": "llm", "text_completion": "llm", "generate_content": "llm",
    "embeddings": "embedding", "embedding": "embedding", "invoke_agent": "agent",
    "create_agent": "agent", "execute_tool": "tool", "tool": "tool", "tool.call": "tool",
    "invoke_tool": "tool", "tools": "tool",
}


def operation_type(attributes: Mapping[str, Any]) -> tuple[str | None, str | None]:
    native = attributes.get("openinference.span.kind")
    if isinstance(native, str) and native.strip():
        return native.strip().lower(), "openinference"
    operation = attributes.get("gen_ai.operation.name")
    if isinstance(operation, str) and operation.strip():
        kind = _OPERATIONS.get(operation.strip().lower())
        return kind, "telemetry_compatibility" if kind else None
    request_type = attributes.get("llm.request.type")
    if isinstance(request_type, str) and request_type.lower() in {"chat", "completion"}:
        return "llm", "telemetry_compatibility"
    # ADK records these paired payloads on operation spans, not transport spans.
    for kind, request, response in (
        ("tool", "gcp.vertex.agent.tool_call_args", "gcp.vertex.agent.tool_response"),
        ("llm", "gcp.vertex.agent.llm_request", "gcp.vertex.agent.llm_response"),
    ):
        if all(isinstance(attributes.get(key), str) and attributes[key].strip() for key in (request, response)):
            return kind, "telemetry_compatibility"
    return None, None
