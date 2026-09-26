"""Deferred scoring after the archived trajectory is finalized."""

import functools
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from proofgrove.db.session import async_session
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.enums import (
    EvaluationScope,
    EvidenceReadiness,
    ProvenanceStatus,
    RunStatus,
    Scenario,
    TriggerReason,
)
from proofgrove.evaluation.judge import MockJudge
from proofgrove.evaluation.models import (
    ArchivedTraceSpan,
    EvaluationRow,
    EvidenceReadinessResult,
    ExperimentDefinition,
    RunItemTraceEvidence,
)
from proofgrove.evaluation.run_service import (
    DATASET_RUN_DEFERRED,
    _score_and_persist_run,
    execute_deferred_telemetry_score,
)
from proofgrove.evaluation.trace_hydrator import (
    TELEMETRY_EVIDENCE_SOURCE,
    TELEMETRY_PENDING_SOURCE,
    apply_a2a_capture_scoring,
    apply_telemetry_to_row,
)
from proofgrove.runs_worker import process_one_completed_telemetry_watch, process_one_deferred_telemetry_job, process_one_job


def _snapshot(
    *,
    deferred_since: datetime | None = None,
    pending: bool = True,
    evaluation_scope: EvaluationScope = EvaluationScope.TOOL_INTERACTIONS,
) -> dict:
    row = EvaluationRow(
        row_id="r1",
        query="What is AAPL revenue?",
        response="session answer",
        expected_response="383B",
        from_agent=True,
        trace_id="0123456789abcdef0123456789abcdef",
        output_data={
            "response": "session answer",
            "response_source": TELEMETRY_PENDING_SOURCE if pending else TELEMETRY_EVIDENCE_SOURCE,
        },
    )
    experiment = ExperimentDefinition(
        experiment_id="exp-deferred",
        name="Deferred telemetry",
        dataset_version="ds.v1",
        target_endpoint="tenant/agent",
        scenario=Scenario.AGENTIC,
        evaluation_scope=evaluation_scope,
        tenant_id="tenant-evalai",
        row_count=1,
        has_ground_truth=True,
        judge_model="mock",
    )
    readiness = EvidenceReadinessResult(
        status=EvidenceReadiness.READY,
        evaluation_scope=evaluation_scope,
        requested_evaluation_scope=evaluation_scope,
        resolved_evaluation_scope=evaluation_scope,
        effective_evidence_requirements=(["input", "final_output"] if evaluation_scope == EvaluationScope.FINAL_RESPONSE else ["input", "final_output", "tool_calls", "tool_results"]),
    )
    return {
        "rows": [row.model_dump(mode="json")],
        "experiment": experiment.model_dump(mode="json"),
        "resolved_metrics": ["llm.correctness"],
        "scoring_configuration": None,
        "pre_run_not_applicable": {},
        "readiness": readiness.model_dump(mode="json"),
        "enable_llm_judge": False,
        "run_human_review": False,
        "trigger_reason": "manual",
        "correlation_id": "corr",
        "label": None,
        "selected_tool_ids": None,
        "archive_tenant_id": "evalai",
        "deferred_since": (deferred_since or datetime.now(UTC)).isoformat(),
    }


async def test_completed_watch_archive_failure_records_retry_after_rollback(monkeypatch):
    snapshot = {**_snapshot(pending=False), "watch_completed_run": True}
    run_id = await _park_job(snapshot)
    async with async_session() as session:
        store = EvaluationStore(session)
        await store.complete_run_job(run_id)

    async def unavailable(**kwargs):
        raise OSError("Archive temporarily unavailable")

    monkeypatch.setattr("proofgrove.runs_worker.execute_deferred_telemetry_score", unavailable)
    monkeypatch.setattr("proofgrove.runs_worker.settings.trace_archive_deferred_poll_seconds", 0)
    assert await process_one_completed_telemetry_watch() is True

    async with async_session() as session:
        store = EvaluationStore(session)
        job = await store.get_run_job(run_id)
        assert job.status == "completed"
        assert job.params["telemetry_score_snapshot"] == snapshot
        assert job.params["telemetry_watch_last_checked_at"]
        assert await store.list_completed_telemetry_watch_jobs(min_check_interval_seconds=15) == []


async def _park_job(snapshot: dict) -> str:
    async with async_session() as session:
        store = EvaluationStore(session)
        run_id = await store.create_run_job(
            dataset_name="ds",
            response_source="agent",
            agent="tenant/agent",
            row_count=1,
            judge_model="mock",
            tenant_id="tenant-evalai",
        )
        await store.park_run_job_waiting_for_telemetry(run_id, snapshot)
        return run_id


@pytest.mark.asyncio
async def test_execute_deferred_repark_when_trajectory_still_incomplete(monkeypatch):
    run_id = await _park_job(_snapshot())

    async def _still_pending(row, **kwargs):  # noqa: ARG001
        output = dict(row.output_data or {})
        output["response_source"] = TELEMETRY_PENDING_SOURCE
        row.output_data = output

    monkeypatch.setattr(
        "proofgrove.evaluation.run_service.hydrate_row_from_archive",
        _still_pending,
    )
    monkeypatch.setattr(
        "proofgrove.evaluation.run_service.settings.trace_archive_score_grace_seconds",
        3600.0,
    )

    async with async_session() as session:
        store = EvaluationStore(session)
        outcome = await execute_deferred_telemetry_score(
            run_id=run_id,
            store=store,
            engine=EvaluationEngine(judge=MockJudge()),
        )
        job = await store.get_run_job(run_id)
        assert await store.get_run(run_id) is None

    assert outcome == DATASET_RUN_DEFERRED
    assert job.status == RunStatus.AWAITING_TRACE.value


@pytest.mark.asyncio
async def test_execute_deferred_scores_completed_trajectory(monkeypatch):
    run_id = await _park_job(_snapshot())

    async def _complete(row, **kwargs):  # noqa: ARG001
        row.response = "archive answer"
        output = dict(row.output_data or {})
        output["response"] = "archive answer"
        output["response_source"] = TELEMETRY_EVIDENCE_SOURCE
        output.pop("archive_pending_reason", None)
        row.output_data = output
        row.tool_evidence_source = TELEMETRY_EVIDENCE_SOURCE

    monkeypatch.setattr(
        "proofgrove.evaluation.run_service.hydrate_row_from_archive",
        _complete,
    )

    async with async_session() as session:
        store = EvaluationStore(session)
        outcome = await execute_deferred_telemetry_score(
            run_id=run_id,
            store=store,
            engine=EvaluationEngine(judge=MockJudge()),
        )
        run = await store.get_run(run_id)

    assert outcome is None
    assert run is not None
    assert run.status == RunStatus.COMPLETED


@pytest.mark.asyncio
async def test_deferred_snapshot_without_a_source_reads_it_from_provenance(monkeypatch):
    """A job parked before the snapshot carried a response source must not be
    scored as though a target was invoked.

    Defaulting to "agent" gave such a run ATTESTED final-output provenance —
    "evaluation target invocation" — for stored responses no target produced.
    The resolved provenance records the same value and survives the upgrade.
    """

    snapshot = _snapshot(evaluation_scope=EvaluationScope.FINAL_RESPONSE)
    assert "response_source" not in snapshot  # the pre-upgrade shape
    snapshot["experiment"]["resolved_target_provenance"] = {"target_type": "provided"}
    run_id = await _park_job(snapshot)

    async def _complete(row, **kwargs):  # noqa: ARG001
        output = dict(row.output_data or {})
        output["response_source"] = TELEMETRY_EVIDENCE_SOURCE
        row.output_data = output

    monkeypatch.setattr(
        "proofgrove.evaluation.run_service.hydrate_row_from_archive",
        _complete,
    )

    async with async_session() as session:
        store = EvaluationStore(session)
        await execute_deferred_telemetry_score(
            run_id=run_id,
            store=store,
            engine=EvaluationEngine(judge=MockJudge()),
        )
        run = await store.get_run(run_id)

    assert run is not None
    final_output = next(item for item in run.evidence_categories if item.category == "final_output")
    assert final_output.provenance_status == ProvenanceStatus.SELF_REPORTED
    assert final_output.provenance_source == "dataset declaration"


@pytest.mark.asyncio
async def test_process_one_job_does_not_complete_deferred_eval(monkeypatch):
    async with async_session() as session:
        run_id = await EvaluationStore(session).create_run_job(
            dataset_name="ds",
            response_source="baseline",
            agent=None,
            row_count=None,
            judge_model=None,
        )

    async def _defer(**kwargs):  # noqa: ARG001
        async with async_session() as session:
            await EvaluationStore(session).park_run_job_waiting_for_telemetry(
                kwargs["run_id"],
                _snapshot(),
            )
        return DATASET_RUN_DEFERRED

    monkeypatch.setattr("proofgrove.runs_worker.execute_dataset_run", _defer)

    assert await process_one_job() is True
    async with async_session() as session:
        job = await EvaluationStore(session).get_run_job(run_id)
    assert job.status == RunStatus.AWAITING_TRACE.value


@pytest.mark.asyncio
async def test_process_one_deferred_job_completes_when_ready(monkeypatch):
    run_id = await _park_job(_snapshot())

    async def _complete(row, **kwargs):  # noqa: ARG001
        output = dict(row.output_data or {})
        output["response_source"] = TELEMETRY_EVIDENCE_SOURCE
        row.output_data = output

    monkeypatch.setattr(
        "proofgrove.evaluation.run_service.hydrate_row_from_archive",
        _complete,
    )

    assert await process_one_deferred_telemetry_job() is True
    async with async_session() as session:
        store = EvaluationStore(session)
        assert (await store.get_run_job(run_id)).status == RunStatus.COMPLETED.value
        assert await store.get_run(run_id) is not None


@pytest.mark.asyncio
async def test_reclaim_running_deferred_job_does_not_reinvoke():
    async with async_session() as session:
        store = EvaluationStore(session)
        run_id = await store.create_run_job(
            dataset_name="ds",
            response_source="agent",
            agent="tenant/agent",
            row_count=1,
            judge_model=None,
        )
        await store.park_run_job_waiting_for_telemetry(run_id, _snapshot())
        job = await store.get_run_job(run_id)
        job.status = RunStatus.RUNNING.value
        await session.commit()
        # Force immediate staleness — see the sibling comment in
        # test_async_runs.test_reclaim_running_jobs.
        assert await store.reclaim_running_jobs(stale_after_seconds=0) >= 1
        assert (await store.get_run_job(run_id)).status == RunStatus.AWAITING_TRACE.value


@pytest.mark.asyncio
async def test_grace_expiry_falls_back_instead_of_waiting(monkeypatch):
    expired = datetime.now(UTC) - timedelta(hours=2)
    run_id = await _park_job(_snapshot(deferred_since=expired))

    async def _keep_pending(row, *, incomplete_mode, **kwargs):  # noqa: ARG001
        if incomplete_mode == "fallback":
            output = dict(row.output_data or {})
            output["response_source"] = "a2a-capture-fallback"
            row.output_data = output
            return
        output = dict(row.output_data or {})
        output["response_source"] = TELEMETRY_PENDING_SOURCE
        row.output_data = output

    monkeypatch.setattr(
        "proofgrove.evaluation.run_service.hydrate_row_from_archive",
        _keep_pending,
    )
    monkeypatch.setattr(
        "proofgrove.evaluation.run_service.settings.trace_archive_score_grace_seconds",
        3600.0,
    )
    monkeypatch.setattr(
        "proofgrove.evaluation.run_service.settings.trace_archive_score_fallback_to_capture",
        True,
    )

    async with async_session() as session:
        store = EvaluationStore(session)
        outcome = await execute_deferred_telemetry_score(
            run_id=run_id,
            store=store,
            engine=EvaluationEngine(judge=MockJudge()),
        )
        assert outcome is None
        assert await store.get_run(run_id) is not None


@pytest.mark.asyncio
async def test_deferred_final_response_scores_a2a_without_archive_wait():
    run_id = await _park_job(_snapshot(evaluation_scope=EvaluationScope.FINAL_RESPONSE))

    async with async_session() as session:
        store = EvaluationStore(session)
        outcome = await execute_deferred_telemetry_score(
            run_id=run_id,
            store=store,
            engine=EvaluationEngine(judge=MockJudge()),
        )
        run = await store.get_run(run_id)
        rows = await store.load_run_evidence_rows(run_id)

    assert outcome is None
    assert run is not None
    assert rows[0].output_data["response_source"] == "a2a-capture-fallback"
    assert rows[0].response == "session answer"


@pytest.mark.asyncio
@pytest.mark.parametrize("diagnostic", ["root_span_missing", "completion_marker_missing", "archive_not_settled", "incomplete_trajectory"])
async def test_partial_result_is_terminal_while_enrichment_job_remains_parked(diagnostic):
    snapshot = _snapshot()
    snapshot["resolved_metrics"] = ["llm.correctness", "agent.tool_selection"]
    snapshot["rows"][0]["expected_tools"] = ["policy_search"]
    run_id = await _park_job(snapshot)
    row = EvaluationRow.model_validate(snapshot["rows"][0])
    apply_a2a_capture_scoring(row, reason=diagnostic)

    async with async_session() as session:
        store = EvaluationStore(session)
        await _score_and_persist_run(
            run_id=run_id,
            rows=[row],
            experiment=ExperimentDefinition.model_validate(snapshot["experiment"]),
            response_source="agent",
            resolved_metrics=snapshot["resolved_metrics"],
            scoring_configuration=None,
            pre_run_not_applicable={},
            readiness=EvidenceReadinessResult.model_validate(snapshot["readiness"]),
            enable_llm_judge=False,
            run_human_review=False,
            trigger_reason=TriggerReason.MANUAL,
            correlation_id=run_id,
            label=None,
            store=store,
            engine=EvaluationEngine(judge=MockJudge()),
            run_status=RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE,
            finalize_job=False,
        )
        run = await store.get_run(run_id)
        job = await store.get_run_job(run_id)

    assert run is not None
    assert run.status == RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE
    assert job.status == RunStatus.AWAITING_TRACE.value
    by_metric = {item.metric_id: item for item in run.metric_results}
    assert by_metric["llm.correctness"].metric_status.value == "unscored"
    assert by_metric["llm.correctness"].unscored_reason.value == "simulated"
    assert by_metric["agent.tool_selection"].unscored_reason.value == "incomplete_trace"
    assert by_metric["agent.tool_selection"].execution_metadata["evidence_diagnostic"] == diagnostic
    assert any(category.diagnostic == diagnostic for category in run.evidence_categories)


@pytest.mark.asyncio
async def test_enrichment_expiry_disables_watch_even_when_never_activated(monkeypatch):
    """Regression for the bot-confirmed unreachable ``if completed_watch:``.

    ``completed_watch`` is provably always False by the time
    ``execute_deferred_telemetry_score`` reaches the
    ``awaiting_trace and published is not None`` branch (the branch above it
    already returns for the True case), so a `if completed_watch:` guard
    around ``disable_run_job_telemetry_watch`` there was dead code -- it never
    ran on the very first attempt, before any watch had been activated, which
    is exactly the case this test exercises: enrichment window already
    expired, no prior watch. The fix makes the call unconditional; this test
    asserts the watch-stopped audit trail (``watch_stopped_at``) actually gets
    recorded.
    """
    old = datetime.now(UTC) - timedelta(days=2)
    snapshot = _snapshot(deferred_since=old)
    run_id = await _park_job(snapshot)
    row = EvaluationRow.model_validate(snapshot["rows"][0])
    apply_a2a_capture_scoring(row, reason="completion_marker_missing")

    async with async_session() as session:
        store = EvaluationStore(session)
        await _score_and_persist_run(
            run_id=run_id,
            rows=[row],
            experiment=ExperimentDefinition.model_validate(snapshot["experiment"]),
            response_source="agent",
            resolved_metrics=snapshot["resolved_metrics"],
            scoring_configuration=None,
            pre_run_not_applicable={},
            readiness=EvidenceReadinessResult.model_validate(snapshot["readiness"]),
            enable_llm_judge=False,
            run_human_review=False,
            trigger_reason=TriggerReason.MANUAL,
            correlation_id=run_id,
            label=None,
            store=store,
            engine=EvaluationEngine(judge=MockJudge()),
            run_status=RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE,
            finalize_job=False,
        )
        published = await store.get_run(run_id)
        job_before = await store.get_run_job(run_id)

    assert published is not None
    assert published.status == RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE
    watch_before = job_before.params.get("telemetry_score_snapshot", {})
    assert not watch_before.get("watch_completed_run")
    assert watch_before.get("watch_stopped_at") is None

    async def _still_pending(row, **kwargs):  # noqa: ARG001
        output = dict(row.output_data or {})
        output["response_source"] = TELEMETRY_PENDING_SOURCE
        row.output_data = output

    monkeypatch.setattr("proofgrove.evaluation.run_service.hydrate_row_from_archive", _still_pending)

    async with async_session() as session:
        store = EvaluationStore(session)
        outcome = await execute_deferred_telemetry_score(
            run_id=run_id,
            store=store,
            engine=EvaluationEngine(judge=MockJudge()),
        )
        job_after = await store.get_run_job(run_id)

    assert outcome is None
    watch_after = job_after.params["telemetry_score_snapshot"]
    assert watch_after["watch_completed_run"] is False
    assert watch_after.get("watch_stopped_at") is not None


@pytest.mark.asyncio
async def test_late_complete_trace_enriches_original_run_id(monkeypatch):
    snapshot = _snapshot()
    run_id = await _park_job(snapshot)
    partial_row = EvaluationRow.model_validate(snapshot["rows"][0])
    apply_a2a_capture_scoring(partial_row, reason="completion_marker_missing")

    async with async_session() as session:
        store = EvaluationStore(session)
        await _score_and_persist_run(
            run_id=run_id,
            rows=[partial_row],
            experiment=ExperimentDefinition.model_validate(snapshot["experiment"]),
            response_source="agent",
            resolved_metrics=snapshot["resolved_metrics"],
            scoring_configuration=None,
            pre_run_not_applicable={},
            readiness=EvidenceReadinessResult.model_validate(snapshot["readiness"]),
            enable_llm_judge=False,
            run_human_review=False,
            trigger_reason=TriggerReason.MANUAL,
            correlation_id=run_id,
            label=None,
            store=store,
            engine=EvaluationEngine(judge=MockJudge()),
            run_status=RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE,
            finalize_job=False,
        )
        partial = await store.get_run(run_id)
        assert partial is not None
        partial_run_number = partial.run_number

    # Exercise the real archive wait with I/O overhead and fresh retrieval
    # timestamps on each read. Stable execution content must still settle.
    from proofgrove.evaluation import trace_hydrator
    from proofgrove.settings import settings

    clock = SimpleNamespace(now=0.0, reads=0)
    monkeypatch.setattr(trace_hydrator, "time", SimpleNamespace(monotonic=lambda: clock.now))

    class _Reader:
        async def find(self, **kwargs):
            clock.now += 1.25
            clock.reads += 1
            return RunItemTraceEvidence(
                state="available", trace_id=kwargs["trace_id"],
                pagination_complete=True, lifecycle_complete=True, evidence_complete=True,
                spans=[ArchivedTraceSpan(
                    trace_id=kwargs["trace_id"], span_id="0123456789abcdef", name="invoke_agent",
                    retrieved_at=datetime(2026, 9, 8, tzinfo=UTC) + timedelta(seconds=clock.now),
                    attributes={"openinference.span.kind": "AGENT", "output.value": "archive answer"},
                )],
            )

    async def _sleep(seconds):
        clock.now += seconds

    monkeypatch.setattr(trace_hydrator, "TraceArchiveReader", lambda _settings: _Reader())
    monkeypatch.setattr(trace_hydrator, "wait_for_archived_trace", functools.partial(trace_hydrator.wait_for_archived_trace, sleep=_sleep))
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    monkeypatch.setattr(settings, "trace_archive_score_timeout_seconds", 60)
    monkeypatch.setattr(settings, "trace_archive_score_poll_seconds", 2)
    monkeypatch.setattr(settings, "trace_archive_completion_settle_seconds", 2)
    monkeypatch.setattr(settings, "trace_archive_completion_min_identical_observations", 3)

    async with async_session() as session:
        store = EvaluationStore(session)
        assert (
            await execute_deferred_telemetry_score(
                run_id=run_id,
                store=store,
                engine=EvaluationEngine(judge=MockJudge()),
            )
            is None
        )
        job = await store.get_run_job(run_id)
        enrichment_id = job.params["telemetry_enrichment_run_id"]
        enrichment = await store.get_run(enrichment_id)
        runs = await store.list_runs()

    assert enrichment is not None
    assert enrichment_id == run_id
    assert enrichment.run_id == run_id
    assert enrichment.run_number == partial_run_number
    assert [run.run_id for run in runs] == [run_id]
    assert enrichment.status == RunStatus.COMPLETED
    assert enrichment.lineage.rescore_configuration["reason"] == "late_telemetry_completion"
    assert enrichment.lineage.rescore_configuration["identity_preserved"] is True
    assert clock.reads == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("kagent_mapping", [False, True])
async def test_settled_late_span_change_rescores_an_already_completed_run(monkeypatch, kagent_mapping):
    snapshot = _snapshot(pending=False)
    snapshot["watch_completed_run"] = True
    snapshot["rows"][0]["output_data"]["trace_evidence_fingerprint"] = "before"

    async with async_session() as session:
        store = EvaluationStore(session)
        run_id = await store.create_run_job(
            dataset_name="ds",
            response_source="agent",
            agent="tenant/agent",
            row_count=1,
            judge_model="mock",
            tenant_id="tenant-evalai",
        )
        await store.update_run_job_telemetry_watch(run_id, snapshot)
        await _score_and_persist_run(
            run_id=run_id,
            rows=[EvaluationRow.model_validate(snapshot["rows"][0])],
            experiment=ExperimentDefinition.model_validate(snapshot["experiment"]),
            response_source="agent",
            resolved_metrics=snapshot["resolved_metrics"],
            scoring_configuration=None,
            pre_run_not_applicable={},
            readiness=EvidenceReadinessResult.model_validate(snapshot["readiness"]),
            enable_llm_judge=False,
            run_human_review=False,
            trigger_reason=TriggerReason.MANUAL,
            correlation_id=run_id,
            label=None,
            store=store,
            engine=EvaluationEngine(judge=MockJudge()),
        )
        first = await store.get_run(run_id)
        first_run_number = first.run_number
        due = await store.list_completed_telemetry_watch_jobs(
            limit=1,
            min_check_interval_seconds=0,
        )
        assert [job.run_id for job in due] == [run_id]

    async def _late_change(row, **kwargs):  # noqa: ARG001
        if kagent_mapping:
            apply_telemetry_to_row(row, RunItemTraceEvidence(
                state="available", trace_id=row.trace_id,
                pagination_complete=True, lifecycle_complete=True, evidence_complete=True,
                spans=[ArchivedTraceSpan(
                    trace_id=row.trace_id, span_id="0123456789abcdef", name="execute_tool multiply",
                    attributes={
                        "gen_ai.tool.name": "multiply",
                        "gcp.vertex.agent.tool_call_args": '{"a": 12, "b": 7}',
                        "gcp.vertex.agent.tool_response": "84.0",
                    },
                )],
            ))
            return
        output = dict(row.output_data or {})
        output["response"] = "answer with late tool evidence"
        output["response_source"] = TELEMETRY_EVIDENCE_SOURCE
        output["trace_evidence_fingerprint"] = "after"
        row.output_data = output
        row.response = output["response"]

    monkeypatch.setattr(
        "proofgrove.evaluation.run_service.hydrate_row_from_archive",
        _late_change,
    )

    async with async_session() as session:
        store = EvaluationStore(session)
        assert (
            await execute_deferred_telemetry_score(
                run_id=run_id,
                store=store,
                engine=EvaluationEngine(judge=MockJudge()),
            )
            is None
        )
        refreshed = await store.get_run(run_id)
        job = await store.get_run_job(run_id)
        assert [run.run_id for run in await store.list_runs()] == [run_id]

    assert refreshed.run_id == run_id
    assert refreshed.run_number == first_run_number
    assert refreshed.status == RunStatus.COMPLETED
    assert refreshed.lineage.rescore_configuration["reason"] == "late_telemetry_change"
    assert job.status == RunStatus.COMPLETED.value
    assert job.params["telemetry_score_snapshot"]["score_stale"] is False
    assert job.params["telemetry_score_snapshot"]["last_fingerprint_change_at"]
    assert job.params["telemetry_score_snapshot"]["last_rescored_at"]
    saved_row = job.params["telemetry_score_snapshot"]["rows"][0]
    if kagent_mapping:
        assert saved_row["tool_calls"][0]["args"] == {"a": 12, "b": 7}
        assert saved_row["tool_calls"][0]["output"] == "84.0"
        assert saved_row["tool_calls"][0]["result_captured"] is True
        categories = {item.category: item for item in refreshed.evidence_categories}
        assert categories["tool_results"].record_count == 1
        assert categories["tool_results"].completeness_attested is True
    else:
        assert saved_row["output_data"]["trace_evidence_fingerprint"] == "after"

    async def _unexpected_rescore(**kwargs):
        pytest.fail("Unchanged interpreted evidence must not trigger another rescore")

    monkeypatch.setattr("proofgrove.evaluation.run_service._score_and_persist_run", _unexpected_rescore)
    async with async_session() as session:
        await execute_deferred_telemetry_score(
            run_id=run_id, store=EvaluationStore(session), engine=EvaluationEngine(judge=MockJudge()),
        )
