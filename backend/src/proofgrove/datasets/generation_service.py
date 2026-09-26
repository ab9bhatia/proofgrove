"""In-process execution of durable dataset-generation jobs.

Follows the ``proofgrove.runs_worker`` pattern — background asyncio work inside
the API process, no new infrastructure — but keyed by the durable job row in
``dataset_generation_jobs`` (see ``proofgrove.datasets.generation_jobs``):

- ``start_generation`` persists a QUEUED job then launches one asyncio task.
- The task advances the job phase with compare-and-set writes, so a cancel
  that lands mid-flight always wins and terminal phases are never overwritten.
- ``cancel_generation`` durably marks the row CANCELLED and cancels the
  in-process task when this process owns it.
- On first store use and status polls, stale active jobs are swept to
  ``failed``/"interrupted". One heartbeat protects each live task, including
  while queued or registering; a restarted process never resumes lost state.

Job survival model: the job row is durable, so navigating away and back (or
reloading the page) re-attaches to a live job; a process restart is an honest
interruption, not a resume.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from functools import lru_cache
from threading import Lock
from typing import Any

from starlette.concurrency import run_in_threadpool

from proofgrove.datasets.generation_jobs import (
    GenerationJobPhase,
    GenerationJobStore,
)
from proofgrove.datasets.models import CreateDatasetRequest, DatasetRecord
from proofgrove.datasets.registry import DatasetRegistryService

# Synthesis halves of the generation pipeline (registration stays here so the
# job can report an honest generating → validating phase split).
from proofgrove.generation.pipeline import (  # noqa: PLC2701 — module-internal seams reused deliberately
    _generate_from_grounded_seeds,
    _generate_from_prompt,
)
from proofgrove.redaction import safe_error_message
from proofgrove.settings import settings

logger = logging.getLogger(__name__)

def _job_error(exc: BaseException) -> str:
    """The ``error`` column is tenant-visible: authored text only (``safe_error_message``)."""
    return safe_error_message(exc)


#: In-process tasks by job id — lets cancel interrupt a live generation and is
#: intentionally *not* durable (a restart sweeps the rows to failed/interrupted).
_TASKS: dict[str, asyncio.Task] = {}

#: Bounds how many generation jobs run their synthesis concurrently in this
#: process. Sized from settings, not hardcoded, so an operator can tune it
#: without a code change — see Settings.dataset_generation_max_concurrent_jobs.
_GENERATION_SEMAPHORE = asyncio.Semaphore(max(1, settings.dataset_generation_max_concurrent_jobs))


_STORE_LOCK = Lock()


def get_generation_job_store() -> GenerationJobStore:
    # Concurrent HTTP worker threads must not run the interruption sweep twice.
    with _STORE_LOCK:
        return _generation_job_store()


@lru_cache
def _generation_job_store() -> GenerationJobStore:
    """Singleton job store; first use in a process sweeps lost jobs honestly."""
    store = GenerationJobStore()
    store.mark_interrupted()
    return store


async def _synthesize_records(params: dict[str, Any]) -> list[DatasetRecord]:
    """Produce records via the existing pipeline paths (patchable test seam)."""
    method = str(params.get("generation_method") or "").strip().lower()
    if method == "llms":
        return await _generate_from_prompt(params)
    return await _generate_from_grounded_seeds(params)


async def _heartbeat_generation_progress(store: GenerationJobStore, job_id: str, interval_seconds: float) -> None:
    """Heartbeat the one task through queueing, synthesis, and registration."""
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            await run_in_threadpool(store.touch, job_id)
        except Exception as exc:  # noqa: BLE001 — retry a transient DB failure next heartbeat
            logger.warning('dataset-generation heartbeat failed for %s', job_id, extra={'error_type': type(exc).__name__})


def _register_records(
    dataset_name: str,
    params: dict[str, Any],
    records: list[DatasetRecord],
    registry: DatasetRegistryService,
) -> tuple[str, int]:
    """Register generated records as a DRAFT dataset (validation half).

    Mirrors the registration half of ``generate_and_register``. The async
    worker runs this synchronous transaction work in the thread pool.
    """
    tenant_id = params.get("tenant_id") or settings.pod_namespace or "local"
    product_id = params.get("product_id") or "proofgrove"
    info = registry.create_dataset(
        CreateDatasetRequest(
            dataset_name=dataset_name,
            tenant_id=tenant_id,
            product_id=product_id,
            created_by="proofgrove-generator",
        )
    )
    # create_dataset may reuse a DRAFT or mint `{name}_vN` when the name exists.
    count = registry.replace_records(info.name, records, tenant_id)
    return info.name, count


async def _execute(job_id: str, registry: DatasetRegistryService) -> None:
    """Run one generation job to an honest terminal phase.

    Bounded by ``_GENERATION_SEMAPHORE``: a job waits here — still reporting
    QUEUED, honestly — until a concurrency slot is free, rather than every
    request spawning an unbounded task that immediately hammers the
    generation LLM/gateway.
    """
    store = await run_in_threadpool(get_generation_job_store)
    heartbeat_task = asyncio.create_task(
        _heartbeat_generation_progress(store, job_id, settings.dataset_generation_progress_heartbeat_seconds)
    )
    try:
        async with _GENERATION_SEMAPHORE:
            await _execute_locked(job_id, registry)
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task


async def _execute_locked(job_id: str, registry: DatasetRegistryService) -> None:
    store = await run_in_threadpool(get_generation_job_store)
    job = await run_in_threadpool(store.get_job, job_id)
    if job is None:
        return
    params: dict[str, Any] = job.get("params") or {}
    requested_rows = int(params.get("num_rows") or 0)

    if not await run_in_threadpool(store.advance,
        job_id,
        from_phases={GenerationJobPhase.QUEUED},
        to_phase=GenerationJobPhase.GENERATING,
        progress_done=0,
        progress_total=requested_rows if requested_rows > 0 else None,
    ):
        return  # cancelled before it ever started

    try:
        records = await _synthesize_records(params)
    except asyncio.CancelledError:
        # The cancel endpoint already CAS'd the row to CANCELLED; this is a
        # belt-and-braces write for a task cancelled by other means.
        await run_in_threadpool(store.advance,
            job_id,
            from_phases={GenerationJobPhase.GENERATING},
            to_phase=GenerationJobPhase.CANCELLED,
        )
        return
    except Exception as exc:  # noqa: BLE001 — job failures are recorded, not raised
        await run_in_threadpool(store.advance,
            job_id,
            from_phases={GenerationJobPhase.GENERATING},
            to_phase=GenerationJobPhase.FAILED,
            error=_job_error(exc),
        )
        logger.warning('dataset-generation job %s failed during synthesis: %s', job_id, type(exc).__name__, extra={'error_type': type(exc).__name__})
        return

    if not await run_in_threadpool(store.advance,
        job_id,
        from_phases={GenerationJobPhase.GENERATING},
        to_phase=GenerationJobPhase.VALIDATING,
        progress_done=len(records),
        progress_total=requested_rows if requested_rows > 0 else len(records),
    ):
        return  # cancelled while generating — do not register anything

    # The successful GENERATING → VALIDATING CAS above owns the commit:
    # cancellation cannot claim this phase or interrupt the registration thread.
    try:
        target_name, count = await run_in_threadpool(_register_records, job["dataset_name"], params, records, registry)
    except Exception as exc:  # noqa: BLE001 — registration failures are job failures
        await run_in_threadpool(store.advance,
            job_id,
            from_phases={GenerationJobPhase.VALIDATING},
            to_phase=GenerationJobPhase.FAILED,
            error=_job_error(exc),
        )
        logger.warning('dataset-generation job %s failed during registration: %s', job_id, type(exc).__name__, extra={'error_type': type(exc).__name__})
        return

    await run_in_threadpool(store.advance,
        job_id,
        from_phases={GenerationJobPhase.VALIDATING},
        to_phase=GenerationJobPhase.COMPLETED,
        progress_done=count,
        progress_total=requested_rows if requested_rows > 0 else count,
        result_dataset_name=target_name,
    )
    logger.info(
        "dataset-generation job %s completed: %d rows into %s", job_id, count, target_name
    )


async def start_generation(
    *,
    dataset_name: str,
    params: dict[str, Any],
    registry: DatasetRegistryService,
) -> dict[str, Any]:
    """Persist a QUEUED job and launch its in-process background task."""
    store = await run_in_threadpool(get_generation_job_store)
    job = await run_in_threadpool(store.create_job,
        tenant_id=str(params.get("tenant_id") or settings.pod_namespace or "local"),
        dataset_name=dataset_name,
        params=params,
    )
    job_id = job["job_id"]
    task = asyncio.create_task(_execute(job_id, registry), name=f"dataset-generation-{job_id}")
    _TASKS[job_id] = task
    task.add_done_callback(lambda _t, jid=job_id: _TASKS.pop(jid, None))
    return job


def get_generation_job(job_id: str, tenant_id: str) -> dict[str, Any] | None:
    store = get_generation_job_store()
    # A quick restart sees fresh lost jobs. Recheck when polled so they cannot
    # remain active forever after the one-time startup sweep skipped them.
    store.mark_interrupted()
    return store.get_job(job_id, tenant_id)


async def cancel_generation(job_id: str, tenant_id: str) -> dict[str, Any] | None:
    """Durably cancel a job owned by ``tenant_id`` (idempotent) and stop its
    in-process task.

    Only queued/generating phases are affected; registration and terminal
    phases are returned unchanged so callers can report the honest state. Returns
    ``None`` for an unknown id or one owned by a different tenant.
    """
    store = await run_in_threadpool(get_generation_job_store)
    job = await run_in_threadpool(store.request_cancel, job_id, tenant_id)
    if job is not None and job["phase"] == GenerationJobPhase.CANCELLED.value:
        task = _TASKS.get(job_id)
        if task is not None and not task.done():
            task.cancel()
    return job
