"""Add the prompt library: saved prompt versions and moveable labels.

A prompt version is a system prompt someone chose to keep, so a run can name
what it was invoked with instead of only carrying a digest. Tenant is part of
the primary key rather than a column beside it: two tenants must both be able
to own ``support-prompt@1``.

Labels are a separate table because they move — rolling back means pointing
``production`` at an earlier version, which an append-only column on the
version row could not express.

Revision ID: 20260827_01
Revises: 20260826_01
Create Date: 2026-08-27
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260827_01"
down_revision = "20260826_01"
branch_labels = None
depends_on = None

_VERSIONS = "prompt_versions"
_LABELS = "prompt_labels"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())

    if _VERSIONS not in tables:
        op.create_table(
            _VERSIONS,
            sa.Column("prompt_version_id", sa.String(length=324), primary_key=True),
            sa.Column("prompt_id", sa.String(length=128), nullable=False, index=True),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("tenant_id", sa.String(length=128), nullable=False, index=True),
            sa.Column("name", sa.String(length=256), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("content_hash", sa.String(length=64), nullable=False, index=True),
            sa.Column("created_by", sa.String(length=128), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )

    if _LABELS not in tables:
        op.create_table(
            _LABELS,
            sa.Column("prompt_label_id", sa.String(length=36), primary_key=True),
            sa.Column("tenant_id", sa.String(length=128), nullable=False, index=True),
            sa.Column("prompt_id", sa.String(length=128), nullable=False, index=True),
            sa.Column("label", sa.String(length=64), nullable=False),
            sa.Column("prompt_version_id", sa.String(length=324), nullable=False, index=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("tenant_id", "prompt_id", "label", name="uq_prompt_label"),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if _LABELS in tables:
        op.drop_table(_LABELS)
    if _VERSIONS in tables:
        op.drop_table(_VERSIONS)
