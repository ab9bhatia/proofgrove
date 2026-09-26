"""The lifespan workers are supervised: their death is logged and reported by
readiness, and shutdown gives them a bounded drain before cancelling."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from proofgrove.main import _drain_workers, _log_worker_exit, app


def test_readiness_reports_a_stopped_background_worker() -> None:
    """A dead run worker leaves every submitted job pending; the probe must say so
    rather than keep routing traffic to a process that executes nothing."""
    with TestClient(app) as client:
        assert client.get("/health/ready").status_code == 200
        worker = app.state.background_workers["run-worker"]
        worker.cancel()

        async def _settled() -> None:
            await asyncio.wait({worker}, timeout=5)

        client.portal.call(_settled)
        assert worker.done()
        response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "not ready", "reason": "background worker stopped", "worker": "run-worker"}


@pytest.mark.asyncio
async def test_shutdown_drain_is_bounded_and_cancels_a_stuck_worker() -> None:
    finished = asyncio.create_task(asyncio.sleep(0), name="finished")
    stuck = asyncio.create_task(asyncio.sleep(60), name="stuck")
    await asyncio.wait_for(_drain_workers({"finished": finished, "stuck": stuck}, 0.05), timeout=2)
    assert finished.done() and not finished.cancelled()
    assert stuck.cancelled()


def test_a_worker_that_dies_is_logged_by_type_only(caplog) -> None:
    async def _fail() -> None:
        raise RuntimeError("host=nowhere.invalid password=hunter2")

    async def _run() -> None:
        task = asyncio.create_task(_fail(), name="run-worker")
        task.add_done_callback(_log_worker_exit)
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.sleep(0)

    with caplog.at_level("CRITICAL"):
        asyncio.run(_run())
    exits = [record for record in caplog.records if "background worker run-worker exited" in record.getMessage()]
    assert exits and exits[0].error_type == "RuntimeError"
    assert "hunter2" not in str(vars(exits[0]))


async def test_shutdown_deadline_includes_cancellation_cleanup(caplog):
    release = asyncio.Event()
    started = asyncio.Event()
    async def worker():
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await release.wait()
    task = asyncio.create_task(worker(), name="slow-cleanup")
    await started.wait()
    try:
        await asyncio.wait_for(_drain_workers({"worker": task}, 0.01), 0.2)
        assert not task.done()
        assert "still running at the shutdown deadline" in caplog.text
    finally:
        release.set()
        await task
