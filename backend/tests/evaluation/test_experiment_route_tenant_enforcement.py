"""Cross-tenant regression tests for the legacy `/evaluation/experiments/*` routes.

These routes used to fetch or mutate an experiment by id with no tenant check
at all: `POST /experiments`, `GET /experiments`, `POST /experiments/{id}/versions`,
`GET /experiments/{id}/versions`, `POST /experiments/{id}/runs/{run_id}/promote`,
`GET /experiments/{id}/decisions`, `POST /experiments/{id}/archive`, and
`POST|GET /experiments/{id}/rows`. Any caller could read or mutate any
tenant's experiment by guessing/enumerating its id. Each now resolves the
experiment's own tenant and calls `enforce_tenant` before acting, mirroring
the pattern already used by `/experiments/{id}/baseline` and
`/experiments/{id}/decisions` (create).
"""

from uuid import uuid4

from tests.conftest import act_as


def _seed_experiment(client, tenant: str, suffix: str) -> str:
    act_as(client, tenant)
    experiment_id = f"exp-tenant-guard-{suffix}"
    created = client.post(
        "/evaluation/experiments",
        json={
            "experiment_id": experiment_id,
            "name": "Tenant guard fixture",
            "dataset_version": "v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "tenant_id": tenant,
        },
    )
    assert created.status_code == 201, created.text
    return experiment_id


def test_create_experiment_rejects_a_body_tenant_the_caller_is_not_authorized_for(client):
    tenant_a = f"tenant-a-{uuid4().hex[:8]}"
    tenant_b = f"tenant-b-{uuid4().hex[:8]}"
    act_as(client, tenant_a)
    response = client.post(
        "/evaluation/experiments",
        json={
            "experiment_id": f"exp-cross-{uuid4().hex[:8]}",
            "name": "Cross tenant",
            "dataset_version": "v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "tenant_id": tenant_b,
        },
    )
    assert response.status_code == 403, response.text


def test_list_experiments_requires_and_scopes_by_tenant(client):
    tenant_a = f"tenant-a-{uuid4().hex[:8]}"
    tenant_b = f"tenant-b-{uuid4().hex[:8]}"
    exp_a = _seed_experiment(client, tenant_a, uuid4().hex[:8])
    _seed_experiment(client, tenant_b, uuid4().hex[:8])

    missing = client.get("/evaluation/experiments")
    assert missing.status_code == 422, missing.text

    act_as(client, tenant_a)
    scoped = client.get(f"/evaluation/experiments?tenant_id={tenant_a}")
    assert scoped.status_code == 200, scoped.text
    ids = {item["experiment_id"] for item in scoped.json()}
    assert exp_a in ids
    assert all(item["tenant_id"] == tenant_a for item in scoped.json())

    refused = client.get(f"/evaluation/experiments?tenant_id={tenant_b}")
    assert refused.status_code == 403, refused.text


def test_experiment_scoped_routes_reject_a_caller_from_another_tenant(client):
    """Every route that operates on one experiment by id must hide the resource from a caller
    acting as a different tenant, rather than silently reading or mutating it.
    """
    tenant_a = f"tenant-a-{uuid4().hex[:8]}"
    tenant_b = f"tenant-b-{uuid4().hex[:8]}"
    experiment_id = _seed_experiment(client, tenant_a, uuid4().hex[:8])

    act_as(client, tenant_b)

    assert client.post(
        f"/evaluation/experiments/{experiment_id}/versions", json={}
    ).status_code == 404
    assert client.get(
        f"/evaluation/experiments/{experiment_id}/versions"
    ).status_code == 404
    assert client.post(
        f"/evaluation/experiments/{experiment_id}/runs/does-not-matter/promote",
        json={"role": "baseline"},
    ).status_code == 404
    assert client.get(
        f"/evaluation/experiments/{experiment_id}/decisions"
    ).status_code == 404
    assert client.post(
        f"/evaluation/experiments/{experiment_id}/archive"
    ).status_code == 404
    assert client.post(
        f"/evaluation/experiments/{experiment_id}/rows",
        json=[{"row_id": "r1", "query": "q", "response": "a"}],
    ).status_code == 404
    foreign_rows = client.get(f"/evaluation/experiments/{experiment_id}/rows")
    assert foreign_rows.status_code == 200
    assert foreign_rows.json() == []

    # The owning tenant may still act on all of them.
    act_as(client, tenant_a)
    assert client.get(
        f"/evaluation/experiments/{experiment_id}/versions"
    ).status_code == 200
    assert client.get(
        f"/evaluation/experiments/{experiment_id}/decisions"
    ).status_code == 200
    assert client.get(
        f"/evaluation/experiments/{experiment_id}/rows"
    ).status_code == 200


def test_direct_run_rejects_a_foreign_tenant_before_execution(client, monkeypatch):
    from evalhub.evaluation.engine import EvaluationEngine

    def unexpected_execution(*args, **kwargs):
        raise AssertionError("a foreign tenant must not execute a run")

    monkeypatch.setattr(EvaluationEngine, "execute", unexpected_execution)
    act_as(client, "tenant-a")
    response = client.post("/evaluation/runs", json={
        "experiment_id": "exp-llm-core-v1",
        "name": "Unauthorized run",
        "dataset_version": "v1",
        "target_endpoint": "https://example.com",
        "scenario": "llm_core",
        "tenant_id": "tenant-b",
    })
    assert response.status_code == 403, response.text
    assert client.get("/evaluation/runs?tenant_id=tenant-a").json() == []


# --- tenant aliases -----------------------------------------------------------


def _experiment_body(experiment_id: str, tenant: str) -> dict:
    return {
        "experiment_id": experiment_id,
        "name": "Alias fixture",
        "dataset_version": "v1",
        "target_endpoint": "https://example.com",
        "scenario": "llm_core",
        "tenant_id": tenant,
    }


def test_experiments_stored_under_the_slug_spelling_are_listed_for_the_namespace(client, monkeypatch):
    """The store widens a tenant lookup to both spellings the deployment accepts
    (``acme`` and ``tenant-acme``); the route used to re-narrow the result with
    an exact comparison and silently drop the caller's own rows."""
    from evalhub.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", "tenant-acme")
    act_as(client, "acme")
    experiment_id = f"exp-alias-{uuid4().hex[:8]}"
    created = client.post("/evaluation/experiments", json=_experiment_body(experiment_id, "acme"))
    assert created.status_code == 201, created.text
    assert created.json()["tenant_id"] == "acme"

    listed = client.get("/evaluation/experiments", params={"tenant_id": "tenant-acme"})
    assert listed.status_code == 200, listed.text
    assert experiment_id in {item["experiment_id"] for item in listed.json()}

    listed_as_slug = client.get("/evaluation/experiments", params={"tenant_id": "acme"})
    assert experiment_id in {item["experiment_id"] for item in listed_as_slug.json()}


def test_workspaces_stored_under_the_slug_spelling_are_listed_for_the_namespace(client, monkeypatch):
    from evalhub.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", "tenant-acme")
    act_as(client, "acme")
    created = client.post(
        "/evaluation/experiments/workspaces",
        json={"tenant_id": "acme", "name": f"alias workspace {uuid4().hex[:6]}"},
    )
    assert created.status_code == 201, created.text
    workspace_id = created.json()["experiment"]["experiment_id"]

    listed = client.get("/evaluation/experiments/workspaces", params={"tenant_id": "tenant-acme"})
    assert listed.status_code == 200, listed.text
    assert workspace_id in {item["experiment"]["experiment_id"] for item in listed.json()}


async def test_attaching_a_run_matches_tenants_by_alias(monkeypatch):
    """``_collect_attach_run_failures`` refused the caller's own run when the run's
    experiment was stored under the other spelling."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from evalhub.api.v1.evaluation import _collect_attach_run_failures
    from evalhub.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", "tenant-acme")
    run = SimpleNamespace(run_id="run-1", status="completed", lineage=SimpleNamespace(comparison_basis_hash="basis", comparison_basis_version="v3"), experiment=SimpleNamespace(tenant_id="acme", experiment_id="exp-1"))
    store = SimpleNamespace(get_run=AsyncMock(return_value=run))
    failures = await _collect_attach_run_failures(store, existing_runs=[], run_ids=["run-1"], tenant_id="tenant-acme")
    assert failures == []
