"""Blocking dataset operations must run outside the ASGI event-loop thread."""

import threading
from unittest.mock import MagicMock

from httpx import ASGITransport, AsyncClient

from evalhub.api.dependencies import get_registry_service
from evalhub.main import app


async def test_dataset_list_authorization_and_records_run_off_loop():
    loop_thread = threading.get_ident()
    calls = []

    def off_loop(name, result):
        def call(*args, **kwargs):
            assert threading.get_ident() != loop_thread
            calls.append(name)
            return result
        return call

    registry = MagicMock()
    registry.list_datasets_page.side_effect = off_loop("list", ([], 0))
    registry.get_dataset_tenant.side_effect = off_loop("authorize", "tenant-test")
    registry.get_records_page.side_effect = off_loop("records", ([], 0))
    app.dependency_overrides[get_registry_service] = lambda: registry
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", headers={"x-evalai-tenant": "tenant-test"}) as client:
            for path in ("/datasets?limit=10", "/datasets/test/records?limit=10"):
                response = await client.get(path)
                assert response.status_code == 200, response.text
                assert response.json()["items"] == []
        assert calls == ["list", "authorize", "records"]
    finally:
        app.dependency_overrides.pop(get_registry_service, None)


async def test_generation_persistence_runs_off_loop(monkeypatch):
    from evalhub.datasets import generation_service
    from evalhub.datasets.models import DatasetRecord

    loop_thread = threading.get_ident()
    calls = []

    def blocking(name, result):
        def call(*args, **kwargs):
            assert threading.get_ident() != loop_thread
            calls.append(name)
            return result
        return call

    job = {"job_id": "thread-check", "dataset_name": "test", "params": {"num_rows": 1}}
    store = MagicMock()
    store.create_job.side_effect = blocking("create_job", job)
    store.get_job.side_effect = blocking("get_job", job)
    store.advance.side_effect = blocking("advance", True)
    monkeypatch.setattr(generation_service, "get_generation_job_store", blocking("store", store))
    registry = MagicMock()
    registry.create_dataset.side_effect = blocking("create_dataset", MagicMock(name="test"))
    registry.replace_records.side_effect = blocking("replace_records", 1)

    async def synthesize(params):
        assert threading.get_ident() == loop_thread
        return [DatasetRecord(inputs={"query": "q"}, expectations={"answer": "a"})]

    monkeypatch.setattr(generation_service, "_synthesize_records", synthesize)
    await generation_service.start_generation(dataset_name="test", params={}, registry=registry)
    await generation_service._TASKS[job["job_id"]]
    assert calls.count("advance") == 3
    assert "create_job" in calls and "get_job" in calls
    assert "create_dataset" in calls and "replace_records" in calls
