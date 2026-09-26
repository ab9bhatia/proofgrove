"""Target ↔ system-Project binding: create, uniqueness, and resolution.

The evaluate flow needs to infer a tenant *system* Project from a selected
agent/target. A target's immutable ``TargetVersion.project_id`` points at the
internal ``catalog_registry`` Project, which is NOT the system home. These tests
pin the settled contract:

* one binding per ``(tenant, logical target, environment)``;
* resolution returns the bound *system* Project (``purpose=system``), never the
  ``catalog_registry`` Project;
* historical ``TargetVersion`` rows are never mutated by binding;
* a target with no binding resolves to ``None`` (the caller must choose).
"""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from proofgrove.db.models import Base
from proofgrove.db.store import EvaluationStore
from proofgrove.platform.contracts import (
    EvaluationProject,
    ProjectPurpose,
    ProjectStatus,
    TargetType,
    TargetVersion,
)
from proofgrove.platform.target_binding import TargetProjectBinding

TENANT = "tenant-evalai"
OTHER_TENANT = "tenant-other"


@pytest.fixture
async def store():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield EvaluationStore(session)
    await engine.dispose()


async def _system_project(store: EvaluationStore, tenant: str, project_id: str) -> EvaluationProject:
    return await store.save_project(
        EvaluationProject(
            project_id=project_id,
            tenant_id=tenant,
            name=f"System {project_id}",
            system_type="agent",
            owner="owner",
            purpose=ProjectPurpose.SYSTEM,
        )
    )


async def _catalog_project(store: EvaluationStore, tenant: str, project_id: str) -> EvaluationProject:
    return await store.save_project(
        EvaluationProject(
            project_id=project_id,
            tenant_id=tenant,
            name="Agent Catalog",
            system_type="agent",
            owner="proofgrove",
            purpose=ProjectPurpose.CATALOG_REGISTRY,
        )
    )


async def _catalog_target_version(
    store: EvaluationStore, tenant: str, *, target_id: str, catalog_project_id: str
) -> TargetVersion:
    return await store.save_target_version(
        TargetVersion(
            target_id=target_id,
            project_id=catalog_project_id,
            tenant_id=tenant,
            name="kagent target",
            version="kagent-abc123",
            endpoint="https://kagent.example.com/api/a2a/ns/agent/",
            target_type=TargetType.AGENT,
            environment="cluster",
        )
    )


@pytest.mark.asyncio
async def test_binding_is_unique_per_tenant_target_environment(store: EvaluationStore):
    await _system_project(store, TENANT, "sys-1")
    await _system_project(store, TENANT, "sys-2")

    await store.create_target_project_binding(
        TargetProjectBinding(
            tenant_id=TENANT,
            target_id="kagent-logical-1",
            environment="cluster",
            system_project_id="sys-1",
        )
    )

    # Same (tenant, target, environment) is rejected.
    with pytest.raises(ValueError):
        await store.create_target_project_binding(
            TargetProjectBinding(
                tenant_id=TENANT,
                target_id="kagent-logical-1",
                environment="cluster",
                system_project_id="sys-2",
            )
        )

    # A different environment of the same logical target is a separate binding.
    other_env = await store.create_target_project_binding(
        TargetProjectBinding(
            tenant_id=TENANT,
            target_id="kagent-logical-1",
            environment="staging",
            system_project_id="sys-2",
        )
    )
    assert other_env.system_project_id == "sys-2"


@pytest.mark.asyncio
async def test_resolve_returns_bound_system_project_not_catalog(store: EvaluationStore):
    await _catalog_project(store, TENANT, "catalog-1")
    system = await _system_project(store, TENANT, "sys-1")
    await _catalog_target_version(
        store, TENANT, target_id="kagent-logical-1", catalog_project_id="catalog-1"
    )

    await store.create_target_project_binding(
        TargetProjectBinding(
            tenant_id=TENANT,
            target_id="kagent-logical-1",
            environment="cluster",
            system_project_id="sys-1",
        )
    )

    resolved = await store.resolve_target_system_project(
        tenant_id=TENANT, target_id="kagent-logical-1", environment="cluster"
    )
    assert resolved is not None
    assert resolved.project_id == system.project_id
    assert resolved.purpose == ProjectPurpose.SYSTEM
    # Never the catalog_registry Project the immutable version points at.
    assert resolved.project_id != "catalog-1"


@pytest.mark.asyncio
async def test_binding_does_not_mutate_historical_target_version(store: EvaluationStore):
    await _catalog_project(store, TENANT, "catalog-1")
    await _system_project(store, TENANT, "sys-1")
    version = await _catalog_target_version(
        store, TENANT, target_id="kagent-logical-1", catalog_project_id="catalog-1"
    )

    await store.create_target_project_binding(
        TargetProjectBinding(
            tenant_id=TENANT,
            target_id="kagent-logical-1",
            environment="cluster",
            system_project_id="sys-1",
        )
    )

    reloaded = await store.get_target_version(version.target_version_id, TENANT)
    assert reloaded is not None
    # The immutable version still points at its catalog_registry Project.
    assert reloaded.project_id == "catalog-1"


@pytest.mark.asyncio
async def test_target_without_binding_resolves_to_none(store: EvaluationStore):
    await _system_project(store, TENANT, "sys-1")
    resolved = await store.resolve_target_system_project(
        tenant_id=TENANT, target_id="kagent-unbound", environment="cluster"
    )
    assert resolved is None


@pytest.mark.asyncio
async def test_resolution_is_tenant_scoped(store: EvaluationStore):
    await _system_project(store, TENANT, "sys-1")
    await store.create_target_project_binding(
        TargetProjectBinding(
            tenant_id=TENANT,
            target_id="kagent-logical-1",
            environment="cluster",
            system_project_id="sys-1",
        )
    )
    # A different tenant cannot resolve another tenant's binding.
    resolved = await store.resolve_target_system_project(
        tenant_id=OTHER_TENANT, target_id="kagent-logical-1", environment="cluster"
    )
    assert resolved is None


@pytest.mark.asyncio
async def test_binding_rejects_catalog_registry_project(store: EvaluationStore):
    await _catalog_project(store, TENANT, "catalog-1")
    with pytest.raises(ValueError):
        await store.create_target_project_binding(
            TargetProjectBinding(
                tenant_id=TENANT,
                target_id="kagent-logical-1",
                environment="cluster",
                system_project_id="catalog-1",
            )
        )


@pytest.mark.asyncio
async def test_resolve_returns_none_when_bound_project_is_reclassified(store: EvaluationStore):
    # Project purpose is mutable; a binding to a project later reclassified away
    # from system must not resolve to a catalog_registry project.
    await _system_project(store, TENANT, "sys-1")
    await store.create_target_project_binding(
        TargetProjectBinding(
            tenant_id=TENANT,
            target_id="kagent-logical-1",
            environment="cluster",
            system_project_id="sys-1",
        )
    )
    await store.set_project_purpose(
        "sys-1", TENANT, ProjectPurpose.CATALOG_REGISTRY
    )
    resolved = await store.resolve_target_system_project(
        tenant_id=TENANT, target_id="kagent-logical-1", environment="cluster"
    )
    assert resolved is None


@pytest.mark.asyncio
async def test_resolve_returns_none_when_bound_project_is_archived(store: EvaluationStore):
    await _system_project(store, TENANT, "sys-1")
    await store.create_target_project_binding(
        TargetProjectBinding(
            tenant_id=TENANT,
            target_id="kagent-logical-1",
            environment="cluster",
            system_project_id="sys-1",
        )
    )
    await store.set_project_status("sys-1", TENANT, ProjectStatus.ARCHIVED)

    resolved = await store.resolve_target_system_project(
        tenant_id=TENANT, target_id="kagent-logical-1", environment="cluster"
    )

    assert resolved is None


async def test_catalog_bindings_are_batched_and_preserve_scope(store):
    from sqlalchemy import event

    from proofgrove.db.models import TargetProjectBindingORM

    await _system_project(store, TENANT, "active")
    await _system_project(store, TENANT, "archived")
    await store.set_project_status("archived", TENANT, ProjectStatus.ARCHIVED)
    await _system_project(store, OTHER_TENANT, "foreign")
    await _catalog_project(store, TENANT, "catalog")
    for i in range(10):
        store.session.add(TargetProjectBindingORM(tenant_id=TENANT, target_id=f"agent-{i}", environment="cluster", system_project_id="active"))
    for target, tenant, project in (("hidden", OTHER_TENANT, "foreign"), ("wrong-project-tenant", TENANT, "foreign"), ("archived", TENANT, "archived"), ("catalog", TENANT, "catalog")):
        store.session.add(TargetProjectBindingORM(tenant_id=tenant, target_id=target, environment="cluster", system_project_id=project))
    await store.session.commit()
    statements = []
    engine = store.session.bind.sync_engine

    def count(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", count)
    try:
        for size in (1, 10):
            statements.clear()
            keys = [(f"agent-{i}", "cluster") for i in range(size)]
            keys += [(name, "cluster") for name in ("hidden", "wrong-project-tenant", "archived", "catalog", "missing")]
            keys.append(("agent-0", "other-environment"))
            projects = await store.target_system_projects(TENANT, keys)
            assert projects == {(f"agent-{i}", "cluster"): "active" for i in range(size)}
            assert len(statements) == 1
    finally:
        event.remove(engine, "before_cursor_execute", count)
