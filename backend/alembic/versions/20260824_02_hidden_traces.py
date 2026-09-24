"""Add reversible trace visibility without deleting evidence.

Revision ID: 20260824_02
Revises: 20260824_01
Create Date: 2026-08-24
"""

import sqlalchemy as sa
from alembic import op

revision = "20260824_02"
down_revision = "20260824_01"
branch_labels = None
depends_on = None

_TABLE = "captured_trace_index"
_COLUMN = "hidden"


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(_TABLE)}
    if _COLUMN not in columns:
        op.add_column(
            _TABLE,
            sa.Column(_COLUMN, sa.Boolean(), nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(_TABLE)}
    if _COLUMN in columns:
        op.drop_column(_TABLE, _COLUMN)
