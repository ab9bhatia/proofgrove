"""Public creates cannot supply earned evidence, history ordering, or lifecycle state."""

import pytest

from evalhub.platform import authz
from evalhub.settings import settings
from tests.conftest import act_as
from tests.platform.test_review_decision_history import _finding_with_task

TENANT = "tenant-proof"


def enable_auth(client, monkeypatch):
    async def grant(request, permission):
        request.state.eval_hub_permissions = {*getattr(request.state, "eval_hub_permissions", set()), permission}
        return True
    monkeypatch.setattr(settings, "platform_auth_required", True)
    monkeypatch.setattr(authz, "check_permission", grant)
    client.headers["x-evalai-sub"] = "synthetic-reviewer"


def test_profile_creation_cannot_forge_dry_run_or_override(client, monkeypatch):
    enable_auth(client, monkeypatch)
    for claimed in ["tested", "overridden"]:
        created = client.post("/platform/quality-profiles", json={
            "profile_id": claimed, "version": "1", "tenant_id": TENANT, "name": claimed,
            "metric_ids": ["llm.relevance"], "test_status": claimed,
            "test_run_id": "nonexistent", "tested_by": "forged", "test_note": "pretend",
            "tested_at": "2000-01-01T00:00:00Z",
        })
        assert created.status_code == 201, created.text
        assert created.json()["test_status"] == "not_tested"
        assert all(created.json()[k] is None for k in ["test_run_id", "tested_by", "test_note", "tested_at"])
        url = f"/platform/quality-profiles/{claimed}/versions/1"
        assert client.post(url + "/validate", params={"tenant_id": TENANT}).status_code == 200
        approved = client.post(url + "/approve", params={"tenant_id": TENANT})
        assert approved.status_code == 409, approved.text
        marked = client.post(url + "/mark-tested", params={"tenant_id": TENANT}, json={"mode": "overridden", "note": "synthetic explicit override"})
        assert marked.status_code == 200, marked.text
        assert client.post(url + "/approve", params={"tenant_id": TENANT}).status_code == 200


@pytest.mark.parametrize("kind,id_key", [("quality-profiles", "profile_id"), ("gate-policies", "gate_policy_id")])
def test_validation_checks_scope_before_mutation(client, monkeypatch, kind, id_key):
    enable_auth(client, monkeypatch)
    created = client.post(f"/platform/{kind}", json={id_key: "scope", "version": "1", "tenant_id": TENANT, "name": "scope"})
    assert created.status_code == 201, created.text
    url = f"/platform/{kind}/scope/versions/1"
    act_as(client, "tenant-foreign")
    assert client.post(url + "/validate", params={"tenant_id": TENANT}).status_code == 403
    act_as(client, TENANT)
    assert client.get(url, params={"tenant_id": TENANT}).json()["status"] == "draft"
    assert client.post(url + "/validate", params={"tenant_id": TENANT}).status_code == 200
    assert client.get(url, params={"tenant_id": TENANT}).json()["status"] == "validated"


@pytest.mark.parametrize("kind,payload", [
    ("evaluators", {"evaluator_id": "proof", "execution_mode": "isolated", "adapter": "custom", "implementation": "oci://synthetic.invalid/test:1", "trusted": False}),
    ("metric-packs", {"metric_pack_id": "proof"}),
])
def test_public_catalog_creation_requires_draft(client, monkeypatch, kind, payload):
    enable_auth(client, monkeypatch)
    body = {**payload, "version": "1", "tenant_id": TENANT, "name": "proof", "status": "approved"}
    rejected = client.post(f"/platform/{kind}", json=body)
    assert rejected.status_code == 409, rejected.text
    body["status"] = "draft"
    created = client.post(f"/platform/{kind}", json=body)
    assert created.status_code == 201, created.text


def test_decision_history_and_remediation_state_are_server_owned(client, monkeypatch):
    finding, task = _finding_with_task(client, "proof")
    enable_auth(client, monkeypatch)
    first = client.post("/platform/review-decisions", json={
        "finding_id": finding, "task_id": task, "reviewer": "forged", "outcome": "agree",
        "rationale": "first", "decision_id": "reused", "created_at": "2099-01-01T00:00:00Z",
    })
    second = client.post("/platform/review-decisions", json={
        "finding_id": finding, "task_id": task, "reviewer": "forged", "outcome": "disagree",
        "rationale": "second", "decision_id": "reused", "created_at": "2000-01-01T00:00:00Z",
    })
    assert first.status_code == second.status_code == 201
    assert first.json()["decision_id"] != second.json()["decision_id"] != "reused"
    assert first.json()["created_at"] <= second.json()["created_at"]
    history = client.get(f"/platform/findings/{finding}/review-decisions").json()
    assert [r["rationale"] for r in history] == ["first", "second"]
    assert history[-1]["actor"] == "synthetic-reviewer"
    response = client.post(f"/platform/findings/{finding}/remediations", json={
        "finding_id": finding, "owner": "owner", "description": "fix", "status": "completed",
        "remediation_id": "forged", "created_at": "2000-01-01T00:00:00Z", "updated_at": "2000-01-01T00:00:00Z",
    })
    assert response.status_code == 201, response.text
    assert response.json()["status"] == "open"
    assert response.json()["remediation_id"] != "forged"
    assert response.json()["created_by"] == "synthetic-reviewer"


@pytest.mark.parametrize("profile_id", ["comments-quality", "comments", "remediations-quality", "review-decisions-quality", "review-cases-quality"])
def test_retirement_requires_approval_regardless_of_profile_name(client, monkeypatch, profile_id):
    response = client.post("/platform/quality-profiles", json={
        "profile_id": profile_id, "version": "1", "tenant_id": TENANT, "name": profile_id,
    })
    assert response.status_code == 201, response.text
    url = f"/platform/quality-profiles/{profile_id}/versions/1"
    params = {"tenant_id": TENANT}
    assert client.post(url + "/mark-tested", params=params, json={"mode": "overridden", "note": "test fixture"}).status_code == 200
    assert client.post(url + "/validate", params=params).status_code == 200
    assert client.post(url + "/approve", params=params).status_code == 200

    enable_auth(client, monkeypatch)
    grant = authz.check_permission
    allowed = {"evaluation.read", "governance.review"}

    async def restricted(request, permission):
        return await grant(request, permission) if permission in allowed else False

    monkeypatch.setattr(authz, "check_permission", restricted)
    denied = client.post(url + "/retire", params=params)
    assert denied.status_code == 403, denied.text
    assert client.get(url, params=params).json()["status"] == "approved"
    allowed.add("governance.approve")
    retired = client.post(url + "/retire", params=params)
    assert retired.status_code == 200, retired.text
    assert client.get(url, params=params).json()["status"] == "retired"


@pytest.mark.parametrize("kind,payload", [
    ("gate-policies", {"gate_policy_id": "audit"}),
    ("quality-profiles", {"profile_id": "audit"}),
    ("evaluators", {"evaluator_id": "audit", "execution_mode": "isolated", "adapter": "custom", "implementation": "oci://synthetic.invalid/test:1", "trusted": False}),
    ("metric-packs", {"metric_pack_id": "audit"}),
])
def test_version_approval_rolls_back_when_audit_insert_fails(client, kind, payload):
    from sqlalchemy import event

    from evalhub.db.models import AuditEventORM

    params = {"tenant_id": TENANT}
    body = {**payload, "version": "1", "tenant_id": TENANT, "name": "Audit rollback"}
    created = client.post(f"/platform/{kind}", json=body)
    assert created.status_code == 201
    url = f"/platform/{kind}/audit/versions/1"
    if kind == "quality-profiles":
        marked = client.post(url + "/mark-tested", params=params, json={"mode": "overridden", "note": "test fixture"})
        assert marked.status_code == 200
    if kind in {"gate-policies", "quality-profiles"}:
        validated = client.post(url + "/validate", params=params)
        assert validated.status_code == 200

    def current_version():
        response = client.get(f"/platform/{kind}", params=params)
        assert response.status_code == 200, response.text
        return next(item for item in response.json() if item.get(next(iter(payload))) == "audit")

    before = current_version()
    audits = client.get("/platform/audit-events", params=params).json()

    def fail_audit(*_args):
        raise RuntimeError("synthetic audit insert failure")

    event.listen(AuditEventORM, "before_insert", fail_audit)
    try:
        with pytest.raises(RuntimeError, match="synthetic audit insert failure"):
            client.post(url + "/approve", params=params)
    finally:
        event.remove(AuditEventORM, "before_insert", fail_audit)
    assert current_version() == before
    assert client.get("/platform/audit-events", params=params).json() == audits

    response = client.post(url + "/approve", params=params)
    assert response.status_code == 200, response.text
    assert current_version()["status"] == "approved"
    assert len(client.get("/platform/audit-events", params=params).json()) == len(audits) + 1
