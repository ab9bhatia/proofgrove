"""Persist the full evaluation contract on the experiment row.

An experiment workspace is stamped by its first run, and everything that
describes WHAT was evaluated has to survive that stamp: the evaluation depth,
any named-tool selection, the threshold overrides and the target provenance all
feed ``compute_experiment_version_id``. Without these columns a stamped
workspace described a different contract from the run that stamped it. Additive
and nullable/empty: historical rows are never backfilled with invented values.

Revision ID: 20260825_01
Revises: 20260824_02
Create Date: 2026-08-25
"""

import sqlalchemy as sa
from alembic import op

revision = "20260825_01"
down_revision = "20260824_02"
branch_labels = None
depends_on = None


_TABLE = "experiments"
_COLUMNS = (
    ("evaluation_scope", sa.String(length=32)),
    ("requested_evaluation_scope", sa.String(length=32)),
    ("selected_tool_ids", sa.JSON()),
    ("kpi_threshold_overrides", sa.JSON()),
    ("requested_target_provenance", sa.JSON()),
    ("resolved_target_provenance", sa.JSON()),
    ("observed_target_provenance", sa.JSON()),
)


def upgrade() -> None:
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(_TABLE)}
    for name, type_ in _COLUMNS:
        if name not in existing:
            op.add_column(_TABLE, sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(_TABLE)}
    for name, _type in reversed(_COLUMNS):
        if name in existing:
            op.drop_column(_TABLE, name)
