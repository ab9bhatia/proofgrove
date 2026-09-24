"""Delete follows the DRAFT-only rule every other mutation follows, and a
same-name race is reported as a duplicate rather than an internal error."""

import logging
import threading
from unittest.mock import MagicMock

import pytest

from evalhub.datasets.exceptions import DatasetError, DatasetImmutableError
from evalhub.datasets.models import CreateDatasetRequest, DatasetMetadata
from evalhub.datasets.postgres_store import SqlDatasetStore
from evalhub.datasets.registry import DatasetRegistryService
from evalhub.datasets.versioning import DatasetStatus
from evalhub.settings import settings

TENANT = "tenant-guards"


def _registry() -> DatasetRegistryService:
    return DatasetRegistryService(storage=SqlDatasetStore())


@pytest.mark.parametrize("redaction_enabled", [True, False])
def test_reject_and_reopen_never_log_review_notes(caplog, monkeypatch, redaction_enabled):
    monkeypatch.setattr(settings, "payload_redaction_enabled", redaction_enabled)
    registry = _registry()
    name = "review-note-guard"
    registry.create_dataset(CreateDatasetRequest(dataset_name=name, tenant_id=TENANT, product_id="p", created_by="t"))
    sentinel = "private-evaluation-note-sentinel"
    with caplog.at_level(logging.INFO, logger="evalhub.datasets.registry"):
        assert registry.reject_dataset(name, "reviewer", TENANT, sentinel).status == DatasetStatus.REJECTED
        assert registry.reopen_dataset(name, "reviewer", TENANT, sentinel).status == DatasetStatus.DRAFT
    records = [record for record in caplog.records if record.name == "evalhub.datasets.registry"]
    assert len(records) == 2
    assert "rejected" in records[0].getMessage()
    assert "returned to draft" in records[1].getMessage()
    for record in records:
        assert name in record.getMessage()
        assert "reviewer" in record.getMessage()
        assert sentinel not in str(vars(record))


def test_delete_refuses_anything_past_draft():
    """A published version is the evidence its runs were scored against."""
    registry = _registry()
    registry.create_dataset(CreateDatasetRequest(dataset_name="published-guard", tenant_id=TENANT, product_id="p", created_by="t"))
    storage = registry._storage
    storage.update_status("published-guard", TENANT, status=DatasetStatus.PUBLISHED.value)
    with pytest.raises(DatasetImmutableError):
        registry.delete_dataset("published-guard", TENANT)
    assert registry.get_dataset("published-guard", TENANT).status == DatasetStatus.PUBLISHED


def test_delete_removes_a_draft():
    registry = _registry()
    registry.create_dataset(CreateDatasetRequest(dataset_name="draft-guard", tenant_id=TENANT, product_id="p", created_by="t"))
    registry.delete_dataset("draft-guard", TENANT)
    with pytest.raises(DatasetError):
        registry.get_dataset("draft-guard", TENANT)


def test_a_same_name_create_race_reads_as_already_exists():
    """Two creates pass the existence check; the composite key admits one.

    The loser used to surface the ``IntegrityError`` as a 500. Only the dataset
    key violation is translated: the row is re-read after rollback before the
    error is reported as a duplicate.
    """
    store = SqlDatasetStore()
    competitor = SqlDatasetStore()
    metadata = DatasetMetadata(tenant_id=TENANT, product_id="p", created_by="t")
    real_sessionmaker = store._sessionmaker
    raced = threading.Event()

    class _RacingSession:
        def __init__(self, session):
            self._session = session

        def flush(self):
            if not raced.is_set():
                raced.set()
                competitor.create_dataset("raced", metadata)  # commits first, in its own connection
            return self._session.flush()

        def __getattr__(self, name):
            return getattr(self._session, name)

        def __enter__(self):
            self._session.__enter__()
            return self

        def __exit__(self, *args):
            return self._session.__exit__(*args)

    store._sessionmaker = lambda: _RacingSession(real_sessionmaker())
    with pytest.raises(DatasetError, match="already exists"):
        store.create_dataset("raced", metadata)
    assert raced.is_set()
    store._sessionmaker = real_sessionmaker
    assert store.get_metadata("raced", TENANT).tenant_id == TENANT


def test_other_integrity_errors_are_not_reported_as_duplicates():
    from sqlalchemy.exc import IntegrityError

    store = SqlDatasetStore()
    real_sessionmaker = store._sessionmaker

    class _BrokenSession:
        def __init__(self, session):
            self._session = session

        def flush(self):
            raise IntegrityError("INSERT", {}, Exception("some other constraint"))

        def __getattr__(self, name):
            return getattr(self._session, name)

        def __enter__(self):
            self._session.__enter__()
            return self

        def __exit__(self, *args):
            return self._session.__exit__(*args)

    store._sessionmaker = lambda: _BrokenSession(real_sessionmaker())
    with pytest.raises(IntegrityError):
        store.create_dataset("not-a-duplicate", DatasetMetadata(tenant_id=TENANT, product_id="p", created_by="t"))
    store._sessionmaker = real_sessionmaker


def test_registry_delete_checks_status_before_storage_delete():
    storage = MagicMock()
    storage.get_metadata.return_value = MagicMock(status=DatasetStatus.PUBLISHED)
    with pytest.raises(DatasetImmutableError):
        DatasetRegistryService(storage=storage).delete_dataset("x", TENANT)
    storage.delete_dataset.assert_not_called()


def test_delete_rechecks_status_when_metadata_became_stale(monkeypatch):
    registry = _registry()
    registry.create_dataset(CreateDatasetRequest(dataset_name="delete-race", tenant_id=TENANT, product_id="p", created_by="test"))
    storage = registry._storage
    original = storage.get_metadata
    def stale(name, tenant):
        metadata = original(name, tenant)
        storage.update_status(name, tenant, status=DatasetStatus.PUBLISHED.value)
        return metadata
    monkeypatch.setattr(storage, "get_metadata", stale)
    with pytest.raises(DatasetImmutableError):
        registry.delete_dataset("delete-race", TENANT)
    assert original("delete-race", TENANT).status == DatasetStatus.PUBLISHED


@pytest.mark.parametrize("action,initial", [("approve", DatasetStatus.VALIDATED), ("reject", DatasetStatus.DRAFT), ("reopen", DatasetStatus.REJECTED)])
@pytest.mark.parametrize("mode", ["authenticated", "offline", "missing-sub", "denied"])
def test_lifecycle_actor_comes_from_authenticated_subject(client, monkeypatch, caplog, action, initial, mode):
    from pydantic import SecretStr

    from evalhub.platform import authz
    from tests.platform.test_action_authorization import _AuthzClient

    registry = _registry()
    registry.create_dataset(CreateDatasetRequest(dataset_name="actor-guard", tenant_id=TENANT, product_id="p"))
    registry._storage.update_status("actor-guard", TENANT, status=initial.value)
    monkeypatch.setattr(settings, "pod_namespace", "")
    monkeypatch.setattr(settings, "platform_auth_required", mode != "offline")
    monkeypatch.setattr(settings, "authz_check_token", SecretStr("synthetic-check-token"))
    calls = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", lambda **kwargs: _AuthzClient(mode != "denied", calls))
    headers = {"x-evalai-subject": "legacy-forged"}
    if mode != "missing-sub":
        headers["x-evalai-sub"] = "user:verified-reviewer"
    field = "approved_by" if action == "approve" else "decided_by"
    caplog.clear()
    with caplog.at_level(logging.INFO):
        response = client.post(f"/datasets/actor-guard/{action}", headers=headers, json={field: "forged-reviewer"})
    assert response.status_code == {"missing-sub": 401, "denied": 403}.get(mode, 200), response.text
    records = [r for r in caplog.records if r.name in {"evalhub.events", "evalhub.datasets.registry"}]
    if mode in {"missing-sub", "denied"}:
        assert registry.get_dataset("actor-guard", TENANT).status == initial
        assert not records
    else:
        expected = "user:verified-reviewer" if mode == "authenticated" else "forged-reviewer"
        assert records
        if action == "approve":
            assert any(getattr(r, "eval_fields", {}).get("approved_by") == expected for r in records)
        else:
            assert any(expected in r.getMessage() for r in records)
        if mode == "authenticated":
            assert "forged-reviewer" not in str([vars(r) for r in records])
    if calls:
        assert all(c["json"]["permission"] == "governance.approve" for c in calls)
        assert all(c["json"]["subject"] == "user:verified-reviewer" for c in calls)
