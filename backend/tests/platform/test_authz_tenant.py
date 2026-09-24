"""Tests for tenant slug ↔ namespace normalization."""

from uuid import uuid4

import pytest
from fastapi import HTTPException, Request

from evalhub.platform.authz import (
    enforce_tenant,
    namespace_for_tenant,
    tenants_match,
)
from evalhub.settings import settings
from tests.conftest import act_as


def test_namespace_for_tenant_is_idempotent(monkeypatch):
    monkeypatch.setattr(settings, "pod_namespace", "tenant-evalai")
    assert namespace_for_tenant("evalai") == "tenant-evalai"
    assert namespace_for_tenant("tenant-evalai") == "tenant-evalai"
    assert namespace_for_tenant("  acme  ") == "acme"


def test_tenants_match_slug_and_namespace(monkeypatch):
    monkeypatch.setattr(settings, "pod_namespace", "tenant-evalai")
    assert tenants_match("evalai", "tenant-evalai")
    assert tenants_match("tenant-evalai", "evalai")
    assert not tenants_match("evalai", "tenant-other")


def test_enforce_tenant_accepts_slug_for_namespace_resource(monkeypatch):
    monkeypatch.setattr(settings, "pod_namespace", "tenant-evalai")
    prior = settings.platform_auth_required
    settings.platform_auth_required = True
    try:
        request = Request(
            {
                "type": "http",
                "headers": [(b"x-evalai-tenant", b"evalai")],
                "method": "GET",
                "path": "/",
            }
        )
        enforce_tenant(request, "tenant-evalai")
    finally:
        settings.platform_auth_required = prior


def test_enforce_tenant_rejects_other_slug():
    prior = settings.platform_auth_required
    settings.platform_auth_required = True
    try:
        request = Request(
            {
                "type": "http",
                "headers": [(b"x-evalai-tenant", b"other")],
                "method": "GET",
                "path": "/",
            }
        )
        try:
            enforce_tenant(request, "tenant-evalai")
            raise AssertionError("expected 403")
        except HTTPException as exc:
            assert exc.status_code == 403
    finally:
        settings.platform_auth_required = prior


def test_middleware_refuses_a_tenant_id_that_is_not_the_callers(client, monkeypatch):
    """Governance lists authorize the caller and query the same tenant."""
    from unittest.mock import AsyncMock

    from evalhub.platform import authz

    monkeypatch.setattr(settings, "platform_auth_required", True)
    monkeypatch.setattr(authz, "check_permission", AsyncMock(return_value=True))
    headers = {"x-evalai-tenant": "tenant-a", "x-evalai-sub": "reader@example.com"}

    refused = client.get("/platform/quality-profiles?tenant_id=tenant-b", headers=headers)
    assert refused.status_code == 403, refused.text

    allowed = client.get("/platform/quality-profiles?tenant_id=tenant-a", headers=headers)
    assert allowed.status_code == 200, allowed.text


def test_middleware_fails_closed_when_a_route_never_checks_a_tenant(monkeypatch):
    """Exercise the guard with a deliberately unscoped route."""
    from unittest.mock import AsyncMock

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from evalhub.platform import authz

    monkeypatch.setattr(settings, "platform_auth_required", True)
    monkeypatch.setattr(authz, "check_permission", AsyncMock(return_value=True))
    app = FastAPI()
    app.add_middleware(authz.AuthorizationMiddleware)

    @app.get("/platform/unscoped-test")
    def unscoped():
        return {"data": "must not escape"}

    with TestClient(app) as client:
        refused = client.get("/platform/unscoped-test", headers={"x-evalai-tenant": "tenant-a", "x-evalai-sub": "reader@example.com"})
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"] == "tenant scoping is required for this route"


def test_middleware_lets_declared_no_tenant_routes_through(client, monkeypatch):
    """Routes that legitimately have no tenant to compare are not caught.

    ``/evaluation/scenarios`` returns the same static catalogue to every
    tenant; ``/agents/mcp-servers`` resolves tenant purely from the caller's
    own header via ``_request_tenant``, which never appears in a query string
    for the structural check to see. Neither should trip the fail-closed rule
    that catches ``/platform/metric-packs`` above.
    """
    from unittest.mock import AsyncMock

    from evalhub.api.v1 import agents as agents_api
    from evalhub.platform import authz

    monkeypatch.setattr(settings, "platform_auth_required", True)
    monkeypatch.setattr(authz, "check_permission", AsyncMock(return_value=True))
    monkeypatch.setattr(agents_api, "list_tenant_tool_servers", AsyncMock(return_value=[]))
    headers = {"x-evalai-tenant": "tenant-a", "x-evalai-sub": "reader@example.com"}

    scenarios = client.get("/evaluation/scenarios", headers=headers)
    assert scenarios.status_code == 200, scenarios.text

    mcp_servers = client.get("/agents/mcp-servers", headers=headers)
    assert mcp_servers.status_code == 200, mcp_servers.text


def test_probe_paths_bypass_auth_even_with_no_identity(client, monkeypatch):
    """``/readyz`` and ``/livez`` are orchestrator probes, not API traffic.

    The bypass previously matched only ``startswith("/health")`` -- exact for
    ``/healthz`` and everything under ``/health/*``, but ``/readyz`` never
    starts with that prefix and so was never exempt (``/livez`` is not a
    routed path in this service, so it 404s either way -- the point is that it
    404s rather than getting an auth 401/403 first).
    """
    monkeypatch.setattr(settings, "platform_auth_required", True)

    assert client.get("/readyz").status_code == 200
    assert client.get("/livez").status_code == 404


def _manifest_and_experiment(client, tenant, suffix):
    """Create a minimal project/target/profile/manifest + experiment for ``tenant``."""
    act_as(client, tenant)
    project, target, profile, experiment = (
        f"project-{suffix}",
        f"target-{suffix}",
        f"profile-{suffix}",
        f"experiment-{suffix}",
    )
    assert client.post(
        "/platform/projects",
        json={
            "project_id": project,
            "tenant_id": tenant,
            "name": "Assistant",
            "system_type": "application",
            "owner": "owner",
        },
    ).status_code == 201
    assert client.post(
        f"/platform/projects/{project}/target-versions",
        json={
            "target_version_id": target,
            "target_id": "assistant",
            "project_id": project,
            "tenant_id": tenant,
            "name": "Assistant",
            "version": "v2",
            "endpoint": "http://assistant",
            "target_type": "application",
        },
    ).status_code == 201
    assert client.post(
        "/platform/quality-profiles",
        json={
            "profile_id": profile,
            "version": "1.0.0",
            "tenant_id": tenant,
            "project_id": project,
            "name": "Quality",
            "scenario": "rag",
            "metric_ids": ["rag.document_recall"],
        },
    ).status_code == 201
    assert client.post(
        f"/platform/quality-profiles/{profile}/versions/1.0.0/validate?tenant_id={tenant}"
    ).status_code == 200
    assert client.post(
        f"/platform/quality-profiles/{profile}/versions/1.0.0/mark-tested?tenant_id={tenant}",
        json={"mode": "overridden", "note": "fixture profile: no dry run in this test"},
    ).status_code == 200
    assert client.post(
        f"/platform/quality-profiles/{profile}/versions/1.0.0/approve?tenant_id={tenant}"
    ).status_code == 200
    manifest = client.post(
        "/platform/run-manifests",
        json={
            "tenant_id": tenant,
            "project_id": project,
            "target_version_id": target,
            "profile_id": profile,
            "profile_version": "1.0.0",
        },
    ).json()
    assert client.post(
        "/evaluation/experiments",
        json={
            "experiment_id": experiment,
            "name": "Candidate",
            "dataset_version": "cases-v1",
            "target_endpoint": "http://placeholder",
            "scenario": "rag",
            "tenant_id": tenant,
        },
    ).status_code == 201
    return experiment, manifest


def test_bind_manifest_route_rejects_a_caller_not_authorized_for_the_experiment(client):
    """`enforce_tenant` is applied to the experiment's OWN tenant BEFORE the
    rebind, so a caller authorized for a different tenant is refused rather
    than being allowed to rewrite an experiment it does not own.
    """
    suffix = uuid4().hex[:8]
    tenant_a, tenant_b = f"tenant-a-{suffix}", f"tenant-b-{suffix}"
    experiment_a, _ = _manifest_and_experiment(client, tenant_a, f"a-{suffix}")
    _, manifest_b = _manifest_and_experiment(client, tenant_b, f"b-{suffix}")

    # Still acting as tenant_b (the last setup call); tenant_b may not rebind
    # tenant_a's experiment.
    response = client.post(
        f"/platform/experiments/{experiment_a}/run-manifest",
        json={"manifest_id": manifest_b["manifest_id"]},
    )
    assert response.status_code == 404, response.text


def test_bind_manifest_route_rejects_a_manifest_from_another_tenant(client):
    """Even a caller authorized for the experiment's own tenant cannot bind a
    manifest that belongs to a different tenant — the store guard at
    ``bind_manifest_to_experiment`` refuses unconditionally.
    """
    suffix = uuid4().hex[:8]
    tenant_a, tenant_b = f"tenant-a-{suffix}", f"tenant-b-{suffix}"
    experiment_a, _ = _manifest_and_experiment(client, tenant_a, f"a-{suffix}")
    _, manifest_b = _manifest_and_experiment(client, tenant_b, f"b-{suffix}")

    act_as(client, tenant_a)
    response = client.post(
        f"/platform/experiments/{experiment_a}/run-manifest",
        json={"manifest_id": manifest_b["manifest_id"]},
    )
    assert response.status_code == 422, response.text
    assert "tenant" in str(response.json()["detail"]).lower()


def test_list_remediations_requires_and_scopes_by_tenant(client, monkeypatch):
    """Tenant identity is required even when the query parameter is omitted."""
    monkeypatch.setattr(settings, "pod_namespace", "")
    missing_tenant = client.get("/platform/remediations")
    assert missing_tenant.status_code == 400, missing_tenant.text

    act_as(client, "tenant-a")
    refused = client.get("/platform/remediations?tenant_id=tenant-b")
    assert refused.status_code == 403, refused.text

    allowed = client.get("/platform/remediations?tenant_id=tenant-a")
    assert allowed.status_code == 200, allowed.text
    assert allowed.json() == []


def test_list_metric_packs_requires_tenant_id(client):
    """`/platform/metric-packs` used to accept an optional tenant_id, so an
    omitted query dropped the store's WHERE and returned every tenant's rows
    — mirrors the same fix already applied to `/platform/evaluators`.
    """
    missing_tenant = client.get("/platform/metric-packs")
    assert missing_tenant.status_code == 422, missing_tenant.text

    act_as(client, "tenant-a")
    refused = client.get("/platform/metric-packs?tenant_id=tenant-b")
    assert refused.status_code == 403, refused.text

    allowed = client.get("/platform/metric-packs?tenant_id=tenant-a")
    assert allowed.status_code == 200, allowed.text



def test_regression_replay_refuses_a_foreign_source_before_execution(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock

    import pytest

    from evalhub.api.v1.platform import ReplayRequest, replay_regression

    monkeypatch.setattr(settings, "platform_auth_required", False)
    request = Request({"type": "http", "headers": [(b"x-evalai-tenant", b"tenant-own")]})
    store = SimpleNamespace(
        get_regression_case=AsyncMock(return_value=SimpleNamespace(
            tenant_id="tenant-foreign", record={"row_id": "case", "query": "private", "response": "private"},
        )),
        get_experiment=AsyncMock(return_value=SimpleNamespace(tenant_id="tenant-own", run_manifest_id=None)),
    )
    engine = Mock()
    with pytest.raises(HTTPException) as denied:
        asyncio.run(replay_regression("case", ReplayRequest(experiment_id="own"), request, store, engine))
    assert denied.value.status_code in (403, 404)
    engine.execute.assert_not_called()


@pytest.mark.parametrize(("path", "method", "args", "is_list"), [
    ("/projects/project/target-versions", "list_target_versions", ("project", "tenant-a"), True),
    ("/target-versions/target", "get_target_version", ("target", "tenant-a"), False),
    ("/quality-profiles", "list_quality_profiles", ("tenant-a", None), True),
    ("/quality-profiles/profile/versions/1", "get_quality_profile", ("profile", "1", "tenant-a"), False),
    ("/gate-policies", "list_gate_policies", ("tenant-a",), True),
    ("/gate-policies/policy/versions/1", "get_gate_policy", ("policy", "1", "tenant-a"), False),
    ("/run-manifests/manifest", "get_run_manifest", ("manifest", "tenant-a"), False),
    ("/evaluators", "list_evaluator_definitions", ("tenant-a",), True),
    ("/regressions", "list_regression_cases", ("tenant-a",), True),
])
def test_governance_read_routes_authorize_and_scope_queries(monkeypatch, path, method, args, is_list):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from evalhub.api.dependencies import get_evaluation_store
    from evalhub.api.v1.platform import router
    from evalhub.db.store import EvaluationStore
    from evalhub.platform import authz

    monkeypatch.setattr(settings, "platform_auth_required", True)
    monkeypatch.setattr(authz, "check_permission", AsyncMock(return_value=True))
    store = AsyncMock(spec=EvaluationStore)
    call = getattr(store, method)
    call.return_value = [] if is_list else SimpleNamespace(model_dump=lambda **_: {"tenant_id": "tenant-a"})
    app = FastAPI()
    app.add_middleware(authz.AuthorizationMiddleware)
    app.include_router(router)
    app.dependency_overrides[get_evaluation_store] = lambda: store
    headers = {"x-evalai-tenant": "tenant-a", "x-evalai-sub": "reader"}
    with TestClient(app) as client:
        assert client.get("/platform" + path + "?tenant_id=tenant-b", headers=headers).status_code == 403
        call.assert_not_awaited()
        response = client.get("/platform" + path + "?tenant_id=tenant-a", headers=headers)
    assert response.status_code == 200, response.text
    call.assert_awaited_once_with(*args)
