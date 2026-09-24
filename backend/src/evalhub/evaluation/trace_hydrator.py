"""Hydrate evaluation rows from archived OTEL spans before scoring.

Phoenix and Confident AI treat telemetry as the source of truth for tool and
full-execution depth: they invoke the target so spans exist, wait for the root
span to close and the ordered child-span trajectory to be finalized, then score
those attributes asynchronously. Final-response depth grades only the live A2A
input and output (``a2a-capture-fallback``) and does not wait on the archive.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from datetime import UTC, datetime
from typing import Any, Protocol

from evalhub.evaluation.enums import EvaluationScope, ProvenanceStatus
from evalhub.evaluation.models import (
    ArchivedTraceSpan,
    EvaluationRow,
    RunItemTraceEvidence,
    ToolCall,
)
from evalhub.evaluation.target.a2a_client import externalize_large_tool_results
from evalhub.evaluation.trace_archive import TraceArchiveReader, tenant_from_namespace
from evalhub.settings import Settings
from evalhub.settings import settings as default_settings
from evalhub.tracing.models import (
    output_text,
    semantic_span_kind,
)

logger = logging.getLogger(__name__)

TELEMETRY_EVIDENCE_SOURCE = "otel-archive"
TELEMETRY_PENDING_SOURCE = "otel-archive-pending"
A2A_FALLBACK_EVIDENCE_SOURCE = "a2a-capture-fallback"

_TOOL_OPERATIONS = frozenset({"execute_tool", "tool.call", "invoke_tool", "tools"})
_OUTPUT_KINDS = ("agent", "chain", "llm")
_DOCUMENT_CONTENT = re.compile(r"^retrieval\.documents\.(\d+)\.document\.content$")
_OUTPUT_TOO_LARGE = "AGENT_OUTPUT_TOO_LARGE"


class TraceLookup(Protocol):
    """The archive-reader surface the hydrator needs."""

    async def find(
        self,
        *,
        trace_id: str | None,
        tenant: str,
        started_at: datetime | None,
        completed_at: datetime | None,
        relevant_only: bool = False,
    ) -> RunItemTraceEvidence: ...


def _span_sort_key(start_time_unix_nano: object) -> int:
    """Best-effort ordering key: unparseable/missing timestamps sort as 0."""

    try:
        return int(start_time_unix_nano or 0)
    except (TypeError, ValueError):
        return 0


def extract_scoring_evidence(
    spans: list[ArchivedTraceSpan],
) -> tuple[str | None, list[ToolCall], list[str]]:
    """Map OpenInference / GenAI spans onto response, tools, and retrieval text."""

    ordered = sorted(spans, key=lambda span: _span_sort_key(span.start_time_unix_nano))
    tools = [_tool_call_from_span(span) for span in ordered if _is_tool_span(span)]
    retrieval = [text for span in ordered if (semantic_span_kind(span) or "") == "retriever" for text in _retrieval_texts(span)]
    response: str | None = None
    # Ordered preference, and it is load-bearing: the delivered answer is the
    # agent's own output, not the last model turn that happened to produce text.
    # Both were previously compared against the OTLP transport kind, which never
    # equals any of these, so every lookup fell through to "the last span with
    # any output" — fine when the read returned nothing, wrong now that it
    # returns the model's internal turns too.
    for kind in _OUTPUT_KINDS:
        for span in reversed(ordered):
            if (semantic_span_kind(span) or "") != kind:
                continue
            text = output_text(span.attributes or {})
            if text:
                response = text
                break
        if response:
            break
    if not response:
        for span in reversed(ordered):
            if _is_tool_span(span) or (semantic_span_kind(span) or "") == "retriever":
                continue
            text = output_text(span.attributes or {})
            if text:
                response = text
                break
    return response, tools, retrieval


def uses_a2a_capture_for_scoring(evaluation_scope: EvaluationScope | None) -> bool:
    """Final-response depth grades live input/output; it does not wait for traces."""

    return evaluation_scope == EvaluationScope.FINAL_RESPONSE


def incomplete_archive_mode(
    cfg: Settings,
    *,
    evaluation_scope: EvaluationScope | None = None,
) -> str:
    """How to treat an incomplete archived trajectory after a bounded wait.

    ``defer`` protects the private invoked-row snapshot while the run service
    publishes a separate response-safe partial result. It does not mean the
    customer-visible run remains active. Disabling it restores the legacy
    immediate fallback/discard behavior without late enrichment.
    """

    if uses_a2a_capture_for_scoring(evaluation_scope):
        return "fallback"
    if cfg.trace_archive_deferred_score:
        return "defer"
    if cfg.trace_archive_score_fallback_to_capture:
        return "fallback"
    return "discard"


def apply_a2a_capture_scoring(
    row: EvaluationRow,
    *,
    reason: str = "final_response_scope",
) -> None:
    """Grade the live A2A / session input and output without waiting on the archive."""

    _keep_capture_as_fallback(row, reason=reason, trace_id=row.trace_id)


def row_awaiting_completed_trace(row: EvaluationRow) -> bool:
    """True when scoring is parked until the archived trajectory is finalized."""

    return (row.output_data or {}).get("response_source") == TELEMETRY_PENDING_SOURCE


async def hydrate_row_from_archive(
    row: EvaluationRow,
    *,
    tenant_id: str | None,
    selected_tool_ids: list[str] | None = None,
    settings: Settings | None = None,
    reader: TraceLookup | None = None,
    started_at: datetime | None = None,
    timeout_seconds: float | None = None,
    incomplete_mode: str | None = None,
) -> None:
    """Wait for the row's archived trace and replace session-captured scoring fields.

    No-op when the archive is disabled, so environments without MinIO keep the
    existing A2A / session scoring path. Scoring uses a completed trajectory
    (root span closed, child spans finalized). When the wait window expires:

    * ``defer`` (default when the archive is on) keeps A2A capture privately
      and marks the row pending so a background worker can score later
    * ``fallback`` grades the A2A / session capture immediately
    * ``discard`` leaves the row without tool evidence
    """

    cfg = settings or default_settings
    if not cfg.trace_archive_enabled:
        return
    if _skip_hydrate(row):
        return
    mode = incomplete_mode or incomplete_archive_mode(cfg)
    fallback = mode == "fallback"
    if not row.trace_id:
        if row.from_agent:
            _miss_or_defer(row, mode=mode, reason="missing_trace_id")
        return
    raw_tenant = (tenant_id or "").strip()
    if not raw_tenant:
        _miss_or_defer(row, mode=mode, reason="missing_tenant")
        return
    tenant = tenant_from_namespace(raw_tenant)

    lookup = reader or TraceArchiveReader(cfg)
    wait_timeout = cfg.trace_archive_score_timeout_seconds if timeout_seconds is None else timeout_seconds
    evidence = await wait_for_archived_trace(
        lookup,
        trace_id=row.trace_id,
        tenant=tenant,
        started_at=started_at,
        timeout_seconds=wait_timeout,
        poll_seconds=cfg.trace_archive_score_poll_seconds,
        settle_seconds=cfg.trace_archive_completion_settle_seconds,
        min_identical_observations=cfg.trace_archive_completion_min_identical_observations,
    )
    apply_telemetry_to_row(
        row,
        evidence,
        selected_tool_ids=selected_tool_ids,
        fallback_to_capture=fallback,
        incomplete_mode=mode,
        settings=cfg,
    )


async def wait_for_archived_trace(
    reader: TraceLookup,
    *,
    trace_id: str,
    tenant: str,
    started_at: datetime | None,
    timeout_seconds: float,
    poll_seconds: float,
    settle_seconds: float = 0.0,
    min_identical_observations: int = 1,
    sleep=asyncio.sleep,
) -> RunItemTraceEvidence:
    """Poll the archive until the trajectory is complete, unconfigured, or time runs out.

    Complete means pagination finished and the root span has closed (or an
    explicit execution-complete marker is present). Partial objects are not
    treated as ready for scoring.
    """

    deadline = time.monotonic() + max(0.0, timeout_seconds)
    interval = max(0.05, poll_seconds)
    settle = max(0.0, settle_seconds) if timeout_seconds > 0 else 0.0
    last: RunItemTraceEvidence | None = None
    stable_fingerprint: str | None = None
    stable_for = 0.0
    identical_observations = 0
    while True:
        last = await reader.find(
            trace_id=trace_id,
            tenant=tenant,
            started_at=started_at,
            completed_at=None,
            relevant_only=True,
        )
        if last.state == "not_configured":
            return last
        complete = last.state == "available" and last.evidence_complete
        if complete:
            fingerprint = trace_evidence_fingerprint(last)
            required_observations = max(1, min_identical_observations)
            if settle == 0 and required_observations == 1:
                return last
            if fingerprint == stable_fingerprint:
                identical_observations += 1
                if stable_for >= settle and identical_observations >= required_observations:
                    return last
            else:
                stable_fingerprint = fingerprint
                stable_for = 0.0
                identical_observations = 1
        else:
            stable_fingerprint = None
            stable_for = 0.0
            identical_observations = 0
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            if complete:
                return last.model_copy(
                    update={
                        "evidence_complete": False,
                        "completion_diagnostic": "archive_not_settled",
                        "message": "Trace lifecycle completed but the archive snapshot did not settle before the deadline.",
                    }
                )
            return last
        sleep_for = min(interval, remaining)
        await sleep(sleep_for)
        if stable_fingerprint is not None:
            stable_for += sleep_for


def apply_telemetry_to_row(
    row: EvaluationRow,
    evidence: RunItemTraceEvidence,
    *,
    selected_tool_ids: list[str] | None = None,
    fallback_to_capture: bool = True,
    incomplete_mode: str | None = None,
    settings: Settings | None = None,
) -> None:
    """Overwrite scoring fields from a completed archived trajectory.

    Incomplete traces (root still open, pagination unfinished, or no relevant
    spans yet) are not graded. ``incomplete_mode`` chooses defer / fallback /
    discard; ``fallback_to_capture`` is the legacy alias for fallback vs discard
    when ``incomplete_mode`` is omitted.
    """

    mode = incomplete_mode or ("fallback" if fallback_to_capture else "discard")
    if evidence.state == "not_configured":
        _miss_archive(
            row,
            fallback=mode != "discard",
            reason="not_configured",
            trace_id=evidence.trace_id or row.trace_id,
        )
        return
    complete = evidence.state == "available" and bool(evidence.spans) and evidence.evidence_complete
    if not complete:
        reason = evidence.state
        if evidence.state == "available" and not evidence.evidence_complete:
            reason = evidence.completion_diagnostic or "incomplete_trajectory"
        elif evidence.state == "available" and not evidence.spans:
            reason = "empty_relevant_spans"
        _miss_or_defer(
            row,
            mode=mode,
            reason=reason,
            trace_id=evidence.trace_id or row.trace_id,
        )
        return

    response, tools, retrieval = extract_scoring_evidence(evidence.spans)
    output = dict(row.output_data or {})
    output.pop("archive_pending_reason", None)
    output.pop("archive_fallback_reason", None)
    if response:
        row.response = response
        output["response"] = response
    output["response_source"] = TELEMETRY_EVIDENCE_SOURCE
    row.output_data = output
    cfg = settings or default_settings
    row.tool_calls, row.tool_result_artifacts = externalize_large_tool_results(
        tools, max_inline_bytes=cfg.agent_max_inline_tool_result_bytes
    )
    # Judge context is built from the bounded calls too -- otherwise an
    # externalized (artifact-only) output would still land verbatim here,
    # defeating the inline budget the externalization above just enforced.
    tool_ctx = _tool_output_texts(row.tool_calls, selected_tool_ids)
    dataset_ctx = list(row.retrieval_snippets or [])
    if retrieval:
        row.context = [*retrieval, *tool_ctx]
        row.retrieval_snippets = retrieval
    else:
        row.context = [*dataset_ctx, *tool_ctx]
    row.trace_unavailable = False
    row.tool_evidence_completion_attested = True
    row.tool_evidence_provenance_status = ProvenanceStatus.ATTESTED
    row.tool_evidence_source = TELEMETRY_EVIDENCE_SOURCE
    row.trace_completion_attested = evidence.evidence_complete
    row.lifecycle_completion_attested = evidence.lifecycle_complete
    # The target invocation owns aggregate usage. Once the archived root closes,
    # the invocation report is final for that execution. Do not sum nested LLM
    # spans: wrappers may repeat child usage and there is no portable ownership
    # convention for separating repeated figures from independent calls.
    row.model_usage_completion_attested = bool(
        evidence.evidence_complete and _reported_usage_total(row.target_usage) is not None
    )
    # Span count remains useful evidence in its own right.
    # generation may be a wrapper repeating its child's figures, or an
    # independent call of its own, and nothing recorded distinguishes the two.
    # Counting both double-counts; counting only the innermost undercounts a
    # genuinely nested pair. Measured on this archive the difference was 2,841
    # against 947 for one trace. It feeds ops.token_efficiency, so a convention
    # for which span owns a call has to be agreed before deriving it.
    row.trace_span_count = len(evidence.spans)
    output = dict(row.output_data or {})
    output["trace_evidence_fingerprint"] = trace_evidence_fingerprint(evidence)
    output["trace_evidence_span_count"] = len(evidence.spans)
    output["trace_evidence_object_count"] = len(evidence.object_refs)
    output["trace_evidence_observed_at"] = datetime.now(UTC).isoformat()
    row.output_data = output


def trace_evidence_fingerprint(evidence: RunItemTraceEvidence) -> str:
    """Return a stable digest of every archived field that can affect scoring.

    Span IDs alone are insufficient because an exporter can first archive a
    span and later archive the same span with its final status, attributes,
    events, or output. Object references are included as an additional signal
    that a new collector batch arrived. Retrieval timestamps describe the read,
    not the execution, and must not make an unchanged snapshot look different.
    Include interpreted evidence so improved attribute mappings can enrich a
    previously scored run even when its archived spans have not changed.
    """

    spans = sorted(
        (span.model_dump(mode="json", exclude={"retrieved_at"}) for span in evidence.spans),
        key=lambda span: (
            str(span.get("span_id") or ""),
            str(span.get("start_time_unix_nano") or ""),
            str(span.get("name") or ""),
        ),
    )
    response, tools, retrieval = extract_scoring_evidence(evidence.spans)
    canonical = {
        "trace_id": evidence.trace_id,
        "object_refs": sorted(evidence.object_refs),
        "pagination_complete": evidence.pagination_complete,
        "lifecycle_complete": evidence.lifecycle_complete,
        "truncated": evidence.truncated,
        "spans": spans,
        "scoring_evidence": {
            "response": response,
            "tools": [tool.model_dump(mode="json") for tool in tools],
            "retrieval": retrieval,
        },
    }
    encoded = json.dumps(
        canonical,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _reported_usage_total(usage: dict[str, Any] | None) -> int | None:
    """Return a positive invocation-owned token total, if one was reported."""

    if not isinstance(usage, dict):
        return None

    def _count(*keys: str) -> int | None:
        for key in keys:
            value = usage.get(key)
            if isinstance(value, bool):
                continue
            if isinstance(value, int) and value >= 0:
                return value
            if isinstance(value, str) and value.isdecimal():
                return int(value)
        return None

    total = _count("total_tokens", "total_token_count")
    if total is None:
        prompt = _count("prompt_tokens", "input_tokens", "prompt_token_count")
        completion = _count(
            "completion_tokens", "output_tokens", "candidates_token_count"
        )
        if prompt is None or completion is None:
            return None
        total = prompt + completion
    return total or None


def _skip_hydrate(row: EvaluationRow) -> bool:
    if row.invocation_error:
        return True
    tags = row.tags or {}
    return tags.get("error_type") == _OUTPUT_TOO_LARGE


def _miss_or_defer(
    row: EvaluationRow,
    *,
    mode: str,
    reason: str,
    trace_id: str | None = None,
) -> None:
    if mode == "defer":
        _defer_archive(row, reason=reason, trace_id=trace_id)
        return
    _miss_archive(row, fallback=mode == "fallback", reason=reason, trace_id=trace_id)


def _miss_archive(
    row: EvaluationRow,
    *,
    fallback: bool,
    reason: str,
    trace_id: str | None = None,
) -> None:
    if fallback:
        _keep_capture_as_fallback(row, reason=reason, trace_id=trace_id)
        return
    logger.warning(
        "eval-hub: archived trace %s not available for scoring (%s)",
        trace_id or row.trace_id,
        reason,
    )
    _discard_session_evidence(row)


def _defer_archive(
    row: EvaluationRow,
    *,
    reason: str,
    trace_id: str | None = None,
) -> None:
    """Keep A2A capture privately until the completed trajectory lands."""

    logger.info(
        "eval-hub: archived trace %s not ready for scoring (%s); waiting for complete, settled evidence",
        trace_id or row.trace_id,
        reason,
    )
    output = dict(row.output_data or {})
    output["response_source"] = TELEMETRY_PENDING_SOURCE
    output["archive_pending_reason"] = reason
    output.pop("archive_fallback_reason", None)
    row.output_data = output


def _keep_capture_as_fallback(
    row: EvaluationRow,
    *,
    reason: str,
    trace_id: str | None = None,
) -> None:
    """Preserve live capture after the archive wait without attesting its tools.

    Response-only metrics can still score. The engine sees
    ``tool_evidence_completion_attested=False`` and abstains from every metric
    whose contract requires complete tool calls or tool results.
    """

    logger.warning(
        "eval-hub: archived trace %s not available (%s); preserving A2A response and abstaining from trace-dependent metrics",
        trace_id or row.trace_id,
        reason,
    )
    output = dict(row.output_data or {})
    output["response_source"] = A2A_FALLBACK_EVIDENCE_SOURCE
    output["archive_fallback_reason"] = reason
    row.output_data = output
    if row.trace_unavailable:
        return
    # The archive never confirmed this execution, so nothing attests that the
    # captured tool set is complete. Keep self-reported capture for inspection
    # and response evaluation, but never claim completeness on the archive's
    # behalf; the engine will abstain from tool-dependent metrics.
    row.tool_evidence_completion_attested = False
    row.trace_completion_attested = False
    row.model_usage_completion_attested = False
    row.lifecycle_completion_attested = False
    if row.tool_evidence_provenance_status == ProvenanceStatus.UNAVAILABLE:
        row.tool_evidence_provenance_status = ProvenanceStatus.SELF_REPORTED
    row.tool_evidence_source = A2A_FALLBACK_EVIDENCE_SOURCE


def _discard_session_evidence(row: EvaluationRow) -> None:
    """Drop A2A/session tools when the operator has disabled capture fallback."""

    row.tool_calls = []
    row.tool_result_artifacts = []
    row.context = list(row.retrieval_snippets or [])
    row.trace_unavailable = True
    row.trace_completion_attested = False
    row.model_usage_completion_attested = False
    row.lifecycle_completion_attested = False
    row.tool_evidence_completion_attested = False
    row.tool_evidence_provenance_status = ProvenanceStatus.UNAVAILABLE
    row.tool_evidence_source = None


def _is_tool_span(span: ArchivedTraceSpan) -> bool:
    kind = semantic_span_kind(span) or ""
    if kind == "tool":
        return True
    attrs = span.attributes or {}
    if attrs.get("gen_ai.tool.name") or attrs.get("tool.name"):
        return True
    operation = str(attrs.get("gen_ai.operation.name") or "").strip().lower()
    return operation in _TOOL_OPERATIONS


def _tool_call_from_span(span: ArchivedTraceSpan) -> ToolCall:
    attrs = span.attributes or {}
    name = attrs.get("gen_ai.tool.name") or attrs.get("tool.name") or attrs.get("llm.function_call.name") or span.name
    # kagent's ADK runtime uses Vertex attribute names for the MCP payloads.
    # Prefer standard attributes when both conventions are present, preserving
    # empty arguments and falsy results as valid captured values.
    raw_args = next((attrs[key] for key in (
        "tool.parameters", "gen_ai.tool.call.arguments", "llm.function_call.arguments",
        "input.value", "gcp.vertex.agent.tool_call_args",
    ) if attrs.get(key) is not None), None)
    parsed = _jsonish(raw_args)
    args = parsed if isinstance(parsed, dict) else ({"input": parsed} if parsed not in (None, "") else {})
    output = next((attrs[key] for key in (
        "output.value", "tool.output", "gen_ai.tool.call.result", "gcp.vertex.agent.tool_response",
    ) if attrs.get(key) is not None), None)
    return ToolCall(
        name=str(name or "unnamed_tool"),
        args=args if isinstance(args, dict) else {},
        output=output,
        result_captured=output is not None,
    )


def _retrieval_texts(span: ArchivedTraceSpan) -> list[str]:
    attrs = span.attributes or {}
    indexed: list[tuple[int, str]] = []
    for key, value in attrs.items():
        match = _DOCUMENT_CONTENT.match(key)
        if match and isinstance(value, str) and value.strip():
            indexed.append((int(match.group(1)), value.strip()))
    if indexed:
        indexed.sort()
        return [text for _, text in indexed]
    output = attrs.get("output.value")
    if isinstance(output, str) and output.strip():
        return [output.strip()]
    if isinstance(output, list):
        return [str(item) for item in output if item]
    return []


def _jsonish(value: Any) -> Any:
    if isinstance(value, (dict, list)) or value is None:
        return value
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if not stripped:
        return ""
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return value


def _tool_output_texts(
    tool_calls: list[ToolCall],
    selected_tool_ids: list[str] | None,
) -> list[str]:
    selected = {name.strip().casefold() for name in selected_tool_ids if name.strip()} if selected_tool_ids is not None else None
    texts: list[str] = []
    for call in tool_calls:
        if call.output is None or call.output == "":
            continue
        if selected is not None and call.name.strip().casefold() not in selected:
            continue
        texts.append(call.output if isinstance(call.output, str) else json.dumps(call.output, ensure_ascii=False, default=str))
    return texts
