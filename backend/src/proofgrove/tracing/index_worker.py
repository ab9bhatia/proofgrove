"""Background trace-index worker (lifespan task, mirrors the runs worker).

Each tick, bounded by settings:

1. Upserts index rows for evaluation run items that carry genuine trace ids
   (``is_evaluated=True``, lifecycle ``requested`` — nothing checked yet).
2. Scans the archive's ``trace-index/`` pointer prefix for trace ids not in the
   index — non-evaluation production traces — and records them
   (``is_evaluated=False``; Project resolved via TargetProjectBinding when
   resource attributes allow, else NULL = Unassigned).
3. Confirms unconfirmed rows against the archive: spans found →
   ``archive_confirmed`` plus real span statistics and bounded span summary
   rows, each classified by what the span did; nothing found →
   ``pending_export``; archive error → ``archive_unavailable`` and the tick
   keeps going.
4. Re-derives span rows for traces summarised by an older derivation, so a
   change to that derivation reaches already-indexed traces.

Idempotent and tenant-scoped; an archive outage never kills the loop.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from proofgrove.db.session import async_session_factory
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.trace_archive import tenant_from_namespace
from proofgrove.settings import settings
from proofgrove.tracing.archive_gateway import TraceArchiveGateway
from proofgrove.tracing.models import (
    TraceLifecycleState,
    span_index_rows_from_spans,
    trace_stats_from_spans,
)
from proofgrove.tracing.scoring import enqueue_automatic_span_checks

logger = logging.getLogger(__name__)


async def _resolve_project_id(store: EvaluationStore, tenant: str, target_id: str | None) -> str | None:
    """Project via TargetProjectBinding when resource attributes allow; else None."""
    if not target_id:
        return None
    binding = await store.get_target_project_binding(
        tenant_id=tenant,
        target_id=target_id,
        environment=settings.trace_archive_environment,
    )
    return binding.system_project_id if binding else None


async def _confirm_one(
    session_factory: Callable[[], Any],
    gateway: Any,
    tenant: str,
    archive_tenant: str,
    row: dict,
    now: datetime,
) -> str:
    """Check one index row against the archive; returns the resulting state."""
    trace_id = row["trace_id"]
    try:
        evidence = await gateway.find(
            trace_id=trace_id,
            tenant=archive_tenant,
            started_at=row.get("started_at"),
            completed_at=row.get("created_at") or now,
        )
    except Exception as exc:  # noqa: BLE001 — archive down must not kill the tick
        logger.warning('trace-index: archive check failed for trace %s', trace_id, extra={'error_type': type(exc).__name__})
        async with session_factory() as session:
            await EvaluationStore(session).mark_trace_index_checked(tenant, trace_id, TraceLifecycleState.ARCHIVE_UNAVAILABLE.value, checked_at=now)
        return TraceLifecycleState.ARCHIVE_UNAVAILABLE.value

    if evidence.state == "available" and evidence.spans:
        # A truncated read is a partial view of the trace, not a smaller trace.
        # span_count counts AI operations, not raw archive rows.
        # On first index it is still better than nothing, but during a rebuild
        # sweep it must never replace a fuller summary: an archive object that
        # has since crossed the size cap would otherwise delete good span rows
        # and rewrite span_count/error_count/duration from the fragment that
        # survived the read. Leaving the revision unstamped keeps the trace
        # queued so a later, complete read can still derive it.
        if evidence.truncated and row.get("span_count") is not None:
            logger.info(
                "trace-index: keeping %d indexed spans for trace %s; archive re-read was truncated to %d",
                row.get("span_count") or 0,
                trace_id,
                len(evidence.spans),
            )
            return TraceLifecycleState.ARCHIVE_CONFIRMED.value

        stats = trace_stats_from_spans(evidence.spans)
        project_id = row.get("project_id")
        if project_id is None:
            async with session_factory() as session:
                project_id = await _resolve_project_id(EvaluationStore(session), tenant, stats.target_id)
        if project_id:
            async with session_factory() as session:
                store = EvaluationStore(session)
                sources = await store.list_automatic_span_scoring_sources(tenant_id=tenant, project_id=project_id, trace_id=trace_id)
                for source in sources:
                    await enqueue_automatic_span_checks(store=store, tenant_id=tenant, project_id=project_id, run_id=source.run_id, spans=evidence.spans)
        async with session_factory() as session:
            await EvaluationStore(session).confirm_trace_index_row(
                tenant,
                trace_id,
                project_id=project_id,
                root_span_name=stats.root_span_name,
                root_span_kind=stats.root_span_kind,
                span_count=stats.span_count,
                error_count=stats.error_count,
                model=stats.model,
                started_at=stats.started_at,
                duration_ms=stats.duration_ms,
                estimated_cost_usd=stats.estimated_cost_usd,
                span_rows=span_index_rows_from_spans(evidence.spans, limit=settings.trace_index_max_spans_per_trace),
                checked_at=now,
            )
        return TraceLifecycleState.ARCHIVE_CONFIRMED.value

    if evidence.state == "not_configured":
        # Nothing was checked; the honest state is unchanged (requested).
        return TraceLifecycleState.REQUESTED.value

    async with session_factory() as session:
        await EvaluationStore(session).mark_trace_index_checked(tenant, trace_id, TraceLifecycleState.PENDING_EXPORT.value, checked_at=now)
    return TraceLifecycleState.PENDING_EXPORT.value


async def run_trace_index_tick(
    *,
    tenant: str,
    gateway: Any | None = None,
    session_factory: Callable[[], Any] | None = None,
    now: datetime | None = None,
) -> dict[str, int]:
    """One bounded, idempotent pass; returns per-step counters."""
    now = now or datetime.now(UTC)
    session_factory = session_factory or async_session_factory()
    gateway = gateway or TraceArchiveGateway(settings)
    counts = {
        "upserted": 0,
        "discovered": 0,
        "confirmed": 0,
        "backfilled": 0,
        "pending": 0,
        "unavailable": 0,
    }
    archive_tenant = tenant_from_namespace(tenant)

    async with session_factory() as session:
        counts["upserted"] = await EvaluationStore(session).upsert_requested_traces_from_run_items(tenant, limit=settings.trace_index_upsert_batch_size)

    if not settings.trace_archive_enabled:
        return counts

    try:
        archived_ids = await gateway.list_archived_trace_ids(archive_tenant, limit=settings.trace_index_discovery_max_traces)
    except Exception as exc:  # noqa: BLE001 — discovery failure must not kill the tick
        logger.warning('trace-index: archive discovery scan failed', extra={'error_type': type(exc).__name__})
        archived_ids = []
    if archived_ids:
        async with session_factory() as session:
            counts["discovered"] = await EvaluationStore(session).insert_discovered_traces(tenant, archived_ids, created_at=now)

    async with session_factory() as session:
        rows = await EvaluationStore(session).list_trace_index_rows_to_check(
            tenant,
            limit=settings.trace_index_confirm_batch_size,
            pending_recheck_cutoff=now - timedelta(seconds=settings.trace_index_pending_grace_seconds),
        )
    for row in rows:
        # Contain EVERY per-row failure (malformed span timestamps, a per-trace
        # DB error, …), not just archive lookups — one bad trace must never
        # starve the rest of the ordered batch. The row is recorded as
        # unavailable so the grace window still governs its rechecks.
        try:
            state = await _confirm_one(session_factory, gateway, tenant, archive_tenant, row, now)
        except Exception as exc:  # noqa: BLE001 — per-row containment by design
            logger.warning('trace-index: confirming trace %s failed', row.get('trace_id'), extra={'error_type': type(exc).__name__})
            state = TraceLifecycleState.ARCHIVE_UNAVAILABLE.value
            try:
                async with session_factory() as session:
                    await EvaluationStore(session).mark_trace_index_checked(tenant, row["trace_id"], state, checked_at=now)
            except Exception as bookkeeping_error:  # noqa: BLE001 — even the bookkeeping must not kill the tick
                logger.warning('trace-index: recording failure state for %s failed', row.get('trace_id'), extra={'error_type': type(bookkeeping_error).__name__})
        if state == TraceLifecycleState.ARCHIVE_CONFIRMED.value:
            counts["confirmed"] += 1
        elif state == TraceLifecycleState.PENDING_EXPORT.value:
            counts["pending"] += 1
        elif state == TraceLifecycleState.ARCHIVE_UNAVAILABLE.value:
            counts["unavailable"] += 1

    async with session_factory() as session:
        backfill_rows = await EvaluationStore(session).list_trace_rows_needing_span_rebuild(tenant, limit=settings.trace_index_confirm_batch_size)
    for row in backfill_rows:
        try:
            state = await _confirm_one(session_factory, gateway, tenant, archive_tenant, row, now)
        except Exception as exc:  # noqa: BLE001 — retry the idempotent backfill next tick
            logger.warning('trace-index: backfilling trace %s failed', row.get('trace_id'), extra={'error_type': type(exc).__name__})
            continue
        if state == TraceLifecycleState.ARCHIVE_CONFIRMED.value:
            counts["backfilled"] += 1
    return counts


async def trace_index_worker_loop(stop: asyncio.Event, interval_seconds: float | None = None) -> None:
    """Poll until ``stop`` is set; a failing tick never kills the loop."""
    interval = interval_seconds or settings.trace_index_interval_seconds
    tenant = settings.pod_namespace or "platform"
    logger.info("proofgrove: trace index worker started (tenant=%s)", tenant)
    while not stop.is_set():
        # Wait first: startup is the busiest moment (seeding, reclaims, first
        # requests) and the index is a background projection — nothing depends
        # on it being warm within the first interval.
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except TimeoutError:
            pass  # Poll interval elapsed; check for new work or a stop request.
        if stop.is_set():
            break
        try:
            await run_trace_index_tick(tenant=tenant)
        except Exception as exc:  # noqa: BLE001 — never let the loop die
            logger.error('proofgrove: trace index tick failed', extra={'error_type': type(exc).__name__})
    logger.info("proofgrove: trace index worker stopped")
