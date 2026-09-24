"""Tests for the deployment migration entrypoint's legacy classifier."""

import pytest
from sqlalchemy import Column, Integer, MetaData, Table, create_engine

from evalhub.db.migrate import legacy_schema_revision
from evalhub.db.models import Base


def test_empty_database_is_classified_as_fresh() -> None:
    engine = create_engine("sqlite://")

    with engine.begin() as connection:
        assert legacy_schema_revision(connection) == "fresh"


def test_pre_alembic_core_schema_starts_at_base_revision() -> None:
    engine = create_engine("sqlite://")
    metadata = MetaData()
    Table("experiments", metadata, Column("id", Integer, primary_key=True))
    metadata.create_all(engine)

    with engine.begin() as connection:
        assert legacy_schema_revision(connection) == "base"


def test_current_pre_alembic_schema_is_stamped_at_head() -> None:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)

    with engine.begin() as connection:
        assert legacy_schema_revision(connection) == "head"


def test_alembic_managed_database_is_never_inferred() -> None:
    engine = create_engine("sqlite://")
    metadata = MetaData()
    Table("alembic_version", metadata, Column("version_num", Integer))
    metadata.create_all(engine)

    with engine.begin() as connection:
        assert legacy_schema_revision(connection) is None


def test_pre_alembic_schema_with_unscoped_profile_keys_is_not_stamped_at_head() -> None:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql("DROP TABLE quality_profile_versions")
        connection.exec_driver_sql(
            "CREATE TABLE quality_profile_versions (profile_version_id VARCHAR(196) PRIMARY KEY)"
        )
        assert legacy_schema_revision(connection) == "20260903_01"


def test_pre_alembic_schema_without_assignments_is_not_stamped_at_head() -> None:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql("DROP TABLE assignment_versions")
        assert legacy_schema_revision(connection) == "20260903_02"


@pytest.mark.parametrize("existing_revision", ["20260908_01", "20260909_01"])
def test_subject_migration_preserves_historical_rows_and_classifier(tmp_path, monkeypatch, existing_revision):
    from pathlib import Path

    from alembic import command
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    from sqlalchemy import inspect

    from evalhub.settings import settings

    database = tmp_path / "subject-migration.db"
    engine = create_engine(f"sqlite:///{database}")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        missing = {"subject_kind"} if existing_revision == "20260908_01" else {
            "target_trace_id", "target_span_id", "evaluator_trace_id", "evaluator_span_id",
            "feedback_scope", "annotator_kind", "evaluation_identifier",
        }
        connection.exec_driver_sql(
            "INSERT INTO metric_results (result_id, run_id, metric_id, evaluator_config_id, row_id, "
            "dataset_version, threshold, span_id, metric_requirement, metric_applicability, "
            "execution_status, execution_metadata, evaluated_at, feedback_scope) VALUES "
            "('legacy', 'run', 'metric', 'cfg', 'row', 'v1', 0.5, 'old-span', "
            "'required', 'applicable', 'success', '{}', '2026-09-09', 'span')"
        )
        for name in missing:
            connection.exec_driver_sql(f"ALTER TABLE metric_results DROP COLUMN {name}")
        assert legacy_schema_revision(connection) == existing_revision
        before = {column["name"] for column in inspect(connection).get_columns("metric_results")}
    service = Path(__file__).parents[2]
    config = Config(str(service / "alembic.ini"))
    config.set_main_option("script_location", str(service / "alembic"))
    assert ScriptDirectory.from_config(config).get_heads() == ["20260922_01"]
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{database}")
    command.stamp(config, existing_revision)
    command.upgrade(config, "head")
    with engine.begin() as connection:
        columns = {column["name"]: column for column in inspect(connection).get_columns("metric_results")}
        assert set(columns) == before | missing
        assert columns["subject_kind"]["nullable"]
        assert connection.exec_driver_sql("SELECT subject_kind, span_id FROM metric_results").one() == (None, "old-span")
    command.downgrade(config, existing_revision)
    with engine.begin() as connection:
        # Undoing a merge returns both branch heads; neither branch's data is dropped.
        assert {column["name"] for column in inspect(connection).get_columns("metric_results")} == before | missing
        # Undoing the merges leaves both branch heads applied. Downgrading TO a
        # revision keeps that branch at exactly the target, while the sibling
        # branch stays at its own head — so the surviving pair depends on which
        # branch the target lives on (20260910_01 stacked on 20260908_01 after
        # case_replays joined that side).
        expected_heads = (
            {"20260909_01", "20260910_01"}
            if existing_revision == "20260909_01"
            else {"20260908_01", "20260909_01"}
        )
        assert set(connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalars()) == expected_heads
        assert connection.exec_driver_sql("SELECT span_id FROM metric_results").scalar_one() == "old-span"
    engine.dispose()


def _legacy_name_only_golden_schema(connection) -> None:
    """The pre-20260915_01 golden-dataset shape as deployed feature DBs hold it."""
    connection.exec_driver_sql(
        "CREATE TABLE golden_datasets (dataset_name VARCHAR(256) PRIMARY KEY, tenant_id VARCHAR(128),"
        " dataset_id VARCHAR(36), product_id VARCHAR(128), status VARCHAR(32), version_number INTEGER,"
        " parent_dataset_name VARCHAR(256), dqs FLOAT, change_reason VARCHAR(64), created_by VARCHAR(128),"
        " created_at DATETIME, updated_at DATETIME)"
    )
    connection.exec_driver_sql(
        "CREATE TABLE golden_dataset_records (dataset_record_id VARCHAR(64), dataset_name VARCHAR(256)"
        " REFERENCES golden_datasets(dataset_name), inputs JSON, expectations JSON, tags JSON,"
        " created_time DATETIME, PRIMARY KEY (dataset_record_id, dataset_name))"
    )
    connection.exec_driver_sql(
        "CREATE TABLE golden_dataset_version_events (id VARCHAR(36) PRIMARY KEY, dataset_name VARCHAR(256),"
        " version INTEGER, operation VARCHAR(64), num_records INTEGER, timestamp DATETIME)"
    )


def test_database_stamped_at_previous_head_upgrades_with_tenant_backfill(tmp_path, monkeypatch):
    """Batch-1 review regression: a deployed database stamped at the previous
    head ``20260910_02`` (old revision IDs, name-only golden identity) must
    resolve every stamped ID and reach the new head with tenant_id backfilled
    from the parent dataset — history is preserved, never rewritten."""
    from pathlib import Path

    from alembic import command
    from alembic.config import Config
    from sqlalchemy import inspect

    from evalhub.settings import settings

    database = tmp_path / "stamped-legacy.db"
    engine = create_engine(f"sqlite:///{database}")
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE experiments (id VARCHAR PRIMARY KEY)")
        _legacy_name_only_golden_schema(connection)
        connection.exec_driver_sql(
            "INSERT INTO golden_datasets (dataset_name, tenant_id, dataset_id, product_id, status,"
            " version_number, created_by, created_at, updated_at)"
            " VALUES ('smoke','t1','d1','p1','DRAFT',1,'u','2026-01-01','2026-01-01')"
        )
        connection.exec_driver_sql("INSERT INTO golden_dataset_records VALUES ('r1','smoke','{}','{}','{}','2026-01-01')")
    service = Path(__file__).parents[2]
    config = Config(str(service / "alembic.ini"))
    config.set_main_option("script_location", str(service / "alembic"))
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{database}")
    command.stamp(config, "20260910_02")
    command.upgrade(config, "head")
    with engine.begin() as connection:
        columns = {c["name"] for c in inspect(connection).get_columns("golden_dataset_records")}
        assert "tenant_id" in columns
        assert connection.exec_driver_sql("SELECT tenant_id FROM golden_dataset_records").scalar_one() == "t1"
        assert connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar_one() == "20260922_01"
    engine.dispose()


def test_classifier_never_stamps_past_the_dataset_identity_migration():
    """Batch-1 review regression: a schema current everywhere EXCEPT the
    name-only golden identity must classify below 20260915_01 (never "head"),
    so the identity migration actually runs instead of being stamped over."""
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        for table in ("golden_dataset_version_events", "golden_dataset_records", "golden_datasets"):
            connection.exec_driver_sql(f"DROP TABLE {table}")
        _legacy_name_only_golden_schema(connection)
        assert legacy_schema_revision(connection) == "20260910_02"


@pytest.mark.parametrize("password", ["p%40ss", "p%25ss", "p%2Fss"])
def test_alembic_preserves_percent_encoded_database_url(monkeypatch, password):
    from io import StringIO
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    from evalhub.db.session import get_async_database_url
    from evalhub.settings import settings

    service = Path(__file__).parents[2]
    output = StringIO()
    config = Config(str(service / "alembic.ini"), output_buffer=output)
    config.set_main_option("script_location", str(service / "alembic"))
    monkeypatch.setattr(settings, "database_url", f"postgresql://test:{password}@localhost/db?sslmode=require")
    command.stamp(config, "head", sql=True)
    assert config.get_main_option("sqlalchemy.url") == get_async_database_url()
    assert "20260922_01" in output.getvalue()


@pytest.mark.parametrize("fail_stamp", [False, True])
def test_entrypoint_uses_one_transaction_for_schema_and_stamp(tmp_path, monkeypatch, fail_stamp):
    from pathlib import Path

    from sqlalchemy import inspect

    from evalhub.db import migrate
    from evalhub.settings import settings

    engine = create_engine(f"sqlite:///{tmp_path / 'entrypoint.db'}")
    monkeypatch.setattr(migrate, "sync_engine", lambda: engine)
    monkeypatch.setattr(settings, "database_url", "sqlite+aiosqlite:///:memory:")
    monkeypatch.chdir(Path(__file__).parents[2])
    stamp = migrate.command.stamp
    connections = []

    def record_stamp(config, revision):
        connection = config.attributes["connection"]
        assert connection.in_transaction()
        assert inspect(connection).has_table("experiments")
        connections.append(connection)
        stamp(config, revision)
        if fail_stamp:
            raise RuntimeError("synthetic stamp failure")

    monkeypatch.setattr(migrate.command, "stamp", record_stamp)
    if fail_stamp:
        with pytest.raises(RuntimeError, match="synthetic stamp failure"):
            migrate.main()
    else:
        migrate.main()
        migrate.main()
    assert len(connections) == 1
    assert connections[0].closed
    if fail_stamp:
        with engine.connect() as connection:
            assert inspect(connection).get_table_names() == []
        monkeypatch.setattr(migrate.command, "stamp", stamp)
        migrate.main()
    with engine.connect() as connection:
        assert connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar_one() == "20260922_01"
    engine.dispose()


def test_dataset_event_actor_column_is_added_without_touching_existing_rows(tmp_path, monkeypatch):
    """A deployed database stamped at the previous head has version events
    without an actor. Upgrading adds the nullable column, keeps every row, and
    leaves the old rows' actor NULL — unknown, never backfilled."""
    from pathlib import Path

    from alembic import command
    from alembic.config import Config
    from sqlalchemy import inspect

    from evalhub.db.migrate import legacy_schema_revision
    from evalhub.settings import settings

    database = tmp_path / "event-actor.db"
    engine = create_engine(f"sqlite:///{database}")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql("ALTER TABLE golden_dataset_version_events DROP COLUMN actor")
        connection.exec_driver_sql(
            "INSERT INTO golden_datasets (dataset_name, tenant_id, dataset_id, product_id, status,"
            " version_number, created_by, created_at, updated_at)"
            " VALUES ('smoke','t1','d1','p1','PUBLISHED',1,'u','2026-01-01','2026-01-01')"
        )
        connection.exec_driver_sql(
            "INSERT INTO golden_dataset_version_events (id, tenant_id, dataset_name, version, operation,"
            " num_records, timestamp) VALUES ('e1','t1','smoke',1,'STATUS:PUBLISHED',0,'2026-01-01')"
        )
        # A pre-Alembic schema of this shape must run 20260922_01, not be stamped past it.
        assert legacy_schema_revision(connection) == "20260915_02"
    service = Path(__file__).parents[2]
    config = Config(str(service / "alembic.ini"))
    config.set_main_option("script_location", str(service / "alembic"))
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{database}")
    command.stamp(config, "20260915_02")
    command.upgrade(config, "head")
    with engine.begin() as connection:
        columns = {c["name"] for c in inspect(connection).get_columns("golden_dataset_version_events")}
        assert "actor" in columns
        rows = connection.exec_driver_sql("SELECT id, operation, actor FROM golden_dataset_version_events").all()
        assert rows == [("e1", "STATUS:PUBLISHED", None)]
        assert connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar_one() == "20260922_01"
    # Re-running is a no-op: the guarded add_column sees the column and skips.
    command.downgrade(config, "20260915_02")
    with engine.begin() as connection:
        assert "actor" not in {c["name"] for c in inspect(connection).get_columns("golden_dataset_version_events")}
    command.upgrade(config, "head")
    engine.dispose()
