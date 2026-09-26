"""Tests for the DatasetRegistryService (orchestration layer).

All MLflow and SQL calls are mocked — these tests verify the
orchestration logic, lifecycle transitions, and quality gate integration.
"""

from unittest.mock import MagicMock, call

import pytest

from proofgrove.datasets.enums import ChangeReason, DatasetStatus
from proofgrove.datasets.exceptions import (
    DatasetImmutableError,
    DatasetNotFoundError,
    InvalidTransitionError,
)
from proofgrove.datasets.models import (
    CreateDatasetRequest,
    CreateVersionRequest,
    DatasetFilterParams,
    DatasetMetadata,
    DatasetRecord,
    WriteExpectedToolsRequest,
)
from proofgrove.datasets.registry import DatasetRegistryService


@pytest.fixture
def mock_storage() -> MagicMock:
    """Create a mock MLflowDatasetClient."""
    storage = MagicMock()
    storage._uc_schema = "evalai_eval.golden_datasets"
    # _dataset_info derives target-kind eligibility from a bounded record read.
    storage.get_records.return_value = []
    storage.count_records.return_value = 0
    return storage


@pytest.fixture
def svc(mock_storage: MagicMock) -> DatasetRegistryService:
    """Create a DatasetRegistryService with mocked storage."""
    return DatasetRegistryService(storage=mock_storage)


def _draft_metadata(**overrides) -> DatasetMetadata:
    """Helper to build a DRAFT DatasetMetadata."""
    defaults = {
        "tenant_id": "tenant-1",
        "product_id": "product-1",
        "status": DatasetStatus.DRAFT,
        "version_number": 1,
        "created_by": "test",
    }
    defaults.update(overrides)
    return DatasetMetadata(**defaults)


# ------------------------------------------------------------------
# Create
# ------------------------------------------------------------------


class TestCreateDataset:
    """Tests for create_dataset."""

    def test_creates_dataset(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        from proofgrove.datasets.exceptions import DatasetNotFoundError

        mock_storage.get_dataset.side_effect = DatasetNotFoundError("missing")
        mock_storage.create_dataset.return_value = {
            "dataset_id": "ds-123",
            "name": "rag_test",
        }
        request = CreateDatasetRequest(
            dataset_name="rag_test",
            tenant_id="t1",
            product_id="p1",
            created_by="user",
        )
        info = svc.create_dataset(request)

        assert info.dataset_id == "ds-123"
        assert info.status == "DRAFT"
        assert info.tenant_id == "t1"
        assert info.version_number == 1
        mock_storage.create_dataset.assert_called_once()

    def test_reuses_existing_draft(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        handle = MagicMock()
        handle.dataset_id = "ds-1"
        handle.name = "eval_ds"
        mock_storage.get_dataset.return_value = handle
        mock_storage.get_metadata.return_value = _draft_metadata(version_number=3)

        info = svc.create_dataset(
            CreateDatasetRequest(
                dataset_name="eval_ds",
                tenant_id="t1",
                product_id="p1",
                    created_by="user",
            )
        )

        assert info.name == "eval_ds"
        assert info.version_number == 3
        mock_storage.create_dataset.assert_not_called()

    def test_creates_child_version_when_published_exists(
        self, svc: DatasetRegistryService, mock_storage: MagicMock
    ) -> None:
        from proofgrove.datasets.exceptions import DatasetNotFoundError

        mock_storage.get_dataset.side_effect = [
            MagicMock(dataset_id="ds-1", name="eval_ds"),  # exists check
            DatasetNotFoundError("missing"),  # allocate eval_ds_v2
        ]
        mock_storage.get_metadata.side_effect = [
            _draft_metadata(status=DatasetStatus.PUBLISHED, version_number=1),
            _draft_metadata(status=DatasetStatus.PUBLISHED, version_number=1),
        ]
        mock_storage.search_datasets.return_value = [
            {
                "dataset_name": "eval_ds",
                "version_number": 1,
                "parent_dataset_name": None,
                "status": "PUBLISHED",
            }
        ]
        mock_storage.create_dataset.return_value = {
            "dataset_id": "ds-2",
            "name": "eval_ds_v2",
        }

        info = svc.create_dataset(
            CreateDatasetRequest(
                dataset_name="eval_ds",
                tenant_id="t1",
                product_id="p1",
                    created_by="user",
            )
        )

        assert info.name == "eval_ds_v2"
        assert info.version_number == 2
        assert info.parent_dataset_name == "eval_ds"
        mock_storage.create_dataset.assert_called_once()


# ------------------------------------------------------------------
# New version
# ------------------------------------------------------------------


class TestCreateNewVersion:
    """Tests for create_new_version."""

    def test_creates_version_from_parent(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.get_metadata.return_value = _draft_metadata(
            status=DatasetStatus.PUBLISHED,
            version_number=2,
        )
        mock_storage.create_dataset.return_value = {
            "dataset_id": "ds-456",
            "name": "evalai_eval.golden_datasets.rag_test_v3",
        }
        request = CreateVersionRequest(
            source_dataset_name="rag_test",
            new_dataset_name="rag_test_v3",
            change_reason=ChangeReason.CONTENT_UPDATE,
            created_by="user",
        )
        info = svc.create_new_version(request, "tenant-1")

        assert info.version_number == 3
        assert info.parent_dataset_name == "rag_test"
        assert info.change_reason == "content_update"
        assert info.status == "DRAFT"


class TestRestoreAsDraft:
    """Tests for restoring an immutable retired version as an editable copy."""

    def test_copies_retired_dataset_into_next_draft(
        self, svc: DatasetRegistryService, mock_storage: MagicMock
    ) -> None:
        from proofgrove.datasets.exceptions import DatasetNotFoundError

        mock_storage.get_metadata.return_value = _draft_metadata(
            status=DatasetStatus.RETIRED,
            version_number=3,
        )
        mock_storage.search_datasets.return_value = [
            {
                "dataset_name": "support_quality",
                "version_number": 3,
                "parent_dataset_name": None,
                "status": "RETIRED",
            }
        ]
        mock_storage.get_dataset.side_effect = DatasetNotFoundError("missing")
        mock_storage.clone_dataset.return_value = {
            "dataset_id": "ds-restored",
            "name": "support_quality_v4",
            "record_count": 12,
        }

        info = svc.restore_as_draft("support_quality", "reviewer", "tenant-1")

        assert info.name == "support_quality_v4"
        assert info.status == "DRAFT"
        assert info.version_number == 4
        assert info.parent_dataset_name == "support_quality"
        assert info.record_count == 12
        _, _tenant_id, new_name, metadata = mock_storage.clone_dataset.call_args.args
        assert new_name == "support_quality_v4"
        assert metadata.status == DatasetStatus.DRAFT
        assert metadata.version_number == 4

    def test_rejects_restore_for_non_retired_dataset(
        self, svc: DatasetRegistryService, mock_storage: MagicMock
    ) -> None:
        mock_storage.get_metadata.return_value = _draft_metadata(status=DatasetStatus.PUBLISHED)

        with pytest.raises(InvalidTransitionError, match="Only RETIRED datasets"):
            svc.restore_as_draft("support_quality", "reviewer", "tenant-1")

        mock_storage.clone_dataset.assert_not_called()


class TestPostgresStoreClone:
    """Exercise the atomic record-copy storage path with the test database."""

    def test_clone_preserves_records_and_source(self) -> None:
        from uuid import uuid4

        from proofgrove.datasets.postgres_store import PostgresDatasetStore

        store = PostgresDatasetStore()
        suffix = uuid4().hex[:8]
        source_name = f"restore_source_{suffix}"
        restored_name = f"restore_source_{suffix}_v3"
        store.create_dataset(
            source_name,
            _draft_metadata(version_number=1),
        )
        source_records = [
            {
                "inputs": {"question": "Q1"},
                "expectations": {"answer": "A1"},
                "tags": {"risk": "low"},
            },
            {
                "inputs": {"question": "Q2"},
                "expectations": {"answer": "A2"},
                "tags": {"risk": "high"},
            },
        ]
        store.merge_records(source_name, "tenant-1", source_records)
        store.update_status(source_name, "tenant-1", status=DatasetStatus.RETIRED.value)
        restored_meta = _draft_metadata(
            status=DatasetStatus.DRAFT,
            version_number=3,
            parent_dataset_name=source_name,
            created_by="reviewer",
        )

        result = store.clone_dataset(source_name, "tenant-1", restored_name, restored_meta)

        assert result["record_count"] == 2
        assert store.get_metadata(source_name, "tenant-1").status == DatasetStatus.RETIRED
        assert store.get_metadata(restored_name, "tenant-1").status == DatasetStatus.DRAFT
        assert store.get_metadata(restored_name, "tenant-1").parent_dataset_name == source_name
        assert store.get_records(restored_name, "tenant-1") == store.get_records(source_name, "tenant-1")
        assert store.get_version_history(restored_name, "tenant-1")[0]["operation"] == "RESTORE"


class TestRestoreEndpoint:
    """Verify the public restore route delegates to the registry contract."""

    def test_restores_retired_dataset(self, client) -> None:
        from proofgrove.api.dependencies import get_registry_service
        from proofgrove.main import app

        registry = MagicMock()
        registry.get_dataset_tenant.return_value = "tenant-1"
        registry.restore_as_draft.return_value.model_dump.return_value = {
            "dataset_id": "ds-restored",
            "name": "support_quality_v4",
            "tenant_id": "tenant-1",
            "product_id": "product-1",
            "status": "DRAFT",
            "version_number": 4,
            "parent_dataset_name": "support_quality",
            "record_count": 12,
        }
        app.dependency_overrides[get_registry_service] = lambda: registry
        try:
            response = client.post(
                "/datasets/support_quality/restore",
                json={"created_by": "reviewer"},
                headers={"x-evalai-tenant": "tenant-1"},
            )
        finally:
            app.dependency_overrides.pop(get_registry_service, None)

        assert response.status_code == 201
        assert response.json()["name"] == "support_quality_v4"
        assert response.json()["record_count"] == 12
        registry.restore_as_draft.assert_called_once_with("support_quality", "reviewer", "tenant-1")

    def test_returns_conflict_when_source_is_not_retired(self, client) -> None:
        from proofgrove.api.dependencies import get_registry_service
        from proofgrove.main import app

        registry = MagicMock()
        registry.get_dataset_tenant.return_value = "tenant-1"
        registry.restore_as_draft.side_effect = InvalidTransitionError(
            "Only RETIRED datasets can be restored as a draft."
        )
        app.dependency_overrides[get_registry_service] = lambda: registry
        try:
            response = client.post(
                "/datasets/support_quality/restore",
                json={"created_by": "reviewer"},
                headers={"x-evalai-tenant": "tenant-1"},
            )
        finally:
            app.dependency_overrides.pop(get_registry_service, None)

        assert response.status_code == 409
        assert "Only RETIRED datasets" in response.json()["detail"]


# ------------------------------------------------------------------
# Merge records
# ------------------------------------------------------------------


class TestMergeRecords:
    """Tests for merge_records."""

    def test_merges_into_draft(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.get_metadata.return_value = _draft_metadata()
        mock_storage.merge_records.return_value = 3

        records = [DatasetRecord(inputs={"q": f"q{i}"}) for i in range(3)]
        count = svc.merge_records("test_ds", "tenant-1", records)

        assert count == 3
        mock_storage.merge_records.assert_called_once()

    def test_rejects_merge_into_published(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.get_metadata.return_value = _draft_metadata(status=DatasetStatus.PUBLISHED)

        with pytest.raises(DatasetImmutableError):
            svc.merge_records("test_ds", "tenant-1", [DatasetRecord(inputs={"q": "test"})])


# ------------------------------------------------------------------
# Delete records
# ------------------------------------------------------------------


class TestDeleteRecords:
    """Tests for delete_records."""

    def test_deletes_from_draft(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.get_metadata.return_value = _draft_metadata()
        mock_storage.delete_records.return_value = 2

        count = svc.delete_records("test_ds", "tenant-1", ["id1", "id2"])
        assert count == 2

    def test_rejects_delete_from_published(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.get_metadata.return_value = _draft_metadata(status=DatasetStatus.PUBLISHED)

        with pytest.raises(DatasetImmutableError):
            svc.delete_records("test_ds", "tenant-1", ["id1"])


# ------------------------------------------------------------------
# Validate
# ------------------------------------------------------------------


class TestValidateDataset:
    """Tests for validate_dataset."""

    def test_passing_validation(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.get_metadata.return_value = _draft_metadata()
        mock_storage.get_records.return_value = [
            {"inputs": {"q": f"q{i}"}, "expectations": {"a": f"a{i}"}, "tags": {}}
            for i in range(5)
        ]
        result = svc.validate_dataset("test_ds", "tenant-1")

        assert result.passed is True
        assert result.target_status == DatasetStatus.VALIDATED
        mock_storage.update_status.assert_called_once()

    def test_failing_validation(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.get_metadata.return_value = _draft_metadata()
        mock_storage.get_records.return_value = []

        result = svc.validate_dataset("test_ds", "tenant-1")

        assert result.passed is False
        assert result.target_status == DatasetStatus.REJECTED
        assert "record_count" in result.blocker_failures

    def test_rejects_validate_non_draft(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.get_metadata.return_value = _draft_metadata(status=DatasetStatus.PUBLISHED)

        with pytest.raises(DatasetImmutableError):
            svc.validate_dataset("test_ds", "tenant-1")


# ------------------------------------------------------------------
# Lifecycle transitions
# ------------------------------------------------------------------


class TestLifecycleTransitions:
    """Tests for approve, publish, deprecate, retire."""

    def _setup_dataset_info(self, mock_storage: MagicMock, status: DatasetStatus) -> None:
        """Configure mock for _dataset_info call after transition."""
        mock_ds = MagicMock()
        mock_ds.dataset_id = "ds-123"
        mock_ds.name = "evalai_eval.golden_datasets.test_ds"
        mock_ds.to_df.return_value = MagicMock(__len__=lambda s: 5)
        mock_storage.get_dataset.return_value = mock_ds
        mock_storage.get_metadata.return_value = _draft_metadata(status=status)

    def test_approve_validated(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        self._setup_dataset_info(mock_storage, DatasetStatus.VALIDATED)
        # After approval, _dataset_info calls get_metadata again with APPROVED
        mock_storage.get_metadata.side_effect = [
            _draft_metadata(status=DatasetStatus.VALIDATED),  # for approval check
            _draft_metadata(status=DatasetStatus.APPROVED),   # for _dataset_info
        ]
        svc.approve_dataset("test_ds", "reviewer", "tenant-1")
        mock_storage.update_status.assert_called_once_with("test_ds", "tenant-1", status="APPROVED", actor="reviewer")

    def test_approve_draft_fails(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.get_metadata.return_value = _draft_metadata(status=DatasetStatus.DRAFT)
        with pytest.raises(InvalidTransitionError):
            svc.approve_dataset("test_ds", "reviewer", "tenant-1")

    def test_reject_and_reopen_are_persisted_transitions(
        self, svc: DatasetRegistryService, mock_storage: MagicMock
    ) -> None:
        mock_ds = MagicMock()
        mock_ds.dataset_id = "ds-123"
        mock_ds.name = "evalai_eval.golden_datasets.test_ds"
        mock_ds.to_df.return_value = MagicMock(__len__=lambda s: 5)
        mock_storage.get_dataset.return_value = mock_ds
        mock_storage.get_metadata.side_effect = [
            _draft_metadata(status=DatasetStatus.VALIDATED),
            _draft_metadata(status=DatasetStatus.REJECTED),
            _draft_metadata(status=DatasetStatus.REJECTED),
            _draft_metadata(status=DatasetStatus.DRAFT),
        ]

        rejected = svc.reject_dataset("test_ds", "reviewer", "tenant-1", "Fix missing expectations")
        reopened = svc.reopen_dataset("test_ds", "editor", "tenant-1")

        assert rejected.status == DatasetStatus.REJECTED.value
        assert reopened.status == DatasetStatus.DRAFT.value
        assert mock_storage.update_status.call_args_list == [
            call("test_ds", "tenant-1", status="REJECTED", actor="reviewer"),
            call("test_ds", "tenant-1", status="DRAFT", actor="editor"),
        ]

    def test_publish_approved(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.get_metadata.side_effect = [
            _draft_metadata(status=DatasetStatus.APPROVED),
            _draft_metadata(status=DatasetStatus.PUBLISHED),
        ]
        mock_ds = MagicMock()
        mock_ds.dataset_id = "ds-123"
        mock_ds.name = "evalai_eval.golden_datasets.test_ds"
        mock_ds.to_df.return_value = MagicMock(__len__=lambda s: 5)
        mock_storage.get_dataset.return_value = mock_ds

        svc.publish_dataset("test_ds", "tenant-1")
        mock_storage.update_status.assert_called_once_with("test_ds", "tenant-1", status="PUBLISHED", actor=None)

    def test_deprecate_published(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.get_metadata.side_effect = [
            _draft_metadata(status=DatasetStatus.PUBLISHED),
            _draft_metadata(status=DatasetStatus.DEPRECATED),
        ]
        mock_ds = MagicMock()
        mock_ds.dataset_id = "ds-123"
        mock_ds.name = "evalai_eval.golden_datasets.test_ds"
        mock_ds.to_df.return_value = MagicMock(__len__=lambda s: 0)
        mock_storage.get_dataset.return_value = mock_ds

        svc.deprecate_dataset("test_ds", "tenant-1")
        mock_storage.update_status.assert_called_once_with("test_ds", "tenant-1", status="DEPRECATED", actor=None)

    def test_retire_deprecated(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.get_metadata.side_effect = [
            _draft_metadata(status=DatasetStatus.DEPRECATED),
            _draft_metadata(status=DatasetStatus.RETIRED),
        ]
        mock_ds = MagicMock()
        mock_ds.dataset_id = "ds-123"
        mock_ds.name = "evalai_eval.golden_datasets.test_ds"
        mock_ds.to_df.return_value = MagicMock(__len__=lambda s: 0)
        mock_storage.get_dataset.return_value = mock_ds

        svc.retire_dataset("test_ds", "tenant-1")
        mock_storage.update_status.assert_called_once_with("test_ds", "tenant-1", status="RETIRED", actor=None)

    def test_full_lifecycle(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        """Test the full lifecycle: DRAFT → VALIDATED → APPROVED → PUBLISHED → DEPRECATED → RETIRED."""
        mock_ds = MagicMock()
        mock_ds.dataset_id = "ds-123"
        mock_ds.name = "evalai_eval.golden_datasets.test_ds"
        mock_ds.to_df.return_value = MagicMock(__len__=lambda s: 5)
        mock_storage.get_dataset.return_value = mock_ds

        # Validate (DRAFT → VALIDATED)
        mock_storage.get_metadata.return_value = _draft_metadata()
        mock_storage.get_records.return_value = [
            {"inputs": {"q": f"q{i}"}, "expectations": {"a": f"a{i}"}, "tags": {}}
            for i in range(5)
        ]
        result = svc.validate_dataset("test_ds", "tenant-1")
        assert result.target_status == DatasetStatus.VALIDATED

        # Approve (VALIDATED → APPROVED)
        mock_storage.get_metadata.side_effect = [
            _draft_metadata(status=DatasetStatus.VALIDATED),
            _draft_metadata(status=DatasetStatus.APPROVED),
        ]
        svc.approve_dataset("test_ds", "reviewer", "tenant-1")

        # Publish (APPROVED → PUBLISHED)
        mock_storage.get_metadata.side_effect = [
            _draft_metadata(status=DatasetStatus.APPROVED),
            _draft_metadata(status=DatasetStatus.PUBLISHED),
        ]
        svc.publish_dataset("test_ds", "tenant-1")

        # Deprecate (PUBLISHED → DEPRECATED)
        mock_storage.get_metadata.side_effect = [
            _draft_metadata(status=DatasetStatus.PUBLISHED),
            _draft_metadata(status=DatasetStatus.DEPRECATED),
        ]
        svc.deprecate_dataset("test_ds", "tenant-1")

        # Retire (DEPRECATED → RETIRED)
        mock_storage.get_metadata.side_effect = [
            _draft_metadata(status=DatasetStatus.DEPRECATED),
            _draft_metadata(status=DatasetStatus.RETIRED),
        ]
        svc.retire_dataset("test_ds", "tenant-1")


# ------------------------------------------------------------------
# Query
# ------------------------------------------------------------------


class TestQuery:
    """Tests for get_dataset and list_datasets."""

    def test_get_dataset(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_ds = MagicMock()
        mock_ds.dataset_id = "ds-123"
        mock_ds.name = "evalai_eval.golden_datasets.test_ds"
        mock_ds.to_df.return_value = MagicMock(__len__=lambda s: 3)
        mock_storage.get_dataset.return_value = mock_ds
        mock_storage.get_metadata.return_value = _draft_metadata()

        info = svc.get_dataset("test_ds", "tenant-1")
        assert info.dataset_id == "ds-123"
        assert info.tenant_id == "tenant-1"

    def test_list_datasets_passes_filters(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.search_datasets.return_value = [
            {"tenant_id": "t1", "dataset_name": "test", "record_count": 0}
        ]
        mock_storage.sample_records_by_dataset.return_value = {("t1", "test"): []}

        filters = DatasetFilterParams(tenant_id="t1", status=DatasetStatus.PUBLISHED)
        result = svc.list_datasets(filters)

        mock_storage.search_datasets.assert_called_once_with(
            tenant_id="t1",
            product_id=None,
            status="PUBLISHED",
            # Empty unless the caller asks to hide something; the exclusion is
            # independent of the exact-status filter.
            exclude_statuses=[],
        )
        assert len(result) == 1

    def test_get_version_history(self, svc: DatasetRegistryService, mock_storage: MagicMock) -> None:
        mock_storage.get_version_history.return_value = [
            {"version": 0, "operation": "CREATE TABLE"},
            {"version": 1, "operation": "MERGE"},
        ]
        history = svc.get_version_history("test_ds", "tenant-1")
        assert len(history) == 2


# ------------------------------------------------------------------
# Write expected tools onto chosen rows (#3032)
# ------------------------------------------------------------------


def _records(*ids: str) -> list[dict]:
    return [
        {
            "dataset_record_id": rid,
            "inputs": {"question": f"q-{rid}"},
            "expectations": {"expected_response": f"a-{rid}"},
            "tags": {},
        }
        for rid in ids
    ]


class TestWriteExpectedTools:
    """Write-back of agent tools as per-row expectations."""

    def test_annotates_only_the_rows_the_operator_chose(
        self, svc: DatasetRegistryService, mock_storage: MagicMock
    ) -> None:
        # The whole point of the feature: a run-scope selection covers every row,
        # a row expectation covers the rows named and no others.
        mock_storage.get_metadata.return_value = _draft_metadata()
        mock_storage.get_records.return_value = _records("r1", "r2", "r3")
        mock_storage.annotate_expected_tools.return_value = 2

        result = svc.annotate_expected_tools(
            "test_ds",
            WriteExpectedToolsRequest(record_ids=["r1", "r3"], tools=["search", "summarize"]),
            "tenant-1",
        )

        mock_storage.annotate_expected_tools.assert_called_once_with(
            "test_ds", "tenant-1", ["r1", "r3"], ["search", "summarize"]
        )
        assert result.annotated == 2
        assert result.created_version is False
        assert result.dataset_name == "test_ds"

    def test_unknown_record_ids_write_nothing(
        self, svc: DatasetRegistryService, mock_storage: MagicMock
    ) -> None:
        # Partial application would leave the operator with a half-annotated
        # dataset and no signal about which half.
        mock_storage.get_metadata.return_value = _draft_metadata()
        mock_storage.get_records.return_value = _records("r1")

        with pytest.raises(DatasetNotFoundError):
            svc.annotate_expected_tools(
                "test_ds",
                WriteExpectedToolsRequest(record_ids=["r1", "ghost"], tools=["search"]),
                "tenant-1",
            )
        mock_storage.annotate_expected_tools.assert_not_called()

    def test_published_dataset_is_not_mutated(
        self, svc: DatasetRegistryService, mock_storage: MagicMock
    ) -> None:
        mock_storage.get_metadata.return_value = _draft_metadata(status=DatasetStatus.PUBLISHED)
        mock_storage.get_records.return_value = _records("r1")

        with pytest.raises(DatasetImmutableError):
            svc.annotate_expected_tools(
                "test_ds",
                WriteExpectedToolsRequest(record_ids=["r1"], tools=["search"]),
                "tenant-1",
            )
        mock_storage.annotate_expected_tools.assert_not_called()
        mock_storage.clone_dataset.assert_not_called()

    def test_immutable_dataset_annotates_a_new_draft_version_when_asked(
        self, svc: DatasetRegistryService, mock_storage: MagicMock
    ) -> None:
        # Opting in branches instead of refusing — and the write must land on
        # the new version, never on the approved one the operator started from.
        mock_storage.get_metadata.return_value = _draft_metadata(status=DatasetStatus.APPROVED)
        mock_storage.get_records.return_value = _records("r1", "r2")
        mock_storage.search_datasets.return_value = [
            {"dataset_name": "test_ds", "parent_dataset_name": None, "version_number": 1}
        ]
        # _allocate_versioned_name probes names until one is free; a bare
        # MagicMock never raises, so the probe would spin forever.
        mock_storage.get_dataset.side_effect = DatasetNotFoundError("free")
        mock_storage.clone_dataset.return_value = {
            "dataset_id": "ds-2",
            "name": "test_ds_v2",
            "record_count": 2,
            "annotated": 1,
        }

        result = svc.annotate_expected_tools(
            "test_ds",
            WriteExpectedToolsRequest(
                record_ids=["r1"], tools=["search"], create_version_if_immutable=True
            ),
            "tenant-1",
        )

        assert result.created_version is True
        assert result.source_dataset_name == "test_ds"
        assert result.annotated == 1
        # Branch and annotate share one transaction, so the clone carries the
        # selection: a separate annotate call would be able to fail on its own
        # and strand an unannotated draft version in the lineage.
        mock_storage.annotate_expected_tools.assert_not_called()
        clone_kwargs = mock_storage.clone_dataset.call_args.kwargs
        assert clone_kwargs["annotate_record_ids"] == ["r1"]
        assert clone_kwargs["annotate_tools"] == ["search"]
        # And the original is never the clone target.
        assert mock_storage.clone_dataset.call_args.args[0] == "test_ds"
        assert mock_storage.clone_dataset.call_args.args[2] != "test_ds"

    @pytest.mark.parametrize(
        "status", [DatasetStatus.REJECTED, DatasetStatus.RETIRED]
    )
    def test_rejected_and_retired_are_not_branchable(
        self, svc: DatasetRegistryService, mock_storage: MagicMock, status: DatasetStatus
    ) -> None:
        # The opt-in may branch an immutable dataset, but not resurrect one the
        # lifecycle has ruled out — restore (RETIRED-only) owns that decision.
        mock_storage.get_metadata.return_value = _draft_metadata(status=status)

        with pytest.raises(InvalidTransitionError):
            svc.annotate_expected_tools(
                "test_ds",
                WriteExpectedToolsRequest(
                    record_ids=["r1"], tools=["search"], create_version_if_immutable=True
                ),
                "tenant-1",
            )
        mock_storage.annotate_expected_tools.assert_not_called()
        mock_storage.clone_dataset.assert_not_called()

    def test_tool_names_are_validated_at_the_boundary(self) -> None:
        # ";" splits the stored join and "(" truncates at parse time — both
        # would silently corrupt a governed expectation.
        for bad in ("", "  ", "a;b", "call(", "x)"):
            with pytest.raises(ValueError):
                WriteExpectedToolsRequest(record_ids=["r1"], tools=[bad])
        request = WriteExpectedToolsRequest(
            record_ids=["r1"], tools=[" search ", "search", "summarize"]
        )
        assert request.tools == ["search", "summarize"]


class TestSingleDatasetReadCountsItsRows:
    """The single-dataset read must not report an empty dataset.

    ``record_count`` was never set on this path, so it defaulted to 0 while the
    listing reported the truth. A caller that resolved a dataset by name — the
    run setup does exactly that after publishing a new version — saw 0 rows and
    offered to evaluate 0 cases.
    """

    def _store(self):
        from proofgrove.datasets.postgres_store import SqlDatasetStore

        return SqlDatasetStore()

    def test_get_dataset_reports_the_same_count_as_the_listing(self) -> None:
        from proofgrove.datasets.registry import DatasetRegistryService

        store = self._store()
        svc = DatasetRegistryService(storage=store)
        store.create_dataset("counted_ds", _draft_metadata())
        store.merge_records(
            "counted_ds",
            "tenant-1",
            [
                {"inputs": {"question": f"q{i}"}, "expectations": {"expected_output": "a"}, "tags": {}}
                for i in range(3)
            ],
        )

        info = svc.get_dataset("counted_ds", "tenant-1")

        assert info.record_count == 3
        assert info.record_count == store.count_records("counted_ds", "tenant-1")

    def test_a_genuinely_empty_dataset_still_reports_zero(self) -> None:
        from proofgrove.datasets.registry import DatasetRegistryService

        store = self._store()
        svc = DatasetRegistryService(storage=store)
        store.create_dataset("empty_ds", _draft_metadata())

        assert svc.get_dataset("empty_ds", "tenant-1").record_count == 0


class TestExpectedToolsStorePaths:
    """Against the real store: the actual SQL mutation, not the registry call."""

    def _store(self):
        from proofgrove.datasets.postgres_store import SqlDatasetStore

        return SqlDatasetStore()

    def _seeded(self, status: DatasetStatus = DatasetStatus.DRAFT):
        store = self._store()
        store.create_dataset("ds", _draft_metadata())
        store.merge_records(
            "ds",
            "tenant-1",
            [
                {
                    "inputs": {"question": "q1"},
                    "expectations": {"expected_output": "a1", "actions": "old"},
                    "tags": {},
                },
                {
                    "inputs": {"question": "q2"},
                    "expectations": {"expected_output": "a2"},
                    "tags": {},
                },
            ],
        )
        if status != DatasetStatus.DRAFT:
            store.update_status("ds", "tenant-1", status=status.value)
        return store

    def test_annotate_writes_only_chosen_rows_and_clears_aliases(self) -> None:
        store = self._seeded()
        rows = store.get_records("ds", "tenant-1")
        chosen = rows[0]["dataset_record_id"]
        before = store.get_metadata("ds", "tenant-1").version_number

        annotated = store.annotate_expected_tools("ds", "tenant-1", [chosen], ["search", "summarize"])

        assert annotated == 1
        after = {r["dataset_record_id"]: r for r in store.get_records("ds", "tenant-1")}
        assert after[chosen]["expectations"]["expected_actions"] == "search;summarize"
        # Every alias the bridge probes is cleared, not just the one written.
        assert "actions" not in after[chosen]["expectations"]
        untouched = next(rid for rid in after if rid != chosen)
        assert "expected_actions" not in after[untouched]["expectations"]
        assert store.get_metadata("ds", "tenant-1").version_number == before + 1
        operations = [e["operation"] for e in store.get_version_history("ds", "tenant-1")]
        assert "ANNOTATE" in operations

    def test_annotate_with_no_tools_skips_rows_without_an_expectation(self) -> None:
        store = self._seeded()
        rows = {r["inputs"]["question"]: r for r in store.get_records("ds", "tenant-1")}
        bare = rows["q2"]["dataset_record_id"]

        annotated = store.annotate_expected_tools("ds", "tenant-1", [bare], [])

        # Clearing a row that never had an expectation is a no-op, not a write.
        assert annotated == 0

    def test_clone_branches_and_annotates_in_one_call(self) -> None:
        store = self._seeded(status=DatasetStatus.PUBLISHED)
        chosen = store.get_records("ds", "tenant-1")[0]["dataset_record_id"]

        result = store.clone_dataset(
            "ds",
            "tenant-1",
            "ds_v2",
            _draft_metadata(status=DatasetStatus.DRAFT, version_number=2),
            annotate_record_ids=[chosen],
            annotate_tools=["search"],
        )

        assert result["annotated"] == 1
        copied = {r["dataset_record_id"]: r for r in store.get_records("ds_v2", "tenant-1")}
        assert copied[chosen]["expectations"]["expected_actions"] == "search"
        # The published original is untouched.
        original = {r["dataset_record_id"]: r for r in store.get_records("ds", "tenant-1")}
        assert "expected_actions" not in original[chosen]["expectations"]


class TestWrittenExpectedToolsAreReadable:
    """The written value must be the one the scorers and the CSV already read."""

    def test_write_back_surfaces_as_expected_tools_and_round_trips_to_metadata(self) -> None:
        # End-to-end on the value itself, not on a mock call: what the store
        # writes must parse back out as expected tools, and must survive the
        # metadata mapping that the CSV download/upload path uses.
        from proofgrove.datasets.csv_parser import metadata_to_record, record_metadata
        from proofgrove.evaluation.dataset_bridge import record_to_row

        # The exact shape SqlDatasetStore.annotate_expected_tools persists.
        record = {
            "dataset_record_id": "r1",
            "inputs": {"question": "latest AAPL price?"},
            "expectations": {
                "expected_response": "AAPL is up 2%.",
                "expected_actions": ";".join(["search", "summarize"]),
            },
            "tags": {},
        }

        row = record_to_row(record, response_source="agent")
        assert row.expected_tools == ["search", "summarize"]

        metadata = record_metadata(record)
        assert metadata["expected_actions"] == "search;summarize"
        assert "question" not in metadata
        assert "expected_response" not in metadata

        inputs: dict = {}
        expectations: dict = {}
        tags: dict = {}
        metadata_to_record(metadata, inputs, expectations, tags)
        assert expectations["expected_actions"] == "search;summarize"

    def test_written_tools_make_tool_metrics_gradeable_again(self) -> None:
        # The point of #3032 read against #3029: before the write-back the row
        # is unscored for want of a declared expectation; after it, it grades.
        from proofgrove.evaluation.adapters.trace_adapter import TraceJudge
        from proofgrove.evaluation.dataset_bridge import record_to_row
        from proofgrove.evaluation.metrics import METRIC_CATALOG
        from proofgrove.evaluation.models import EvaluatorConfig, ToolCall

        def config(metric_id: str) -> EvaluatorConfig:
            metric = METRIC_CATALOG[metric_id]
            return EvaluatorConfig(
                metric_id=metric_id,
                instance_id=f"{metric_id}-1",
                adapter=metric.default_adapter,
                adapter_class=metric.adapter_class,
                scoring_type=metric.scoring_type,
                score_range=metric.score_range,
            )

        base = {
            "dataset_record_id": "r1",
            "inputs": {"question": "latest AAPL price?"},
            "expectations": {"expected_response": "AAPL is up 2%."},
        }
        calls = [ToolCall(name="search", args={"q": "AAPL"})]
        judge = TraceJudge()

        before = record_to_row(base, response_source="agent")
        before.tool_calls = calls
        assert judge.evaluate(config("agent.tool_call_accuracy"), before).score is None

        annotated = {**base, "expectations": {**base["expectations"], "expected_actions": "search"}}
        after = record_to_row(annotated, response_source="agent")
        after.tool_calls = calls
        assert judge.evaluate(config("agent.tool_call_accuracy"), after).score == 1.0


class TestExpectedToolAliasHandling:
    """The scorer probes three action keys; a write must own all of them."""

    def test_write_clears_stale_aliases_so_none_can_contradict_it(self) -> None:
        from proofgrove.datasets.postgres_store import _with_expected_tools

        # A row already carrying a non-canonical alias.
        result = _with_expected_tools({"expected_tool_calls": "old_tool"}, ["search"])
        assert result == {"expected_actions": "search"}

    def test_clear_removes_every_alias_not_just_the_canonical_one(self) -> None:
        # Clearing only `expected_actions` would leave the row gradeable through
        # `actions`, so a reported clear would not be one.
        from proofgrove.datasets.postgres_store import _with_expected_tools
        from proofgrove.evaluation.dataset_bridge import record_to_row

        cleared = _with_expected_tools(
            {"expected_response": "a", "actions": "search(q=1)", "expected_actions": "search"},
            [],
        )
        assert cleared == {"expected_response": "a"}
        row = record_to_row({"inputs": {"question": "q"}, "expectations": cleared})
        assert row.expected_tools == []

    def test_every_key_the_bridge_probes_is_covered(self) -> None:
        # If the bridge learns a new alias, this write path must learn it too.
        from proofgrove.datasets.postgres_store import _ACTION_KEYS
        from proofgrove.evaluation.dataset_bridge import _EXPECTED_ACTION_KEYS

        assert set(_ACTION_KEYS) == set(_EXPECTED_ACTION_KEYS)


class TestAtomicCsvImport:
    def test_import_starts_at_version_one_with_all_records(self):
        from proofgrove.datasets.postgres_store import SqlDatasetStore

        store = SqlDatasetStore()
        registry = DatasetRegistryService(store)
        result = registry.create_dataset(
            CreateDatasetRequest(
                dataset_name="atomic_import",
                tenant_id="t1",
                product_id="p1",
                csv_content="Question,Expected Output\nWhat is the capital of France?,Paris\nWhat is 2+2?,4\n",
            )
        )
        assert result.version_number == 1
        assert result.record_count == 2
        assert store.get_metadata("atomic_import", "t1").version_number == 1
        assert store.get_version_history("atomic_import", "t1")[0]["num_records"] == 2

    @pytest.mark.parametrize("content", ["unknown,unused\na,b\n", "Question,Expected Output\n"])
    def test_invalid_import_leaves_no_dataset(self, content):
        from proofgrove.datasets.exceptions import DatasetValidationError
        from proofgrove.datasets.postgres_store import SqlDatasetStore

        store = SqlDatasetStore()
        with pytest.raises(DatasetValidationError):
            DatasetRegistryService(store).create_dataset(
                CreateDatasetRequest(
                    dataset_name="invalid_import",
                    tenant_id="t1",
                    product_id="p1",
                    csv_content=content,
                )
            )
        with pytest.raises(DatasetNotFoundError):
            store.get_dataset("invalid_import", "t1")

    def test_record_write_failure_rolls_back_the_dataset(self):
        from sqlalchemy import event

        from proofgrove.datasets.postgres_store import SqlDatasetStore
        from proofgrove.db.models import GoldenDatasetRecordORM

        store = SqlDatasetStore()

        def reject_record(*args):
            raise RuntimeError("simulated storage failure")

        event.listen(GoldenDatasetRecordORM, "before_insert", reject_record)
        try:
            with pytest.raises(RuntimeError, match="simulated storage failure"):
                DatasetRegistryService(store).create_dataset(
                    CreateDatasetRequest(
                        dataset_name="failed_import",
                        tenant_id="t1",
                        product_id="p1",
                        csv_content="Question,Expected Output\nWhat is 2+2?,4\n",
                    )
                )
        finally:
            event.remove(GoldenDatasetRecordORM, "before_insert", reject_record)
        with pytest.raises(DatasetNotFoundError):
            store.get_dataset("failed_import", "t1")
