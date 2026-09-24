"""Add optional label annotation on evaluation runs.

Revision ID: 20260813_01
Revises: 20260803_01
Create Date: 2026-08-13
"""

import sqlalchemy as sa
from alembic import op

revision = "20260813_01"
down_revision = "20260803_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "evaluation_runs",
        sa.Column("label", sa.String(length=256), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("evaluation_runs", "label")
