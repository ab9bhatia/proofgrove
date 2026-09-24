"""Drop the golden dataset ``dataset_type`` label.

A dataset is a question + expected output + metadata; what it is evaluated
against is chosen per run, not fixed at upload time. The column only ever fed a
UI filter and the weakest rung of the scenario precedence, both of which are
gone, so the label is removed rather than left to rot.

Irreversible in content: the downgrade re-adds the column with an empty value
because the labels themselves are not recoverable.

Revision ID: 20260825_03
Revises: 20260825_02
Create Date: 2026-08-25
"""

import sqlalchemy as sa
from alembic import op

revision = "20260825_03"
down_revision = "20260825_02"
branch_labels = None
depends_on = None


_TABLE = "golden_datasets"
_COLUMN = "dataset_type"


def _columns() -> set[str]:
    """Column names of the registry table, empty when it does not exist yet."""
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_TABLE):
        return set()
    return {column["name"] for column in inspector.get_columns(_TABLE)}


def upgrade() -> None:
    if _COLUMN in _columns():
        op.drop_column(_TABLE, _COLUMN)


def downgrade() -> None:
    existing = _columns()
    if existing and _COLUMN not in existing:
        op.add_column(
            _TABLE,
            sa.Column(_COLUMN, sa.String(length=32), nullable=False, server_default=""),
        )
