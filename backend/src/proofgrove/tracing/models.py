"""Trace-index domain model: honest lifecycle states and span statistics.

Everything here is derived from real signals — evaluation run items that carry
a genuine trace id, and spans actually read from the S3 trace archive. Nothing
is fabricated: statistics stay ``None`` until the archive was read.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from proofgrove.evaluation.models import ArchivedTraceSpan
from proofgrove.platform.payloads import TRUNCATION_MARKER, redact_for_persistence
from proofgrove.tracing.cost import estimate_span_cost_usd, span_model, sum_span_costs_usd


class TraceLifecycleState(StrEnum):
    """Honest lifecycle of an indexed trace, from real signals only.

    - ``requested``: a run item carries the trace id (or the archive pointer
      was discovered) but the archive has not been checked yet.
    - ``pending_export``: the archive was checked and no spans have landed yet
      (export may still be in flight within the grace window).
    - ``archive_confirmed``: spans were genuinely found in the archive; span
      statistics on the row are real.
    - ``archive_unavailable``: the last archive check errored; span presence is
      unknown, never guessed.
    """

    REQUESTED = "requested"
    PENDING_EXPORT = "pending_export"
    ARCHIVE_CONFIRMED = "archive_confirmed"
    ARCHIVE_UNAVAILABLE = "archive_unavailable"


# OTLP SpanKind enum → lowercase label; 0 (UNSPECIFIED) is honestly absent.
_OTLP_SPAN_KINDS: dict[int, str] = {
    1: "internal",
    2: "server",
    3: "client",
    4: "producer",
    5: "consumer",
}

# GenAI / OpenInference model attributes, in preference order.
_MODEL_ATTRIBUTES = ("gen_ai.request.model", "gen_ai.response.model", "llm.model_name")

# Resource attributes that may carry the logical target id used by
# TargetProjectBinding. ``service.name`` last: it is the OTel-conventional
# service identity the collector stamps on kagent workloads.
_TARGET_ATTRIBUTES = ("ctx.target", "ctx.target_id", "evalai.target_id", "service.name")

#: Bumped whenever the derivation below changes, so already-indexed traces are
#: rebuilt by the index worker instead of keeping stale summary columns.
SPAN_INDEX_REV: int = 4

#: Previews exist to recognise a row, not to carry the payload.
SPAN_PREVIEW_MAX_CHARS: int = 500

# ``gen_ai.operation.name`` → semantic kind. Unions the operation vocabularies
# already recognised elsewhere rather than inventing a fourth.
_SEMANTIC_OPERATIONS: dict[str, str] = {
    "chat": "llm",
    "completion": "llm",
    "text_completion": "llm",
    "generate_content": "llm",
    "embeddings": "embedding",
    "embedding": "embedding",
    "invoke_agent": "agent",
    "create_agent": "agent",
    "execute_tool": "tool",
    "tool": "tool",
    "tool.call": "tool",
    "invoke_tool": "tool",
    "tools": "tool",
}

# Attributes that only a model generation records. Deliberately excludes the
# ambient ``gen_ai.conversation.id`` / ``task.id`` / ``system`` / ``agent.name``,
# which ride on agent and framework spans too and would promote plumbing.
_GENERATION_ATTRIBUTE_PREFIXES = (
    "gen_ai.request.",
    "gen_ai.response.",
    "gen_ai.usage.",
    "gen_ai.prompt",
    "gen_ai.completion",
    "llm.request.",
    "llm.usage.",
    "llm.token_count.",
    "llm.input_messages.",
    "llm.output_messages.",
)

_PROMPT_TOKEN_KEYS = ("llm.token_count.prompt", "gen_ai.usage.input_tokens")
_COMPLETION_TOKEN_KEYS = ("llm.token_count.completion", "gen_ai.usage.output_tokens")

# Indexed message conventions: ``{prefix}.{i}.content`` and the ``.message.``
# variant, matching what the span detail view reads.
_COMPLETION_CONTENT = re.compile(r"^(?:gen_ai\.completion|llm\.output_messages)\.(\d+)\.(?:message\.)?content$")
_PROMPT_CONTENT = re.compile(
    r"^(?:gen_ai\.prompt|llm\.input_messages|gen_ai\.input\.messages)"
    r"\.(\d+)\.(?:message\.)?content$"
)

# Framework attributes carrying request/response bodies, used only when the
# conventional keys are absent — several real agent spans record nothing else.
_FALLBACK_INPUT_KEYS = ("gcp.vertex.agent.llm_request", "gcp.vertex.agent.tool_call_args")
_FALLBACK_OUTPUT_KEYS = ("gcp.vertex.agent.llm_response", "gcp.vertex.agent.tool_response")


def _nano_to_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1_000_000_000, tz=UTC)
    except (ValueError, OverflowError, OSError):
        return None


def _parse_unix_nano(value: str | None) -> int | None:
    """Parse a producer-supplied unix-nano timestamp.

    ``None`` when unparseable (e.g. a float-serialising exporter's
    ``"1.7579e+18"``) — a malformed value is excluded, never coerced into a
    fabricated instant or duration.
    """
    if not value:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def span_has_error(span: ArchivedTraceSpan) -> bool:
    """OTLP error status only (numeric 2 or a string containing ERROR)."""
    code = (span.status or {}).get("code")
    if isinstance(code, bool):
        return False
    if isinstance(code, int | float):
        return int(code) == 2
    if isinstance(code, str):
        return code == "2" or "ERROR" in code.upper()
    return False


def span_kind_label(span: ArchivedTraceSpan) -> str | None:
    """Semantic OpenInference kind when present, else the OTLP transport kind."""
    semantic = (span.attributes or {}).get("openinference.span.kind")
    if isinstance(semantic, str) and semantic.strip():
        return semantic.strip().lower()
    if span.kind is not None:
        return _OTLP_SPAN_KINDS.get(span.kind)
    return None


def recorded_span_kind(span: ArchivedTraceSpan) -> str | None:
    """Native OpenInference first, then explicit legacy operation markers."""
    return span.semantic_kind


def semantic_span_kind(span: ArchivedTraceSpan) -> str | None:
    """Legacy semantic reader for historical scoring evidence.

    Tracing presentation and indexing use recorded_span_kind instead; this
    compatibility path still reads earlier GenAI instrumentation.
    """
    attrs = span.attributes or {}

    instrumented = attrs.get("openinference.span.kind")
    if isinstance(instrumented, str) and instrumented.strip():
        return instrumented.strip().lower()

    operation = attrs.get("gen_ai.operation.name")
    if isinstance(operation, str) and operation.strip():
        # Before the attribute sweep below: a tool execution also carries
        # ``gen_ai.*`` neighbours and must not be read as a generation.
        kind = _SEMANTIC_OPERATIONS.get(operation.strip().lower())
        if kind:
            return kind

    # ponytail: attribute-presence heuristic — a producer emitting a stray
    # ``gen_ai.request.*`` on a wrapper span would read as an LLM call. This is
    # the legacy reader only; do not use it for new tracing presentation.
    if any(key.startswith(_GENERATION_ATTRIBUTE_PREFIXES) for key in attrs):
        return "llm"
    return None


def _indexed_message_text(attrs: Mapping[str, Any], pattern) -> str | None:
    """Join ``{prefix}.{i}.content`` attributes in index order."""
    messages: list[tuple[int, str]] = []
    for key, value in attrs.items():
        match = pattern.match(key)
        if match and isinstance(value, str) and value.strip():
            messages.append((int(match.group(1)), value.strip()))
    if not messages:
        return None
    messages.sort()
    return "\n\n".join(text for _, text in messages)


def output_text(attrs: Mapping[str, Any]) -> str | None:
    """Recorded completion text, or None when the span records none."""
    for key in ("output.value", "gen_ai.completion"):
        value = attrs.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return _indexed_message_text(attrs, _COMPLETION_CONTENT) or _first_text(attrs, ("gcp.vertex.agent.tool_response",))


def input_text(attrs: Mapping[str, Any]) -> str | None:
    """Recorded prompt/input text, or None when the span records none."""
    for key in ("input.value", "gen_ai.prompt"):
        value = attrs.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return _indexed_message_text(attrs, _PROMPT_CONTENT) or _first_text(attrs, ("gcp.vertex.agent.tool_call_args",))


def _first_text(attrs: Mapping[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = attrs.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _int_attribute(attrs: Mapping[str, Any], keys: tuple[str, ...]) -> int | None:
    """First non-negative whole-number token count among ``keys``.

    OTLP/JSON encodes int64 as a string, so real spans carry ``"1591"`` rather
    than ``1591``; a numeric-only reader records no tokens for any archived
    span. Parsing through ``float`` would be worse than either: ``"-0.5"``
    would land as a fabricated ``0``, and an overflowing literal would raise
    out of the indexer. A token count is a whole number, so only that is read.
    """
    for key in keys:
        value = attrs.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            if value >= 0:
                return value
            continue
        if isinstance(value, str) and value.strip().isdigit():
            return int(value.strip())
    return None


def _preview(text: str | None) -> str | None:
    """Bounded preview of span text, redacted when payload redaction is on.

    Redaction runs before the cut: truncating first can bisect a credential and
    leave a live-looking fragment past the point the patterns match.
    """
    if not text:
        return None
    redacted = redact_for_persistence(text)
    if not isinstance(redacted, str) or not redacted:
        return None
    if len(redacted) <= SPAN_PREVIEW_MAX_CHARS:
        return redacted
    keep = SPAN_PREVIEW_MAX_CHARS - len(TRUNCATION_MARKER)
    marked = f"{redacted[:keep]}{TRUNCATION_MARKER}" if keep > 0 else TRUNCATION_MARKER
    # The marker itself can be longer than a small limit; the bound wins.
    return marked[:SPAN_PREVIEW_MAX_CHARS]


def span_status_label(span: ArchivedTraceSpan) -> str:
    if span_has_error(span):
        return "error"
    code = (span.status or {}).get("code")
    if code in (1, "1") or (isinstance(code, str) and "OK" in code.upper()):
        return "ok"
    return "unset"


def _root_span(spans: list[ArchivedTraceSpan]) -> ArchivedTraceSpan | None:
    if not spans:
        return None
    span_ids = {span.span_id for span in spans}
    # Root: no parent, or a parent that was not captured; earliest start wins.
    candidates = [s for s in spans if not s.parent_span_id or s.parent_span_id not in span_ids]
    pool = candidates or spans
    # Ordering only — an unparseable timestamp sorts as 0 (deterministic degrade).
    return min(pool, key=lambda s: _parse_unix_nano(s.start_time_unix_nano) or 0)


@dataclass(frozen=True)
class TraceStats:
    """Real, archive-derived statistics for one confirmed trace."""

    root_span_name: str | None
    root_span_kind: str | None
    span_count: int
    error_count: int
    model: str | None
    started_at: datetime | None
    duration_ms: float | None
    target_id: str | None
    estimated_cost_usd: float | None


def trace_stats_from_spans(spans: list[ArchivedTraceSpan]) -> TraceStats:
    archived_spans = spans
    spans = [span for span in spans if recorded_span_kind(span) is not None]
    root = _root_span(spans) or _root_span(archived_spans)
    model: str | None = None
    target_id: str | None = None
    for span in archived_spans:
        if model is None:
            for key in _MODEL_ATTRIBUTES:
                value = (span.attributes or {}).get(key)
                if isinstance(value, str) and value.strip():
                    model = value.strip()
                    break
        if target_id is None:
            for key in _TARGET_ATTRIBUTES:
                value = (span.resource_attributes or {}).get(key)
                if isinstance(value, str) and value.strip():
                    target_id = value.strip()
                    break

    # Unparseable timestamps are excluded, not coerced to 0 — a 0 start would
    # fabricate a duration for a span whose real timing is unknown.
    starts = [ts for ts in (_parse_unix_nano(s.start_time_unix_nano) for s in archived_spans) if ts is not None and ts > 0]
    ends = [ts for ts in (_parse_unix_nano(s.end_time_unix_nano) for s in archived_spans) if ts is not None and ts > 0]
    duration_ms = (max(ends) - min(starts)) / 1_000_000 if starts and ends else None
    if duration_ms is not None and duration_ms < 0:
        duration_ms = None

    return TraceStats(
        root_span_name=root.name if root else None,
        root_span_kind=recorded_span_kind(root) if root else None,
        span_count=len(spans),
        error_count=sum(1 for span in spans if span_has_error(span)),
        model=model,
        started_at=_nano_to_datetime(str(min(starts))) if starts else None,
        duration_ms=duration_ms,
        target_id=target_id,
        estimated_cost_usd=sum_span_costs_usd([estimate_span_cost_usd(span.attributes) for span in spans]),
    )


def _span_index_row(span: ArchivedTraceSpan, semantic_kind: str | None) -> dict:
    attrs = span.attributes or {}
    return {
        "span_id": span.span_id,
        "parent_span_id": span.parent_span_id,
        "name": span.name,
        "kind": span_kind_label(span),
        "semantic_kind": semantic_kind,
        "input_preview": _preview(input_text(attrs) or _first_text(attrs, _FALLBACK_INPUT_KEYS)),
        "output_preview": _preview(output_text(attrs) or _first_text(attrs, _FALLBACK_OUTPUT_KEYS)),
        "llm_token_count_prompt": _int_attribute(attrs, _PROMPT_TOKEN_KEYS),
        "llm_token_count_completion": _int_attribute(attrs, _COMPLETION_TOKEN_KEYS),
        "estimated_cost_usd": estimate_span_cost_usd(
            attrs,
            prompt_tokens=_int_attribute(attrs, _PROMPT_TOKEN_KEYS),
            completion_tokens=_int_attribute(attrs, _COMPLETION_TOKEN_KEYS),
            model=span_model(attrs),
        ),
        "started_at": _nano_to_datetime(span.start_time_unix_nano),
        "duration_ms": span.duration_ms,
        "status": span_status_label(span),
    }


def span_index_rows_from_spans(spans: list[ArchivedTraceSpan], *, limit: int) -> list[dict]:
    """Bounded span summary rows for the span index — previews, never payloads.

    The bound is spent semantic-first. Traces run heavily to transport and
    framework plumbing, so a positional cut can bury every span a reviewer came
    for behind queue churn, and the listing shows semantic spans only — a trace
    whose whole allowance went to plumbing would read as empty rather than as
    truncated. Classification is dictionary lookups, so classifying every span
    to spend the budget well costs nothing measurable.
    """
    budget = max(0, limit)
    classified = [(span, recorded_span_kind(span)) for span in spans if span.span_id]
    chosen = [entry for entry in enumerate(classified) if entry[1][1] is not None][:budget]
    remaining = budget - len(chosen)
    if remaining > 0:
        chosen += [entry for entry in enumerate(classified) if entry[1][1] is None][:remaining]
    chosen.sort(key=lambda entry: entry[0])
    return [_span_index_row(span, kind) for _, (span, kind) in chosen]
