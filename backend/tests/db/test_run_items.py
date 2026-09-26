"""First-class run-item evidence persistence and legacy reconstruction."""

import pytest
from sqlalchemy import delete, event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from proofgrove.db.models import Base, DatasetRowORM, EvaluationRunItemORM
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.enums import MetricStatus, Scenario
from proofgrove.evaluation.judge import MockJudge
from proofgrove.evaluation.models import (
    EvaluationRow,
    ExperimentDefinition,
    ToolCall,
    ToolResultArtifact,
)
from proofgrove.settings import settings


@pytest.fixture
async def store():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield EvaluationStore(session)
    await engine.dispose()


def _experiment(experiment_id: str = "run-items-exp") -> ExperimentDefinition:
    return ExperimentDefinition(
        experiment_id=experiment_id,
        name="Run item evidence",
        dataset_version="evidence.v3",
        target_endpoint="tenant/evidence-agent",
        scenario=Scenario.LLM_CORE,
        judge_model="mock",
        tenant_id="tenant-run-items",
    )


def _execute(
    rows: list[EvaluationRow], experiment_id: str = "run-items-exp"
):
    return EvaluationEngine(judge=MockJudge()).execute(
        _experiment(experiment_id), rows
    )


def _strings(value):
    if isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)
    elif isinstance(value, str):
        yield value


@pytest.mark.asyncio
async def test_experiment_rows_preserve_structured_evidence_through_run(
    store: EvaluationStore,
):
    experiment = _experiment("stored-evidence-experiment")
    await store.save_experiment(experiment)
    source = EvaluationRow(
        row_id="stored/evidence-1",
        query="Review the request",
        response="Approved",
        expected_response="Approve with checks",
        input_data={"messages": [{"role": "user", "content": "Review it"}]},
        output_data={"answer": "Approved", "citations": ["policy-4"]},
        expected_data={"answer": "Approve with checks", "rubric": "cite policy"},
        retrieval_snippets=["Policy 4"],
        tool_calls=[ToolCall(name="policy_search", args={"id": 4}, output="Policy 4")],
        span_id="span-stored",
        invocation_id="invocation-stored",
        kagent_session_id="session-stored",
        latency_ms=321,
        target_usage={"total_tokens": 12},
        invocation_error="recoverable target warning",
    )
    await store.add_rows(experiment.experiment_id, experiment.tenant_id, [source])

    stored_rows = await store.get_rows(experiment.experiment_id, experiment.tenant_id)
    assert len(stored_rows) == 1
    stored = stored_rows[0]
    assert stored.input_data == source.input_data
    assert stored.output_data == source.output_data
    assert stored.expected_data == source.expected_data
    assert stored.retrieval_snippets == ["Policy 4"]
    assert stored.span_id == "span-stored"
    assert stored.invocation_id == "invocation-stored"
    assert stored.kagent_session_id == "session-stored"
    assert stored.latency_ms == 321
    assert stored.target_usage == {"total_tokens": 12}
    assert stored.invocation_error == "recoverable target warning"

    run = EvaluationEngine(judge=MockJudge()).execute(experiment, stored_rows)
    await store.save_run(run, stored_rows)
    detail = await store.get_run_item(run.run_id, source.row_id)
    assert detail is not None
    assert detail.input == source.input_data
    assert detail.output == source.output_data
    assert detail.expected == source.expected_data
    assert detail.retrieval_snippets == ["Policy 4"]
    assert detail.tool_calls and detail.tool_calls[0].args == {"id": 4}
    assert detail.execution.invocation_id == "invocation-stored"
    assert detail.execution.kagent_session_id == "session-stored"
    assert detail.execution.latency_ms == 321
    assert detail.execution.usage == {"total_tokens": 12}
    assert detail.execution.invocation_error == "recoverable target warning"
    assert detail.execution.span_id == "span-stored"
    assert detail.evidence_ref.endswith("/items/stored%2Fevidence-1")


@pytest.mark.asyncio
async def test_large_tool_result_is_partial_evaluated_and_paged(store: EvaluationStore):
    content = "document-result-" + ("x" * 300_000)
    artifact = ToolResultArtifact(
        artifact_id="12345678-1234-1234-1234-123456789abc",
        artifact_ref="artifact://tool-results/12345678-1234-1234-1234-123456789abc",
        tool_name="document_search",
        tool_call_index=0,
        content_type="text/plain",
        content=content,
        size_bytes=len(content.encode()),
        preview=content[: 128 * 1024],
        preview_bytes=128 * 1024,
    )
    row = EvaluationRow(
        row_id="large-result",
        query="find the document",
        response="The final answer remains available.",
        tool_calls=[
            ToolCall(
                name="document_search",
                output={"artifact_ref": artifact.artifact_ref, "truncated": True},
            )
        ],
        tool_result_artifacts=[artifact],
    )
    run = _execute([row], "large-result-experiment")
    await store.save_run(run, [row])

    summary = (await store.list_run_items(run.run_id))[0]
    assert summary.evaluation_state == "evaluated"
    assert summary.capture_state == "complete"
    assert summary.artifact_count == 1
    assert summary.trace_available is False

    detail = await store.get_run_item(run.run_id, row.row_id)
    assert detail is not None
    assert detail.output == {"response": "The final answer remains available."}
    assert detail.tool_result_artifacts[0].tool_name == "document_search"

    first = await store.get_tool_result_artifact(
        run.run_id, row.row_id, artifact.artifact_id, limit=128 * 1024
    )
    assert first is not None
    assert first.complete is False
    assert first.next_offset == 128 * 1024
    second = await store.get_tool_result_artifact(
        run.run_id,
        row.row_id,
        artifact.artifact_id,
        offset=first.next_offset,
        limit=128 * 1024,
    )
    assert second is not None
    assert first.content + second.content == content[: 256 * 1024]


@pytest.mark.asyncio
async def test_experiment_rows_preserve_source_order_across_uploads(
    store: EvaluationStore,
):
    experiment = _experiment("ordered-source-experiment")
    await store.save_experiment(experiment)
    first = EvaluationRow(row_id="z-first", query="first", response="one")
    remainder = [
        EvaluationRow(row_id="a-second", query="second", response="two"),
        EvaluationRow(row_id="m-third", query="third", response="three"),
    ]

    await store.add_rows(experiment.experiment_id, experiment.tenant_id, [first])
    await store.add_rows(experiment.experiment_id, experiment.tenant_id, remainder)

    stored_rows = await store.get_rows(experiment.experiment_id, experiment.tenant_id)
    assert [row.row_id for row in stored_rows] == [
        "z-first",
        "a-second",
        "m-third",
    ]

    run = EvaluationEngine(judge=MockJudge()).execute(experiment, stored_rows)
    await store.save_run(run, stored_rows)
    summaries = await store.list_run_items(run.run_id)
    assert [item.example_id for item in summaries] == [
        "z-first",
        "a-second",
        "m-third",
    ]


@pytest.mark.asyncio
async def test_experiment_row_positions_are_unique_per_experiment(
    store: EvaluationStore,
):
    experiment = _experiment("unique-position-experiment")
    await store.save_experiment(experiment)
    await store.add_rows(
        experiment.experiment_id,
        experiment.tenant_id,
        [EvaluationRow(row_id="position-one", query="first", response="one")],
    )
    store.session.add(
        DatasetRowORM(
            row_id="position-two",
            experiment_id=experiment.experiment_id,
            sequence_position=0,
            query="second",
            response="two",
            context=[],
            expected_tools=[],
            tool_calls=[],
            trace_unavailable=False,
            from_agent=False,
            tags={},
        )
    )

    with pytest.raises(IntegrityError):
        await store.session.commit()
    await store.session.rollback()


@pytest.mark.asyncio
async def test_run_items_persist_in_dataset_order_with_full_evidence(
    store: EvaluationStore,
):
    rows = [
        EvaluationRow(
            row_id="example-b",
            query="Find the policy",
            response="The policy allows 30 days.",
            output_data={
                "response": "The policy allows 30 days.",
                "citations": ["policy-7"],
            },
            expected_response="30 days",
            context=["Policy text"],
            input_data={"question": "Find the policy", "locale": "en"},
            expected_data={"expected_answer": "30 days"},
            retrieval_snippets=["Policy text"],
            expected_tools=["search"],
            tool_calls=[
                ToolCall(
                    name="search",
                    args={"query": "policy"},
                    output="Policy text",
                )
            ],
            tags={"suite": "release"},
            invocation_id="invocation-b",
            kagent_session_id="session-b",
            latency_ms=1250,
            target_usage={"prompt_tokens": 10, "output_tokens": 4, "total_tokens": 14},
            trace_id="phoenix-trace-b",
            span_id="phoenix-span-b",
        ),
        EvaluationRow(
            row_id="example-a",
            query="Second row",
            response="Second answer",
            expected_response="Second expected",
            invocation_id="invocation-a",
            kagent_session_id="session-a",
            invocation_error="target returned a terminal error",
        ),
    ]
    run = _execute(rows)
    errored_result = next(
        result for result in run.metric_results if result.row_id == "example-b"
    )
    errored_result.error_message = "judge timed out"
    errored_result.execution_status = "error"
    errored_result.metric_status = MetricStatus.TECHNICAL_ERROR
    errored_result.error_details = {"type": "judge_timeout"}
    errored_result.score = None
    errored_result.normalised_score = None
    errored_result.passed = None
    errored_result.threshold_result = None
    await store.save_run(run, rows)

    summaries = await store.list_run_items(run.run_id)
    assert [item.example_id for item in summaries] == ["example-b", "example-a"]
    assert [item.query for item in summaries] == ["Find the policy", "Second row"]
    assert [item.sequence_position for item in summaries] == [0, 1]
    assert all(item.capture_state == "complete" for item in summaries)
    assert summaries[0].metric_count == len(run.active_metrics)
    assert summaries[0].error_count == 1
    assert summaries[0].evaluation_state == "technical_error"
    assert summaries[0].latency_ms == 1250
    assert summaries[0].trace_available is True

    detail = await store.get_run_item(run.run_id, "example-b")
    assert detail is not None
    assert detail.input == {"question": "Find the policy", "locale": "en"}
    assert detail.output == {
        "response": "The policy allows 30 days.",
        "citations": ["policy-7"],
    }
    assert detail.expected == {"expected_answer": "30 days"}
    assert detail.retrieval_snippets == ["Policy text"]
    assert detail.expected_tools == ["search"]
    assert detail.tool_calls and detail.tool_calls[0].output == "Policy text"
    assert detail.execution.invocation_id == "invocation-b"
    assert detail.execution.kagent_session_id == "session-b"
    assert detail.execution.trace_id == "phoenix-trace-b"
    assert detail.execution.span_id == "phoenix-span-b"
    assert detail.evidence_ref == (
        f"evidence-pack://{run.run_id}/items/example-b"
    )
    assert detail.evidence_policy.retention_policy == "stored_with_run_lifecycle"
    assert len(detail.scorer_results) == len(run.active_metrics)
    scorer = detail.scorer_results[0]
    assert scorer.evaluator_id and scorer.evaluator_version
    assert scorer.rationale
    assert scorer.threshold is not None
    assert scorer.judge_total_tokens is None
    assert scorer.executed_scorer == "mock"
    persisted_error = next(
        result for result in detail.scorer_results if result.error_message
    )
    assert persisted_error.error_message == "judge timed out"
    assert persisted_error.execution_status == "error"

    failed_detail = await store.get_run_item(run.run_id, "example-a")
    assert failed_detail is not None
    assert failed_detail.execution.invocation_error == (
        "target returned a terminal error"
    )


@pytest.mark.asyncio
async def test_run_item_identity_never_mixes_evidence_between_runs(
    store: EvaluationStore,
):
    first_rows = [
        EvaluationRow(
            row_id="shared-example",
            query="q",
            response="first run",
            invocation_id="first-invocation",
        )
    ]
    second_rows = [
        EvaluationRow(
            row_id="shared-example",
            query="q",
            response="second run",
            invocation_id="second-invocation",
        )
    ]
    first = _execute(first_rows, "shared-experiment")
    second = _execute(second_rows, "shared-experiment")
    await store.save_run(first, first_rows)
    await store.save_run(second, second_rows)

    first_detail = await store.get_run_item(first.run_id, "shared-example")
    second_detail = await store.get_run_item(second.run_id, "shared-example")
    assert first_detail and second_detail
    assert first_detail.output == {"response": "first run"}
    assert first_detail.execution.invocation_id == "first-invocation"
    assert second_detail.output == {"response": "second run"}
    assert second_detail.execution.invocation_id == "second-invocation"
    assert all(result.run_id == first.run_id for result in first_detail.scorer_results)
    assert all(result.run_id == second.run_id for result in second_detail.scorer_results)


@pytest.mark.asyncio
async def test_run_item_payloads_are_recursively_redacted_and_truncated(
    store: EvaluationStore,
):
    prior_limit = settings.max_persisted_sample_chars
    prior_redaction = settings.payload_redaction_enabled
    settings.max_persisted_sample_chars = 24
    settings.payload_redaction_enabled = True
    try:
        rows = [
            EvaluationRow(
                row_id="sensitive",
                query="email jane@example.com " + "q" * 60,
                response="Bearer secret-token-for-output",
                input_data={
                    "query": "email jane@example.com " + "q" * 60,
                    "authorization": "Bearer private-token",
                    "nested": {"message": "x" * 60},
                },
                expected_data={"email": "jane@example.com"},
                retrieval_snippets=["sk-abcdefghijklmnop"],
                tool_calls=[
                    ToolCall(
                        name="lookup",
                        args={"api_key": "top-secret", "query": "y" * 60},
                        output={"api_key": "tool-secret", "content": "z" * 60},
                    )
                ],
                invocation_error="contact jane@example.com about " + "e" * 60,
            )
        ]
        run = _execute(rows, "redaction-experiment")
        await store.save_run(run, rows)
    finally:
        settings.max_persisted_sample_chars = prior_limit
        settings.payload_redaction_enabled = prior_redaction

    summaries = await store.list_run_items(run.run_id)
    assert summaries[0].query is not None
    assert "jane@example.com" not in summaries[0].query
    assert summaries[0].query.endswith("[TRUNCATED]")

    detail = await store.get_run_item(run.run_id, "sensitive")
    assert detail is not None
    assert detail.input["authorization"] == "[REDACTED]"
    assert detail.input["nested"]["message"].endswith("[TRUNCATED]")
    assert "jane@example.com" not in str(detail.expected)
    assert "sk-abcdefghijklmnop" not in str(detail.retrieval_snippets)
    assert detail.tool_calls
    assert detail.tool_calls[0].args["api_key"] == "[REDACTED]"
    assert detail.tool_calls[0].args["query"].endswith("[TRUNCATED]")
    assert detail.tool_calls[0].output["api_key"] == "[REDACTED]"
    assert detail.tool_calls[0].output["content"].endswith("[TRUNCATED]")
    assert "jane@example.com" not in detail.execution.invocation_error
    governed_evidence = [
        detail.input,
        detail.output,
        detail.expected,
        detail.metadata,
        detail.retrieval_snippets,
        detail.expected_tools,
        [tool.model_dump() for tool in detail.tool_calls],
        detail.execution.usage,
        detail.execution.invocation_error,
    ]
    assert all(len(value) <= 24 for value in _strings(governed_evidence))
    assert detail.evidence_policy.redaction_enabled is True
    assert detail.evidence_policy.max_persisted_string_size == 24


@pytest.mark.asyncio
async def test_run_item_without_scorers_is_not_reported_as_pass(
    store: EvaluationStore,
):
    rows = [EvaluationRow(row_id="not-evaluated", query="q", response="a")]
    run = _execute(rows, "not-evaluated-experiment")
    run.metric_results = []
    await store.save_run(run, rows)

    summaries = await store.list_run_items(run.run_id)

    assert summaries[0].metric_count == 0
    assert summaries[0].worst_gate is None
    assert summaries[0].evaluation_state == "not_evaluated"


@pytest.mark.asyncio
async def test_legacy_metric_samples_return_unknown_item_without_inference(
    store: EvaluationStore,
):
    rows = [
        EvaluationRow(
            row_id="legacy-example",
            query="legacy query",
            response="legacy answer",
            expected_response="not stored in metric sample",
            context=["legacy context"],
        )
    ]
    run = _execute(rows, "legacy-experiment")
    await store.save_run(run, rows)
    await store.session.execute(
        delete(EvaluationRunItemORM).where(
            EvaluationRunItemORM.run_id == run.run_id
        )
    )
    await store.session.commit()

    summaries = await store.list_run_items(run.run_id)
    assert len(summaries) == 1
    assert summaries[0].query == "legacy query"
    assert summaries[0].capture_state == "unknown"

    detail = await store.get_run_item(run.run_id, "legacy-example")
    assert detail is not None
    assert detail.capture_state == "unknown"
    assert detail.input == {
        "query": "legacy query",
        "context": ["legacy context"],
    }
    assert detail.output == {"response": "legacy answer"}
    assert detail.expected is None
    assert detail.expected_tools is None
    assert detail.tool_calls is None
    assert detail.execution.invocation_id is None
    assert detail.execution.kagent_session_id is None
    assert detail.execution.usage is None
    assert detail.evidence_policy.redaction_enabled is None
    assert detail.evidence_policy.max_persisted_string_size is None


@pytest.mark.asyncio
async def test_summary_falls_back_to_normalised_query_for_structured_chat_input(
    store: EvaluationStore,
):
    rows = [
        EvaluationRow(
            row_id="chat-input",
            query="What is the approval status?",
            response="Pending review.",
            input_data={
                "input": [
                    {"role": "user", "content": "What is the approval status?"}
                ]
            },
        )
    ]
    run = _execute(rows, "chat-input-experiment")
    await store.save_run(run, rows)

    summaries = await store.list_run_items(run.run_id)
    assert summaries[0].query == "What is the approval status?"


@pytest.mark.asyncio
async def test_run_item_list_uses_compact_metric_projection(
    store: EvaluationStore,
    monkeypatch: pytest.MonkeyPatch,
):
    rows = [EvaluationRow(row_id="compact", query="q", response="a")]
    run = _execute(rows, "compact-summary-experiment")
    await store.save_run(run, rows)

    statements: list[str] = []
    assert store.session.bind is not None

    def capture_statement(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(
        store.session.bind.sync_engine,
        "before_cursor_execute",
        capture_statement,
    )

    async def reject_full_metric_hydration(*_args, **_kwargs):
        raise AssertionError("list_run_items must not hydrate full metric results")

    monkeypatch.setattr(
        store,
        "_metric_results_for_run",
        reject_full_metric_hydration,
    )
    try:
        summaries = await store.list_run_items(run.run_id)
    finally:
        event.remove(
            store.session.bind.sync_engine,
            "before_cursor_execute",
            capture_statement,
        )

    assert len(summaries) == 1
    assert summaries[0].example_id == "compact"
    assert summaries[0].query == "q"
    assert summaries[0].metric_count == len(run.metric_results)
    item_statement = next(
        statement
        for statement in statements
        if "FROM evaluation_run_items" in statement
    )
    assert "evaluation_run_items.input" not in item_statement
    assert "evaluation_run_items.output" not in item_statement
    assert "evaluation_run_items.tool_calls" not in item_statement


@pytest.mark.asyncio
async def test_run_item_snapshot_preserves_empty_structured_payloads(
    store: EvaluationStore,
):
    rows = [
        EvaluationRow(
            row_id="empty-structured",
            query="fallback query",
            response="fallback response",
            input_data={},
            output_data={},
        )
    ]
    run = _execute(rows, "empty-structured-experiment")
    await store.save_run(run, rows)

    detail = await store.get_run_item(run.run_id, "empty-structured")

    assert detail is not None
    assert detail.input == {}
    assert detail.output == {}


@pytest.mark.asyncio
async def test_complete_item_detail_queries_only_the_selected_examples_scores(
    store: EvaluationStore,
    monkeypatch: pytest.MonkeyPatch,
):
    rows = [
        EvaluationRow(row_id="first", query="q1", response="a1"),
        EvaluationRow(row_id="second", query="q2", response="a2"),
    ]
    run = _execute(rows, "selected-score-query-experiment")
    await store.save_run(run, rows)
    original = store._metric_results_for_run
    calls: list[tuple[str, str | None]] = []

    async def tracked(run_id: str, example_id: str | None = None):
        calls.append((run_id, example_id))
        return await original(run_id, example_id)

    monkeypatch.setattr(store, "_metric_results_for_run", tracked)
    detail = await store.get_run_item(run.run_id, "second")

    assert detail is not None
    assert calls == [(run.run_id, "second")]
    assert {result.row_id for result in detail.scorer_results} == {"second"}
