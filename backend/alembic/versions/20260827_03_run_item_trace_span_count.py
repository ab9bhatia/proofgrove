"""Persist the archived span count on a run item.

The `trace` evidence category is derived from how many spans the archive
returned for a case. Held only in memory, a reload reported the trace as never
captured when it had been — the run's own classification was correct, but any
later reclassification was not.

Revision ID: 20260827_03
Revises: 20260827_02
Create Date: 2026-08-27
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260827_03"
down_revision = "20260827_02"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "evaluation_run_items",
        sa.Column("trace_span_count", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("evaluation_run_items", "trace_span_count")
