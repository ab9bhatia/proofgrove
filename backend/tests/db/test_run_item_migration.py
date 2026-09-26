"""Migration smoke test for first-class run-item evidence."""

import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations

from proofgrove.settings import settings


def _load_migration():
    path = Path(__file__).parents[2] / "alembic" / "versions" / "20260803_01_evaluation_run_items.py"
    spec = importlib.util.spec_from_file_location("run_item_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_run_item_migration_upgrades_and_downgrades() -> None:
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    sa.Table(
        "evaluation_runs",
        metadata,
        sa.Column("run_id", sa.String(36), primary_key=True),
    )
    sa.Table(
        "dataset_rows",
        metadata,
        sa.Column("row_id", sa.String(128), primary_key=True),
        sa.Column("experiment_id", sa.String(36), nullable=False),
    )
    sa.Table(
        "metric_results",
        metadata,
        sa.Column("result_id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), nullable=False),
        sa.Column("row_id", sa.String(128), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        migration = _load_migration()
        migration.op = Operations(MigrationContext.configure(connection))

        migration.upgrade()
        inspector = sa.inspect(connection)
        assert "evaluation_run_items" in inspector.get_table_names()
        assert {column["name"] for column in inspector.get_columns("evaluation_run_items")} >= {
            "run_id",
            "example_id",
            "sequence_position",
            "query",
            "input",
            "output",
            "expected",
            "trace_id",
            "span_id",
            "evidence_ref",
        }
        assert inspector.get_pk_constraint("evaluation_run_items")["constrained_columns"] == ["run_id", "example_id"]
        assert {column["name"] for column in inspector.get_columns("dataset_rows")} >= {
            "input_data",
            "output_data",
            "expected_data",
            "retrieval_snippets",
            "span_id",
            "invocation_id",
            "kagent_session_id",
            "latency_ms",
            "target_usage",
            "invocation_error",
            "sequence_position",
        }
        assert any(constraint["name"] == "uq_dataset_rows_experiment_position" and constraint["column_names"] == ["experiment_id", "sequence_position"] for constraint in inspector.get_unique_constraints("dataset_rows"))
        assert "ix_metric_results_run_row" in {index["name"] for index in inspector.get_indexes("metric_results")}

        migration.downgrade()
        inspector = sa.inspect(connection)
        assert "evaluation_run_items" not in inspector.get_table_names()
        assert "input_data" not in {column["name"] for column in inspector.get_columns("dataset_rows")}
        assert "ix_metric_results_run_row" not in {index["name"] for index in inspector.get_indexes("metric_results")}


def test_alembic_online_upgrade_reaches_head_from_previous_revision(tmp_path) -> None:
    """Exercise the real async Alembic environment, not only migration functions."""
    service_root = Path(__file__).parents[2]
    database_path = tmp_path / "proofgrove-migration.db"
    sync_url = f"sqlite:///{database_path}"
    async_url = f"sqlite+aiosqlite:///{database_path}"

    engine = sa.create_engine(sync_url)
    metadata = sa.MetaData()
    sa.Table(
        "evaluation_runs",
        metadata,
        sa.Column("run_id", sa.String(36), primary_key=True),
        sa.Column("overall_gate", sa.String(16), nullable=False),
    )
    sa.Table(
        "dataset_rows",
        metadata,
        sa.Column("row_id", sa.String(128), primary_key=True),
        sa.Column("experiment_id", sa.String(36), nullable=False),
    )
    sa.Table(
        "metric_results",
        metadata,
        sa.Column("result_id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), nullable=False),
        sa.Column("row_id", sa.String(128), nullable=False),
        sa.Column("score", sa.Float(), nullable=False),
        sa.Column("normalised_score", sa.Float(), nullable=False),
        sa.Column("passed", sa.Boolean(), nullable=False),
        sa.Column("threshold_result", sa.String(16), nullable=False),
    )
    sa.Table(
        "kpi_results",
        metadata,
        sa.Column("result_id", sa.String(36), primary_key=True),
        sa.Column("composite_score", sa.Float(), nullable=False),
        sa.Column("gate_result", sa.String(16), nullable=False),
    )
    sa.Table(
        "evidence_packs",
        metadata,
        sa.Column("evidence_pack_id", sa.String(36), primary_key=True),
        sa.Column("overall_gate", sa.String(16), nullable=False),
    )
    sa.Table(
        "experiments",
        metadata,
        sa.Column("experiment_id", sa.String(36), primary_key=True),
        sa.Column("scenario", sa.String(64), nullable=False),
    )
    metadata.create_all(engine)

    config = Config(str(service_root / "alembic.ini"))
    config.set_main_option("script_location", str(service_root / "alembic"))
    prior_url = settings.database_url
    settings.database_url = async_url
    try:
        command.stamp(config, "20260731_02")
        command.upgrade(config, "20260820_01")
        with engine.begin() as connection:
            connection.execute(
                sa.text(
                    """
                    INSERT INTO metric_results (
                        result_id, run_id, row_id, score, normalised_score,
                        passed, threshold_result, metric_applicability, metric_status
                    ) VALUES (
                        'invalid-na', 'run-1', 'row-1', NULL, NULL,
                        NULL, NULL, 'not_applicable', 'scored'
                    )
                    """
                )
            )
        command.upgrade(config, "head")
    finally:
        settings.database_url = prior_url

    inspector = sa.inspect(engine)
    assert "evaluation_run_items" in inspector.get_table_names()
    assert "tool_result_artifacts" in inspector.get_table_names()
    assert {column["name"] for column in inspector.get_columns("dataset_rows")} >= {
        "input_data",
        "output_data",
        "expected_data",
        "retrieval_snippets",
        "span_id",
        "invocation_id",
        "kagent_session_id",
        "latency_ms",
        "target_usage",
        "invocation_error",
        "sequence_position",
    }
    run_item_columns = {
        column["name"] for column in inspector.get_columns("evaluation_run_items")
    }
    assert "query" in run_item_columns
    assert "tool_call_count" in run_item_columns
    assert run_item_columns >= {
        "trace_completion_attested",
        "model_usage_completion_attested",
        "lifecycle_completion_attested",
    }
    metric_result_columns = {
        column["name"]: column for column in inspector.get_columns("metric_results")
    }
    assert set(metric_result_columns) >= {
        "metric_requirement",
        "metric_applicability",
        "metric_status",
        "unscored_reason",
        "error_details",
        "span_id",
        "target_trace_id",
        "target_span_id",
        "evaluator_trace_id",
        "evaluator_span_id",
        "feedback_scope",
        "annotator_kind",
        "evaluation_identifier",
        "requested_scorer",
        "executed_scorer",
    }
    assert metric_result_columns["metric_status"]["default"] is None
    with engine.connect() as connection:
        feedback_scope = connection.scalar(
            sa.text(
                "SELECT feedback_scope FROM metric_results "
                "WHERE result_id = 'invalid-na'"
            )
        )
    assert feedback_scope == "span"
    assert {column["name"] for column in inspector.get_columns("kpi_results")} >= {
        "observed_score",
        "required_coverage_percentage",
        "optional_coverage_percentage",
        "coverage_label",
    }
    assert {column["name"] for column in inspector.get_columns("evaluation_runs")} >= {
        "verdict_status",
        "diagnostic_only",
        "evidence_readiness",
        "evidence_capture_status",
        "evidence_categories",
        "labels",
    }
    assert {column["name"] for column in inspector.get_columns("captured_trace_index")} >= {
        "hidden",
        "span_index_rev",
        "estimated_cost_usd",
    }
    # The migration is the only thing that builds the production schema, so the
    # span summary columns have to be asserted here — the rest of the suite
    # builds its schema from the ORM metadata and would not notice the drift.
    assert {column["name"] for column in inspector.get_columns("captured_span_index")} >= {
        "semantic_kind",
        "input_preview",
        "output_preview",
        "llm_token_count_prompt",
        "llm_token_count_completion",
        "estimated_cost_usd",
    }
    assert {column["name"] for column in inspector.get_columns("experiments")} >= {
        "evaluation_scope",
        "requested_evaluation_scope",
        "selected_tool_ids",
        "kpi_threshold_overrides",
        "requested_target_provenance",
        "resolved_target_provenance",
        "observed_target_provenance",
    }
    assert any(constraint["name"] == "uq_dataset_rows_experiment_position" and constraint["column_names"] == ["experiment_id", "sequence_position"] for constraint in inspector.get_unique_constraints("dataset_rows"))
    with engine.connect() as connection:
        # Derived, not pinned: a hardcoded head makes every new migration fail
        # this test for the wrong reason. What matters is that the upgrade
        # reached whatever the current head is.
        from alembic.config import Config as _AlembicConfig
        from alembic.script import ScriptDirectory as _ScriptDirectory

        _script = _ScriptDirectory.from_config(
            _AlembicConfig(str(Path(__file__).resolve().parents[2] / "alembic.ini"))
        )
        assert connection.scalar(
            sa.text("select version_num from alembic_version")
        ) == _script.get_current_head()
        repaired = connection.execute(
            sa.text(
                """
                SELECT metric_status, unscored_reason, score, normalised_score,
                       passed, threshold_result
                FROM metric_results
                WHERE result_id = 'invalid-na'
                """
            )
        ).one()
        assert tuple(repaired) == (None, None, None, None, None, None)

    prior_url = settings.database_url
    settings.database_url = async_url
    try:
        command.downgrade(config, "20260831_01")
    finally:
        settings.database_url = prior_url
    inspector = sa.inspect(engine)
    metric_columns = {
        column["name"] for column in inspector.get_columns("metric_results")
    }
    kpi_columns = {
        column["name"] for column in inspector.get_columns("kpi_results")
    }
    assert "requested_scorer" not in metric_columns
    assert "executed_scorer" not in metric_columns
    assert "coverage_label" not in kpi_columns
