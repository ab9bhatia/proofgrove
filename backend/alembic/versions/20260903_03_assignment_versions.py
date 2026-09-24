"""Add tenant-scoped Assignment versions.

An Assignment is a named pin of one Project and exact target version to an
approved Quality Profile and optional approved Gate Policy. The resolved run
manifest stays the immutable execution snapshot; this table is only identity,
revision lineage and catalogue metadata.

Revision ID: 20260903_03
Revises: 20260903_02
Create Date: 2026-09-03
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260903_03"
down_revision = "20260903_02"
branch_labels = None
depends_on = None

_TABLE = "assignment_versions"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE in set(inspector.get_table_names()):
        return
    op.create_table(
        _TABLE,
        sa.Column("assignment_version_id", sa.String(length=324), primary_key=True),
        sa.Column("assignment_id", sa.String(length=128), nullable=False, index=True),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("tenant_id", sa.String(length=128), nullable=False, index=True),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("purpose", sa.Text(), nullable=True),
        sa.Column("owner", sa.String(length=128), nullable=True),
        sa.Column("change_note", sa.Text(), nullable=True),
        sa.Column("project_id", sa.String(length=36), nullable=False, index=True),
        sa.Column("target_version_id", sa.String(length=36), nullable=False, index=True),
        sa.Column("profile_id", sa.String(length=128), nullable=False, index=True),
        sa.Column("profile_version", sa.String(length=64), nullable=False),
        sa.Column("gate_policy_id", sa.String(length=128), nullable=True),
        sa.Column("gate_policy_version", sa.String(length=64), nullable=True),
        sa.Column("run_manifest_id", sa.String(length=64), nullable=False, index=True),
        sa.Column("parent_assignment_version_id", sa.String(length=324), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("tenant_id", "assignment_id", "version", name="uq_assignment_version"),
    )
    op.create_index(
        "ix_assignment_versions_tenant_project",
        _TABLE,
        ["tenant_id", "project_id"],
    )
    op.create_index(
        "ix_assignment_versions_tenant_target",
        _TABLE,
        ["tenant_id", "target_version_id"],
    )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE in set(inspector.get_table_names()):
        op.drop_table(_TABLE)
