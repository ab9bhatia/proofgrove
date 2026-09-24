"""Persist run-item trace, usage, and lifecycle completion attestations.

Revision ID: 20260901_01
Revises: 20260827_03
Create Date: 2026-09-01
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260901_01"
down_revision = "20260827_03"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "evaluation_run_items",
        sa.Column(
            "trace_completion_attested",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "evaluation_run_items",
        sa.Column(
            "model_usage_completion_attested",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "evaluation_run_items",
        sa.Column(
            "lifecycle_completion_attested",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("evaluation_run_items", "lifecycle_completion_attested")
    op.drop_column("evaluation_run_items", "model_usage_completion_attested")
    op.drop_column("evaluation_run_items", "trace_completion_attested")
