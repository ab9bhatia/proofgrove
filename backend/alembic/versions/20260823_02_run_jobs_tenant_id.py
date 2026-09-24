"""Attribute in-flight run jobs to a tenant.

``run_jobs`` rows back the Monitor fallback for runs that have not persisted a
full result yet, but carried no tenant column — so in-flight job metadata could
not be tenant-scoped. Adds a nullable ``tenant_id`` populated at job creation;
NULL rows are legacy jobs that remain visible only to unscoped queries.

Revision ID: 20260823_02
Revises: 20260823_01
Create Date: 2026-08-23
"""

import sqlalchemy as sa
from alembic import op

revision = "20260823_02"
down_revision = "20260823_01"
branch_labels = None
depends_on = None

_TABLE = "run_jobs"
_INDEX_NAME = "ix_run_jobs_tenant_id"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns(_TABLE)}
    if "tenant_id" not in columns:
        op.add_column(_TABLE, sa.Column("tenant_id", sa.String(length=128), nullable=True))
    indexes = {index["name"] for index in inspector.get_indexes(_TABLE)}
    if _INDEX_NAME not in indexes:
        op.create_index(_INDEX_NAME, _TABLE, ["tenant_id"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE not in inspector.get_table_names():
        return
    indexes = {index["name"] for index in inspector.get_indexes(_TABLE)}
    if _INDEX_NAME in indexes:
        op.drop_index(_INDEX_NAME, table_name=_TABLE)
    columns = {column["name"] for column in inspector.get_columns(_TABLE)}
    if "tenant_id" in columns:
        op.drop_column(_TABLE, "tenant_id")
