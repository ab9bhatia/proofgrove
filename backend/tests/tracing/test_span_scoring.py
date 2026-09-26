"""Span evidence, durable retries and case-result isolation."""

from unittest.mock import AsyncMock

import pytest
from sqlalchemy import func, select

from proofgrove.db.models import EvaluationRunORM
from proofgrove.db.session import async_session
from proofgrove.db.store import EvaluationStore, RunCancelledError
from proofgrove.evaluation.adapters.dispatcher import AdapterDispatchJudge
from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.metrics import get_metric
from proofgrove.evaluation.models import ArchivedTraceSpan
from proofgrove.settings import Settings
from proofgrove.tracing.scoring import SpanSelection, execute_span_scoring, preview_fingerprint, preview_span


def evidence(**attributes):
    return ArchivedTraceSpan(
        trace_id="a" * 32,
        span_id="b" * 16,
        name="answer",
        duration_ms=250,
        attributes={"openinference.span.kind": "LLM", **attributes},
    )


def preview(span):
    return preview_span(span, SpanSelection(trace_id=span.trace_id, span_id=span.span_id))


def test_compatibility_uses_recorded_kind_and_own_evidence():
    span = evidence(**{"input.value": "Question", "output.value": "Answer", "llm.token_count.prompt": 0})
    item = preview(span)
    checks = {entry["metric_id"]: entry for entry in item["checks"]}
    assert item["input"] == "Question" and item["output"] == "Answer"
    assert item["expected_response"] is None
    assert checks["llm.relevance"]["available"]
    assert not checks["llm.correctness"]["available"]
    assert checks["ops.input_token_count"]["available"]
    assert not checks["ops.total_token_count"]["available"]
    span.attributes.pop("openinference.span.kind")
    span.attributes["gen_ai.operation.name"] = "chat"
    assert preview(span)["span_kind"] == "llm"
    assert any(check["available"] for check in preview(span)["checks"])


@pytest.mark.asyncio
async def test_measurements_are_persisted_only_on_span_job_and_retries_reuse_results(monkeypatch):
    from proofgrove.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", "tenant-tenant")
    span = evidence()
    span.duration_ms = 250.125
    item = preview(span)
    params = {
        "project_id": "project",
        "tenant_id": "tenant",
        "request_hash": "request",
        "preview_hash": preview_fingerprint([item]),
        "items": [item],
        "metric_ids": ["ops.latency"],
        "metric_definitions": [get_metric("ops.latency").model_dump(mode="json")],
        "span_keys": {f"{item['trace_id']}:{item['span_id']}": True},
        "results": [],
    }
    async with async_session() as session:
        store = EvaluationStore(session)
        job = await store.create_span_scoring_job(job_id="span-job", tenant_id="tenant", params=params, judge_model="")
        assert (await store.create_span_scoring_job(job_id="span-job", tenant_id="tenant", params=params, judge_model="")).run_id == job.run_id
        with pytest.raises(ValueError, match="different scoring"):
            await store.create_span_scoring_job(job_id="span-job", tenant_id="tenant", params={**params, "request_hash": "other"}, judge_model="")
        await store.claim_run_job(job.run_id)
        await execute_span_scoring(job_id=job.run_id, params=params, judge_model="", engine=EvaluationEngine(judge=AdapterDispatchJudge(Settings(judge_mode="mock"))), store=store)
        await session.refresh(job)
        result = job.params["results"][0]
        assert result["subject_kind"] == "span"
        assert result["span_id"] == item["span_id"]
        assert result["score"] == 0.250125
        assert result["threshold_result"] is None
        assert result["normalised_score"] is None
        assert await session.scalar(select(func.count()).select_from(EvaluationRunORM)) == 0
        assert len(await store.list_span_scoring_jobs(tenant_id="tenant", project_id="project", trace_id=item["trace_id"], span_id=item["span_id"])) == 1
        assert len(await store.list_span_scoring_jobs(tenant_id="tenant-tenant", project_id="project", trace_id=item["trace_id"], span_id=item["span_id"])) == 1
        assert not await store.list_span_scoring_jobs(tenant_id="other", project_id="project", trace_id=item["trace_id"], span_id=item["span_id"])
        unused_engine = AsyncMock()
        await execute_span_scoring(job_id=job.run_id, params=job.params, judge_model="", engine=unused_engine, store=store)
        unused_engine.execute.assert_not_called()
        await store.complete_run_job(job.run_id)
        with pytest.raises(RunCancelledError):
            await store.save_span_scoring_results(job.run_id, [])


def test_retrieval_check_binds_only_openinference_documents():
    span = evidence(
        **{
            "openinference.span.kind": "RETRIEVER",
            "input.value": "Where is Paris?",
            "retrieval.documents.1.document.content": "France is in Europe.",
            "retrieval.documents.0.document.content": "Paris is in France.",
        }
    )
    item = preview(span)
    assert item["context"] == ["Paris is in France.", "France is in Europe."]
    assert next(check for check in item["checks"] if check["metric_id"] == "rag.chunk_relevance")["available"]


@pytest.mark.asyncio
async def test_automatic_checks_match_recorded_types_and_do_not_duplicate(monkeypatch):
    from proofgrove.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", "tenant-tenant")
    from proofgrove.evaluation.enums import EvaluationScope
    from proofgrove.tracing.scoring import enqueue_automatic_span_checks, full_execution_span_checks

    definitions = [get_metric(mid).model_dump(mode="json") for mid in ["ops.latency", "llm.correctness", "llm.relevance"]]
    assert full_execution_span_checks(EvaluationScope.FINAL_RESPONSE, definitions, ["ops.latency"]) is None
    assert full_execution_span_checks(EvaluationScope.TOOL_INTERACTIONS, definitions, ["ops.latency"]) is None
    policy = full_execution_span_checks(EvaluationScope.FULL_EXECUTION, definitions, ["ops.latency", "llm.correctness"])
    assert policy["metric_ids"] == ["ops.latency"]
    async with async_session() as session:
        store = EvaluationStore(session)
        run_id = await store.create_run_job(
            dataset_name="dataset",
            response_source="llm",
            agent=None,
            row_count=1,
            judge_model="",
            tenant_id="tenant",
            project_id="project",
            span_checks=policy,
        )
        span = evidence()
        legacy = evidence()
        legacy.span_id = "legacy"
        legacy.attributes = {"gen_ai.operation.name": "chat"}
        for _ in range(2):
            await enqueue_automatic_span_checks(store=store, tenant_id="tenant", project_id="project", run_id=run_id, spans=[span, legacy])
        jobs = await store.list_span_scoring_jobs(tenant_id="tenant", project_id="project", trace_id=span.trace_id, span_id=span.span_id)
        assert len(jobs) == 1
        assert jobs[0].params["source_run_id"] == run_id
        assert await store.automatic_span_scoring_counts(tenant_id="tenant", run_id=run_id) == {"pending": 2}
        assert await store.automatic_span_scoring_counts(tenant_id="tenant-tenant", run_id=run_id) == {"pending": 2}
        assert await store.automatic_span_scoring_counts(tenant_id="other", run_id=run_id) == {}
        assert len(await store.list_span_scoring_jobs(tenant_id="tenant", project_id="project", trace_id=span.trace_id, span_id="legacy")) == 1


@pytest.mark.parametrize("attributes,kind,source", [
    ({"openinference.span.kind": "TOOL", "gen_ai.operation.name": "chat"}, "tool", "openinference"),
    ({"gen_ai.operation.name": "generate_content"}, "llm", "telemetry_compatibility"),
    ({"gen_ai.operation.name": "execute_tool"}, "tool", "telemetry_compatibility"),
    ({"llm.request.type": "chat"}, "llm", "telemetry_compatibility"),
    ({"gcp.vertex.agent.llm_request": "{}", "gcp.vertex.agent.llm_response": "{}"}, "llm", "telemetry_compatibility"),
    ({"gcp.vertex.agent.tool_call_args": "{}", "gcp.vertex.agent.tool_response": "done"}, "tool", "telemetry_compatibility"),
    ({"gen_ai.operation.name": "unknown", "llm.request.type": "chat"}, None, None),
    ({"gen_ai.request.model": "model", "gen_ai.usage.input_tokens": 20}, None, None),
    ({"gen_ai.conversation.id": "id", "tool.name": "advertised"}, None, None),
])
def test_explicit_compatibility_is_shared_by_serialization_index_and_scoring(attributes, kind, source):
    from proofgrove.tracing.models import span_index_rows_from_spans
    span = evidence()
    span.name = "call_llm tool network"
    span.attributes = attributes
    before = dict(attributes)
    assert span.model_dump()["semantic_kind"] == kind
    assert span.model_dump()["semantic_kind_source"] == source
    assert preview(span)["span_kind"] == kind
    assert span_index_rows_from_spans([span], limit=10)[0]["semantic_kind"] == kind
    assert span.attributes == before


def test_legacy_tool_uses_only_own_evidence_and_missing_llm_output_stays_unavailable():
    span = evidence()
    span.attributes = {"gcp.vertex.agent.tool_call_args": '{"city":"Paris"}', "gcp.vertex.agent.tool_response": "Sunny"}
    item = preview(span)
    assert item["input"] == '{"city":"Paris"}' and item["output"] == "Sunny"
    assert item["span_kind"] == "tool"
    span.attributes = {"gen_ai.operation.name": "generate_content"}
    checks = {check["metric_id"]: check for check in preview(span)["checks"]}
    assert not checks["llm.coherence"]["available"]
    assert checks["ops.latency"]["available"]
