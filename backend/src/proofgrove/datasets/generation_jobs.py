"""Durable dataset-generation jobs — the datasets store's own job table.

Generation used to be observable only through the shared ``run_jobs`` queue;
this module gives the datasets slice its own durable job record so the UI can
watch, cancel, and resume watching a generation across page navigations, and
so an interrupted process leaves an honest ``failed``/"interrupted" trail
instead of a job stuck in limbo.

Schema management follows ``SqlDatasetStore``: the table is created idempotently
via ``Base.metadata.create_all(..., checkfirst=True)`` at store construction
(the datasets store's own DDL bootstrap — deliberately not Alembic-managed here).

Phase model (all transitions are compare-and-set so a landed cancel or a
terminal phase is never overwritten by a late worker write)::

    queued → generating → validating → completed
       └──────────┴────→ cancelled
       └──────────┴────────────┴─────→ failed
"""

from __future__ import annotations

import enum
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import JSON, DateTime, Integer, String, Text, select, update
from sqlalchemy.orm import Mapped, mapped_column

from proofgrove.db.session import Base, sync_engine, sync_sessionmaker
from proofgrove.platform.authz import tenant_id_candidates

logger = logging.getLogger(__name__)

#: A job untouched this long, still in an active phase at process start, is
#: presumed abandoned by a dead worker in THIS process — not one a live
#: sibling replica is still updating. Mirrors the store's
#: ``reclaim_running_jobs`` staleness heuristic (same ponytail note applies:
#: an updated_at-age proxy, not a real worker lease/owner column).
_INTERRUPTED_STALE_AFTER_SECONDS = 900.0


class GenerationJobPhase(enum.StrEnum):
    """Lifecycle phase of a dataset-generation job."""

    QUEUED = "queued"
    GENERATING = "generating"
    VALIDATING = "validating"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


#: Phases a job can still move out of (cancel / interruption apply here only).
ACTIVE_PHASES: frozenset[GenerationJobPhase] = frozenset(
    {
        GenerationJobPhase.QUEUED,
        GenerationJobPhase.GENERATING,
        GenerationJobPhase.VALIDATING,
    }
)

#: Phases that end a job — durable and never overwritten.
TERMINAL_PHASES: frozenset[GenerationJobPhase] = frozenset(
    {
        GenerationJobPhase.COMPLETED,
        GenerationJobPhase.FAILED,
        GenerationJobPhase.CANCELLED,
    }
)

#: Honest reason recorded when a process restart loses an in-flight job.
INTERRUPTED_ERROR = "interrupted"


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(UTC)


class DatasetGenerationJobORM(Base):
    """One durable dataset-generation job (datasets-slice owned table)."""

    __tablename__ = "dataset_generation_jobs"

    job_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(String(128), index=True)
    dataset_name: Mapped[str] = mapped_column(String(256))
    phase: Mapped[str] = mapped_column(String(32), default=GenerationJobPhase.QUEUED.value)
    progress_done: Mapped[int | None] = mapped_column(Integer, nullable=True)
    progress_total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    result_dataset_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


def _serialize(orm: DatasetGenerationJobORM) -> dict[str, Any]:
    """Public job shape: progress only appears when it is honestly known."""
    progress: dict[str, int] | None = None
    if orm.progress_done is not None or orm.progress_total is not None:
        progress = {
            "done": orm.progress_done if orm.progress_done is not None else 0,
            "total": orm.progress_total if orm.progress_total is not None else 0,
        }
    return {
        "job_id": orm.job_id,
        "tenant": orm.tenant_id,
        "dataset_name": orm.dataset_name,
        "phase": orm.phase,
        "progress": progress,
        "error": orm.error,
        "result_dataset_name": orm.result_dataset_name,
        "created_at": orm.created_at.isoformat() if orm.created_at else None,
        "updated_at": orm.updated_at.isoformat() if orm.updated_at else None,
        "params": orm.params or {},
    }


class GenerationJobStore:
    """Synchronous SQLAlchemy store for dataset-generation jobs.

    Mirrors ``SqlDatasetStore``: blocking engine, idempotent table bootstrap at
    construction, dict-shaped results for the API layer.
    """

    def __init__(self) -> None:
        Base.metadata.create_all(
            sync_engine(),
            tables=[DatasetGenerationJobORM.__table__],
            checkfirst=True,
        )
        self._sessionmaker = sync_sessionmaker()

    # ------------------------------------------------------------------
    # Create / read
    # ------------------------------------------------------------------

    def create_job(
        self,
        *,
        tenant_id: str,
        dataset_name: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Persist a new QUEUED job and return its public shape."""
        with self._sessionmaker() as session:
            orm = DatasetGenerationJobORM(
                tenant_id=tenant_id,
                dataset_name=dataset_name,
                params=params or {},
            )
            session.add(orm)
            session.commit()
            session.refresh(orm)
            logger.info(
                "dataset-generation job %s created (dataset=%s tenant=%s)",
                orm.job_id,
                dataset_name,
                tenant_id,
            )
            return _serialize(orm)

    def get_job(self, job_id: str, tenant_id: str | None = None) -> dict[str, Any] | None:
        """Read one job. ``tenant_id``, when given, scopes the read in the WHERE
        clause — a route-facing caller must pass it so a foreign tenant's job
        id resolves to "not found" rather than being readable by guess.
        Internal worker call sites (which minted the id themselves) may omit
        it.
        """
        with self._sessionmaker() as session:
            if tenant_id is not None:
                stmt = select(DatasetGenerationJobORM).where(
                    DatasetGenerationJobORM.job_id == job_id,
                    DatasetGenerationJobORM.tenant_id.in_(tenant_id_candidates(tenant_id)),
                )
                orm = session.execute(stmt).scalar_one_or_none()
            else:
                orm = session.get(DatasetGenerationJobORM, job_id)
            return _serialize(orm) if orm is not None else None

    # ------------------------------------------------------------------
    # Transitions (compare-and-set)
    # ------------------------------------------------------------------

    def advance(
        self,
        job_id: str,
        *,
        from_phases: frozenset[GenerationJobPhase] | set[GenerationJobPhase],
        to_phase: GenerationJobPhase,
        tenant_id: str | None = None,
        error: str | None = None,
        progress_done: int | None = None,
        progress_total: int | None = None,
        result_dataset_name: str | None = None,
    ) -> bool:
        """Move a job to ``to_phase`` iff it is currently in ``from_phases``.

        Returns ``False`` (and changes nothing) when the job is missing, owned
        by a different tenant (when ``tenant_id`` is given), or the
        predecessor check fails — so a cancel that already landed, or a
        terminal phase, always wins over a late worker write.
        """
        values: dict[str, Any] = {"phase": to_phase.value, "updated_at": _now()}
        if error is not None:
            values["error"] = error
        if progress_done is not None:
            values["progress_done"] = progress_done
        if progress_total is not None:
            values["progress_total"] = progress_total
        if result_dataset_name is not None:
            values["result_dataset_name"] = result_dataset_name

        conditions = [
            DatasetGenerationJobORM.job_id == job_id,
            DatasetGenerationJobORM.phase.in_(p.value for p in from_phases),
        ]
        if tenant_id is not None:
            conditions.append(DatasetGenerationJobORM.tenant_id.in_(tenant_id_candidates(tenant_id)))

        with self._sessionmaker() as session:
            result = session.execute(update(DatasetGenerationJobORM).where(*conditions).values(**values))
            session.commit()
            return bool(result.rowcount)

    def touch(self, job_id: str) -> None:
        """Keep an owned task live without changing its phase or terminal state."""
        with self._sessionmaker() as session:
            session.execute(
                update(DatasetGenerationJobORM)
                .where(
                    DatasetGenerationJobORM.job_id == job_id,
                    DatasetGenerationJobORM.phase.in_(phase.value for phase in ACTIVE_PHASES),
                )
                .values(updated_at=_now())
            )
            session.commit()

    def request_cancel(self, job_id: str, tenant_id: str) -> dict[str, Any] | None:
        """Cancel queued/synthesizing work owned by ``tenant_id``.

        VALIDATING owns the registration commit and cannot be cancelled.
        Registration and terminal phases are returned untouched.

        Idempotent: cancelling an already-cancelled job simply returns it.
        Returns ``None`` for an unknown id OR a job owned by a different
        tenant — the two are indistinguishable to the caller, which is the
        point: both the cancelling UPDATE and the read-back are scoped by
        ``tenant_id`` in their WHERE clause.
        """
        self.advance(job_id, tenant_id=tenant_id, from_phases={GenerationJobPhase.QUEUED, GenerationJobPhase.GENERATING}, to_phase=GenerationJobPhase.CANCELLED)
        return self.get_job(job_id, tenant_id)

    def mark_interrupted(self, *, stale_after_seconds: float = _INTERRUPTED_STALE_AFTER_SECONDS) -> int:
        """Fail jobs still in an active phase and untouched since before this
        process started (process-restart sweep).

        A restarted process cannot resume a lost in-memory generation task, so
        the honest terminal state is ``failed`` with reason "interrupted" —
        but only for a job stale enough that it can't belong to a still-live
        sibling replica. Without the staleness bound, one replica's startup
        sweep would fail every active job across the whole tenant, including
        ones a peer replica is still actively generating.

        Returns the number of jobs swept.
        """
        cutoff = _now() - timedelta(seconds=stale_after_seconds)
        with self._sessionmaker() as session:
            result = session.execute(
                update(DatasetGenerationJobORM)
                .where(
                    DatasetGenerationJobORM.phase.in_(p.value for p in ACTIVE_PHASES),
                    DatasetGenerationJobORM.updated_at < cutoff,
                )
                .values(
                    phase=GenerationJobPhase.FAILED.value,
                    error=INTERRUPTED_ERROR,
                    updated_at=_now(),
                )
            )
            session.commit()
            swept = int(result.rowcount or 0)
            if swept:
                logger.warning(
                    "dataset-generation: marked %d interrupted job(s) as failed", swept
                )
            return swept
