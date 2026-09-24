"""Persist single-case prompt replays as isolated evidence.

``case_replays`` records each ad-hoc re-invocation of one evaluated case with
a different prompt (#3317): the prompt reference or hash, the model invoked,
the new response and its measurements. Rows are lineage back to the source
``(run_id, example_id)`` and are deliberately joined by no report, export,
comparison, or review query — a replay never changes case-facing results.

Revision ID: 20260910_01
Revises: 20260908_01
Create Date: 2026-09-10
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260910_01"
down_revision = "20260908_01"
branch_labels = None
depends_on = None

_TABLE = "case_replays"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE in set(inspector.get_table_names()):
        return
    op.create_table(
        _TABLE,
        sa.Column("replay_id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=128), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("example_id", sa.String(length=128), nullable=False),
        sa.Column("prompt_version_ref", sa.String(length=256), nullable=True),
        sa.Column("prompt_hash", sa.String(length=128), nullable=True),
        sa.Column("system_prompt", sa.Text(), nullable=True),
        sa.Column("target_model", sa.String(length=128), nullable=False),
        sa.Column("target_endpoint", sa.String(length=512), nullable=True),
        sa.Column("response", sa.Text(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("target_usage", sa.JSON(), nullable=True),
        sa.Column("invocation_error", sa.Text(), nullable=True),
        sa.Column("invocation_id", sa.String(length=128), nullable=True),
        sa.Column("trace_id", sa.String(length=128), nullable=True),
        sa.Column("span_id", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(length=128), nullable=False),
    )
    op.create_index("ix_case_replays_case", _TABLE, ["tenant_id", "run_id", "example_id"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE in set(inspector.get_table_names()):
        op.drop_table(_TABLE)
