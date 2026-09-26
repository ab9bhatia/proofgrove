"""Actor attribution on dataset write routes that were not covered by the
governance sign-off fix (eb804a3d9, dataset approve/reject/reopen).

Each of these routes accepts a body-supplied ``created_by`` and persists it as
the actor of record. Under ``platform_auth_required``, the authenticated
subject (``x-evalai-sub``) must win over whatever the caller wrote in the
body -- the same pattern already used by approve/reject/reopen
(``if settings.platform_auth_required: request.<field> = actor_from_request(...)``).
With auth off (local dev), the body value must still be used unchanged.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from proofgrove.api import dependencies
from proofgrove.api.dependencies import get_evaluation_store, get_registry_service
from proofgrove.datasets.enums import DatasetStatus
from proofgrove.datasets.exceptions import DatasetNotFoundError
from proofgrove.datasets.models import CreateDatasetRequest, DatasetInfo, PromoteRunItemResult, WriteExpectedToolsResult
from proofgrove.evaluation.models import EvidencePolicy, RunItemDetail, RunItemExecution
from proofgrove.main import app
from proofgrove.platform import authz
from proofgrove.platform.authz import actor_from_request
from proofgrove.settings import settings
from tests.platform.test_action_authorization import _AuthzClient

TENANT = "tenant-actor-binding"
FORGED = "mallory"
VERIFIED = "alice"


def _headers(*, subject: str | None = VERIFIED) -> dict:
    headers = {"x-evalai-tenant": TENANT}
    if subject is not None:
        headers["x-evalai-sub"] = subject
    return headers


def _allow_authz(monkeypatch, auth_required: bool) -> None:
    """Every POST route in this file requires PERMISSION_EVALUATION_RUN via
    AuthorizationMiddleware. When auth is required that means a real-looking
    check_permission() call; stub it to allow, same as
    test_dataset_lifecycle_guards.py's established pattern."""
    if not auth_required:
        return
    monkeypatch.setattr(settings, "pod_namespace", "")
    monkeypatch.setattr(settings, "authz_check_token", SecretStr("synthetic-check-token"))
    monkeypatch.setattr(authz.httpx, "AsyncClient", lambda **kwargs: _AuthzClient(True, []))


@pytest.fixture
def mock_svc() -> MagicMock:
    svc = MagicMock()
    svc.get_dataset_tenant.return_value = TENANT
    return svc


@pytest.fixture
def mock_store() -> MagicMock:
    return MagicMock()


@pytest.fixture
async def api_client(mock_svc: MagicMock, mock_store: MagicMock):
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    app.dependency_overrides[get_evaluation_store] = lambda: mock_store
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


@pytest.mark.asyncio
@pytest.mark.parametrize("auth_required", [True, False])
async def test_create_dataset_binds_actor(api_client, mock_svc, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    # A fresh dataset name has no owner yet -- _authorize_named_dataset treats
    # that as the normal "creating something new" case.
    mock_svc.get_dataset_tenant.side_effect = DatasetNotFoundError("no such dataset")
    mock_svc.create_dataset.return_value = DatasetInfo(
        dataset_id="d1", name="ds", tenant_id=TENANT, product_id="p", status="DRAFT"
    )
    resp = await api_client.post(
        "/datasets",
        json={"dataset_name": "ds", "tenant_id": TENANT, "product_id": "p", "created_by": FORGED},
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    sent = mock_svc.create_dataset.call_args.args[0]
    assert sent.created_by == (VERIFIED if auth_required else FORGED)


@pytest.mark.asyncio
@pytest.mark.parametrize("auth_required", [True, False])
async def test_create_version_binds_actor(api_client, mock_svc, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    mock_svc.create_new_version.return_value = DatasetInfo(
        dataset_id="d2", name="ds_v2", tenant_id=TENANT, product_id="p", status="DRAFT"
    )
    resp = await api_client.post(
        "/datasets/ds/versions",
        json={
            "source_dataset_name": "ds",
            "new_dataset_name": "ds_v2",
            "change_reason": "content_update",
            "created_by": FORGED,
        },
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    sent = mock_svc.create_new_version.call_args.args[0]
    assert sent.created_by == (VERIFIED if auth_required else FORGED)


@pytest.mark.asyncio
@pytest.mark.parametrize("auth_required", [True, False])
async def test_restore_dataset_binds_actor(api_client, mock_svc, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    mock_svc.restore_as_draft.return_value = DatasetInfo(
        dataset_id="d3", name="ds_v3", tenant_id=TENANT, product_id="p", status="DRAFT"
    )
    resp = await api_client.post(
        "/datasets/ds/restore",
        json={"created_by": FORGED},
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    actor_arg = mock_svc.restore_as_draft.call_args.args[1]
    assert actor_arg == (VERIFIED if auth_required else FORGED)


@pytest.mark.asyncio
@pytest.mark.parametrize("auth_required", [True, False])
async def test_write_expected_tools_binds_actor(api_client, mock_svc, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    mock_svc.annotate_expected_tools.return_value = WriteExpectedToolsResult(
        dataset_name="ds", annotated=1, tools=["search"]
    )
    resp = await api_client.post(
        "/datasets/ds/expected-tools",
        json={"record_ids": ["r1"], "tools": ["search"], "created_by": FORGED},
        headers=_headers(),
    )
    assert resp.status_code == 200, resp.text
    sent = mock_svc.annotate_expected_tools.call_args.args[1]
    assert sent.created_by == (VERIFIED if auth_required else FORGED)


def _run_item() -> RunItemDetail:
    return RunItemDetail(
        run_id="run-1",
        example_id="ex-1",
        sequence_position=0,
        input={"question": "q"},
        output={"response": "a"},
        expected={"expected_output": "a"},
        metadata={},
        execution=RunItemExecution(trace_id="trace-1"),
        evidence_ref="evidence-pack://run-1/items/ex-1",
        evidence_policy=EvidencePolicy(redaction_enabled=False, max_persisted_string_size=None),
        capture_state="complete",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("auth_required", [True, False])
async def test_promote_run_item_binds_actor(api_client, mock_svc, mock_store, monkeypatch, auth_required):
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    mock_store.get_run_item = AsyncMock(return_value=_run_item())
    mock_svc.promote_record.return_value = PromoteRunItemResult(
        dataset_name="ds", record_id="rid-1", duplicate=False
    )
    resp = await api_client.post(
        "/datasets/ds/promotions",
        json={"run_id": "run-1", "example_id": "ex-1", "created_by": FORGED},
        headers=_headers(),
    )
    assert resp.status_code == 200, resp.text
    kwargs = mock_svc.promote_record.call_args.kwargs
    assert kwargs["created_by"] == (VERIFIED if auth_required else FORGED)


def test_actor_from_request_prefers_the_gateway_subject():
    """actor_from_request prefers x-evalai-sub (gateway-injected) over the
    legacy x-evalai-subject header, falling back to 'system' with neither.
    AuthorizationMiddleware separately 401s a request with no x-evalai-sub
    before any route is reached when auth is required -- so by the time a
    route calls actor_from_request under platform_auth_required, x-evalai-sub
    is already guaranteed present and this fallback ordering is defensive,
    not load-bearing. Verified directly since that path isn't reachable
    through the live app."""
    from starlette.requests import Request as StarletteRequest

    def _request(headers: dict) -> StarletteRequest:
        raw = [(k.lower().encode(), v.encode()) for k, v in headers.items()]
        return StarletteRequest({"type": "http", "headers": raw})

    assert actor_from_request(_request({"x-evalai-sub": "verified", "x-evalai-subject": "legacy-forged"})) == "verified"
    assert actor_from_request(_request({"x-evalai-subject": "legacy-forged"})) == "legacy-forged"
    assert actor_from_request(_request({})) == "system"


@pytest.mark.parametrize("auth_required", [True, False])
def test_restore_dataset_actor_is_really_persisted(client, monkeypatch, auth_required):
    """The other tests in this file assert what the route PASSES to the
    (mocked) service, not what lands in the database. This one closes that
    gap for the immutable-branching path: a real dataset, forced RETIRED
    through the real registry/store (same technique as
    test_dataset_lifecycle_guards.py's test_lifecycle_actor_comes_from_authenticated_subject),
    restored via a real HTTP call with a forged body actor, then read back
    through a SEPARATE GET request -- proving persistence, not just an
    echoed response."""
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    registry = dependencies.get_registry_service()
    name = f"actor-persist-restore-{auth_required}"
    registry.create_dataset(CreateDatasetRequest(dataset_name=name, tenant_id=TENANT, product_id="p", created_by="original"))
    registry._storage.update_status(name, TENANT, status=DatasetStatus.RETIRED.value)

    resp = client.post(
        f"/datasets/{name}/restore",
        json={"created_by": FORGED},
        headers=_headers(),
    )
    assert resp.status_code == 201, resp.text
    restored_name = resp.json()["name"]
    expected = VERIFIED if auth_required else FORGED

    # Re-fetch through a fresh, unrelated request -- the earlier response body
    # alone would only prove the handler passed the right value in, not that
    # it survived to storage.
    readback = client.get(f"/datasets/{restored_name}", headers=_headers())
    assert readback.status_code == 200, readback.text
    assert readback.json()["created_by"] == expected


@pytest.mark.parametrize("auth_required", [True, False])
def test_lifecycle_history_actor_is_really_persisted(client, monkeypatch, auth_required):
    """Validate / approve / publish through real HTTP calls, then read the
    dataset history back through a separate GET: the STATUS events carry the
    authenticated subject when auth is on. With auth off, approve keeps the
    body-supplied actor (the existing contract) while the body-less
    transitions record no actor at all rather than a made-up one."""
    monkeypatch.setattr(settings, "platform_auth_required", auth_required)
    _allow_authz(monkeypatch, auth_required)
    registry = dependencies.get_registry_service()
    name = f"history-actor-{auth_required}"
    registry.create_dataset(CreateDatasetRequest(dataset_name=name, tenant_id=TENANT, product_id="p", created_by="original"))
    from proofgrove.datasets.models import DatasetRecord

    registry.merge_records(
        name,
        TENANT,
        [DatasetRecord(inputs={"question": "What is X?"}, expectations={"expected_output": "X"})],
        actor="original",
    )

    validated = client.post(f"/datasets/{name}/validate", headers=_headers())
    assert validated.status_code == 200, validated.text
    assert validated.json()["target_status"] == DatasetStatus.VALIDATED.value
    approved = client.post(f"/datasets/{name}/approve", json={"approved_by": FORGED}, headers=_headers())
    assert approved.status_code == 200, approved.text
    published = client.post(f"/datasets/{name}/publish", headers=_headers())
    assert published.status_code == 200, published.text

    history = client.get(f"/datasets/{name}/history", headers=_headers())
    assert history.status_code == 200, history.text
    actors = {event["operation"]: event["actor"] for event in history.json()}
    assert actors["CREATE"] == "original"
    assert actors["MERGE"] == "original"
    assert actors["STATUS:VALIDATED"] == (VERIFIED if auth_required else None)
    assert actors["STATUS:APPROVED"] == (VERIFIED if auth_required else FORGED)
    assert actors["STATUS:PUBLISHED"] == (VERIFIED if auth_required else None)
