"""Persist metric applicability, honest coverage, and nullable gates.

Revision ID: 20260820_01
Revises: 20260814_01
Create Date: 2026-08-20
"""

import sqlalchemy as sa
from alembic import op

revision = "20260820_01"
down_revision = "20260814_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("evaluation_runs") as batch:
        batch.add_column(sa.Column("verdict_status", sa.String(16), nullable=True))
        batch.add_column(
            sa.Column(
                "diagnostic_only",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )
        batch.add_column(sa.Column("evidence_readiness", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("evidence_capture_status", sa.String(32), nullable=True))
        batch.add_column(
            sa.Column(
                "evidence_categories",
                sa.JSON(),
                nullable=False,
                server_default="[]",
            )
        )
        batch.alter_column("overall_gate", existing_type=sa.String(16), nullable=True)

    with op.batch_alter_table("metric_results") as batch:
        batch.add_column(
            sa.Column(
                "metric_requirement",
                sa.String(16),
                nullable=False,
                server_default="required",
            )
        )
        batch.add_column(sa.Column("metric_requirement_source", sa.String(64), nullable=True))
        batch.add_column(
            sa.Column(
                "metric_applicability",
                sa.String(32),
                nullable=False,
                server_default="applicable",
            )
        )
        batch.add_column(
            sa.Column(
                "metric_status",
                sa.String(32),
                nullable=True,
                server_default="scored",
            )
        )
        batch.add_column(sa.Column("unscored_reason", sa.String(32), nullable=True))
        batch.add_column(sa.Column("error_details", sa.JSON(), nullable=True))
        batch.alter_column("score", existing_type=sa.Float(), nullable=True)
        batch.alter_column("normalised_score", existing_type=sa.Float(), nullable=True)
        batch.alter_column("passed", existing_type=sa.Boolean(), nullable=True)
        batch.alter_column("threshold_result", existing_type=sa.String(16), nullable=True)

    with op.batch_alter_table("kpi_results") as batch:
        batch.alter_column("composite_score", existing_type=sa.Float(), nullable=True)
        batch.alter_column("gate_result", existing_type=sa.String(16), nullable=True)
        batch.add_column(sa.Column("observed_score", sa.Float(), nullable=True))
        batch.add_column(sa.Column("required_applicable_pair_count", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("required_scored_count", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("required_unscored_count", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("required_technical_error_count", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("required_coverage_percentage", sa.Float(), nullable=True))
        batch.add_column(sa.Column("optional_applicable_pair_count", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("optional_scored_count", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("optional_coverage_percentage", sa.Float(), nullable=True))

    with op.batch_alter_table("evidence_packs") as batch:
        batch.alter_column("overall_gate", existing_type=sa.String(16), nullable=True)


def downgrade() -> None:
    with op.batch_alter_table("evidence_packs") as batch:
        batch.alter_column("overall_gate", existing_type=sa.String(16), nullable=False)

    with op.batch_alter_table("kpi_results") as batch:
        batch.drop_column("optional_coverage_percentage")
        batch.drop_column("optional_scored_count")
        batch.drop_column("optional_applicable_pair_count")
        batch.drop_column("required_coverage_percentage")
        batch.drop_column("required_technical_error_count")
        batch.drop_column("required_unscored_count")
        batch.drop_column("required_scored_count")
        batch.drop_column("required_applicable_pair_count")
        batch.drop_column("observed_score")
        batch.alter_column("gate_result", existing_type=sa.String(16), nullable=False)
        batch.alter_column("composite_score", existing_type=sa.Float(), nullable=False)

    with op.batch_alter_table("metric_results") as batch:
        batch.alter_column("threshold_result", existing_type=sa.String(16), nullable=False)
        batch.alter_column("passed", existing_type=sa.Boolean(), nullable=False)
        batch.alter_column("normalised_score", existing_type=sa.Float(), nullable=False)
        batch.alter_column("score", existing_type=sa.Float(), nullable=False)
        batch.drop_column("error_details")
        batch.drop_column("unscored_reason")
        batch.drop_column("metric_status")
        batch.drop_column("metric_applicability")
        batch.drop_column("metric_requirement_source")
        batch.drop_column("metric_requirement")

    with op.batch_alter_table("evaluation_runs") as batch:
        batch.alter_column("overall_gate", existing_type=sa.String(16), nullable=False)
        batch.drop_column("evidence_categories")
        batch.drop_column("evidence_capture_status")
        batch.drop_column("evidence_readiness")
        batch.drop_column("diagnostic_only")
        batch.drop_column("verdict_status")
