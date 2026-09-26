from typing import Any

import pytest


@pytest.fixture
def _restore_settings():
    from proofgrove.settings import settings

    previous = (settings.app_env, settings.database_auto_create)
    yield settings
    settings.app_env, settings.database_auto_create = previous


def test_init_creates_schema_in_dev_and_test(_restore_settings, monkeypatch):
    """Dev/test still get idempotent create_all -- standalone/script usage
    that never goes through the app's async ``init_db`` needs the tables."""
    from proofgrove.datasets import postgres_store

    _restore_settings.app_env = "test"
    _restore_settings.database_auto_create = False

    calls: list[Any] = []
    monkeypatch.setattr(
        postgres_store.Base.metadata, "create_all", lambda *a, **k: calls.append((a, k))
    )
    postgres_store.SqlDatasetStore()

    assert len(calls) == 1


def test_init_skips_schema_creation_in_production_without_opt_in(_restore_settings, monkeypatch):
    """Production schema changes are owned by Alembic -- a prod pod must not
    race another replica with implicit DDL, same gate as ``init_db``."""
    from proofgrove.datasets import postgres_store

    _restore_settings.app_env = "production"
    _restore_settings.database_auto_create = False

    calls: list[Any] = []
    monkeypatch.setattr(
        postgres_store.Base.metadata, "create_all", lambda *a, **k: calls.append((a, k))
    )
    postgres_store.SqlDatasetStore()

    assert calls == []


def test_init_creates_schema_in_production_with_auto_create_opt_in(_restore_settings, monkeypatch):
    """DATABASE_AUTO_CREATE=1 still allows create_all outside dev/test."""
    from proofgrove.datasets import postgres_store

    _restore_settings.app_env = "production"
    _restore_settings.database_auto_create = True

    calls: list[Any] = []
    monkeypatch.setattr(
        postgres_store.Base.metadata, "create_all", lambda *a, **k: calls.append((a, k))
    )
    postgres_store.SqlDatasetStore()

    assert len(calls) == 1


def test_records_come_back_in_the_author_s_serial_order(tmp_path):
    """A bulk upload shares one ``created_time``.

    That left the record-id tie-breaker deciding the order, so the Serial No
    column rendered the author's own numbering shuffled: 1, 4, 3, 2, 5.
    """
    from proofgrove.datasets.postgres_store import _record_sort_key

    class Row:
        def __init__(self, tags, record_id):
            self.tags = tags
            self.dataset_record_id = record_id

    shuffled = [
        Row({"serial_no": "4"}, "id-d"),
        Row({"serial_no": "1"}, "id-a"),
        Row({"serial_no": "10"}, "id-j"),
        Row({"serial_no": "2"}, "id-b"),
    ]
    ordered = sorted(shuffled, key=_record_sort_key)
    # Numeric, not lexical: "10" sorts after "2", not between "1" and "2".
    assert [r.tags["serial_no"] for r in ordered] == ["1", "2", "4", "10"]

    # The three spellings the CSV importer accepts all count.
    assert _record_sort_key(Row({"Serial No": "7"}, "x"))[1] == 7
    assert _record_sort_key(Row({"serialNo": "8"}, "x"))[1] == 8

    # Unnumbered records sort after numbered ones and keep a stable order among
    # themselves, so a partly numbered dataset never interleaves the two.
    mixed = sorted(
        [Row({}, "id-z"), Row({"serial_no": "3"}, "id-c"), Row({}, "id-y")],
        key=_record_sort_key,
    )
    assert [r.dataset_record_id for r in mixed] == ["id-c", "id-y", "id-z"]


def test_same_dataset_name_in_two_tenants_stays_isolated(tmp_path, monkeypatch):
    """Batch-1 review regression: composite identity permits the same name in
    two tenants; every scoped lookup must resolve the caller's row instead of
    raising MultipleResultsFound or 404."""
    from proofgrove.datasets.models import DatasetMetadata
    from proofgrove.datasets.postgres_store import SqlDatasetStore
    from proofgrove.settings import settings

    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{tmp_path/'dup.db'}")
    store = SqlDatasetStore()
    for tenant in ("tenant-one", "tenant-two"):
        store.create_dataset(
            dataset_name="smoke-test",
            metadata=DatasetMetadata(tenant_id=tenant, product_id="p", version_number=1, created_by="u"),
        )
    one = store.get_metadata("smoke-test", "tenant-one")
    two = store.get_metadata("smoke-test", "tenant-two")
    assert (one.tenant_id, two.tenant_id) == ("tenant-one", "tenant-two")


def test_dataset_lookup_accepts_equivalent_tenant_spellings(tmp_path, monkeypatch):
    """Batch-1 review regression: authorization accepts alias spellings
    (``a`` vs ``tenant-a``); the store filter must accept the same set."""
    from proofgrove.datasets.models import DatasetMetadata
    from proofgrove.datasets.postgres_store import SqlDatasetStore
    from proofgrove.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", "tenant-a")
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{tmp_path/'alias.db'}")
    store = SqlDatasetStore()
    store.create_dataset(
        dataset_name="alias-ds",
        metadata=DatasetMetadata(tenant_id="tenant-a", product_id="p", version_number=1, created_by="u"),
    )
    assert store.get_metadata("alias-ds", "a").tenant_id == "tenant-a"
    assert store.get_metadata("alias-ds", "tenant-a").tenant_id == "tenant-a"


def _store_with_two_owners(tmp_path, monkeypatch, db_name: str, dataset_name: str = "shared-name"):
    """Two tenants own the same dataset name, each with one record."""
    from proofgrove.datasets.models import DatasetMetadata
    from proofgrove.datasets.postgres_store import SqlDatasetStore
    from proofgrove.settings import settings

    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{tmp_path/db_name}")
    store = SqlDatasetStore()
    for tenant in ("tenant-one", "tenant-two"):
        store.create_dataset(
            dataset_name=dataset_name,
            metadata=DatasetMetadata(tenant_id=tenant, product_id="p", version_number=1, created_by="u"),
        )
        store.merge_records(
            dataset_name,
            tenant,
            [{"inputs": {"tenant": tenant}, "expectations": {}, "tags": {}}],
        )
    return store


def test_unscoped_get_dataset_raises_on_ambiguous_name(tmp_path, monkeypatch):
    """R2 regression: a name owned by two tenants must fail as a
    dataset-level error for an unscoped caller -- not leak SQLAlchemy's raw
    ``MultipleResultsFound``."""
    from sqlalchemy.exc import MultipleResultsFound

    from proofgrove.datasets.exceptions import DatasetError

    store = _store_with_two_owners(tmp_path, monkeypatch, "ambiguous-dataset.db")

    with pytest.raises(DatasetError) as excinfo:
        store.get_dataset("shared-name", None)
    assert not isinstance(excinfo.value, MultipleResultsFound)


def test_unscoped_get_records_raises_instead_of_merging_tenants(tmp_path, monkeypatch):
    """R2 regression: an unscoped read of an ambiguous name must fail, never
    silently merge both tenants' rows into one list."""
    from proofgrove.datasets.exceptions import DatasetError

    store = _store_with_two_owners(tmp_path, monkeypatch, "ambiguous-records.db")

    with pytest.raises(DatasetError):
        store.get_records("shared-name", None)


def test_unscoped_get_version_history_raises_on_ambiguous_name(tmp_path, monkeypatch):
    """R2 regression: same ambiguity guard for version history."""
    from proofgrove.datasets.exceptions import DatasetError

    store = _store_with_two_owners(tmp_path, monkeypatch, "ambiguous-history.db")

    with pytest.raises(DatasetError):
        store.get_version_history("shared-name", None)


def test_unscoped_access_still_works_for_a_single_owner(tmp_path, monkeypatch):
    """Legacy contract: an unscoped caller against a name owned by exactly
    one tenant must keep working unchanged."""
    from proofgrove.datasets.models import DatasetMetadata
    from proofgrove.datasets.postgres_store import SqlDatasetStore
    from proofgrove.settings import settings

    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{tmp_path/'single-owner.db'}")
    store = SqlDatasetStore()
    store.create_dataset(
        dataset_name="solo-name",
        metadata=DatasetMetadata(tenant_id="tenant-one", product_id="p", version_number=1, created_by="u"),
    )
    store.merge_records(
        "solo-name",
        "tenant-one",
        [{"inputs": {"k": "v"}, "expectations": {}, "tags": {}}],
    )

    handle = store.get_dataset("solo-name", None)
    assert handle.name == "solo-name"

    records = store.get_records("solo-name", None)
    assert [r["inputs"] for r in records] == [{"k": "v"}]

    history = store.get_version_history("solo-name", None)
    assert len(history) >= 1


def test_scoped_get_records_returns_only_the_right_tenant(tmp_path, monkeypatch):
    """Scoped access against a duplicated name must return only the caller's
    own rows, never the other tenant's."""
    store = _store_with_two_owners(tmp_path, monkeypatch, "scoped-records.db")

    one = store.get_records("shared-name", "tenant-one")
    two = store.get_records("shared-name", "tenant-two")

    assert [r["inputs"] for r in one] == [{"tenant": "tenant-one"}]
    assert [r["inputs"] for r in two] == [{"tenant": "tenant-two"}]


def test_version_history_records_who_changed_status(tmp_path, monkeypatch):
    """Lifecycle events carry the actor that the API bound, read back from the
    database rather than from a mocked call, and events written before the
    column existed stay unknown instead of gaining an invented identity."""
    from sqlalchemy import create_engine, text

    from proofgrove.datasets.models import DatasetMetadata
    from proofgrove.datasets.postgres_store import SqlDatasetStore
    from proofgrove.settings import settings

    database = tmp_path / "history-actor.db"
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{database}")
    store = SqlDatasetStore()
    store.create_dataset(
        dataset_name="actors",
        metadata=DatasetMetadata(tenant_id="tenant-one", product_id="p", version_number=1, created_by="user:alice"),
    )
    store.merge_records(
        "actors", "tenant-one", [{"inputs": {"question": "q"}, "expectations": {}, "tags": {}}], actor="user:alice"
    )
    store.update_status("actors", "tenant-one", status="VALIDATED", dqs=1.0, actor="user:bob")
    store.update_status("actors", "tenant-one", status="APPROVED", actor="user:carol")
    store.update_status("actors", "tenant-one", status="PUBLISHED")
    # Actors are not length-limited upstream; a long one must not be refused.
    long_actor = "user:" + "x" * 300
    store.update_status("actors", "tenant-one", status="DEPRECATED", actor=long_actor)

    engine = create_engine(f"sqlite:///{database}")
    with engine.begin() as connection:
        # A legacy row, as written before the column existed: actor is NULL.
        connection.execute(
            text(
                "INSERT INTO golden_dataset_version_events (id, tenant_id, dataset_name, version, operation,"
                " num_records, timestamp) VALUES ('legacy', 'tenant-one', 'actors', 0, 'CREATE', 0, '2026-01-01')"
            )
        )
    engine.dispose()

    fresh = SqlDatasetStore()
    by_operation = {event["operation"]: event["actor"] for event in fresh.get_version_history("actors", "tenant-one")}
    assert by_operation["CREATE"] in {"user:alice", None}  # newest-first ordering picks one of the two CREATE rows
    assert by_operation["MERGE"] == "user:alice"
    assert by_operation["STATUS:VALIDATED"] == "user:bob"
    assert by_operation["STATUS:APPROVED"] == "user:carol"
    assert by_operation["STATUS:PUBLISHED"] is None
    assert by_operation["STATUS:DEPRECATED"] == long_actor
    legacy = [event for event in fresh.get_version_history("actors", "tenant-one") if event["version"] == 0]
    assert legacy and legacy[0]["actor"] is None
