"""Promoting a captured run item into a golden dataset record (#3007).

Covers the builder (run item → record), the registry orchestration, the
store-level atomic upsert and clone-append, and the route's two-sided tenant
handling. The record's provenance keys must survive the metadata round trip and
keep the stable record id distinct per source item.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from evalhub.api.dependencies import get_evaluation_store, get_registry_service
from evalhub.api.v1.datasets import promoted_record
from evalhub.datasets import postgres_store as store_module
from evalhub.datasets.csv_parser import metadata_to_record, record_metadata
from evalhub.datasets.enums import ChangeReason, DatasetStatus
from evalhub.datasets.exceptions import (
    DatasetImmutableError,
    DatasetNotFoundError,
    DatasetValidationError,
    InvalidTransitionError,
)
from evalhub.datasets.models import DatasetMetadata, DatasetRecord, PromoteRunItemRequest
from evalhub.datasets.registry import DatasetRegistryService
from evalhub.evaluation.dataset_bridge import record_to_row
from evalhub.evaluation.models import EvidencePolicy, RunItemDetail, RunItemExecution
from evalhub.main import app


def _item(**overrides) -> RunItemDetail:
    defaults = {
        "run_id": "run-1",
        "example_id": "ex-1",
        "sequence_position": 0,
        "input": {"question": "What is the refund window?"},
        "output": {"response": "Refunds are accepted within 30 days."},
        "expected": {"expected_output": "30 days."},
        "metadata": {"domain": "billing", "attempt": 2, "internal_note": "unlisted"},
        "execution": RunItemExecution(trace_id="trace-abc"),
        "evidence_ref": "evidence-pack://run-1/items/ex-1",
        "evidence_policy": EvidencePolicy(
            redaction_enabled=False, max_persisted_string_size=None
        ),
        "capture_state": "complete",
    }
    defaults.update(overrides)
    return RunItemDetail(**defaults)


def _meta(**overrides) -> DatasetMetadata:
    defaults = {
        "tenant_id": "tenant-1",
        "product_id": "product-1",
        "status": DatasetStatus.DRAFT,
        "version_number": 1,
        "created_by": "test",
    }
    defaults.update(overrides)
    return DatasetMetadata(**defaults)


class TestPromotedRecordBuilder:
    def test_actual_output_becomes_the_expectation_by_default(self) -> None:
        record = promoted_record(_item(), "output")
        assert record.inputs["question"] == "What is the refund window?"
        assert record.expectations["expected_output"] == (
            "Refunds are accepted within 30 days."
        )

    def test_original_expectation_is_the_other_source(self) -> None:
        record = promoted_record(_item(), "expected")
        assert record.expectations["expected_output"] == "30 days."

    def test_provenance_lands_in_inputs(self) -> None:
        record = promoted_record(_item(), "output")
        assert record.inputs["source_run_id"] == "run-1"
        assert record.inputs["source_example_id"] == "ex-1"
        assert record.inputs["source_trace_id"] == "trace-abc"

    def test_trace_id_is_omitted_when_absent(self) -> None:
        record = promoted_record(_item(execution=RunItemExecution()), "output")
        assert "source_trace_id" not in record.inputs

    def test_missing_question_refuses(self) -> None:
        with pytest.raises(DatasetValidationError, match="question"):
            promoted_record(_item(input={"unrelated": 1}), "output")

    def test_missing_output_text_refuses_naming_the_source(self) -> None:
        with pytest.raises(DatasetValidationError, match="output"):
            promoted_record(_item(output=None), "output")

    def test_missing_expectation_refuses_naming_the_source(self) -> None:
        with pytest.raises(DatasetValidationError, match="expectation"):
            promoted_record(_item(expected={}), "expected")

    def test_expected_tools_use_the_canonical_action_format(self) -> None:
        record = promoted_record(_item(expected_tools=["search", "summarize"]), "output")
        assert record.expectations["expected_actions"] == "search;summarize"

    def test_only_allow_listed_string_metadata_becomes_tags(self) -> None:
        record = promoted_record(_item(), "output")
        assert record.tags["domain"] == "billing"
        assert "attempt" not in record.tags
        assert "internal_note" not in record.tags

    def test_capture_caveats_travel_as_tags(self) -> None:
        record = promoted_record(
            _item(
                capture_state="partial",
                evidence_policy=EvidencePolicy(
                    redaction_enabled=True, max_persisted_string_size=100
                ),
            ),
            "output",
        )
        assert record.tags["source_capture_state"] == "partial"
        assert record.tags["source_redacted"] == "true"

    def test_complete_unredacted_capture_is_tagged_false_not_absent(self) -> None:
        record = promoted_record(_item(), "output")
        assert record.tags["source_capture_state"] == "complete"
        assert record.tags["source_redacted"] == "false"

    def test_unknown_redaction_policy_never_reads_as_unredacted(self) -> None:
        # None means the policy is UNKNOWN — precisely when the caveat matters
        # most. A falsy check would tag the record as clean.
        record = promoted_record(
            _item(
                evidence_policy=EvidencePolicy(
                    redaction_enabled=None, max_persisted_string_size=None
                )
            ),
            "output",
        )
        assert record.tags["source_redacted"] == "unknown"

    def test_retention_policy_travels_with_the_record(self) -> None:
        # The text leaves the run's retention lifecycle for the dataset's;
        # the record has to say which policy it was captured under.
        record = promoted_record(_item(), "output")
        assert record.tags["source_retention_policy"] == "stored_with_run_lifecycle"

    def test_truncated_text_is_refused_not_warned(self) -> None:
        # A truncated string is a proven mutilation of the exact text being
        # installed as ground truth: no future run can ever match it.
        truncated = "a" * 50 + "[TRUNCATED]"
        with pytest.raises(DatasetValidationError, match="truncated"):
            promoted_record(_item(output={"response": truncated}), "output")

    def test_text_exactly_at_the_persistence_limit_is_still_promotable(self) -> None:
        # The persistence layer leaves a string of exactly the limit unchanged,
        # so refusing it would reject intact evidence.
        record = promoted_record(
            _item(
                output={"response": "a" * 100},
                evidence_policy=EvidencePolicy(
                    redaction_enabled=False, max_persisted_string_size=100
                ),
            ),
            "output",
        )
        assert record.expectations["expected_output"] == "a" * 100

    def test_text_longer_than_the_persistence_limit_is_refused(self) -> None:
        with pytest.raises(DatasetValidationError, match="truncated"):
            promoted_record(
                _item(
                    output={"response": "a" * 101},
                    evidence_policy=EvidencePolicy(
                        redaction_enabled=False, max_persisted_string_size=100
                    ),
                ),
                "output",
            )

    def test_retrieval_context_is_carried_so_the_task_stays_the_same(self) -> None:
        # The answer was produced WITH this context; dropping it would grade a
        # future run on a different task.
        record = promoted_record(_item(retrieval_snippets=["doc-1", "doc-2"]), "output")
        assert record.inputs["context"] == ["doc-1", "doc-2"]

    def test_run_metadata_is_allow_listed_not_type_filtered(self) -> None:
        # Run metadata originates with the evaluated workload and may carry
        # customer identifiers; only the dataset tag vocabulary is copied.
        record = promoted_record(
            _item(metadata={"domain": "billing", "customer_email": "a@b.example"}),
            "output",
        )
        assert record.tags["domain"] == "billing"
        assert "customer_email" not in record.tags


class TestPromotedRecordIsReadable:
    """The promoted shape must parse back through the bridge and the metadata
    mapping, and its identity must be stable per source item."""

    def test_bridge_reads_question_and_expectation(self) -> None:
        record = promoted_record(_item(), "output").model_dump()
        record["dataset_record_id"] = store_module.record_id_for_inputs(record["inputs"])
        row = record_to_row(record)
        assert row.query == "What is the refund window?"
        assert row.expected_response == "Refunds are accepted within 30 days."

    def test_provenance_round_trips_through_metadata(self) -> None:
        record = promoted_record(_item(), "output")
        metadata = record_metadata(record.model_dump())
        assert metadata["source_run_id"] == "run-1"
        assert metadata["source_example_id"] == "ex-1"
        assert metadata["source_trace_id"] == "trace-abc"

        inputs: dict = {"question": record.inputs["question"]}
        expectations: dict = {}
        tags: dict = {}
        metadata_to_record(metadata, inputs, expectations, tags)
        for key in ("source_run_id", "source_example_id", "source_trace_id"):
            assert inputs[key] == record.inputs[key]

    def test_record_id_distinct_per_source_item_for_the_same_question(self) -> None:
        first = promoted_record(_item(), "output")
        second = promoted_record(_item(example_id="ex-2"), "output")
        assert first.inputs["question"] == second.inputs["question"]
        assert store_module.record_id_for_inputs(first.inputs) != store_module.record_id_for_inputs(second.inputs)

    def test_record_id_stable_for_the_same_source_item(self) -> None:
        assert store_module.record_id_for_inputs(
            promoted_record(_item(), "output").inputs
        ) == store_module.record_id_for_inputs(promoted_record(_item(), "expected").inputs)


@pytest.fixture
def mock_storage() -> MagicMock:
    storage = MagicMock()
    storage.get_metadata.return_value = _meta()
    storage.upsert_record.return_value = {"record_id": "rid-1", "duplicate": False}
    return storage


@pytest.fixture
def svc(mock_storage: MagicMock) -> DatasetRegistryService:
    return DatasetRegistryService(storage=mock_storage)


def _record() -> DatasetRecord:
    return promoted_record(_item(), "output")


class TestPromoteRecordRegistry:
    def test_draft_path_upserts_with_promote_operation(
        self, svc: DatasetRegistryService, mock_storage: MagicMock
    ) -> None:
        result = svc.promote_record("ds", _record(), "tenant-1")
        args, kwargs = mock_storage.upsert_record.call_args
        assert args[0] == "ds"
        assert kwargs["operation"] == "PROMOTE"
        assert result.duplicate is False
        assert result.created_version is False
        mock_storage.clone_dataset.assert_not_called()

    def test_duplicate_flag_passes_through(
        self, svc: DatasetRegistryService, mock_storage: MagicMock
    ) -> None:
        mock_storage.upsert_record.return_value = {"record_id": "rid-1", "duplicate": True}
        assert svc.promote_record("ds", _record(), "tenant-1").duplicate is True

    def test_immutable_without_opt_in_refuses_and_writes_nothing(
        self, svc: DatasetRegistryService, mock_storage: MagicMock
    ) -> None:
        mock_storage.get_metadata.return_value = _meta(status=DatasetStatus.PUBLISHED)
        with pytest.raises(DatasetImmutableError):
            svc.promote_record("ds", _record(), "tenant-1")
        mock_storage.upsert_record.assert_not_called()
        mock_storage.clone_dataset.assert_not_called()

    @pytest.mark.parametrize("status", [DatasetStatus.REJECTED, DatasetStatus.RETIRED])
    def test_rejected_and_retired_are_not_branchable(
        self, svc: DatasetRegistryService, mock_storage: MagicMock, status: DatasetStatus
    ) -> None:
        mock_storage.get_metadata.return_value = _meta(status=status)
        with pytest.raises(InvalidTransitionError):
            svc.promote_record("ds", _record(), "tenant-1", create_version_if_immutable=True)
        mock_storage.upsert_record.assert_not_called()
        mock_storage.clone_dataset.assert_not_called()

    def test_immutable_with_opt_in_branches_with_feedback_promotion_reason(
        self, svc: DatasetRegistryService, mock_storage: MagicMock
    ) -> None:
        def _meta_for(name: str, tenant_id: str | None = None) -> DatasetMetadata:
            if name == "ds_v2":
                return _meta(status=DatasetStatus.DRAFT, version_number=2)
            return _meta(status=DatasetStatus.PUBLISHED)

        mock_storage.get_metadata.side_effect = _meta_for
        # Without this, _allocate_versioned_name never finds a free name.
        mock_storage.get_dataset.side_effect = DatasetNotFoundError("free")
        mock_storage.search_datasets.return_value = []
        mock_storage.clone_dataset.return_value = {
            "dataset_id": "id-2",
            "name": "ds_v2",
            "record_count": 3,
            "annotated": 0,
            "appended": 1,
            "duplicates": [],
        }
        result = svc.promote_record(
            "ds", _record(), "tenant-1", create_version_if_immutable=True, created_by="op"
        )
        kwargs = mock_storage.clone_dataset.call_args.kwargs
        assert kwargs["append_records"] == [_record().model_dump()]
        # The copy re-asserts the lifecycle guard against the row it reads, so
        # a transition landing after promote_record's own check still refuses.
        assert kwargs["require_branchable"] is True
        new_meta = mock_storage.clone_dataset.call_args.args[3]
        assert new_meta.change_reason == ChangeReason.FEEDBACK_PROMOTION
        assert result.created_version is True
        assert result.source_dataset_name == "ds"
        assert result.duplicate is False

    def test_branch_reports_duplicate_when_the_copy_already_held_the_row(
        self, svc: DatasetRegistryService, mock_storage: MagicMock
    ) -> None:
        def _meta_for(name: str, tenant_id: str | None = None) -> DatasetMetadata:
            if name == "ds_v2":
                return _meta(status=DatasetStatus.DRAFT, version_number=2)
            return _meta(status=DatasetStatus.PUBLISHED)

        mock_storage.get_metadata.side_effect = _meta_for
        mock_storage.get_dataset.side_effect = DatasetNotFoundError("free")
        mock_storage.search_datasets.return_value = []
        mock_storage.clone_dataset.return_value = {
            "dataset_id": "id-2",
            "name": "ds_v2",
            "record_count": 3,
            "annotated": 0,
            "appended": 0,
            "duplicates": ["rid-existing"],
        }
        result = svc.promote_record("ds", _record(), "tenant-1", create_version_if_immutable=True)
        assert result.duplicate is True
        assert result.record_id == "rid-existing"


class TestPromoteStorePaths:
    """Against the real store on the isolated per-test database."""

    def _store(self):
        return store_module.SqlDatasetStore()

    def _seed(self, store, name: str = "ds", status: DatasetStatus = DatasetStatus.DRAFT):
        store.create_dataset(name, _meta(status=DatasetStatus.DRAFT))
        store.merge_records(
            name,
            "tenant-1",
            [
                {
                    "inputs": {"question": "seed-q"},
                    "expectations": {"expected_output": "seed-a"},
                    "tags": {},
                }
            ],
        )
        if status != DatasetStatus.DRAFT:
            store.update_status(name, "tenant-1", status=status.value)
        return store

    def test_upsert_inserts_then_reports_duplicate_on_the_same_inputs(self) -> None:
        store = self._seed(self._store())
        record = _record().model_dump()
        first = store.upsert_record("ds", "tenant-1", record)
        assert first["duplicate"] is False
        second = store.upsert_record("ds", "tenant-1", record)
        assert second["duplicate"] is True
        assert second["record_id"] == first["record_id"]
        assert store.count_records("ds", "tenant-1") == 2  # seed + one promoted row

    def test_upsert_refuses_a_non_draft_dataset_at_the_write_itself(self) -> None:
        # The registry checks status first, but a transition can land between
        # its read and this write; the store is the last line.
        store = self._store()
        store.create_dataset("ds", _meta(status=DatasetStatus.PUBLISHED))
        with pytest.raises(DatasetImmutableError):
            store.upsert_record("ds", "tenant-1", _record().model_dump())

    def test_capture_caveats_survive_to_storage(self) -> None:
        # The builder producing the tags is not enough — they have to still be
        # on the row a reader loads back.
        store = self._seed(self._store())
        record = promoted_record(
            _item(
                capture_state="partial",
                evidence_policy=EvidencePolicy(
                    redaction_enabled=None, max_persisted_string_size=None
                ),
            ),
            "output",
        )
        result = store.upsert_record("ds", "tenant-1", record.model_dump())
        stored = {r["dataset_record_id"]: r for r in store.get_records("ds", "tenant-1")}
        tags = stored[result["record_id"]]["tags"]
        assert tags["source_capture_state"] == "partial"
        assert tags["source_redacted"] == "unknown"
        assert tags["source_retention_policy"] == "stored_with_run_lifecycle"

    def test_a_duplicate_upsert_still_records_a_version_event(self) -> None:
        # The append-only history is what AC3 and provenance visibility lean
        # on; a duplicate mutates the record, so it must be audited too.
        store = self._seed(self._store())
        record = _record().model_dump()
        store.upsert_record("ds", "tenant-1", record)
        before = store.get_metadata("ds", "tenant-1").version_number
        store.upsert_record("ds", "tenant-1", record)
        after = store.get_metadata("ds", "tenant-1").version_number
        assert after == before + 1
        events = [e for e in store.get_version_history("ds", "tenant-1") if e["operation"] == "PROMOTE"]
        assert len(events) == 2

    def test_upsert_writes_a_promote_version_event(self) -> None:
        store = self._seed(self._store())
        store.upsert_record("ds", "tenant-1", _record().model_dump())
        operations = [e["operation"] for e in store.get_version_history("ds", "tenant-1")]
        assert "PROMOTE" in operations

    def test_upsert_refuses_a_new_row_at_the_ceiling(self, monkeypatch) -> None:
        monkeypatch.setattr(store_module, "MAX_ROWS_PER_DATASET", 1)
        store = self._seed(self._store())
        with pytest.raises(DatasetValidationError, match="already holds"):
            store.upsert_record("ds", "tenant-1", _record().model_dump())
        # Overwriting the existing row is still allowed at the ceiling.
        seed = {
            "inputs": {"question": "seed-q"},
            "expectations": {"expected_output": "revised"},
            "tags": {},
        }
        assert store.upsert_record("ds", "tenant-1", seed)["duplicate"] is True

    def test_clone_appends_a_new_row_in_the_same_version(self) -> None:
        store = self._seed(self._store(), status=DatasetStatus.PUBLISHED)
        result = store.clone_dataset(
            "ds",
            "tenant-1",
            "ds_v2",
            _meta(status=DatasetStatus.DRAFT, version_number=2),
            append_records=[_record().model_dump()],
        )
        assert result["record_count"] == 1  # copied source rows only
        assert result["appended"] == 1
        assert result["duplicates"] == []
        assert store.count_records("ds_v2", "tenant-1") == 2

    def test_clone_upserts_onto_a_copied_row_and_reports_it(self) -> None:
        store = self._store()
        store.create_dataset("ds", _meta(status=DatasetStatus.DRAFT))
        promoted = _record().model_dump()
        store.merge_records("ds", "tenant-1", [promoted])
        store.update_status("ds", "tenant-1", status=DatasetStatus.PUBLISHED.value)
        revised = _record().model_dump()
        revised["expectations"] = {"expected_output": "revised"}
        result = store.clone_dataset(
            "ds",
            "tenant-1",
            "ds_v2",
            _meta(status=DatasetStatus.DRAFT, version_number=2),
            append_records=[revised],
        )
        assert result["appended"] == 0
        assert result["duplicates"] == [store_module.record_id_for_inputs(promoted["inputs"])]
        rows = store.get_records("ds_v2", "tenant-1")
        assert rows[0]["expectations"]["expected_output"] == "revised"

    def test_clone_append_refuses_past_the_ceiling(self, monkeypatch) -> None:
        monkeypatch.setattr(store_module, "MAX_ROWS_PER_DATASET", 1)
        store = self._seed(self._store(), status=DatasetStatus.PUBLISHED)
        with pytest.raises(DatasetValidationError, match="would exceed"):
            store.clone_dataset(
                "ds",
                "tenant-1",
                "ds_v2",
                _meta(status=DatasetStatus.DRAFT, version_number=2),
                append_records=[_record().model_dump()],
            )


OWNER = "tenant-owner"


def _as(tenant: str) -> dict[str, str]:
    return {"x-evalai-tenant": tenant}


def _body(**overrides) -> dict:
    # No tenant in the body on purpose: the dataset's own tenant scopes the run
    # lookup, so the two sides of the copy cannot be authorized differently.
    body = {"run_id": "run-1", "example_id": "ex-1"}
    body.update(overrides)
    return body


@pytest.fixture
def mock_svc() -> MagicMock:
    svc = MagicMock()
    svc.get_dataset_tenant.return_value = OWNER
    svc.promote_record.return_value = None
    return svc


@pytest.fixture
def mock_store() -> MagicMock:
    store = MagicMock()
    store.get_run_item = AsyncMock(return_value=_item())
    return store


@pytest.fixture
async def client(mock_svc: MagicMock, mock_store: MagicMock):
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    app.dependency_overrides[get_evaluation_store] = lambda: mock_store
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


class TestPromoteRoute:
    async def test_happy_path_promotes_the_fetched_item(
        self, client: AsyncClient, mock_svc: MagicMock, mock_store: MagicMock
    ) -> None:
        from evalhub.datasets.models import PromoteRunItemResult

        mock_svc.promote_record.return_value = PromoteRunItemResult(
            dataset_name="ds", record_id="rid-1", duplicate=False
        )
        resp = await client.post(
            "/datasets/ds/promotions", json=_body(), headers=_as(OWNER)
        )
        assert resp.status_code == 200
        assert resp.json()["record_id"] == "rid-1"
        mock_store.get_run_item.assert_awaited_once_with(
            "run-1", "ex-1", tenant_id=OWNER
        )

    async def test_run_tenant_mismatch_reads_as_missing_item(
        self, client: AsyncClient, mock_store: MagicMock
    ) -> None:
        mock_store.get_run_item.return_value = None
        resp = await client.post(
            "/datasets/ds/promotions", json=_body(), headers=_as(OWNER)
        )
        assert resp.status_code == 404

    async def test_the_run_is_read_under_the_datasets_own_tenant(
        self, client: AsyncClient, mock_svc: MagicMock, mock_store: MagicMock
    ) -> None:
        # The destination dataset belongs to OWNER, so the source run is looked
        # up as OWNER's — a caller cannot name the tenant the read runs under.
        from evalhub.datasets.models import PromoteRunItemResult

        mock_svc.get_dataset_tenant.return_value = OWNER
        mock_svc.promote_record.return_value = PromoteRunItemResult(
            dataset_name="ds", record_id="rid-1", duplicate=False
        )
        resp = await client.post(
            "/datasets/ds/promotions",
            json={"run_id": "run-1", "example_id": "ex-1", "tenant_id": "tenant-other"},
            headers=_as(OWNER),
        )
        assert resp.status_code == 200
        mock_store.get_run_item.assert_awaited_once_with(
            "run-1", "ex-1", tenant_id=OWNER
        )

    async def test_a_header_less_caller_cannot_choose_the_run_tenant(
        self, client: AsyncClient, mock_svc: MagicMock, mock_store: MagicMock, monkeypatch
    ) -> None:
        # Production sets POD_NAMESPACE, so the dataset guard passes for an
        # in-namespace caller with no header. The run side must be scoped by
        # the dataset's tenant regardless — never by a body-supplied one.
        from evalhub.platform import authz

        monkeypatch.setattr(authz.settings, "pod_namespace", OWNER)
        mock_svc.get_dataset_tenant.return_value = OWNER
        mock_store.get_run_item.return_value = None
        resp = await client.post(
            "/datasets/ds/promotions",
            json={"run_id": "run-1", "example_id": "ex-1", "tenant_id": "tenant-other"},
        )
        assert resp.status_code == 404
        # The confidentiality-relevant half: the foreign read never happened.
        mock_store.get_run_item.assert_awaited_once_with(
            "run-1", "ex-1", tenant_id=OWNER
        )
        mock_svc.promote_record.assert_not_called()

    async def test_a_cross_tenant_caller_never_reads_the_run(
        self, client: AsyncClient, mock_svc: MagicMock, mock_store: MagicMock
    ) -> None:
        resp = await client.post(
            "/datasets/ds/promotions", json=_body(), headers=_as("tenant-intruder")
        )
        assert resp.status_code == 404
        mock_store.get_run_item.assert_not_awaited()
        mock_svc.promote_record.assert_not_called()

    async def test_truncated_capture_is_refused_at_the_route(
        self, client: AsyncClient, mock_store: MagicMock
    ) -> None:
        mock_store.get_run_item.return_value = _item(
            output={"response": "a" * 40 + "[TRUNCATED]"}
        )
        resp = await client.post(
            "/datasets/ds/promotions", json=_body(), headers=_as(OWNER)
        )
        assert resp.status_code == 422

    async def test_immutable_without_opt_in_is_a_conflict(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        mock_svc.promote_record.side_effect = DatasetImmutableError("immutable")
        resp = await client.post(
            "/datasets/ds/promotions", json=_body(), headers=_as(OWNER)
        )
        assert resp.status_code == 409

    async def test_rejected_source_with_opt_in_is_a_conflict(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        mock_svc.promote_record.side_effect = InvalidTransitionError("not branchable")
        resp = await client.post(
            "/datasets/ds/promotions",
            json=_body(create_version_if_immutable=True),
            headers=_as(OWNER),
        )
        assert resp.status_code == 409

    async def test_unpromotable_item_is_a_validation_error(
        self, client: AsyncClient, mock_store: MagicMock
    ) -> None:
        mock_store.get_run_item.return_value = _item(output=None)
        resp = await client.post(
            "/datasets/ds/promotions", json=_body(), headers=_as(OWNER)
        )
        assert resp.status_code == 422


class TestReviewerAuthoredExpectation:
    """A reviewer's correction becomes ground truth, not a note for the judge.

    This is the annotation path other tools converge on: a human who judged a
    case wrong writes what the right answer was, and it is installed as the
    expectation later runs are graded against. It changes future scoring
    through evidence rather than by nudging a judge's opinion — which is why
    the reviewer writes an answer here and never a score.
    """

    def test_the_reviewer_s_answer_becomes_the_expectation(self):
        record = promoted_record(_item(), "reviewer", "The policy limit is ten thousand dollars.")

        assert record.expectations["expected_output"] == "The policy limit is ten thousand dollars."
        assert record.tags["expected_authored_by"] == "reviewer"

    def test_a_captured_expectation_is_still_marked_as_captured(self):
        """Provenance has to distinguish the two; a record that cannot is unauditable."""
        assert promoted_record(_item(), "output").tags["expected_authored_by"] == "capture"

    def test_an_empty_reviewer_answer_is_refused(self):
        with pytest.raises(DatasetValidationError):
            promoted_record(_item(), "reviewer", "   ")

    def test_the_request_rejects_text_that_contradicts_its_source(self):
        """Ignoring the mismatch would install one answer while claiming another."""
        with pytest.raises(ValueError):
            PromoteRunItemRequest(
                run_id="r", example_id="e", expected_source="output", expected_text="something"
            )
        with pytest.raises(ValueError):
            PromoteRunItemRequest(run_id="r", example_id="e", expected_source="reviewer")
