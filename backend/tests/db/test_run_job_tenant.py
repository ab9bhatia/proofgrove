"""Tenant attribution of in-flight run jobs.

``run_jobs`` rows back the Monitor fallback for runs without a persisted
result, so they must be attributable to a tenant. NULL-tenant rows are legacy
jobs, visible only to unscoped queries.
"""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from evalhub.db.models import Base
from evalhub.db.store import EvaluationStore
from evalhub.settings import settings


@pytest.fixture
async def store():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield EvaluationStore(session)
    await engine.dispose()


async def _create_job(store: EvaluationStore, *, tenant_id: str | None) -> str:
    return await store.create_run_job(
        dataset_name="d",
        response_source="baseline",
        agent=None,
        row_count=None,
        judge_model=None,
        tenant_id=tenant_id,
    )


@pytest.mark.asyncio
async def test_job_created_under_tenant_a_is_invisible_to_tenant_b(store: EvaluationStore):
    run_id = await _create_job(store, tenant_id="tenant-a")

    listed_for_b = await store.list_eval_jobs(tenant_id="tenant-b")
    assert run_id not in {job.run_id for job in listed_for_b}

    listed_for_a = await store.list_eval_jobs(tenant_id="tenant-a")
    assert run_id in {job.run_id for job in listed_for_a}

    assert (await store.get_run_job(run_id, tenant_id="tenant-b")) is None
    scoped = await store.get_run_job(run_id, tenant_id="tenant-a")
    assert scoped is not None and scoped.tenant_id == "tenant-a"


@pytest.mark.asyncio
async def test_legacy_null_tenant_jobs_only_visible_unscoped(store: EvaluationStore):
    tenant_job = await _create_job(store, tenant_id="tenant-a")
    legacy_job = await _create_job(store, tenant_id=None)

    unscoped = {job.run_id for job in await store.list_eval_jobs()}
    assert {tenant_job, legacy_job} <= unscoped

    scoped = {job.run_id for job in await store.list_eval_jobs(tenant_id="tenant-a")}
    assert tenant_job in scoped
    assert legacy_job not in scoped

    # Unscoped point lookups still see everything (worker paths).
    assert (await store.get_run_job(legacy_job)) is not None
    # Scoped point lookups never see legacy unattributed jobs.
    assert (await store.get_run_job(legacy_job, tenant_id="tenant-a")) is None


@pytest.mark.parametrize("stored,requested", [("evalai", "tenant-evalai"), ("tenant-evalai", "evalai")])
async def test_job_spelling_preserves_lookup_listing_and_cancellation(store, stored, requested, monkeypatch):
    monkeypatch.setattr(settings, "pod_namespace", "tenant-evalai")
    run_id = await _create_job(store, tenant_id=stored)
    foreign_id = await _create_job(store, tenant_id="tenant-other")
    legacy_id = await _create_job(store, tenant_id=None)

    assert await store.get_run_job(run_id, tenant_id=requested) is not None
    assert {job.run_id for job in await store.list_eval_jobs(tenant_id=requested)} == {run_id}
    for hidden_id in (foreign_id, legacy_id):
        assert await store.get_run_job(hidden_id, tenant_id=requested) is None
        assert await store.cancel_run_job(hidden_id, tenant_id=requested) is None
        assert (await store.get_run_job(hidden_id)).status == "pending"
    stopped = await store.cancel_run_job(run_id, tenant_id=requested)
    assert stopped is not None and stopped.status == "cancelled"
    assert (await store.cancel_run_job(run_id, tenant_id=stored)).status == "cancelled"
