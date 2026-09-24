"""Persist multiple labels on evaluation runs.

Runs already expose a singular optional ``label`` for older clients. New UI
flows need multiple short tags per run, but historical rows should not be
backfilled at rest because that would assert labels the user never explicitly
typed. The JSON column stores only canonical multi-label input; read paths
derive legacy fallback labels when the column is empty.

Revision ID: 20260831_01
Revises: 20260901_01
Create Date: 2026-08-31
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260831_01"
down_revision = "20260901_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "evaluation_runs",
        sa.Column("labels", sa.JSON(), nullable=True, server_default=sa.text("'[]'")),
    )


def downgrade() -> None:
    op.drop_column("evaluation_runs", "labels")
