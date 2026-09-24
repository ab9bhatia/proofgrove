"""Add first-class evaluation run-item evidence snapshots.

Revision ID: 20260803_01
Revises: 20260731_02
Create Date: 2026-08-03
"""

import sqlalchemy as sa
from alembic import op

revision = "20260803_01"
down_revision = "20260731_02"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "evaluation_run_items",
        sa.Column(
            "run_id",
            sa.String(length=36),
            sa.ForeignKey("evaluation_runs.run_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("example_id", sa.String(length=128), primary_key=True),
        sa.Column("sequence_position", sa.Integer(), nullable=False),
        sa.Column("dataset_version", sa.String(length=128), nullable=False),
        sa.Column("query", sa.Text(), nullable=True),
        sa.Column("input", sa.JSON(), nullable=False),
        sa.Column("output", sa.JSON(), nullable=True),
        sa.Column("expected", sa.JSON(), nullable=True),
        sa.Column("row_metadata", sa.JSON(), nullable=False),
        sa.Column("retrieval_snippets", sa.JSON(), nullable=False),
        sa.Column("expected_tools", sa.JSON(), nullable=False),
        sa.Column("tool_calls", sa.JSON(), nullable=False),
        sa.Column("invocation_id", sa.String(length=128), nullable=True),
        sa.Column("kagent_session_id", sa.String(length=128), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("target_usage", sa.JSON(), nullable=True),
        sa.Column("invocation_error", sa.Text(), nullable=True),
        sa.Column("trace_id", sa.String(length=128), nullable=True),
        sa.Column("span_id", sa.String(length=128), nullable=True),
        sa.Column("evidence_ref", sa.String(length=512), nullable=False),
        sa.Column("redaction_enabled", sa.Boolean(), nullable=False),
        sa.Column("max_persisted_string_size", sa.Integer(), nullable=False),
        sa.Column("capture_state", sa.String(length=16), nullable=False),
        sa.UniqueConstraint(
            "run_id",
            "sequence_position",
            name="uq_evaluation_run_items_position",
        ),
    )
    op.add_column("dataset_rows", sa.Column("input_data", sa.JSON(), nullable=True))
    op.add_column("dataset_rows", sa.Column("output_data", sa.JSON(), nullable=True))
    op.add_column("dataset_rows", sa.Column("expected_data", sa.JSON(), nullable=True))
    op.add_column(
        "dataset_rows", sa.Column("retrieval_snippets", sa.JSON(), nullable=True)
    )
    op.add_column("dataset_rows", sa.Column("span_id", sa.String(128), nullable=True))
    op.add_column(
        "dataset_rows", sa.Column("invocation_id", sa.String(128), nullable=True)
    )
    op.add_column(
        "dataset_rows", sa.Column("kagent_session_id", sa.String(128), nullable=True)
    )
    op.add_column("dataset_rows", sa.Column("latency_ms", sa.Integer(), nullable=True))
    op.add_column("dataset_rows", sa.Column("target_usage", sa.JSON(), nullable=True))
    op.add_column("dataset_rows", sa.Column("invocation_error", sa.Text(), nullable=True))
    # Nullable keeps historical rows readable without inventing source order.
    op.add_column(
        "dataset_rows",
        sa.Column("sequence_position", sa.Integer(), nullable=True),
    )
    with op.batch_alter_table("dataset_rows") as batch_op:
        batch_op.create_unique_constraint(
            "uq_dataset_rows_experiment_position",
            ["experiment_id", "sequence_position"],
        )
    op.create_index(
        "ix_metric_results_run_row",
        "metric_results",
        ["run_id", "row_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_metric_results_run_row", table_name="metric_results")
    with op.batch_alter_table("dataset_rows") as batch_op:
        batch_op.drop_constraint(
            "uq_dataset_rows_experiment_position",
            type_="unique",
        )
    op.drop_column("dataset_rows", "sequence_position")
    op.drop_column("dataset_rows", "invocation_error")
    op.drop_column("dataset_rows", "target_usage")
    op.drop_column("dataset_rows", "latency_ms")
    op.drop_column("dataset_rows", "kagent_session_id")
    op.drop_column("dataset_rows", "invocation_id")
    op.drop_column("dataset_rows", "span_id")
    op.drop_column("dataset_rows", "retrieval_snippets")
    op.drop_column("dataset_rows", "expected_data")
    op.drop_column("dataset_rows", "output_data")
    op.drop_column("dataset_rows", "input_data")
    op.drop_table("evaluation_run_items")
