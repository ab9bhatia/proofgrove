"""Server paging for the dataset list + records endpoints.

The datasets UI used to fetch the entire tenant client-side and cap records at
50 with a false empty state beyond. These tests pin the additive paging
contract: legacy unpaged callers keep getting bare lists, while callers that
pass ``limit``/``offset``/``cursor`` get the ``{items, total, limit, offset,
next_cursor}`` envelope (same convention as ``GET /evaluation/run-history``).
"""

from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from proofgrove.api.dependencies import get_registry_service
from proofgrove.datasets.exceptions import DatasetNotFoundError
from proofgrove.datasets.models import DatasetFilterParams
from proofgrove.datasets.registry import DatasetRegistryService
from proofgrove.main import app
from proofgrove.settings import settings

#: The tenant this module's clients act as, the way the gateway sets it.
TENANT = "t1"


def _dataset_row(name: str) -> dict:
    return {
        "dataset_name": name,
        "dataset_id": f"id-{name}",
        "tenant_id": "t1",
        "product_id": "p1",
        "status": "DRAFT",
        "version_number": 1,
        "parent_dataset_name": None,
        "dqs": None,
        "change_reason": None,
        "created_by": "test",
        "record_count": 3,
    }


def _record_row(i: int) -> dict:
    return {
        "dataset_record_id": f"rec-{i}",
        "inputs": {"question": f"q{i}"},
        "expectations": {"expected_output": f"a{i}"},
        "tags": {"serial_no": str(i)},
    }


@pytest.fixture
def mock_svc() -> MagicMock:
    svc = MagicMock()
    svc.get_dataset_tenant.return_value = "t1"
    return svc


@pytest.fixture
async def client(mock_svc: MagicMock, async_client: AsyncClient):
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    yield async_client
    app.dependency_overrides.clear()


# ------------------------------------------------------------------
# GET /datasets — list paging
# ------------------------------------------------------------------


class TestListDatasetsPaging:
    async def test_unpaged_call_returns_legacy_bare_list(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        mock_svc.list_datasets.return_value = [_dataset_row("a"), _dataset_row("b")]

        resp = await client.get("/datasets", params={"tenant_id": "t1"})

        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list)
        assert [d["dataset_name"] for d in body] == ["a", "b"]

    async def test_limit_returns_envelope_with_total_and_cursor(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        mock_svc.list_datasets_page.return_value = (
            [_dataset_row("a"), _dataset_row("b")],
            107,
        )

        resp = await client.get("/datasets", params={"limit": 2, "tenant_id": "t1"})

        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, dict)
        assert [d["dataset_name"] for d in body["items"]] == ["a", "b"]
        assert body["total"] == 107
        assert body["limit"] == 2
        assert body["offset"] == 0
        assert body["next_cursor"] == "2"

    async def test_exclude_status_reaches_the_filter(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        """"Everything still in play" is an exclusion, not a synthetic status.

        The catalog's landing view is dominated by retired rows, and the endpoint
        only ever accepted one exact status — so that view could not be asked for
        at all.
        """
        mock_svc.list_datasets_page.return_value = ([_dataset_row("a")], 16)

        resp = await client.get(
            "/datasets",
            params={"limit": 20, "tenant_id": "t1", "exclude_status": "RETIRED"},
        )

        assert resp.status_code == 200, resp.text
        filters = mock_svc.list_datasets_page.call_args.kwargs["filters"]
        assert [status.value for status in filters.exclude_statuses] == ["RETIRED"]
        # The exact-status filter stays independent of the exclusion.
        assert filters.status is None

    async def test_last_page_has_null_cursor(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        mock_svc.list_datasets_page.return_value = ([_dataset_row("z")], 5)

        resp = await client.get("/datasets", params={"limit": 4, "offset": 4, "tenant_id": "t1"})

        body = resp.json()
        assert body["offset"] == 4
        assert body["next_cursor"] is None

    async def test_cursor_advances_offset(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        mock_svc.list_datasets_page.return_value = ([], 10)

        resp = await client.get("/datasets", params={"limit": 5, "cursor": "5", "tenant_id": "t1"})

        assert resp.status_code == 200
        _, kwargs = mock_svc.list_datasets_page.call_args
        assert kwargs["offset"] == 5

    async def test_invalid_cursor_is_a_400(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        resp = await client.get(
            "/datasets", params={"limit": 5, "cursor": "bogus", "tenant_id": "t1"}
        )

        assert resp.status_code == 400

    async def test_paged_call_forwards_filters(
        self, client: AsyncClient, mock_svc: MagicMock, monkeypatch
    ) -> None:
        monkeypatch.setattr(settings, "pod_namespace", "tenant-t1")
        mock_svc.list_datasets_page.return_value = ([], 0)

        resp = await client.get(
            "/datasets", params={"limit": 10, "status": "PUBLISHED", "tenant_id": "t1"}
        )

        assert resp.status_code == 200
        _, kwargs = mock_svc.list_datasets_page.call_args
        filters = kwargs["filters"]
        assert filters.status is not None and filters.status.value == "PUBLISHED"
        # Resolved to the namespace value-space, like GET /datasets/stats.
        assert filters.tenant_id == "tenant-t1"


# ------------------------------------------------------------------
# GET /datasets/{name}/records — records paging
# ------------------------------------------------------------------


class TestRecordsPaging:
    async def test_unpaged_call_returns_legacy_bare_list(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        mock_svc.get_records.return_value = [_record_row(1)]

        resp = await client.get("/datasets/my_ds/records")

        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list)
        assert body[0]["dataset_record_id"] == "rec-1"

    async def test_limit_returns_envelope_with_total(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        mock_svc.get_records_page.return_value = ([_record_row(i) for i in range(50)], 180)

        resp = await client.get("/datasets/my_ds/records", params={"limit": 50})

        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, dict)
        assert len(body["items"]) == 50
        assert body["total"] == 180
        assert body["next_cursor"] == "50"

    async def test_cursor_advances_offset_and_ends(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        mock_svc.get_records_page.return_value = ([_record_row(0)], 51)

        resp = await client.get("/datasets/my_ds/records", params={"limit": 50, "cursor": "50"})

        body = resp.json()
        assert body["offset"] == 50
        assert body["next_cursor"] is None
        _, kwargs = mock_svc.get_records_page.call_args
        assert kwargs["offset"] == 50

    async def test_unknown_dataset_is_a_404_not_a_fake_empty(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        mock_svc.get_records_page.side_effect = DatasetNotFoundError("Dataset 'nope' not found")

        resp = await client.get("/datasets/nope/records", params={"limit": 50})

        assert resp.status_code == 404


# ------------------------------------------------------------------
# Registry service — paged pass-through
# ------------------------------------------------------------------


class TestRegistryPaging:
    def test_list_datasets_page_forwards_paging_and_counts(self) -> None:
        storage = MagicMock()
        storage.search_datasets.return_value = [_dataset_row("a")]
        storage.sample_records_by_dataset.return_value = {"a": [_record_row(0)]}
        storage.count_datasets.return_value = 42
        svc = DatasetRegistryService(storage=storage)

        items, total = svc.list_datasets_page(
            DatasetFilterParams(tenant_id="t1"), limit=10, offset=20
        )

        assert [d["dataset_name"] for d in items] == ["a"]
        assert total == 42
        _, kwargs = storage.search_datasets.call_args
        assert kwargs["limit"] == 10
        assert kwargs["offset"] == 20
        assert kwargs["tenant_id"] == "t1"
        _, count_kwargs = storage.count_datasets.call_args
        assert count_kwargs["tenant_id"] == "t1"

    def test_get_records_page_forwards_paging_and_counts(self) -> None:
        storage = MagicMock()
        storage.get_records.return_value = [_record_row(0)]
        storage.count_records.return_value = 180
        svc = DatasetRegistryService(storage=storage)

        items, total = svc.get_records_page("my_ds", "t1", limit=50, offset=100)

        assert len(items) == 1
        assert total == 180
        storage.get_records.assert_called_once_with("my_ds", "t1", limit=50, offset=100)
        storage.count_records.assert_called_once_with("my_ds", "t1")


# ------------------------------------------------------------------
# Store — real SQL paging over a file-backed sqlite database
# ------------------------------------------------------------------


class TestStorePaging:
    @pytest.fixture
    def store(self, tmp_path, monkeypatch):
        from proofgrove.settings import settings

        monkeypatch.setattr(settings, "database_url", f"sqlite:///{tmp_path}/datasets.db")
        from proofgrove.datasets.postgres_store import SqlDatasetStore

        return SqlDatasetStore()

    def _seed(self, store, name: str, records: int) -> None:
        from proofgrove.datasets.enums import DatasetStatus
        from proofgrove.datasets.models import DatasetMetadata

        store.create_dataset(
            name,
            DatasetMetadata(
                tenant_id="t1",
                product_id="p1",
                status=DatasetStatus.DRAFT,
                version_number=1,
                created_by="test",
            ),
        )
        if records:
            store.merge_records(
                name,
                "t1",
                [
                    {
                        "inputs": {"question": f"{name}-q{i}"},
                        "expectations": {"expected_output": f"a{i}"},
                        "tags": {"serial_no": str(i)},
                    }
                    for i in range(records)
                ],
            )

    def test_search_datasets_limit_offset_and_count(self, store) -> None:
        for i in range(5):
            self._seed(store, f"ds_{i}", records=0)

        page = store.search_datasets(tenant_id="t1", limit=2, offset=2)
        assert len(page) == 2
        assert store.count_datasets(tenant_id="t1") == 5
        # Legacy unpaged call still returns everything.
        assert len(store.search_datasets(tenant_id="t1")) == 5

    def test_get_records_limit_offset_and_count(self, store) -> None:
        self._seed(store, "big", records=7)

        page = store.get_records("big", "t1", limit=3, offset=5)
        assert len(page) == 2
        assert store.count_records("big", "t1") == 7
        # Legacy unpaged call still returns everything.
        assert len(store.get_records("big", "t1")) == 7

    def test_count_records_unknown_dataset_raises(self, store) -> None:
        with pytest.raises(DatasetNotFoundError):
            store.count_records("missing", "t1")


# ------------------------------------------------------------------
# GET /datasets — tenant scoping
# ------------------------------------------------------------------


class TestListDatasetsTenantScope:
    """``GET /datasets`` must never return another tenant's datasets.

    It resolves the tenant the same way ``GET /datasets/stats`` does, so the
    library's status chips (scoped) and the paged ``total`` count the same
    population.
    """

    @pytest.fixture
    def scoped_client(self, tmp_path, monkeypatch):
        from proofgrove.datasets.enums import DatasetStatus
        from proofgrove.datasets.models import DatasetMetadata
        from proofgrove.settings import settings

        monkeypatch.setattr(settings, "database_url", f"sqlite:///{tmp_path}/scope.db")
        from proofgrove.datasets.postgres_store import SqlDatasetStore

        store = SqlDatasetStore()
        for name, tenant in (("mine_a", "tenant-a"), ("mine_b", "tenant-a"), ("theirs", "tenant-b")):
            store.create_dataset(
                name,
                DatasetMetadata(
                    tenant_id=tenant,
                    product_id="p1",
                        status=DatasetStatus.DRAFT,
                    version_number=1,
                    created_by="test",
                ),
            )
        svc = DatasetRegistryService(storage=store)
        app.dependency_overrides[get_registry_service] = lambda: svc
        transport = ASGITransport(app=app)
        return transport

    @pytest.fixture
    async def scoped(self, scoped_client):
        async with AsyncClient(
            transport=scoped_client,
            base_url="http://test",
            headers={"x-evalai-tenant": TENANT},
        ) as ac:
            yield ac
        app.dependency_overrides.clear()

    async def test_paged_list_excludes_other_tenants(self, scoped: AsyncClient) -> None:
        resp = await scoped.get(
            "/datasets",
            params={"limit": 50, "tenant_id": "tenant-a"},
            headers={"x-evalai-tenant": "tenant-a"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert sorted(d["dataset_name"] for d in body["items"]) == ["mine_a", "mine_b"]
        assert body["total"] == 2

    async def test_legacy_bare_list_excludes_other_tenants(self, scoped: AsyncClient, monkeypatch) -> None:
        monkeypatch.setattr(settings, "pod_namespace", "tenant-b")
        # No paging params and no tenant_id: the unpaged legacy shape used to
        # return every tenant's datasets.
        resp = await scoped.get("/datasets", headers={"x-evalai-tenant": "b"})

        assert resp.status_code == 200
        assert [d["dataset_name"] for d in resp.json()] == ["theirs"]

    async def test_gateway_header_scopes_a_query_without_tenant_id(
        self, scoped: AsyncClient, monkeypatch
    ) -> None:
        monkeypatch.setattr(settings, "pod_namespace", "tenant-a")
        resp = await scoped.get(
            "/datasets", params={"limit": 50}, headers={"x-evalai-tenant": "a"}
        )

        assert resp.status_code == 200
        body = resp.json()
        assert sorted(d["dataset_name"] for d in body["items"]) == ["mine_a", "mine_b"]

    async def test_tenant_id_that_contradicts_the_header_is_a_403(
        self, scoped: AsyncClient
    ) -> None:
        resp = await scoped.get(
            "/datasets",
            params={"limit": 50, "tenant_id": "tenant-b"},
            headers={"x-evalai-tenant": "a"},
        )

        assert resp.status_code == 403
