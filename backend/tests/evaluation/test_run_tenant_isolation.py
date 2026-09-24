"""Cross-tenant isolation for the run / run-item read endpoints.

Security invariant: a run created under tenant A must NEVER be readable by a
request scoped to tenant B, and the read endpoints must REJECT a missing or
blank tenant rather than treating it as "all tenants". These tests are the proof
for the tenant-scoping fix on ``GET /evaluation/runs``, ``/run-history``,
``/runs/{id}`` and the run-item / report surfaces.
"""

from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from evalhub.db.models import Base
from evalhub.db.store import EvaluationStore
from evalhub.evaluation.engine import EvaluationEngine
from evalhub.evaluation.judge import MockJudge
from evalhub.evaluation.models import EvaluationRow, ExperimentDefinition
from evalhub.platform.authz import tenants_match


def _act_as(client, tenant: str) -> None:
    """Present the tenant identity the gateway would inject for this caller.

    A request carries exactly one identity, so a test that exercises two
    tenants switches between them rather than presenting neither.
    """
    client.headers["x-evalai-tenant"] = tenant


def _create_tenant_run(client, *, tenant_id: str, token: str) -> dict:
    """Create an isolated experiment (with one row) under ``tenant_id`` and run it.

    ``token`` is embedded in the experiment id/name so run-history ``search`` can
    target exactly this run.
    """
    experiment_id = f"exp-iso-{token}"
    created = client.post(
        "/evaluation/experiments",
        json={
            "experiment_id": experiment_id,
            "name": f"Isolation fixture {token}",
            "dataset_version": "iso_v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "domain": "general",
            "tenant_id": tenant_id,
        },
    )
    assert created.status_code == 201, created.text
    added = client.post(
        f"/evaluation/experiments/{experiment_id}/rows",
        json=[
            {
                "row_id": f"{token}-row-1",
                "query": "Where is my request?",
                "response": "It is in review.",
                "expected_response": "It is in review.",
            }
        ],
    )
    assert added.status_code == 201, added.text
    run = client.post(
        "/evaluation/runs",
        json={
            "experiment_id": experiment_id,
            "name": f"Isolation fixture {token}",
            "dataset_version": "iso_v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "tenant_id": tenant_id,
        },
    )
    assert run.status_code == 201, run.text
    return run.json()


def test_runs_are_not_readable_across_tenants(client):
    token_a = uuid4().hex[:12]
    token_b = uuid4().hex[:12]
    tenant_a = f"tenant-a-{token_a}"
    tenant_b = f"tenant-b-{token_b}"

    _act_as(client, tenant_a)
    run_a = _create_tenant_run(client, tenant_id=tenant_a, token=token_a)
    _act_as(client, tenant_b)
    run_b = _create_tenant_run(client, tenant_id=tenant_b, token=token_b)
    run_a_id = run_a["run_id"]
    example_a = f"{token_a}-row-1"

    # A caller acting as B cannot even ask for A's scope: the identity and the
    # requested scope must agree before any lookup happens.
    for scoped in (
        f"/evaluation/runs?tenant_id={tenant_a}",
        f"/evaluation/run-history?limit=50&search={token_a}&tenant_id={tenant_a}",
        f"/evaluation/runs/{run_a_id}?tenant_id={tenant_a}",
        f"/evaluation/runs/{run_a_id}/configuration?tenant_id={tenant_a}",
    ):
        assert client.get(scoped).status_code == 403, scoped

    # ── list_runs ─────────────────────────────────────────────────────────────
    listed_b = client.get(f"/evaluation/runs?tenant_id={tenant_b}")
    assert listed_b.status_code == 200
    ids_b = {item["run_id"] for item in listed_b.json()}
    assert run_a_id not in ids_b, "tenant B must not see tenant A's run"
    assert run_b["run_id"] in ids_b, "tenant B must still see its own run"

    _act_as(client, tenant_a)
    listed_a = client.get(f"/evaluation/runs?tenant_id={tenant_a}")
    assert run_a_id in {item["run_id"] for item in listed_a.json()}

    # ── run-history ───────────────────────────────────────────────────────────
    _act_as(client, tenant_b)
    hist_b = client.get(
        f"/evaluation/run-history?limit=50&search={token_a}&tenant_id={tenant_b}"
    )
    assert hist_b.status_code == 200
    assert hist_b.json()["total"] == 0
    assert hist_b.json()["items"] == []

    _act_as(client, tenant_a)
    hist_a = client.get(
        f"/evaluation/run-history?limit=50&search={token_a}&tenant_id={tenant_a}"
    )
    assert hist_a.json()["total"] == 1
    assert hist_a.json()["items"][0]["run_id"] == run_a_id

    # ── run detail / report / ci-callback / review-queue ──────────────────────
    for suffix in ("", "/report", "/ci-callback", "/review-queue"):
        _act_as(client, tenant_b)
        cross = client.get(f"/evaluation/runs/{run_a_id}{suffix}?tenant_id={tenant_b}")
        assert cross.status_code == 404, (
            f"tenant B must get 404 on runs/{{id}}{suffix}, got {cross.status_code}"
        )
        _act_as(client, tenant_a)
        same = client.get(f"/evaluation/runs/{run_a_id}{suffix}?tenant_id={tenant_a}")
        assert same.status_code == 200, (suffix, same.text)

    # ── run items (list + detail) ─────────────────────────────────────────────
    _act_as(client, tenant_b)
    items_cross = client.get(f"/evaluation/runs/{run_a_id}/items?tenant_id={tenant_b}")
    assert items_cross.status_code == 404
    detail_cross = client.get(
        f"/evaluation/runs/{run_a_id}/items/{example_a}?tenant_id={tenant_b}"
    )
    assert detail_cross.status_code == 404

    _act_as(client, tenant_a)
    items_same = client.get(f"/evaluation/runs/{run_a_id}/items?tenant_id={tenant_a}")
    assert items_same.status_code == 200
    assert [item["example_id"] for item in items_same.json()] == [example_a]
    detail_same = client.get(
        f"/evaluation/runs/{run_a_id}/items/{example_a}?tenant_id={tenant_a}"
    )
    assert detail_same.status_code == 200
    assert detail_same.json()["example_id"] == example_a


def test_run_reads_reject_missing_or_blank_tenant(client):
    token = uuid4().hex[:12]
    tenant = f"tenant-{token}"
    _act_as(client, tenant)
    run = _create_tenant_run(client, tenant_id=tenant, token=token)
    run_id = run["run_id"]
    example_id = f"{token}-row-1"

    # A missing tenant must be rejected (422), never treated as "all tenants".
    missing_tenant_paths = [
        "/evaluation/runs",
        "/evaluation/run-history",
        f"/evaluation/runs/{run_id}",
        f"/evaluation/runs/{run_id}/configuration",
        f"/evaluation/runs/{run_id}/report",
        f"/evaluation/runs/{run_id}/ci-callback",
        f"/evaluation/runs/{run_id}/review-queue",
        f"/evaluation/runs/{run_id}/items",
        f"/evaluation/runs/{run_id}/items/{example_id}",
    ]
    for path in missing_tenant_paths:
        resp = client.get(path)
        assert resp.status_code == 422, f"{path} must require tenant_id, got {resp.status_code}"

    # A blank tenant is likewise rejected (min_length=1), not "all tenants".
    for path in missing_tenant_paths:
        resp = client.get(f"{path}?tenant_id=")
        assert resp.status_code == 422, f"{path}?tenant_id= must be rejected, got {resp.status_code}"


def test_compare_requires_tenant_and_rejects_cross_tenant_runs(client):
    """Compare must require tenant_id and 404 for runs outside that tenant."""
    token = uuid4().hex[:12]
    tenant_a = f"tenant-a-{token}"
    tenant_b = f"tenant-b-{token}"
    shared_id = f"exp-cmp-{token}"

    _act_as(client, tenant_a)
    created = client.post(
        "/evaluation/experiments",
        json={
            "experiment_id": shared_id,
            "name": f"Compare fixture {token}",
            "dataset_version": "iso_v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "domain": "general",
            "tenant_id": tenant_a,
        },
    )
    assert created.status_code == 201, created.text
    assert (
        client.post(
            f"/evaluation/experiments/{shared_id}/rows",
            json=[
                {
                    "row_id": f"{token}-cmp-row-1",
                    "query": "Where is my request?",
                    "response": "It is in review.",
                    "expected_response": "It is in review.",
                }
            ],
        ).status_code
        == 201
    )

    def _run(label: str) -> str:
        resp = client.post(
            "/evaluation/runs",
            json={
                "experiment_id": shared_id,
                "name": f"Compare {label} {token}",
                "dataset_version": "iso_v1",
                "target_endpoint": "https://example.com",
                "scenario": "llm_core",
                "tenant_id": tenant_a,
            },
        )
        assert resp.status_code == 201, resp.text
        return resp.json()["run_id"]

    base_id = _run("base")
    cand_id = _run("cand")
    _act_as(client, tenant_b)
    other = _create_tenant_run(client, tenant_id=tenant_b, token=f"{token}b")

    _act_as(client, tenant_a)
    same = client.get(
        f"/evaluation/experiments/{shared_id}/compare"
        f"?base_run_id={base_id}&candidate_run_id={cand_id}&tenant_id={tenant_a}"
    )
    assert same.status_code == 200, same.text

    missing = client.get(
        f"/evaluation/experiments/{shared_id}/compare"
        f"?base_run_id={base_id}&candidate_run_id={cand_id}"
    )
    assert missing.status_code == 422

    blank = client.get(
        f"/evaluation/experiments/{shared_id}/compare"
        f"?base_run_id={base_id}&candidate_run_id={cand_id}&tenant_id="
    )
    assert blank.status_code == 422

    # Cross-tenant: a caller acting as B cannot compare A's runs. Asking for
    # A's scope while acting as B is refused before any lookup; asking within
    # B's own scope finds nothing of A's.
    _act_as(client, tenant_b)
    # Acting as B, naming A's scope is refused before any lookup.
    cross_scope = client.get(
        f"/evaluation/experiments/{shared_id}/compare"
        f"?base_run_id={base_id}&candidate_run_id={cand_id}&tenant_id={tenant_a}"
    )
    assert cross_scope.status_code == 403, cross_scope.text
    cross = client.get(
        f"/evaluation/experiments/{shared_id}/compare"
        f"?base_run_id={base_id}&candidate_run_id={cand_id}&tenant_id={tenant_b}"
    )
    assert cross.status_code == 404, cross.text
    _act_as(client, tenant_a)

    foreign = client.get(
        f"/evaluation/experiments/{shared_id}/compare"
        f"?base_run_id={base_id}&candidate_run_id={other['run_id']}&tenant_id={tenant_a}"
    )
    assert foreign.status_code == 404, foreign.text

    # The BASE side must be scoped exactly like the candidate side: a foreign
    # base run leaks its KPI scores, gates and metric failures into the
    # comparison payload if only the candidate is checked.
    foreign_base = client.get(
        f"/evaluation/experiments/{shared_id}/compare"
        f"?base_run_id={other['run_id']}&candidate_run_id={cand_id}&tenant_id={tenant_a}"
    )
    assert foreign_base.status_code == 404, foreign_base.text


def test_compare_accepts_the_gateway_slug_for_a_namespace_scoped_experiment(client, monkeypatch):
    """Ownership is decided in the namespace value-space, not by raw string.

    ``enforce_tenant``/``tenants_match`` treat ``evalai`` and
    ``tenant-evalai`` as the same tenant, so the compare endpoint must too —
    otherwise a non-UI caller sending the gateway slug gets a bogus 404.
    """
    token = uuid4().hex[:12]
    slug = f"slugtest-{token}"
    namespace = f"tenant-{slug}"
    experiment_id = f"exp-slug-{token}"
    from evalhub.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", namespace)
    _act_as(client, slug)
    created = client.post(
        "/evaluation/experiments",
        json={
            "experiment_id": experiment_id,
            "name": f"Slug fixture {token}",
            "dataset_version": "iso_v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "domain": "general",
            "tenant_id": namespace,
        },
    )
    assert created.status_code == 201, created.text
    assert (
        client.post(
            f"/evaluation/experiments/{experiment_id}/rows",
            json=[
                {
                    "row_id": f"{token}-slug-row-1",
                    "query": "Where is my request?",
                    "response": "It is in review.",
                    "expected_response": "It is in review.",
                }
            ],
        ).status_code
        == 201
    )

    def _run(label: str) -> str:
        resp = client.post(
            "/evaluation/runs",
            json={
                "experiment_id": experiment_id,
                "name": f"Slug {label} {token}",
                "dataset_version": "iso_v1",
                "target_endpoint": "https://example.com",
                "scenario": "llm_core",
                "tenant_id": namespace,
            },
        )
        assert resp.status_code == 201, resp.text
        return resp.json()["run_id"]

    base_id = _run("base")
    cand_id = _run("cand")

    for form in (namespace, slug):
        resp = client.get(
            f"/evaluation/experiments/{experiment_id}/compare"
            f"?base_run_id={base_id}&candidate_run_id={cand_id}&tenant_id={form}"
        )
        assert resp.status_code == 200, (form, resp.text)

    # Normalizing must not make an unrelated tenant match: an unrelated scope
    # is refused for this caller, and a caller acting AS that tenant finds
    # nothing of this experiment's.
    other = client.get(
        f"/evaluation/experiments/{experiment_id}/compare"
        f"?base_run_id={base_id}&candidate_run_id={cand_id}&tenant_id=tenant-other-{token}"
    )
    assert other.status_code == 403, other.text

    monkeypatch.setattr(settings, "pod_namespace", f"tenant-other-{token}")
    _act_as(client, f"other-{token}")
    as_other = client.get(
        f"/evaluation/experiments/{experiment_id}/compare"
        f"?base_run_id={base_id}&candidate_run_id={cand_id}&tenant_id=tenant-other-{token}"
    )
    assert as_other.status_code == 404, as_other.text


@pytest.fixture
async def store():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        s = EvaluationStore(session)
        await s.seed_definitions()
        yield s
    await engine.dispose()


def _tenant_experiment(experiment_id: str, tenant_id: str) -> ExperimentDefinition:
    return ExperimentDefinition(
        experiment_id=experiment_id,
        name=f"Isolation {experiment_id}",
        dataset_version="iso_v1",
        target_endpoint="https://example.com",
        scenario="llm_core",
        domain="general",
        tenant_id=tenant_id,
    )


def _row(row_id: str) -> EvaluationRow:
    return EvaluationRow(
        row_id=row_id,
        query="Where is my request?",
        response="It is in review.",
        expected_response="It is in review.",
    )


@pytest.mark.asyncio
async def test_compare_runs_refuses_foreign_run_linked_into_local_experiment(store):
    """A linked-in run owned by another tenant must not be readable via compare.

    ``experiment_has_run`` consults the ExperimentRunLink table, while ``get_run``
    scopes by the run's OWNING experiment. Those are different relations, so a
    tenant-B run linked into a tenant-A experiment passes the link check — only
    the tenant-scoped ``get_run`` stops the read. Without that scoping this
    comparison would succeed and expose tenant B's run payload, so this test
    fails if the tenant argument is ever dropped.
    """
    engine = EvaluationEngine(judge=MockJudge())
    tenant_a, tenant_b = "tenant-a-linked", "tenant-b-linked"

    exp_a = await store.save_experiment(_tenant_experiment("exp-linked-a", tenant_a))
    exp_b = await store.save_experiment(_tenant_experiment("exp-linked-b", tenant_b))

    rows_a = [_row("linked-row-a")]
    rows_b = [_row("linked-row-b")]
    await store.add_rows(exp_a.experiment_id, tenant_a, rows_a)
    await store.add_rows(exp_b.experiment_id, tenant_b, rows_b)

    run_a = await store.save_run(engine.execute(exp_a, rows_a), rows_a)
    run_b = await store.save_run(engine.execute(exp_b, rows_b), rows_b)

    # Forge the cross-tenant link the attach flow would create for same-tenant runs.
    await store.link_runs_to_experiment(exp_a.experiment_id, [run_a.run_id, run_b.run_id])

    # The link check cannot stop this read: tenant B's run IS linked to A's experiment.
    assert await store.experiment_has_run(exp_a.experiment_id, run_b.run_id)
    # Only the tenant argument stops it — unscoped the run is fully readable.
    assert await store.get_run(run_b.run_id) is not None
    assert await store.get_run(run_b.run_id, tenant_id=tenant_a) is None

    with pytest.raises(ValueError, match=f"Candidate run {run_b.run_id} not found"):
        await store.compare_runs(
            exp_a.experiment_id,
            run_a.run_id,
            run_b.run_id,
            tenant_id=tenant_a,
        )

    # Mirror assertion for the BASE slot. Both runs are loaded with the same
    # tenant argument, so dropping it from either one leaks the foreign run.
    with pytest.raises(ValueError, match=f"Base run {run_b.run_id} not found"):
        await store.compare_runs(
            exp_a.experiment_id,
            run_b.run_id,
            run_a.run_id,
            tenant_id=tenant_a,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("workspace_tenant", "owner_tenant"),
    [("tenant-spelled", "spelled"), ("spelled", "tenant-spelled")],
)
async def test_compare_runs_accepts_equivalent_tenant_spellings(
    store, workspace_tenant: str, owner_tenant: str, monkeypatch
):
    """Attachment and compare must agree on what "same tenant" means.

    A run may join a workspace whenever ``tenants_match`` holds, so ``evalai``
    and ``tenant-evalai`` are the same tenant there. If compare scopes its run
    reads by one exact spelling, a legitimately attached run becomes uncomparable
    and both runs 404 — this asserts the two spellings stay interchangeable in
    both directions, without letting an unrelated tenant in.
    """
    from evalhub.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", "tenant-spelled")
    engine = EvaluationEngine(judge=MockJudge())

    workspace = await store.save_experiment(
        _tenant_experiment("exp-spelled-workspace", workspace_tenant)
    )
    owner = await store.save_experiment(_tenant_experiment("exp-spelled-owner", owner_tenant))
    assert tenants_match(owner.tenant_id or "", workspace.tenant_id or "")

    rows = [_row("spelled-row-1")]
    await store.add_rows(owner.experiment_id, owner.tenant_id, rows)
    base = await store.save_run(engine.execute(owner, rows), rows)
    candidate = await store.save_run(engine.execute(owner, rows), rows)

    # The attachment the workspace flow permits between these two spellings.
    await store.link_runs_to_experiment(
        workspace.experiment_id, [base.run_id, candidate.run_id]
    )

    comparison = await store.compare_runs(
        workspace.experiment_id,
        base.run_id,
        candidate.run_id,
        tenant_id=workspace.tenant_id,
    )
    assert comparison.base_run_id == base.run_id
    assert comparison.candidate_run_id == candidate.run_id

    # Normalizing spellings must not make an unrelated tenant match.
    for foreign in ("tenant-spelled-other", "spelled-other"):
        with pytest.raises(ValueError, match=f"Base run {base.run_id} not found"):
            await store.compare_runs(
                workspace.experiment_id,
                base.run_id,
                candidate.run_id,
                tenant_id=foreign,
            )


@pytest.mark.asyncio
async def test_list_runs_for_experiment_excludes_a_linked_foreign_run(store):
    """A foreign run linked into a local experiment must not be hydrated.

    The link table and a run's OWNING experiment are different relations, so the
    link check alone cannot prove tenancy. Without the tenant argument the foreign
    run is returned and then appears in the workspace run list and summary.
    """
    engine = EvaluationEngine(judge=MockJudge())
    tenant_a, tenant_b = "tenant-a-listruns", "tenant-b-listruns"

    exp_a = await store.save_experiment(_tenant_experiment("exp-listruns-a", tenant_a))
    exp_b = await store.save_experiment(_tenant_experiment("exp-listruns-b", tenant_b))
    rows_a = [_row("listruns-row-a")]
    rows_b = [_row("listruns-row-b")]
    await store.add_rows(exp_a.experiment_id, tenant_a, rows_a)
    await store.add_rows(exp_b.experiment_id, tenant_b, rows_b)
    run_a = await store.save_run(engine.execute(exp_a, rows_a), rows_a)
    run_b = await store.save_run(engine.execute(exp_b, rows_b), rows_b)

    # Forge the cross-tenant link the attach flow creates for same-tenant runs.
    await store.link_runs_to_experiment(exp_a.experiment_id, [run_a.run_id, run_b.run_id])

    unscoped = await store.list_runs_for_experiment(exp_a.experiment_id)
    assert {r.run_id for r in unscoped} == {run_a.run_id, run_b.run_id}

    scoped = await store.list_runs_for_experiment(exp_a.experiment_id, tenant_id=tenant_a)
    assert {r.run_id for r in scoped} == {run_a.run_id}


@pytest.mark.asyncio
async def test_experiment_crud_is_tenant_scoped(store):
    """get_experiment / list_experiments / update_experiment must not cross tenants.

    Before this fix these three methods took no tenant argument at all — any
    caller holding an experiment id could read or patch any tenant's
    experiment, and ``list_experiments`` returned the whole table regardless
    of caller identity.
    """
    tenant_a, tenant_b = "tenant-a-crud", "tenant-b-crud"
    exp_a = await store.save_experiment(_tenant_experiment("exp-crud-a", tenant_a))
    await store.save_experiment(_tenant_experiment("exp-crud-b", tenant_b))

    assert await store.get_experiment(exp_a.experiment_id, tenant_a) is not None
    assert await store.get_experiment(exp_a.experiment_id, tenant_b) is None

    listed_a = await store.list_experiments(tenant_a)
    assert {e.experiment_id for e in listed_a} == {exp_a.experiment_id}

    assert await store.update_experiment(exp_a.experiment_id, tenant_b, {"name": "hijacked"}) is None
    updated = await store.update_experiment(exp_a.experiment_id, tenant_a, {"name": "renamed"})
    assert updated is not None
    assert updated.name == "renamed"



@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["pending", "running", "awaiting_trace", "failed", "cancelled"])
async def test_job_status_without_completed_result_is_tenant_scoped(store, status, monkeypatch):
    from fastapi import HTTPException, Request

    from evalhub.api.v1.evaluation import get_run

    run_id = await store.create_run_job(
        dataset_name="private-dataset", tenant_id="tenant-owner", response_source="baseline",
        agent=None, row_count=None, judge_model=None,
    )
    job = await store.get_run_job(run_id)
    job.status = status
    job.error_message = "private diagnostic"
    await store.session.commit()
    foreign = Request({"type": "http", "headers": [(b"x-evalai-tenant", b"tenant-foreign")]})
    with pytest.raises(HTTPException) as denied:
        await get_run(run_id, foreign, "tenant-foreign", store)
    assert denied.value.status_code == 404
    from evalhub.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", "tenant-owner")
    for spelling in ("owner", "tenant-owner"):
        owner = Request({"type": "http", "headers": [(b"x-evalai-tenant", b"owner")]})
        payload = await get_run(run_id, owner, spelling, store)
        assert payload["status"] == status
        assert payload["dataset_name"] == "private-dataset"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["pending", "running", "awaiting_trace", "blocked", "failed", "cancelled"])
async def test_run_listing_scopes_unfinished_jobs_to_caller(store, status, monkeypatch):
    from fastapi import Request

    from evalhub.api.v1.evaluation import list_runs
    from evalhub.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", "tenant-owner")
    expected_ids = set()
    for tenant in ("owner", "tenant-owner", "tenant-foreign", None):
        run_id = await store.create_run_job(
            dataset_name=f"private-{tenant}", tenant_id=tenant, response_source="baseline",
            agent=None, row_count=None, judge_model=None,
        )
        job = await store.get_run_job(run_id)
        job.status = status
        job.error_message = f"diagnostic-{tenant}"
        if tenant in {"owner", "tenant-owner"}:
            expected_ids.add(run_id)
    await store.session.commit()

    caller = Request({"type": "http", "headers": [(b"x-evalai-tenant", b"owner")]})
    for spelling in ("owner", "tenant-owner"):
        result = await list_runs(caller, spelling, store)
        assert {item["run_id"] for item in result} == expected_ids
        assert {item["status"] for item in result} == {status}
        assert "private-tenant-foreign" not in str(result)
        assert "diagnostic-tenant-foreign" not in str(result)
        assert "private-None" not in str(result)
        assert "diagnostic-None" not in str(result)


@pytest.mark.asyncio
async def test_rescore_checks_source_owner_before_enqueue_and_preserves_tenant(store):
    from fastapi import HTTPException, Request
    from sqlalchemy import func, select

    from evalhub.api.v1.evaluation import ExperimentRunRequest, create_experiment_rescore, get_run
    from evalhub.db.models import RunJobORM
    from evalhub.evaluation.run_service import execute_rescore

    tenant = "tenant-rescore-owner"
    engine = EvaluationEngine(judge=MockJudge())
    experiment = await store.save_experiment(_tenant_experiment("exp-rescore-owner", tenant))
    rows = [_row("rescore-row")]
    source = await store.save_run(engine.execute(experiment, rows), rows)
    options = ExperimentRunRequest(source_run_id=source.run_id)
    foreign = Request({"type": "http", "headers": [(b"x-evalai-tenant", b"tenant-foreign")]})

    with pytest.raises(HTTPException) as denied:
        await create_experiment_rescore(experiment.experiment_id, foreign, options, store)
    assert denied.value.status_code == 403
    assert await store.session.scalar(select(func.count()).select_from(RunJobORM)) == 0

    caller = Request({"type": "http", "headers": [(b"x-evalai-tenant", tenant.encode())]})
    queued = await create_experiment_rescore(experiment.experiment_id, caller, options, store)
    job = await store.get_run_job(queued["run_id"])
    assert job.tenant_id == tenant
    await execute_rescore(
        run_id=job.run_id, source_run_id=job.params["source_run_id"],
        active_metrics=job.params["active_metrics"], judge_model=job.judge_model,
        created_by=job.params["created_by"], source_evidence_snapshot=job.params["source_evidence_snapshot"],
        store=store, engine=engine,
    )
    saved = await store.get_run(job.run_id)
    assert saved.experiment.tenant_id == source.experiment.tenant_id == tenant
    assert saved.diagnostic_only is True
    with pytest.raises(HTTPException) as denied:
        await get_run(job.run_id, foreign, "tenant-foreign", store)
    assert denied.value.status_code == 404
