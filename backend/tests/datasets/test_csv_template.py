"""The upload CSV template is a frozen constant every tenant may read.

With ``platform_auth_required`` on, ``AuthorizationMiddleware`` refuses any
non-error response from a route that never compared a caller to a resource
owner. The template has no owner to compare against, so it must be declared
tenant-agnostic; before that it answered 403 in every authenticated deployment
while the UI's "download template" kept working only with auth off.
"""

from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from evalhub.main import app
from evalhub.platform import authz
from evalhub.settings import settings


@pytest.mark.parametrize("auth_required", [True, False])
async def test_csv_template_is_served_with_and_without_platform_auth(monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    monkeypatch.setattr(settings, "pod_namespace", "tenant-t1")
    monkeypatch.setattr(authz, "check_permission", AsyncMock(return_value=True))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/datasets/csv-template", headers={"x-evalai-tenant": "t1", "x-evalai-sub": "user@example.com"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["csv"].startswith("Serial No,Question,Expected Output,Metadata")
    assert set(body["columns"]) == {"Serial No", "Question", "Expected Output", "Metadata"}
