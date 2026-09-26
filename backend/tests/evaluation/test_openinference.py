"""OpenInference conformance for evaluator feedback and target linking."""

from __future__ import annotations

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.sampling import ALWAYS_OFF

from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.judge import MockJudge
from proofgrove.evaluation.openinference import (
    EVALUATION_ANNOTATOR_KIND,
    EVALUATION_EXPLANATION,
    EVALUATION_IDENTIFIER,
    EVALUATION_NAME,
    EVALUATION_SCORE,
    INPUT_VALUE,
    OPENINFERENCE_SPAN_KIND,
    content_attributes,
    evaluator_span,
)
from proofgrove.evaluation.sample_data import SAMPLE_EXPERIMENTS, get_sample_rows
from proofgrove.evaluation.target.invocation_span import setup_invocation_tracing


def _exporter() -> InMemorySpanExporter:
    setup_invocation_tracing()
    exporter = InMemorySpanExporter()
    trace.get_tracer_provider().add_span_processor(SimpleSpanProcessor(exporter))
    return exporter


def test_evaluator_span_emits_portable_feedback_and_target_link():
    exporter = _exporter()
    target_trace_id = "0123456789abcdef0123456789abcdef"
    target_span_id = "0123456789abcdef"

    with evaluator_span(
        tracer=trace.get_tracer("test.openinference"),
        name="proofgrove.evaluate.correctness",
        attributes={"ctx.eval.run_id": "run-1"},
        target_trace_id=target_trace_id,
        target_span_id=target_span_id,
    ) as evaluation:
        evaluation.record_feedback(
            name="correctness",
            annotator_kind="LLM",
            identifier="correctness:v2",
            score=0.9,
            explanation="supported",
        )

    span = exporter.get_finished_spans()[-1]
    assert span.parent is None
    assert span.attributes[OPENINFERENCE_SPAN_KIND] == "EVALUATOR"
    assert span.attributes[EVALUATION_NAME] == "correctness"
    assert span.attributes[EVALUATION_SCORE] == 0.9
    assert span.attributes[EVALUATION_EXPLANATION] == "supported"
    assert span.attributes[EVALUATION_ANNOTATOR_KIND] == "LLM"
    assert span.attributes[EVALUATION_IDENTIFIER] == "correctness:v2"
    assert span.context.trace_state.get("evalaieval") == "1"
    assert len(span.links) == 1
    assert format(span.links[0].context.trace_id, "032x") == target_trace_id
    assert format(span.links[0].context.span_id, "016x") == target_span_id


def test_content_attributes_redact_credentials_and_honour_hide_input(monkeypatch):
    attributes = content_attributes(input_value="Authorization: Bearer abc123secret")
    assert "abc123secret" not in attributes[INPUT_VALUE]

    monkeypatch.setenv("OPENINFERENCE_HIDE_INPUTS", "true")
    assert INPUT_VALUE not in content_attributes(input_value="private")


def test_engine_records_distinct_target_and_evaluator_trace_identity():
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    rows[0].trace_id = "0123456789abcdef0123456789abcdef"
    rows[0].span_id = "0123456789abcdef"

    run = EvaluationEngine(judge=MockJudge()).execute(SAMPLE_EXPERIMENTS[0], rows)

    evaluated = [result for result in run.metric_results if result.evaluator_trace_id]
    assert evaluated
    assert all(result.target_trace_id == rows[0].trace_id for result in evaluated)
    assert all(result.target_span_id == rows[0].span_id for result in evaluated)
    assert all(result.subject_kind == "case" and result.span_id is None for result in evaluated)
    assert all(type(result).model_validate(result.model_dump()).span_id is None for result in evaluated)
    assert all(result.evaluator_span_id for result in evaluated)
    assert all(result.annotator_kind == "CODE" for result in evaluated)
    assert all(result.evaluation_identifier for result in evaluated)


@pytest.mark.parametrize("hidden", [False, True])
def test_feedback_privacy_and_safe_failure(monkeypatch, hidden):
    monkeypatch.setenv("OPENINFERENCE_HIDE_OUTPUTS", str(hidden).lower())
    monkeypatch.setenv("OPENINFERENCE_HIDE_INPUTS", str(hidden).lower())
    exporter = _exporter()
    private_feedback = "private customer verdict"
    private_error = "judge failed on private customer prompt"
    with pytest.raises(RuntimeError, match=private_error):
        with evaluator_span(
            tracer=trace.get_tracer("test.openinference"),
            name="evaluation-privacy",
            attributes={},
            target_trace_id=None,
            target_span_id=None,
        ) as evaluation:
            evaluation.record_feedback(
                name="correctness", annotator_kind="LLM", identifier="correctness:v1",
                score=0.9, label=private_feedback, explanation=private_feedback,
                metadata={"detail": private_feedback},
            )
            raise RuntimeError(private_error)

    span = exporter.get_finished_spans()[-1]
    attributes = dict(span.attributes)
    assert attributes[EVALUATION_SCORE] == 0.9
    assert attributes[EVALUATION_IDENTIFIER] == "correctness:v1"
    for key in ("output.value", "output.mime_type", EVALUATION_EXPLANATION,
                "evaluations.0.evaluation.label", "evaluations.0.evaluation.metadata"):
        assert (key in attributes) is not hidden
    assert (private_feedback in str(attributes)) is not hidden
    assert span.status.status_code.name == "ERROR"
    assert span.status.description == "RuntimeError"
    assert private_error not in str(attributes)
    assert private_error not in str([dict(event.attributes) for event in span.events])


@pytest.mark.parametrize("sdk_disabled", [False, True])
def test_unrecorded_evaluator_has_no_trace_identity(monkeypatch, sdk_disabled):
    monkeypatch.setenv("OTEL_SDK_DISABLED", str(sdk_disabled).lower())
    provider = TracerProvider(sampler=ALWAYS_OFF)
    with evaluator_span(
        tracer=provider.get_tracer("test.no-recording"),
        name="unrecorded-evaluation", attributes={}, target_trace_id=None, target_span_id=None,
    ) as evaluation:
        assert evaluation.span.is_recording() is False
        assert evaluation.span.get_span_context().is_valid is (not sdk_disabled)
        assert evaluation.trace_id is None
        assert evaluation.span_id is None
        # Scoring remains functional even when its optional telemetry is absent.
        evaluation.record_feedback(name="f1", annotator_kind="CODE", identifier="f1:v1", score=0.5)
    provider.shutdown()
