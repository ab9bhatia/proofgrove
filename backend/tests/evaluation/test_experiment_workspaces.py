"""Experiment workspaces: pre-create, manual attach, draft listing (#2671)."""

from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from proofgrove import runs_worker
from proofgrove.api.dependencies import get_registry_service
from proofgrove.db.models import Base
from proofgrove.db.session import async_session_factory
from proofgrove.db.store import EXPERIMENT_CONTRACT_FIELDS, EvaluationStore
from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.enums import EvaluationScope
from proofgrove.evaluation.judge import MockJudge
from proofgrove.evaluation.sample_data import SAMPLE_EXPERIMENTS, get_sample_rows
from proofgrove.main import app
from proofgrove.runs_worker import process_one_job

TENANT = "tenant-attach"
OTHER_TENANT = "tenant-intruder"


def _mock_registry(*, version_number: int = 1):
    mock_svc = MagicMock()
    mock_svc.get_dataset.return_value = MagicMock(
        status="PUBLISHED",
        version_number=version_number,
        product_id="product-a",
        tenant_id=TENANT,
    )
    mock_svc.get_records.return_value = [
        {"inputs": {"query": "q1"}, "expectations": {"answer": "a1"}},
        {"inputs": {"query": "q2"}, "expectations": {"answer": "a2"}},
    ]
    return mock_svc


async def _create_workspace(ac: AsyncClient, name: str = "Pre-run workspace") -> str:
    created = await ac.post(
        "/evaluation/experiments/workspaces",
        json={
            "tenant_id": TENANT,
            "name": name,
            "objective": "Track variants",
            "created_by": "tester",
        },
        headers={"x-evalai-tenant": TENANT},
    )
    assert created.status_code == 201, created.text
    return created.json()["experiment"]["experiment_id"]


async def _run_from_dataset(ac: AsyncClient, dataset: str, body: dict) -> dict:
    resp = await ac.post(
        f"/evaluation/runs/from-dataset/{dataset}",
        json=body,
        headers={"x-evalai-tenant": TENANT},
    )
    return {"status_code": resp.status_code, "json": resp.json(), "text": resp.text}


@pytest.fixture
def mock_registry(monkeypatch):
    svc = _mock_registry()
    app.dependency_overrides[get_registry_service] = lambda: svc
    monkeypatch.setattr(runs_worker, "get_registry_service", lambda: svc)
    yield svc
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_workspaces_listing_includes_lineage_drafts(mock_registry):
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        workspace_id = await _create_workspace(ac, "Named workspace")
        legacy = await _run_from_dataset(
            ac,
            "test_ds",
            {
                "response_source": "baseline",
                "evaluation_name": "Auto group draft",
            },
        )
        assert legacy["status_code"] == 202, legacy["text"]
        assert await process_one_job() is True
        run = (
            await ac.get(
                f"/evaluation/runs/{legacy['json']['run_id']}?tenant_id={TENANT}",
                headers={"x-evalai-tenant": TENANT},
            )
        ).json()
        lineage_id = run["experiment"]["experiment_id"]

        diagnostic = await _run_from_dataset(
            ac,
            "test_ds",
            {
                "response_source": "baseline",
                "evaluation_name": "Diag excluded",
            },
        )
        assert diagnostic["status_code"] == 202, diagnostic["text"]
        assert await process_one_job() is True
        diag_run = (
            await ac.get(
                f"/evaluation/runs/{diagnostic['json']['run_id']}?tenant_id={TENANT}",
                headers={"x-evalai-tenant": TENANT},
            )
        ).json()
        diag_lineage_id = diag_run["experiment"]["experiment_id"]
        # The platform-owned diagnostic marker is no longer minted at run time,
        # but a lineage already carrying it must stay out of the draft listing —
        # the UI labels such runs "Diagnostic", never as a groupable draft.
        async with async_session_factory()() as session:
            await EvaluationStore(session).update_experiment(
                diag_lineage_id, TENANT, {"tags": {"one_off_diagnostic": "true"}}
            )

        listed = await ac.get(
            f"/evaluation/experiments/workspaces?tenant_id={TENANT}&include_drafts=true",
            headers={"x-evalai-tenant": TENANT},
        )
        assert listed.status_code == 200, listed.text
        items = listed.json()
        by_id = {item["experiment"]["experiment_id"]: item for item in items}
        assert workspace_id in by_id
        assert by_id[workspace_id]["kind"] == "experiment"
        assert lineage_id in by_id
        assert by_id[lineage_id]["kind"] == "draft"
        assert by_id[lineage_id]["run_count"] >= 1
        assert diag_lineage_id not in by_id


@pytest.mark.asyncio
async def test_promoting_a_draft_retires_it_from_the_draft_listing(mock_registry):
    """Promotion must not leave the source draft promotable a second time."""
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        launched = await _run_from_dataset(
            ac,
            "test_ds",
            {"response_source": "baseline", "evaluation_name": "Promote me"},
        )
        assert launched["status_code"] == 202, launched["text"]
        assert await process_one_job() is True
        run = (
            await ac.get(
                f"/evaluation/runs/{launched['json']['run_id']}?tenant_id={TENANT}",
                headers={"x-evalai-tenant": TENANT},
            )
        ).json()
        lineage_id = run["experiment"]["experiment_id"]
        run_id = run["run_id"]

        def draft_ids(items: list) -> set:
            return {
                item["experiment"]["experiment_id"]
                for item in items
                if item["kind"] == "draft"
            }

        before = await ac.get(
            f"/evaluation/experiments/workspaces?tenant_id={TENANT}&include_drafts=true",
            headers={"x-evalai-tenant": TENANT},
        )
        assert lineage_id in draft_ids(before.json())

        promoted = await ac.post(
            "/evaluation/experiments/from-runs",
            json={
                "tenant_id": TENANT,
                "name": "Promoted workspace",
                "run_ids": [run_id],
                "baseline_run_id": run_id,
                "created_by": "tester",
            },
            headers={"x-evalai-tenant": TENANT},
        )
        assert promoted.status_code == 201, promoted.text
        workspace_id = promoted.json()["experiment"]["experiment_id"]

        after = await ac.get(
            f"/evaluation/experiments/workspaces?tenant_id={TENANT}&include_drafts=true",
            headers={"x-evalai-tenant": TENANT},
        )
        items = after.json()
        # The draft is gone, the workspace it produced is listed in its place.
        assert lineage_id not in draft_ids(items)
        assert workspace_id in {
            item["experiment"]["experiment_id"] for item in items if item["kind"] == "experiment"
        }
        # The lineage row itself survives, tagged with what it became.
        lineage = await ac.get(
            f"/evaluation/experiments/{lineage_id}",
            headers={"x-evalai-tenant": TENANT},
        )
        assert lineage.json()["tags"].get("promoted_to") == workspace_id
        # The new workspace must not inherit the marker.
        workspace = await ac.get(
            f"/evaluation/experiments/{workspace_id}",
            headers={"x-evalai-tenant": TENANT},
        )
        assert workspace.json()["tags"].get("promoted_to") is None


@pytest.mark.asyncio
async def test_manual_attach_stamps_a_pending_workspace(mock_registry):
    """Add-runs on a zero-run workspace must stamp it like a run-time attach.

    Otherwise ``pending_first_run`` stays set and the next run-time attachment is
    treated as an unrestricted first run, overwriting the workspace basis.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        workspace_id = await _create_workspace(ac, "Manual attach workspace")

        standalone = await _run_from_dataset(
            ac,
            "test_ds",
            {"response_source": "baseline", "evaluation_name": "Manual attach run"},
        )
        assert standalone["status_code"] == 202, standalone["text"]
        assert await process_one_job() is True
        run_id = standalone["json"]["run_id"]

        attached = await ac.post(
            f"/evaluation/experiments/{workspace_id}/runs/attach",
            json={"tenant_id": TENANT, "run_ids": [run_id]},
            headers={"x-evalai-tenant": TENANT},
        )
        assert attached.status_code == 200, attached.text

        workspace = (
            await ac.get(
                f"/evaluation/experiments/{workspace_id}",
                headers={"x-evalai-tenant": TENANT},
            )
        ).json()
        assert workspace["tags"].get("pending_first_run") != "true"
        # The sentinel contract was replaced by the attached run's basis.
        assert workspace["dataset_version"]
        assert workspace["target_endpoint"]


@pytest.fixture
async def store():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield EvaluationStore(session)
    await engine.dispose()


async def _persisted_run(
    store: EvaluationStore,
    *,
    tenant_id: str,
    experiment_id: str,
    basis_hash: str | None = None,
    basis_version: str | None = None,
):
    experiment = SAMPLE_EXPERIMENTS[0].model_copy(
        update={"experiment_id": experiment_id, "tenant_id": tenant_id}
    )
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    run = EvaluationEngine(judge=MockJudge()).execute(experiment, rows)
    if basis_hash is not None:
        assert run.lineage is not None
        run.lineage.comparison_basis_hash = basis_hash
        run.lineage.comparison_basis_version = basis_version
    await store.save_run(run, rows)
    return run


@pytest.mark.asyncio
async def test_store_rejects_attaching_a_foreign_run(store: EvaluationStore):
    """The store guards the attach independently of the enqueue-time check.

    The worker attaches with no request context, so the header check in the API
    cannot be the only thing standing between two tenants.
    """
    workspace = await store.save_experiment(
        SAMPLE_EXPERIMENTS[0].model_copy(
            update={
                "experiment_id": "ws-tenant-a",
                "tenant_id": "tenant-a",
                "tags": {"workspace_kind": "experiment", "pending_first_run": "true"},
            }
        )
    )
    foreign = await _persisted_run(store, tenant_id="tenant-b", experiment_id="exp-b")

    with pytest.raises(ValueError):
        await store.ensure_workspace_accepts_run(
            workspace.experiment_id, foreign, tenant_id="tenant-b"
        )
    with pytest.raises(ValueError):
        await store.attach_run_to_experiment_workspace(
            workspace.experiment_id, foreign, tenant_id="tenant-b"
        )

    assert await store.list_runs_for_experiment(workspace.experiment_id) == []
    reloaded = await store.get_experiment(workspace.experiment_id, "tenant-a")
    assert reloaded is not None
    # The foreign run must not have stamped the workspace contract.
    assert reloaded.tags.get("pending_first_run") == "true"

    # Positive control: the owning tenant's run still attaches and stamps.
    owned = await _persisted_run(store, tenant_id="tenant-a", experiment_id="exp-a")
    await store.ensure_workspace_accepts_run(
        workspace.experiment_id, owned, tenant_id="tenant-a"
    )
    await store.attach_run_to_experiment_workspace(
        workspace.experiment_id, owned, tenant_id="tenant-a"
    )
    assert [run.run_id for run in await store.list_runs_for_experiment(workspace.experiment_id)] == [
        owned.run_id
    ]


@pytest.mark.asyncio
async def test_same_hash_different_basis_version_never_joins_or_compares(
    store: EvaluationStore,
):
    """A v1 run must not join a v2 run's workspace just because the hash matches.

    Attach and compare have to agree: letting the pair in while ``compare_runs``
    refuses every combination leaves a workspace that can never be compared.
    """
    workspace = await store.save_experiment(
        SAMPLE_EXPERIMENTS[0].model_copy(
            update={
                "experiment_id": "ws-basis-version",
                "tenant_id": "tenant-a",
                "tags": {"workspace_kind": "experiment", "pending_first_run": "true"},
            }
        )
    )
    shared_hash = "shared-basis-hash"
    v2 = await _persisted_run(
        store,
        tenant_id="tenant-a",
        experiment_id="exp-basis-v2",
        basis_hash=shared_hash,
        basis_version="v2",
    )
    await store.attach_run_to_experiment_workspace(
        workspace.experiment_id, v2, tenant_id="tenant-a"
    )

    v1 = await _persisted_run(
        store,
        tenant_id="tenant-a",
        experiment_id="exp-basis-v1",
        basis_hash=shared_hash,
        basis_version=None,
    )
    with pytest.raises(ValueError):
        await store.ensure_workspace_accepts_run(
            workspace.experiment_id, v1, tenant_id="tenant-a"
        )
    with pytest.raises(ValueError):
        await store.attach_run_to_experiment_workspace(
            workspace.experiment_id, v1, tenant_id="tenant-a"
        )

    # Positive control: same hash AND same version attaches and compares.
    same = await _persisted_run(
        store,
        tenant_id="tenant-a",
        experiment_id="exp-basis-v2b",
        basis_hash=shared_hash,
        basis_version="v2",
    )
    await store.attach_run_to_experiment_workspace(
        workspace.experiment_id, same, tenant_id="tenant-a"
    )
    comparison = await store.compare_runs(
        workspace.experiment_id, v2.run_id, same.run_id
    )
    assert comparison is not None

    # Linked behind the guard's back, ``compare_runs`` still refuses the pair —
    # which is exactly the dead end the attach check has to prevent.
    await store.link_runs_to_experiment(workspace.experiment_id, [v1.run_id])
    with pytest.raises(ValueError):
        await store.compare_runs(workspace.experiment_id, v2.run_id, v1.run_id)


async def _run_and_wait(ac: AsyncClient, name: str, body: dict | None = None) -> dict:
    """Enqueue one run of evaluation ``name``, drain the worker, return the run."""
    enqueued = await _run_from_dataset(
        ac,
        "test_ds",
        {"response_source": "baseline", "evaluation_name": name, **(body or {})},
    )
    assert enqueued["status_code"] == 202, enqueued["text"]
    assert await process_one_job() is True
    run = await ac.get(
        f"/evaluation/runs/{enqueued['json']['run_id']}?tenant_id={TENANT}",
        headers={"x-evalai-tenant": TENANT},
    )
    assert run.status_code == 200, run.text
    return run.json()


async def _listing(ac: AsyncClient) -> list:
    listed = await ac.get(
        f"/evaluation/experiments/workspaces?tenant_id={TENANT}&include_drafts=true",
        headers={"x-evalai-tenant": TENANT},
    )
    assert listed.status_code == 200, listed.text
    return listed.json()


@pytest.mark.asyncio
async def test_a_run_after_promotion_is_still_listed(mock_registry):
    """Promoting a lineage must not swallow that evaluation's future runs.

    A promoted lineage keeps its stable id, so the next run of the same
    evaluation joins it. Retiring the lineage permanently would leave that run
    in no listed row at all — neither the workspace (which only holds the runs
    selected at promotion time) nor the draft.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        first = await _run_and_wait(ac, "Recurring eval")
        second = await _run_and_wait(ac, "Recurring eval")
        lineage_id = first["experiment"]["experiment_id"]
        assert second["experiment"]["experiment_id"] == lineage_id

        promoted = await ac.post(
            "/evaluation/experiments/from-runs",
            json={
                "tenant_id": TENANT,
                "name": "Promoted from recurring",
                "run_ids": [first["run_id"], second["run_id"]],
                "baseline_run_id": first["run_id"],
                "created_by": "tester",
            },
            headers={"x-evalai-tenant": TENANT},
        )
        assert promoted.status_code == 201, promoted.text
        workspace_id = promoted.json()["experiment"]["experiment_id"]

        # Everything is inside the workspace, so the draft is fully represented.
        by_id = {item["experiment"]["experiment_id"]: item for item in await _listing(ac)}
        assert lineage_id not in by_id
        assert by_id[workspace_id]["run_count"] == 2

        third = await _run_and_wait(ac, "Recurring eval")
        assert third["experiment"]["experiment_id"] == lineage_id

        by_id = {item["experiment"]["experiment_id"]: item for item in await _listing(ac)}
        # The draft is back, carrying only the run that is not in the workspace.
        assert lineage_id in by_id, "the run after promotion is invisible"
        assert by_id[lineage_id]["kind"] == "draft"
        assert by_id[lineage_id]["run_count"] == 1
        assert by_id[lineage_id]["latest_run_id"] == third["run_id"]
        assert by_id[workspace_id]["run_count"] == 2


@pytest.mark.asyncio
async def test_manually_attached_run_is_not_also_listed_as_its_own_draft(mock_registry):
    """The manual Add-runs path must retire the lineage exactly like run-time attach."""
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        workspace_id = await _create_workspace(ac, "Manual single row workspace")
        standalone = await _run_and_wait(ac, "Manually attached eval")
        lineage_id = standalone["experiment"]["experiment_id"]

        by_id = {item["experiment"]["experiment_id"]: item for item in await _listing(ac)}
        assert lineage_id in by_id

        attached = await ac.post(
            f"/evaluation/experiments/{workspace_id}/runs/attach",
            json={"tenant_id": TENANT, "run_ids": [standalone["run_id"]]},
            headers={"x-evalai-tenant": TENANT},
        )
        assert attached.status_code == 200, attached.text

        by_id = {item["experiment"]["experiment_id"]: item for item in await _listing(ac)}
        assert workspace_id in by_id
        assert lineage_id not in by_id


@pytest.mark.asyncio
async def test_foreign_tenant_cannot_read_or_patch_a_workspace(mock_registry):
    """Reading and editing a workspace must be scoped like every other route.

    ``PATCH`` can rewrite the governance contract, so an unscoped one hands one
    tenant's experiment to another.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        workspace_id = await _create_workspace(ac, "Private workspace")
        intruder = {"x-evalai-tenant": OTHER_TENANT}

        assert (
            await ac.get(f"/evaluation/experiments/{workspace_id}", headers=intruder)
        ).status_code == 404
        assert (
            await ac.get(
                f"/evaluation/experiments/{workspace_id}/summary", headers=intruder
            )
        ).status_code == 403
        assert (
            await ac.get(f"/evaluation/experiments/{workspace_id}/runs", headers=intruder)
        ).status_code == 404
        patched = await ac.patch(
            f"/evaluation/experiments/{workspace_id}",
            json={"name": "pwned"},
            headers=intruder,
        )
        assert patched.status_code == 404, patched.text

        owner = await ac.get(
            f"/evaluation/experiments/{workspace_id}",
            headers={"x-evalai-tenant": TENANT},
        )
        assert owner.status_code == 200
        assert owner.json()["name"] == "Private workspace"


@pytest.mark.asyncio
async def test_patch_cannot_forge_or_clear_platform_tags(mock_registry):
    """Platform-managed tags are invariants, not client-writable metadata.

    Setting ``pending_first_run`` re-opens a stamped workspace to any comparison
    basis; dropping ``workspace_kind`` demotes it to a lineage draft.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        headers = {"x-evalai-tenant": TENANT}
        workspace_id = await _create_workspace(ac, "Tag guarded workspace")
        stamping = await _run_and_wait(ac, "Tag guarded eval")
        attached = await ac.post(
            f"/evaluation/experiments/{workspace_id}/runs/attach",
            json={"tenant_id": TENANT, "run_ids": [stamping["run_id"]]},
            headers=headers,
        )
        assert attached.status_code == 200, attached.text

        for forged in (
            {"pending_first_run": "true"},
            {"workspace_kind": "draft"},
            {"promoted_to": "somewhere-else"},
            {"one_off_diagnostic": "true"},
        ):
            denied = await ac.patch(
                f"/evaluation/experiments/{workspace_id}",
                json={"tags": forged},
                headers=headers,
            )
            assert denied.status_code == 422, denied.text
            assert denied.json()["detail"]["code"] == "reserved_experiment_tags"

        # A patch that omits them must not clear them either.
        patched = await ac.patch(
            f"/evaluation/experiments/{workspace_id}",
            json={"tags": {"team": "quality"}},
            headers=headers,
        )
        assert patched.status_code == 200, patched.text
        tags = patched.json()["tags"]
        assert tags["team"] == "quality"
        assert tags["workspace_kind"] == "experiment"
        assert tags.get("pending_first_run") is None


@pytest.mark.asyncio
async def test_versioning_a_pending_workspace_is_a_structured_422(mock_registry):
    """A workspace with no stamped basis cannot be snapshotted as a version.

    Its sentinel ``scenario`` has no enum value, so the contract build used to
    raise ``AttributeError`` and surface as an opaque 500.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        workspace_id = await _create_workspace(ac, "Unstamped workspace")

        denied = await ac.post(
            f"/evaluation/experiments/{workspace_id}/versions",
            json={"created_by": "tester"},
            headers={"x-evalai-tenant": TENANT},
        )
        assert denied.status_code == 422, denied.text
        assert denied.json()["detail"]["code"] == "workspace_has_no_basis_yet"

        # Once an attached run stamps the basis the snapshot succeeds.
        stamping = await _run_and_wait(ac, "Stamping eval")
        attached = await ac.post(
            f"/evaluation/experiments/{workspace_id}/runs/attach",
            json={"tenant_id": TENANT, "run_ids": [stamping["run_id"]]},
            headers={"x-evalai-tenant": TENANT},
        )
        assert attached.status_code == 200, attached.text
        created = await ac.post(
            f"/evaluation/experiments/{workspace_id}/versions",
            json={"created_by": "tester"},
            headers={"x-evalai-tenant": TENANT},
        )
        assert created.status_code == 201, created.text


@pytest.mark.asyncio
async def test_public_experiment_create_rejects_the_sentinel_scenario(mock_registry):
    """``scenario: ""`` is the workspace sentinel, never a client-supplied value.

    It used to persist first and only then crash while reporting the event,
    leaving a poisoned row behind an opaque failure.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as ac:
        denied = await ac.post(
            "/evaluation/experiments",
            json={
                "experiment_id": "exp-sentinel-scenario",
                "name": "Sentinel",
                "dataset_version": "test_ds.v1",
                "target_endpoint": "golden-dataset:test_ds",
                "scenario": "",
                "tenant_id": TENANT,
            },
            headers={"x-evalai-tenant": TENANT},
        )
        assert denied.status_code == 422, denied.text
        assert denied.json()["detail"]["code"] == "scenario_required"

        # Nothing was persisted.
        missing = await ac.get(
            "/evaluation/experiments/exp-sentinel-scenario",
            headers={"x-evalai-tenant": TENANT},
        )
        assert missing.status_code == 404, missing.text


@pytest.mark.asyncio
async def test_first_run_stamps_the_whole_workspace_contract(store: EvaluationStore):
    """A stamped workspace describes the contract of the run that stamped it.

    Copying only the dataset/target/judge fields left the rest of the contract
    (project, evaluation depth, named-tool selection, target provenance) at its
    sentinel, so later workspace reads and version snapshots described a
    contract no run was ever produced under.
    """
    workspace = await store.save_experiment(
        SAMPLE_EXPERIMENTS[0].model_copy(
            update={
                "experiment_id": "ws-contract-stamp",
                "name": "Pre-run workspace",
                "tenant_id": "tenant-a",
                "scenario": "",
                "tags": {"workspace_kind": "experiment", "pending_first_run": "true"},
            }
        )
    )
    contract = SAMPLE_EXPERIMENTS[0].model_copy(
        update={
            "experiment_id": "exp-contract-source",
            "name": "Stamping run lineage",
            "tenant_id": "tenant-a",
            "project_id": "project-checkout",
            "evaluation_scope": EvaluationScope.TOOL_INTERACTIONS,
            "requested_evaluation_scope": EvaluationScope.FULL_EXECUTION,
            "selected_tool_ids": ["search_orders", "issue_refund"],
            "requested_target_provenance": {"agent": "checkout"},
            "resolved_target_provenance": {"agent": "checkout", "revision": "7"},
            "observed_target_provenance": {"agent": "checkout", "revision": "7"},
            "target_version_id": "tv-checkout-7",
            "gate_policy_id": "gate-release",
            "gate_policy_version": "1.2",
        }
    )
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    run = EvaluationEngine(judge=MockJudge()).execute(contract, rows)
    await store.save_run(run, rows)

    await store.attach_run_to_experiment_workspace(
        workspace.experiment_id, run, tenant_id="tenant-a"
    )

    stamped = await store.get_experiment(workspace.experiment_id, "tenant-a")
    assert stamped is not None
    for field in EXPERIMENT_CONTRACT_FIELDS:
        assert getattr(stamped, field) == getattr(run.experiment, field), field
    # The two fields a partial stamp silently invented.
    assert stamped.evaluation_scope == EvaluationScope.TOOL_INTERACTIONS
    assert stamped.selected_tool_ids == ["search_orders", "issue_refund"]
    assert stamped.project_id == "project-checkout"
    # Governance stays the workspace's own; only the contract is stamped.
    assert stamped.name == "Pre-run workspace"
    assert stamped.tags.get("pending_first_run") is None
