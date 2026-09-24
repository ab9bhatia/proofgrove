"""Archive is reversible, and an archived Project can actually be removed.

Deleting a Project drops its captured trace index rows but never the archived
span payloads: archive objects are keyed tenant/environment/date/hour with no
Project dimension, so one object is an hourly batch shared by every Project in
the tenant.
"""

from __future__ import annotations

import uuid

from evalhub.settings import settings


def _project(client, tenant: str) -> str:
    project_id = str(uuid.uuid4())
    assert client.post("/platform/projects", json={
        "project_id": project_id, "tenant_id": tenant,
        "name": "Lifecycle", "system_type": "application", "owner": "team-a",
    }).status_code == 201
    return project_id


def test_archived_project_can_be_restored_to_active(client):
    tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    # Act as the tenant this test creates, the way the gateway sets it.
    client.headers["x-evalai-tenant"] = tenant
    project_id = _project(client, tenant)

    assert client.post(f"/platform/projects/{project_id}/archive?tenant_id={tenant}").status_code == 200
    assert client.get(f"/platform/projects/{project_id}?tenant_id={tenant}").json()["status"] == "archived"

    restored = client.post(f"/platform/projects/{project_id}/restore?tenant_id={tenant}")
    assert restored.status_code == 200
    assert restored.json()["status"] == "active"
    assert client.get(f"/platform/projects/{project_id}?tenant_id={tenant}").json()["status"] == "active"


def test_active_project_cannot_be_deleted_without_archiving_first(client):
    tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    # Act as the tenant this test creates, the way the gateway sets it.
    client.headers["x-evalai-tenant"] = tenant
    project_id = _project(client, tenant)

    response = client.request("DELETE", f"/platform/projects/{project_id}?tenant_id={tenant}")
    assert response.status_code == 409
    assert "archived" in response.json()["detail"].lower()
    # Refusing must not have removed it on the way out.
    assert client.get(f"/platform/projects/{project_id}?tenant_id={tenant}").status_code == 200


def test_archived_project_is_deleted_and_reports_the_traces_it_removed(client):
    tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    # Act as the tenant this test creates, the way the gateway sets it.
    client.headers["x-evalai-tenant"] = tenant
    project_id = _project(client, tenant)
    assert client.post(f"/platform/projects/{project_id}/archive?tenant_id={tenant}").status_code == 200

    response = client.request("DELETE", f"/platform/projects/{project_id}?tenant_id={tenant}")
    assert response.status_code == 200
    # No traces were indexed for this Project, and the count says so rather
    # than being omitted — 0 removed is a result, not an absence.
    assert response.json() == {"project_id": project_id, "deleted_traces": 0}
    assert client.get(f"/platform/projects/{project_id}?tenant_id={tenant}").status_code == 404


def test_delete_refuses_while_a_target_version_still_points_at_the_project(client):
    tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    # Act as the tenant this test creates, the way the gateway sets it.
    client.headers["x-evalai-tenant"] = tenant
    project_id = _project(client, tenant)
    assert client.post(f"/platform/projects/{project_id}/target-versions", json={
        "target_version_id": str(uuid.uuid4()), "target_id": "generic",
        "project_id": project_id, "tenant_id": tenant, "name": "Generic",
        "version": "1", "endpoint": "http://generic", "target_type": "application",
    }).status_code == 201
    assert client.post(f"/platform/projects/{project_id}/archive?tenant_id={tenant}").status_code == 200

    response = client.request("DELETE", f"/platform/projects/{project_id}?tenant_id={tenant}")
    assert response.status_code == 409
    detail = response.json()["detail"]
    # The refusal names what holds it, so the operator is not left guessing.
    assert "1 target version" in detail
    assert client.get(f"/platform/projects/{project_id}?tenant_id={tenant}").status_code == 200


def test_lifecycle_endpoints_reject_another_tenants_project(client, monkeypatch):
    from unittest.mock import AsyncMock

    from evalhub.platform import authz

    tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    # Act as the tenant this test creates, the way the gateway sets it.
    client.headers["x-evalai-tenant"] = tenant
    project_id = _project(client, tenant)
    monkeypatch.setattr(settings, "platform_auth_required", True)
    monkeypatch.setattr(authz, "check_permission", AsyncMock(return_value=True))
    headers = {
        "x-evalai-tenant": "tenant-intruder",
        "x-evalai-sub": "intruder@example.com",
    }

    # Every mutating lifecycle route must refuse a caller naming a tenant that
    # is not its own. archive_project shipped without this guard.
    assert client.post(
        f"/platform/projects/{project_id}/archive?tenant_id={tenant}", headers=headers
    ).status_code == 403
    assert client.post(
        f"/platform/projects/{project_id}/restore?tenant_id={tenant}", headers=headers
    ).status_code == 403
    assert client.request(
        "DELETE", f"/platform/projects/{project_id}?tenant_id={tenant}", headers=headers
    ).status_code == 403


def test_project_named_readiness_still_requires_approval_to_delete(client, monkeypatch):
    from evalhub.platform import authz
    from tests.platform.test_server_owned_governance import enable_auth

    tenant = "tenant-readiness"
    client.headers["x-evalai-tenant"] = tenant
    url = "/platform/projects/readiness"
    params = {"tenant_id": tenant}
    response = client.post("/platform/projects", json={
        "project_id": "readiness", "tenant_id": tenant,
        "name": "readiness", "system_type": "application", "owner": "test",
    })
    assert response.status_code == 201, response.text
    archived = client.post(url + "/archive", params=params)
    assert archived.status_code == 200
    enable_auth(client, monkeypatch)
    grant = authz.check_permission
    allowed = {"evaluation.read", "evaluation.query"}

    async def restricted(request, permission):
        return await grant(request, permission) if permission in allowed else False

    monkeypatch.setattr(authz, "check_permission", restricted)
    denied = client.delete(url, params=params)
    assert denied.status_code == 403, denied.text
    assert client.get(url, params=params).json()["status"] == "archived"
    allowed.add("governance.approve")
    deleted = client.delete(url, params=params)
    assert deleted.status_code == 200
    assert client.get(url, params=params).status_code == 404
