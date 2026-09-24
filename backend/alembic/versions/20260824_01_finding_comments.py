"""F6 review collaboration: append-only finding comments.

``finding_comments`` stores collaboration comments on review findings —
author, bounded body, and server-parsed ``@mentions`` (recorded only; no
notification delivery). The activity timeline is derived from existing tables
plus this one, so no event table is created.

Revision ID: 20260824_01
Revises: 20260823_03
Create Date: 2026-08-24
"""

import sqlalchemy as sa
from alembic import op

revision = "20260824_01"
down_revision = "20260823_03"
branch_labels = None
depends_on = None

_TABLE = "finding_comments"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE in set(inspector.get_table_names()):
        return
    op.create_table(
        _TABLE,
        sa.Column("comment_id", sa.String(length=36), primary_key=True),
        sa.Column("finding_id", sa.String(length=36), sa.ForeignKey("findings.finding_id"), nullable=False),
        sa.Column("tenant_id", sa.String(length=128), nullable=True),
        sa.Column("author", sa.String(length=128), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("mentions", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_finding_comments_finding_id", _TABLE, ["finding_id"])
    op.create_index("ix_finding_comments_tenant_id", _TABLE, ["tenant_id"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE in set(inspector.get_table_names()):
        op.drop_table(_TABLE)
