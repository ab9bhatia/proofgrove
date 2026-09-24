"""Enforce a single BASELINE link per experiment.

Concurrent baseline promotions could each pass the read-then-demote check and
commit two ``role='baseline'`` rows for one experiment. A partial unique index
on ``(experiment_id) WHERE role = 'baseline'`` makes the database reject the
second commit; the store retries the losing promotion after re-demoting.

Pre-existing duplicates (from historical races) are resolved before the index
is created: the newest baseline link per experiment is kept, older ones are
demoted to ``exploratory`` — matching the tie-break the store already applies
when reading (`_current_baseline_run_id` takes the newest link).

Revision ID: 20260823_01
Revises: 20260822_03
Create Date: 2026-08-23
"""

import sqlalchemy as sa
from alembic import op

revision = "20260823_01"
down_revision = "20260822_03"
branch_labels = None
depends_on = None

_INDEX_NAME = "uq_experiment_run_links_baseline"
_TABLE = "experiment_run_links"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE not in inspector.get_table_names():
        # Minimal bootstrap databases (see migration tests) may not carry this
        # table; ``create_all`` builds it with the index directly from the ORM.
        return

    # Demote all but the newest baseline link per experiment so the unique
    # index can be created even if a historical race left duplicates.
    op.execute(
        sa.text(
            """
            UPDATE experiment_run_links
            SET role = 'exploratory'
            WHERE role = 'baseline'
              AND EXISTS (
                SELECT 1
                FROM experiment_run_links AS newer
                WHERE newer.experiment_id = experiment_run_links.experiment_id
                  AND newer.role = 'baseline'
                  AND (
                    newer.created_at > experiment_run_links.created_at
                    OR (
                      newer.created_at = experiment_run_links.created_at
                      AND newer.run_id > experiment_run_links.run_id
                    )
                  )
              )
            """
        )
    )

    existing = {index["name"] for index in inspector.get_indexes(_TABLE)}
    if _INDEX_NAME in existing:
        return
    op.create_index(
        _INDEX_NAME,
        _TABLE,
        ["experiment_id"],
        unique=True,
        sqlite_where=sa.text("role = 'baseline'"),
        postgresql_where=sa.text("role = 'baseline'"),
    )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE not in inspector.get_table_names():
        return
    existing = {index["name"] for index in inspector.get_indexes(_TABLE)}
    if _INDEX_NAME in existing:
        op.drop_index(_INDEX_NAME, table_name=_TABLE)
