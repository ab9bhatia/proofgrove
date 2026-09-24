"""Add governed-run lineage columns to evaluation runs.

Surfaces the approved quality profile / release gate policy that governed a run
as first-class nullable columns, so a run can be identified as *governed* (and
filtered by governance) without unpacking the ``lineage`` JSON snapshot. A run
is governed only when a quality profile / gate policy resolves it — the columns
stay ``NULL`` for ungoverned runs. Additive only: no backfill of invented
values for historical rows.

Revision ID: 20260822_02
Revises: 20260822_01
Create Date: 2026-08-22
"""

import sqlalchemy as sa
from alembic import op

revision = "20260822_02"
down_revision = "20260822_01"
branch_labels = None
depends_on = None


_COLUMNS = (
    ("quality_profile_id", sa.String(length=128), True),
    ("quality_profile_version", sa.String(length=64), False),
    ("gate_policy_id", sa.String(length=128), True),
    ("gate_policy_version", sa.String(length=64), False),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = {column["name"] for column in inspector.get_columns("evaluation_runs")}
    indexes = {index["name"] for index in inspector.get_indexes("evaluation_runs")}
    for name, type_, _indexed in _COLUMNS:
        if name not in existing:
            op.add_column("evaluation_runs", sa.Column(name, type_, nullable=True))
    for name, _type, indexed in _COLUMNS:
        index_name = f"ix_evaluation_runs_{name}"
        if indexed and index_name not in indexes:
            op.create_index(index_name, "evaluation_runs", [name])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = {column["name"] for column in inspector.get_columns("evaluation_runs")}
    indexes = {index["name"] for index in inspector.get_indexes("evaluation_runs")}
    for name, _type, indexed in _COLUMNS:
        index_name = f"ix_evaluation_runs_{name}"
        if indexed and index_name in indexes:
            op.drop_index(index_name, table_name="evaluation_runs")
    for name, _type, _indexed in reversed(_COLUMNS):
        if name in existing:
            op.drop_column("evaluation_runs", name)
