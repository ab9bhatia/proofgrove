"""Make golden dataset identity tenant-scoped.

``golden_datasets`` used ``dataset_name`` alone as its primary key, making
dataset names globally unique across tenants — the first tenant to create
"smoke-test" blocked every other tenant from using that name. Identity becomes
``(tenant_id, dataset_name)``; ``golden_dataset_records`` and
``golden_dataset_version_events`` gain a ``tenant_id`` column backfilled from
the parent dataset so their foreign keys can follow the composite identity.

Guarded and idempotent like the sibling backfill revisions: every step checks
current schema state first, so a fresh install created via ``create_all``
(which already has the composite shape) passes through untouched.

Revision ID: 20260915_01
Revises: 20260910_02
Create Date: 2026-09-15
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260915_01"
down_revision = "20260910_02"
branch_labels = None
depends_on = None


def _pk_columns(inspector, table):
    pk = inspector.get_pk_constraint(table)
    return list(pk.get("constrained_columns") or [])


def _create_tables() -> None:
    json_type = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
    op.create_table(
        "golden_datasets",
        sa.Column("tenant_id", sa.String(length=128), nullable=False),
        sa.Column("dataset_name", sa.String(length=256), nullable=False),
        sa.Column("dataset_id", sa.String(length=36), nullable=False),
        sa.Column("product_id", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("parent_dataset_name", sa.String(length=256), nullable=True),
        sa.Column("dqs", sa.Float(), nullable=True),
        sa.Column("change_reason", sa.String(length=64), nullable=True),
        sa.Column("created_by", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("tenant_id", "dataset_name", name="pk_golden_datasets"),
    )
    op.create_table(
        "golden_dataset_records",
        sa.Column("dataset_record_id", sa.String(length=64), nullable=False),
        sa.Column("tenant_id", sa.String(length=128), nullable=False),
        sa.Column("dataset_name", sa.String(length=256), nullable=False),
        sa.Column("inputs", json_type, nullable=False),
        sa.Column("expectations", json_type, nullable=False),
        sa.Column("tags", json_type, nullable=False),
        sa.Column("created_time", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint(
            "tenant_id", "dataset_name", "dataset_record_id", name="pk_golden_dataset_records"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "dataset_name"],
            ["golden_datasets.tenant_id", "golden_datasets.dataset_name"],
            name="fk_golden_dataset_records_dataset",
            ondelete="CASCADE",
        ),
    )
    op.create_table(
        "golden_dataset_version_events",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("tenant_id", sa.String(length=128), nullable=False),
        sa.Column("dataset_name", sa.String(length=256), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("operation", sa.String(length=64), nullable=False),
        sa.Column("num_records", sa.Integer(), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_golden_dataset_version_events"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "dataset_name"],
            ["golden_datasets.tenant_id", "golden_datasets.dataset_name"],
            name="fk_golden_dataset_version_events_dataset",
            ondelete="CASCADE",
        ),
    )


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = inspector.get_table_names()
    if "golden_datasets" not in tables:
        # Fresh database: no earlier revision creates these tables (they
        # historically came from the store's create_all, which is now gated
        # off in production), so this revision owns creating them — directly
        # in the final composite-identity shape.
        _create_tables()
        return

    # records + version events: add tenant_id, backfill from parent dataset.
    for table in ("golden_dataset_records", "golden_dataset_version_events"):
        if table not in tables:
            continue
        columns = {c["name"] for c in inspector.get_columns(table)}
        if "tenant_id" not in columns:
            op.add_column(table, sa.Column("tenant_id", sa.String(length=128), nullable=True))
            bind.execute(
                sa.text(
                    f"UPDATE {table} SET tenant_id = ("
                    "SELECT gd.tenant_id FROM golden_datasets gd "
                    f"WHERE gd.dataset_name = {table}.dataset_name)"
                )
            )

    # golden_datasets: rebuild PK as (tenant_id, dataset_name) when it is the
    # old single-column shape. Dependent FKs are rebuilt in the same pass.
    if _pk_columns(inspector, "golden_datasets") == ["dataset_name"]:
        with op.batch_alter_table("golden_dataset_records") as batch:
            for fk in inspector.get_foreign_keys("golden_dataset_records"):
                if fk.get("referred_table") == "golden_datasets" and fk.get("name"):
                    batch.drop_constraint(fk["name"], type_="foreignkey")
        with op.batch_alter_table("golden_dataset_version_events") as batch:
            for fk in inspector.get_foreign_keys("golden_dataset_version_events"):
                if fk.get("referred_table") == "golden_datasets" and fk.get("name"):
                    batch.drop_constraint(fk["name"], type_="foreignkey")

        with op.batch_alter_table("golden_datasets") as batch:
            pk_name = inspector.get_pk_constraint("golden_datasets").get("name")
            if pk_name:
                batch.drop_constraint(pk_name, type_="primary")
            batch.create_primary_key("pk_golden_datasets", ["tenant_id", "dataset_name"])

        with op.batch_alter_table("golden_dataset_records") as batch:
            batch.alter_column("tenant_id", existing_type=sa.String(length=128), nullable=False)
            pk_name = inspector.get_pk_constraint("golden_dataset_records").get("name")
            if pk_name:
                batch.drop_constraint(pk_name, type_="primary")
            batch.create_primary_key(
                "pk_golden_dataset_records", ["tenant_id", "dataset_name", "dataset_record_id"]
            )
            batch.create_foreign_key(
                "fk_golden_dataset_records_dataset",
                "golden_datasets",
                ["tenant_id", "dataset_name"],
                ["tenant_id", "dataset_name"],
                ondelete="CASCADE",
            )
        with op.batch_alter_table("golden_dataset_version_events") as batch:
            batch.create_foreign_key(
                "fk_golden_dataset_version_events_dataset",
                "golden_datasets",
                ["tenant_id", "dataset_name"],
                ["tenant_id", "dataset_name"],
                ondelete="CASCADE",
            )


def downgrade() -> None:
    """Restore the single-column dataset identity.

    Fails loudly (duplicate-key error from the database) if two tenants hold
    the same dataset name — that data cannot be represented in the old shape,
    and silently dropping one tenant's rows is worse than refusing.
    """
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = inspector.get_table_names()
    if "golden_datasets" not in tables:
        return
    if _pk_columns(inspector, "golden_datasets") != ["tenant_id", "dataset_name"]:
        return

    for table in ("golden_dataset_records", "golden_dataset_version_events"):
        with op.batch_alter_table(table) as batch:
            for fk in inspector.get_foreign_keys(table):
                if fk.get("referred_table") == "golden_datasets" and fk.get("name"):
                    batch.drop_constraint(fk["name"], type_="foreignkey")

    with op.batch_alter_table("golden_datasets") as batch:
        pk_name = inspector.get_pk_constraint("golden_datasets").get("name")
        if pk_name:
            batch.drop_constraint(pk_name, type_="primary")
        batch.create_primary_key("pk_golden_datasets", ["dataset_name"])

    with op.batch_alter_table("golden_dataset_records") as batch:
        pk_name = inspector.get_pk_constraint("golden_dataset_records").get("name")
        if pk_name:
            batch.drop_constraint(pk_name, type_="primary")
        batch.create_primary_key(
            "pk_golden_dataset_records", ["dataset_record_id", "dataset_name"]
        )
        batch.create_foreign_key(
            "fk_golden_dataset_records_dataset",
            "golden_datasets",
            ["dataset_name"],
            ["dataset_name"],
            ondelete="CASCADE",
        )
        batch.drop_column("tenant_id")
    with op.batch_alter_table("golden_dataset_version_events") as batch:
        batch.create_foreign_key(
            "fk_golden_dataset_version_events_dataset",
            "golden_datasets",
            ["dataset_name"],
            ["dataset_name"],
            ondelete="CASCADE",
        )
        batch.drop_column("tenant_id")
