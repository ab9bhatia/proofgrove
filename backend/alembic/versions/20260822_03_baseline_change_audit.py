"""Add the baseline-change audit table.

Records every baseline promotion / undo on an experiment (actor, timestamp,
previous and new baseline run) so the baseline history is readable and an undo
can revert to the prior baseline. Additive only: a new nullable table, no
backfill of historical baseline promotions.

The versioned comparison basis (``comparison_basis_version``) needs no schema
change — it rides inside the existing ``evaluation_runs.lineage`` JSON snapshot,
and historical rows simply lack the key (read back as ``None``).

Revision ID: 20260822_03
Revises: 20260822_02
Create Date: 2026-08-22
"""

import sqlalchemy as sa
from alembic import op

revision = "20260822_03"
down_revision = "20260822_02"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "baseline_changes" in inspector.get_table_names():
        return
    op.create_table(
        "baseline_changes",
        sa.Column("baseline_change_id", sa.String(length=36), primary_key=True),
        sa.Column(
            "experiment_id",
            sa.String(length=36),
            sa.ForeignKey("experiments.experiment_id"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.String(length=128), nullable=True),
        sa.Column("actor", sa.String(length=128), nullable=False, server_default="system"),
        sa.Column("action", sa.String(length=32), nullable=False, server_default="promote"),
        sa.Column("previous_baseline_run_id", sa.String(length=36), nullable=True),
        sa.Column("new_baseline_run_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_baseline_changes_experiment_id", "baseline_changes", ["experiment_id"]
    )
    op.create_index("ix_baseline_changes_tenant_id", "baseline_changes", ["tenant_id"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "baseline_changes" not in inspector.get_table_names():
        return
    indexes = {index["name"] for index in inspector.get_indexes("baseline_changes")}
    for index_name in ("ix_baseline_changes_tenant_id", "ix_baseline_changes_experiment_id"):
        if index_name in indexes:
            op.drop_index(index_name, table_name="baseline_changes")
    op.drop_table("baseline_changes")
