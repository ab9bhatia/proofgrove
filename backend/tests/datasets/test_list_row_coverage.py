"""Dataset listing reports what its rows are missing, in a bounded query count.

``missing_row_fields`` used to be populated only by ``_dataset_info`` (the
single-dataset read), so every row of the workbench picker resolved to unknown.
The list paths compute it too — via one bulk, per-dataset-bounded record query,
not ``get_records`` per dataset.
"""

import contextlib

import pytest
from sqlalchemy import event

from evalhub.datasets.enums import DatasetStatus
from evalhub.datasets.models import DatasetFilterParams, DatasetMetadata
from evalhub.datasets.postgres_store import SqlDatasetStore
from evalhub.datasets.registry import DatasetRegistryService
from evalhub.db.session import sync_engine


@pytest.fixture
def svc(tmp_path, monkeypatch) -> DatasetRegistryService:
    from evalhub.settings import settings

    monkeypatch.setattr(settings, "database_url", f"sqlite:///{tmp_path}/datasets.db")
    return DatasetRegistryService(storage=SqlDatasetStore())


def _seed(svc: DatasetRegistryService, name: str, records: list[dict], tenant_id: str = "t1") -> None:
    svc._storage.create_dataset(
        name,
        DatasetMetadata(
            tenant_id=tenant_id,
            product_id="p1",
            status=DatasetStatus.DRAFT,
            version_number=1,
            created_by="test",
        ),
    )
    if records:
        svc._storage.merge_records(name, tenant_id, records)


def _agent_record(i: int) -> dict:
    return {
        "inputs": {"question": f"q{i}", "context": ["doc"]},
        "expectations": {"expected_output": "a", "expected_actions": "search(q=x)"},
        "tags": {},
    }


def _chat_record(i: int) -> dict:
    return {
        "inputs": {"question": f"q{i}"},
        "expectations": {"expected_output": "a", "response": f"response {i}"},
        "tags": {},
    }


def _question_only_record(i: int) -> dict:
    return {"inputs": {"question": f"q{i}"}, "expectations": {}, "tags": {}}


@contextlib.contextmanager
def _count_selects():
    """Count SELECT statements issued against the registry's sync engine."""
    statements: list[str] = []
    engine = sync_engine()

    def _before_cursor_execute(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        if statement.lstrip().lower().startswith("select"):
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", _before_cursor_execute)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", _before_cursor_execute)


def test_listing_statement_count_does_not_grow_with_datasets(svc) -> None:
    """12 datasets must cost the same SELECTs as 2.

    Sampling rows per dataset would be one record query each (and the record
    counts already were one count each: 4 SELECTs for 2 datasets, 14 for 12).
    Both are aggregate now, so the listing is flat.
    """
    for i in range(2):
        _seed(svc, f"small_{i}", [_agent_record(j) for j in range(3)])

    with _count_selects() as small:
        items, _ = svc.list_datasets_page(DatasetFilterParams(tenant_id="t1"), limit=50)
    assert len(items) == 2

    for i in range(10):
        _seed(svc, f"big_{i}", [_agent_record(j) for j in range(3)])

    with _count_selects() as big:
        items, _ = svc.list_datasets_page(DatasetFilterParams(tenant_id="t1"), limit=50)
    assert len(items) == 12

    assert len(big) == len(small), (
        f"dataset listing scales with dataset count: {len(small)} SELECTs for 2 "
        f"datasets vs {len(big)} for 12"
    )
    assert len(big) <= 5, f"expected a bounded listing, got {len(big)} SELECTs"

    # The unpaged legacy list is the same shape.
    with _count_selects() as legacy:
        assert len(svc.list_datasets(DatasetFilterParams(tenant_id="t1"))) == 12
    assert len(legacy) <= 5


def test_listing_marks_rows_the_way_the_single_read_does(svc) -> None:
    """The picker's verdict must match ``GET /datasets/{name}``, not be inert."""
    _seed(svc, "agent_ds", [_agent_record(0)])
    _seed(svc, "chat_ds", [_chat_record(0), _chat_record(1)])
    empty_response = _chat_record(2)
    empty_response["expectations"]["response"] = ""
    _seed(svc, "empty_response_ds", [empty_response])
    _seed(svc, "question_only_ds", [_question_only_record(0)])
    _seed(svc, "questionless_ds", [{"inputs": {"note": "n"}, "expectations": {}, "tags": {}}])
    _seed(svc, "empty_ds", [])

    rows = {row["dataset_name"]: row for row in svc.list_datasets(DatasetFilterParams(tenant_id="t1"))}

    # Metadata (context, expected actions) never decides this — the two halves do.
    assert rows["agent_ds"]["missing_row_fields"] == []
    assert rows["chat_ds"]["missing_row_fields"] == []
    assert rows["question_only_ds"]["missing_row_fields"] == ["expected output"]
    assert rows["questionless_ds"]["missing_row_fields"] == ["question", "expected output"]
    assert rows["empty_ds"]["missing_row_fields"] == ["question", "expected output"]
    assert rows["agent_ds"]["missing_provided_response"] is True
    assert rows["chat_ds"]["missing_provided_response"] is False
    assert rows["empty_response_ds"]["missing_provided_response"] is False
    assert rows["question_only_ds"]["missing_provided_response"] is True

    # Identical verdict on the single-dataset read path.
    for name, row in rows.items():
        assert svc.get_dataset(name, "t1").missing_row_fields == row["missing_row_fields"]
        assert (
            svc.get_dataset(name, "t1").missing_provided_response
            == row["missing_provided_response"]
        )


def test_datasets_past_the_scan_cap_are_null_not_unusable(svc, monkeypatch) -> None:
    """Beyond the cap the field means "not computed" — never "missing something"."""
    monkeypatch.setattr("evalhub.datasets.registry.ROW_SCAN_DATASETS", 2)
    for i in range(3):
        _seed(svc, f"ds_{i}", [_agent_record(0)])

    rows = svc.list_datasets(DatasetFilterParams(tenant_id="t1"))

    computed = [row for row in rows if row["missing_row_fields"] is not None]
    assert len(computed) == 2
    assert rows[2]["missing_row_fields"] is None
    assert rows[2]["missing_provided_response"] is None


def test_clean_partial_response_sample_is_not_reported_ready(svc, monkeypatch) -> None:
    monkeypatch.setattr("evalhub.datasets.registry.ROW_SCAN_RECORDS", 2)
    _seed(svc, "large_ds", [_chat_record(i) for i in range(3)])

    listed = svc.list_datasets(DatasetFilterParams(tenant_id="t1"))[0]

    assert listed["record_count"] == 3
    assert listed["missing_provided_response"] is None
    assert svc.get_dataset("large_ds", "t1").missing_provided_response is None


@pytest.mark.parametrize("tenant_id", ["t1", "tenant-t1", "t2", "tenant-t2", None])
def test_same_name_dataset_counts_and_coverage_stay_with_the_owner(svc, tenant_id, monkeypatch):
    from evalhub.settings import settings

    namespace = f"tenant-{tenant_id.removeprefix('tenant-')}" if tenant_id else ""
    monkeypatch.setattr(settings, "pod_namespace", namespace)
    _seed(svc, "shared", [_question_only_record(0)], tenant_id="t2")
    _seed(svc, "shared", [_chat_record(1), _chat_record(2)], tenant_id="t1")
    _seed(svc, "empty_shared", [_chat_record(3)], tenant_id="t2")
    _seed(svc, "empty_shared", [], tenant_id="t1")
    expected_counts = {("t1", "shared"): 2, ("t2", "shared"): 1,
                       ("t1", "empty_shared"): 0, ("t2", "empty_shared"): 1}
    filters = DatasetFilterParams(tenant_id=tenant_id)
    with _count_selects() as statements:
        page, total = svc.list_datasets_page(filters, limit=50)
    assert len(statements) <= 5
    assert total == (4 if tenant_id is None else 2)
    assert len(page) == total
    assert page == svc.list_datasets(filters)
    for row in page:
        owner, name = row["tenant_id"], row["dataset_name"]
        assert row["record_count"] == expected_counts[owner, name]
        detail = svc.get_dataset(name, owner)
        assert row["missing_row_fields"] == detail.missing_row_fields
        assert row["missing_provided_response"] == detail.missing_provided_response
