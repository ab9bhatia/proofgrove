"""Explicit span evidence bindings shared by preview and scoring execution."""

import asyncio
import hashlib
import json
import math
import re
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field

from evalhub.errors import EvaluationInputError
from evalhub.evaluation.adapters.deterministic_adapter import usage_total_tokens
from evalhub.evaluation.enums import EvaluationScope, MetricStatus, Scenario, ScoreSubjectKind, UnscoredReason
from evalhub.evaluation.evidence_requirements import metric_evidence_categories
from evalhub.evaluation.metrics import list_metrics
from evalhub.evaluation.models import ArchivedTraceSpan, EvaluationRow, ExperimentDefinition, MetricDefinition, MetricResult
from evalhub.platform.contracts import ResolvedScoringConfiguration
from evalhub.tracing.cost import span_token_usage
from evalhub.tracing.models import input_text, output_text, recorded_span_kind


class SpanSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trace_id: str = Field(min_length=1, max_length=128, pattern=r"\S")
    span_id: str = Field(min_length=1, max_length=128, pattern=r"\S")
    expected_response: str | None = Field(default=None, max_length=16_384)


class SpanScoringPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    spans: list[SpanSelection] = Field(min_length=1, max_length=100)


class SpanScoringRequest(SpanScoringPreviewRequest):
    request_id: UUID
    preview_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    metric_ids: list[str] = Field(min_length=1, max_length=10)
    judge_model: str = Field(default="", max_length=128)


def full_execution_span_checks(scope: EvaluationScope, definitions: list[dict], metric_ids: list[str]) -> dict | None:
    """Freeze compatible selected checks for the existing Full execution flow."""
    if scope != EvaluationScope.FULL_EXECUTION:
        return None
    selected = [definition for definition in definitions if definition["metric_id"] in metric_ids and definition.get("span_kinds") and not definition.get("requires_ground_truth") and definition.get("available_in_run", True)]
    if not selected:
        return None
    return {"metric_ids": [definition["metric_id"] for definition in selected], "metric_definitions": selected}


def preview_fingerprint(items: list[dict]) -> str:
    return hashlib.sha256(json.dumps(items, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def span_evaluation_row(span: ArchivedTraceSpan, selection: SpanSelection) -> EvaluationRow:
    """Bind only this span's captured IO; never substitute its case or parent."""
    if (span.trace_id, span.span_id) != (selection.trace_id, selection.span_id):
        raise EvaluationInputError("Selected span does not match the captured evidence")
    documents = sorted((int(match[1]), value) for key, value in (span.attributes or {}).items() if (match := re.fullmatch(r"retrieval\.documents\.(\d+)\.document\.content", key)) and isinstance(value, str) and value.strip())
    return EvaluationRow(
        context=[value for _, value in documents],
        row_id=hashlib.sha256(f"{span.trace_id}:{span.span_id}".encode()).hexdigest(),
        query=input_text(span.attributes or {}) or "",
        response=output_text(span.attributes or {}) or "",
        expected_response=selection.expected_response,
        trace_id=span.trace_id,
        span_id=span.span_id,
        latency_ms=span.duration_ms if span.duration_ms is not None and math.isfinite(span.duration_ms) and span.duration_ms >= 0 else None,
        target_usage=span_token_usage(span.attributes or {}),
    )


def preview_span(span: ArchivedTraceSpan, selection: SpanSelection, *, definitions: list[dict] | None = None) -> dict:
    row = span_evaluation_row(span, selection)
    kind = recorded_span_kind(span)
    checks = []
    for metric in [MetricDefinition.model_validate(item) for item in definitions] if definitions is not None else list_metrics():
        if not metric.span_kinds:
            continue
        reason = None
        if kind not in metric.span_kinds:
            reason = "This check does not support the recorded span type."
        elif not metric.available_in_run:
            reason = metric.availability_note or "This check is not available."
        elif metric.requires_ground_truth and not (row.expected_response or "").strip():
            reason = "Provide an expected response for this span."
        elif metric.metric_id.startswith("ops."):
            values = {
                "ops.latency": row.latency_ms,
                "ops.input_token_count": (row.target_usage or {}).get("prompt_tokens"),
                "ops.output_token_count": (row.target_usage or {}).get("completion_tokens"),
                "ops.total_token_count": usage_total_tokens(row.target_usage or {}),
            }
            if values.get(metric.metric_id) is None:
                reason = "This measurement was not recorded on the span."
        elif metric.metric_id == "rag.chunk_relevance":
            if not row.query or not row.context:
                reason = "This check needs the span's query and recorded retrieval documents."
            elif len(row.query) + sum(map(len, row.context)) > 16_384:
                reason = "The captured retrieval evidence is too large for this scoring flow."
        elif not row.response:
            reason = "This span has no captured output."
        elif max(len(row.query), len(row.response)) > 16_384:
            reason = "The captured input or output is too large for this scoring flow."
        elif metric.metric_id == "llm.relevance" and not row.query:
            reason = "This span has no captured input."
        checks.append(
            {
                "metric_id": metric.metric_id,
                "name": metric.name,
                "description": metric.description,
                "available": reason is None,
                "unavailable_reason": reason,
                "scoring_type": metric.scoring_type.value,
                "definition_hash": preview_fingerprint([metric.model_dump(mode="json")]),
            }
        )
    return {
        "trace_id": span.trace_id,
        "span_id": span.span_id,
        "name": span.name,
        "span_kind": kind,
        "input": row.query,
        "context": row.context,
        "output": row.response,
        "expected_response": row.expected_response,
        "checks": checks,
        "latency_ms": row.latency_ms,
        "target_usage": row.target_usage,
    }


async def execute_span_scoring(*, job_id: str, params: dict, judge_model: str, engine, store) -> None:
    """Score frozen span IO with the existing engine, persisting only span results."""
    results = list(params.get("results") or [])
    definitions = params["metric_definitions"]
    from evalhub.evaluation.models import MetricDefinition

    configuration = ResolvedScoringConfiguration(
        configuration_id=job_id,
        configuration_hash=preview_fingerprint(definitions),
        scenario=Scenario.LLM_CORE,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
        metric_ids=params["metric_ids"],
        metric_definitions=definitions,
        metric_evidence_requirements={item["metric_id"]: metric_evidence_categories(MetricDefinition.model_validate(item)) for item in definitions},
        diagnostic_only=True,
    )
    completed = {(result["trace_id"], result["span_id"]) for result in results}
    for item in params["items"]:
        identity = (item["trace_id"], item["span_id"])
        if identity in completed:
            continue
        row = EvaluationRow(
            row_id=hashlib.sha256(f"{identity[0]}:{identity[1]}".encode()).hexdigest(),
            query=item["input"],
            context=item.get("context", []),
            response=item["output"],
            expected_response=item["expected_response"],
            trace_id=identity[0],
            span_id=identity[1],
            latency_ms=item.get("latency_ms"),
            target_usage=item.get("target_usage"),
        )
        experiment = ExperimentDefinition(
            name="Span scoring",
            experiment_id=job_id,
            dataset_version=f"span-evidence:{params['preview_hash']}",
            target_endpoint="captured-span",
            scenario=Scenario.LLM_CORE,
            judge_model=judge_model,
            has_ground_truth=bool(row.expected_response),
            project_id=params["project_id"],
            tenant_id=params["tenant_id"],
        )
        available_ids = []
        for check in item["checks"]:
            if check["metric_id"] not in params["metric_ids"]:
                continue
            if check["available"]:
                available_ids.append(check["metric_id"])
                continue
            definition = next(entry for entry in definitions if entry["metric_id"] == check["metric_id"])
            results.append(
                MetricResult(
                    metric_id=check["metric_id"],
                    evaluator_instance_id=f"{check['metric_id']}::{job_id}",
                    run_id=job_id,
                    row_id=row.row_id,
                    subject_kind=ScoreSubjectKind.SPAN,
                    trace_id=identity[0],
                    span_id=identity[1],
                    score=None,
                    normalised_score=None,
                    passed=None,
                    threshold_result=None,
                    threshold=definition["default_threshold_pass"],
                    metric_status=MetricStatus.UNSCORED,
                    unscored_reason=UnscoredReason.EVIDENCE_UNAVAILABLE,
                    rationale=check["unavailable_reason"],
                    execution_status="unscored",
                    requested_scorer=definition["default_adapter"],
                    dataset_version=experiment.dataset_version,
                ).model_dump(mode="json")
            )
        if not available_ids:
            await store.save_span_scoring_results(job_id, results)
            continue
        scored = await asyncio.to_thread(
            engine.execute,
            experiment,
            [row],
            run_id=job_id,
            metric_ids=available_ids,
            scoring_configuration=configuration.model_copy(update={"metric_ids": available_ids}),
        )
        for result in scored.metric_results:
            values = result.model_dump(mode="json")
            # Evidence is already frozen once per span in the job snapshot.
            values.update(sample_input=None, sample_output=None)
            values.update(subject_kind=ScoreSubjectKind.SPAN.value, trace_id=identity[0], span_id=identity[1], target_trace_id=identity[0], target_span_id=identity[1])
            results.append(MetricResult.model_validate(values).model_dump(mode="json"))
        await store.save_span_scoring_results(job_id, results)


async def enqueue_automatic_span_checks(*, store, tenant_id: str, project_id: str, run_id: str, spans: list[ArchivedTraceSpan]) -> None:
    """Apply Full execution checks to the matching recorded operations."""
    source = await store.get_run_job(run_id, tenant_id=tenant_id)
    policy = source.params.get("span_checks") if source else None
    if not policy or source.params.get("project_id") != project_id:
        return
    for span in spans:
        definitions = [definition for definition in policy["metric_definitions"] if recorded_span_kind(span) in definition.get("span_kinds", [])]
        if not definitions:
            continue
        job_id = str(uuid5(NAMESPACE_URL, f"automatic-span:{tenant_id}:{run_id}:{span.trace_id}:{span.span_id}"))
        job = await store.get_run_job(job_id, tenant_id=tenant_id)
        if job is None:
            item = preview_span(span, SpanSelection(trace_id=span.trace_id, span_id=span.span_id), definitions=definitions)
            fingerprint = preview_fingerprint([item])
            job = await store.create_span_scoring_job(
                job_id=job_id,
                tenant_id=tenant_id,
                judge_model=source.judge_model or "",
                params={
                    "project_id": project_id,
                    "tenant_id": tenant_id,
                    "source_run_id": run_id,
                    "request_hash": fingerprint,
                    "preview_hash": fingerprint,
                    "items": [item],
                    "metric_ids": [definition["metric_id"] for definition in definitions],
                    "metric_definitions": definitions,
                    "span_keys": {f"{span.trace_id}:{span.span_id}": True},
                    "results": [],
                },
            )
        from evalhub.settings import settings

        if settings.evaluation_runtime == "temporal" and job.status == "pending":
            from temporalio.exceptions import WorkflowAlreadyStartedError

            from evalhub.orchestrator.temporal import submit_dataset_run

            try:
                await submit_dataset_run(job_id)
            except WorkflowAlreadyStartedError:
                # Idempotent by design: another caller already started this
                # job's workflow (e.g. a concurrent enqueue), so there is
                # nothing left to do here.
                pass
