"""Preserve null status for not-applicable metric results.

Revision ID: 20260820_02
Revises: 20260820_01
Create Date: 2026-08-20
"""

import sqlalchemy as sa
from alembic import op

revision = "20260820_02"
down_revision = "20260820_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("metric_results") as batch:
        batch.alter_column(
            "metric_status",
            existing_type=sa.String(32),
            nullable=True,
            server_default=None,
        )

    op.execute(
        sa.text(
            """
            UPDATE metric_results
            SET metric_status = NULL,
                unscored_reason = NULL,
                score = NULL,
                normalised_score = NULL,
                passed = NULL,
                threshold_result = NULL
            WHERE metric_applicability = 'not_applicable'
              AND (
                  metric_status IS NOT NULL
                  OR unscored_reason IS NOT NULL
                  OR score IS NOT NULL
                  OR normalised_score IS NOT NULL
                  OR passed IS NOT NULL
                  OR threshold_result IS NOT NULL
              )
            """
        )
    )


def downgrade() -> None:
    with op.batch_alter_table("metric_results") as batch:
        batch.alter_column(
            "metric_status",
            existing_type=sa.String(32),
            nullable=True,
            server_default="scored",
        )
