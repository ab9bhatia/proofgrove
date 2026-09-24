"""Governance correctness foundations: identity, evidence, roles, and drafts."""

import pytest
from fastapi import HTTPException
from pydantic import SecretStr

from evalhub.evaluation.evidence_requirements import (
    CAPTURE_EVIDENCE_CATEGORIES,
    canonicalize_capture_requirements,
)
from evalhub.platform import authz
from evalhub.platform.authz import GOVERNANCE_ROLES
from evalhub.settings import settings
from tests.conftest import act_as
from tests.platform.test_action_authorization import _AuthzClient, _request

TENANT = "tenant-a"


def test_canonical_evidence_maps_aliases_and_rejects_unenforced_names():
    assert canonicalize_capture_requirements(
        ["actual_output", "retrieval_context", "input"]
    ) == ["input", "final_output", "retrieval"]
    with pytest.raises(ValueError, match="canonical runtime capture"):
        canonicalize_capture_requirements(["gate-report"])
    with pytest.raises(ValueError, match="expected_output"):
        canonicalize_capture_requirements(["expected_output"])
    assert set(CAPTURE_EVIDENCE_CATEGORIES) == {
        "input",
        "final_output",
        "tool_calls",
        "tool_results",
        "trace",
        "retrieval",
        "model_usage",
        "lifecycle_events",
    }


def test_profile_and_policy_create_as_draft_and_reject_self_approval(client):
    approved = client.post(
        "/platform/quality-profiles",
        json={
            "profile_id": "self-approved",
            "version": "1.0.0",
            "tenant_id": TENANT,
            "name": "Should stay draft",
            "status": "approved",
            "metric_ids": ["llm.relevance"],
        },
    )
    assert approved.status_code == 422, approved.text
    assert approved.json()["detail"]["field"] == "status"

    created = client.post(
        "/platform/quality-profiles",
        json={
            "profile_id": "kept-draft",
            "version": "1.0.0",
            "tenant_id": TENANT,
            "name": "Draft controls",
            "metric_ids": ["llm.relevance"],
            "evidence_requirements": ["actual_output"],
            "approver_roles": ["eval-hub-approver"],
        },
    )
    assert created.status_code == 201, created.text
    profile = created.json()
    assert profile["status"] == "draft"
    assert profile["evidence_requirements"] == ["final_output"]

    policy = client.post(
        "/platform/gate-policies",
        json={
            "gate_policy_id": "kept-draft-gate",
            "version": "1.0.0",
            "tenant_id": TENANT,
            "name": "Draft gate",
            "status": "approved",
        },
    )
    assert policy.status_code == 422, policy.text


def test_unknown_evidence_and_roles_are_rejected_on_write(client):
    evidence = client.post(
        "/platform/quality-profiles",
        json={
            "profile_id": "mixed-evidence",
            "version": "1.0.0",
            "tenant_id": TENANT,
            "name": "Mixed evidence",
            "metric_ids": ["llm.relevance"],
            "evidence_requirements": ["input", "gate-report"],
        },
    )
    assert evidence.status_code == 422, evidence.text

    roles = client.post(
        "/platform/gate-policies",
        json={
            "gate_policy_id": "fake-roles",
            "version": "1.0.0",
            "tenant_id": TENANT,
            "name": "Fake roles",
            "required_approver_roles": ["evaluation-owner"],
        },
    )
    assert roles.status_code == 422, roles.text
    assert "eval-hub-approver" in roles.json()["detail"]["message"]


def test_two_tenants_can_own_the_same_profile_and_policy_identity(client):
    other = "tenant-b"
    for tenant in (TENANT, other):
        act_as(client, tenant)
        profile = client.post(
            "/platform/quality-profiles",
            json={
                "profile_id": "shared-quality",
                "version": "1.0.0",
                "tenant_id": tenant,
                "name": f"{tenant} quality",
                "metric_ids": ["llm.relevance"],
            },
        )
        assert profile.status_code == 201, profile.text
        policy = client.post(
            "/platform/gate-policies",
            json={
                "gate_policy_id": "shared-gate",
                "version": "1.0.0",
                "tenant_id": tenant,
                "name": f"{tenant} gate",
            },
        )
        assert policy.status_code == 201, policy.text

    act_as(client, TENANT)
    own = client.get("/platform/quality-profiles/shared-quality/versions/1.0.0?tenant_id=tenant-a")
    assert own.status_code == 200
    assert own.json()["name"] == "tenant-a quality"
    listed = client.get("/platform/quality-profiles?tenant_id=tenant-a").json()
    assert {item["name"] for item in listed if item["profile_id"] == "shared-quality"} == {
        "tenant-a quality"
    }

    act_as(client, other)
    other_profile = client.get(
        "/platform/quality-profiles/shared-quality/versions/1.0.0?tenant_id=tenant-b"
    )
    assert other_profile.status_code == 200
    assert other_profile.json()["name"] == "tenant-b quality"


@pytest.fixture
def auth_required():
    previous = (
        settings.platform_auth_required,
        settings.authz_check_token,
        settings.authz_service_url,
        settings.authz_app_name,
    )
    settings.platform_auth_required = True
    settings.authz_check_token = SecretStr("check-token")
    settings.authz_service_url = "http://authz.test:8080"
    settings.authz_app_name = "eval-ai"
    yield
    (
        settings.platform_auth_required,
        settings.authz_check_token,
        settings.authz_service_url,
        settings.authz_app_name,
    ) = previous


@pytest.mark.anyio
async def test_release_decision_enforces_configured_platform_roles(auth_required, monkeypatch):
    calls: list[dict] = []

    def _client(*_args, **_kwargs):
        return _AuthzClient(True, calls)

    monkeypatch.setattr(authz.httpx, "AsyncClient", _client)
    request = _request()
    await authz.require_configured_approver_roles(
        request, ["eval-hub-approver", "eval-hub-reviewer"]
    )
    assert [call["json"]["permission"] for call in calls] == [
        "governance.approve",
        "governance.review",
    ]


@pytest.mark.anyio
async def test_release_decision_fails_closed_for_unknown_configured_roles(auth_required):
    request = _request()
    with pytest.raises(HTTPException) as raised:
        await authz.require_configured_approver_roles(request, ["evaluation-owner"])
    assert raised.value.status_code == 403
    assert raised.value.detail["code"] == "approver_role_unenforceable"


def test_governance_roles_are_the_real_platform_roles():
    assert GOVERNANCE_ROLES == {"eval-hub-approver", "eval-hub-reviewer"}
