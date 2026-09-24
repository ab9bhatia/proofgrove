"""Exclusive compatibility ownership recovers recently interrupted jobs."""

import asyncio

from evalhub import runs_worker
from evalhub.db.session import async_session
from evalhub.db.store import EvaluationStore


async def test_owned_worker_fails_fresh_interrupted_job_without_reinvocation(monkeypatch):
    async with async_session() as session:
        store = EvaluationStore(session)
        run_id = await store.create_run_job(
            dataset_name="interrupted", response_source="agent", agent="synthetic",
            row_count=1, judge_model=None, tenant_id="test",
        )
        await store.claim_run_job(run_id)

    stop = asyncio.Event()

    async def stop_after_recovery(**kwargs):
        stop.set()
        return False

    monkeypatch.setattr(runs_worker, "process_one_job", stop_after_recovery)
    await runs_worker._run_owned_worker(stop, 0.01)
    async with async_session() as session:
        job = await EvaluationStore(session).get_run_job(run_id)
        assert job.status == "failed"
        assert job.error_message == "Worker interrupted before completion. Start a new run to retry."


def test_poll_fails_job_that_becomes_stale_after_startup(monkeypatch):
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import update

    from evalhub.datasets import generation_service
    from evalhub.datasets.generation_jobs import DatasetGenerationJobORM, GenerationJobStore

    store = GenerationJobStore()
    monkeypatch.setattr(generation_service, "get_generation_job_store", lambda: store)
    job_id = store.create_job(tenant_id="test", dataset_name="interrupted")["job_id"]
    assert generation_service.get_generation_job(job_id, "test")["phase"] == "queued"
    with store._sessionmaker() as session:
        session.execute(update(DatasetGenerationJobORM).where(DatasetGenerationJobORM.job_id == job_id).values(updated_at=datetime.now(UTC) - timedelta(seconds=901)))
        session.commit()
    observed = generation_service.get_generation_job(job_id, "test")
    assert observed["phase"] == "failed"
    assert observed["error"] == "interrupted"


async def test_generation_has_one_heartbeat_while_waiting_for_capacity(monkeypatch):
    from contextlib import suppress
    from unittest.mock import MagicMock

    from evalhub.datasets import generation_service

    touched = asyncio.Event()
    store = MagicMock()
    monkeypatch.setattr(generation_service, "get_generation_job_store", lambda: store)
    monkeypatch.setattr(generation_service, "_GENERATION_SEMAPHORE", asyncio.Semaphore(0))
    started = 0

    async def heartbeat(*args):
        nonlocal started
        started += 1
        touched.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(generation_service, "_heartbeat_generation_progress", heartbeat)
    task = asyncio.create_task(generation_service._execute("queued", MagicMock()))
    try:
        await asyncio.wait_for(touched.wait(), 0.5)
        assert started == 1
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


def test_generation_heartbeat_preserves_active_and_terminal_phases():
    from evalhub.datasets.generation_jobs import GenerationJobPhase, GenerationJobStore

    store = GenerationJobStore()
    job_id = store.create_job(tenant_id="test", dataset_name="heartbeat")["job_id"]
    store.touch(job_id)
    assert store.get_job(job_id)["phase"] == "queued"
    store.advance(job_id, from_phases={GenerationJobPhase.QUEUED}, to_phase=GenerationJobPhase.VALIDATING)
    store.touch(job_id)
    assert store.get_job(job_id)["phase"] == "validating"
    assert store.request_cancel(job_id, "test")["phase"] == "validating"
    store.advance(job_id, from_phases={GenerationJobPhase.VALIDATING}, to_phase=GenerationJobPhase.COMPLETED)
    terminal = store.get_job(job_id)
    store.touch(job_id)
    assert store.get_job(job_id) == terminal


async def test_generation_heartbeat_retries_transient_store_failure():
    from contextlib import suppress
    from unittest.mock import MagicMock

    from evalhub.datasets.generation_service import _heartbeat_generation_progress

    store = MagicMock()
    store.touch.side_effect = [RuntimeError("temporary database failure"), None]
    task = asyncio.create_task(_heartbeat_generation_progress(store, "job", 0.001))
    try:
        async with asyncio.timeout(0.5):
            while store.touch.call_count < 2:
                await asyncio.sleep(0.001)
        assert not task.done()
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


async def test_temporal_interruption_does_not_reinvoke_live_target(monkeypatch):
    from unittest.mock import AsyncMock, MagicMock

    import pytest
    from temporalio.exceptions import ApplicationError

    async with async_session() as session:
        store = EvaluationStore(session)
        run_id = await store.create_run_job(dataset_name="interrupted", response_source="agent", agent="synthetic", row_count=1, judge_model=None, tenant_id="test")
        await store.claim_run_job(run_id)
    invoke = AsyncMock()
    monkeypatch.setattr(runs_worker, "execute_dataset_run", invoke)
    monkeypatch.setattr(runs_worker, "get_registry_service", MagicMock())
    with pytest.raises(ApplicationError) as error:
        await runs_worker.process_run_job(run_id)
    assert error.value.non_retryable
    invoke.assert_not_awaited()
    async with async_session() as session:
        job = await EvaluationStore(session).get_run_job(run_id)
        assert job.status == "failed"


async def test_temporal_interruption_resumes_persisted_telemetry_without_invoking(monkeypatch):
    from unittest.mock import AsyncMock, MagicMock

    async with async_session() as session:
        store = EvaluationStore(session)
        run_id = await store.create_run_job(dataset_name="interrupted", response_source="agent", agent="synthetic", row_count=1, judge_model=None, tenant_id="test")
        job = await store.claim_run_job(run_id)
        job.params = {runs_worker.TELEMETRY_SCORE_SNAPSHOT_KEY: {"saved": True}}
        await session.commit()
    invoke = AsyncMock()
    resume = AsyncMock()
    monkeypatch.setattr(runs_worker, "execute_dataset_run", invoke)
    monkeypatch.setattr(runs_worker, "_await_deferred_telemetry_score", resume)
    monkeypatch.setattr(runs_worker, "get_registry_service", MagicMock())
    await runs_worker.process_run_job(run_id)
    invoke.assert_not_awaited()
    resume.assert_awaited_once_with(run_id)


async def test_late_partial_publish_cannot_revive_failed_job():
    import pytest

    from evalhub.db.store import RunCancelledError
    from evalhub.evaluation.enums import RunStatus, Scenario
    from evalhub.evaluation.models import EvaluationRow, ExperimentDefinition, RunResult

    async with async_session() as session:
        store = EvaluationStore(session)
        run_id = await store.create_run_job(dataset_name="late", response_source="agent", agent="synthetic", row_count=1, judge_model=None, tenant_id="test")
        await store.claim_run_job(run_id)
        await store.fail_run_job(run_id, "interrupted")
        run = RunResult(run_id=run_id, status=RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE,
            experiment=ExperimentDefinition(
                experiment_id=run_id, name="late", dataset_version="late.v1", target_endpoint="synthetic", scenario=Scenario.AGENTIC, tenant_id="test",
            ),
        )
        with pytest.raises(RunCancelledError):
            await store.save_run(run, [EvaluationRow(row_id="row", query="q", response="a")], finalize_job=False)
        assert await store.get_run(run_id) is None
        assert (await store.get_run_job(run_id)).status == "failed"


async def test_completed_telemetry_refresh_keeps_completed_job():
    from evalhub.evaluation.enums import RunStatus, Scenario
    from evalhub.evaluation.models import EvaluationRow, ExperimentDefinition, RunResult

    async with async_session() as session:
        store = EvaluationStore(session)
        run_id = await store.create_run_job(dataset_name="refresh", response_source="agent", agent="synthetic", row_count=1, judge_model=None, tenant_id="test")
        run = RunResult(run_id=run_id, status=RunStatus.COMPLETED,
            experiment=ExperimentDefinition(
                experiment_id=run_id, name="refresh", dataset_version="refresh.v1", target_endpoint="synthetic", scenario=Scenario.AGENTIC, tenant_id="test",
            ),
        )
        row = EvaluationRow(row_id="row", query="q", response="a")
        await store.save_run(run, [row])
        row.response = "updated"
        await store.save_run(run, [row], finalize_job=False, replace_existing=True, allow_completed_telemetry_refresh=True)
        assert (await store.get_run_job(run_id)).status == "completed"
        assert (await store.get_run(run_id)).status == RunStatus.COMPLETED
