"""Add indexes on hot-path query columns.

Several frequently-filtered/sorted columns had no index, forcing sequential
scans as tables grow: golden_dataset_version_events lookups by (tenant,
dataset), evaluation run listing by experiment/started_at, experiment listing
by tenant, and the run_id foreign keys on evaluator_configs / kpi_results /
review_queue. run_jobs and prompt_versions gain composite indexes matching
their common query shape (tenant+created_at paging; tenant+prompt+version
max-lookup).

Guarded and idempotent like the sibling index revisions: each index is only
created if missing, so a fresh install via ``create_all`` (which already
carries these indexes from the ORM) passes through untouched.

Revision ID: 20260915_02
Revises: 20260915_01
Create Date: 2026-09-15
"""

import sqlalchemy as sa
from alembic import op

revision = "20260915_02"
down_revision = "20260915_01"
branch_labels = None
depends_on = None

# (index_name, table, columns)
_INDEXES = [
    ("ix_golden_dataset_version_events_tenant_dataset", "golden_dataset_version_events", ["tenant_id", "dataset_name"]),
    ("ix_evaluation_runs_experiment_id", "evaluation_runs", ["experiment_id"]),
    ("ix_evaluation_runs_started_at", "evaluation_runs", ["started_at"]),
    ("ix_experiments_tenant_id", "experiments", ["tenant_id"]),
    ("ix_evaluator_configs_run_id", "evaluator_configs", ["run_id"]),
    ("ix_kpi_results_run_id", "kpi_results", ["run_id"]),
    ("ix_review_queue_run_id", "review_queue", ["run_id"]),
    ("ix_run_jobs_tenant_created", "run_jobs", ["tenant_id", "created_at"]),
    ("ix_prompt_versions_max", "prompt_versions", ["tenant_id", "prompt_id", "version"]),
]


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    for index_name, table, columns in _INDEXES:
        if table not in tables:
            continue
        table_columns = {column["name"] for column in inspector.get_columns(table)}
        if not set(columns).issubset(table_columns):
            # Legacy/partial schema (e.g. an in-progress migration chain test
            # fixture) that hasn't gained this column yet — skip, don't fail.
            continue
        existing = {index["name"] for index in inspector.get_indexes(table)}
        if index_name in existing:
            continue
        op.create_index(index_name, table, columns)


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    for index_name, table, _columns in _INDEXES:
        if table not in tables:
            continue
        existing = {index["name"] for index in inspector.get_indexes(table)}
        if index_name in existing:
            op.drop_index(index_name, table_name=table)
