"""In-process background worker for async evaluation runs.

A single lifespan-started task polls the run_jobs table for PENDING jobs and
executes them (agent invocation per row is slow network I/O, so it must not block
the request). Mirrors the memory service's DB-status + worker-poll pattern and
evalai-reconciler's lifespan asyncio poll loop. PostgreSQL elects one active
compatibility worker across replicas, including during rolling deployment.

Store reads in this module (``get_run``, ``get_run_job``) intentionally omit
``tenant_id``: the worker drains one shared ``run_jobs`` queue keyed by
``run_id`` across every tenant, so it has no per-request caller tenant to scope
by -- unlike an HTTP route, which must always pass its authenticated
``tenant_id``. This is the legitimate cross-tenant case the read side of the
tenant sweep (see ``db/store.py::tenant_clause``) carves out.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import text
from temporalio import activity
from temporalio.exceptions import ApplicationError

from proofgrove.api.dependencies import get_evaluation_engine, get_registry_service
from proofgrove.db.session import async_engine, async_session
from proofgrove.db.store import EvaluationStore, RunCancelledError
from proofgrove.evaluation.enums import EvaluationScope, RunStatus, TriggerReason
from proofgrove.evaluation.readiness import ReadinessBlockedError
from proofgrove.evaluation.run_service import (
    DATASET_RUN_DEFERRED,
    TELEMETRY_SCORE_SNAPSHOT_KEY,
    execute_dataset_run,
    execute_deferred_telemetry_score,
    execute_rescore,
)
from proofgrove.generation.pipeline import generate_and_register
from proofgrove.redaction import safe_error_message
from proofgrove.settings import settings
from proofgrove.tracing.scoring import execute_span_scoring

logger = logging.getLogger(__name__)

_active_run_tasks: dict[str, asyncio.Task] = {}


def cancel_active_run(run_id: str) -> bool:
    """Cancel a currently executing in-process run, if this pod owns it."""

    task = _active_run_tasks.get(run_id)
    if task is None or task.done():
        return False
    task.cancel()
    return True


async def _watch_durable_cancellation(
    run_id: str,
    owner: asyncio.Task,
) -> None:
    """Cancel ``owner`` when another process marks its durable job stopped."""

    poll = max(0.05, settings.evaluation_cancel_poll_seconds)
    while not owner.done():
        await asyncio.sleep(poll)
        try:
            async with async_session() as session:
                job = await EvaluationStore(session).get_run_job(run_id)
        except Exception as exc:  # noqa: BLE001 - a transient read must not kill execution
            logger.warning('proofgrove: could not check cancellation state for run %s', run_id, extra={'error_type': type(exc).__name__})
            continue
        if job is None or job.status in {
            RunStatus.COMPLETED.value,
            RunStatus.FAILED.value,
            RunStatus.BLOCKED.value,
        }:
            return
        if job.status == RunStatus.CANCELLED.value:
            logger.info("proofgrove: observed durable stop request for active run %s", run_id)
            owner.cancel()
            return


def _start_cancellation_watch(run_id: str) -> asyncio.Task | None:
    owner = asyncio.current_task()
    if owner is None:
        return None
    return asyncio.create_task(
        _watch_durable_cancellation(run_id, owner),
        name=f"proofgrove-cancel-watch-{run_id}",
    )


async def _stop_cancellation_watch(watch: asyncio.Task | None) -> None:
    if watch is None:
        return
    watch.cancel()
    try:
        await watch
    except asyncio.CancelledError:
        pass  # Expected after cancelling the watch above.


def _job_error_message(exc: BaseException) -> str:
    """One actionable, tenant-safe line for a failed job.

    ``error_message`` is tenant-visible evidence: only a ``TenantVisibleError``
    keeps its authored text, everything else is reduced to its type name
    (``safe_error_message``).
    """
    return safe_error_message(exc)


async def process_one_job(*, register_active: bool = False) -> bool:
    """Claim and execute a single pending job. Returns True if one was processed."""

    async with async_session() as session:
        store = EvaluationStore(session)
        job = await store.claim_next_pending_job()
        if job is None:
            if await process_one_deferred_telemetry_job():
                return True
            return await process_one_completed_telemetry_watch()
        run_id = job.run_id
        kind = job.kind
        dataset_name = job.dataset_name
        # None on a legacy job created before tenant attribution -- the
        # dataset store treats that as "no tenant to check against" rather
        # than a wildcard (see _get_dataset_row in postgres_store.py).
        tenant_id = job.tenant_id
        response_source = job.response_source
        agent = job.agent
        row_count = job.row_count
        judge_model = job.judge_model
        params = dict(job.params or {})

    if register_active:
        task = asyncio.current_task()
        if task is not None:
            _active_run_tasks[run_id] = task
            task.add_done_callback(lambda completed, active_run_id=run_id: _active_run_tasks.pop(active_run_id, None) if _active_run_tasks.get(active_run_id) is completed else None)

    registry = get_registry_service()
    cancellation_watch = _start_cancellation_watch(run_id)
    try:
        if kind == "generate":
            await generate_and_register(dataset_name=dataset_name, params=params, registry=registry)
        elif kind == "span_score":
            async with async_session() as session:
                await execute_span_scoring(job_id=run_id, params=params, judge_model=judge_model, engine=get_evaluation_engine(), store=EvaluationStore(session))
        elif kind == "rescore":
            async with async_session() as session:
                await execute_rescore(
                    run_id=run_id,
                    source_run_id=params["source_run_id"],
                    active_metrics=list(params.get("active_metrics") or []),
                    judge_model=judge_model,
                    created_by=params.get("created_by") or "system",
                    source_evidence_snapshot=params["source_evidence_snapshot"],
                    store=EvaluationStore(session),
                    engine=get_evaluation_engine(),
                )
        else:
            trigger_reason = TriggerReason(params.get("trigger_reason", TriggerReason.MANUAL.value))
            correlation_id = params.get("correlation_id") or run_id
            async with async_session() as session:
                outcome = await execute_dataset_run(
                    run_id=run_id,
                    dataset_name=dataset_name,
                    tenant_id=tenant_id,
                    response_source=response_source,
                    agent=agent,
                    row_count=row_count,
                    judge_model=judge_model,
                    target_endpoint=params.get("target_endpoint"),
                    target_model=params.get("target_model"),
                    system_prompt=params.get("system_prompt"),
                    prompt_version_ref=params.get("prompt_version_ref"),
                    active_metrics=params.get("active_metrics"),
                    resolved_active_metrics=params.get("resolved_active_metrics"),
                    resolved_scoring_configuration=params.get("resolved_scoring_configuration"),
                    enable_llm_judge=bool(params.get("enable_llm_judge", True)),
                    parallel_requests=int(params.get("parallel_requests", 5)),
                    run_human_review=bool(params.get("run_human_review", True)),
                    quality_contract_ids=params.get("quality_contract_ids") or [],
                    store=EvaluationStore(session),
                    engine=get_evaluation_engine(),
                    registry=registry,
                    trigger_reason=trigger_reason,
                    correlation_id=correlation_id,
                    label=params.get("label") or params.get("name"),
                    labels=params.get("labels"),
                    evaluation_name=params.get("evaluation_name"),
                    evaluation_scope=EvaluationScope(params.get("evaluation_scope", EvaluationScope.FINAL_RESPONSE.value)),
                    evidence_readiness_snapshot=params.get("evidence_readiness"),
                    requested_provenance=params.get("requested_provenance") or {},
                    project_id=params.get("project_id"),
                    run_manifest_id=params.get("run_manifest_id"),
                    assignment_id=params.get("assignment_id"),
                    assignment_version=params.get("assignment_version"),
                )
            if outcome == DATASET_RUN_DEFERRED:
                logger.info("proofgrove: %s job %s awaiting completed traces", kind, run_id)
                return True
        async with async_session() as session:
            await EvaluationStore(session).complete_run_job(run_id)
        logger.info("proofgrove: %s job %s completed", kind, run_id)
    except ReadinessBlockedError as exc:
        logger.warning('proofgrove: %s job %s blocked by readiness: %s', kind, run_id, type(exc).__name__, extra={'error_type': type(exc).__name__})
        async with async_session() as session:
            await EvaluationStore(session).block_run_job(
                run_id,
                str(exc),
                exc.readiness.model_dump(mode="json"),
            )
    except RunCancelledError:
        logger.info("proofgrove: %s job %s stopped before results were persisted", kind, run_id)
    except Exception as exc:  # noqa: BLE001 — platform failures mark the job FAILED
        logger.error('proofgrove: %s job %s failed', kind, run_id, extra={'error_type': type(exc).__name__})
        async with async_session() as session:
            await EvaluationStore(session).fail_run_job(run_id, _job_error_message(exc))
    finally:
        await _stop_cancellation_watch(cancellation_watch)
    return True


async def process_one_deferred_telemetry_job() -> bool:
    """Score one parked run if its archived trajectory is now complete.

    Returns True when a job was completed or failed. Returns False when nothing
    is waiting, or traces are still incomplete, so the worker can back off.
    """

    async with async_session() as session:
        store = EvaluationStore(session)
        jobs = await store.list_jobs_awaiting_trace(limit=1)
        if not jobs:
            return False
        run_id = jobs[0].run_id
        published = await store.get_run(run_id)
        if published and published.status != RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE:
            await store.complete_run_job(run_id)
            return True
    try:
        async with async_session() as session:
            outcome = await execute_deferred_telemetry_score(
                run_id=run_id,
                store=EvaluationStore(session),
                engine=get_evaluation_engine(),
            )
        if outcome == DATASET_RUN_DEFERRED:
            return False
        async with async_session() as session:
            await EvaluationStore(session).complete_run_job(run_id)
        logger.info("proofgrove: deferred telemetry score completed for %s", run_id)
    except ReadinessBlockedError as exc:
        logger.warning('proofgrove: deferred score %s blocked by readiness: %s', run_id, type(exc).__name__, extra={'error_type': type(exc).__name__})
        async with async_session() as session:
            await EvaluationStore(session).block_run_job(
                run_id,
                str(exc),
                exc.readiness.model_dump(mode="json"),
            )
    except RunCancelledError:
        logger.info("proofgrove: deferred score %s stopped before results were persisted", run_id)
    except Exception as exc:  # noqa: BLE001 — platform failures mark the job FAILED
        logger.error('proofgrove: deferred score %s failed', run_id, extra={'error_type': type(exc).__name__})
        async with async_session() as session:
            await EvaluationStore(session).fail_run_job(run_id, _job_error_message(exc))
    return True


async def process_one_completed_telemetry_watch() -> bool:
    """Recheck one recently completed trajectory for a settled late change."""

    async with async_session() as session:
        store = EvaluationStore(session)
        jobs = await store.list_completed_telemetry_watch_jobs(
            limit=1,
            min_check_interval_seconds=settings.trace_archive_deferred_poll_seconds,
        )
        if not jobs:
            return False
        run_id = jobs[0].run_id
        # Rollback expires the ORM job; preserve retry state before any I/O.
        snapshot = dict((jobs[0].params or {}).get(TELEMETRY_SCORE_SNAPSHOT_KEY) or {})
        try:
            await execute_deferred_telemetry_score(
                run_id=run_id,
                store=store,
                engine=get_evaluation_engine(),
            )
        except Exception as exc:  # noqa: BLE001 - keep the completed score and retry later
            logger.error('proofgrove: late telemetry recheck failed for %s', run_id, extra={'error_type': type(exc).__name__})
            await session.rollback()
            await store.update_run_job_telemetry_watch(run_id, snapshot)
    return True


async def _await_deferred_telemetry_score(run_id: str) -> None:
    """Block until a parked run is scored, failed, or the archive grace expires."""

    poll = max(0.05, settings.trace_archive_deferred_poll_seconds)
    while True:
        # This loop backs the Temporal activity's heartbeat_timeout — without a
        # heartbeat here a long telemetry wait looks like a dead worker. Guarded
        # because process_run_job / this helper also run outside an activity
        # context (in-process worker path, tests).
        if activity.in_activity():
            activity.heartbeat()
        async with async_session() as session:
            store = EvaluationStore(session)
            job = await store.get_run_job(run_id)
            if job is None or job.status == "cancelled":
                return
            published = await store.get_run(run_id)
            if published and published.status != RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE:
                return
            outcome = await execute_deferred_telemetry_score(
                run_id=run_id,
                store=store,
                engine=get_evaluation_engine(),
            )
        if outcome != DATASET_RUN_DEFERRED:
            return
        await asyncio.sleep(poll)


async def process_run_job(run_id: str) -> None:
    """Execute one persisted job by id for Temporal activity retries.

    A result already persisted for ``run_id`` means a prior activity attempt
    completed after Temporal lost the acknowledgement, so the retry is a no-op.
    Interrupted live target invocations fail explicitly unless a persisted
    telemetry snapshot lets scoring resume without invoking the target again.
    """
    async with async_session() as session:
        store = EvaluationStore(session)
        published = await store.get_run(run_id)
        if published and published.status != RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE:
            await store.complete_run_job(run_id)
            return
        existing_job = await store.get_run_job(run_id)
        if (
            existing_job is not None
            and existing_job.status == RunStatus.RUNNING.value
            and existing_job.kind == "eval"
            and existing_job.response_source in {"agent", "llm"}
            and not (existing_job.params or {}).get(TELEMETRY_SCORE_SNAPSHOT_KEY)
        ):
            # The target may have accepted a previous activity's request. A new
            # invocation ID cannot deduplicate its effects, so require a new run.
            message = "Worker interrupted before completion. Start a new run to retry."
            await store.fail_run_job(run_id, message)
            raise ApplicationError(message, non_retryable=True)
        job = await store.claim_run_job(run_id)
        if job is None:
            existing_job = await store.get_run_job(run_id)
            if existing_job and existing_job.kind == "span_score" and existing_job.status == RunStatus.COMPLETED.value:
                return
            raise ValueError(f"Run job {run_id} is unavailable or already claimed")
        kind = job.kind
        dataset_name = job.dataset_name
        tenant_id = job.tenant_id
        response_source = job.response_source
        agent = job.agent
        row_count = job.row_count
        judge_model = job.judge_model
        params = dict(job.params or {})

    registry = get_registry_service()
    cancellation_watch = _start_cancellation_watch(run_id)
    try:
        if kind == "generate":
            await generate_and_register(dataset_name=dataset_name, params=params, registry=registry)
        elif kind == "span_score":
            async with async_session() as session:
                await execute_span_scoring(job_id=run_id, params=params, judge_model=judge_model, engine=get_evaluation_engine(), store=EvaluationStore(session))
        else:
            if kind == "rescore":
                async with async_session() as execution_session:
                    await execute_rescore(
                        run_id=run_id,
                        source_run_id=params["source_run_id"],
                        active_metrics=list(params.get("active_metrics") or []),
                        judge_model=judge_model,
                        created_by=params.get("created_by") or "system",
                        source_evidence_snapshot=params["source_evidence_snapshot"],
                        store=EvaluationStore(execution_session),
                        engine=get_evaluation_engine(),
                    )
            elif params.get("deferred_telemetry_score") or params.get(TELEMETRY_SCORE_SNAPSHOT_KEY):
                await _await_deferred_telemetry_score(run_id)
            else:
                async with async_session() as execution_session:
                    outcome = await execute_dataset_run(
                        run_id=run_id,
                        dataset_name=dataset_name,
                        tenant_id=tenant_id,
                        response_source=response_source,
                        agent=agent,
                        row_count=row_count,
                        judge_model=judge_model,
                        target_endpoint=params.get("target_endpoint"),
                        target_model=params.get("target_model"),
                        system_prompt=params.get("system_prompt"),
                        prompt_version_ref=params.get("prompt_version_ref"),
                        active_metrics=params.get("active_metrics"),
                        resolved_active_metrics=params.get("resolved_active_metrics"),
                        resolved_scoring_configuration=params.get("resolved_scoring_configuration"),
                        enable_llm_judge=bool(params.get("enable_llm_judge", True)),
                        parallel_requests=int(params.get("parallel_requests", 5)),
                        run_human_review=bool(params.get("run_human_review", True)),
                        quality_contract_ids=params.get("quality_contract_ids") or [],
                        store=EvaluationStore(execution_session),
                        engine=get_evaluation_engine(),
                        registry=registry,
                        trigger_reason=TriggerReason(params.get("trigger_reason", TriggerReason.MANUAL.value)),
                        correlation_id=params.get("correlation_id") or run_id,
                        label=params.get("label") or params.get("name"),
                        labels=params.get("labels"),
                        evaluation_name=params.get("evaluation_name"),
                        evaluation_scope=EvaluationScope(params.get("evaluation_scope", EvaluationScope.FINAL_RESPONSE.value)),
                        evidence_readiness_snapshot=params.get("evidence_readiness"),
                        requested_provenance=params.get("requested_provenance") or {},
                        project_id=params.get("project_id"),
                        run_manifest_id=params.get("run_manifest_id"),
                        assignment_id=params.get("assignment_id"),
                        assignment_version=params.get("assignment_version"),
                    )
                if outcome == DATASET_RUN_DEFERRED:
                    await _await_deferred_telemetry_score(run_id)
        async with async_session() as complete_session:
            await EvaluationStore(complete_session).complete_run_job(run_id)
    except ReadinessBlockedError as exc:
        async with async_session() as blocked_session:
            await EvaluationStore(blocked_session).block_run_job(
                run_id,
                str(exc),
                exc.readiness.model_dump(mode="json"),
            )
    except RunCancelledError:
        logger.info("proofgrove: Temporal job %s stopped before results were persisted", run_id)
    except ApplicationError:
        raise
    except Exception as exc:
        # The job stays RUNNING: marking it FAILED here made every later
        # Temporal attempt unclaimable, so ``RetryPolicy(maximum_attempts=3)``
        # never retried anything. The workflow marks the job failed once the
        # retry policy is exhausted (``fail_dataset_run_job``); until then a
        # retry re-claims the RUNNING row. Live target invocations are still
        # refused a second attempt by the interrupted-run guard above.
        raise application_error_for(exc, run_id) from None
    finally:
        await _stop_cancellation_watch(cancellation_watch)


def application_error_for(exc: BaseException, run_id: str) -> ApplicationError:
    """The only form in which a worker exception may reach Temporal.

    Temporal's failure converter serializes the whole ``__cause__`` chain into
    workflow history, so the sanitized message must not be raised ``from`` the
    original exception -- callers raise the result ``from None``.
    """
    logger.error("proofgrove: Temporal job %s attempt failed", run_id, extra={"error_type": type(exc).__name__})
    return ApplicationError(_job_error_message(exc), type=type(exc).__name__)


async def fail_run_job(run_id: str, message: str) -> None:
    """Record a terminal failure for a job whose durable retries are exhausted.

    Compare-and-set in the store: a job that completed, was blocked or was
    cancelled in the meantime keeps that state.
    """
    async with async_session() as session:
        await EvaluationStore(session).fail_run_job(run_id, message)


async def _run_owned_worker(stop: asyncio.Event, poll_interval_seconds: float) -> None:
    """Poll for pending run jobs until ``stop`` is set."""

    # Exclusive ownership proves the previous compatibility executor is gone.
    # Recover fresh interrupted jobs too; no later reclaim pass runs here.
    async with async_session() as session:
        reclaimed = await EvaluationStore(session).reclaim_running_jobs(stale_after_seconds=0)
        logger.info("proofgrove: worker acquired ownership; recovered %d interrupted jobs", reclaimed)
    logger.info("proofgrove: run worker started")
    while not stop.is_set():
        try:
            iteration = asyncio.create_task(
                process_one_job(register_active=True),
                name="proofgrove-run-worker-iteration",
            )
            processed = await iteration
        except asyncio.CancelledError:
            # A stop request cancels the child iteration but not the durable
            # worker loop. Cancellation of this worker task itself must still
            # propagate during application shutdown.
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                raise
            processed = True
        except Exception as exc:  # noqa: BLE001 — never let the loop die
            logger.error('proofgrove: run worker iteration failed', extra={'error_type': type(exc).__name__})
            processed = False
        if not processed:
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll_interval_seconds)
            except TimeoutError:
                pass  # Poll interval elapsed; check for new work or a stop request.
    logger.info("proofgrove: run worker stopped")


async def run_worker_loop(stop: asyncio.Event, poll_interval_seconds: float = 3.0) -> None:
    """Keep one compatibility executor per database; standbys retry on failover."""
    engine = async_engine()
    if engine.dialect.name == "sqlite":
        # SQLite is a single-process development backend.
        await _run_owned_worker(stop, poll_interval_seconds)
        return
    if engine.dialect.name != "postgresql":
        raise RuntimeError("Compatibility worker ownership requires PostgreSQL")
    # ponytail: one executor per database; use the existing Temporal runtime for parallel execution.
    while not stop.is_set():
        try:
            async with engine.connect() as connection:
                async with connection.begin():
                    # The transaction releases ownership even on process/connection loss.
                    acquired = await connection.scalar(text("SELECT pg_try_advisory_xact_lock(1129271892, 1)"))
                    if acquired:
                        worker = asyncio.create_task(_run_owned_worker(stop, poll_interval_seconds))
                        try:
                            while not worker.done():
                                await asyncio.wait({worker}, timeout=poll_interval_seconds)
                                if not worker.done():
                                    # Do not continue executing after losing the ownership connection.
                                    await asyncio.wait_for(connection.execute(text("SELECT 1")), timeout=5.0)
                            await worker
                        finally:
                            if not worker.done():
                                worker.cancel()
                            await asyncio.gather(worker, return_exceptions=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error('proofgrove: compatibility worker ownership lost or unavailable', extra={'error_type': type(exc).__name__})
        if not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll_interval_seconds)
            except TimeoutError:
                pass  # Poll interval elapsed; check for new work or a stop request.
