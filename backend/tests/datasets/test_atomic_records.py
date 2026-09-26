"""Dataset replacement rolls back as a unit and cannot mutate validated data.

For PostgreSQL, set PROOFGROVE_TEST_POSTGRES_URL to a disposable test database
(asyncpg URL), then run ``uv run pytest --confcutdir=tests/datasets tests/datasets/test_atomic_records.py``.
The confcutdir excludes the parent SQLite-only fixtures. Each test creates
and removes its own PostgreSQL schema; no deployed database should be used.
"""

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from proofgrove.datasets.exceptions import DatasetImmutableError, DatasetValidationError
from proofgrove.datasets.models import DatasetMetadata, DatasetRecord
from proofgrove.datasets.postgres_store import SqlDatasetStore
from proofgrove.datasets.registry import DatasetRegistryService
from proofgrove.db.models import Base


@pytest.fixture
def dataset():
    url = os.environ.get("PROOFGROVE_TEST_POSTGRES_URL")
    engine = None
    schema = None
    if url:
        engine = create_engine(url.replace("+asyncpg", "+psycopg"))
        schema = f"test_records_{uuid.uuid4().hex}"
        with engine.begin() as conn:
            conn.execute(text(f'CREATE SCHEMA "{schema}"'))
        engine = engine.execution_options(schema_translate_map={None: schema})
        Base.metadata.create_all(engine)
        storage = object.__new__(SqlDatasetStore)
        storage._sessionmaker = sessionmaker(engine)
    else:
        storage = SqlDatasetStore()
    storage.create_dataset("atomic", DatasetMetadata(tenant_id="tenant-one", product_id="p", created_by="test"))
    storage.merge_records("atomic", "tenant-one", [{"inputs": {"q": "old"}}])
    registry = DatasetRegistryService(storage)
    try:
        yield storage, registry
    finally:
        if engine:
            with engine.begin() as conn:
                conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
            engine.dispose()


@pytest.mark.parametrize("failure", ["limit", "serialization"])
def test_failed_replacement_preserves_rows_and_history(dataset, failure):
    storage, registry = dataset
    before = storage.get_records("atomic", "tenant-one")
    history = storage.get_version_history("atomic", "tenant-one")
    metadata = storage.get_metadata("atomic", "tenant-one")
    if failure == "limit":
        records = [DatasetRecord(inputs={"q": str(i)}) for i in range(2001)]
        with pytest.raises(DatasetValidationError):
            registry.replace_records("atomic", records, "tenant-one")
    else:
        from sqlalchemy.exc import StatementError

        with pytest.raises((StatementError, TypeError), match="not JSON serializable"):
            storage.merge_records("atomic", "tenant-one", [{"inputs": {"q": "new"}, "tags": {"invalid": object()}}], replace=True)
    assert storage.get_records("atomic", "tenant-one") == before
    assert storage.get_version_history("atomic", "tenant-one") == history
    assert storage.get_metadata("atomic", "tenant-one") == metadata


def test_replacement_and_empty_replacement_commit_once(dataset):
    storage, registry = dataset
    version = storage.get_metadata("atomic", "tenant-one").version_number
    assert registry.replace_records("atomic", [DatasetRecord(inputs={"q": "new"})], "tenant-one") == 1
    assert [r["inputs"] for r in storage.get_records("atomic", "tenant-one")] == [{"q": "new"}]
    assert storage.get_metadata("atomic", "tenant-one").version_number == version + 1
    assert registry.replace_records("atomic", [], "tenant-one") == 0
    assert storage.get_records("atomic", "tenant-one") == []


def test_merge_rechecks_status_after_service_precheck(dataset, monkeypatch):
    storage, registry = dataset
    read_metadata = storage.get_metadata

    def stale_metadata(*args):
        metadata = read_metadata(*args)
        storage.update_status("atomic", "tenant-one", status="VALIDATED")
        return metadata

    monkeypatch.setattr(storage, "get_metadata", stale_metadata)
    with pytest.raises(DatasetImmutableError):
        registry.merge_records("atomic", "tenant-one", [DatasetRecord(inputs={"q": "new"})])
    assert [r["inputs"] for r in storage.get_records("atomic", "tenant-one")] == [{"q": "old"}]


@pytest.mark.skipif(not os.environ.get("PROOFGROVE_TEST_POSTGRES_URL"), reason="requires PostgreSQL row locks")
def test_waiting_merge_observes_committed_validation(dataset, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from proofgrove.datasets import postgres_store

    storage, _ = dataset
    reached_lock = Event()
    lookup = postgres_store._get_dataset_row

    def signal_lookup(*args, **kwargs):
        if kwargs.get("with_for_update"):
            reached_lock.set()
        return lookup(*args, **kwargs)

    with storage._sessionmaker() as validator:
        row = lookup(validator, "atomic", "tenant-one", with_for_update=True)
        row.status = "VALIDATED"
        validator.flush()
        monkeypatch.setattr(postgres_store, "_get_dataset_row", signal_lookup)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(storage.merge_records, "atomic", "tenant-one", [{"inputs": {"q": "late"}}])
            try:
                assert reached_lock.wait(timeout=5)
            finally:
                validator.commit()
            with pytest.raises(DatasetImmutableError):
                pending.result(timeout=5)
    assert [r["inputs"] for r in storage.get_records("atomic", "tenant-one")] == [{"q": "old"}]
