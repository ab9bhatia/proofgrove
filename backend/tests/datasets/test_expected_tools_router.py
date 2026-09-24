"""Router-level coverage for the expected-tools write path.

The registry tests exercise ``annotate_expected_tools`` directly and never
cross the router, which is how a denial-status defect survived review: the
guard refused correctly but ``_handle_error`` reported the refusal as a 500.
"""

from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from evalhub.api.dependencies import get_registry_service
from evalhub.main import app

OWNER = "tenant-owner"
INTRUDER = "tenant-intruder"


@pytest.fixture
def mock_svc() -> MagicMock:
    svc = MagicMock()
    svc.get_dataset_tenant.return_value = OWNER
    return svc


@pytest.fixture
async def client(mock_svc: MagicMock):
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


async def test_cross_tenant_write_is_denied_with_its_own_status(
    client: AsyncClient, mock_svc: MagicMock
) -> None:
    resp = await client.post(
        "/datasets/victim_ds/expected-tools",
        json={"record_ids": ["r1"], "tools": ["search"]},
        headers={"x-evalai-tenant": INTRUDER},
    )
    # The denial must surface as the guard's own status — never remapped to a
    # 500 by the router's terminal error branch. Under the router-level guard
    # the cross-tenant refusal is the uniform 404, indistinguishable from a
    # missing dataset.
    assert resp.status_code == 404
    assert not mock_svc.annotate_expected_tools.called


async def test_owner_write_reaches_the_service(
    client: AsyncClient, mock_svc: MagicMock
) -> None:
    mock_svc.annotate_expected_tools.return_value = {
        "dataset_name": "victim_ds",
        "annotated": 1,
        "tools": ["search"],
        "created_version": False,
        "source_dataset_name": None,
        "version_number": 2,
        "status": "DRAFT",
    }
    resp = await client.post(
        "/datasets/victim_ds/expected-tools",
        json={"record_ids": ["r1"], "tools": ["search"]},
        headers={"x-evalai-tenant": OWNER},
    )
    assert resp.status_code == 200
    assert mock_svc.annotate_expected_tools.called
