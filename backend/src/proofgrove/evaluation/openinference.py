"""OpenInference tracing helpers for target and evaluator executions.

OpenInference is a semantic layer on top of OpenTelemetry.  PostgreSQL remains
the source of truth for evaluation results; these spans make the same execution
and feedback portable through the Proofgrove OTLP archive.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from openinference.semconv.trace import OpenInferenceSpanKindValues, SpanAttributes
from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.trace import Link, Span, SpanContext, Status, StatusCode, TraceFlags, TraceState

from proofgrove.platform.payloads import redact_for_persistence

OPENINFERENCE_SPAN_KIND = SpanAttributes.OPENINFERENCE_SPAN_KIND
INPUT_VALUE = SpanAttributes.INPUT_VALUE
INPUT_MIME_TYPE = SpanAttributes.INPUT_MIME_TYPE
OUTPUT_VALUE = SpanAttributes.OUTPUT_VALUE
OUTPUT_MIME_TYPE = SpanAttributes.OUTPUT_MIME_TYPE

EVALUATION_PREFIX = "evaluations.0.evaluation"
EVALUATION_NAME = f"{EVALUATION_PREFIX}.name"
EVALUATION_SCORE = f"{EVALUATION_PREFIX}.score"
EVALUATION_LABEL = f"{EVALUATION_PREFIX}.label"
EVALUATION_EXPLANATION = f"{EVALUATION_PREFIX}.explanation"
EVALUATION_ANNOTATOR_KIND = f"{EVALUATION_PREFIX}.annotator_kind"
EVALUATION_IDENTIFIER = f"{EVALUATION_PREFIX}.identifier"
EVALUATION_METADATA = f"{EVALUATION_PREFIX}.metadata"


def span_kind(value: OpenInferenceSpanKindValues) -> str:
    """Return the wire value across enum/string semconv package versions."""

    return str(getattr(value, "value", value))


def safe_json(value: Any) -> str:
    """Serialize a bounded, credential-redacted value for an OTel attribute."""

    redacted = redact_for_persistence(value)
    if isinstance(redacted, str):
        return redacted
    return json.dumps(redacted, ensure_ascii=False, sort_keys=True, default=str)


def content_attributes(
    *,
    input_value: Any | None = None,
    output_value: Any | None = None,
    input_mime_type: str = "application/json",
    output_mime_type: str = "application/json",
) -> dict[str, str]:
    """Build privacy-governed canonical OpenInference input/output attributes."""

    attributes: dict[str, str] = {}
    if input_value is not None and not _env_true("OPENINFERENCE_HIDE_INPUTS"):
        attributes[INPUT_VALUE] = safe_json(input_value)
        attributes[INPUT_MIME_TYPE] = input_mime_type
    if output_value is not None and not _env_true("OPENINFERENCE_HIDE_OUTPUTS"):
        attributes[OUTPUT_VALUE] = safe_json(output_value)
        attributes[OUTPUT_MIME_TYPE] = output_mime_type
    return attributes


def _env_true(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def remote_span_context(trace_id: str | None, span_id: str | None) -> SpanContext | None:
    """Create a linkable context only from canonical non-zero hex identifiers."""

    if not trace_id or not span_id:
        return None
    try:
        trace_value = int(trace_id, 16)
        span_value = int(span_id, 16)
    except ValueError:
        return None
    if len(trace_id) != 32 or len(span_id) != 16 or not trace_value or not span_value:
        return None
    return SpanContext(
        trace_id=trace_value,
        span_id=span_value,
        is_remote=True,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
        trace_state=TraceState(),
    )


def _mark_evaluation_trace(span: Span) -> None:
    """Stamp the collector routing marker on a locally-created trace."""

    context = span.get_span_context()
    if not context.is_valid or context.trace_state.get("evalaieval") == "1":
        return
    marked = SpanContext(
        trace_id=context.trace_id,
        span_id=context.span_id,
        is_remote=context.is_remote,
        trace_flags=context.trace_flags,
        trace_state=(context.trace_state or TraceState()).update("evalaieval", "1"),
    )
    # The OTel SDK exposes no public setter. This matches the target-root
    # compatibility shim and is covered by an exported-span test.
    if hasattr(span, "_context"):
        span._context = marked  # noqa: SLF001


@dataclass
class EvaluatorSpan:
    """Mutable handle used to add the verdict before the evaluator span closes."""

    span: Span
    trace_id: str | None
    span_id: str | None

    def record_feedback(
        self,
        *,
        name: str,
        annotator_kind: str,
        identifier: str,
        score: float | None = None,
        label: str | None = None,
        explanation: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        verdict = {
            key: value
            for key, value in {
                "name": name,
                "score": score,
                "label": label,
                "explanation": explanation,
                "annotator_kind": annotator_kind,
                "identifier": identifier,
            }.items()
            if value is not None
        }
        for key, value in content_attributes(output_value=verdict).items():
            self.span.set_attribute(key, value)
        self.span.set_attribute(EVALUATION_NAME, name)
        self.span.set_attribute(EVALUATION_ANNOTATOR_KIND, annotator_kind)
        self.span.set_attribute(EVALUATION_IDENTIFIER, identifier)
        if score is not None:
            self.span.set_attribute(EVALUATION_SCORE, score)
        if not _env_true("OPENINFERENCE_HIDE_OUTPUTS"):
            if label:
                self.span.set_attribute(EVALUATION_LABEL, label)
            if explanation:
                self.span.set_attribute(EVALUATION_EXPLANATION, safe_json(explanation))
            if metadata:
                self.span.set_attribute(EVALUATION_METADATA, safe_json(dict(metadata)))


@contextmanager
def evaluator_span(
    *,
    tracer: trace.Tracer,
    name: str,
    attributes: Mapping[str, Any],
    target_trace_id: str | None,
    target_span_id: str | None,
) -> Iterator[EvaluatorSpan]:
    """Record an EVALUATOR carrier span linked to the completed target span."""

    target = remote_span_context(target_trace_id, target_span_id)
    links = [Link(target)] if target is not None else ()
    stamped = {
        OPENINFERENCE_SPAN_KIND: span_kind(OpenInferenceSpanKindValues.EVALUATOR),
        **attributes,
    }
    with tracer.start_as_current_span(
        name,
        context=Context(),
        attributes=stamped,
        links=links,
        record_exception=False,
        set_status_on_exception=False,
    ) as current:
        context = current.get_span_context()
        recorded = current.is_recording() and context.is_valid
        if recorded:
            _mark_evaluation_trace(current)
        try:
            yield EvaluatorSpan(
                span=current,
                trace_id=format(context.trace_id, "032x") if recorded else None,
                span_id=format(context.span_id, "016x") if recorded else None,
            )
        except BaseException as exc:
            # Judge exceptions can contain the input or generated explanation.
            current.set_status(Status(StatusCode.ERROR, type(exc).__name__))
            raise
