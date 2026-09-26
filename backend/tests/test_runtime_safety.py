"""Runtime failures stay private; registration owns a non-cancellable commit."""

import asyncio
import logging
import threading
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from starlette.requests import Request

from proofgrove import main, runs_worker
from proofgrove.datasets import generation_service
from proofgrove.datasets.generation_jobs import GenerationJobStore
from proofgrove.datasets.models import DatasetRecord
from proofgrove.datasets.postgres_store import SqlDatasetStore
from proofgrove.datasets.registry import DatasetRegistryService
from proofgrove.errors import EvaluationInputError
from proofgrove.tracing import index_worker


async def test_registration_cannot_report_cancelled_then_replace_records(monkeypatch):
    store = GenerationJobStore()
    registry = DatasetRegistryService(storage=SqlDatasetStore())
    entered, release = threading.Event(), threading.Event()
    register = generation_service._register_records

    def held_registration(*args):
        entered.set()
        assert release.wait(5), "test did not release registration"
        return register(*args)

    monkeypatch.setattr(generation_service, "get_generation_job_store", lambda: store)
    monkeypatch.setattr(generation_service, "_synthesize_records", AsyncMock(return_value=[DatasetRecord(inputs={"query": "q"}, expectations={"expected_response": "a"})]))
    monkeypatch.setattr(generation_service, "_register_records", held_registration)
    job = await generation_service.start_generation(dataset_name="registration", params={"tenant_id": "test", "num_rows": 1}, registry=registry)
    task = generation_service._TASKS[job["job_id"]]
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        cancelled = await generation_service.cancel_generation(job["job_id"], "test")
        assert cancelled["phase"] == "validating"
        assert not task.cancelling()
    finally:
        release.set()
        await asyncio.wait_for(task, 5)
    completed = store.get_job(job["job_id"], "test")
    assert completed["phase"] == "completed"
    assert completed["progress"]["done"] == 1
    assert registry.get_records(completed["result_dataset_name"], "test")[0]["inputs"]["query"] == "q"


@pytest.mark.parametrize("path", ["http", "run", "generation", "archive"])
async def test_runtime_failure_logs_exclude_raw_exception(monkeypatch, caplog, path):
    sentinel = "private-input-sentinel password=opaque-credential-sentinel"
    error = RuntimeError(sentinel)
    caplog.set_level(logging.WARNING)
    if path == "http":
        try:
            raise error
        except RuntimeError as exc:
            response = await main._json_unhandled_handler(Request({"type": "http", "method": "GET", "path": "/example", "headers": []}), exc)
        assert response.status_code == 500
    elif path == "generation":
        store = GenerationJobStore()
        job = store.create_job(tenant_id="test", dataset_name="failed", params={"num_rows": 1})
        monkeypatch.setattr(generation_service, "get_generation_job_store", lambda: store)
        monkeypatch.setattr(generation_service, "_synthesize_records", AsyncMock(side_effect=error))
        await generation_service._execute_locked(job["job_id"], object())
        failed = store.get_job(job["job_id"])
        assert failed["phase"] == "failed"
        assert sentinel not in failed["error"]
        assert failed["error"] == "RuntimeError: the failure detail is withheld from stored evidence"
    else:
        store = AsyncMock()

        @asynccontextmanager
        async def sessions():
            yield object()

        if path == "run":
            store.claim_next_pending_job.return_value = SimpleNamespace(run_id="run", kind="eval", dataset_name="data", tenant_id="test", response_source="provided", agent=None, row_count=1, judge_model=None, params={})
            monkeypatch.setattr(runs_worker, "async_session", sessions)
            monkeypatch.setattr(runs_worker, "EvaluationStore", lambda _: store)
            monkeypatch.setattr(runs_worker, "get_registry_service", object)
            monkeypatch.setattr(runs_worker, "get_evaluation_engine", object)
            monkeypatch.setattr(runs_worker, "_start_cancellation_watch", lambda _: None)
            monkeypatch.setattr(runs_worker, "execute_dataset_run", AsyncMock(side_effect=error))
            assert await runs_worker.process_one_job()
            store.fail_run_job.assert_awaited_once()
            # The persisted message is tenant-visible evidence, not just a log line.
            persisted = store.fail_run_job.await_args.args[1]
            assert sentinel not in persisted
            assert persisted == "RuntimeError: the failure detail is withheld from stored evidence"
        else:
            monkeypatch.setattr(index_worker, "EvaluationStore", lambda _: store)
            state = await index_worker._confirm_one(sessions, SimpleNamespace(find=AsyncMock(side_effect=error)), "test", "test", {"trace_id": "trace"}, None)
            assert state == "archive_unavailable"
    records = [record for record in caplog.records if record.name.startswith("proofgrove.")]
    assert records
    for record in records:
        assert record.exc_info is None
        assert sentinel not in record.getMessage()
        assert getattr(record, "error_type", None) == "RuntimeError"


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (EvaluationInputError("Source run has no immutable evidence snapshot to rescore"), "Source run has no immutable evidence snapshot to rescore"),
        (EvaluationInputError("target postgresql://eval:s3cret@db.internal/proofgrove password=hunter2"), "target postgresql://eval:[REDACTED]@db.internal/proofgrove password=[REDACTED]"),
        (RuntimeError("postgresql://eval:s3cret@db.internal/proofgrove"), "RuntimeError: the failure detail is withheld from stored evidence"),
    ],
)
def test_job_error_messages_keep_authored_text_and_withhold_driver_text(error, expected):
    assert runs_worker._job_error_message(error) == expected


def test_pydantic_validation_errors_are_never_treated_as_safe():
    """``ValidationError`` subclasses ``ValueError`` but repeats the offending input."""
    from pydantic import BaseModel

    class _Probe(BaseModel):
        count: int

    try:
        _Probe(count="password=opaque-credential-sentinel")
    except ValueError as exc:
        message = runs_worker._job_error_message(exc)
    assert "opaque-credential-sentinel" not in message
    assert message.startswith("ValidationError:")


async def test_wrapped_agent_transport_errors_never_become_public(monkeypatch):
    import httpx

    from proofgrove.evaluation.target import a2a_client
    from proofgrove.redaction import safe_error_message

    sentinel = "SYNTHETIC_PRIVATE_PAYLOAD_42"
    real_client = httpx.AsyncClient
    def fail(request):
        raise httpx.ConnectError(sentinel, request=request)
    monkeypatch.setattr(a2a_client.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(fail)))
    with pytest.raises(a2a_client.AgentInvocationError) as raised:
        await a2a_client.invoke_agent(kagent_url="http://synthetic.invalid", namespace="t", agent_name="a", prompt="synthetic")
    assert sentinel not in str(raised.value)
    assert sentinel not in safe_error_message(raised.value)
    assert sentinel not in safe_error_message(ValueError(sentinel))
