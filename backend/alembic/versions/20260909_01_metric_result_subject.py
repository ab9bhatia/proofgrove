"""Identify case and span scores without rewriting historical results.

Revision ID: 20260909_01
Revises: 20260903_03
Create Date: 2026-09-09
"""

import sqlalchemy as sa
from alembic import op

revision = "20260909_01"
down_revision = "20260903_03"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("metric_results", sa.Column("subject_kind", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("metric_results", "subject_kind")
