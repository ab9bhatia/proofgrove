"""SQLAlchemy-backed dataset storage — records + governance in one database.

Records follow the record schema (``inputs`` / ``expectations`` / ``tags``);
governance metadata (tenant, product, lifecycle, DQS, lineage) lives alongside
them in the shared Eval Hub relational database.

The Golden Dataset Registry service is synchronous, so this client uses a
blocking SQLAlchemy engine (see ``evalhub.db.session.sync_engine``). Each
mutating call appends a row to ``golden_dataset_version_events`` to provide an
append-only version history. The concrete database product is selected by
``DATABASE_URL`` / ``DATABASE_BACKEND``.
"""

import hashlib
import json
import logging
from collections.abc import Sequence
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, func, select, tuple_
from sqlalchemy.exc import IntegrityError, MultipleResultsFound
from sqlalchemy.orm import Session

from evalhub.datasets.enums import ChangeReason, DatasetStatus
from evalhub.datasets.exceptions import (
    DatasetError,
    DatasetImmutableError,
    DatasetNotFoundError,
    DatasetValidationError,
)
from evalhub.datasets.models import MAX_ROWS_PER_DATASET, DatasetMetadata
from evalhub.datasets.versioning import assert_branchable, assert_mutable
from evalhub.db.models import (
    GoldenDatasetORM,
    GoldenDatasetRecordORM,
    GoldenDatasetVersionEventORM,
)
from evalhub.db.session import Base, sync_engine, sync_sessionmaker
from evalhub.platform.authz import tenant_id_candidates
from evalhub.settings import settings

logger = logging.getLogger(__name__)


@dataclass
class _DatasetHandle:
    """Lightweight handle for a dataset (id + name)."""

    dataset_id: str
    name: str


def _record_id(inputs: dict[str, Any]) -> str:
    """Stable id derived from inputs so re-merging upserts the same row."""
    canonical = json.dumps(inputs, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()[:64]


#: Expectation keys the scorer probes for declared tool actions, mirroring
#: ``dataset_bridge._EXPECTED_ACTION_KEYS``. A write clears all of them and
#: stores only the canonical one, so no alias can contradict what was written.
_ACTION_KEYS = ("expected_actions", "expected_tool_calls", "actions")


def expectations_with_expected_tools(
    expectations: dict[str, Any], tools: list[str]
) -> dict[str, Any]:
    """Public form of the canonical expected-tools write, for builders that
    must produce exactly the shape the scorer reads."""
    return _with_expected_tools(expectations, tools)


def record_id_for_inputs(inputs: dict[str, Any]) -> str:
    """Public form of the stable record id, for callers that must know the
    row a record will land on before (or without) writing it."""
    return _record_id(inputs)


def _with_expected_tools(
    expectations: dict[str, Any] | None, tools: list[str]
) -> dict[str, Any]:
    """Return expectations with every action alias replaced by ``tools``.

    Clearing all aliases before writing the canonical key is what stops a stale
    ``expected_tool_calls`` from contradicting — or outliving — the write.
    """
    result = dict(expectations or {})
    for key in _ACTION_KEYS:
        result.pop(key, None)
    value = ";".join(tools)
    if value:
        result["expected_actions"] = value
    return result



def _get_dataset_row(
    session: Session,
    dataset_name: str,
    tenant_id: str | None,
    *,
    with_for_update: bool = False,
) -> GoldenDatasetORM | None:
    """Fetch a dataset row scoped to ``tenant_id``.

    Every by-name read/mutate path used to look the row up by
    ``dataset_name`` alone (the primary key), which meant any caller who
    knew -- or guessed -- another tenant's dataset name could read or
    mutate it through the store, regardless of what the request-level authz
    layer had already checked. ``tenant_id`` is now a required argument
    everywhere this store resolves a dataset by name, so a wrong-tenant
    dataset reads back exactly like one that doesn't exist.

    ``tenant_id=None`` is an explicit, narrow escape hatch: the async run
    worker (``evalhub.runs_worker``) does not yet carry a caller tenant
    through its job pipeline end-to-end, so it passes ``None`` to mean
    "no tenant to check against" rather than silently defaulting to it.
    # ponytail: full tenant plumbing through the run-job pipeline is a
    # separate, larger change; None keeps that gap visible instead of
    # inventing a tenant value that doesn't exist yet.

    Composite identity is ``(tenant_id, dataset_name)``, so a name can be
    owned by more than one tenant. An unscoped (``tenant_id=None``) lookup
    that hits more than one owner has no way to pick the right one, so it
    fails as a dataset-level ``DatasetError`` rather than either leaking
    SQLAlchemy's raw ``MultipleResultsFound`` or silently merging rows from
    every owner. A single owner still resolves unchanged.
    """
    stmt = select(GoldenDatasetORM).where(GoldenDatasetORM.dataset_name == dataset_name)
    if tenant_id is not None:
        stmt = stmt.where(GoldenDatasetORM.tenant_id.in_(tenant_id_candidates(tenant_id)))
    if with_for_update:
        stmt = stmt.with_for_update()
    try:
        return session.scalars(stmt).one_or_none()
    except MultipleResultsFound as exc:
        raise DatasetError(
            f"Dataset name '{dataset_name}' is ambiguous without tenant scope "
            "(owned by more than one tenant)"
        ) from exc


def _record_sort_key(record: Any) -> tuple[int, int, str]:
    """Order records by the author's serial number, then by insertion.

    Records without a usable serial number sort after the ones that have one,
    keeping their own relative order, so a partially-numbered dataset never
    interleaves the two.
    """
    tags = record.tags or {}
    for key in ("serial_no", "Serial No", "serialNo"):
        raw = tags.get(key)
        if raw is None:
            continue
        digits = "".join(character for character in str(raw) if character.isdigit())
        if digits:
            return (0, int(digits), record.dataset_record_id or "")
    return (1, 0, record.dataset_record_id or "")


class SqlDatasetStore:
    """Synchronous SQLAlchemy store for golden datasets (records + governance).

    Implements the storage contract expected by ``DatasetRegistryService``:
    ``create_dataset``, ``get_dataset``, ``get_metadata``, ``merge_records``,
    ``get_records``, ``sample_records_by_dataset``, ``delete_records``,
    ``delete_dataset``, ``update_status``, ``search_datasets`` and
    ``get_version_history``.
    """

    def __init__(self) -> None:
        # Mirrors evalhub.db.session.init_db's gate: production schema is
        # owned by Alembic, so a production API pod must not race another
        # replica with implicit DDL. Dev/test (and any deployment that opts
        # in via DATABASE_AUTO_CREATE) still get idempotent create_all here,
        # which covers standalone/script usage the async init_db never runs.
        if settings.app_env in {"dev", "test"} or settings.database_auto_create:
            Base.metadata.create_all(
                sync_engine(),
                tables=[
                    GoldenDatasetORM.__table__,
                    GoldenDatasetRecordORM.__table__,
                    GoldenDatasetVersionEventORM.__table__,
                ],
                checkfirst=True,
            )
        self._sessionmaker = sync_sessionmaker()

    # ------------------------------------------------------------------
    # Dataset lifecycle
    # ------------------------------------------------------------------

    def create_dataset(self, dataset_name: str, metadata: DatasetMetadata, records: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        """Create a new dataset row and seed its version history."""
        with self._sessionmaker() as session:
            existing = session.scalars(
                select(GoldenDatasetORM).where(
                    GoldenDatasetORM.dataset_name == dataset_name,
                    GoldenDatasetORM.tenant_id.in_(tenant_id_candidates(metadata.tenant_id)),
                )
            ).one_or_none()
            if existing is not None:
                raise DatasetError(f"Dataset '{dataset_name}' already exists")

            orm = GoldenDatasetORM(
                dataset_name=dataset_name,
                tenant_id=metadata.tenant_id,
                product_id=metadata.product_id,
                status=metadata.status.value,
                version_number=metadata.version_number,
                parent_dataset_name=metadata.parent_dataset_name,
                dqs=metadata.dqs,
                change_reason=metadata.change_reason.value if metadata.change_reason else None,
                created_by=metadata.created_by,
            )
            session.add(orm)
            try:
                session.flush()
            except IntegrityError:
                # Two creates raced past the existence check above; the
                # composite (tenant_id, dataset_name) key let exactly one in.
                # Re-read before translating so only that violation reads as
                # "already exists" -- any other constraint failure stays an
                # internal error.
                session.rollback()
                if _get_dataset_row(session, dataset_name, metadata.tenant_id) is not None:
                    raise DatasetError(f"Dataset '{dataset_name}' already exists") from None
                raise
            initial_records = {_record_id(record.get("inputs", {})): record for record in (records or [])}
            dropped = len(records or []) - len(initial_records)
            if dropped > 0:
                # Same-hash records collapse silently into the dict above (last
                # write wins); report the count rather than the return shape,
                # which is a plain {dataset_id, name} consumed by key elsewhere.
                logger.warning("create_dataset(%s): %d duplicate-input record(s) dropped", dataset_name, dropped)
            if len(initial_records) > MAX_ROWS_PER_DATASET:
                raise DatasetValidationError(f"Dataset exceeds {MAX_ROWS_PER_DATASET} records")
            for rid, record in initial_records.items():
                session.add(
                    GoldenDatasetRecordORM(
                        dataset_record_id=rid,
                        tenant_id=metadata.tenant_id,
                        dataset_name=dataset_name,
                        inputs=record.get("inputs", {}),
                        expectations=record.get("expectations", {}),
                        tags=record.get("tags", {}),
                    )
                )
            session.add(
                GoldenDatasetVersionEventORM(
                    tenant_id=metadata.tenant_id,
                    dataset_name=dataset_name,
                    version=metadata.version_number,
                    operation="CREATE",
                    num_records=len(initial_records),
                    actor=metadata.created_by,
                )
            )
            session.commit()
            logger.info("Created dataset %s (id=%s)", dataset_name, orm.dataset_id)
            return {"dataset_id": orm.dataset_id, "name": orm.dataset_name}

    def clone_dataset(
        self,
        source_dataset_name: str,
        tenant_id: str | None,
        new_dataset_name: str,
        metadata: DatasetMetadata,
        annotate_record_ids: list[str] | None = None,
        annotate_tools: list[str] | None = None,
        append_records: list[dict[str, Any]] | None = None,
        require_branchable: bool = False,
    ) -> dict[str, Any]:
        """Atomically create a dataset version and copy all source records.

        When ``annotate_record_ids`` is given, the named copies are annotated
        with ``annotate_tools`` inside the same transaction. Branch-then-annotate
        as two commits would leave an unannotated draft version behind whenever
        the second one failed, so the caller reporting failure would still have
        mutated the lineage.

        ``require_branchable`` re-asserts the lifecycle guard inside this
        transaction, for callers whose status read happened in an earlier one.
        ``restore_as_draft`` passes it False on purpose: restoring a RETIRED
        dataset is exactly the action the guard reserves to the lifecycle.

        ``append_records`` are upserted into the new version in that same
        transaction: a record whose inputs hash to an already-copied row
        overwrites that copy's expectations/tags (reported in ``duplicates``),
        anything else is a new row. ``record_count`` and the RESTORE event keep
        counting copied source rows only; ``appended`` counts the extras.
        """
        with self._sessionmaker() as session:
            source = _get_dataset_row(session, source_dataset_name, tenant_id)
            if source is None:
                raise DatasetNotFoundError(f"Dataset '{source_dataset_name}' not found")
            # The caller checked the source status in an earlier transaction; a
            # lifecycle transition can land in between, so the copy re-asserts
            # it against the row it is actually reading. Opt-in, because
            # ``restore_as_draft`` legitimately copies a RETIRED dataset — that
            # is the lifecycle action this guard exists to keep exclusive.
            if require_branchable:
                assert_branchable(DatasetStatus(source.status), source_dataset_name)
            if session.scalars(
                select(GoldenDatasetORM).where(
                    GoldenDatasetORM.dataset_name == new_dataset_name,
                    GoldenDatasetORM.tenant_id.in_(tenant_id_candidates(metadata.tenant_id)),
                )
            ).one_or_none() is not None:
                raise DatasetError(f"Dataset '{new_dataset_name}' already exists")

            try:
                return self._clone_into(session, source, new_dataset_name, metadata, annotate_record_ids, annotate_tools, append_records)
            except IntegrityError:
                # Two clones raced past the existence check above; only a
                # violation of the dataset key reads as "already exists".
                session.rollback()
                if _get_dataset_row(session, new_dataset_name, metadata.tenant_id) is not None:
                    raise DatasetError(f"Dataset '{new_dataset_name}' already exists") from None
                raise

    def _clone_into(
        self,
        session: Session,
        source: GoldenDatasetORM,
        new_dataset_name: str,
        metadata: DatasetMetadata,
        annotate_record_ids: list[str] | None,
        annotate_tools: list[str] | None,
        append_records: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        """The body of ``clone_dataset`` after its guards, in the caller's transaction."""
        restored = GoldenDatasetORM(
            dataset_name=new_dataset_name,
            tenant_id=metadata.tenant_id,
            product_id=metadata.product_id,
            status=metadata.status.value,
            version_number=metadata.version_number,
            parent_dataset_name=metadata.parent_dataset_name,
            dqs=metadata.dqs,
            change_reason=metadata.change_reason.value if metadata.change_reason else None,
            created_by=metadata.created_by,
        )
        session.add(restored)
        source_records = session.scalars(
            select(GoldenDatasetRecordORM).where(
                GoldenDatasetRecordORM.tenant_id == source.tenant_id,
                GoldenDatasetRecordORM.dataset_name == source.dataset_name,
            )
        ).all()
        annotate_ids = set(annotate_record_ids or ())
        annotated = 0
        copied: dict[str, GoldenDatasetRecordORM] = {}
        for record in source_records:
            expectations = deepcopy(record.expectations)
            if record.dataset_record_id in annotate_ids:
                expectations = _with_expected_tools(expectations, annotate_tools or [])
                annotated += 1
            copy = GoldenDatasetRecordORM(
                dataset_record_id=record.dataset_record_id,
                tenant_id=source.tenant_id,
                dataset_name=new_dataset_name,
                inputs=deepcopy(record.inputs),
                expectations=expectations,
                tags=deepcopy(record.tags),
            )
            copied[record.dataset_record_id] = copy
            session.add(copy)
        appended = 0
        duplicates: list[str] = []
        total = len(copied)
        for rec in append_records or []:
            # Copies are pending, not flushed — session.get would miss them,
            # so dedupe against the in-loop map instead.
            rid = _record_id(rec.get("inputs", {}))
            existing = copied.get(rid)
            if existing is not None:
                existing.expectations = rec.get("expectations", {})
                existing.tags = rec.get("tags", {})
                duplicates.append(rid)
                continue
            total += 1
            if total > MAX_ROWS_PER_DATASET:
                raise DatasetValidationError(f"Dataset '{new_dataset_name}' would exceed {MAX_ROWS_PER_DATASET} records")
            copy = GoldenDatasetRecordORM(
                dataset_record_id=rid,
                tenant_id=source.tenant_id,
                dataset_name=new_dataset_name,
                inputs=rec.get("inputs", {}),
                expectations=rec.get("expectations", {}),
                tags=rec.get("tags", {}),
            )
            copied[rid] = copy
            session.add(copy)
            appended += 1
        session.add(
            GoldenDatasetVersionEventORM(
                tenant_id=source.tenant_id,
                dataset_name=new_dataset_name,
                version=metadata.version_number,
                operation="RESTORE",
                num_records=len(source_records),
                actor=metadata.created_by,
            )
        )
        session.commit()
        logger.info(
            "Restored %s as %s with %d records",
            source.dataset_name,
            new_dataset_name,
            len(source_records),
        )
        return {
            "dataset_id": restored.dataset_id,
            "name": restored.dataset_name,
            "record_count": len(source_records),
            "annotated": annotated,
            "appended": appended,
            "duplicates": duplicates,
        }

    def get_dataset(self, dataset_name: str, tenant_id: str | None) -> _DatasetHandle:
        """Return a handle with the dataset id and name."""
        with self._sessionmaker() as session:
            orm = _get_dataset_row(session, dataset_name, tenant_id)
            if orm is None:
                raise DatasetNotFoundError(f"Dataset '{dataset_name}' not found")
            return _DatasetHandle(dataset_id=orm.dataset_id, name=orm.dataset_name)

    def get_metadata(self, dataset_name: str, tenant_id: str | None) -> DatasetMetadata:
        """Read governance metadata for a dataset."""
        with self._sessionmaker() as session:
            orm = _get_dataset_row(session, dataset_name, tenant_id)
            if orm is None:
                raise DatasetNotFoundError(f"No registry entry for '{dataset_name}'")
            return DatasetMetadata(
                tenant_id=orm.tenant_id,
                product_id=orm.product_id,
                status=DatasetStatus(orm.status),
                version_number=orm.version_number,
                parent_dataset_name=orm.parent_dataset_name,
                dqs=orm.dqs,
                change_reason=ChangeReason(orm.change_reason) if orm.change_reason else None,
                created_by=orm.created_by,
                # Read from the row, not defaulted. The model defaults both to
                # "now at construction", so omitting them made the single-dataset
                # read report every dataset as updated seconds ago — and report a
                # different time on every refresh — while the listing, which does
                # read the column, showed the truth.
                created_at=orm.created_at,
                updated_at=orm.updated_at,
            )

    def update_status(
        self,
        dataset_name: str,
        tenant_id: str | None,
        *,
        status: str,
        dqs: float | None = None,
        actor: str | None = None,
    ) -> None:
        """Update lifecycle status (and optionally DQS), recording who did it."""
        with self._sessionmaker() as session:
            orm = _get_dataset_row(session, dataset_name, tenant_id)
            if orm is None:
                raise DatasetNotFoundError(f"Dataset '{dataset_name}' not found")
            orm.status = status
            if dqs is not None:
                orm.dqs = dqs
            orm.updated_at = datetime.now(UTC)
            session.add(
                GoldenDatasetVersionEventORM(
                    tenant_id=orm.tenant_id,
                    dataset_name=dataset_name,
                    version=orm.version_number,
                    operation=f"STATUS:{status}",
                    num_records=0,
                    actor=actor,
                )
            )
            session.commit()
            logger.info("Updated %s → status=%s, dqs=%s", dataset_name, status, dqs)

    def delete_dataset(self, dataset_name: str, tenant_id: str | None) -> None:
        """Delete a DRAFT dataset and all its records + version events (cascade).

        The lifecycle guard is asserted here, on the locked row, not only in
        the registry: a publish that lands between the registry's metadata
        read and this transaction must make the delete fail, not silently
        remove immutable data. Same shape as ``merge_records``; SQLite ignores
        ``FOR UPDATE`` so the lock is PostgreSQL-only, the status re-check is not.
        """
        with self._sessionmaker() as session:
            orm = _get_dataset_row(session, dataset_name, tenant_id, with_for_update=True)
            if orm is None:
                return
            assert_mutable(DatasetStatus(orm.status))
            session.delete(orm)
            session.commit()
            logger.info("Deleted dataset %s", dataset_name)

    # ------------------------------------------------------------------
    # Records
    # ------------------------------------------------------------------

    def merge_records(self, dataset_name: str, tenant_id: str | None, records: list[dict[str, Any]], *, replace: bool = False, actor: str | None = None) -> int:
        """Upsert records, or atomically replace them, in a DRAFT dataset.

        ``MAX_ROWS_PER_DATASET`` is a per-dataset ceiling, not a per-batch one:
        the request models cap a single batch, but repeated merges could walk a
        dataset past the limit while promotion refused row N+1. The count is
        taken here under the same row lock the version bump needs (PostgreSQL
        only — SQLite ignores ``with_for_update``, so the guard is best-effort
        under SQLite's own locking there).
        """
        if not records and not replace:
            # No-op input: skip the dataset lock entirely and record no MERGE
            # version event — there is nothing to merge.
            return 0
        with self._sessionmaker() as session:
            ds = _get_dataset_row(session, dataset_name, tenant_id, with_for_update=True)
            if ds is None:
                raise DatasetNotFoundError(f"Dataset '{dataset_name}' not found")

            # The service-level check may predate a concurrent validation.
            assert_mutable(DatasetStatus(ds.status))
            total = session.scalar(select(func.count()).select_from(GoldenDatasetRecordORM).where(GoldenDatasetRecordORM.tenant_id == ds.tenant_id, GoldenDatasetRecordORM.dataset_name == dataset_name)) or 0
            first_write = total == 0 and ds.version_number == 1
            if replace:
                total = 0
                # Deletion, validation and insertion commit together. Any error
                # rolls back the old rows and their version/event history.
                session.execute(delete(GoldenDatasetRecordORM).where(
                    GoldenDatasetRecordORM.tenant_id == ds.tenant_id,
                    GoldenDatasetRecordORM.dataset_name == dataset_name,
                ))

            # One prefetch select instead of a per-record session.get — avoids
            # N round trips for a batch of N records.
            rids = [_record_id(rec.get("inputs", {})) for rec in records]
            existing_rows = session.scalars(
                select(GoldenDatasetRecordORM).where(
                    GoldenDatasetRecordORM.tenant_id == ds.tenant_id,
                    GoldenDatasetRecordORM.dataset_name == dataset_name,
                    GoldenDatasetRecordORM.dataset_record_id.in_(rids),
                )
            )
            existing_by_id = {row.dataset_record_id: row for row in existing_rows}

            for rec, rid in zip(records, rids):
                inputs = rec.get("inputs", {})
                existing = existing_by_id.get(rid)
                if existing is not None:
                    existing.expectations = rec.get("expectations", {})
                    existing.tags = rec.get("tags", {})
                else:
                    total += 1
                    if total > MAX_ROWS_PER_DATASET:
                        raise DatasetValidationError(f"Dataset '{dataset_name}' would exceed {MAX_ROWS_PER_DATASET} records")
                    new_row = GoldenDatasetRecordORM(
                        dataset_record_id=rid,
                        tenant_id=ds.tenant_id,
                        dataset_name=dataset_name,
                        inputs=inputs,
                        expectations=rec.get("expectations", {}),
                        tags=rec.get("tags", {}),
                    )
                    session.add(new_row)
                    # A repeated rid later in the same batch must update this
                    # row, matching the prior per-record session.get behavior.
                    existing_by_id[rid] = new_row

            if not first_write:
                ds.version_number += 1
            ds.updated_at = datetime.now(UTC)
            session.add(
                GoldenDatasetVersionEventORM(
                    tenant_id=ds.tenant_id,
                    dataset_name=dataset_name,
                    version=ds.version_number,
                    operation="REPLACE" if replace else "MERGE",
                    num_records=len(records),
                    actor=actor,
                )
            )
            session.commit()
            logger.info("Merged %d records into %s (total=%s)", len(records), dataset_name, total)
            return len(records)

    def upsert_record(
        self, dataset_name: str, tenant_id: str | None, record: dict[str, Any], operation: str = "PROMOTE"
    ) -> dict[str, Any]:
        """Upsert one record and report, atomically, whether it already existed.

        A separate exists-then-merge sequence can misreport under concurrent
        writers; here the duplicate answer comes from the same transaction that
        performs the write. New rows are refused once the dataset holds
        ``MAX_ROWS_PER_DATASET`` records; overwriting an existing row is always
        allowed.

        A concurrent writer that wins the insert is resolved as a duplicate
        rather than an error — but the retry re-runs the whole unit of work,
        including the status guard, the version bump and the append-only
        version event. Re-applying only the record content would mutate golden
        data with no audit entry, and could land on a dataset that was
        published between the two attempts.
        """
        for attempt in (1, 2):
            with self._sessionmaker() as session:
                ds = _get_dataset_row(session, dataset_name, tenant_id, with_for_update=True)
                if ds is None:
                    raise DatasetNotFoundError(f"Dataset '{dataset_name}' not found")
                if ds.status != DatasetStatus.DRAFT.value:
                    # The registry checks status before calling, but a lifecycle
                    # transition can land in between; the write itself must
                    # refuse — on the retry as much as the first attempt.
                    raise DatasetImmutableError(
                        f"Dataset '{dataset_name}' is {ds.status}; records are immutable"
                    )
                inputs = record.get("inputs", {})
                rid = _record_id(inputs)
                existing = session.get(GoldenDatasetRecordORM, (rid, ds.tenant_id, dataset_name))
                duplicate = existing is not None
                if existing is not None:
                    existing.expectations = record.get("expectations", {})
                    existing.tags = record.get("tags", {})
                else:
                    # The row lock above (with_for_update=True) serialises this
                    # count against other writers on PostgreSQL, so the ceiling
                    # cannot be overshot by a race; SQLite ignores FOR UPDATE
                    # (no row-level locking), so this guard is best-effort there.
                    count = session.scalar(
                        select(func.count())
                        .select_from(GoldenDatasetRecordORM)
                        .where(
                            GoldenDatasetRecordORM.tenant_id == ds.tenant_id,
                            GoldenDatasetRecordORM.dataset_name == dataset_name,
                        )
                    )
                    if (count or 0) >= MAX_ROWS_PER_DATASET:
                        raise DatasetValidationError(f"Dataset '{dataset_name}' already holds {MAX_ROWS_PER_DATASET} records")
                    session.add(
                        GoldenDatasetRecordORM(
                            dataset_record_id=rid,
                            tenant_id=ds.tenant_id,
                            dataset_name=dataset_name,
                            inputs=inputs,
                            expectations=record.get("expectations", {}),
                            tags=record.get("tags", {}),
                        )
                    )
                ds.version_number += 1
                ds.updated_at = datetime.now(UTC)
                session.add(
                    GoldenDatasetVersionEventORM(
                        tenant_id=ds.tenant_id,
                        dataset_name=dataset_name,
                        version=ds.version_number,
                        operation=operation,
                        num_records=1,
                    )
                )
                try:
                    session.commit()
                except IntegrityError:
                    session.rollback()
                    if attempt == 2:
                        raise
                    # A concurrent writer inserted this record id first. Retry
                    # the whole unit of work: the second pass sees the row and
                    # takes the duplicate branch, with its own guard, bump and
                    # event.
                    continue
                return {"record_id": rid, "duplicate": duplicate}
        raise DatasetError(f"Could not upsert a record into '{dataset_name}'")

    def get_records(
        self,
        dataset_name: str,
        tenant_id: str | None,
        *,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Return records for a dataset as record dicts.

        Unpaged by default (legacy callers get everything); pass ``limit`` /
        ``offset`` to fetch one stable page in insertion order.

        A ``tenant_id`` that does not own ``dataset_name`` reads back the same
        empty list an unknown ``dataset_name`` already did -- the join against
        ``golden_datasets`` below matches neither case, so the two stay
        indistinguishable rather than one going empty and the other 404ing.

        An unscoped call (``tenant_id=None``) first resolves the one owning
        dataset row via ``_get_dataset_row`` -- which raises a dataset-level
        error if the name is ambiguous across tenants -- and then scopes the
        record query to that resolved tenant. Without this, an unscoped read
        of an ambiguous name silently merged every owning tenant's rows.
        """
        with self._sessionmaker() as session:
            effective_tenant_id = tenant_id
            if tenant_id is None:
                ds = _get_dataset_row(session, dataset_name, None)
                if ds is None:
                    return []
                effective_tenant_id = ds.tenant_id
            stmt = (
                select(GoldenDatasetRecordORM)
                .join(
                    GoldenDatasetORM,
                    (GoldenDatasetRecordORM.tenant_id == GoldenDatasetORM.tenant_id)
                    & (GoldenDatasetRecordORM.dataset_name == GoldenDatasetORM.dataset_name),
                )
                .where(GoldenDatasetRecordORM.dataset_name == dataset_name)
                .where(GoldenDatasetORM.tenant_id.in_(tenant_id_candidates(effective_tenant_id)))
            )
            # Deterministic, and in the author's own order. Every record of a
            # bulk upload shares one ``created_time``, so the record-id
            # tie-breaker decided the rest and the Serial No column came out
            # 1, 4, 3, 2, 5 — the numbers the author wrote, shuffled.
            stmt = stmt.order_by(
                GoldenDatasetRecordORM.created_time,
                GoldenDatasetRecordORM.dataset_record_id,
            )
            rows = session.scalars(stmt).all()
            # ponytail: sorted in Python, not SQL. The serial number lives in a
            # JSON tag under three spellings, and the portable cast to order by
            # it raises on Postgres for a non-numeric value while SQLite
            # silently returns 0. Golden datasets are tens to low thousands of
            # rows; push this into the query if one ever gets big enough to
            # care.
            rows = sorted(rows, key=_record_sort_key)
            if offset:
                rows = rows[offset:]
            if limit is not None:
                rows = rows[:limit]
            return [
                {
                    "dataset_record_id": r.dataset_record_id,
                    "inputs": r.inputs,
                    "expectations": r.expectations,
                    "tags": r.tags,
                }
                for r in rows
            ]

    def sample_records_by_dataset(
        self,
        dataset_keys: list[tuple[str, str]],
        *,
        limit_per_dataset: int,
    ) -> dict[tuple[str, str], list[dict[str, Any]]]:
        """Return up to ``limit_per_dataset`` records per dataset in ONE query.

        A per-dataset ``LIMIT`` is a window function, not N queries: ranking
        rows inside each ``(tenant_id, dataset_name)`` partition keeps a list call flat no
        matter how many datasets it returns. Only the columns row-derived
        verdicts read are selected.

        Order is insertion order and is deliberately NOT the author-serial order
        ``get_records`` returns: the one caller scans this sample for missing
        row fields, a set property no ordering affects, and matching the serial
        order would mean ranking on a JSON tag in SQL to no one's benefit. Do not
        render this sample as an ordered list — read it through ``get_records``
        if order matters.

        A listed dataset with no records maps to ``[]``; a key absent from the
        result was never asked about.
        """
        if not dataset_keys:
            return {}
        with self._sessionmaker() as session:
            ranked = (
                select(
                    GoldenDatasetRecordORM.tenant_id.label("tenant_id"),
                    GoldenDatasetRecordORM.dataset_name.label("dataset_name"),
                    GoldenDatasetRecordORM.inputs.label("inputs"),
                    GoldenDatasetRecordORM.expectations.label("expectations"),
                    func.row_number()
                    .over(
                        partition_by=(GoldenDatasetRecordORM.tenant_id, GoldenDatasetRecordORM.dataset_name),
                        order_by=(
                            GoldenDatasetRecordORM.created_time,
                            GoldenDatasetRecordORM.dataset_record_id,
                        ),
                    )
                    .label("rank"),
                )
                .where(tuple_(GoldenDatasetRecordORM.tenant_id, GoldenDatasetRecordORM.dataset_name).in_(dataset_keys))
                .subquery()
            )
            rows = session.execute(
                select(ranked.c.tenant_id, ranked.c.dataset_name, ranked.c.inputs, ranked.c.expectations).where(
                    ranked.c.rank <= limit_per_dataset
                )
            ).all()
        out: dict[tuple[str, str], list[dict[str, Any]]] = {key: [] for key in dataset_keys}
        for tenant_id, dataset_name, inputs, expectations in rows:
            out[tenant_id, dataset_name].append({"inputs": inputs, "expectations": expectations})
        return out

    def count_records(self, dataset_name: str, tenant_id: str | None) -> int:
        """Return the honest total record count for a dataset.

        Raises ``DatasetNotFoundError`` for an unknown dataset (or one owned
        by a different tenant) so paged callers can surface a 404 instead of
        a fake empty page.
        """
        with self._sessionmaker() as session:
            ds = _get_dataset_row(session, dataset_name, tenant_id)
            if ds is None:
                raise DatasetNotFoundError(f"Dataset '{dataset_name}' not found")
            return session.scalar(select(func.count()).select_from(GoldenDatasetRecordORM).where(GoldenDatasetRecordORM.tenant_id == ds.tenant_id, GoldenDatasetRecordORM.dataset_name == dataset_name)) or 0

    def delete_records(self, dataset_name: str, tenant_id: str | None, record_ids: list[str]) -> int:
        """Delete specific records by id; record a DELETE version event."""
        with self._sessionmaker() as session:
            ds = _get_dataset_row(session, dataset_name, tenant_id)
            if ds is None:
                raise DatasetNotFoundError(f"Dataset '{dataset_name}' not found")
            result = session.execute(
                delete(GoldenDatasetRecordORM).where(
                    GoldenDatasetRecordORM.tenant_id == ds.tenant_id,
                    GoldenDatasetRecordORM.dataset_name == dataset_name,
                    GoldenDatasetRecordORM.dataset_record_id.in_(record_ids),
                )
            )
            deleted = result.rowcount or 0
            if deleted:
                ds.version_number += 1
                ds.updated_at = datetime.now(UTC)
                session.add(
                    GoldenDatasetVersionEventORM(
                        tenant_id=ds.tenant_id,
                        dataset_name=dataset_name,
                        version=ds.version_number,
                        operation="DELETE",
                        num_records=deleted,
                    )
                )
            session.commit()
            logger.info("Deleted %d records from %s", deleted, dataset_name)
            return deleted

    def annotate_expected_tools(
        self,
        dataset_name: str,
        tenant_id: str | None,
        record_ids: list[str],
        tools: list[str],
    ) -> int:
        """Write expected tool actions onto specific records by id.

        Only the named records are touched — the caller's row selection is the
        whole scope of the write. ``tools`` is stored under the expectation key
        ``dataset_bridge._EXPECTED_ACTION_KEYS`` probes first, so the scorers
        read it where they already read; an empty list clears the expectation
        rather than writing an empty one.

        Records the write as an ANNOTATE version event, the same way
        :meth:`delete_records` records a DELETE.
        """
        if not record_ids:
            return 0
        with self._sessionmaker() as session:
            ds = _get_dataset_row(session, dataset_name, tenant_id)
            if ds is None:
                raise DatasetNotFoundError(f"Dataset '{dataset_name}' not found")
            records = session.scalars(
                select(GoldenDatasetRecordORM).where(
                    GoldenDatasetRecordORM.tenant_id == ds.tenant_id,
                    GoldenDatasetRecordORM.dataset_name == dataset_name,
                    GoldenDatasetRecordORM.dataset_record_id.in_(record_ids),
                )
            ).all()
            annotated = 0
            for record in records:
                # Reassign rather than mutate: a JSON column tracks attribute
                # sets, not in-place dict edits.
                current = dict(record.expectations or {})
                had_expectation = any(key in current for key in _ACTION_KEYS)
                if not tools and not had_expectation:
                    continue  # nothing declared, nothing to clear
                record.expectations = _with_expected_tools(current, tools)
                annotated += 1
            if annotated:
                ds.version_number += 1
                ds.updated_at = datetime.now(UTC)
                session.add(
                    GoldenDatasetVersionEventORM(
                        tenant_id=ds.tenant_id,
                        dataset_name=dataset_name,
                        version=ds.version_number,
                        operation="ANNOTATE",
                        num_records=annotated,
                    )
                )
            session.commit()
            logger.info(
                "Annotated %d records in %s with expected tools %s",
                annotated,
                dataset_name,
                tools or "(cleared)",
            )
            return annotated

    # ------------------------------------------------------------------
    # Search / history
    # ------------------------------------------------------------------

    @staticmethod
    def _dataset_filters(
        *,
        tenant_id: str | None,
        product_id: str | None,
        status: str | None,
        exclude_statuses: Sequence[str] | None = None,
    ) -> list[Any]:
        clauses: list[Any] = []
        if tenant_id:
            clauses.append(GoldenDatasetORM.tenant_id.in_(tenant_id_candidates(tenant_id)))
        if product_id:
            clauses.append(GoldenDatasetORM.product_id == product_id)
        if status:
            clauses.append(GoldenDatasetORM.status == status)
        # Exclusion rather than a synthetic "active" status: the set a caller
        # wants to hide is theirs to choose, and inventing an enum member would
        # need keeping in sync with the real lifecycle everywhere else.
        if exclude_statuses:
            clauses.append(GoldenDatasetORM.status.notin_(list(exclude_statuses)))
        return clauses

    def search_datasets(
        self,
        *,
        tenant_id: str | None = None,
        product_id: str | None = None,
        status: str | None = None,
        exclude_statuses: Sequence[str] | None = None,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Filter datasets by governance attributes.

        Unpaged by default (legacy callers get everything); pass ``limit`` /
        ``offset`` to fetch one page ordered by most recently updated.
        """
        with self._sessionmaker() as session:
            stmt = select(GoldenDatasetORM).where(
                *self._dataset_filters(
                    tenant_id=tenant_id,
                    product_id=product_id,
                    status=status,
                    exclude_statuses=exclude_statuses,
                )
            )
            stmt = stmt.order_by(
                GoldenDatasetORM.updated_at.desc(),
                GoldenDatasetORM.dataset_name,
            )
            if offset:
                stmt = stmt.offset(offset)
            if limit is not None:
                stmt = stmt.limit(limit)

            rows = session.scalars(stmt).all()
            # One grouped count for the whole page — a count per row turned a
            # list call into an N+1.
            counts = {
                (tenant, name): count
                for tenant, name, count in session.execute(
                    select(GoldenDatasetRecordORM.tenant_id, GoldenDatasetRecordORM.dataset_name, func.count())
                    .where(
                        tuple_(GoldenDatasetRecordORM.tenant_id, GoldenDatasetRecordORM.dataset_name)
                        .in_([(r.tenant_id, r.dataset_name) for r in rows])
                    )
                    .group_by(GoldenDatasetRecordORM.tenant_id, GoldenDatasetRecordORM.dataset_name)
                )
            }
            out: list[dict[str, Any]] = []
            for r in rows:
                out.append(
                    {
                        "dataset_name": r.dataset_name,
                        "dataset_id": r.dataset_id,
                        "tenant_id": r.tenant_id,
                        "product_id": r.product_id,
                        "status": r.status,
                        "version_number": r.version_number,
                        "parent_dataset_name": r.parent_dataset_name,
                        "dqs": r.dqs,
                        "change_reason": r.change_reason,
                        "created_by": r.created_by,
                        "record_count": counts.get((r.tenant_id, r.dataset_name), 0),
                        # Recency is what a reader scans a 117-row library by, and
                        # the listing was the one read that did not carry it.
                        "updated_at": r.updated_at,
                    }
                )
            return out

    def dataset_stats(
        self,
        *,
        tenant_id: str | None = None,
        product_id: str | None = None,
    ) -> dict[str, Any]:
        """Return ``{total, by_status}`` via a single GROUP BY on status.

        ``by_status`` includes every ``DatasetStatus`` key (zeros when absent).
        Definition of "published" for Overview/library KPIs is enum
        ``PUBLISHED``.
        """
        by_status = {status.value: 0 for status in DatasetStatus}
        with self._sessionmaker() as session:
            stmt = (
                select(GoldenDatasetORM.status, func.count())
                .where(
                    *self._dataset_filters(
                        tenant_id=tenant_id,
                        product_id=product_id,
                            status=None,
                    )
                )
                .group_by(GoldenDatasetORM.status)
            )
            for status, count in session.execute(stmt).all():
                by_status[str(status)] = int(count or 0)
        return {"total": sum(by_status.values()), "by_status": by_status}

    def count_datasets(
        self,
        *,
        tenant_id: str | None = None,
        product_id: str | None = None,
        status: str | None = None,
        exclude_statuses: Sequence[str] | None = None,
    ) -> int:
        """Return the honest total dataset count for the given filters."""
        with self._sessionmaker() as session:
            return (
                session.scalar(
                    select(func.count())
                    .select_from(GoldenDatasetORM)
                    .where(
                        *self._dataset_filters(
                            tenant_id=tenant_id,
                            product_id=product_id,
                            status=status,
                            exclude_statuses=exclude_statuses,
                        )
                    )
                )
                or 0
            )

    def get_version_history(self, dataset_name: str, tenant_id: str | None) -> list[dict[str, Any]]:
        """Return the append-only version event history (newest first).

        Same indistinguishable-empty-list behavior as :meth:`get_records` for
        an unknown dataset or one owned by a different tenant, and the same
        ambiguity guard for an unscoped (``tenant_id=None``) call against a
        name owned by more than one tenant -- see :meth:`get_records`.
        """
        with self._sessionmaker() as session:
            effective_tenant_id = tenant_id
            if tenant_id is None:
                ds = _get_dataset_row(session, dataset_name, None)
                if ds is None:
                    return []
                effective_tenant_id = ds.tenant_id
            events = session.scalars(
                select(GoldenDatasetVersionEventORM)
                .join(
                    GoldenDatasetORM,
                    (GoldenDatasetVersionEventORM.tenant_id == GoldenDatasetORM.tenant_id)
                    & (GoldenDatasetVersionEventORM.dataset_name == GoldenDatasetORM.dataset_name),
                )
                .where(
                    GoldenDatasetVersionEventORM.dataset_name == dataset_name,
                    GoldenDatasetORM.tenant_id.in_(tenant_id_candidates(effective_tenant_id)),
                )
                .order_by(GoldenDatasetVersionEventORM.version.desc())
            ).all()
            return [
                {
                    "version": e.version,
                    "operation": e.operation,
                    "num_records": e.num_records,
                    "timestamp": e.timestamp.isoformat(),
                    # None for events written before the actor was recorded;
                    # readers must show that as unknown, not as anyone.
                    "actor": e.actor,
                }
                for e in events
            ]


# Backward-compatible alias — Postgres was the original default backend.
PostgresDatasetStore = SqlDatasetStore
