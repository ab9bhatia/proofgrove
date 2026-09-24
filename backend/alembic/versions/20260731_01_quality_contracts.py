"""Add Eval Hub quality-contract control-plane records.

Revision ID: 20260731_01
Revises:
Create Date: 2026-07-31
"""

import sqlalchemy as sa
from alembic import op

revision = "20260731_01"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "evaluation_projects",
        sa.Column("project_id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("system_type", sa.String(length=128), nullable=False),
        sa.Column("owner", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(length=128), nullable=False, server_default="system"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_evaluation_projects_tenant_id", "evaluation_projects", ["tenant_id"])
    op.create_table(
        "target_versions",
        sa.Column("target_version_id", sa.String(length=36), primary_key=True),
        sa.Column("target_id", sa.String(length=256), nullable=False),
        sa.Column("project_id", sa.String(length=36), sa.ForeignKey("evaluation_projects.project_id"), nullable=False),
        sa.Column("tenant_id", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("version", sa.String(length=128), nullable=False),
        sa.Column("endpoint", sa.String(length=1024), nullable=False),
        sa.Column("target_type", sa.String(length=64), nullable=False, server_default="endpoint"),
        sa.Column("environment", sa.String(length=64), nullable=False, server_default="dev"),
        sa.Column("model_version", sa.String(length=256), nullable=True),
        sa.Column("prompt_version", sa.String(length=256), nullable=True),
        sa.Column("tool_versions", sa.JSON(), nullable=False),
        sa.Column("configuration", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(length=128), nullable=False, server_default="system"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_target_versions_target_id", "target_versions", ["target_id"])
    op.create_index("ix_target_versions_project_id", "target_versions", ["project_id"])
    op.create_index("ix_target_versions_tenant_id", "target_versions", ["tenant_id"])
    op.create_table(
        "quality_profile_versions",
        sa.Column("profile_version_id", sa.String(length=196), primary_key=True),
        sa.Column("profile_id", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("tenant_id", sa.String(length=128), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=True),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="draft"),
        sa.Column("scenario", sa.String(length=64), nullable=True),
        sa.Column("contract_json", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(length=128), nullable=False, server_default="system"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_quality_profile_versions_profile_id", "quality_profile_versions", ["profile_id"])
    op.create_index("ix_quality_profile_versions_tenant_id", "quality_profile_versions", ["tenant_id"])
    op.create_index("ix_quality_profile_versions_project_id", "quality_profile_versions", ["project_id"])
    op.create_table(
        "release_gate_policy_versions",
        sa.Column("gate_policy_version_id", sa.String(length=196), primary_key=True),
        sa.Column("gate_policy_id", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("tenant_id", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="draft"),
        sa.Column("policy_json", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(length=128), nullable=False, server_default="system"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_release_gate_policy_versions_gate_policy_id", "release_gate_policy_versions", ["gate_policy_id"])
    op.create_index("ix_release_gate_policy_versions_tenant_id", "release_gate_policy_versions", ["tenant_id"])
    op.create_table(
        "run_manifests",
        sa.Column("manifest_id", sa.String(length=64), primary_key=True),
        sa.Column("manifest_hash", sa.String(length=64), nullable=False, unique=True),
        sa.Column("tenant_id", sa.String(length=128), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("target_version_id", sa.String(length=36), nullable=False),
        sa.Column("profile_id", sa.String(length=128), nullable=False),
        sa.Column("profile_version", sa.String(length=64), nullable=False),
        sa.Column("gate_policy_id", sa.String(length=128), nullable=True),
        sa.Column("gate_policy_version", sa.String(length=64), nullable=True),
        sa.Column("manifest_json", sa.JSON(), nullable=False),
        sa.Column("resolved_by", sa.String(length=128), nullable=False, server_default="system"),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_run_manifests_manifest_hash", "run_manifests", ["manifest_hash"])
    op.create_index("ix_run_manifests_tenant_id", "run_manifests", ["tenant_id"])
    op.create_index("ix_run_manifests_project_id", "run_manifests", ["project_id"])
    op.create_index("ix_run_manifests_target_version_id", "run_manifests", ["target_version_id"])
    op.create_index("ix_run_manifests_profile_id", "run_manifests", ["profile_id"])
    with op.batch_alter_table("experiments") as batch:
        batch.add_column(sa.Column("project_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("target_version_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("gate_policy_id", sa.String(length=128), nullable=True))
        batch.add_column(sa.Column("gate_policy_version", sa.String(length=64), nullable=True))
        batch.add_column(sa.Column("run_manifest_id", sa.String(length=64), nullable=True))
        batch.create_index("ix_experiments_project_id", ["project_id"])
        batch.create_index("ix_experiments_run_manifest_id", ["run_manifest_id"])
    with op.batch_alter_table("evaluation_runs") as batch:
        batch.add_column(sa.Column("run_manifest_id", sa.String(length=64), nullable=True))
        batch.create_index("ix_evaluation_runs_run_manifest_id", ["run_manifest_id"])


def downgrade() -> None:
    with op.batch_alter_table("evaluation_runs") as batch:
        batch.drop_index("ix_evaluation_runs_run_manifest_id")
        batch.drop_column("run_manifest_id")
    with op.batch_alter_table("experiments") as batch:
        batch.drop_index("ix_experiments_run_manifest_id")
        batch.drop_index("ix_experiments_project_id")
        batch.drop_column("run_manifest_id")
        batch.drop_column("gate_policy_version")
        batch.drop_column("gate_policy_id")
        batch.drop_column("target_version_id")
        batch.drop_column("project_id")
    op.drop_table("run_manifests")
    op.drop_table("release_gate_policy_versions")
    op.drop_table("quality_profile_versions")
    op.drop_table("target_versions")
    op.drop_table("evaluation_projects")
