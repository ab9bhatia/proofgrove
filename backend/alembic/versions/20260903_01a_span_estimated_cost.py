"""Store estimated USD cost on indexed traces and spans.

Revision ID: 20260903_01a
Revises: 20260903_01
Create Date: 2026-09-03

Renumbered on 2026-09-04. This shipped from #3153 as "20260903_01", which
#3152's scorer-provenance migration had already taken. Two files carrying one
revision id, both children of 20260831_01, left Alembic reporting multiple
heads and refusing to migrate at all — so `alembic upgrade head` fails on a
fresh database against this branch.

The second failure is quieter and worse: a database that had already recorded
"20260903_01" as applied considered this migration done, so estimated_cost_usd
was never added and the trace-cost feature reads a column that does not exist.
Chaining after 20260903_01 rather than beside it means those databases pick it
up on their next upgrade. The column steps are guarded so an environment that
did get them under the old id is not broken by re-running.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260903_01a"
down_revision = "20260903_01"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    return any(existing["name"] == column for existing in inspector.get_columns(table))


def upgrade() -> None:
    for table in ("captured_trace_index", "captured_span_index"):
        if not _has_column(table, "estimated_cost_usd"):
            op.add_column(table, sa.Column("estimated_cost_usd", sa.Float(), nullable=True))


def downgrade() -> None:
    for table in ("captured_span_index", "captured_trace_index"):
        if _has_column(table, "estimated_cost_usd"):
            op.drop_column(table, "estimated_cost_usd")
