"""Persist scorer provenance and required KPI coverage labels.

Revision ID: 20260903_01
Revises: 20260831_01
Create Date: 2026-09-03
"""

import sqlalchemy as sa
from alembic import op

revision = "20260903_01"
down_revision = "20260831_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("metric_results", sa.Column("requested_scorer", sa.String(32), nullable=True))
    op.add_column("metric_results", sa.Column("executed_scorer", sa.String(32), nullable=True))
    op.add_column("kpi_results", sa.Column("coverage_label", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("kpi_results", "coverage_label")
    op.drop_column("metric_results", "executed_scorer")
    op.drop_column("metric_results", "requested_scorer")
