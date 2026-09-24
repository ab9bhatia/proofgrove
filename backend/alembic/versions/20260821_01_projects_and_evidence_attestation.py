"""Add honest evidence attestation and project trace identity.

Revision ID: 20260821_01
Revises: 20260820_02
Create Date: 2026-08-21
"""

import sqlalchemy as sa
from alembic import op

revision = "20260821_01"
down_revision = "20260820_02"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    # Nullable is intentional: historical projects are not reclassified unless
    # existing data proves their purpose.
    if (
        "evaluation_projects" in tables
        and "purpose" not in {column["name"] for column in inspector.get_columns("evaluation_projects")}
    ):
        op.add_column(
            "evaluation_projects", sa.Column("purpose", sa.String(32), nullable=True)
        )

    for table in ("dataset_rows", "evaluation_run_items"):
        if table not in tables:
            continue
        columns = {column["name"] for column in inspector.get_columns(table)}
        if "tool_evidence_completion_attested" not in columns:
            op.add_column(
                table,
                sa.Column(
                    "tool_evidence_completion_attested",
                    sa.Boolean(),
                    nullable=False,
                    server_default=sa.false(),
                ),
            )
        if "tool_evidence_provenance_status" not in columns:
            op.add_column(
                table,
                sa.Column(
                    "tool_evidence_provenance_status",
                    sa.String(24),
                    nullable=False,
                    server_default="unavailable",
                ),
            )
        if "tool_evidence_source" not in columns:
            op.add_column(
                table, sa.Column("tool_evidence_source", sa.String(256), nullable=True)
            )
        if "parent_span_id" not in columns:
            op.add_column(
                table, sa.Column("parent_span_id", sa.String(128), nullable=True)
            )
        if "trace_provider" not in columns:
            op.add_column(
                table, sa.Column("trace_provider", sa.String(64), nullable=True)
            )

    if "evaluation_run_items" in tables:
        columns = {
            column["name"]
            for column in inspector.get_columns("evaluation_run_items")
        }
        if "captured_at" not in columns:
            op.add_column(
                "evaluation_run_items",
                sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
            )
        indexes = {
            index["name"] for index in inspector.get_indexes("evaluation_run_items")
        }
        if "ix_evaluation_run_items_trace_id" not in indexes:
            op.create_index(
                "ix_evaluation_run_items_trace_id",
                "evaluation_run_items",
                ["trace_id"],
            )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "evaluation_run_items" in tables:
        op.drop_index(
            "ix_evaluation_run_items_trace_id", table_name="evaluation_run_items"
        )
        op.drop_column("evaluation_run_items", "captured_at")
    for table in ("evaluation_run_items", "dataset_rows"):
        if table not in tables:
            continue
        op.drop_column(table, "trace_provider")
        op.drop_column(table, "parent_span_id")
        op.drop_column(table, "tool_evidence_source")
        op.drop_column(table, "tool_evidence_provenance_status")
        op.drop_column(table, "tool_evidence_completion_attested")
    if "evaluation_projects" in tables:
        op.drop_column("evaluation_projects", "purpose")
