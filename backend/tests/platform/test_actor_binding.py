"""Actor attribution on quality-contract creation.

Instantiating a built-in InEval rubric template into a governed draft profile
(POST /platform/quality-contract-templates/{id}/instantiate) accepts a
body-supplied ``created_by`` and persists it on the new QualityProfileVersion.
Under ``platform_auth_required`` the authenticated subject (``x-evalai-sub``)
must win over the body -- the same pattern already used by the review
decision / waiver / regression-promotion routes further down this file
(``if settings.platform_auth_required: body.<field> = actor_from_request(...)``).
With auth off (local dev), the body value must still be used unchanged.
"""

import pytest
from pydantic import SecretStr

from proofgrove.platform import authz
from proofgrove.settings import settings
from tests.platform.test_action_authorization import _AuthzClient

TENANT = "tenant-actor-binding-qc"
FORGED = "mallory"
VERIFIED = "alice"


def _headers(*, subject: str | None = VERIFIED) -> dict:
    headers = {"x-evalai-tenant": TENANT}
    if subject is not None:
        headers["x-evalai-sub"] = subject
    return headers


def _allow_authz(monkeypatch, auth_required: bool) -> None:
    """This route requires PERMISSION_GOVERNANCE_APPROVE via
    AuthorizationMiddleware (any /platform path); stub the outbound
    check_permission() call when auth is required, same pattern as
    test_dataset_lifecycle_guards.py."""
    if not auth_required:
        return
    monkeypatch.setattr(settings, "pod_namespace", "")
    monkeypatch.setattr(settings, "authz_check_token", SecretStr("synthetic-check-token"))
    monkeypatch.setattr(authz.httpx, "AsyncClient", lambda **kwargs: _AuthzClient(True, []))


@pytest.mark.parametrize("auth_required", [True, False])
def test_instantiate_quality_contract_template_binds_actor(client, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    resp = client.post(
        "/platform/quality-contract-templates/qc_tpl_task_completion/instantiate",
        json={"tenant_id": TENANT, "created_by": FORGED},
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["created_by"] == (VERIFIED if auth_required else FORGED)


@pytest.mark.parametrize("auth_required", [True, False])
def test_create_project_binds_actor(client, monkeypatch, auth_required):
    """POST /platform/projects takes the whole EvaluationProject as its body
    and persists it verbatim via store.save_project -- missed by a grep for
    an explicit ``.created_by`` field reference, since the field is never
    named in the handler."""
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    resp = client.post(
        "/platform/projects",
        json={
            "project_id": f"proj-actor-binding-{auth_required}",
            "tenant_id": TENANT,
            "name": "Actor binding project",
            "system_type": "agent",
            "owner": "quality-team",
            "created_by": FORGED,
        },
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["created_by"] == (VERIFIED if auth_required else FORGED)


@pytest.mark.parametrize("auth_required", [True, False])
def test_register_target_version_binds_actor(client, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    project_id = f"proj-target-actor-{auth_required}"
    setup = client.post(
        "/platform/projects",
        json={
            "project_id": project_id,
            "tenant_id": TENANT,
            "name": "Target actor project",
            "system_type": "agent",
            "owner": "quality-team",
        },
        headers=_headers(),
    )
    assert setup.status_code == 201, setup.text
    resp = client.post(
        f"/platform/projects/{project_id}/target-versions",
        json={
            "target_version_id": f"target-actor-{auth_required}",
            "target_id": "generic",
            "project_id": project_id,
            "tenant_id": TENANT,
            "name": "Generic target",
            "version": "1",
            "endpoint": "http://generic.test",
            "target_type": "application",
            "created_by": FORGED,
        },
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["created_by"] == (VERIFIED if auth_required else FORGED)


@pytest.mark.parametrize("auth_required", [True, False])
def test_create_quality_profile_binds_actor(client, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    resp = client.post(
        "/platform/quality-profiles",
        json={
            "profile_id": f"profile-actor-{auth_required}",
            "version": "1.0.0",
            "tenant_id": TENANT,
            "name": "Actor binding profile",
            "scenario": "llm_core",
            "metric_ids": [],
            "created_by": FORGED,
        },
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["created_by"] == (VERIFIED if auth_required else FORGED)


@pytest.mark.parametrize("auth_required", [True, False])
def test_create_gate_policy_binds_actor(client, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    resp = client.post(
        "/platform/gate-policies",
        json={
            "gate_policy_id": f"gate-actor-{auth_required}",
            "version": "1.0.0",
            "tenant_id": TENANT,
            "name": "Actor binding gate",
            "created_by": FORGED,
        },
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["created_by"] == (VERIFIED if auth_required else FORGED)


@pytest.mark.parametrize("auth_required", [True, False])
def test_register_evaluator_binds_actor(client, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    resp = client.post(
        "/platform/evaluators",
        json={
            "evaluator_id": f"team.actor-binding-{auth_required}",
            "version": "1.0.0",
            "tenant_id": TENANT,
            "name": "Actor binding evaluator",
            "execution_mode": "isolated",
            "adapter": "custom",
            "implementation": "oci://tenant-registry/actor-binding:1.0.0",
            "created_by": FORGED,
        },
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["created_by"] == (VERIFIED if auth_required else FORGED)


@pytest.mark.parametrize("auth_required", [True, False])
def test_install_metric_pack_binds_actor(client, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    resp = client.post(
        "/platform/metric-packs",
        json={
            "metric_pack_id": f"pack-actor-{auth_required}",
            "version": "1.0.0",
            "tenant_id": TENANT,
            "name": "Actor binding pack",
            "created_by": FORGED,
        },
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["created_by"] == (VERIFIED if auth_required else FORGED)


@pytest.mark.parametrize("auth_required", [True, False])
def test_resolve_manifest_binds_actor(client, monkeypatch, auth_required):
    """resolve_manifest splats the whole ResolveManifestRequest into
    store.resolve_and_save_manifest(**body.model_dump()) -- resolved_by rides
    along with everything else, the same whole-model-passthrough shape as the
    other gaps in this file."""
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    suffix = f"manifest-actor-{auth_required}"
    project_id, target_id, profile_id = f"proj-{suffix}", f"target-{suffix}", f"profile-{suffix}"
    h = _headers()
    setup = client.post(
        "/platform/projects",
        json={"project_id": project_id, "tenant_id": TENANT, "name": "Manifest project", "system_type": "agent", "owner": "quality-team"},
        headers=h,
    )
    assert setup.status_code == 201, setup.text
    setup = client.post(
        f"/platform/projects/{project_id}/target-versions",
        json={
            "target_version_id": target_id,
            "target_id": "generic",
            "project_id": project_id,
            "tenant_id": TENANT,
            "name": "Generic",
            "version": "1",
            "endpoint": "http://generic.test",
            "target_type": "application",
        },
        headers=h,
    )
    assert setup.status_code == 201, setup.text
    setup = client.post(
        "/platform/quality-profiles",
        json={
            "profile_id": profile_id,
            "version": "1.0.0",
            "tenant_id": TENANT,
            "project_id": project_id,
            "name": "Manifest profile",
            "scenario": "llm_core",
            "metric_ids": [],
        },
        headers=h,
    )
    assert setup.status_code == 201, setup.text
    setup = client.post(f"/platform/quality-profiles/{profile_id}/versions/1.0.0/validate?tenant_id={TENANT}", headers=h)
    assert setup.status_code == 200, setup.text
    setup = client.post(
        f"/platform/quality-profiles/{profile_id}/versions/1.0.0/mark-tested?tenant_id={TENANT}",
        json={"mode": "overridden", "note": "actor-binding fixture: no dry run"},
        headers=h,
    )
    assert setup.status_code == 200, setup.text
    setup = client.post(f"/platform/quality-profiles/{profile_id}/versions/1.0.0/approve?tenant_id={TENANT}", headers=h)
    assert setup.status_code == 200, setup.text

    resp = client.post(
        "/platform/run-manifests",
        json={
            "tenant_id": TENANT,
            "project_id": project_id,
            "target_version_id": target_id,
            "profile_id": profile_id,
            "profile_version": "1.0.0",
            "resolved_by": FORGED,
        },
        headers=h,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["resolved_by"] == (VERIFIED if auth_required else FORGED)
