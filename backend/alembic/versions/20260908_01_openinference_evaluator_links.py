"""Add explicit target/evaluator OpenInference correlation to metric results.

Revision ID: 20260908_01
Revises: 20260903_03
Create Date: 2026-09-08
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260908_01"
down_revision = "20260903_03"
branch_labels = None
depends_on = None

_TABLE = "metric_results"
_COLUMNS = {
    "target_trace_id": sa.String(length=128),
    "target_span_id": sa.String(length=128),
    "evaluator_trace_id": sa.String(length=128),
    "evaluator_span_id": sa.String(length=128),
    "feedback_scope": sa.String(length=16),
    "annotator_kind": sa.String(length=16),
    "evaluation_identifier": sa.String(length=256),
}


def upgrade() -> None:
    bind = op.get_bind()
    existing = {column["name"] for column in sa.inspect(bind).get_columns(_TABLE)}
    for name, column_type in _COLUMNS.items():
        if name not in existing:
            op.add_column(_TABLE, sa.Column(name, column_type, nullable=True))
    op.execute(sa.text("UPDATE metric_results SET feedback_scope = 'span'"))
    if "trace_id" in existing:
        op.execute(
            sa.text(
                "UPDATE metric_results SET target_trace_id = trace_id "
                "WHERE target_trace_id IS NULL"
            )
        )
    if "span_id" in existing:
        op.execute(
            sa.text(
                "UPDATE metric_results SET target_span_id = span_id "
                "WHERE target_span_id IS NULL"
            )
        )


def downgrade() -> None:
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(_TABLE)}
    for name in reversed(tuple(_COLUMNS)):
        if name in existing:
            op.drop_column(_TABLE, name)
