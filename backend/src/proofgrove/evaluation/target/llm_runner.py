"""Invoke an OpenAI-compatible / Compass-hosted LLM as an evaluation target."""

from __future__ import annotations

import logging
import math
import secrets
import time
from collections.abc import Mapping
from dataclasses import dataclass

import httpx
from fastapi.concurrency import run_in_threadpool
from openai import APITimeoutError, OpenAI

from proofgrove.errors import TenantVisibleError
from proofgrove.evaluation.llm_judge import (
    completion_token_params,
    extract_completion_text,
    gateway_model_headers,
    reshape_messages_for_model,
    uses_completion_tokens,
)
from proofgrove.evaluation.local_lab import local_lab_mode
from proofgrove.evaluation.model_providers import ENDPOINTS, endpoint_credential, target_provider_problem
from proofgrove.evaluation.openinference import content_attributes
from proofgrove.evaluation.target.catalog import (
    AgentCatalogError,
    normalize_agent_endpoint,
    resolve_agent_card_request,
)
from proofgrove.evaluation.target.invocation_span import (
    GEN_AI_OPERATION_NAME,
    OPENINFERENCE_SPAN_KIND,
    evaluation_root_span,
)
from proofgrove.settings import Settings

logger = logging.getLogger(__name__)


class LlmInvocationError(RuntimeError, TenantVisibleError):
    """Raised when the target LLM cannot produce a usable response."""


@dataclass(frozen=True)
class LlmTargetOutput:
    response: str
    latency_seconds: float
    model_id: str
    invocation_id: str | None = None
    trace_id: str | None = None
    span_id: str | None = None
    # None means the provider did not report this counter -- no usage object
    # at all, or a usage object whose field is absent/null. Distinct from a
    # genuine zero, which a provider that DID report the counter can send.
    # Collapsing either to 0 lets a judge score ops.token_efficiency on a
    # fabricated measurement (see run_service._run_llm_row).
    prompt_tokens: int | None = None
    completion_tokens: int | None = None


def _reported_counter(usage: object, field: str) -> int | None:
    """The counter's value only when the provider reported a usable count.

    Per-counter: an empty or partial usage object must not invent a zero for
    the fields it does not carry, while an explicit reported ``0`` survives.
    A count is only a nonnegative integral number — NaN/Infinity, fractions,
    and negatives are malformed provider output and stay unreported rather
    than crashing the runner or rounding into a fabricated count.
    """
    value = getattr(usage, field, None)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return None
    if value < 0:
        return None
    return int(value)


def _is_explicit_target_endpoint(target_endpoint: str | None) -> bool:
    """True when ``target_endpoint`` names a real URL, not a catalog placeholder."""
    endpoint = (target_endpoint or "").strip()
    return bool(
        endpoint
        and not endpoint.startswith("llm-catalog:")
        and not endpoint.startswith("golden-dataset:")
        and "://" in endpoint
    )


def _provider_failure_message(model_id: str, exc: BaseException) -> str:
    """Name the failure without the provider's text.

    An SDK error message can echo the gateway URL and the request; the status
    code and exception type are what a reader can act on.
    """
    if isinstance(exc, (APITimeoutError, httpx.TimeoutException)):
        return f"LLM '{model_id}' timed out."
    status = getattr(exc, "status_code", None)
    suffix = f" (HTTP {status})" if isinstance(status, int) else ""
    return f"LLM '{model_id}' failed: {type(exc).__name__}{suffix}"


def resolve_llm_base_url(target_endpoint: str | None, settings: Settings) -> str:
    """Pick the chat-completions base URL for a catalogue / custom LLM target."""
    endpoint = (target_endpoint or "").strip()
    if _is_explicit_target_endpoint(endpoint):
        return endpoint.rstrip("/")
    base = (settings.openai_base_url or "").rstrip("/")
    if not base:
        raise LlmInvocationError(
            "No LLM endpoint configured. Select a catalog model with an endpoint "
            "or set openai_base_url (AI Gateway)."
        )
    return base


def _build_chat_request(
    *, model_id: str, query: str, system_prompt: str | None = None, max_tokens: int = 1024
) -> dict:
    # A system prompt is the variable under test when comparing prompts, so it
    # is sent verbatim and never merged into the row's question.
    prelude = [{"role": "system", "content": system_prompt}] if system_prompt else []
    messages, extra_body = reshape_messages_for_model(
        model_id,
        [*prelude, {"role": "user", "content": query}],
    )
    request: dict = {
        "model": model_id,
        "messages": messages,
        **completion_token_params(model_id, max_tokens),
        "extra_headers": gateway_model_headers(model_id),
    }
    if not uses_completion_tokens(model_id):
        request["temperature"] = 0
    if extra_body:
        request["extra_body"] = extra_body
    return request


def _invoke_sync(
    *,
    settings: Settings,
    base_url: str,
    model_id: str,
    query: str,
    system_prompt: str | None = None,
    invocation_id: str | None = None,
    trace_id: str | None = None,
    trace_attributes: Mapping[str, str] | None = None,
    request_timeout_seconds: float | None = None,
    credential_allowed: bool = False,
    endpoint_headers: dict[str, str] | None = None,
    request_extensions: dict | None = None,
) -> LlmTargetOutput:
    if not model_id.strip():
        raise LlmInvocationError("target_model is required for LLM evaluation.")
    if not (query or "").strip():
        raise LlmInvocationError("dataset row has an empty query; cannot invoke the LLM.")

    api_key = (endpoint_credential(settings, base_url) if credential_allowed else "") or "not-needed"

    def pin_tls_name(request: httpx.Request) -> None:
        request.extensions.update(request_extensions or {})

    # Bound each HTTP attempt and disable retries for deadline-bound calls:
    # cancelling the awaiting coroutine cannot stop this synchronous worker.
    client = OpenAI(
        api_key=api_key,
        base_url=base_url,
        default_headers=endpoint_headers,
        http_client=httpx.Client(
            follow_redirects=False, trust_env=False,
            event_hooks={"request": [pin_tls_name]},
        ),
        **({"timeout": request_timeout_seconds, "max_retries": 0} if request_timeout_seconds is not None else {}),
    )
    request = _build_chat_request(model_id=model_id, query=query, system_prompt=system_prompt)
    message_id = invocation_id or secrets.token_hex(16)
    _ = trace_id
    span_attrs = {
        OPENINFERENCE_SPAN_KIND: "AGENT",
        GEN_AI_OPERATION_NAME: "invoke_llm",
        "gen_ai.request.model": model_id,
        "ctx.agent_run_id": message_id,
        **content_attributes(
            input_value={"query": query, "system_prompt": system_prompt},
        ),
        **dict(trace_attributes or {}),
    }
    with evaluation_root_span(name="proofgrove.invoke_llm", attributes=span_attrs) as invocation_span:
        request["extra_headers"] = {
            **request["extra_headers"],
            **invocation_span.headers,
            "X-Ctx-Agent-Run-Id": message_id,
        }
        started = time.monotonic()
        try:
            completion = client.chat.completions.create(**request)
        except Exception as exc:  # noqa: BLE001 — surface provider errors to the worker
            raise LlmInvocationError(_provider_failure_message(model_id, exc)) from exc
        finally:
            client.close()
        latency = time.monotonic() - started
        choices = getattr(completion, "choices", None)
        finish_reason = getattr(choices[0], "finish_reason", None) if choices else None
        if finish_reason == "length":
            # A reasoning model can exhaust the budget before emitting any
            # final answer. A partial answer is also not a completed response.
            # Never promote its separate reasoning field into scored output.
            raise LlmInvocationError(
                f"LLM '{model_id}' reached its output token limit before completing the answer. "
                "Choose another model in Models or shorten the test case, then run again."
            )
        try:
            text = extract_completion_text(completion).strip()
        except ValueError:
            # The extractor includes provider payloads in its diagnostic error.
            # Keep the stored, tenant-visible error useful and payload-free.
            raise LlmInvocationError(
                f"LLM '{model_id}' returned no final answer. "
                "Choose another model in Models or retry the evaluation."
            ) from None
        if not text:
            raise LlmInvocationError(f"LLM '{model_id}' returned an empty completion.")
        invocation_span.set_output(text, mime_type="text/plain")
        usage = getattr(completion, "usage", None)
        return LlmTargetOutput(
            response=text,
            latency_seconds=latency,
            model_id=model_id,
            invocation_id=message_id,
            trace_id=invocation_span.trace_id,
            span_id=invocation_span.span_id,
            prompt_tokens=_reported_counter(usage, "prompt_tokens"),
            completion_tokens=_reported_counter(usage, "completion_tokens"),
        )


async def run_llm_target(
    *,
    settings: Settings,
    target_endpoint: str | None,
    target_model: str,
    query: str,
    system_prompt: str | None = None,
    invocation_id: str | None = None,
    trace_id: str | None = None,
    trace_attributes: Mapping[str, str] | None = None,
    request_timeout_seconds: float | None = None,
) -> LlmTargetOutput:
    """Call the selected LLM and return its assistant text."""
    base_url = resolve_llm_base_url(target_endpoint, settings)
    # Only the exact operator-configured base URL may receive its credential.
    # A different path on the same gateway may route to a different upstream.
    local_provider = local_lab_mode(settings) is not None and base_url in ENDPOINTS.values()
    problem = await target_provider_problem(settings, base_url, target_model)
    if problem:
        raise LlmInvocationError(problem[1])
    credential_allowed = local_provider or base_url == (settings.openai_base_url or "").rstrip("/")
    endpoint_headers: dict[str, str] = {}
    request_extensions: dict = {}
    if not credential_allowed:
        try:
            normalized = normalize_agent_endpoint(base_url, settings.pod_namespace or "")
            base_url, endpoint_headers, request_extensions = await resolve_agent_card_request(normalized)
        except AgentCatalogError as exc:
            raise LlmInvocationError(str(exc)) from exc
    return await run_in_threadpool(
        _invoke_sync,
        settings=settings,
        base_url=base_url,
        model_id=target_model,
        query=query,
        system_prompt=system_prompt,
        invocation_id=invocation_id,
        trace_id=trace_id,
        trace_attributes=trace_attributes,
        request_timeout_seconds=request_timeout_seconds,
        credential_allowed=credential_allowed,
        endpoint_headers=endpoint_headers,
        request_extensions=request_extensions,
    )
