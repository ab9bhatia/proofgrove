"""Retire a prompt version without deleting it.

A run records ``prompt-id@version`` and an exact rerun replays that reference,
so a version cannot simply be removed once anything has used it — the row has
to outlive its usefulness or a run's own provenance becomes a dangling
pointer. ``archived_at`` retires a version from the pickers while leaving it
resolvable by number.

Revision ID: 20260827_02
Revises: 20260827_01
Create Date: 2026-08-27
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260827_02"
down_revision = "20260827_01"
branch_labels = None
depends_on = None

_VERSIONS = "prompt_versions"
_COLUMN = "archived_at"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _VERSIONS not in set(inspector.get_table_names()):
        # The library itself is not present; 20260827_01 creates it with this
        # column already in the model, so there is nothing to add here.
        return
    if _COLUMN in {column["name"] for column in inspector.get_columns(_VERSIONS)}:
        return
    op.add_column(_VERSIONS, sa.Column(_COLUMN, sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _VERSIONS not in set(inspector.get_table_names()):
        return
    if _COLUMN not in {column["name"] for column in inspector.get_columns(_VERSIONS)}:
        return
    op.drop_column(_VERSIONS, _COLUMN)
