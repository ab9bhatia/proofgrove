"""Temporal workflow boundary for asynchronous Eval Hub runs.

The module has no Temporal import at module load time so local/offline execution
remains possible. Production selects this runtime with EVALUATION_RUNTIME=temporal.

A job row is committed before its workflow is started, and a start can fail --
or succeed with the reply lost -- without the API being able to tell which. The
row is therefore never marked failed on a start error. Instead every accepted
start stamps the row (``mark_run_job_submitted``) and a supervised loop
resubmits pending rows that carry no stamp, by their stable workflow id, after
a short grace period. The stable ID handles concurrent API/reconciler submissions.
``REJECT_DUPLICATE`` prevents reuse of executions retained by Temporal.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from evalhub.settings import Settings, settings

logger = logging.getLogger(__name__)

# Rows per store page in one reconciliation pass; the pass walks every page.
_RECONCILE_PAGE = 500


@dataclass
class DatasetRunWorkflowInput:
    run_id: str


@dataclass
class DatasetRunFailure:
    run_id: str
    message: str


def workflow_id_for_run(run_id: str) -> str:
    """Stable identity: the same job can never be started twice."""
    return f"evalhub-run-{run_id}"


async def _mark_submitted(run_id: str) -> None:
    from evalhub.db.session import async_session
    from evalhub.db.store import EvaluationStore

    async with async_session() as session:
        await EvaluationStore(session).mark_run_job_submitted(run_id)


async def _start(client: Any, run_id: str, runtime: Settings) -> None:
    """Start the job's workflow; a duplicate id (in flight or closed) is refused."""
    from temporalio.common import WorkflowIDReusePolicy

    await client.start_workflow(
        "evalhub.dataset-run",
        DatasetRunWorkflowInput(run_id=run_id),
        id=workflow_id_for_run(run_id),
        task_queue=runtime.temporal_task_queue,
        id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
    )


async def submit_dataset_run(run_id: str, cfg: Settings | None = None) -> None:
    """Start a durable workflow for an already-persisted run job.

    On success the job is stamped as submitted. ``WorkflowAlreadyStartedError``
    (the workflow exists, or existed) also stamps the row and is re-raised for
    callers that treat it as idempotent success. Any other failure is raised
    as-is: the caller must not mark the job failed on it -- the outcome is
    unknown to this process, and the reconciliation loop settles it.
    """
    runtime = cfg or settings
    if runtime.evaluation_runtime != "temporal":
        return
    from temporalio.client import Client
    from temporalio.exceptions import WorkflowAlreadyStartedError

    client = await Client.connect(runtime.temporal_host, namespace=runtime.temporal_namespace)
    try:
        await _start(client, run_id, runtime)
    except WorkflowAlreadyStartedError:
        await _mark_submitted(run_id)
        raise
    await _mark_submitted(run_id)


async def cancel_dataset_run(run_id: str, cfg: Settings | None = None) -> None:
    """Request cancellation of the durable workflow for an Eval Hub run."""
    runtime = cfg or settings
    if runtime.evaluation_runtime != "temporal":
        return
    from temporalio.client import Client

    client = await Client.connect(runtime.temporal_host, namespace=runtime.temporal_namespace)
    await client.get_workflow_handle(workflow_id_for_run(run_id)).cancel()


async def reconcile_pending_run_jobs(client: Any, cfg: Settings | None = None, *, page: int = _RECONCILE_PAGE) -> int:
    """One pass: start a workflow for every unstamped pending job old enough to be settled.

    Walks the whole pending set in keyset pages. A job whose workflow turns
    out to exist is stamped and skipped; a start that fails is logged (type
    only) and left for the next pass. Returns how many workflows were started.
    """
    from temporalio.exceptions import WorkflowAlreadyStartedError

    from evalhub.db.session import async_session
    from evalhub.db.store import WORKFLOW_SUBMITTED_AT_KEY, EvaluationStore

    runtime = cfg or settings
    older_than = datetime.now(UTC) - timedelta(seconds=runtime.temporal_reconcile_after_seconds)
    started = 0
    after: tuple[datetime, str] | None = None
    while True:
        async with async_session() as session:
            store = EvaluationStore(session)
            batch = await store.list_pending_run_job_page(older_than=older_than, limit=page, after=after)
        if not batch:
            return started
        after = (batch[-1].created_at, batch[-1].run_id)
        for job in batch:
            if (job.params or {}).get(WORKFLOW_SUBMITTED_AT_KEY):
                continue
            try:
                await _start(client, job.run_id, runtime)
            except WorkflowAlreadyStartedError:
                await _mark_submitted(job.run_id)
                continue
            except Exception as exc:  # noqa: BLE001 - one job must not stop the pass
                logger.error("eval-hub: could not resubmit pending run %s", job.run_id, extra={"error_type": type(exc).__name__})
                continue
            await _mark_submitted(job.run_id)
            started += 1
        if len(batch) < page:
            return started


async def reconcile_pending_run_jobs_loop(client: Any, stop: asyncio.Event, cfg: Settings | None = None) -> None:
    """Run ``reconcile_pending_run_jobs`` until ``stop``; a failing pass is retried next tick."""
    runtime = cfg or settings
    logger.info("eval-hub: Temporal reconciliation loop started")
    while not stop.is_set():
        try:
            started = await reconcile_pending_run_jobs(client, runtime)
            if started:
                logger.info("eval-hub: resubmitted %d pending run jobs to Temporal", started)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - never let the loop die; readiness watches the task
            logger.error("eval-hub: Temporal reconciliation pass failed", extra={"error_type": type(exc).__name__})
        try:
            await asyncio.wait_for(stop.wait(), timeout=runtime.temporal_reconcile_interval_seconds)
        except TimeoutError:
            pass  # Poll interval elapsed; retry pending submissions on the next tick.
    logger.info("eval-hub: Temporal reconciliation loop stopped")


@asynccontextmanager
async def temporal_worker(cfg: Settings | None = None) -> AsyncIterator[Any]:
    """Connect before serving requests; let the SDK supervise worker failures.

    Yields the connected client so the lifespan can run the reconciliation
    loop against it.
    """
    runtime = cfg or settings
    from temporalio.client import Client
    from temporalio.worker import Worker

    from evalhub.orchestrator.workflows import DatasetRunWorkflow, execute_dataset_run_job, fail_dataset_run_job

    client = await Client.connect(runtime.temporal_host, namespace=runtime.temporal_namespace)
    worker = Worker(
        client,
        task_queue=runtime.temporal_task_queue,
        workflows=[DatasetRunWorkflow],
        activities=[execute_dataset_run_job, fail_dataset_run_job],
    )
    async with worker:
        yield client
