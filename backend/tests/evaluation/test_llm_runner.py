"""Tests for live LLM target invocation during dataset evaluation."""

from __future__ import annotations

import asyncio
import ipaddress
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx
import pytest
from openai import OpenAI

from evalhub.evaluation.models import EvaluationRow
from evalhub.evaluation.run_service import _run_llm_row, _run_llm_rows
from evalhub.evaluation.target.llm_runner import (
    LlmInvocationError,
    LlmTargetOutput,
    resolve_llm_base_url,
    run_llm_target,
)
from evalhub.settings import Settings

_PUBLIC_ADDRESS = ipaddress.ip_address("93.184.216.34")


def test_resolve_llm_base_url_prefers_explicit_http_endpoint():
    settings = Settings(openai_base_url="https://gateway.example/v1")
    assert (
        resolve_llm_base_url("https://custom.example/v1/", settings)
        == "https://custom.example/v1"
    )


def test_resolve_llm_base_url_falls_back_for_catalog_placeholder():
    settings = Settings(openai_base_url="https://gateway.example/v1")
    assert resolve_llm_base_url("llm-catalog:gpt-4.1-mini", settings) == "https://gateway.example/v1"
    assert resolve_llm_base_url(None, settings) == "https://gateway.example/v1"


@pytest.mark.asyncio
async def test_run_llm_target_sends_model_routing_header():
    settings = Settings(
        openai_api_key="test-key",
        openai_base_url="https://gateway.example/v1",
        judge_model="gpt-4.1-mini",
    )
    completion = MagicMock()
    completion.choices = [MagicMock(message=MagicMock(content="Hello from Compass"))]
    completion.usage = MagicMock(prompt_tokens=3, completion_tokens=4)

    with patch("evalhub.evaluation.target.llm_runner.OpenAI") as openai_cls:
        openai_cls.return_value.chat.completions.create.return_value = completion
        out = await run_llm_target(
            settings=settings,
            target_endpoint=None,
            target_model="gpt-4.1-mini",
            query="Say hello",
        )

    assert out.response == "Hello from Compass"
    kwargs = openai_cls.return_value.chat.completions.create.call_args.kwargs
    assert kwargs["model"] == "gpt-4.1-mini"
    assert kwargs["extra_headers"]["x-model-id"] == "gpt-4.1-mini"
    assert kwargs["extra_headers"]["tracestate"] == "evalaieval=1"
    assert kwargs["extra_headers"]["X-Ctx-Agent-Run-Id"] == out.invocation_id
    assert kwargs["extra_headers"]["traceparent"].startswith(f"00-{out.trace_id}-")
    assert kwargs["messages"][0]["content"] == "Say hello"


def test_llm_completion_without_recording_keeps_trace_identity_absent(monkeypatch):
    from opentelemetry import trace

    from evalhub.evaluation.target import invocation_span
    from evalhub.evaluation.target.llm_runner import _invoke_sync

    monkeypatch.setattr(invocation_span, "setup_invocation_tracing", lambda: False)
    monkeypatch.setattr(invocation_span.trace, "get_tracer", lambda *_: trace.NoOpTracerProvider().get_tracer("test"))
    completion = MagicMock()
    completion.choices = [MagicMock(message=MagicMock(content="A generated answer"))]
    completion.usage = None
    with patch("evalhub.evaluation.target.llm_runner.OpenAI") as provider:
        provider.return_value.chat.completions.create.return_value = completion
        result = _invoke_sync(
            settings=Settings(), base_url="https://example.com/v1", model_id="test-model", query="Question",
        )
    assert result.response == "A generated answer"
    assert result.invocation_id
    assert result.trace_id is None
    assert result.span_id is None
    headers = provider.return_value.chat.completions.create.call_args.kwargs["extra_headers"]
    assert "traceparent" not in headers
    assert "tracestate" not in headers
    assert headers["X-Ctx-Agent-Run-Id"] == result.invocation_id


@pytest.mark.asyncio
async def test_run_llm_target_with_no_usage_object_reports_none_not_zero():
    """No usage object on the completion -> None, not a fabricated 0.

    Regression for R7: collapsing "provider reported nothing" to 0 is
    indistinguishable downstream from a genuine reported zero, which lets a
    judge score ops.token_efficiency on a measurement that was never taken.
    """
    settings = Settings(
        openai_api_key="test-key",
        openai_base_url="https://gateway.example/v1",
        judge_model="gpt-4.1-mini",
    )
    completion = MagicMock()
    completion.choices = [MagicMock(message=MagicMock(content="Hello from Compass"))]
    completion.usage = None

    with patch("evalhub.evaluation.target.llm_runner.OpenAI") as openai_cls:
        openai_cls.return_value.chat.completions.create.return_value = completion
        out = await run_llm_target(
            settings=settings,
            target_endpoint=None,
            target_model="gpt-4.1-mini",
            query="Say hello",
        )

    assert out.prompt_tokens is None
    assert out.completion_tokens is None


@pytest.mark.asyncio
async def test_run_llm_target_with_genuine_zero_usage_reports_zero():
    """A provider that DOES send usage, reporting zero, keeps that zero."""
    settings = Settings(
        openai_api_key="test-key",
        openai_base_url="https://gateway.example/v1",
        judge_model="gpt-4.1-mini",
    )
    completion = MagicMock()
    completion.choices = [MagicMock(message=MagicMock(content="Hello from Compass"))]
    completion.usage = MagicMock(prompt_tokens=0, completion_tokens=0)

    with patch("evalhub.evaluation.target.llm_runner.OpenAI") as openai_cls:
        openai_cls.return_value.chat.completions.create.return_value = completion
        out = await run_llm_target(
            settings=settings,
            target_endpoint=None,
            target_model="gpt-4.1-mini",
            query="Say hello",
        )

    assert out.prompt_tokens == 0
    assert out.completion_tokens == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("usage", "expected_prompt", "expected_completion"),
    [
        # Empty usage object: neither counter was reported.
        (SimpleNamespace(), None, None),
        # Partial: only the reported side survives; the missing side must not
        # become a fabricated zero.
        (SimpleNamespace(prompt_tokens=7), 7, None),
        # Explicit nulls inside a present usage object are "not reported".
        (SimpleNamespace(prompt_tokens=None, completion_tokens=None), None, None),
        # Genuine zeros inside a present usage object survive per counter.
        (SimpleNamespace(prompt_tokens=0, completion_tokens=0), 0, 0),
        # Malformed numerics are unreported, never a crash or a rounded count.
        (SimpleNamespace(prompt_tokens=float("inf"), completion_tokens=4), None, 4),
        (SimpleNamespace(prompt_tokens=float("-inf"), completion_tokens=4), None, 4),
        (SimpleNamespace(prompt_tokens=float("nan"), completion_tokens=4), None, 4),
        (SimpleNamespace(prompt_tokens=-0.5, completion_tokens=4), None, 4),
        (SimpleNamespace(prompt_tokens=-1, completion_tokens=4), None, 4),
        (SimpleNamespace(prompt_tokens=2.5, completion_tokens=4), None, 4),
        # A JSON number that is integral-valued is a real count.
        (SimpleNamespace(prompt_tokens=7.0, completion_tokens=4), 7, 4),
        # Booleans are not counts.
        (SimpleNamespace(prompt_tokens=True, completion_tokens=4), None, 4),
    ],
)
async def test_run_llm_target_preserves_per_counter_reportedness(usage, expected_prompt, expected_completion):
    """Empty/partial/null usage objects must not invent zero counters (R7)."""
    settings = Settings(
        openai_api_key="test-key",
        openai_base_url="https://gateway.example/v1",
        judge_model="gpt-4.1-mini",
    )
    completion = MagicMock()
    completion.choices = [MagicMock(message=MagicMock(content="Hello from Compass"))]
    completion.usage = usage

    with patch("evalhub.evaluation.target.llm_runner.OpenAI") as openai_cls:
        openai_cls.return_value.chat.completions.create.return_value = completion
        out = await run_llm_target(
            settings=settings,
            target_endpoint=None,
            target_model="gpt-4.1-mini",
            query="Say hello",
        )

    assert out.prompt_tokens == expected_prompt
    assert out.completion_tokens == expected_completion


@pytest.mark.asyncio
async def test_run_llm_row_keeps_only_reported_counters_for_partial_usage():
    """A one-sided report persists one key; the readers see only that side."""
    from evalhub.evaluation.engine import usage_total_tokens
    from evalhub.evaluation.trace_hydrator import _reported_usage_total

    row = EvaluationRow(row_id="r1", query="Q?", response="")
    out = LlmTargetOutput(
        response="Answer",
        latency_seconds=0.12,
        model_id="gpt-4.1-mini",
        prompt_tokens=7,
        completion_tokens=None,
    )
    with patch("evalhub.evaluation.run_service.run_llm_target", return_value=out):
        await _run_llm_row(
            row,
            target_endpoint=None,
            target_model="gpt-4.1-mini",
        )
    assert row.target_usage["prompt_tokens"] == 7
    assert "completion_tokens" not in row.target_usage
    # Both readers require both sides, so neither fabricates a total from
    # one half of a partial report: the token-efficiency guard records
    # UNSCORED and the model_usage evidence category stays UNKNOWN.
    assert usage_total_tokens(row.target_usage) is None
    assert _reported_usage_total(row.target_usage) is None


@pytest.mark.asyncio
async def test_run_llm_row_fills_response_and_aborts_on_empty():
    row = EvaluationRow(row_id="r1", query="Q?", response="")
    out = LlmTargetOutput(
        response="Answer",
        latency_seconds=0.12,
        model_id="gpt-4.1-mini",
        invocation_id="invocation-1",
        trace_id="0123456789abcdef0123456789abcdef",
        prompt_tokens=1,
        completion_tokens=2,
    )
    with patch("evalhub.evaluation.run_service.run_llm_target", return_value=out):
        await _run_llm_row(
            row,
            target_endpoint="https://gateway.example/v1",
            target_model="gpt-4.1-mini",
        )
    assert row.response == "Answer"
    assert row.output_data == {"response": "Answer"}
    assert row.latency_ms == 120
    assert row.target_usage["model"] == "gpt-4.1-mini"
    assert row.invocation_id == "invocation-1"
    assert row.trace_id == "0123456789abcdef0123456789abcdef"

    empty_row = EvaluationRow(row_id="r2", query="Q?", response="")
    with (
        patch(
            "evalhub.evaluation.run_service.run_llm_target",
            side_effect=LlmInvocationError("empty completion"),
        ),
        pytest.raises(LlmInvocationError, match="Failed to retrieve LLM output"),
    ):
        await _run_llm_row(
            empty_row,
            target_endpoint="https://gateway.example/v1",
            target_model="gpt-4.1-mini",
        )


@pytest.mark.asyncio
async def test_run_llm_row_omits_token_counts_when_provider_reported_no_usage():
    """Regression for R7 -- readers must AGREE the run is unscored, not fabricate a 0.

    When ``LlmTargetOutput`` carries ``prompt_tokens=None``/``completion_tokens=None``
    (the provider sent no usage object), ``row.target_usage`` must not carry
    those keys at all -- a present key with value 0 is indistinguishable from
    a genuine reported zero to every downstream reader.
    """
    from evalhub.evaluation.adapters.deterministic_adapter import usage_total_tokens
    from evalhub.evaluation.trace_hydrator import _reported_usage_total

    row = EvaluationRow(row_id="r3", query="Q?", response="")
    out = LlmTargetOutput(
        response="Answer",
        latency_seconds=0.1,
        model_id="gpt-4.1-mini",
        prompt_tokens=None,
        completion_tokens=None,
    )
    with patch("evalhub.evaluation.run_service.run_llm_target", return_value=out):
        await _run_llm_row(
            row,
            target_endpoint="https://gateway.example/v1",
            target_model="gpt-4.1-mini",
        )

    assert "prompt_tokens" not in row.target_usage
    assert "completion_tokens" not in row.target_usage
    assert row.target_usage["model"] == "gpt-4.1-mini"
    # engine.py's reader: None -> ops.token_efficiency goes UNSCORED, never a
    # fabricated 0.
    assert usage_total_tokens(row.target_usage) is None
    # readiness.py's reader: None -> model_usage UNKNOWN, agreeing with engine.
    assert _reported_usage_total(row.target_usage) is None


@pytest.mark.asyncio
async def test_run_llm_row_keeps_genuine_zero_usage():
    """A provider-reported zero still flows through and scores as today."""
    from evalhub.evaluation.adapters.deterministic_adapter import usage_total_tokens

    row = EvaluationRow(row_id="r4", query="Q?", response="")
    out = LlmTargetOutput(
        response="Answer",
        latency_seconds=0.1,
        model_id="gpt-4.1-mini",
        prompt_tokens=0,
        completion_tokens=0,
    )
    with patch("evalhub.evaluation.run_service.run_llm_target", return_value=out):
        await _run_llm_row(
            row,
            target_endpoint="https://gateway.example/v1",
            target_model="gpt-4.1-mini",
        )

    assert row.target_usage["prompt_tokens"] == 0
    assert row.target_usage["completion_tokens"] == 0
    assert usage_total_tokens(row.target_usage) == 0.0


@pytest.mark.asyncio
async def test_run_llm_rows_invokes_in_parallel():
    rows = [
        EvaluationRow(row_id="a", query="one", response=""),
        EvaluationRow(row_id="b", query="two", response=""),
    ]

    async def fake_run(**kwargs):
        return LlmTargetOutput(
            response=f"resp:{kwargs['query']}",
            latency_seconds=0.01,
            model_id="gpt-4.1-mini",
        )

    with patch("evalhub.evaluation.run_service.run_llm_target", side_effect=fake_run):
        await _run_llm_rows(
            rows,
            target_endpoint="https://gateway.example/v1",
            target_model="gpt-4.1-mini",
            parallel_requests=2,
        )

    assert [row.response for row in rows] == ["resp:one", "resp:two"]


@pytest.mark.asyncio
async def test_run_llm_rows_cancels_the_other_row_on_first_failure():
    """One row's target call failing must cancel a sibling call still in
    flight, not leave it running unobserved in the background.

    Plain ``asyncio.gather`` (the prior implementation) propagates the first
    exception but never cancels the other concurrent calls — they kept
    hitting the target after the caller had already raised and moved on.
    """
    rows = [
        EvaluationRow(row_id="slow", query="slow", response=""),
        EvaluationRow(row_id="fails", query="boom", response=""),
    ]
    slow_started = asyncio.Event()
    slow_cancelled = False

    async def fake_run(**kwargs):
        nonlocal slow_cancelled
        if kwargs["query"] == "slow":
            slow_started.set()
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                slow_cancelled = True
                raise
            return LlmTargetOutput(response="never reached", latency_seconds=0.0, model_id="gpt-4.1-mini")
        await slow_started.wait()
        raise LlmInvocationError("boom")

    with patch("evalhub.evaluation.run_service.run_llm_target", side_effect=fake_run):
        with pytest.raises(LlmInvocationError, match="boom"):
            await _run_llm_rows(
                rows,
                target_endpoint="https://gateway.example/v1",
                target_model="gpt-4.1-mini",
                parallel_requests=2,
            )

    assert slow_cancelled is True


@pytest.mark.asyncio
async def test_deadline_bound_target_does_not_retry_upstream_timeout():
    attempts = []

    def fail_request(request):
        attempts.append(request)
        raise httpx.ReadTimeout("synthetic upstream timeout", request=request)

    async def dns(host, port):
        return [_PUBLIC_ADDRESS]

    with httpx.Client(transport=httpx.MockTransport(fail_request)) as http_client:
        with (
            patch(
                "evalhub.evaluation.target.llm_runner.OpenAI",
                side_effect=lambda **kwargs: OpenAI(**{**kwargs, "http_client": http_client}),
            ),
            patch("evalhub.evaluation.target.catalog.resolve_endpoint_addresses", dns),
        ):
            with pytest.raises(LlmInvocationError, match="timed out"):
                await run_llm_target(
                    settings=Settings(openai_api_key="test-key"),
                    target_endpoint="https://synthetic.invalid/v1",
                    target_model="gpt-4.1-mini",
                    query="Synthetic timeout check",
                    request_timeout_seconds=0.01,
                )
    assert len(attempts) == 1


@pytest.mark.asyncio
async def test_run_llm_target_rejects_endpoint_resolving_to_metadata_address():
    """A target endpoint that resolves to the cloud metadata address must be
    rejected before the real provider API key is ever sent to it."""

    async def dns(host, port):
        return [ipaddress.ip_address("169.254.169.254")]

    with (
        patch("evalhub.evaluation.target.catalog.resolve_endpoint_addresses", dns),
        patch("evalhub.evaluation.target.llm_runner.OpenAI") as openai_cls,
    ):
        with pytest.raises(LlmInvocationError, match="private or local"):
            await run_llm_target(
                settings=Settings(openai_api_key="super-secret-key"),
                target_endpoint="https://ssrf.example/v1",
                target_model="gpt-4.1-mini",
                query="q",
            )
    openai_cls.assert_not_called()


@pytest.mark.asyncio
async def test_run_llm_target_rejects_endpoint_resolving_to_cross_namespace_service():
    """A cluster-internal address (e.g. a cross-namespace k8s service ClusterIP)
    resolved from a user-supplied endpoint must be rejected the same way."""

    async def dns(host, port):
        return [ipaddress.ip_address("10.42.7.9")]

    with (
        patch("evalhub.evaluation.target.catalog.resolve_endpoint_addresses", dns),
        patch("evalhub.evaluation.target.llm_runner.OpenAI") as openai_cls,
    ):
        with pytest.raises(LlmInvocationError, match="private or local"):
            await run_llm_target(
                settings=Settings(openai_api_key="super-secret-key"),
                target_endpoint="https://other-ns-svc.example/v1",
                target_model="gpt-4.1-mini",
                query="q",
            )
    openai_cls.assert_not_called()


@pytest.mark.asyncio
async def test_run_llm_target_allows_endpoint_resolving_to_public_address():
    """A benign explicit endpoint that resolves publicly still reaches the client."""

    async def dns(host, port):
        return [_PUBLIC_ADDRESS]

    completion = MagicMock()
    completion.choices = [MagicMock(message=MagicMock(content="hi"))]
    completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1)

    with (
        patch("evalhub.evaluation.target.catalog.resolve_endpoint_addresses", dns),
        patch("evalhub.evaluation.target.llm_runner.OpenAI") as openai_cls,
    ):
        openai_cls.return_value.chat.completions.create.return_value = completion
        out = await run_llm_target(
            settings=Settings(openai_api_key="test-key"),
            target_endpoint="https://custom.example/v1",
            target_model="gpt-4.1-mini",
            query="q",
        )
    assert out.response == "hi"


@pytest.mark.asyncio
async def test_run_llm_target_skips_dns_check_for_catalog_placeholder():
    """The operator-configured openai_base_url fallback is trusted and never
    resolved through the SSRF guard -- only an explicit target_endpoint is."""

    with (
        patch("evalhub.evaluation.target.catalog.resolve_endpoint_addresses") as dns,
        patch("evalhub.evaluation.target.llm_runner.OpenAI") as openai_cls,
    ):
        completion = MagicMock()
        completion.choices = [MagicMock(message=MagicMock(content="hi"))]
        completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1)
        openai_cls.return_value.chat.completions.create.return_value = completion
        await run_llm_target(
            settings=Settings(openai_api_key="test-key", openai_base_url="https://gateway.example/v1"),
            target_endpoint=None,
            target_model="gpt-4.1-mini",
            query="q",
        )
    dns.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint,credential_expected", [
    ("https://custom.example/v1", False),
    ("https://gateway.example/other-upstream", False),
    ("https://gateway.example/v1", True),
    (None, True),
])
async def test_target_credentials_and_dns_are_bound_to_destination(endpoint, credential_expected):
    requests = []
    client_class = httpx.Client

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={
            "id": "c", "created": 0, "model": "m", "object": "chat.completion",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
        })

    class Client(client_class):
        def __init__(self, **kwargs):
            super().__init__(transport=httpx.MockTransport(respond), **kwargs)

    async def dns(host, port):
        return [_PUBLIC_ADDRESS]

    with (
        patch("evalhub.evaluation.target.llm_runner.httpx.Client", Client),
        patch("evalhub.evaluation.target.catalog.resolve_endpoint_addresses", side_effect=dns) as lookup,
    ):
        result = await run_llm_target(
            settings=Settings(openai_api_key="configured-secret", openai_base_url="https://gateway.example/v1"),
            target_endpoint=endpoint, target_model="m", query="q",
        )
    assert result.response == "ok"
    assert len(requests) == 1
    request = requests[0]
    assert request.headers["authorization"] == ("Bearer configured-secret" if credential_expected else "Bearer not-needed")
    if credential_expected:
        lookup.assert_not_called()
        assert request.url.host == "gateway.example"
    else:
        lookup.assert_awaited_once()
        assert request.url.host == str(_PUBLIC_ADDRESS)
        original_host = httpx.URL(endpoint).host
        assert request.headers["host"] == original_host
        assert request.extensions["sni_hostname"] == original_host


@pytest.mark.asyncio
async def test_target_does_not_follow_redirects():
    requests = []
    client_class = httpx.Client

    def redirect(request):
        requests.append(request)
        return httpx.Response(307, headers={"location": "http://169.254.169.254/latest"})

    class Client(client_class):
        def __init__(self, **kwargs):
            super().__init__(transport=httpx.MockTransport(redirect), **kwargs)

    with patch("evalhub.evaluation.target.llm_runner.httpx.Client", Client):
        with pytest.raises(LlmInvocationError):
            await run_llm_target(
                settings=Settings(openai_api_key="test-key", openai_base_url="https://gateway.example/v1"),
                target_endpoint=None, target_model="m", query="q",
            )
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_llm_failure_logs_omit_private_evidence(caplog):
    private = "private customer provider diagnostic"
    row = EvaluationRow(row_id="r-private", query="query", response="")
    with (
        patch("evalhub.evaluation.run_service.run_llm_target", side_effect=LlmInvocationError(private)),
        pytest.raises(LlmInvocationError, match=private),
    ):
        await _run_llm_row(row, target_endpoint=None, target_model="model")
    assert row.invocation_error == private
    assert caplog.records
    assert private not in caplog.text
