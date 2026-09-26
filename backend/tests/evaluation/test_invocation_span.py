"""Evaluation root spans must be recorded parents, not forged traceparent ids."""

from __future__ import annotations

from contextlib import nullcontext
from unittest.mock import MagicMock

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from proofgrove.evaluation.target.invocation_span import (
    EVAL_TRACESTATE_MEMBER,
    EXECUTION_COMPLETE_ATTRIBUTE,
    _eval_resource,
    evaluation_root_span,
    setup_invocation_tracing,
)


@pytest.fixture
def recorded_spans() -> InMemorySpanExporter:
    setup_invocation_tracing()
    exporter = InMemorySpanExporter()
    provider = trace.get_tracer_provider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return exporter


@pytest.mark.parametrize("fails", [False, True])
def test_invocation_setup_attempts_instrumentation_only_once(monkeypatch, fails):
    from openinference.instrumentation.openai import OpenAIInstrumentor

    from proofgrove.evaluation.target import invocation_span

    attempts = []

    def instrument(*_args, **_kwargs):
        attempts.append(True)
        if fails:
            raise RuntimeError("instrumentation unavailable")

    monkeypatch.setattr(invocation_span, "_provider_ready", False)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
    monkeypatch.setattr(OpenAIInstrumentor, "instrument", instrument)
    assert setup_invocation_tracing() is False
    assert setup_invocation_tracing() is False
    assert attempts == [True]


def test_evaluation_root_span_injects_own_context_and_completion(recorded_spans: InMemorySpanExporter):
    with evaluation_root_span(
        name="proofgrove.invoke_agent",
        attributes={"gen_ai.agent.name": "geo"},
    ) as (headers, trace_id):
        assert headers["traceparent"].startswith(f"00-{trace_id}-")
        _, _, parent_span_id, trace_flags = headers["traceparent"].split("-")
        assert int(trace_flags, 16) & 0x01
        assert len(parent_span_id) == 16
        assert EVAL_TRACESTATE_MEMBER in headers["tracestate"]

    spans = recorded_spans.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "proofgrove.invoke_agent"
    assert span.parent is None
    assert format(span.context.trace_id, "032x") == trace_id
    assert format(span.context.span_id, "016x") == parent_span_id
    assert span.attributes[EXECUTION_COMPLETE_ATTRIBUTE] is True
    assert any(event.name == EXECUTION_COMPLETE_ATTRIBUTE for event in span.events)
    assert span.attributes["openinference.span.kind"] == "AGENT"
    assert span.context.trace_state.get("evalaieval") == "1"


def test_evaluation_root_span_stamps_completion_on_failure(recorded_spans: InMemorySpanExporter):
    with pytest.raises(RuntimeError, match="boom"):
        with evaluation_root_span(name="proofgrove.invoke_agent"):
            raise RuntimeError("boom")

    spans = recorded_spans.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].attributes[EXECUTION_COMPLETE_ATTRIBUTE] is True
    assert spans[0].status.status_code.name == "ERROR"


def test_evaluation_root_span_records_redacted_output_and_exposes_span_id(recorded_spans: InMemorySpanExporter):
    with evaluation_root_span(name="proofgrove.invoke_agent") as invocation:
        invocation.set_output("Bearer abc123secret", mime_type="text/plain")
        assert len(invocation.span_id) == 16

    span = recorded_spans.get_finished_spans()[0]
    assert span.attributes["output.mime_type"] == "text/plain"
    assert "abc123secret" not in span.attributes["output.value"]


def test_eval_resource_stamps_tenant_namespace_for_archive_partition(monkeypatch):
    monkeypatch.setenv("POD_NAMESPACE", "tenant-evalai")
    monkeypatch.setenv("OTEL_SERVICE_NAME", "proofgrove")
    attrs = dict(_eval_resource().attributes)
    assert attrs["k8s.namespace.name"] == "tenant-evalai"
    assert attrs["ctx.tenant"] == "evalai"


@pytest.mark.parametrize("hidden", [False, True])
def test_root_span_output_privacy_and_safe_failure(recorded_spans, monkeypatch, hidden):
    monkeypatch.setenv("OPENINFERENCE_HIDE_OUTPUTS", str(hidden).lower())
    monkeypatch.setenv("OPENINFERENCE_HIDE_INPUTS", str(hidden).lower())
    private_output = "private customer response"
    private_error = "provider rejected private customer prompt"
    with pytest.raises(RuntimeError, match=private_error):
        with evaluation_root_span(name="proofgrove.invoke_agent") as invocation:
            invocation.set_output(private_output, mime_type="text/plain")
            raise RuntimeError(private_error)

    span = recorded_spans.get_finished_spans()[-1]
    if hidden:
        assert "output.value" not in span.attributes
        assert "output.mime_type" not in span.attributes
    else:
        assert span.attributes["output.value"] == private_output
        assert span.attributes["output.mime_type"] == "text/plain"
    assert span.status.status_code.name == "ERROR"
    assert span.status.description == "RuntimeError"
    assert span.attributes[EXECUTION_COMPLETE_ATTRIBUTE] is True
    assert private_error not in str(dict(span.attributes))
    assert private_error not in str([dict(event.attributes) for event in span.events])


def test_disabled_otel_sdk_does_not_report_zero_trace_ids(monkeypatch):
    from proofgrove.evaluation.target import invocation_span

    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    provider = TracerProvider()
    monkeypatch.setattr(invocation_span, "setup_invocation_tracing", lambda: False)
    monkeypatch.setattr(invocation_span.trace, "get_tracer", lambda *_: provider.get_tracer("disabled-test"))
    with evaluation_root_span(name="disabled") as invocation:
        assert invocation.span.is_recording() is False
        assert invocation.trace_id is None
        assert invocation.span_id is None
        assert invocation.headers == {}
        assert tuple(invocation) == ({}, None)
    provider.shutdown()


@pytest.mark.parametrize("valid_context", [False, True])
def test_unrecorded_or_invalid_context_never_claims_recorded_identity(monkeypatch, valid_context):
    from proofgrove.evaluation.target import invocation_span

    # Both ways a context fails to establish a recorded root are covered:
    # a dropped span can have valid ids; a broken provider can record invalid ids.
    span = MagicMock()
    span.is_recording.return_value = not valid_context
    span.get_span_context.return_value = trace.SpanContext(
        trace_id=1 if valid_context else 0,
        span_id=2 if valid_context else 0,
        is_remote=False,
    )
    tracer = MagicMock()
    tracer.start_as_current_span.return_value = nullcontext(span)
    monkeypatch.setattr(invocation_span, "setup_invocation_tracing", lambda: False)
    monkeypatch.setattr(invocation_span.trace, "get_tracer", lambda *_: tracer)
    with evaluation_root_span(name="unrecorded") as invocation:
        assert invocation.trace_id is None
        assert invocation.span_id is None
        assert invocation.headers == {}
