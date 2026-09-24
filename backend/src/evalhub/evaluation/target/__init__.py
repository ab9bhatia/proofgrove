"""Live agent evaluation targets.

This package invokes a Proofgrove/kagent ``Agent`` as an evaluation target: it sends
each golden row's query to the agent over A2A so a W3C trace exists. When the
trace archive is enabled, scoring hydrates tool calls and outputs from those
archived OTEL spans. A2A / session capture remains the invocation path and the
fallback when the archive is off.
"""

from evalhub.evaluation.target.a2a_client import (
    AgentInvocation,
    AgentInvocationError,
    AgentOutputTooLargeError,
    invoke_agent,
    kagent_a2a_url,
)
from evalhub.evaluation.target.agent_runner import AgentRunOutput, run_agent_target
from evalhub.evaluation.target.discovery import AgentSummary, list_tenant_agents
from evalhub.evaluation.target.llm_runner import (
    LlmInvocationError,
    LlmTargetOutput,
    resolve_llm_base_url,
    run_llm_target,
)
from evalhub.evaluation.target.sessions import (
    fetch_session_tool_calls,
    parse_tool_calls_from_events,
)

__all__ = [
    "AgentInvocation",
    "AgentInvocationError",
    "AgentOutputTooLargeError",
    "AgentRunOutput",
    "AgentSummary",
    "LlmInvocationError",
    "LlmTargetOutput",
    "fetch_session_tool_calls",
    "invoke_agent",
    "kagent_a2a_url",
    "list_tenant_agents",
    "parse_tool_calls_from_events",
    "resolve_llm_base_url",
    "run_agent_target",
    "run_llm_target",
]
