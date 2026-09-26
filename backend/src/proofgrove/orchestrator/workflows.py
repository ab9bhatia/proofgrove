"""Temporal workflow and idempotent activity for a persisted Proofgrove run job."""

from __future__ import annotations

import asyncio
import contextlib
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

# The workflow sandbox re-imports this module and refuses non-deterministic
# work during that import. ``proofgrove.settings`` builds its Settings object at
# import (pydantic-settings expands ``~``), which the sandbox rejects, so a real
# worker failed to validate ``proofgrove.dataset-run`` at startup. Both modules
# are configuration read once per process; pass them through unsandboxed.
with workflow.unsafe.imports_passed_through():
    from proofgrove.orchestrator.temporal import DatasetRunFailure, DatasetRunWorkflowInput
    from proofgrove.settings import settings


async def _execute_dataset_run_job(run_id: str) -> None:
    """Execute the persisted job once; a completed result makes retries safe.

    Every exception leaves as a sanitized ``ApplicationError`` with no cause
    chain: the store reads that precede the job's own try-block would
    otherwise put a driver's message into workflow history.
    """
    from proofgrove.runs_worker import application_error_for, process_run_job

    try:
        await process_run_job(run_id)
    except ApplicationError:
        raise
    except Exception as exc:
        raise application_error_for(exc, run_id) from None


async def _heartbeat_loop(interval_seconds: float) -> None:
    """Heartbeat on a fixed interval for the life of the activity.

    ``process_run_job`` is one long ``await`` with no natural checkpoints to
    heartbeat from inside, so a background task heartbeats alongside it. This
    is not just liveness reporting: the Temporal SDK only *delivers* a
    cancellation request into a running async activity on a heartbeat call.
    With no heartbeat at all, ``cancel_dataset_run`` cancels the workflow, but
    the up-to-26h activity underneath it never finds out and keeps running.
    """
    while True:
        await asyncio.sleep(interval_seconds)
        activity.heartbeat()


@activity.defn(name="proofgrove.execute-run-job")
async def execute_dataset_run_job(run_id: str) -> None:
    heartbeat_task = asyncio.create_task(_heartbeat_loop(settings.temporal_activity_heartbeat_seconds))
    try:
        await _execute_dataset_run_job(run_id)
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task


@activity.defn(name="proofgrove.fail-dataset-run-job")
async def fail_dataset_run_job(failure: DatasetRunFailure) -> None:
    """Mark the job failed once every run attempt is spent (compare-and-set)."""
    from proofgrove.runs_worker import application_error_for, fail_run_job

    try:
        await fail_run_job(failure.run_id, failure.message)
    except Exception as exc:
        raise application_error_for(exc, failure.run_id) from None


@workflow.defn(name="proofgrove.dataset-run")
class DatasetRunWorkflow:
    @workflow.run
    async def run(self, request: DatasetRunWorkflowInput) -> None:
        try:
            await workflow.execute_activity(
                execute_dataset_run_job,
                request.run_id,
                # Allow the default 24-hour late-telemetry enrichment window.
                start_to_close_timeout=timedelta(hours=26),
                heartbeat_timeout=timedelta(seconds=settings.temporal_activity_heartbeat_timeout_seconds),
                # Retries are safe: a completed result short-circuits the next
                # attempt, and a failed attempt leaves the job RUNNING so the
                # next one can claim it. Only the workflow marks the job
                # failed, after the last attempt.
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
        except ActivityError as exc:
            cause = exc.cause
            message = getattr(cause, "message", None) or type(cause or exc).__name__
            await workflow.execute_activity(
                fail_dataset_run_job,
                DatasetRunFailure(run_id=request.run_id, message=message),
                start_to_close_timeout=timedelta(minutes=1),
            )
            raise
