"""GET /datasets/stats — single source of truth for status counts.

Published = enum status PUBLISHED. Overview KPI and library chips both consume
this aggregate so they cannot drift.
"""

from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from proofgrove.api.dependencies import get_registry_service
from proofgrove.datasets.enums import DatasetStatus
from proofgrove.datasets.models import DatasetMetadata
from proofgrove.datasets.postgres_store import SqlDatasetStore
from proofgrove.datasets.registry import DatasetRegistryService
from proofgrove.main import app
from proofgrove.settings import settings
from tests.conftest import act_as

#: The tenant this module's clients act as, the way the gateway sets it.
TENANT = "t1"


@pytest.fixture
def mock_svc() -> MagicMock:
    return MagicMock()


@pytest.fixture
async def client(mock_svc: MagicMock):
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        yield ac
    app.dependency_overrides.clear()


class TestDatasetStatsEndpoint:
    async def test_returns_total_and_by_status(
        self, client: AsyncClient, mock_svc: MagicMock, monkeypatch
    ) -> None:
        monkeypatch.setattr(settings, "pod_namespace", "tenant-t1")
        mock_svc.dataset_stats.return_value = {
            "total": 5,
            "by_status": {
                "DRAFT": 2,
                "VALIDATED": 0,
                "APPROVED": 0,
                "PUBLISHED": 3,
                "DEPRECATED": 0,
                "RETIRED": 0,
                "REJECTED": 0,
            },
        }

        resp = await client.get("/datasets/stats", params={"tenant_id": "t1"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 5
        assert body["by_status"]["PUBLISHED"] == 3
        assert body["by_status"]["DRAFT"] == 2
        mock_svc.dataset_stats.assert_called_once()
        filters = mock_svc.dataset_stats.call_args.args[0]
        assert filters.tenant_id == "tenant-t1"

    async def test_enforces_tenant_header(
        self, client: AsyncClient, mock_svc: MagicMock, monkeypatch
    ) -> None:
        from unittest.mock import AsyncMock

        from proofgrove.platform import authz
        from proofgrove.settings import settings

        mock_svc.dataset_stats.return_value = {"total": 0, "by_status": {}}
        prior = settings.platform_auth_required
        settings.platform_auth_required = True
        monkeypatch.setattr(authz, "check_permission", AsyncMock(return_value=True))
        try:
            act_as(client, "tenant-evalai")
            mismatched = await client.get(
                "/datasets/stats",
                params={"tenant_id": "tenant-evalai"},
                headers={"x-evalai-tenant": "other", "x-evalai-sub": "user@example.com"},
            )
            assert mismatched.status_code == 403
            mock_svc.dataset_stats.assert_not_called()
        finally:
            settings.platform_auth_required = prior

    async def test_stats_route_not_captured_as_dataset_name(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        mock_svc.dataset_stats.return_value = {"total": 0, "by_status": {}}
        resp = await client.get(
            "/datasets/stats",
            params={"tenant_id": "t1"},
        )
        assert resp.status_code == 200
        mock_svc.get_dataset.assert_not_called()


class TestDatasetStatsRegistry:
    def test_delegates_to_storage_group_by(self) -> None:
        storage = MagicMock()
        storage.dataset_stats.return_value = {
            "total": 4,
            "by_status": {"PUBLISHED": 1, "DRAFT": 3},
        }
        svc = DatasetRegistryService(storage=storage)
        from proofgrove.datasets.models import DatasetFilterParams

        result = svc.dataset_stats(
            DatasetFilterParams(tenant_id="t1", product_id="p1", status=None)
        )
        assert result["total"] == 4
        assert result["by_status"]["PUBLISHED"] == 1
        storage.dataset_stats.assert_called_once_with(
            tenant_id="t1", product_id="p1"
        )


class TestDatasetStatsStore:
    @pytest.fixture
    def store(self):
        return SqlDatasetStore()

    def _seed(self, store, name: str, status: DatasetStatus, tenant_id: str = "t1") -> None:
        store.create_dataset(
            name,
            DatasetMetadata(
                tenant_id=tenant_id,
                product_id="p1",
                status=DatasetStatus.DRAFT,
                version_number=1,
                created_by="test",
            ),
        )
        if status != DatasetStatus.DRAFT:
            store.update_status(name, tenant_id, status=status.value)

    def test_group_by_status_across_tenants(self, store) -> None:
        self._seed(store, "a", DatasetStatus.PUBLISHED, tenant_id="t1")
        self._seed(store, "b", DatasetStatus.PUBLISHED, tenant_id="t1")
        self._seed(store, "c", DatasetStatus.DRAFT, tenant_id="t1")
        self._seed(store, "d", DatasetStatus.DEPRECATED, tenant_id="t1")
        self._seed(store, "other", DatasetStatus.PUBLISHED, tenant_id="t2")

        stats = store.dataset_stats(tenant_id="t1")
        assert stats["total"] == 4
        assert stats["by_status"]["PUBLISHED"] == 2
        assert stats["by_status"]["DRAFT"] == 1
        assert stats["by_status"]["DEPRECATED"] == 1
        # All enum keys present (zeros for missing)
        for status in DatasetStatus:
            assert status.value in stats["by_status"]

        other = store.dataset_stats(tenant_id="t2")
        assert other["total"] == 1
        assert other["by_status"]["PUBLISHED"] == 1
