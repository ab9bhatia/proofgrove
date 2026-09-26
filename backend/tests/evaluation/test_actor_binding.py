"""Actor attribution on evaluation-workspace write routes.

Workspace create (pre-run and from-runs), the experiment version snapshot, and
the saved-evidence rescore enqueue all accept a body-supplied ``created_by``
and persist it as the actor of record. Under ``platform_auth_required`` the
authenticated subject (``x-evalai-sub``) must win over the body -- the same
pattern already used for experiment decisions (``PATCH .../decisions``,
``approved_by=actor_from_request(request) if settings.platform_auth_required
else body.approved_by``). With auth off (local dev), the body value must
still be used unchanged.
"""

import pytest
from pydantic import SecretStr

from proofgrove.db.session import async_session
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.judge import MockJudge
from proofgrove.evaluation.sample_data import SAMPLE_EXPERIMENTS, get_sample_rows
from proofgrove.platform import authz
from proofgrove.settings import settings
from tests.platform.test_action_authorization import _AuthzClient

TENANT = "tenant-eval-actor-binding"
FORGED = "mallory"
VERIFIED = "alice"


def _headers(*, subject: str | None = VERIFIED) -> dict:
    headers = {"x-evalai-tenant": TENANT}
    if subject is not None:
        headers["x-evalai-sub"] = subject
    return headers


def _allow_authz(monkeypatch, auth_required: bool) -> None:
    """Every POST route in this file requires PERMISSION_EVALUATION_RUN via
    AuthorizationMiddleware; stub the outbound check_permission() call when
    auth is required, same pattern as test_dataset_lifecycle_guards.py."""
    if not auth_required:
        return
    monkeypatch.setattr(settings, "pod_namespace", "")
    monkeypatch.setattr(settings, "authz_check_token", SecretStr("synthetic-check-token"))
    monkeypatch.setattr(authz.httpx, "AsyncClient", lambda **kwargs: _AuthzClient(True, []))


async def _persisted_run(experiment_id: str):
    """A completed run with a real comparison basis, saved to the app's own
    per-test database (async_session() always resolves against the current
    settings.database_url, same as the app's get_evaluation_store dependency)."""
    experiment = SAMPLE_EXPERIMENTS[0].model_copy(update={"experiment_id": experiment_id, "tenant_id": TENANT})
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    run = EvaluationEngine(judge=MockJudge()).execute(experiment, rows)
    async with async_session() as session:
        store = EvaluationStore(session)
        await store.save_run(run, rows)
    return run


@pytest.mark.parametrize("auth_required", [True, False])
async def test_create_pre_run_workspace_binds_actor(async_client, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    resp = await async_client.post(
        "/evaluation/experiments/workspaces",
        json={"tenant_id": TENANT, "name": "pre-run-ws", "created_by": FORGED},
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["experiment"]["created_by"] == (VERIFIED if auth_required else FORGED)


@pytest.mark.parametrize("auth_required", [True, False])
async def test_create_workspace_from_runs_binds_actor(async_client, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    run = await _persisted_run(f"exp-from-runs-{auth_required}")
    resp = await async_client.post(
        "/evaluation/experiments/from-runs",
        json={
            "tenant_id": TENANT,
            "name": "from-runs-ws",
            "run_ids": [run.run_id],
            "baseline_run_id": run.run_id,
            "created_by": FORGED,
        },
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["experiment"]["created_by"] == (VERIFIED if auth_required else FORGED)


@pytest.mark.parametrize("auth_required", [True, False])
async def test_create_experiment_version_binds_actor(async_client, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    experiment_id = f"exp-version-{auth_required}"
    await _persisted_run(experiment_id)
    # save_experiment_version is content-addressed (keyed by a fingerprint of
    # the contract + active_metrics, not by experiment_id) and idempotent --
    # _persisted_run's own run save already snapshots a version with the
    # default metric set, so re-requesting that same fingerprint would just
    # return the pre-existing row untouched. A distinct metrics list forces a
    # genuinely new row so this test observes the create path, not a replay.
    resp = await async_client.post(
        f"/evaluation/experiments/{experiment_id}/versions",
        json={"created_by": FORGED, "active_metrics": [f"actor-binding-probe-{auth_required}"]},
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["created_by"] == (VERIFIED if auth_required else FORGED)


@pytest.mark.parametrize("auth_required", [True, False])
async def test_create_experiment_binds_actor(async_client, monkeypatch, auth_required):
    """POST /experiments takes the whole ExperimentDefinition as its body and
    persists it verbatim via store.save_experiment -- a grep for an explicit
    ``.created_by`` field reference misses this because the field is never
    named in the handler, only passed through wholesale."""
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    resp = await async_client.post(
        "/evaluation/experiments",
        json={
            "name": f"exp-create-{auth_required}",
            "dataset_version": "general_qa_v1",
            "target_endpoint": "http://target.test",
            "scenario": "llm_core",
            "tenant_id": TENANT,
            "created_by": FORGED,
        },
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["created_by"] == (VERIFIED if auth_required else FORGED)


@pytest.mark.parametrize("auth_required", [True, False])
async def test_create_run_binds_first_time_experiment_actor(async_client, monkeypatch, auth_required):
    """POST /runs embeds an ExperimentDefinition too; save_run's "not exp_orm"
    branch persists it (including created_by) the first time that
    experiment_id is seen.

    The only reachable way to hit that branch through this route is the
    sample-fallback path (a real, not-yet-existing experiment_id can never
    have rows -- DatasetRowORM.experiment_id is a foreign key to
    experiments.experiment_id, so rows cannot exist before their parent
    experiment does). A well-known sample id under a fresh tenant is
    namespaced to "<id>--<tenant>" and takes that fallback, which replaces
    the whole ``experiment`` object with a copy of the SAMPLE definition --
    so the body's ``created_by`` was never reachable here even before this
    fix, auth on or off. What this fix actually changes: instead of every
    such run being permanently attributed to the sample's own "system"
    default, an authenticated caller's real identity now wins. Auth-off
    behaviour (the sample default persists) is unchanged from before.
    """
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    resp = await async_client.post(
        "/evaluation/runs",
        json={
            "experiment_id": "exp-llm-core-v1",
            "name": f"exp-run-create-{auth_required}",
            "dataset_version": "general_qa_v1",
            "target_endpoint": "http://target.test",
            "scenario": "llm_core",
            "tenant_id": TENANT,
            "created_by": FORGED,
        },
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["experiment"]["created_by"] == (VERIFIED if auth_required else "system")


@pytest.mark.parametrize("auth_required", [True, False])
async def test_create_experiment_rescore_binds_actor(async_client, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    experiment_id = f"exp-rescore-{auth_required}"
    run = await _persisted_run(experiment_id)
    resp = await async_client.post(
        f"/evaluation/experiments/{experiment_id}/rescores",
        json={"source_run_id": run.run_id, "created_by": FORGED},
        headers=_headers(),
    )
    assert resp.status_code == 202, resp.text
    rescore_run_id = resp.json()["run_id"]
    async with async_session() as session:
        job = await EvaluationStore(session).get_run_job(rescore_run_id, tenant_id=TENANT)
    assert job is not None
    assert job.params["created_by"] == (VERIFIED if auth_required else FORGED)
