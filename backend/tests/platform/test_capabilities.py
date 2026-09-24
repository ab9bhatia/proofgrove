"""GET /platform/capabilities — honest central-AuthZ action discovery.

The capability answer asks for the same permission as the write path so the UI
can hide affordances instead of rendering-then-403. Role headers are ignored.
"""

from unittest.mock import AsyncMock

import pytest

from evalhub.settings import settings
from tests.conftest import act_as

#: The tenant this module's client acts as, the way the gateway sets it.
TENANT = "tenant-evalai"


@pytest.fixture
def auth_required():
    prior = settings.platform_auth_required
    settings.platform_auth_required = True
    yield
    settings.platform_auth_required = prior


def test_capabilities_grant_everything_when_auth_not_required(client):
    assert settings.platform_auth_required is False
    response = client.get("/platform/capabilities")
    assert response.status_code == 200
    assert response.json()["actions"]["record_release_decision"] is True


def test_capabilities_deny_release_decision_when_authz_denies(client, auth_required, monkeypatch):
    check = AsyncMock(return_value=False)
    monkeypatch.setattr("evalhub.api.v1.platform.check_permission", check)
    response = client.get(
        "/platform/capabilities",
        headers={"x-evalai-tenant": "evalai", "x-evalai-sub": "viewer@example.com"},
    )
    assert response.status_code == 200
    assert response.json()["actions"]["record_release_decision"] is False
    check.assert_awaited_once()


def test_capabilities_do_not_trust_roles_header(client, auth_required, monkeypatch):
    monkeypatch.setattr("evalhub.api.v1.platform.check_permission", AsyncMock(return_value=False))
    response = client.get(
        "/platform/capabilities",
        headers={
            "x-evalai-tenant": "evalai",
            "x-evalai-sub": "admin@example.com",
            "x-evalai-roles": "eval-hub-admin",
        },
    )
    assert response.status_code == 200
    assert response.json()["actions"]["record_release_decision"] is False


def test_capabilities_grant_release_decision_when_authz_allows(client, auth_required, monkeypatch):
    monkeypatch.setattr("evalhub.api.v1.platform.check_permission", AsyncMock(return_value=True))
    response = client.get(
        "/platform/capabilities",
        headers={
            "x-evalai-tenant": "evalai",
            "x-evalai-sub": "approver@example.com",
        },
    )
    assert response.status_code == 200
    assert response.json()["actions"]["record_release_decision"] is True


def test_capabilities_require_tenant_header_when_auth_required(client, auth_required):
    # The module client acts as a tenant by default; drop the identity to
    # exercise the header requirement itself.
    client.headers.pop("x-evalai-tenant", None)
    response = client.get("/platform/capabilities")
    assert response.status_code == 401


def test_capabilities_reject_mismatched_tenant(client, auth_required):
    act_as(client, "tenant-evalai")
    response = client.get(
        "/platform/capabilities",
        params={"tenant_id": "tenant-evalai"},
        headers={"x-evalai-tenant": "other", "x-evalai-roles": "eval-hub-approver"},
    )
    assert response.status_code == 403
