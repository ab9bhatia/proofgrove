"""Baseline promotion audit trail + undo.

Every baseline change records who did it, when, and the previous/new baseline
run. History is readable, and an undo re-promotes the previous baseline while
itself being recorded as an audited change.

The in-memory SQLite database is shared across tests in a process, so each test
provisions its own experiment id to keep its baseline history isolated.
"""

import pytest

from evalhub.platform import authz
from evalhub.settings import settings
from tests.conftest import act_as

#: Most tests seed from the sample experiment, which belongs to the sample
#: tenant; the client acts as that one.
TENANT = "tenant-sample"


def _experiment_with_rows(client, experiment_id: str, *, sample_id: str = "exp-llm-core-v1"):
    samples = client.get("/evaluation/sample-experiments").json()
    source = next(s for s in samples if s["experiment_id"] == sample_id)
    # A run's experiment_version_id is derived from the contract hash, which is
    # shared across experiments with identical contracts. Give each baseline
    # experiment a distinct target so it gets its own version row and never
    # hijacks the shared sample experiment's version association.
    body = {
        **source,
        "experiment_id": experiment_id,
        "name": f"{source['name']} {experiment_id}",
        "target_endpoint": f"https://{experiment_id}.example.com/v1/chat",
    }
    created = client.post("/evaluation/experiments", json=body)
    assert created.status_code == 201, created.text
    rows = client.get(f"/evaluation/experiments/{sample_id}/rows").json()
    rows = [{**row, "row_id": f"{experiment_id}-{row['row_id']}"} for row in rows]
    added = client.post(f"/evaluation/experiments/{experiment_id}/rows", json=rows)
    assert added.status_code == 201, added.text
    return body


def _run(client, experiment: dict, correlation_id: str):
    resp = client.post(
        f"/evaluation/runs?correlation_id={correlation_id}", json=experiment
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_baseline_change_writes_audit_and_history_returns_it(client):
    exp_id = "exp-baseline-audit-history"
    experiment = _experiment_with_rows(client, exp_id)
    r1 = _run(client, experiment, "bl-audit-1")
    r2 = _run(client, experiment, "bl-audit-2")

    first = client.post(
        f"/evaluation/experiments/{exp_id}/baseline", json={"run_id": r1["run_id"]}
    )
    assert first.status_code == 200, first.text
    assert first.json()["new_baseline_run_id"] == r1["run_id"]
    assert first.json()["previous_baseline_run_id"] is None

    second = client.post(
        f"/evaluation/experiments/{exp_id}/baseline", json={"run_id": r2["run_id"]}
    )
    assert second.status_code == 200, second.text
    assert second.json()["previous_baseline_run_id"] == r1["run_id"]
    assert second.json()["new_baseline_run_id"] == r2["run_id"]

    summary = client.get(f"/evaluation/experiments/{exp_id}/summary").json()
    assert summary["baseline_run_id"] == r2["run_id"]

    history = client.get(f"/evaluation/experiments/{exp_id}/baseline/history")
    assert history.status_code == 200, history.text
    changes = history.json()
    assert len(changes) == 2
    # Newest first.
    assert changes[0]["new_baseline_run_id"] == r2["run_id"]
    assert changes[0]["previous_baseline_run_id"] == r1["run_id"]
    assert changes[0]["action"] == "promote"
    assert changes[0]["actor"]
    assert changes[0]["created_at"]


def test_baseline_undo_restores_previous_baseline(client):
    exp_id = "exp-baseline-undo"
    experiment = _experiment_with_rows(client, exp_id)
    r1 = _run(client, experiment, "bl-undo-1")
    r2 = _run(client, experiment, "bl-undo-2")

    client.post(f"/evaluation/experiments/{exp_id}/baseline", json={"run_id": r1["run_id"]})
    client.post(f"/evaluation/experiments/{exp_id}/baseline", json={"run_id": r2["run_id"]})

    undo = client.post(f"/evaluation/experiments/{exp_id}/baseline/undo")
    assert undo.status_code == 200, undo.text
    assert undo.json()["new_baseline_run_id"] == r1["run_id"]
    assert undo.json()["previous_baseline_run_id"] == r2["run_id"]
    assert undo.json()["action"] == "undo"

    summary = client.get(f"/evaluation/experiments/{exp_id}/summary").json()
    assert summary["baseline_run_id"] == r1["run_id"]

    # The undo is itself an audited baseline change.
    history = client.get(f"/evaluation/experiments/{exp_id}/baseline/history").json()
    assert len(history) == 3
    assert history[0]["action"] == "undo"
    assert history[0]["new_baseline_run_id"] == r1["run_id"]


def test_baseline_undo_without_history_is_rejected(client):
    exp_id = "exp-baseline-undo-empty"
    experiment = _experiment_with_rows(client, exp_id)
    _run(client, experiment, "bl-undo-empty-1")

    undo = client.post(f"/evaluation/experiments/{exp_id}/baseline/undo")
    assert undo.status_code == 409, undo.text


def _tenant_experiment_with_rows(client, experiment_id: str, tenant_id: str):
    act_as(client, tenant_id)
    samples = client.get("/evaluation/sample-experiments").json()
    source = next(s for s in samples if s["experiment_id"] == "exp-llm-core-v1")
    body = {
        **source,
        "experiment_id": experiment_id,
        "tenant_id": tenant_id,
        "name": f"{source['name']} {experiment_id}",
        "target_endpoint": f"https://{experiment_id}.example.com/v1/chat",
    }
    assert client.post("/evaluation/experiments", json=body).status_code == 201
    rows = client.get("/evaluation/experiments/exp-llm-core-v1/rows").json()
    rows = [{**row, "row_id": f"{experiment_id}-{row['row_id']}"} for row in rows]
    assert client.post(f"/evaluation/experiments/{experiment_id}/rows", json=rows).status_code == 201
    return body


def test_baseline_change_records_the_request_actor(client):
    exp_id = "exp-baseline-actor"
    experiment = _experiment_with_rows(client, exp_id)
    r1 = _run(client, experiment, "bl-actor-1")

    promote = client.post(
        f"/evaluation/experiments/{exp_id}/baseline",
        json={"run_id": r1["run_id"]},
        headers={"x-evalai-subject": "alice@example.com"},
    )
    assert promote.status_code == 200, promote.text
    assert promote.json()["actor"] == "alice@example.com"

    history = client.get(f"/evaluation/experiments/{exp_id}/baseline/history").json()
    assert history[0]["actor"] == "alice@example.com"


def test_baseline_endpoints_reject_a_mismatched_tenant(client):
    exp_id = "exp-baseline-tenant"
    experiment = _tenant_experiment_with_rows(client, exp_id, tenant_id="tenant-alpha")
    r1 = _run(client, experiment, "bl-tenant-1")

    wrong = {"x-evalai-tenant": "tenant-beta"}
    promote = client.post(
        f"/evaluation/experiments/{exp_id}/baseline",
        json={"run_id": r1["run_id"]},
        headers=wrong,
    )
    assert promote.status_code == 404, promote.text

    # A caller from the owning tenant succeeds, then the other two endpoints are
    # rejected the same way for the wrong tenant.
    ok = client.post(
        f"/evaluation/experiments/{exp_id}/baseline",
        json={"run_id": r1["run_id"]},
        headers={"x-evalai-tenant": "tenant-alpha"},
    )
    assert ok.status_code == 200, ok.text

    assert client.get(
        f"/evaluation/experiments/{exp_id}/baseline/history", headers=wrong
    ).status_code == 404
    assert client.post(
        f"/evaluation/experiments/{exp_id}/baseline/undo", headers=wrong
    ).status_code == 404


@pytest.mark.parametrize("action", ["baseline", "baseline/undo"])
def test_baseline_mutations_require_approval_despite_experiment_name(client, monkeypatch, action):
    exp_id = "comments-baseline-review"
    experiment = _experiment_with_rows(client, exp_id)
    first = _run(client, experiment, "permission-first")
    second = _run(client, experiment, "permission-second")
    base = f"/evaluation/experiments/{exp_id}"
    for run in [first, second]:
        assert client.post(base + "/baseline", json={"run_id": run["run_id"]}).status_code == 200
    history = client.get(base + "/baseline/history").json()
    allowed = {"evaluation.read", "governance.review"}

    async def check_permission(request, permission):
        if permission not in allowed:
            return False
        request.state.eval_hub_permissions = {*getattr(request.state, "eval_hub_permissions", set()), permission}
        return True

    monkeypatch.setattr(settings, "platform_auth_required", True)
    monkeypatch.setattr(authz, "check_permission", check_permission)
    client.headers["x-evalai-sub"] = "synthetic-reviewer"
    payload = {"run_id": first["run_id"]} if action == "baseline" else None
    denied = client.post(f"{base}/{action}", json=payload)
    assert denied.status_code == 403, denied.text
    assert client.get(base + "/summary").json()["baseline_run_id"] == second["run_id"]
    assert client.get(base + "/baseline/history").json() == history

    allowed.add("governance.approve")
    changed = client.post(f"{base}/{action}", json=payload)
    assert changed.status_code == 200, changed.text
    assert client.get(base + "/summary").json()["baseline_run_id"] == first["run_id"]
    assert len(client.get(base + "/baseline/history").json()) == len(history) + 1
