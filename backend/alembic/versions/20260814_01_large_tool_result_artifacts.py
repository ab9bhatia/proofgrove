"""Store oversized tool results outside inline evaluation evidence.

Revision ID: 20260814_01
Revises: 20260813_01
Create Date: 2026-08-14
"""

import sqlalchemy as sa
from alembic import op

revision = "20260814_01"
down_revision = "20260813_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "evaluation_run_items",
        sa.Column("tool_call_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "tool_result_artifacts",
        sa.Column("artifact_id", sa.String(length=36), primary_key=True),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("example_id", sa.String(length=128), nullable=False),
        sa.Column("tool_name", sa.String(length=256), nullable=False),
        sa.Column("tool_call_index", sa.Integer(), nullable=False),
        sa.Column("content_type", sa.String(length=64), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("preview", sa.Text(), nullable=False),
        sa.Column("preview_bytes", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["run_id", "example_id"],
            ["evaluation_run_items.run_id", "evaluation_run_items.example_id"],
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "ix_tool_result_artifacts_run_item",
        "tool_result_artifacts",
        ["run_id", "example_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_tool_result_artifacts_run_item", table_name="tool_result_artifacts"
    )
    op.drop_table("tool_result_artifacts")
    op.drop_column("evaluation_run_items", "tool_call_count")
