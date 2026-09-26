"""Dataset Registry — high-level operations layer (records + governance).

Orchestrates golden dataset records and the governance
registry (lifecycle, DQS, lineage):

    create_dataset   → dataset row + registry entry
    create_new_version → new dataset linked to parent
    restore_as_draft → copied DRAFT version from a RETIRED source
    merge_records    → upsert into DRAFT dataset
    validate_dataset → run quality gate, update status
    approve / publish / deprecate / retire → lifecycle transitions
    list_datasets    → filtered search on registry
"""

import logging
from typing import Any

from proofgrove.datasets.csv_parser import parse_csv
from proofgrove.datasets.enums import ChangeReason, DatasetStatus
from proofgrove.datasets.exceptions import (
    DatasetNotFoundError,
    DatasetValidationError,
    InvalidTransitionError,
)
from proofgrove.datasets.models import (
    CreateDatasetRequest,
    CreateVersionRequest,
    DatasetFilterParams,
    DatasetInfo,
    DatasetMetadata,
    DatasetRecord,
    PromoteRunItemResult,
    WriteExpectedToolsRequest,
    WriteExpectedToolsResult,
)
from proofgrove.datasets.postgres_store import SqlDatasetStore, record_id_for_inputs
from proofgrove.datasets.quality_gate import QualityGateResult, run_quality_gate
from proofgrove.datasets.versioning import (
    assert_branchable,
    assert_mutable,
    validate_transition,
)
from proofgrove.evaluation.dataset_bridge import (
    ROW_SCAN_DATASETS,
    ROW_SCAN_RECORDS,
    missing_provided_response,
    missing_row_fields,
)
from proofgrove.events import EvalEvent, emit

logger = logging.getLogger(__name__)


def _provided_response_coverage(
    records: list[dict[str, Any]], record_count: int
) -> bool | None:
    """Report clean only when the bounded sample covered the whole dataset."""

    if missing_provided_response(records):
        return True
    return False if len(records) >= record_count else None


class DatasetRegistryService:
    """High-level service for managing golden datasets.

    Combines record operations with the governance lifecycle.

    """

    def __init__(self, storage: SqlDatasetStore) -> None:
        self._storage = storage

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _dataset_info(self, dataset_name: str, tenant_id: str | None) -> DatasetInfo:
        """Build a DatasetInfo response from records + registry.

        Whether the rows carry a question and an expected output is read from row
        content, at most ``ROW_SCAN_RECORDS`` rows, so a 2,000-row dataset cannot
        turn a single-dataset read into a full table scan.
        """
        ds = self._storage.get_dataset(dataset_name, tenant_id)
        meta = self._storage.get_metadata(dataset_name, tenant_id)
        records = self._storage.get_records(dataset_name, tenant_id, limit=ROW_SCAN_RECORDS)
        record_count = self._storage.count_records(dataset_name, tenant_id)
        return DatasetInfo(
            dataset_id=ds.dataset_id,
            name=ds.name,
            tenant_id=meta.tenant_id,
            product_id=meta.product_id,
            status=meta.status.value,
            version_number=meta.version_number,
            parent_dataset_name=meta.parent_dataset_name,
            dqs=meta.dqs,
            change_reason=meta.change_reason.value if meta.change_reason else None,
            created_by=meta.created_by,
            updated_at=meta.updated_at,
            # Counted, not defaulted. Leaving this unset reported every dataset
            # as empty on the single-dataset read while the listing reported the
            # truth — so a caller that resolved a dataset by name saw 0 rows and
            # offered to evaluate 0 cases. One COUNT, beside a scan this method
            # already performs.
            record_count=record_count,
            missing_row_fields=missing_row_fields(records),
            missing_provided_response=_provided_response_coverage(
                records, record_count
            ),
        )

    def _with_row_coverage(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Annotate registry rows with the same row-derived verdict as reads.

        One bulk query for the whole listing — never one ``get_records`` per
        dataset, which would make a 50-row page cost 50 record queries. Rows
        past ``ROW_SCAN_DATASETS`` keep ``None``: the field means "not computed"
        there, which the picker shows as unknown rather than as "this dataset is
        missing something".
        """
        scanned = [(row["tenant_id"], row["dataset_name"]) for row in rows[:ROW_SCAN_DATASETS]]
        samples = self._storage.sample_records_by_dataset(
            scanned, limit_per_dataset=ROW_SCAN_RECORDS
        )
        for row in rows:
            records = samples.get((row["tenant_id"], row["dataset_name"]))
            row["missing_row_fields"] = None if records is None else missing_row_fields(records)
            row["missing_provided_response"] = None if records is None else _provided_response_coverage(records, int(row["record_count"]))
        return rows

    # ------------------------------------------------------------------
    # Create
    # ------------------------------------------------------------------

    def create_dataset(self, request: CreateDatasetRequest) -> DatasetInfo:
        """Create a new evaluation dataset (DRAFT status).

        If ``request.dataset_name`` already exists:
        - DRAFT → reuse that dataset (same name) so callers can write into it
        - otherwise → create a new DRAFT child version with a unique
          ``{name}_v{N}`` name linked to the lineage tip
        """
        try:
            existing = self._storage.get_dataset(request.dataset_name, request.tenant_id)
        except DatasetNotFoundError:
            existing = None

        initial_records = None
        if request.csv_content is not None:
            initial_records = [DatasetRecord(**record).model_dump() for record in parse_csv(request.csv_content)]
            if existing is not None:
                raise DatasetValidationError("A dataset with this name already exists. Choose a new name for the import.")

        if existing is not None:
            meta = self._storage.get_metadata(request.dataset_name, request.tenant_id)
            if meta.status == DatasetStatus.DRAFT:
                logger.info(
                    "Reusing existing DRAFT dataset %s (v%s)",
                    request.dataset_name,
                    meta.version_number,
                )
                return self._dataset_info(request.dataset_name, request.tenant_id)

            tip_name, tip_version = self._lineage_tip(request.dataset_name, request.tenant_id)
            root_name = self._lineage_root(request.dataset_name, request.tenant_id)
            next_ver = tip_version + 1
            new_name = self._allocate_versioned_name(root_name, next_ver, request.tenant_id)
            logger.info(
                "Dataset %s exists (status=%s); creating version %s as %s from tip %s",
                request.dataset_name,
                meta.status.value,
                next_ver,
                new_name,
                tip_name,
            )
            return self.create_new_version(
                CreateVersionRequest(
                    source_dataset_name=tip_name,
                    new_dataset_name=new_name,
                    change_reason=ChangeReason.CONTENT_UPDATE,
                    created_by=request.created_by,
                ),
                tenant_id=request.tenant_id,
            )

        metadata = DatasetMetadata(
            tenant_id=request.tenant_id,
            product_id=request.product_id,
            created_by=request.created_by,
        )
        result = self._storage.create_dataset(
            dataset_name=request.dataset_name,
            metadata=metadata,
            **({"records": initial_records} if initial_records is not None else {}),
        )
        emit(
            EvalEvent.DATASET_REGISTERED,
            correlation_id=result["name"],
            dataset_name=result["name"],
            tenant_id=request.tenant_id,
            product_id=request.product_id,
        )
        return DatasetInfo(
            dataset_id=result["dataset_id"],
            name=result["name"],
            tenant_id=request.tenant_id,
            product_id=request.product_id,
            status=DatasetStatus.DRAFT.value,
            version_number=1,
            created_by=request.created_by,
            record_count=self._storage.count_records(request.dataset_name, request.tenant_id),
        )

    def _lineage_root(self, dataset_name: str, tenant_id: str | None) -> str:
        """Walk parents to the root dataset name for version naming."""
        rows = {row["dataset_name"]: row for row in self._storage.search_datasets(tenant_id=tenant_id)}
        name = dataset_name
        seen: set[str] = set()
        while name in rows:
            parent = rows[name].get("parent_dataset_name")
            if not parent or parent not in rows or name in seen:
                break
            seen.add(name)
            name = parent
        return name

    def _lineage_tip(self, dataset_name: str, tenant_id: str | None) -> tuple[str, int]:
        """Return ``(name, version_number)`` for the highest version in the lineage."""
        rows = {row["dataset_name"]: row for row in self._storage.search_datasets(tenant_id=tenant_id)}
        if dataset_name not in rows:
            meta = self._storage.get_metadata(dataset_name, tenant_id)
            return dataset_name, meta.version_number

        def root_of(name: str) -> str:
            seen: set[str] = set()
            current = name
            while current in rows:
                parent = rows[current].get("parent_dataset_name")
                if not parent or parent not in rows or current in seen:
                    break
                seen.add(current)
                current = parent
            return current

        root = root_of(dataset_name)
        members = [name for name in rows if root_of(name) == root]
        tip = max(
            members,
            key=lambda name: (int(rows[name].get("version_number") or 1), name),
        )
        return tip, int(rows[tip].get("version_number") or 1)

    def _allocate_versioned_name(self, root_name: str, version: int, tenant_id: str | None) -> str:
        """Pick an unused ``{root}_v{N}`` dataset name starting at ``version``."""
        candidate_version = max(version, 2)
        while True:
            candidate = f"{root_name}_v{candidate_version}"
            try:
                self._storage.get_dataset(candidate, tenant_id)
            except DatasetNotFoundError:
                return candidate
            candidate_version += 1
    def replace_records(
        self,
        dataset_name: str,
        records: list[DatasetRecord],
        tenant_id: str | None,
    ) -> int:
        """Replace all records in a DRAFT dataset with ``records``."""
        return self.merge_records(dataset_name, tenant_id, records, replace=True)

    # ------------------------------------------------------------------
    # New version (creates a new dataset linked to parent)
    # ------------------------------------------------------------------

    def create_new_version(self, request: CreateVersionRequest, tenant_id: str | None) -> DatasetInfo:
        """Create a new version by creating a new dataset from an existing one.

        Each version is a separate dataset row. Records from the
        source are NOT copied — the new version starts empty.

        """
        source_meta = self._storage.get_metadata(request.source_dataset_name, tenant_id)

        new_meta = DatasetMetadata(
            tenant_id=source_meta.tenant_id,
            product_id=source_meta.product_id,
            version_number=source_meta.version_number + 1,
            parent_dataset_name=request.source_dataset_name,
            change_reason=request.change_reason,
            created_by=request.created_by,
        )

        result = self._storage.create_dataset(
            dataset_name=request.new_dataset_name,
            metadata=new_meta,
        )
        emit(
            EvalEvent.DATASET_VERSION_CREATED,
            correlation_id=result["name"],
            dataset_name=result["name"],
            version=new_meta.version_number,
            parent_dataset_name=request.source_dataset_name,
            change_reason=request.change_reason.value,
        )
        return DatasetInfo(
            dataset_id=result["dataset_id"],
            name=result["name"],
            tenant_id=new_meta.tenant_id,
            product_id=new_meta.product_id,
            status=DatasetStatus.DRAFT.value,
            version_number=new_meta.version_number,
            parent_dataset_name=request.source_dataset_name,
            change_reason=request.change_reason.value,
            created_by=request.created_by,
        )

    def restore_as_draft(self, dataset_name: str, created_by: str, tenant_id: str | None) -> DatasetInfo:
        """Copy a RETIRED dataset into the next editable DRAFT version."""
        source_meta = self._storage.get_metadata(dataset_name, tenant_id)
        if source_meta.status != DatasetStatus.RETIRED:
            msg = f"Dataset '{dataset_name}' has status '{source_meta.status.value}'. Only RETIRED datasets can be restored as a draft."
            raise InvalidTransitionError(msg)

        _, tip_version = self._lineage_tip(dataset_name, tenant_id)
        next_version = tip_version + 1
        new_name = self._allocate_versioned_name(self._lineage_root(dataset_name, tenant_id), next_version, tenant_id)
        new_meta = DatasetMetadata(
            tenant_id=source_meta.tenant_id,
            product_id=source_meta.product_id,
            status=DatasetStatus.DRAFT,
            version_number=next_version,
            parent_dataset_name=dataset_name,
            change_reason=ChangeReason.CONTENT_UPDATE,
            created_by=created_by,
        )
        result = self._storage.clone_dataset(dataset_name, tenant_id, new_name, new_meta)
        copied_records = int(result["record_count"])
        emit(
            EvalEvent.DATASET_VERSION_CREATED,
            correlation_id=result["name"],
            dataset_name=result["name"],
            version=next_version,
            parent_dataset_name=dataset_name,
            change_reason=ChangeReason.CONTENT_UPDATE.value,
            restore_source_status=DatasetStatus.RETIRED.value,
            copied_records=copied_records,
        )
        return DatasetInfo(
            dataset_id=result["dataset_id"],
            name=result["name"],
            tenant_id=new_meta.tenant_id,
            product_id=new_meta.product_id,
            status=DatasetStatus.DRAFT.value,
            version_number=next_version,
            parent_dataset_name=dataset_name,
            change_reason=ChangeReason.CONTENT_UPDATE.value,
            created_by=created_by,
            record_count=copied_records,
        )

    # ------------------------------------------------------------------
    # Merge records (upsert by inputs)
    # ------------------------------------------------------------------

    def merge_records(
        self,
        dataset_name: str,
        tenant_id: str | None,
        records: list[DatasetRecord],
        *,
        replace: bool = False,
        actor: str | None = None,
    ) -> int:
        """Merge records into a DRAFT dataset (upsert by inputs).

        Raises
        ------
        DatasetImmutableError
            If the dataset is not in DRAFT status.
        """
        meta = self._storage.get_metadata(dataset_name, tenant_id)
        assert_mutable(meta.status)

        record_dicts = [r.model_dump() for r in records]
        count = self._storage.merge_records(dataset_name, tenant_id, record_dicts, replace=replace, actor=actor)
        emit(
            EvalEvent.RECORDS_MERGED,
            correlation_id=dataset_name,
            dataset_name=dataset_name,
            merged=count,
        )
        return count

    def get_dataset_tenant(self, dataset_name: str, tenant_id: str | None) -> str | None:
        """The stored owner of ``dataset_name`` within the caller's tenant.

        Dataset identity is (tenant, name): two tenants may hold the same
        name, so an unscoped by-name lookup is ambiguous by construction.
        The lookup is scoped to the caller's tenant (alias spellings
        included); a name that exists only under another tenant raises the
        same ``DatasetNotFoundError`` an unknown name does, so the answer
        never confirms which names exist elsewhere.
        """
        return self._storage.get_metadata(dataset_name, tenant_id).tenant_id

    # ------------------------------------------------------------------
    # Write expected tools onto chosen rows
    # ------------------------------------------------------------------

    def annotate_expected_tools(
        self,
        dataset_name: str,
        request: WriteExpectedToolsRequest,
        tenant_id: str | None,
    ) -> WriteExpectedToolsResult:
        """Write expected tools onto the rows the operator chose.

        This is deliberately not the same operation as scoping a run. Scoping
        says "score only these tools"; this says "these rows should call these
        tools", and it is written only to ``request.record_ids``. Nothing here
        stamps an agent's inventory across a dataset.

        A DRAFT dataset is annotated in place. Anything past DRAFT is immutable,
        so the write is refused unless the caller set
        ``create_version_if_immutable``, in which case the dataset is copied
        into the next DRAFT version and that copy is annotated. ``clone_dataset``
        preserves ``dataset_record_id``, so the operator's row selection carries
        over unchanged.

        Raises
        ------
        DatasetImmutableError
            If the dataset is past DRAFT and no new version was requested.
        """
        meta = self._storage.get_metadata(dataset_name, tenant_id)
        target_name = dataset_name
        created_version = False
        mutable = meta.status == DatasetStatus.DRAFT

        if not mutable and not request.create_version_if_immutable:
            # Same refusal the other record writes give, with the same error.
            assert_mutable(meta.status)
        if not mutable:
            # Fail before any work: the same shared guard that
            # restore_for_annotation re-asserts inside the copy transaction.
            assert_branchable(meta.status, dataset_name)
        known_ids = {
            str(record["dataset_record_id"])
            for record in self._storage.get_records(dataset_name, tenant_id)
            if record.get("dataset_record_id")
        }
        selected = [rid for rid in request.record_ids if rid in known_ids]
        unknown = [rid for rid in request.record_ids if rid not in known_ids]
        if unknown:
            msg = f"Dataset '{dataset_name}' has no record(s): {sorted(unknown)}. Expected tools were not written."
            raise DatasetNotFoundError(msg)

        if not mutable:
            # Branch and annotate in one transaction: a failed annotation must
            # not leave an unannotated draft version behind in the lineage.
            new_version, clone_result = self.restore_for_annotation(
                dataset_name,
                request.created_by,
                tenant_id,
                annotate_record_ids=selected,
                annotate_tools=request.tools,
            )
            annotated = int(clone_result.get("annotated") or 0)
            target_name = new_version.name
            created_version = True
        else:
            annotated = self._storage.annotate_expected_tools(
                target_name, tenant_id, selected, request.tools
            )
        target_meta = self._storage.get_metadata(target_name, tenant_id)
        emit(
            EvalEvent.RECORDS_MERGED,
            correlation_id=target_name,
            dataset_name=target_name,
            merged=annotated,
            expected_tools=request.tools,
            source_agent=request.source_agent,
            created_version=created_version,
        )
        return WriteExpectedToolsResult(
            dataset_name=target_name,
            annotated=annotated,
            tools=request.tools,
            created_version=created_version,
            source_dataset_name=dataset_name if created_version else None,
            version_number=target_meta.version_number,
            status=target_meta.status.value,
        )

    def promote_record(
        self,
        dataset_name: str,
        record: DatasetRecord,
        tenant_id: str | None,
        *,
        create_version_if_immutable: bool = False,
        created_by: str = "system",
    ) -> PromoteRunItemResult:
        """Write one promoted record into the dataset, or into a new draft.

        A DRAFT dataset takes the record in place via an atomic upsert that
        also answers whether this source was already promoted. Past DRAFT the
        write is refused unless the caller opted into
        ``create_version_if_immutable`` — and even then REJECTED and RETIRED
        datasets are not branchable from here: resurrecting a dataset the
        lifecycle has ruled out is a lifecycle action, not a promotion.
        """
        meta = self._storage.get_metadata(dataset_name, tenant_id)
        mutable = meta.status == DatasetStatus.DRAFT

        if not mutable and not create_version_if_immutable:
            # Same refusal the other record writes give, with the same error.
            assert_mutable(meta.status)
        if not mutable:
            assert_branchable(meta.status, dataset_name)
        if not mutable:
            new_version, clone_result = self.restore_for_annotation(
                dataset_name,
                created_by,
                tenant_id,
                append_records=[record.model_dump()],
                change_reason=ChangeReason.FEEDBACK_PROMOTION,
            )
            target_name = new_version.name
            created_version = True
            duplicates = clone_result.get("duplicates") or []
            record_id = duplicates[0] if duplicates else record_id_for_inputs(record.inputs)
            duplicate = bool(duplicates)
        else:
            upserted = self._storage.upsert_record(
                dataset_name, tenant_id, record.model_dump(), operation="PROMOTE"
            )
            target_name = dataset_name
            created_version = False
            record_id = str(upserted["record_id"])
            duplicate = bool(upserted["duplicate"])

        target_meta = self._storage.get_metadata(target_name, tenant_id)
        emit(
            EvalEvent.RECORDS_MERGED,
            correlation_id=target_name,
            dataset_name=target_name,
            merged=1,
            promoted_record_id=record_id,
            duplicate=duplicate,
            created_version=created_version,
        )
        return PromoteRunItemResult(
            dataset_name=target_name,
            record_id=record_id,
            duplicate=duplicate,
            created_version=created_version,
            source_dataset_name=dataset_name if created_version else None,
            version_number=target_meta.version_number,
            status=target_meta.status.value,
        )

    def restore_for_annotation(
        self,
        dataset_name: str,
        created_by: str,
        tenant_id: str | None,
        *,
        annotate_record_ids: list[str] | None = None,
        annotate_tools: list[str] | None = None,
        append_records: list[dict[str, Any]] | None = None,
        change_reason: ChangeReason = ChangeReason.CONTENT_UPDATE,
    ) -> tuple[DatasetInfo, dict[str, Any]]:
        """Copy any non-DRAFT dataset into the next DRAFT version and write to it.

        ``restore_as_draft`` does the same copy but only from RETIRED, because
        restoring is a lifecycle action. Annotating or promoting into an
        approved or published dataset is a different reason to branch, so it
        gets its own entry point rather than loosening that guard.

        The copy and the write (annotation and/or appended records) share one
        transaction, so a failure leaves no half-built version behind. Returns
        the new version and the raw clone result (``annotated`` / ``appended`` /
        ``duplicates``).

        The lifecycle guard lives HERE, in the shared primitive, rather than in
        each caller: a status the lifecycle has ruled out must not be
        resurrected through any branch-into-DRAFT path, including one added
        later. ``clone_dataset`` re-asserts it inside its own transaction,
        which is what closes the window between this read and that write.
        """
        source_meta = self._storage.get_metadata(dataset_name, tenant_id)
        assert_branchable(source_meta.status, dataset_name)
        _, tip_version = self._lineage_tip(dataset_name, tenant_id)
        next_version = tip_version + 1
        new_name = self._allocate_versioned_name(self._lineage_root(dataset_name, tenant_id), next_version, tenant_id)
        new_meta = DatasetMetadata(
            tenant_id=source_meta.tenant_id,
            product_id=source_meta.product_id,
            status=DatasetStatus.DRAFT,
            version_number=next_version,
            parent_dataset_name=dataset_name,
            change_reason=change_reason,
            created_by=created_by,
        )
        result = self._storage.clone_dataset(
            dataset_name,
            tenant_id,
            new_name,
            new_meta,
            annotate_record_ids=annotate_record_ids,
            annotate_tools=annotate_tools,
            append_records=append_records,
            require_branchable=True,
        )
        copied_records = int(result["record_count"])
        annotated = int(result.get("annotated") or 0)
        emit(
            EvalEvent.DATASET_VERSION_CREATED,
            correlation_id=result["name"],
            dataset_name=result["name"],
            version=next_version,
            parent_dataset_name=dataset_name,
            change_reason=change_reason.value,
            annotation_source_status=source_meta.status.value,
            copied_records=copied_records,
            annotated_records=annotated,
        )
        return DatasetInfo(
            dataset_id=result["dataset_id"],
            name=result["name"],
            tenant_id=new_meta.tenant_id,
            product_id=new_meta.product_id,
            status=DatasetStatus.DRAFT.value,
            version_number=next_version,
            parent_dataset_name=dataset_name,
            change_reason=change_reason.value,
            created_by=created_by,
            record_count=copied_records,
        ), result

    # ------------------------------------------------------------------
    # Get records
    # ------------------------------------------------------------------

    def get_records(self, dataset_name: str, tenant_id: str | None) -> list[dict[str, Any]]:
        """Get all records from a dataset.

        """
        return self._storage.get_records(dataset_name, tenant_id)

    def get_records_page(
        self, dataset_name: str, tenant_id: str | None, *, limit: int, offset: int = 0
    ) -> tuple[list[dict[str, Any]], int]:
        """Get one page of records plus the honest total count.

        Raises
        ------
        DatasetNotFoundError
            If the dataset does not exist (never a fake empty page).
        """
        if offset < 0:
            raise DatasetValidationError("offset must be >= 0")
        total = self._storage.count_records(dataset_name, tenant_id)
        items = self._storage.get_records(dataset_name, tenant_id, limit=limit, offset=offset)
        return items, total

    # ------------------------------------------------------------------
    # Delete records
    # ------------------------------------------------------------------

    def delete_records(self, dataset_name: str, tenant_id: str | None, record_ids: list[str]) -> int:
        """Delete specific records from a DRAFT dataset.

        Raises
        ------
        DatasetImmutableError
            If the dataset is not in DRAFT status.
        """
        meta = self._storage.get_metadata(dataset_name, tenant_id)
        assert_mutable(meta.status)
        return self._storage.delete_records(dataset_name, tenant_id, record_ids)

    # ------------------------------------------------------------------
    # Validate (quality gate)
    # ------------------------------------------------------------------

    def validate_dataset(
        self, dataset_name: str, tenant_id: str | None, actor: str | None = None
    ) -> QualityGateResult:
        """Run quality gate checks and transition status.

        """
        meta = self._storage.get_metadata(dataset_name, tenant_id)
        assert_mutable(meta.status)

        records = self._storage.get_records(dataset_name, tenant_id)
        result = run_quality_gate(meta.status, records)

        if result.target_status != DatasetStatus.DRAFT:
            validate_transition(meta.status, result.target_status)

        self._storage.update_status(
            dataset_name,
            tenant_id,
            status=result.target_status.value,
            dqs=result.dqs,
            actor=actor,
        )
        emit(
            EvalEvent.DATASET_VALIDATED,
            correlation_id=dataset_name,
            dataset_name=dataset_name,
            target_status=result.target_status.value,
            dqs=result.dqs,
            passed=result.passed,
        )
        return result

    # ------------------------------------------------------------------
    # Approve / Publish / Deprecate / Retire
    # ------------------------------------------------------------------

    def approve_dataset(self, dataset_name: str, approved_by: str, tenant_id: str | None) -> DatasetInfo:
        """Approve a VALIDATED dataset (human sign-off).

        """
        meta = self._storage.get_metadata(dataset_name, tenant_id)
        validate_transition(meta.status, DatasetStatus.APPROVED)
        self._storage.update_status(dataset_name, tenant_id, status=DatasetStatus.APPROVED.value, actor=approved_by)
        emit(
            EvalEvent.DATASET_APPROVED,
            correlation_id=dataset_name,
            dataset_name=dataset_name,
            approved_by=approved_by,
        )
        return self._dataset_info(dataset_name, tenant_id)

    def reject_dataset(
        self, dataset_name: str, decided_by: str, tenant_id: str | None, note: str | None = None
    ) -> DatasetInfo:
        """Persist a human rejection of a DRAFT or VALIDATED dataset."""
        meta = self._storage.get_metadata(dataset_name, tenant_id)
        validate_transition(meta.status, DatasetStatus.REJECTED)
        self._storage.update_status(dataset_name, tenant_id, status=DatasetStatus.REJECTED.value, actor=decided_by)
        logger.info("Dataset %s rejected by %s", dataset_name, decided_by)
        return self._dataset_info(dataset_name, tenant_id)

    def reopen_dataset(
        self, dataset_name: str, decided_by: str, tenant_id: str | None, note: str | None = None
    ) -> DatasetInfo:
        """Return a REJECTED dataset to DRAFT so its records can be corrected."""
        meta = self._storage.get_metadata(dataset_name, tenant_id)
        validate_transition(meta.status, DatasetStatus.DRAFT)
        self._storage.update_status(dataset_name, tenant_id, status=DatasetStatus.DRAFT.value, actor=decided_by)
        logger.info("Dataset %s returned to draft by %s", dataset_name, decided_by)
        return self._dataset_info(dataset_name, tenant_id)

    def publish_dataset(self, dataset_name: str, tenant_id: str | None, actor: str | None = None) -> DatasetInfo:
        """Publish an APPROVED dataset (makes it immutable).

        """
        meta = self._storage.get_metadata(dataset_name, tenant_id)
        validate_transition(meta.status, DatasetStatus.PUBLISHED)
        self._storage.update_status(dataset_name, tenant_id, status=DatasetStatus.PUBLISHED.value, actor=actor)
        emit(
            EvalEvent.DATASET_PUBLISHED,
            correlation_id=dataset_name,
            dataset_name=dataset_name,
            version=meta.version_number,
        )
        return self._dataset_info(dataset_name, tenant_id)

    def deprecate_dataset(self, dataset_name: str, tenant_id: str | None, actor: str | None = None) -> DatasetInfo:
        """Deprecate a PUBLISHED dataset.

        """
        meta = self._storage.get_metadata(dataset_name, tenant_id)
        validate_transition(meta.status, DatasetStatus.DEPRECATED)
        self._storage.update_status(dataset_name, tenant_id, status=DatasetStatus.DEPRECATED.value, actor=actor)
        emit(EvalEvent.DATASET_DEPRECATED, correlation_id=dataset_name, dataset_name=dataset_name)
        return self._dataset_info(dataset_name, tenant_id)

    def retire_dataset(self, dataset_name: str, tenant_id: str | None, actor: str | None = None) -> DatasetInfo:
        """Retire a DEPRECATED dataset.

        """
        meta = self._storage.get_metadata(dataset_name, tenant_id)
        validate_transition(meta.status, DatasetStatus.RETIRED)
        self._storage.update_status(dataset_name, tenant_id, status=DatasetStatus.RETIRED.value, actor=actor)
        emit(EvalEvent.DATASET_RETIRED, correlation_id=dataset_name, dataset_name=dataset_name)
        return self._dataset_info(dataset_name, tenant_id)

    # ------------------------------------------------------------------
    # Delete
    # ------------------------------------------------------------------

    def delete_dataset(self, dataset_name: str, tenant_id: str | None) -> None:
        """Delete a DRAFT dataset and its registry entry.

        Anything past DRAFT is immutable (``assert_mutable``), and that includes
        being removed: a published version is the evidence its runs were scored
        against, and its version events are the record that it existed. Retire
        it through the lifecycle instead.

        Raises
        ------
        DatasetImmutableError
            If the dataset is not in DRAFT status.
        """
        meta = self._storage.get_metadata(dataset_name, tenant_id)
        assert_mutable(meta.status)
        self._storage.delete_dataset(dataset_name, tenant_id)
        logger.info("Deleted dataset %s", dataset_name)

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def get_dataset(self, dataset_name: str, tenant_id: str | None) -> DatasetInfo:
        """Get dataset info by name.

        Raises
        ------
        DatasetNotFoundError
            If the dataset does not exist.
        """
        return self._dataset_info(dataset_name, tenant_id)

    def list_datasets(self, filters: DatasetFilterParams) -> list[dict[str, Any]]:
        """List datasets with optional filters.

        Returns
        -------
        list[dict]
            Matching registry rows, each carrying ``missing_row_fields``
            (``None`` past the scan cap — see ``_with_row_coverage``).
        """
        return self._with_row_coverage(
            self._storage.search_datasets(
                tenant_id=filters.tenant_id,
                product_id=filters.product_id,
                status=filters.status.value if filters.status else None,
                exclude_statuses=[s.value for s in filters.exclude_statuses],
            )
        )

    def list_datasets_page(
        self, filters: DatasetFilterParams, *, limit: int, offset: int = 0
    ) -> tuple[list[dict[str, Any]], int]:
        """List one page of datasets plus the honest total match count.

        Returns
        -------
        tuple[list[dict], int]
            (page of registry rows each carrying ``missing_row_fields``, total
            unpaged match count).
        """
        if offset < 0:
            raise DatasetValidationError("offset must be >= 0")
        kwargs = {
            "tenant_id": filters.tenant_id,
            "product_id": filters.product_id,
            "status": filters.status.value if filters.status else None,
            "exclude_statuses": [s.value for s in filters.exclude_statuses],
        }
        total = self._storage.count_datasets(**kwargs)
        items = self._storage.search_datasets(**kwargs, limit=limit, offset=offset)
        return self._with_row_coverage(items), total

    def dataset_stats(self, filters: DatasetFilterParams) -> dict[str, Any]:
        """Aggregate dataset counts by status for the given filters.

        """
        return self._storage.dataset_stats(
            tenant_id=filters.tenant_id,
            product_id=filters.product_id,
        )

    def get_version_history(self, dataset_name: str, tenant_id: str | None) -> list[dict[str, Any]]:
        """Get version history for a dataset.

        """
        return self._storage.get_version_history(dataset_name, tenant_id)
