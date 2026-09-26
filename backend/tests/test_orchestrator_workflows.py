"""Tests for the Temporal activity heartbeat around a long-running run job.

``execute_dataset_run_job`` wraps a single ``await`` with no natural
checkpoints to heartbeat from inside. Without a background heartbeat, Temporal
has no way to relay a cancellation request into the running activity, so an
up-to-26h run keeps going even after ``cancel_dataset_run`` cancels the
workflow above it. These tests mock ``activity.heartbeat`` (calling it outside
a real Temporal activity execution context raises) and assert it fires
periodically for the life of the job, and stops once the job finishes.
"""

import asyncio
from unittest.mock import MagicMock

import pytest

from proofgrove.orchestrator import workflows as orchestrator_workflows
from proofgrove.orchestrator.workflows import _heartbeat_loop, execute_dataset_run_job


async def test_heartbeat_loop_calls_activity_heartbeat_periodically(monkeypatch):
    heartbeat = MagicMock()
    monkeypatch.setattr(orchestrator_workflows.activity, "heartbeat", heartbeat)

    task = asyncio.create_task(_heartbeat_loop(0.01))
    try:
        await asyncio.sleep(0.05)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert heartbeat.call_count >= 2


async def test_execute_dataset_run_job_heartbeats_while_the_job_runs(monkeypatch):
    heartbeat = MagicMock()
    monkeypatch.setattr(orchestrator_workflows.activity, "heartbeat", heartbeat)
    monkeypatch.setattr(orchestrator_workflows.settings, "temporal_activity_heartbeat_seconds", 0.01)

    async def _slow_job(run_id: str) -> None:
        await asyncio.sleep(0.05)

    monkeypatch.setattr(orchestrator_workflows, "_execute_dataset_run_job", _slow_job)

    await execute_dataset_run_job("run-1")

    assert heartbeat.call_count >= 2


async def test_execute_dataset_run_job_stops_heartbeating_once_the_job_finishes(monkeypatch):
    heartbeat = MagicMock()
    monkeypatch.setattr(orchestrator_workflows.activity, "heartbeat", heartbeat)
    monkeypatch.setattr(orchestrator_workflows.settings, "temporal_activity_heartbeat_seconds", 0.01)

    async def _fast_job(run_id: str) -> None:
        return None

    monkeypatch.setattr(orchestrator_workflows, "_execute_dataset_run_job", _fast_job)

    await execute_dataset_run_job("run-1")
    calls_at_return = heartbeat.call_count

    # No leftover heartbeat task still running in the background after the
    # activity returned -- confirmed by waiting past another interval and
    # observing no further calls.
    await asyncio.sleep(0.05)
    assert heartbeat.call_count == calls_at_return


async def test_execute_dataset_run_job_stops_heartbeat_task_even_if_the_job_raises(monkeypatch):
    heartbeat = MagicMock()
    monkeypatch.setattr(orchestrator_workflows.activity, "heartbeat", heartbeat)
    monkeypatch.setattr(orchestrator_workflows.settings, "temporal_activity_heartbeat_seconds", 0.01)

    async def _failing_job(run_id: str) -> None:
        await asyncio.sleep(0.02)
        raise ValueError("boom")

    monkeypatch.setattr(orchestrator_workflows, "_execute_dataset_run_job", _failing_job)

    with pytest.raises(ValueError, match="boom"):
        await execute_dataset_run_job("run-1")

    calls_at_raise = heartbeat.call_count
    await asyncio.sleep(0.05)
    assert heartbeat.call_count == calls_at_raise
    # Every background task spawned by this test should have finished.
    pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]
    assert pending == []


async def test_temporal_connection_failure_prevents_application_startup(monkeypatch):
    from unittest.mock import AsyncMock

    from temporalio.client import Client

    from proofgrove.main import app, lifespan

    monkeypatch.setattr(orchestrator_workflows.settings, "evaluation_runtime", "temporal")
    monkeypatch.setattr(orchestrator_workflows.settings, "trace_index_enabled", False)
    monkeypatch.setattr(Client, "connect", AsyncMock(side_effect=RuntimeError("Temporal unavailable")))
    entered = False
    with pytest.raises(RuntimeError, match="Temporal unavailable"):
        async with lifespan(app):
            entered = True
            await asyncio.sleep(0)
    assert not entered, "Application started with no Temporal worker"


# --- retry semantics -------------------------------------------------------


async def _pending_job(response_source: str = "provided") -> str:
    from proofgrove.db.session import async_session
    from proofgrove.db.store import EvaluationStore

    async with async_session() as session:
        return await EvaluationStore(session).create_run_job(
            dataset_name="retry", response_source=response_source, agent=None, row_count=1, judge_model=None, tenant_id="test",
        )


async def _job_state(run_id: str) -> tuple[str, str | None]:
    from proofgrove.db.session import async_session
    from proofgrove.db.store import EvaluationStore

    async with async_session() as session:
        job = await EvaluationStore(session).get_run_job(run_id)
        return job.status, job.error_message


async def test_a_failed_attempt_leaves_the_job_claimable_for_the_next_attempt(monkeypatch):
    """The first attempt used to mark the job FAILED, which made every later
    attempt unclaimable -- the retry policy retried nothing. The failure is
    raised as a retryable ApplicationError with a tenant-safe message and the
    job stays RUNNING; the next attempt claims it and executes."""
    from unittest.mock import AsyncMock, MagicMock

    from temporalio.exceptions import ApplicationError

    from proofgrove import runs_worker

    run_id = await _pending_job()
    execute = AsyncMock(side_effect=[RuntimeError("postgresql://eval:s3cret@db.internal/proofgrove"), None])
    monkeypatch.setattr(runs_worker, "execute_dataset_run", execute)
    monkeypatch.setattr(runs_worker, "get_registry_service", MagicMock())
    monkeypatch.setattr(runs_worker, "get_evaluation_engine", MagicMock())

    with pytest.raises(ApplicationError) as raised:
        await runs_worker.process_run_job(run_id)
    assert not raised.value.non_retryable
    assert "s3cret" not in raised.value.message and "db.internal" not in raised.value.message
    assert raised.value.message == "RuntimeError: the failure detail is withheld from stored evidence"
    assert await _job_state(run_id) == ("running", None)

    await runs_worker.process_run_job(run_id)
    assert execute.await_count == 2
    assert await _job_state(run_id) == ("completed", None)


async def test_the_workflow_marks_the_job_failed_only_after_the_last_attempt(monkeypatch):
    from unittest.mock import AsyncMock

    from temporalio.exceptions import ActivityError, ApplicationError

    from proofgrove.orchestrator.temporal import DatasetRunFailure, DatasetRunWorkflowInput
    from proofgrove.orchestrator.workflows import DatasetRunWorkflow, fail_dataset_run_job

    exhausted = ActivityError("activity failed", scheduled_event_id=1, started_event_id=2, identity="w", activity_type="proofgrove.execute-dataset-run-job", activity_id="1", retry_state=None)
    exhausted.__cause__ = ApplicationError("ValueError: dataset has no rows")
    execute_activity = AsyncMock(side_effect=[exhausted, None])
    monkeypatch.setattr(orchestrator_workflows.workflow, "execute_activity", execute_activity)

    with pytest.raises(ActivityError):
        await DatasetRunWorkflow().run(DatasetRunWorkflowInput(run_id="run-1"))

    assert execute_activity.await_count == 2
    terminal = execute_activity.await_args_list[1]
    assert terminal.args[0] is fail_dataset_run_job
    assert terminal.args[1] == DatasetRunFailure(run_id="run-1", message="ValueError: dataset has no rows")


async def test_fail_dataset_run_job_never_overwrites_a_completed_job():
    from proofgrove.db.session import async_session
    from proofgrove.db.store import EvaluationStore
    from proofgrove.orchestrator.temporal import DatasetRunFailure
    from proofgrove.orchestrator.workflows import fail_dataset_run_job

    run_id = await _pending_job()
    async with async_session() as session:
        await EvaluationStore(session).complete_run_job(run_id)
    await fail_dataset_run_job(DatasetRunFailure(run_id=run_id, message="late"))
    assert await _job_state(run_id) == ("completed", None)

    pending = await _pending_job()
    await fail_dataset_run_job(DatasetRunFailure(run_id=pending, message="exhausted"))
    assert await _job_state(pending) == ("failed", "exhausted")


# --- submission reconciliation ---------------------------------------------


@pytest.fixture
def temporal_runtime(monkeypatch):
    from proofgrove.orchestrator import temporal
    monkeypatch.setattr(temporal.settings, "evaluation_runtime", "temporal")
    monkeypatch.setattr(temporal.settings, "temporal_reconcile_after_seconds", 0)
    return temporal


async def test_submission_outcomes_keep_ambiguous_jobs_recoverable(monkeypatch, temporal_runtime):
    from unittest.mock import AsyncMock

    from temporalio.client import Client
    from temporalio.common import WorkflowIDReusePolicy
    from temporalio.exceptions import WorkflowAlreadyStartedError

    from proofgrove.db.session import async_session
    from proofgrove.db.store import WORKFLOW_SUBMITTED_AT_KEY, EvaluationStore

    job = await _pending_job()
    client = AsyncMock()
    monkeypatch.setattr(Client, "connect", AsyncMock(return_value=client))
    client.start_workflow.side_effect = RuntimeError("reply lost")
    with pytest.raises(RuntimeError, match="reply lost"):
        await temporal_runtime.submit_dataset_run(job)
    async with async_session() as session:
        row = await EvaluationStore(session).get_run_job(job)
        assert row.status == "pending"
        assert not (row.params or {}).get(WORKFLOW_SUBMITTED_AT_KEY)
    client.start_workflow.side_effect = WorkflowAlreadyStartedError(job, "proofgrove.dataset-run")
    with pytest.raises(WorkflowAlreadyStartedError):
        await temporal_runtime.submit_dataset_run(job)
    async with async_session() as session:
        row = await EvaluationStore(session).get_run_job(job)
        assert row.params[WORKFLOW_SUBMITTED_AT_KEY]
    assert client.start_workflow.call_args.kwargs["id_reuse_policy"] == WorkflowIDReusePolicy.REJECT_DUPLICATE


async def test_reconciliation_walks_pages_and_retries_new_and_failed_jobs(temporal_runtime):
    from unittest.mock import AsyncMock

    from temporalio.exceptions import WorkflowAlreadyStartedError

    from proofgrove.db.session import async_session
    from proofgrove.db.store import WORKFLOW_SUBMITTED_AT_KEY, EvaluationStore

    jobs = [await _pending_job() for _ in range(5)]
    client = AsyncMock()
    failed = temporal_runtime.workflow_id_for_run(jobs[0])
    duplicate = temporal_runtime.workflow_id_for_run(jobs[1])
    async def start(*args, **kwargs):
        if kwargs["id"] == failed:
            raise RuntimeError("temporarily offline")
        if kwargs["id"] == duplicate:
            raise WorkflowAlreadyStartedError(duplicate, "proofgrove.dataset-run")
    client.start_workflow.side_effect = start
    assert await temporal_runtime.reconcile_pending_run_jobs(client, page=2) == 3
    assert client.start_workflow.await_count == 5
    async with async_session() as session:
        for job in jobs:
            row = await EvaluationStore(session).get_run_job(job)
            assert bool((row.params or {}).get(WORKFLOW_SUBMITTED_AT_KEY)) == (job != jobs[0])
    late = await _pending_job()
    client.start_workflow.side_effect = None
    client.start_workflow.reset_mock()
    assert await temporal_runtime.reconcile_pending_run_jobs(client, page=2) == 2
    assert {c.kwargs["id"] for c in client.start_workflow.call_args_list} == {
        failed, temporal_runtime.workflow_id_for_run(late),
    }


async def test_reconciliation_respects_grace_and_does_not_overwrite_running_params(monkeypatch, temporal_runtime):
    from unittest.mock import AsyncMock

    from proofgrove.db.session import async_session
    from proofgrove.db.store import EvaluationStore
    job = await _pending_job()
    monkeypatch.setattr(temporal_runtime.settings, "temporal_reconcile_after_seconds", 60)
    client = AsyncMock()
    assert await temporal_runtime.reconcile_pending_run_jobs(client) == 0
    client.start_workflow.assert_not_called()
    async with async_session() as session:
        store = EvaluationStore(session)
        row = await store.claim_run_job(job)
        row.params = {"telemetry_score_snapshot": {"synthetic": True}}
        await session.commit()
        await store.mark_run_job_submitted(job)
        await session.refresh(row)
        assert row.params == {"telemetry_score_snapshot": {"synthetic": True}}


async def test_reconciliation_loop_survives_failed_pass(monkeypatch, temporal_runtime):
    from unittest.mock import AsyncMock
    stop = asyncio.Event()
    attempts = 0
    async def reconcile(*args):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("temporary store outage")
        stop.set()
        return 0
    monkeypatch.setattr(temporal_runtime, "reconcile_pending_run_jobs", reconcile)
    monkeypatch.setattr(temporal_runtime.settings, "temporal_reconcile_interval_seconds", 0.01)
    await asyncio.wait_for(temporal_runtime.reconcile_pending_run_jobs_loop(AsyncMock(), stop), 1)
    assert attempts == 2


async def test_activity_failure_serialization_excludes_entire_private_cause(monkeypatch):
    from unittest.mock import AsyncMock

    from temporalio.api.failure.v1 import Failure
    from temporalio.converter import DefaultFailureConverter, DefaultPayloadConverter
    from temporalio.exceptions import ApplicationError

    from proofgrove import runs_worker
    sentinel = "SYNTHETIC_PRIVATE_PAYLOAD_42"
    monkeypatch.setattr(runs_worker, "process_run_job", AsyncMock(side_effect=RuntimeError(sentinel)))
    with pytest.raises(ApplicationError) as error:
        await orchestrator_workflows._execute_dataset_run_job("job")
    failure = Failure()
    DefaultFailureConverter().to_failure(error.value, DefaultPayloadConverter(), failure)
    assert sentinel not in str(failure)
    assert not failure.HasField("cause")
