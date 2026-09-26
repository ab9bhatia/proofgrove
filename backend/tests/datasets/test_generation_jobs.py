"""Durable dataset-generation jobs: store lifecycle, endpoints, cancel, interruption.

The generation flow persists a job row in the datasets store (its own table,
created via the store's create_all bootstrap — no Alembic) and executes the
synthesis in an in-process background task keyed by job id. These tests cover:

- store phase transitions (queued → generating → validating → completed)
- compare-and-set semantics (a landed cancel is never overwritten)
- cancel idempotency + refusal to cancel terminal jobs
- interrupted-job sweeping on process restart (honest ``failed``/"interrupted")
- the HTTP endpoints (POST /datasets/generate, GET/POST generation-jobs)
"""

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from proofgrove.api.dependencies import get_registry_service
from proofgrove.datasets.generation_jobs import (
    _INTERRUPTED_STALE_AFTER_SECONDS,
    ACTIVE_PHASES,
    GenerationJobPhase,
    GenerationJobStore,
)
from proofgrove.datasets.models import DatasetRecord
from proofgrove.datasets.postgres_store import SqlDatasetStore
from proofgrove.datasets.registry import DatasetRegistryService
from proofgrove.main import app


@pytest.fixture
def store() -> GenerationJobStore:
    return GenerationJobStore()


@pytest.fixture
def real_registry():
    """A real registry constructed in the test thread.

    The sqlite ``:memory:`` sync engine keeps one connection per thread, so the
    store must be built in the same thread the in-process generation task runs
    in — mirroring production where every thread shares one Postgres.
    """
    registry = DatasetRegistryService(storage=SqlDatasetStore())
    app.dependency_overrides[get_registry_service] = lambda: registry
    yield registry
    app.dependency_overrides.pop(get_registry_service, None)


def _create(store: GenerationJobStore, **overrides) -> dict:
    params = {"tenant_id": "local", "dataset_name": "gen_ds", "params": {"num_rows": 3}}
    params.update(overrides)
    return store.create_job(**params)


# ------------------------------------------------------------------
# Store: lifecycle transitions
# ------------------------------------------------------------------


def test_create_job_starts_queued(store: GenerationJobStore):
    job = _create(store)
    assert job["phase"] == GenerationJobPhase.QUEUED.value
    assert job["tenant"] == "local"
    assert job["dataset_name"] == "gen_ds"
    assert job["error"] is None
    assert job["created_at"] and job["updated_at"]

    fetched = store.get_job(job["job_id"])
    assert fetched is not None
    assert fetched["phase"] == GenerationJobPhase.QUEUED.value


def test_happy_path_transitions(store: GenerationJobStore):
    job_id = _create(store)["job_id"]

    assert store.advance(
        job_id,
        from_phases={GenerationJobPhase.QUEUED},
        to_phase=GenerationJobPhase.GENERATING,
        progress_done=0,
        progress_total=3,
    )
    assert store.advance(
        job_id,
        from_phases={GenerationJobPhase.GENERATING},
        to_phase=GenerationJobPhase.VALIDATING,
        progress_done=3,
    )
    assert store.advance(
        job_id,
        from_phases={GenerationJobPhase.VALIDATING},
        to_phase=GenerationJobPhase.COMPLETED,
        result_dataset_name="gen_ds",
    )

    job = store.get_job(job_id)
    assert job["phase"] == GenerationJobPhase.COMPLETED.value
    assert job["progress"] == {"done": 3, "total": 3}
    assert job["result_dataset_name"] == "gen_ds"


def test_advance_rejects_wrong_predecessor(store: GenerationJobStore):
    job_id = _create(store)["job_id"]
    # queued → completed directly is not a legal CAS from VALIDATING
    assert not store.advance(
        job_id,
        from_phases={GenerationJobPhase.VALIDATING},
        to_phase=GenerationJobPhase.COMPLETED,
    )
    assert store.get_job(job_id)["phase"] == GenerationJobPhase.QUEUED.value


def test_terminal_phase_is_never_overwritten(store: GenerationJobStore):
    job_id = _create(store)["job_id"]
    assert store.advance(
        job_id, from_phases=ACTIVE_PHASES, to_phase=GenerationJobPhase.FAILED, error="boom"
    )
    # A late worker transition must not resurrect a terminal job.
    assert not store.advance(
        job_id, from_phases=ACTIVE_PHASES, to_phase=GenerationJobPhase.COMPLETED
    )
    job = store.get_job(job_id)
    assert job["phase"] == GenerationJobPhase.FAILED.value
    assert job["error"] == "boom"


def test_progress_only_reported_when_known(store: GenerationJobStore):
    job = _create(store)
    assert job["progress"] is None  # nothing honestly known yet


# ------------------------------------------------------------------
# Store: cancel semantics
# ------------------------------------------------------------------


def test_cancel_queued_job(store: GenerationJobStore):
    job_id = _create(store)["job_id"]
    job = store.request_cancel(job_id, "local")
    assert job["phase"] == GenerationJobPhase.CANCELLED.value


def test_cancel_is_idempotent(store: GenerationJobStore):
    job_id = _create(store)["job_id"]
    store.request_cancel(job_id, "local")
    again = store.request_cancel(job_id, "local")
    assert again["phase"] == GenerationJobPhase.CANCELLED.value


def test_cancel_does_not_touch_terminal_jobs(store: GenerationJobStore):
    job_id = _create(store)["job_id"]
    store.advance(job_id, from_phases=ACTIVE_PHASES, to_phase=GenerationJobPhase.COMPLETED)
    job = store.request_cancel(job_id, "local")
    assert job["phase"] == GenerationJobPhase.COMPLETED.value


def test_cancel_wins_over_late_worker_advance(store: GenerationJobStore):
    job_id = _create(store)["job_id"]
    store.advance(
        job_id, from_phases={GenerationJobPhase.QUEUED}, to_phase=GenerationJobPhase.GENERATING
    )
    store.request_cancel(job_id, "local")
    # Worker comes back from the LLM call and tries to advance — must lose.
    assert not store.advance(
        job_id,
        from_phases={GenerationJobPhase.GENERATING},
        to_phase=GenerationJobPhase.VALIDATING,
    )
    assert store.get_job(job_id)["phase"] == GenerationJobPhase.CANCELLED.value


def test_cancel_unknown_job_returns_none(store: GenerationJobStore):
    assert store.request_cancel("nope", "local") is None


def test_cancel_rejects_a_foreign_tenant(store: GenerationJobStore):
    """The cancelling UPDATE is scoped by tenant_id, not just the read-back —
    a different tenant naming the same job id must not be able to cancel it.
    """
    job_id = _create(store)["job_id"]
    assert store.request_cancel(job_id, "some-other-tenant") is None
    assert store.get_job(job_id)["phase"] == GenerationJobPhase.QUEUED.value
    assert store.get_job(job_id, "some-other-tenant") is None
    assert store.get_job(job_id, "local")["phase"] == GenerationJobPhase.QUEUED.value


# ------------------------------------------------------------------
# Store: interrupted marking (process restart)
# ------------------------------------------------------------------


def test_mark_interrupted_fails_active_jobs_only(store: GenerationJobStore):
    queued = _create(store)["job_id"]
    generating = _create(store, dataset_name="gen_ds2")["job_id"]
    store.advance(
        generating, from_phases={GenerationJobPhase.QUEUED}, to_phase=GenerationJobPhase.GENERATING
    )
    done = _create(store, dataset_name="gen_ds3")["job_id"]
    store.advance(done, from_phases=ACTIVE_PHASES, to_phase=GenerationJobPhase.COMPLETED)

    # A just-created/updated active job is presumed owned by a still-live
    # sibling replica (see mark_interrupted's staleness bound) — force
    # immediate staleness so this test doesn't need to wait out the real
    # production threshold.
    swept = store.mark_interrupted(stale_after_seconds=0)
    assert swept >= 2

    assert store.get_job(queued)["phase"] == GenerationJobPhase.FAILED.value
    assert store.get_job(queued)["error"] == "interrupted"
    assert store.get_job(generating)["phase"] == GenerationJobPhase.FAILED.value
    assert store.get_job(generating)["error"] == "interrupted"
    # Terminal jobs are untouched — no fake failure of finished work.
    assert store.get_job(done)["phase"] == GenerationJobPhase.COMPLETED.value
    assert store.get_job(done)["error"] is None


def test_mark_interrupted_skips_a_fresh_active_job(store: GenerationJobStore):
    """A job still within the staleness window must survive the sweep — it
    may belong to a sibling replica that started before this one and is
    still actively updating it.
    """
    fresh = _create(store)["job_id"]
    swept = store.mark_interrupted(stale_after_seconds=_INTERRUPTED_STALE_AFTER_SECONDS)
    assert swept == 0
    assert store.get_job(fresh)["phase"] == GenerationJobPhase.QUEUED.value


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------


def _records(n: int = 2) -> list[DatasetRecord]:
    return [
        DatasetRecord(
            inputs={"question": f"q{i}"},
            expectations={"expected_output": f"a{i}"},
            tags={"risk": "Low"},
        )
        for i in range(n)
    ]


async def _wait_for_phase(ac: AsyncClient, job_id: str, phases: set[str], attempts: int = 200) -> dict:
    for _ in range(attempts):
        resp = await ac.get(f"/datasets/generation-jobs/{job_id}")
        assert resp.status_code == 200
        body = resp.json()
        if body["phase"] in phases:
            return body
        await asyncio.sleep(0.01)
    raise AssertionError(f"job {job_id} never reached {phases}: {body}")


def _generate_body(name: str = "genjob_ds") -> dict:
    return {
        "dataset_name": name,
        "generation_method": "llms",
        "seeds": ["Create cases"],
        "num_rows": 2,
        "model": "gpt-5.1",
    }


@pytest.mark.asyncio
async def test_generate_returns_job_and_completes(monkeypatch, real_registry):
    from proofgrove.datasets import generation_service

    async def fake_synthesize(params):
        return _records(2)

    monkeypatch.setattr(generation_service, "_synthesize_records", fake_synthesize)

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": "local"}
    ) as ac:
        resp = await ac.post("/datasets/generate", json=_generate_body("genjob_complete"))
        assert resp.status_code == 202
        body = resp.json()
        # Legacy contract preserved…
        assert body["job_id"]
        assert body["status"] == "pending"
        assert body["dataset_name"] == "genjob_complete"
        # …plus the durable job shape.
        assert body["phase"] == "queued"

        job = await _wait_for_phase(ac, body["job_id"], {"completed", "failed"})
        assert job["phase"] == "completed"
        assert job["progress"] == {"done": 2, "total": 2}
        assert job["result_dataset_name"]
        assert job["error"] is None

        # The generated dataset is a real DRAFT registry entry with the rows.
        ds = await ac.get(f"/datasets/{job['result_dataset_name']}/records")
        assert ds.status_code == 200
        assert len(ds.json()) == 2


@pytest.mark.asyncio
async def test_generate_failure_is_recorded_honestly(monkeypatch):
    from proofgrove.datasets import generation_service

    async def fake_synthesize(params):
        from proofgrove.generation.generator import GenerationError
        raise GenerationError("no grounding material")

    monkeypatch.setattr(generation_service, "_synthesize_records", fake_synthesize)

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": "local"}
    ) as ac:
        resp = await ac.post("/datasets/generate", json=_generate_body("genjob_fail"))
        assert resp.status_code == 202
        job = await _wait_for_phase(ac, resp.json()["job_id"], {"completed", "failed"})
        assert job["phase"] == "failed"
        assert job["error"] == "Dataset generation failed. Check the generation inputs and try again."


@pytest.mark.asyncio
async def test_generation_concurrency_is_bounded_by_the_semaphore(monkeypatch, real_registry):
    """A second generation job must sit QUEUED, not start synthesizing,
    while the concurrency limit is held by the first.

    Before this fix every ``/datasets/generate`` spawned an unbounded
    asyncio task — a burst of requests could hammer the generation
    LLM/gateway with no limit at all.
    """
    from proofgrove.datasets import generation_service

    monkeypatch.setattr(generation_service, "_GENERATION_SEMAPHORE", asyncio.Semaphore(1))

    release_first = asyncio.Event()
    # With the semaphore's only slot held by the first job, at most one call
    # can be in flight at a time — the list length is the "how many jobs have
    # started synthesizing" count regardless of which job it was.
    started: list[int] = []

    async def slow_synthesize(params):
        started.append(len(started) + 1)
        await release_first.wait()
        return _records(1)

    monkeypatch.setattr(generation_service, "_synthesize_records", slow_synthesize)

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": "local"}
    ) as ac:
        first = await ac.post("/datasets/generate", json=_generate_body("genjob_sem_first"))
        first_id = first.json()["job_id"]
        await _wait_for_phase(ac, first_id, {"generating"})

        second = await ac.post("/datasets/generate", json=_generate_body("genjob_sem_second"))
        second_id = second.json()["job_id"]

        # Give the second job's task every chance to run — it must stay
        # QUEUED because the semaphore's only slot is held by the first job.
        for _ in range(20):
            await asyncio.sleep(0.01)
        second_job = (await ac.get(f"/datasets/generation-jobs/{second_id}")).json()
        assert second_job["phase"] == "queued"
        assert started == [1]

        release_first.set()
        await _wait_for_phase(ac, first_id, {"completed", "failed"})
        second_completed = await _wait_for_phase(ac, second_id, {"completed", "failed"})
        assert second_completed["phase"] == "completed"
        assert started == [1, 2]


@pytest.mark.asyncio
async def test_cancel_endpoint_is_idempotent(monkeypatch):
    from proofgrove.datasets import generation_service

    release = asyncio.Event()

    async def slow_synthesize(params):
        await release.wait()
        return _records(1)

    monkeypatch.setattr(generation_service, "_synthesize_records", slow_synthesize)

    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": "local"}
    ) as ac:
            resp = await ac.post("/datasets/generate", json=_generate_body("genjob_cancel"))
            job_id = resp.json()["job_id"]
            await _wait_for_phase(ac, job_id, {"generating"})

            first = await ac.post(f"/datasets/generation-jobs/{job_id}/cancel")
            assert first.status_code == 200
            assert first.json()["phase"] == "cancelled"

            second = await ac.post(f"/datasets/generation-jobs/{job_id}/cancel")
            assert second.status_code == 200
            assert second.json()["phase"] == "cancelled"

            # Cancellation is durable and honest — never silently completed.
            job = await ac.get(f"/datasets/generation-jobs/{job_id}")
            assert job.json()["phase"] == "cancelled"
    finally:
        release.set()


@pytest.mark.asyncio
async def test_cancel_completed_job_is_409(monkeypatch, real_registry):
    from proofgrove.datasets import generation_service

    async def fake_synthesize(params):
        return _records(1)

    monkeypatch.setattr(generation_service, "_synthesize_records", fake_synthesize)

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": "local"}
    ) as ac:
        resp = await ac.post("/datasets/generate", json=_generate_body("genjob_done"))
        job_id = resp.json()["job_id"]
        await _wait_for_phase(ac, job_id, {"completed"})

        cancel = await ac.post(f"/datasets/generation-jobs/{job_id}/cancel")
        assert cancel.status_code == 409


@pytest.mark.asyncio
async def test_get_unknown_job_is_404():
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": "local"}
    ) as ac:
        resp = await ac.get("/datasets/generation-jobs/does-not-exist")
        assert resp.status_code == 404
        cancel = await ac.post("/datasets/generation-jobs/does-not-exist/cancel")
        assert cancel.status_code == 404


@pytest.mark.asyncio
async def test_job_endpoints_enforce_tenant(monkeypatch, real_registry):
    """A foreign tenant's read/cancel now 404s, not 403.

    The job read is scoped by tenant_id in the store's WHERE clause (see
    ``GenerationJobStore.get_job``/``request_cancel``) rather than fetched
    unscoped and rejected afterward — same "not found" shape as the rest of
    this PR's tenant-scoped reads (e.g. the evidence-pack route), so a
    mismatched tenant can't distinguish "doesn't exist" from "exists but
    isn't yours".
    """
    from proofgrove.datasets import generation_service

    async def fake_synthesize(params):
        return _records(1)

    monkeypatch.setattr(generation_service, "_synthesize_records", fake_synthesize)

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": "local"}
    ) as ac:
        resp = await ac.post("/datasets/generate", json=_generate_body("genjob_tenant"))
        job_id = resp.json()["job_id"]

        mismatched = await ac.get(
            f"/datasets/generation-jobs/{job_id}",
            headers={"x-evalai-tenant": "some-other-tenant"},
        )
        assert mismatched.status_code == 404

        cancel_mismatch = await ac.post(
            f"/datasets/generation-jobs/{job_id}/cancel",
            headers={"x-evalai-tenant": "some-other-tenant"},
        )
        assert cancel_mismatch.status_code == 404

        matched = await ac.get(
            f"/datasets/generation-jobs/{job_id}",
            headers={"x-evalai-tenant": resp.json()["tenant"]},
        )
        assert matched.status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "grounding_url",
    [
        "http://169.254.169.254/latest/meta-data/",
        "http://svc.other-tenant.svc.cluster.local",
        "http://localhost:8080/mcp",
    ],
)
async def test_generate_rejects_ssrf_targeted_grounding_url(grounding_url):
    """A tools/agents generation's grounding_url is an outbound fetch target,
    the same class of URL an onboarded agent endpoint is -- cloud metadata, a
    cross-tenant in-cluster service, and localhost must all be refused before
    a background job is ever queued to fetch them.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": "local"}
    ) as ac:
        resp = await ac.post(
            "/datasets/generate",
            json={
                "dataset_name": "genjob_ssrf",
                "generation_method": "tools",
                "grounding_url": grounding_url,
                "seeds": ["Create cases"],
                "num_rows": 2,
            },
        )
    assert resp.status_code == 422, resp.text



def test_new_generation_returns_job_with_platform_authorization(monkeypatch):
    from unittest.mock import AsyncMock, Mock

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from proofgrove.api.v1 import datasets
    from proofgrove.datasets.exceptions import DatasetNotFoundError
    from proofgrove.platform import authz
    from proofgrove.settings import settings

    monkeypatch.setattr(settings, "platform_auth_required", True)

    async def allow(request, permission):
        request.state.proofgrove_permissions = {permission}

    monkeypatch.setattr(authz, "require_permission", allow)
    test_app = FastAPI()
    test_app.include_router(datasets.router)
    test_app.add_middleware(authz.AuthorizationMiddleware)
    registry = Mock()
    registry.get_dataset_tenant.side_effect = DatasetNotFoundError("missing")
    test_app.dependency_overrides[get_registry_service] = lambda: registry
    start = AsyncMock(return_value={"job_id": "generated", "phase": "queued"})
    monkeypatch.setattr(datasets.generation_service, "start_generation", start)
    with TestClient(test_app, headers={"x-evalai-tenant": "tenant-own", "x-evalai-sub": "author"}) as client:
        response = client.post("/datasets/generate", json={
            "dataset_name": "new", "generation_method": "llms", "seeds": ["question"], "num_rows": 1, "model": "test",
        })
    assert response.status_code == 202, response.text
    assert response.json()["job_id"] == "generated"
    assert start.await_args.kwargs["params"]["tenant_id"] == "tenant-own"


@pytest.mark.parametrize("phase", ["validating", "completed", "failed"])
async def test_cancel_route_uses_atomic_result_when_registration_wins(monkeypatch, phase):
    from unittest.mock import AsyncMock

    from proofgrove.datasets import generation_service

    cancel = AsyncMock(return_value={"job_id": "racing", "phase": phase})
    monkeypatch.setattr(generation_service, "cancel_generation", cancel)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test", headers={"x-evalai-tenant": "local"}) as ac:
        response = await ac.post("/datasets/generation-jobs/racing/cancel")
    assert response.status_code == 409
    cancel.assert_awaited_once_with("racing", "local")


def test_historical_generation_error_never_leaves_response_boundary():
    from proofgrove.api.v1.datasets import _job_response
    payload = _job_response({"phase": "failed", "error": "OPAQUE_PRIVATE_VALUE", "params": {"secret": "OPAQUE_PRIVATE_VALUE"}})
    assert payload["phase"] == "failed"
    assert "OPAQUE_PRIVATE_VALUE" not in str(payload)
    assert "params" not in payload
