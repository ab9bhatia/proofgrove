"""Export a real evaluation root span and inject it as W3C ``traceparent``.

Proofgrove used to mint a random parent span id in the outbound ``traceparent``
without ever recording that span. Downstream A2A / LLM spans then pointed at a
ghost parent, so the archive had no root (``root_span_missing``). This module
starts a recording CLIENT span, injects its context, and stamps
``evalai.execution.complete`` when the invocation ends.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.propagate import inject
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.trace import SpanContext, SpanKind, Status, StatusCode, TraceState

from proofgrove.evaluation.openinference import (
    OPENINFERENCE_SPAN_KIND,
    content_attributes,
)

logger = logging.getLogger(__name__)

TRACER_NAME = "proofgrove.evaluation"
EVAL_TRACESTATE_KEY = "evalaieval"
EVAL_TRACESTATE_VALUE = "1"
EVAL_TRACESTATE_MEMBER = f"{EVAL_TRACESTATE_KEY}={EVAL_TRACESTATE_VALUE}"
EXECUTION_COMPLETE_ATTRIBUTE = "evalai.execution.complete"
GEN_AI_OPERATION_NAME = "gen_ai.operation.name"

_provider_lock = threading.Lock()
_provider_ready = False


@dataclass
class InvocationSpan:
    """Recorded target root identity, or None when no recording span exists."""

    headers: dict[str, str]
    trace_id: str | None
    span_id: str | None
    span: trace.Span

    def __iter__(self):
        """Keep the historical ``headers, trace_id = context`` API working."""

        yield self.headers
        yield self.trace_id

    def set_output(self, value: Any, *, mime_type: str = "application/json") -> None:
        if self.span.is_recording():
            self.span.set_attributes(content_attributes(output_value=value, output_mime_type=mime_type))


def setup_invocation_tracing(*, otlp_endpoint: str | None = None) -> bool:
    """Install a recording tracer provider. Returns True when OTLP export is wired.

    Idempotent. When no endpoint is configured (tests, offline), spans are still
    recording so ``traceparent`` carries a real root span id. Export uses
    ``SimpleSpanProcessor`` so the root is flushed as soon as the invoke ends
    and can join the collector's proofgrove tail-sampled trace.
    """

    global _provider_ready
    endpoint = (otlp_endpoint or os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
    with _provider_lock:
        if _provider_ready:
            return bool(endpoint)
        provider = trace.get_tracer_provider()
        if not isinstance(provider, TracerProvider):
            provider = TracerProvider(resource=_eval_resource())
            trace.set_tracer_provider(provider)
        if endpoint and not _has_span_processor(provider):
            try:
                from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
            except ImportError:  # pragma: no cover - dependency is declared
                logger.warning("proofgrove: OTLP span exporter is not installed; root spans stay local")
            else:
                traces_endpoint = f"{endpoint.rstrip('/')}/v1/traces"
                provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter(endpoint=traces_endpoint)))
                logger.info("proofgrove: evaluation root spans export to %s", traces_endpoint)
        try:
            from openinference.instrumentation import TraceConfig
            from openinference.instrumentation.openai import OpenAIInstrumentor

            OpenAIInstrumentor().instrument(
                tracer_provider=provider,
                config=TraceConfig(),
            )
        except Exception:  # noqa: BLE001 — tracing must never break evaluation
            logger.exception("proofgrove: OpenAI OpenInference instrumentation could not be enabled")
        _provider_ready = True
        return bool(endpoint)


def _eval_resource() -> Resource:
    """Stamp the tenant namespace so the archive sink does not write platform/."""

    attributes: dict[str, str] = {
        "service.name": os.getenv("OTEL_SERVICE_NAME", "proofgrove"),
    }
    namespace = (os.getenv("POD_NAMESPACE") or "").strip()
    environment = (os.getenv("TRACE_ARCHIVE_ENVIRONMENT") or os.getenv("DEPLOYMENT_ENVIRONMENT") or "").strip()
    if namespace:
        attributes["k8s.namespace.name"] = namespace
        if namespace.startswith("tenant-") and len(namespace) > 7:
            attributes["ctx.tenant"] = namespace[7:]
    if environment:
        attributes["deployment.environment"] = environment
    return Resource.create(attributes)



def _has_span_processor(provider: TracerProvider) -> bool:
    processors = getattr(provider, "_active_span_processor", None)
    inner = getattr(processors, "_span_processors", None)
    return bool(inner)


def _with_eval_tracestate(existing: str | None) -> str:
    members = [part.strip() for part in (existing or "").split(",") if part.strip()]
    if EVAL_TRACESTATE_MEMBER not in members:
        members.insert(0, EVAL_TRACESTATE_MEMBER)
    return ",".join(members)


def _stamp_eval_tracestate(span: trace.Span) -> None:
    """Put evalaieval=1 on the recording span so the collector filter keeps it.

    Outbound ``tracestate`` alone does not change the exported SpanContext.
    proofgrove-collector drops spans whose trace_state lacks this member (unless
    the span name is ``proofgrove.invoke_*``).
    """

    ctx = span.get_span_context()
    if not ctx.is_valid:
        return
    state = ctx.trace_state or TraceState()
    if state.get(EVAL_TRACESTATE_KEY) == EVAL_TRACESTATE_VALUE:
        return
    stamped = SpanContext(
        trace_id=ctx.trace_id,
        span_id=ctx.span_id,
        is_remote=ctx.is_remote,
        trace_flags=ctx.trace_flags,
        trace_state=state.update(EVAL_TRACESTATE_KEY, EVAL_TRACESTATE_VALUE),
    )
    if hasattr(span, "_context"):
        span._context = stamped  # noqa: SLF001 — SDK has no public setter


def _force_flush() -> None:
    provider = trace.get_tracer_provider()
    flush = getattr(provider, "force_flush", None)
    if callable(flush):
        flush(timeout_millis=2_000)


@contextmanager
def evaluation_root_span(
    *,
    name: str,
    attributes: Mapping[str, Any] | None = None,
) -> Iterator[InvocationSpan]:
    """Yield a recording evaluation root-span handle.

    The handle exposes W3C propagation headers plus the exported trace/span
    identifiers, or None ids and no trace headers when tracing is disabled or
    the span is not recorded. It remains iterable as ``(headers, trace_id)`` for older
    callers. Completion is stamped in ``finally`` so both success and failure
    attest that the invoke finished.
    """

    setup_invocation_tracing()
    tracer = trace.get_tracer(TRACER_NAME)
    stamped = dict(attributes or {})
    stamped.setdefault(OPENINFERENCE_SPAN_KIND, "AGENT")
    try:
        with tracer.start_as_current_span(
            name,
            context=Context(),
            kind=SpanKind.CLIENT,
            attributes=stamped,
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            headers: dict[str, str] = {}
            ctx = span.get_span_context()
            # Disabled tracing (or a sampler dropping the root) returns a
            # non-recording span. Its absent/invalid identity must remain None,
            # not an all-zero id that looks like captured trace evidence.
            recorded = span.is_recording() and ctx.is_valid
            if recorded:
                _stamp_eval_tracestate(span)
                inject(headers)
                headers["tracestate"] = _with_eval_tracestate(headers.get("tracestate"))
            try:
                yield InvocationSpan(
                    headers=headers,
                    trace_id=format(ctx.trace_id, "032x") if recorded else None,
                    span_id=format(ctx.span_id, "016x") if recorded else None,
                    span=span,
                )
                if span.is_recording():
                    span.set_status(Status(StatusCode.OK))
            except BaseException as exc:
                if span.is_recording():
                    # Provider exceptions can contain prompts, responses and credentials.
                    span.set_status(Status(StatusCode.ERROR, type(exc).__name__))
                raise
            finally:
                if span.is_recording():
                    span.set_attribute(EXECUTION_COMPLETE_ATTRIBUTE, True)
                    span.add_event(EXECUTION_COMPLETE_ATTRIBUTE)
    finally:
        # SimpleSpanProcessor exports on end; force_flush also covers a provider
        # installed by auto-instrumentation with a batch processor.
        _force_flush()
