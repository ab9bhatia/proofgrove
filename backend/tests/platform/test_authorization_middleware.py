"""AuthorizationMiddleware's structural fail-closed tenant-scope gate.

``require_caller_tenant`` only resolves *who is asking* -- it never compares
that identity to a resource owner. It must not satisfy the middleware's
tenant-scope-checked gate on its own; only a real comparison
(``enforce_tenant`` / ``authorize_dataset_access``) may do that.
"""

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from pydantic import SecretStr

from proofgrove.platform import authz
from proofgrove.platform.authz import (
    AuthorizationMiddleware,
    enforce_tenant,
    require_caller_tenant,
    resolve_requested_tenant,
)
from proofgrove.settings import settings


@pytest.fixture
def auth_required(monkeypatch):
    monkeypatch.setattr(settings, "pod_namespace", "tenant-acme")
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

    async def _always_allowed(request: Request, permission: str) -> bool:
        request.state.proofgrove_permissions = {permission}
        return True

    monkeypatch.setattr(authz, "check_permission", _always_allowed)
    yield
    (
        settings.platform_auth_required,
        settings.authz_check_token,
        settings.authz_service_url,
        settings.authz_app_name,
    ) = previous


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(AuthorizationMiddleware)

    @app.get("/evaluation/runs/unscoped-bug")
    async def unscoped_bug(request: Request):
        # Bug shape under test: resolves identity, never compares it to a
        # resource owner, then returns data anyway.
        require_caller_tenant(request)
        return {"data": "should not ship"}

    @app.get("/evaluation/runs/scoped-ok")
    async def scoped_ok(request: Request):
        enforce_tenant(request, "acme")
        return {"data": "ok"}

    return app


@pytest.mark.parametrize("query", ["", "?tenant_id=acme", "?tenant_id=tenant-acme"])
def test_require_caller_tenant_alone_does_not_satisfy_the_scope_gate(auth_required, query):
    with TestClient(_app()) as client:
        response = client.get(
            "/evaluation/runs/unscoped-bug" + query,
            headers={"x-evalai-tenant": "acme", "x-evalai-sub": "alice"},
        )
    assert response.status_code == 403
    assert "tenant scoping" in response.json()["detail"]


@pytest.mark.parametrize("query", ["", "?tenant_id=acme", "?tenant_id=tenant-acme"])
def test_enforce_tenant_satisfies_the_scope_gate(auth_required, query):
    with TestClient(_app()) as client:
        response = client.get(
            "/evaluation/runs/scoped-ok" + query,
            headers={"x-evalai-tenant": "acme", "x-evalai-sub": "alice"},
        )
    assert response.status_code == 200
    assert response.json() == {"data": "ok"}


def test_require_caller_tenant_does_not_mark_scope_checked_directly():
    """Unit-level guard against the underlying regression, independent of the app."""
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/x",
            "headers": [(b"x-evalai-tenant", b"acme")],
        }
    )
    require_caller_tenant(request)
    assert not getattr(request.state, "proofgrove_tenant_scope_checked", False)


def test_enforce_tenant_marks_scope_checked_directly():
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/x",
            "headers": [(b"x-evalai-tenant", b"acme")],
        }
    )
    enforce_tenant(request, "acme")
    assert request.state.proofgrove_tenant_scope_checked is True


# Rows two tenants own — the foreign row must never leave the building.
_ROWS_BY_TENANT = {
    "tenant-acme": [{"run": "acme-row"}],
    "tenant-foreign": [{"run": "FOREIGN-TENANT-ROW"}],
}


@pytest.mark.parametrize("query", ["", "?tenant_id=acme", "?tenant_id=tenant-acme"])
def test_resolve_then_ignore_is_refused_by_the_structural_gate(auth_required, query):
    """A route that resolves the scope and then reads unscoped data must 403.

    This is the exact bypass shape from the R1 review: resolution alone used
    to release the gate, so this handler shipped both tenants' rows with 200.
    """
    app = FastAPI()
    app.add_middleware(AuthorizationMiddleware)

    @app.get("/evaluation/runs/resolve-then-ignore")
    async def resolve_then_ignore(request: Request, tenant_id: str | None = None):
        resolve_requested_tenant(request, tenant_id)
        # Bug shape: the resolved scope is never applied to the read.
        unfiltered = [row for rows in _ROWS_BY_TENANT.values() for row in rows]
        return {"rows": unfiltered}

    with TestClient(app) as client:
        response = client.get(
            "/evaluation/runs/resolve-then-ignore" + query,
            headers={"x-evalai-tenant": "acme", "x-evalai-sub": "alice"},
        )
    assert response.status_code == 403
    assert "FOREIGN-TENANT-ROW" not in response.text


@pytest.mark.parametrize("query", ["", "?tenant_id=acme", "?tenant_id=tenant-acme"])
def test_scoped_list_marking_at_the_query_boundary_succeeds(auth_required, query):
    """The sanctioned list/create pattern: resolve, filter by the result,
    attest at the query boundary. Both request forms the UI sends must work,
    and only the caller tenant's rows may come back."""
    app = FastAPI()
    app.add_middleware(AuthorizationMiddleware)

    @app.get("/evaluation/runs/scoped-list")
    async def scoped_list(request: Request, tenant_id: str | None = None):
        scope = resolve_requested_tenant(request, tenant_id)
        rows = _ROWS_BY_TENANT.get(scope, [])
        authz.mark_tenant_scope_checked(request)
        return {"scope": scope, "rows": rows}

    with TestClient(app) as client:
        response = client.get(
            "/evaluation/runs/scoped-list" + query,
            headers={"x-evalai-tenant": "acme", "x-evalai-sub": "alice"},
        )
    assert response.status_code == 200
    assert response.json() == {"scope": "tenant-acme", "rows": [{"run": "acme-row"}]}
    assert "FOREIGN-TENANT-ROW" not in response.text


def test_resolve_requested_tenant_does_not_forge_the_ownership_mark():
    """Resolution proves identity, not ownership — the ownership mark stays
    reserved for a real caller-vs-resource-owner comparison."""
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/x",
            "headers": [(b"x-evalai-tenant", b"acme")],
        }
    )
    resolve_requested_tenant(request, None)
    assert not getattr(request.state, "proofgrove_tenant_scope_checked", False)


def test_resolve_requested_tenant_preserves_an_earlier_ownership_mark():
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/x",
            "headers": [(b"x-evalai-tenant", b"acme")],
        }
    )
    enforce_tenant(request, "acme")  # a real owner comparison happened first
    resolve_requested_tenant(request, None)
    assert request.state.proofgrove_tenant_scope_checked is True


def test_resolve_requested_tenant_still_rejects_a_foreign_tenant(auth_required):
    app = FastAPI()
    app.add_middleware(AuthorizationMiddleware)

    @app.get("/evaluation/runs/scoped-list")
    async def scoped_list(request: Request, tenant_id: str | None = None):
        scope = resolve_requested_tenant(request, tenant_id)
        return {"scope": scope}

    with TestClient(app) as client:
        response = client.get(
            "/evaluation/runs/scoped-list?tenant_id=foreign",
            headers={"x-evalai-tenant": "acme", "x-evalai-sub": "alice"},
        )
    assert response.status_code == 403


@pytest.mark.parametrize(
    ("path", "headers", "query", "status"),
    [
        ("/platform/example", {"x-evalai-tenant": "acme"}, "?tenant_id=foreign", 403),
        ("/platform/example", {"x-evalai-tenant": "acme"}, "?tenant_id=tenant-acme", 403),
        ("/platform/example", {}, "", 200),
        ("/health", {}, "?tenant_id=foreign", 200),
    ],
)
def test_development_mode_preserves_explicit_tenant_isolation(monkeypatch, path, headers, query, status):
    monkeypatch.setattr(settings, "platform_auth_required", False)
    monkeypatch.setattr(settings, "pod_namespace", "")
    app = FastAPI()
    app.add_middleware(AuthorizationMiddleware)
    calls = []

    @app.get("/platform/example")
    @app.get("/health")
    async def resource():
        calls.append(True)
        return {"data": "ok"}

    with TestClient(app) as client:
        response = client.get(path + query, headers=headers)
    assert response.status_code == status
    assert bool(calls) is (status == 200)


def test_regression_replay_permission_satisfies_reviewer_guard(auth_required):
    app = FastAPI()
    app.add_middleware(AuthorizationMiddleware)

    @app.post("/platform/regressions/{case_id}/replay")
    async def replay(request: Request, case_id: str):
        enforce_tenant(request, "acme")
        authz.require_role(request, "proofgrove-reviewer")
        return {"case_id": case_id}

    with TestClient(app) as client:
        response = client.post(
            "/platform/regressions/case/replay",
            headers={"x-evalai-tenant": "acme", "x-evalai-sub": "reviewer"},
        )
    assert response.status_code == 200


@pytest.mark.parametrize("root", ["/agents", "/evaluation/llm-catalog"])
def test_self_scoped_exemption_requires_path_boundary(auth_required, root):
    app = FastAPI()
    app.add_middleware(AuthorizationMiddleware)

    @app.get("/{path:path}")
    async def unscoped(path: str):
        return {"data": "unscoped"}

    with TestClient(app) as client:
        headers = {"x-evalai-tenant": "acme", "x-evalai-sub": "alice"}
        assert client.get(root, headers=headers).status_code == 200
        assert client.get(root + "/catalog", headers=headers).status_code == 200
        response = client.get(root + "-export", headers=headers)
    assert response.status_code == 403
    assert response.json() == {"detail": "tenant scoping is required for this route"}
