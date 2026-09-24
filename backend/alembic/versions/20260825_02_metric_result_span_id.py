"""Persist the span a metric result was recorded against.

``MetricResult.span_id`` already existed on the domain model but had no column,
so any caller binding a score to a span lost that binding on write. Additive and
nullable: historical rows keep a NULL span, never an invented one.

Revision ID: 20260825_02
Revises: 20260825_01
Create Date: 2026-08-25
"""

import sqlalchemy as sa
from alembic import op

revision = "20260825_02"
down_revision = "20260825_01"
branch_labels = None
depends_on = None


_TABLE = "metric_results"
_COLUMN = "span_id"


def upgrade() -> None:
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(_TABLE)}
    if _COLUMN not in existing:
        op.add_column(_TABLE, sa.Column(_COLUMN, sa.String(length=128), nullable=True))


def downgrade() -> None:
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(_TABLE)}
    if _COLUMN in existing:
        op.drop_column(_TABLE, _COLUMN)
