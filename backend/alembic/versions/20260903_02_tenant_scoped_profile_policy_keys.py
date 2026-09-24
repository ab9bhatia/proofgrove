"""Put tenant identity inside Profile and Gate Policy version keys.

Two tenants must both be able to own ``support-quality@1.0.0``. The previous
primary keys were ``{id}@{version}`` with tenant only as a column beside them.

Revision ID: 20260903_02
Revises: 20260903_01a
Create Date: 2026-09-03
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260903_02"
down_revision = "20260903_01a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "quality_profile_versions" in tables:
        _widen_key("quality_profile_versions", "profile_version_id")
        op.execute(
            sa.text(
                "UPDATE quality_profile_versions "
                "SET profile_version_id = tenant_id || ':' || profile_id || '@' || version "
                "WHERE profile_version_id NOT LIKE '%:%'"
            )
        )
    if "release_gate_policy_versions" in tables:
        _widen_key("release_gate_policy_versions", "gate_policy_version_id")
        op.execute(
            sa.text(
                "UPDATE release_gate_policy_versions "
                "SET gate_policy_version_id = tenant_id || ':' || gate_policy_id || '@' || version "
                "WHERE gate_policy_version_id NOT LIKE '%:%'"
            )
        )


def _refuse_if_tenants_collide(table: str, id_column: str) -> None:
    """Stop a downgrade that would merge two tenants' rows into one key.

    The upgrade exists so two tenants can each own ``support-quality@1.0.0``.
    Reversing the key to ``{id}@{version}`` therefore has no answer when both
    tenants really do — the rows collide on the primary key. Left to the database
    that surfaces as an opaque integrity error part-way through; refusing up front
    names the rows instead.
    """
    bind = op.get_bind()
    collisions = bind.execute(
        sa.text(
            # Grouped on the two columns rather than a concatenation: `||` is
            # string concat on PostgreSQL and SQLite but logical OR on MySQL,
            # where it would collapse every row into one group and refuse a
            # downgrade that is perfectly safe.
            f"SELECT {id_column} AS legacy_id, version, count(DISTINCT tenant_id) AS tenants "
            f"FROM {table} GROUP BY {id_column}, version HAVING count(DISTINCT tenant_id) > 1"
        )
    ).fetchall()
    if collisions:
        listed = ", ".join(f"{row.legacy_id}@{row.version} ({row.tenants} tenants)" for row in collisions[:5])
        raise RuntimeError(
            f"Cannot downgrade {table}: the pre-tenant key is not unique for {listed}. "
            "Remove or re-key the duplicate rows first — downgrading would merge records "
            "belonging to different tenants."
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "quality_profile_versions" in tables:
        _refuse_if_tenants_collide("quality_profile_versions", "profile_id")
    if "release_gate_policy_versions" in tables:
        _refuse_if_tenants_collide("release_gate_policy_versions", "gate_policy_id")
    if "quality_profile_versions" in tables:
        op.execute(
            sa.text(
                "UPDATE quality_profile_versions "
                "SET profile_version_id = profile_id || '@' || version"
            )
        )
        _widen_key(
            "quality_profile_versions",
            "profile_version_id",
            length=196,
            existing_length=324,
        )
    if "release_gate_policy_versions" in tables:
        op.execute(
            sa.text(
                "UPDATE release_gate_policy_versions "
                "SET gate_policy_version_id = gate_policy_id || '@' || version"
            )
        )
        _widen_key(
            "release_gate_policy_versions",
            "gate_policy_version_id",
            length=196,
            existing_length=324,
        )


def _widen_key(
    table: str,
    column: str,
    *,
    length: int = 324,
    existing_length: int = 196,
) -> None:
    with op.batch_alter_table(table) as batch:
        batch.alter_column(
            column,
            existing_type=sa.String(existing_length),
            type_=sa.String(length),
            existing_nullable=False,
        )
