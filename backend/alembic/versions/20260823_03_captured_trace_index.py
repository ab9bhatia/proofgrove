"""Collector-confirmed trace catalog: captured_trace_index + captured_span_index.

Langfuse-style worker→index projection. Raw OTLP spans stay in the S3 trace
archive; eval-hub keeps an index row per observed trace with honest lifecycle
states (requested / pending_export / archive_confirmed / archive_unavailable)
plus bounded span summary rows for confirmed traces. ``project_id`` is NULL for
production traces whose resource attributes did not resolve to a Project
binding ("Unassigned").

Revision ID: 20260823_03
Revises: 20260823_02
Create Date: 2026-08-23
"""

import sqlalchemy as sa
from alembic import op

revision = "20260823_03"
down_revision = "20260823_02"
branch_labels = None
depends_on = None

_TRACE_TABLE = "captured_trace_index"
_SPAN_TABLE = "captured_span_index"
_TRACE_INDEX = "ix_captured_trace_index_keyset"
_SPAN_INDEX = "ix_captured_span_index_keyset"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())

    if _TRACE_TABLE not in tables:
        op.create_table(
            _TRACE_TABLE,
            sa.Column("tenant_id", sa.String(length=128), primary_key=True),
            sa.Column("trace_id", sa.String(length=128), primary_key=True),
            sa.Column("project_id", sa.String(length=36), nullable=True),
            sa.Column("root_span_name", sa.String(length=512), nullable=True),
            sa.Column("root_span_kind", sa.String(length=32), nullable=True),
            sa.Column("span_count", sa.Integer(), nullable=True),
            sa.Column("error_count", sa.Integer(), nullable=True),
            sa.Column("model", sa.String(length=256), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("duration_ms", sa.Float(), nullable=True),
            sa.Column("is_evaluated", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column(
                "lifecycle_state",
                sa.String(length=32),
                nullable=False,
                server_default="requested",
            ),
            sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index(
            _TRACE_INDEX,
            _TRACE_TABLE,
            ["tenant_id", "project_id", sa.text("started_at DESC"), "trace_id"],
        )

    if _SPAN_TABLE not in tables:
        op.create_table(
            _SPAN_TABLE,
            sa.Column("tenant_id", sa.String(length=128), primary_key=True),
            sa.Column("trace_id", sa.String(length=128), primary_key=True),
            sa.Column("span_id", sa.String(length=128), primary_key=True),
            sa.Column("project_id", sa.String(length=36), nullable=True),
            sa.Column("parent_span_id", sa.String(length=128), nullable=True),
            sa.Column("name", sa.String(length=512), nullable=False),
            sa.Column("kind", sa.String(length=32), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("duration_ms", sa.Float(), nullable=True),
            sa.Column("status", sa.String(length=16), nullable=False, server_default="unset"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index(
            _SPAN_INDEX,
            _SPAN_TABLE,
            ["tenant_id", "project_id", sa.text("started_at DESC"), "trace_id", "span_id"],
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if _SPAN_TABLE in tables:
        op.drop_table(_SPAN_TABLE)
    if _TRACE_TABLE in tables:
        op.drop_table(_TRACE_TABLE)
