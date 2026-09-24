"""Safe Alembic entrypoint for fresh and legacy Eval Hub databases."""

from __future__ import annotations

from alembic import command
from alembic.config import Config
from sqlalchemy import Connection, inspect

from evalhub.db import models  # noqa: F401 - register all ORM tables
from evalhub.db.session import Base, sync_engine


def _columns(connection: Connection, table: str) -> set[str]:
    inspector = inspect(connection)
    if not inspector.has_table(table):
        return set()
    return {column["name"] for column in inspector.get_columns(table)}


def _string_length(connection: Connection, table: str, column: str) -> int | None:
    inspector = inspect(connection)
    if not inspector.has_table(table):
        return None
    for item in inspector.get_columns(table):
        if item["name"] == column:
            return getattr(item["type"], "length", None)
    return None


def legacy_schema_revision(connection: Connection) -> str | None:
    """Infer the last compatible revision only for pre-Alembic databases.

    Older Eval Hub versions bootstrapped ORM tables with ``create_all`` and did
    not write ``alembic_version``. This narrow classifier lets the deployment
    migration job establish history without replaying DDL that already exists.
    It never advances an already Alembic-managed database.
    """

    inspector = inspect(connection)
    tables = set(inspector.get_table_names())
    if "alembic_version" in tables:
        return None
    if "experiments" not in tables:
        return "fresh"
    if "evaluation_projects" not in tables:
        return "base"
    if "evaluator_definitions" not in tables:
        return "20260731_01"
    if "evaluation_run_items" not in tables:
        return "20260731_02"
    if "label" not in _columns(connection, "evaluation_runs"):
        return "20260803_01"
    if "tool_result_artifacts" not in tables:
        return "20260813_01"
    if "metric_status" not in _columns(connection, "metric_results"):
        return "20260814_01"
    # A legacy database that is current in every other respect still predates
    # the prompt library. Without this the classifier returns "head", the
    # deployment stamps without running DDL, and the first prompt query fails
    # on a missing table.
    if "prompt_versions" not in tables:
        return "20260826_01"
    # Same trap one revision later: the library exists but predates archiving.
    if "archived_at" not in _columns(connection, "prompt_versions"):
        return "20260827_01"

    current_columns = {
        "evaluation_projects": {"purpose"},
        "dataset_rows": {
            "tool_evidence_completion_attested",
            "tool_evidence_provenance_status",
            "tool_evidence_source",
            "parent_span_id",
            "trace_provider",
        },
        "evaluation_run_items": {
            "tool_evidence_completion_attested",
            "tool_evidence_provenance_status",
            "tool_evidence_source",
            "parent_span_id",
            "trace_provider",
            "captured_at",
        },
    }
    if all(required <= _columns(connection, table) for table, required in current_columns.items()):
        provenance_columns = {"requested_scorer", "executed_scorer"}
        if not (
            provenance_columns <= _columns(connection, "metric_results")
            and "coverage_label" in _columns(connection, "kpi_results")
        ):
            return "20260831_01"
        # 2642 landed as 20260903_01. Tenant-scoped Profile/Gate Policy keys and
        # Assignments stack after it; do not stamp head until both exist.
        if _string_length(connection, "quality_profile_versions", "profile_version_id") != 324:
            return "20260903_01"
        if "assignment_versions" not in tables:
            return "20260903_02"
        metric_columns = _columns(connection, "metric_results")
        openinference_columns = {
            "target_trace_id", "target_span_id", "evaluator_trace_id", "evaluator_span_id",
            "feedback_scope", "annotator_kind", "evaluation_identifier",
        }
        if "subject_kind" not in metric_columns:
            return "20260908_01" if openinference_columns <= metric_columns else "20260903_03"
        if not openinference_columns <= metric_columns:
            return "20260909_01"
        # Tenant-scoped dataset identity (20260915_01) rebuilt the golden-dataset
        # primary keys. A schema that still carries the name-only shape must run
        # that revision, not be stamped past it — stamping "head" here would
        # leave tenant_id absent while Alembic believes the work is done.
        if "golden_datasets" in tables and "tenant_id" not in _columns(connection, "golden_dataset_records"):
            return "20260910_02"
        # Dataset event actors (20260922_01) added a column to an existing
        # table. A pre-Alembic schema bootstrapped before it has the table but
        # not the column, so it must run that revision rather than be stamped
        # past it.
        if "golden_dataset_version_events" in tables and "actor" not in _columns(connection, "golden_dataset_version_events"):
            return "20260915_02"
        return "head"
    return "20260820_01"


def main() -> None:
    """Upgrade an existing schema, or stamp a freshly created current schema."""

    engine = sync_engine()
    with engine.begin() as connection:
        # Every replica uses the same transaction for inspection, DDL and the
        # version stamp. PostgreSQL releases the lock on commit or rollback.
        if connection.dialect.name == "postgresql":
            connection.exec_driver_sql("SELECT pg_advisory_xact_lock(hashtext('eval-hub-schema-migration'))")
        elif connection.dialect.name == "sqlite":
            # sqlite3's legacy mode otherwise leaves DDL outside the transaction.
            connection.exec_driver_sql("BEGIN")
        config = Config("alembic.ini")
        config.attributes["connection"] = connection
        revision = legacy_schema_revision(connection)
        if revision == "fresh":
            Base.metadata.create_all(connection)
            command.stamp(config, "head")
            return
        if revision not in {None, "base"}:
            command.stamp(config, revision)
        command.upgrade(config, "head")


if __name__ == "__main__":
    main()
