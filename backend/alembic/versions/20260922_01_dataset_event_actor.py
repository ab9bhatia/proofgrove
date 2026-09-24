"""Record the actor on dataset version events.

``golden_dataset_version_events`` carried version, operation, record count and
timestamp, so the history a dataset shows could name who created it (from the
dataset's own ``created_by``) but not who validated, approved, published,
rejected or reopened it. The new nullable ``actor`` column is written from the
same authenticated-identity binding the other audit fields use. It is ``Text``
rather than a bounded varchar because neither the gateway subject nor the
request-supplied actor is length-limited upstream, and an oversized audit
value must never roll back the status change it describes.

Additive and guarded: the column is only added when missing, so a fresh
install (``create_all`` already carries it from the ORM) passes through
untouched. Existing rows keep ``NULL`` — their actor is genuinely unknown and is
never backfilled.

Revision ID: 20260922_01
Revises: 20260915_02
Create Date: 2026-09-22
"""

import sqlalchemy as sa
from alembic import op

revision = "20260922_01"
down_revision = "20260915_02"
branch_labels = None
depends_on = None

_TABLE = "golden_dataset_version_events"
_COLUMN = "actor"


def _columns() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if _TABLE not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(_TABLE)}


def upgrade() -> None:
    columns = _columns()
    if not columns or _COLUMN in columns:
        return
    op.add_column(_TABLE, sa.Column(_COLUMN, sa.Text(), nullable=True))


def downgrade() -> None:
    if _COLUMN not in _columns():
        return
    with op.batch_alter_table(_TABLE) as batch:
        batch.drop_column(_COLUMN)
