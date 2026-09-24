"""Add evaluator registry, closed-loop review, and platform audit records.

Revision ID: 20260731_02
Revises: 20260731_01
Create Date: 2026-07-31
"""

import sqlalchemy as sa
from alembic import op

revision = "20260731_02"
down_revision = "20260731_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "evaluator_definitions",
        sa.Column("evaluator_version_id", sa.String(length=324), primary_key=True),
        sa.Column("evaluator_id", sa.String(length=256), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("tenant_id", sa.String(length=128), nullable=True),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="draft"),
        sa.Column("execution_mode", sa.String(length=64), nullable=False),
        sa.Column("adapter", sa.String(length=64), nullable=False),
        sa.Column("implementation", sa.String(length=512), nullable=False),
        sa.Column("definition_json", sa.JSON(), nullable=False),
        sa.Column("trusted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.String(length=128), nullable=False, server_default="system"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_evaluator_definitions_evaluator_id", "evaluator_definitions", ["evaluator_id"])
    op.create_index("ix_evaluator_definitions_tenant_id", "evaluator_definitions", ["tenant_id"])

    op.create_table(
        "metric_pack_versions",
        sa.Column("metric_pack_version_id", sa.String(length=324), primary_key=True),
        sa.Column("metric_pack_id", sa.String(length=256), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("tenant_id", sa.String(length=128), nullable=True),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="draft"),
        sa.Column("pack_json", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(length=128), nullable=False, server_default="system"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_metric_pack_versions_metric_pack_id", "metric_pack_versions", ["metric_pack_id"])
    op.create_index("ix_metric_pack_versions_tenant_id", "metric_pack_versions", ["tenant_id"])

    with op.batch_alter_table("metric_results") as batch:
        batch.add_column(sa.Column("evaluator_id", sa.String(length=256), nullable=True))
        batch.add_column(sa.Column("evaluator_version", sa.String(length=64), nullable=True))
        batch.add_column(
            sa.Column("execution_status", sa.String(length=32), nullable=False, server_default="success")
        )
        batch.add_column(sa.Column("execution_metadata", sa.JSON(), nullable=False, server_default=sa.text("'{}'")))

    op.create_table(
        "findings",
        sa.Column("finding_id", sa.String(length=36), primary_key=True),
        sa.Column("run_id", sa.String(length=36), sa.ForeignKey("evaluation_runs.run_id"), nullable=False),
        sa.Column("experiment_id", sa.String(length=36), sa.ForeignKey("experiments.experiment_id"), nullable=False),
        sa.Column("row_id", sa.String(length=128), nullable=False),
        sa.Column("metric_ids", sa.JSON(), nullable=False),
        sa.Column("gate_result", sa.String(length=16), nullable=False),
        sa.Column("severity", sa.String(length=16), nullable=False),
        sa.Column("root_cause_category", sa.String(length=128), nullable=True),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="open"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_findings_run_id", "findings", ["run_id"])
    op.create_index("ix_findings_experiment_id", "findings", ["experiment_id"])
    op.create_index("ix_findings_row_id", "findings", ["row_id"])

    op.create_table(
        "review_tasks",
        sa.Column("task_id", sa.String(length=36), primary_key=True),
        sa.Column("finding_id", sa.String(length=36), sa.ForeignKey("findings.finding_id"), nullable=False),
        sa.Column("tenant_id", sa.String(length=128), nullable=True),
        sa.Column("assigned_to", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="open"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_review_tasks_finding_id", "review_tasks", ["finding_id"])
    op.create_index("ix_review_tasks_tenant_id", "review_tasks", ["tenant_id"])

    op.create_table(
        "review_decisions",
        sa.Column("decision_id", sa.String(length=36), primary_key=True),
        sa.Column("finding_id", sa.String(length=36), sa.ForeignKey("findings.finding_id"), nullable=False),
        sa.Column("task_id", sa.String(length=36), sa.ForeignKey("review_tasks.task_id"), nullable=False),
        sa.Column("reviewer", sa.String(length=128), nullable=False),
        sa.Column("outcome", sa.String(length=32), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=False),
        sa.Column("score_override", sa.Float(), nullable=True),
        sa.Column("severity", sa.String(length=16), nullable=True),
        sa.Column("root_cause_category", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_review_decisions_finding_id", "review_decisions", ["finding_id"])
    op.create_index("ix_review_decisions_task_id", "review_decisions", ["task_id"])

    op.create_table(
        "waivers",
        sa.Column("waiver_id", sa.String(length=36), primary_key=True),
        sa.Column("finding_id", sa.String(length=36), sa.ForeignKey("findings.finding_id"), nullable=False),
        sa.Column("approved_by", sa.String(length=128), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_waivers_finding_id", "waivers", ["finding_id"])

    op.create_table(
        "remediations",
        sa.Column("remediation_id", sa.String(length=36), primary_key=True),
        sa.Column("finding_id", sa.String(length=36), sa.ForeignKey("findings.finding_id"), nullable=False),
        sa.Column("owner", sa.String(length=128), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="open"),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.String(length=128), nullable=False, server_default="system"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_remediations_finding_id", "remediations", ["finding_id"])

    op.create_table(
        "regression_cases",
        sa.Column("regression_case_id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=128), nullable=True),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="approved"),
        sa.Column("finding_id", sa.String(length=36), sa.ForeignKey("findings.finding_id"), nullable=False),
        sa.Column("source_run_id", sa.String(length=36), sa.ForeignKey("evaluation_runs.run_id"), nullable=False),
        sa.Column("source_target_version_id", sa.String(length=36), nullable=True),
        sa.Column("record", sa.JSON(), nullable=False),
        sa.Column("provenance", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.String(length=128), nullable=False, server_default="system"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_regression_cases_tenant_id", "regression_cases", ["tenant_id"])
    op.create_index("ix_regression_cases_finding_id", "regression_cases", ["finding_id"])
    op.create_index("ix_regression_cases_source_run_id", "regression_cases", ["source_run_id"])

    op.create_table(
        "evidence_packs",
        sa.Column("evidence_pack_id", sa.String(length=36), primary_key=True),
        sa.Column("run_id", sa.String(length=36), sa.ForeignKey("evaluation_runs.run_id"), nullable=False, unique=True),
        sa.Column("experiment_id", sa.String(length=36), sa.ForeignKey("experiments.experiment_id"), nullable=False),
        sa.Column("overall_gate", sa.String(length=16), nullable=False),
        sa.Column("manifest_id", sa.String(length=64), nullable=True),
        sa.Column("contents", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_evidence_packs_run_id", "evidence_packs", ["run_id"])
    op.create_index("ix_evidence_packs_experiment_id", "evidence_packs", ["experiment_id"])

    op.create_table(
        "audit_events",
        sa.Column("audit_event_id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=128), nullable=True),
        sa.Column("actor", sa.String(length=128), nullable=False),
        sa.Column("action", sa.String(length=128), nullable=False),
        sa.Column("resource_type", sa.String(length=128), nullable=False),
        sa.Column("resource_id", sa.String(length=256), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_audit_events_tenant_id", "audit_events", ["tenant_id"])
    op.create_index("ix_audit_events_action", "audit_events", ["action"])
    op.create_index("ix_audit_events_resource_id", "audit_events", ["resource_id"])


def downgrade() -> None:
    op.drop_table("audit_events")
    op.drop_table("evidence_packs")
    op.drop_table("regression_cases")
    op.drop_table("remediations")
    op.drop_table("waivers")
    op.drop_table("review_decisions")
    op.drop_table("review_tasks")
    op.drop_table("findings")
    with op.batch_alter_table("metric_results") as batch:
        batch.drop_column("execution_metadata")
        batch.drop_column("execution_status")
        batch.drop_column("evaluator_version")
        batch.drop_column("evaluator_id")
    op.drop_table("metric_pack_versions")
    op.drop_table("evaluator_definitions")
