"""Dataset routes are authorized against the dataset's own tenant.

Datasets are addressed by a globally unique name rather than under a tenant
path, so before this the name alone was enough to reach one. List and search
were tenant-scoped, which made the registry look partitioned while direct name
access was not.
"""

from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from evalhub.api.dependencies import get_registry_service
from evalhub.datasets.exceptions import DatasetNotFoundError
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


def _as(tenant: str) -> dict[str, str]:
    return {"x-evalai-tenant": tenant}


# One representative of each route family named in the acceptance criteria:
# a read, a record mutation, a lifecycle transition, and a version/restore.
CROSS_TENANT_ROUTES = [
    ("get", "/datasets/victim_ds", None),
    ("get", "/datasets/victim_ds/records", None),
    ("post", "/datasets/victim_ds/records", {"records": []}),
    ("request", "/datasets/victim_ds/records", {"record_ids": ["r1"]}),  # DELETE with body
    ("post", "/datasets/victim_ds/publish", {}),
    ("post", "/datasets/victim_ds/approve", {"approved_by": "someone"}),
    ("post", "/datasets/victim_ds/restore", {"created_by": "someone"}),
    (
        "post",
        "/datasets/victim_ds/expected-tools",
        {"record_ids": ["r1"], "tools": ["t"]},
    ),
    (
        "post",
        "/datasets/victim_ds/promotions",
        {"run_id": "r1", "example_id": "e1", "tenant_id": "tenant-intruder"},
    ),
    ("delete", "/datasets/victim_ds", None),
]


class TestCrossTenantAccessIsRefused:
    @pytest.mark.parametrize(("method", "path", "body"), CROSS_TENANT_ROUTES)
    async def test_another_tenants_dataset_is_unreachable(
        self, client: AsyncClient, mock_svc: MagicMock, method: str, path: str, body
    ) -> None:
        if method == "request":
            resp = await client.request("DELETE", path, json=body, headers=_as(INTRUDER))
        elif body is None:
            resp = await getattr(client, method)(path, headers=_as(INTRUDER))
        else:
            resp = await getattr(client, method)(path, json=body, headers=_as(INTRUDER))

        assert resp.status_code == 404, f"{method} {path} leaked to another tenant"
        # The refusal happens before the service is asked to do anything.
        assert not mock_svc.merge_records.called
        assert not mock_svc.delete_records.called
        assert not mock_svc.publish_dataset.called
        assert not mock_svc.restore_as_draft.called
        assert not mock_svc.annotate_expected_tools.called
        assert not mock_svc.promote_record.called

    async def test_refusal_is_indistinguishable_from_a_missing_dataset(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        # A distinct 403 would confirm the name exists, turning the endpoint
        # into an oracle for other tenants' dataset names.
        forbidden = await client.get("/datasets/victim_ds", headers=_as(INTRUDER))

        mock_svc.get_dataset_tenant.side_effect = DatasetNotFoundError("nope")
        missing = await client.get("/datasets/no_such_ds", headers=_as(INTRUDER))

        assert forbidden.status_code == missing.status_code == 404
        assert forbidden.json() == missing.json()


class TestOwningTenantIsUnaffected:
    async def test_the_owner_still_reaches_its_own_dataset(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        mock_svc.get_records.return_value = [{"inputs": {}, "expectations": {}, "tags": {}}]
        resp = await client.get("/datasets/victim_ds/records", headers=_as(OWNER))
        assert resp.status_code == 200
        assert mock_svc.get_records.called

    async def test_a_caller_with_no_tenant_identity_is_refused(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        # The deny is local to the guard, not delegated to the
        # platform_auth_required flag: no header and no pod namespace means no
        # identity to authorize, and the refusal reads as a missing dataset.
        mock_svc.get_records.return_value = []
        resp = await client.get("/datasets/victim_ds/records")
        assert resp.status_code == 404
        assert not mock_svc.get_records.called

    async def test_an_in_cluster_caller_falls_back_to_the_pod_namespace(
        self, client: AsyncClient, mock_svc: MagicMock, monkeypatch
    ) -> None:
        # Sidecar-less in-cluster callers present no header; the pod namespace
        # is the deployment's own tenant and stands in for it.
        from evalhub.platform import authz

        monkeypatch.setattr(authz.settings, "pod_namespace", OWNER)
        mock_svc.get_records.return_value = []
        resp = await client.get("/datasets/victim_ds/records")
        assert resp.status_code == 200

    async def test_an_empty_recorded_owner_never_matches(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        # Non-nullable is not the guarantee the guard needs — non-empty is. A
        # row that reached the table with an empty tenant must not be
        # world-readable.
        mock_svc.get_dataset_tenant.return_value = ""
        resp = await client.get("/datasets/victim_ds/records", headers=_as(OWNER))
        assert resp.status_code == 404

    async def test_the_missing_header_401_passes_through_unrewritten(
        self, client: AsyncClient, mock_svc: MagicMock, monkeypatch
    ) -> None:
        # Only the cross-tenant 403 is rewritten to 404. A missing header is a
        # fact about the caller, not about which datasets exist, so it must keep
        # its own status rather than be disguised as a missing dataset.
        from evalhub.platform import authz

        monkeypatch.setattr(authz.settings, "platform_auth_required", True)
        resp = await client.get("/datasets/victim_ds/records")
        assert resp.status_code == 401


class TestNonDatasetRoutesAreUntouched:
    async def test_routes_without_a_dataset_name_do_not_resolve_a_tenant(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        # list/stats/template carry no dataset_name, so the guard must no-op
        # rather than fail them or invent a lookup.
        resp = await client.get("/datasets/csv-template", headers=_as(INTRUDER))
        assert resp.status_code == 200
        assert not mock_svc.get_dataset_tenant.called


class TestEveryDatasetScopedRouteIsCovered:
    def test_the_guard_is_on_the_router_not_on_individual_endpoints(self) -> None:
        # Registering per endpoint means route 17 is protected by memory. This
        # asserts the dependency sits on the router, so a route added later is
        # covered by construction.
        from evalhub.api.v1.datasets import authorize_dataset_tenant, router

        registered = [
            dependency.dependency for dependency in (router.dependencies or [])
        ]
        assert authorize_dataset_tenant in registered

    def test_the_set_of_dataset_scoped_routes_is_frozen(self) -> None:
        # A count threshold is a rubber stamp: a route can disappear, or a new
        # vulnerable one can be added under a differently-named path param,
        # without failing. Freeze the exact set so either forces a decision.
        from evalhub.api.v1.datasets import router

        scoped = {
            f"{sorted(route.methods)[0]} {route.path}"
            for route in router.routes
            if "{dataset_name}" in getattr(route, "path", "")
        }
        assert scoped == {
            "GET /datasets/{dataset_name}",
            "DELETE /datasets/{dataset_name}",
            "POST /datasets/{dataset_name}/records",
            "GET /datasets/{dataset_name}/records",
            "DELETE /datasets/{dataset_name}/records",
            "POST /datasets/{dataset_name}/upload-csv",
            "POST /datasets/{dataset_name}/versions",
            "POST /datasets/{dataset_name}/restore",
            "GET /datasets/{dataset_name}/history",
            "POST /datasets/{dataset_name}/validate",
            "POST /datasets/{dataset_name}/approve",
            "POST /datasets/{dataset_name}/reject",
            "POST /datasets/{dataset_name}/reopen",
            "POST /datasets/{dataset_name}/publish",
            "POST /datasets/{dataset_name}/deprecate",
            "POST /datasets/{dataset_name}/retire",
            "POST /datasets/{dataset_name}/expected-tools",
            "POST /datasets/{dataset_name}/promotions",
        }

    def test_no_route_takes_a_dataset_name_under_another_param_name(self) -> None:
        # The router guard keys off `dataset_name`. A route spelling it
        # differently would be silently unguarded.
        import re

        from evalhub.api.v1.datasets import router

        for route in router.routes:
            for param in re.findall(r"{(\w+)}", getattr(route, "path", "")):
                assert param in {"dataset_name", "job_id"}, (
                    f"{route.path} takes {param!r}; the tenant guard only reads dataset_name"
                )


class TestBodySuppliedNamesAreAlsoAuthorized:
    """Routes carrying a dataset name in the body, where the router guard is blind."""

    async def test_create_cannot_reach_another_tenants_existing_dataset(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        # create_dataset reuses an existing DRAFT and versions an existing
        # non-DRAFT, so an unchecked name here reaches a foreign dataset without
        # ever touching a path route.
        resp = await client.post(
            "/datasets",
            json={
                "dataset_name": "victim_ds",
                "tenant_id": INTRUDER,
                "product_id": "p",
                "created_by": "someone",
            },
            headers=_as(INTRUDER),
        )
        assert resp.status_code == 404
        assert not mock_svc.create_dataset.called

    async def test_create_cannot_attribute_a_dataset_to_another_tenant(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        mock_svc.get_dataset_tenant.side_effect = DatasetNotFoundError("new name")
        resp = await client.post(
            "/datasets",
            json={
                "dataset_name": "brand_new_ds",
                "tenant_id": OWNER,
                "product_id": "p",
                "created_by": "someone",
            },
            headers=_as(INTRUDER),
        )
        assert resp.status_code == 403
        assert not mock_svc.create_dataset.called

    async def test_versions_cannot_branch_from_another_tenants_dataset(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        # The confused deputy: the endpoint never reads its own path param, so
        # authorizing only the path would let an owned name in the path escort
        # a victim's name in the body.
        def owner_of(name: str, tenant: str) -> str:
            # Tenant-scoped identity: a foreign name is indistinguishable from
            # a missing one — the store raises instead of naming another owner.
            if name == "my_ds":
                return INTRUDER
            raise DatasetNotFoundError("Dataset not found")

        mock_svc.get_dataset_tenant.side_effect = owner_of
        # The refusal now happens inside the scoped service call, not by
        # comparing owners at the route: branching from a name this tenant
        # does not hold raises the same not-found the route maps to 404.
        mock_svc.create_new_version.side_effect = DatasetNotFoundError("Dataset not found")
        resp = await client.post(
            "/datasets/my_ds/versions",
            json={
                "source_dataset_name": "victim_ds",
                "new_dataset_name": "stolen_v2",
                "change_reason": "content_update",
                "created_by": "someone",
            },
            headers=_as(INTRUDER),
        )
        assert resp.status_code == 404
        assert "victim_ds" not in resp.text

    async def test_generation_cannot_target_another_tenants_dataset(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        # Generation registers via create_dataset then replaces records, so an
        # unchecked target name overwrites a foreign DRAFT asynchronously.
        resp = await client.post(
            "/datasets/generate",
            json={
                "dataset_name": "victim_ds",
                "generation_method": "llms",
                "num_rows": 2,
                "model": "some-model",
            },
            headers=_as(INTRUDER),
        )
        assert resp.status_code in (403, 404)
        assert not mock_svc.create_generation_job.called


class TestTheGuardFailsClosedWithoutIdentity:
    """The root rule: no identity is a refusal, not a pass.

    ``platform_auth_required`` is false in every environment, so a guard that
    only compares when a header happens to be present is not a guard. These
    pin the shared ``enforce_tenant`` behaviour every route depends on.
    """

    async def test_a_scoped_listing_cannot_be_read_without_identity(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        # The enumeration case: naming a victim tenant in the query while
        # presenting none of your own.
        resp = await client.get("/datasets", params={"tenant_id": OWNER})
        assert resp.status_code == 401
        assert not mock_svc.search_datasets.called

    async def test_a_scoped_listing_cannot_name_another_tenant(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        resp = await client.get(
            "/datasets", params={"tenant_id": OWNER}, headers=_as(INTRUDER)
        )
        assert resp.status_code == 403
        assert not mock_svc.search_datasets.called

    async def test_an_in_cluster_caller_is_identified_by_its_namespace(
        self, client: AsyncClient, mock_svc: MagicMock, monkeypatch
    ) -> None:
        # Eval Hub deploys per tenant, so a header-less in-cluster caller is
        # that namespace's tenant — not "unauthenticated but allowed".
        from evalhub.platform import authz

        monkeypatch.setattr(authz.settings, "pod_namespace", OWNER)
        mock_svc.search_datasets.return_value = []
        resp = await client.get("/datasets", params={"tenant_id": OWNER})
        assert resp.status_code == 200


class TestVersionDestinationNamesAreAuthorized:
    async def test_a_foreign_destination_name_is_invisible_not_an_oracle(
        self, client: AsyncClient, mock_svc: MagicMock
    ) -> None:
        # Tenant-scoped identity: another tenant holding "victim_ds" must not
        # influence this caller's answer at all — the name resolves as free
        # for this tenant, and nothing about the foreign row is ever echoed.
        def owner_of(name: str, tenant: str) -> str:
            if name == "victim_ds":
                raise DatasetNotFoundError("Dataset not found")
            return INTRUDER

        mock_svc.get_dataset_tenant.side_effect = owner_of
        mock_svc.create_new_version.return_value.model_dump.return_value = {
            "dataset_id": "d2", "name": "victim_ds", "tenant_id": INTRUDER,
        }
        resp = await client.post(
            "/datasets/mine_ds/versions",
            json={
                "source_dataset_name": "mine_ds",
                "new_dataset_name": "victim_ds",
                "change_reason": "content_update",
                "created_by": "someone",
            },
            headers=_as(INTRUDER),
        )
        # The foreign row changed nothing: the name is free for this tenant.
        assert resp.status_code == 201
        assert mock_svc.create_new_version.called


class TestRunFromDatasetIsAuthorized:
    """The two dataset-named routes outside the datasets router."""

    async def test_launching_a_run_from_a_foreign_dataset_is_refused(
        self, mock_svc: MagicMock
    ) -> None:
        from unittest.mock import MagicMock as _MagicMock

        mock_svc.get_dataset.return_value = _MagicMock(
            status="PUBLISHED", version_number=1, tenant_id=OWNER
        )
        app.dependency_overrides[get_registry_service] = lambda: mock_svc
        transport = ASGITransport(app=app)
        try:
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post(
                    "/evaluation/runs/from-dataset/victim_ds",
                    json={"response_source": "baseline"},
                    headers=_as(INTRUDER),
                )
        finally:
            app.dependency_overrides.clear()
        assert resp.status_code == 404
        assert not mock_svc.get_records.called

    async def test_readiness_for_a_foreign_dataset_is_refused(
        self, mock_svc: MagicMock
    ) -> None:
        from unittest.mock import MagicMock as _MagicMock

        mock_svc.get_dataset.return_value = _MagicMock(
            status="PUBLISHED", version_number=1, tenant_id=OWNER
        )
        app.dependency_overrides[get_registry_service] = lambda: mock_svc
        transport = ASGITransport(app=app)
        try:
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post(
                    "/evaluation/runs/from-dataset/victim_ds/readiness",
                    json={"response_source": "baseline"},
                    headers=_as(INTRUDER),
                )
        finally:
            app.dependency_overrides.clear()
        assert resp.status_code == 404
        assert not mock_svc.get_records.called


class TestEarlyReadinessPathIsAuthorized:
    """A source that cannot supply tool evidence resolves readiness without
    reading records — the structural early return. Tenant isolation there must
    not rest on which depths happen to be unsupported."""

    async def test_unsupported_scope_readiness_still_refuses_a_foreign_dataset(
        self, mock_svc: MagicMock
    ) -> None:
        from unittest.mock import MagicMock as _MagicMock

        mock_svc.get_dataset.return_value = _MagicMock(
            status="PUBLISHED", version_number=1, tenant_id=OWNER
        )
        app.dependency_overrides[get_registry_service] = lambda: mock_svc
        transport = ASGITransport(app=app)
        try:
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post(
                    "/evaluation/runs/from-dataset/victim_ds/readiness",
                    json={"response_source": "baseline", "evaluation_scope": "full_execution"},
                    headers=_as(INTRUDER),
                )
        finally:
            app.dependency_overrides.clear()
        assert resp.status_code == 404
        assert not mock_svc.get_records.called


class TestRestoreRequiresGovernanceApprove:
    """POST /datasets/{name}/restore needs governance.approve, not evaluation.run.

    Restoring a retired dataset re-publishes retired content -- the same
    governance class as /publish and /retire, both already gated. Without a
    ``/restore`` marker in ``permission_for_request`` it fell through to the
    generic ``evaluation.run`` default, so a caller who could only launch
    evaluations could also undo a retirement.
    """

    async def test_evaluation_run_alone_is_refused_governance_approve_is_allowed(
        self, mock_svc: MagicMock, monkeypatch
    ) -> None:
        from evalhub.platform import authz
        from evalhub.settings import settings

        mock_svc.restore_as_draft.return_value = MagicMock(
            model_dump=MagicMock(return_value={"dataset_name": "victim_ds", "version_number": 2})
        )
        app.dependency_overrides[get_registry_service] = lambda: mock_svc

        previous_auth_required = settings.platform_auth_required
        settings.platform_auth_required = True
        granted: set[str] = {"evaluation.run"}

        async def grant(request, permission):
            allowed = permission in granted
            if allowed:
                request.state.eval_hub_permissions = {
                    *getattr(request.state, "eval_hub_permissions", set()),
                    permission,
                }
            return allowed

        monkeypatch.setattr(authz, "check_permission", grant)
        transport = ASGITransport(app=app)
        try:
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                headers = {**_as(OWNER), "x-evalai-sub": "synthetic-operator"}

                denied = await ac.post(
                    "/datasets/victim_ds/restore",
                    json={"created_by": "someone"},
                    headers=headers,
                )
                assert denied.status_code == 403, denied.text
                assert not mock_svc.restore_as_draft.called

                granted.add("governance.approve")
                allowed = await ac.post(
                    "/datasets/victim_ds/restore",
                    json={"created_by": "someone"},
                    headers=headers,
                )
                assert allowed.status_code == 201, allowed.text
                assert mock_svc.restore_as_draft.called
        finally:
            settings.platform_auth_required = previous_auth_required
            app.dependency_overrides.clear()
