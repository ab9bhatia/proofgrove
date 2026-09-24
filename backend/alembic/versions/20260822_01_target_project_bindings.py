"""Add target ↔ system-Project bindings.

Records, separately from immutable ``target_versions``, which tenant *system*
Project a logical target maps to for a given environment. Additive only: no
historical version rows are touched and no purpose is invented for existing data.

Revision ID: 20260822_01
Revises: 20260821_01
Create Date: 2026-08-22
"""

import sqlalchemy as sa
from alembic import op

revision = "20260822_01"
down_revision = "20260821_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "target_project_bindings" in tables:
        return
    op.create_table(
        "target_project_bindings",
        sa.Column("binding_id", sa.String(36), primary_key=True),
        sa.Column("tenant_id", sa.String(128), nullable=False),
        sa.Column("target_id", sa.String(256), nullable=False),
        sa.Column("environment", sa.String(64), nullable=False),
        sa.Column(
            "system_project_id",
            sa.String(36),
            sa.ForeignKey("evaluation_projects.project_id"),
            nullable=False,
        ),
        sa.Column("created_by", sa.String(128), nullable=False, server_default="system"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint(
            "tenant_id",
            "target_id",
            "environment",
            name="uq_target_project_binding",
        ),
    )
    op.create_index(
        "ix_target_project_bindings_tenant_id",
        "target_project_bindings",
        ["tenant_id"],
    )
    op.create_index(
        "ix_target_project_bindings_target_id",
        "target_project_bindings",
        ["target_id"],
    )
    op.create_index(
        "ix_target_project_bindings_system_project_id",
        "target_project_bindings",
        ["system_project_id"],
    )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "target_project_bindings" not in set(inspector.get_table_names()):
        return
    op.drop_index(
        "ix_target_project_bindings_system_project_id",
        table_name="target_project_bindings",
    )
    op.drop_index(
        "ix_target_project_bindings_target_id",
        table_name="target_project_bindings",
    )
    op.drop_index(
        "ix_target_project_bindings_tenant_id",
        table_name="target_project_bindings",
    )
    op.drop_table("target_project_bindings")
