"""Record what each archived span did, so the span listing can show real work.

The span index stored only a name and the OTLP transport kind, which cannot
distinguish a model call from queue plumbing — and archived traces run heavily
to plumbing. These columns carry the derived semantic kind, bounded previews of
the recorded input and output, and token counts, so the listing can filter and
summarise server-side instead of guessing client-side after pagination.

``span_index_rev`` on the trace row stamps which derivation produced that
trace's span rows; rows below the current revision are rebuilt by the index
worker. All additive and nullable: existing rows keep NULLs until re-derived,
never invented values.

Revision ID: 20260826_01
Revises: 20260825_03
Create Date: 2026-08-26
"""

import sqlalchemy as sa
from alembic import op

revision = "20260826_01"
down_revision = "20260825_03"
branch_labels = None
depends_on = None


# Types mirror the ORM by hand: the test suite builds its schema from the
# metadata and never runs Alembic, so nothing else catches drift here.
_COLUMNS: tuple[tuple[str, str, sa.types.TypeEngine], ...] = (
    ("captured_trace_index", "span_index_rev", sa.Integer()),
    ("captured_span_index", "semantic_kind", sa.String(length=32)),
    ("captured_span_index", "input_preview", sa.Text()),
    ("captured_span_index", "output_preview", sa.Text()),
    ("captured_span_index", "llm_token_count_prompt", sa.Integer()),
    ("captured_span_index", "llm_token_count_completion", sa.Integer()),
)


def _existing(table: str) -> set[str]:
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    for table, column, column_type in _COLUMNS:
        if column not in _existing(table):
            op.add_column(table, sa.Column(column, column_type, nullable=True))


def downgrade() -> None:
    for table, column, _ in reversed(_COLUMNS):
        if column in _existing(table):
            op.drop_column(table, column)
