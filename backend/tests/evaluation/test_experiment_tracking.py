"""Experiment tracking MVP — history, versions, promote, compare, decisions."""

import asyncio
from uuid import uuid4

import pytest
from sqlalchemy import event, select, update

from proofgrove.db.models import AuditEventORM, EvaluationRunORM, ExperimentDecisionORM, ExperimentORM, ExperimentRunLinkORM
from proofgrove.db.session import async_session
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.sample_data import SAMPLE_TENANT_ID
from proofgrove.platform import authz
from proofgrove.platform.contracts import ReleaseGatePolicyVersion
from proofgrove.runs_worker import process_one_job
from proofgrove.settings import settings
from tests.conftest import act_as

# Tenant used when a test reads a run back through the tenant-scoped endpoints.
#: Most tests here seed from the sample experiment, which belongs to the
#: sample tenant; the client acts as that one and switches where a test uses
#: its own workspace tenant.
TENANT = "tenant-sample"


def _seed_experiment(client, experiment_id: str = "exp-track-1", **extra):
    body = {
        "experiment_id": experiment_id,
        "name": "Risk Advisor release evaluation",
        "dataset_version": "risk_v1",
        "target_endpoint": "tenant/risk-advisor",
        "scenario": "agentic",
        "domain": "risk",
        "objective": "Verify grounding and safety before release.",
        "hypothesis": "New prompt improves grounding.",
        "owner": "evalai-data-squad",
        "product_id": "risk-advisor",
        "target_id": "risk-advisor-agent",
        "target_version": "prompt-v7",
        "environment": "dev",
        "tags": {"engagement": "santander-gqef"},
        # Owned on purpose: an experiment created without a tenant belongs to
        # nobody, and nothing that belongs to nobody should be reachable.
        "tenant_id": TENANT,
        **extra,
    }
    resp = client.post("/evaluation/experiments", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _run_sample(
    client,
    experiment_id: str = "exp-llm-core-v1",
    tenant_id: str | None = None,
    **params,
):
    """Use a known sample experiment so rows exist without seeding."""
    q = "&".join(f"{k}={v}" for k, v in params.items())
    path = f"/evaluation/runs?{q}" if q else "/evaluation/runs"
    resp = client.post(
        path,
        json={
            "experiment_id": experiment_id,
            "name": "LLM Core",
            "dataset_version": "general_qa_v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "row_count": 2,
            "objective": "Track quality over time",
            "owner": "tester",
            "tenant_id": tenant_id,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _tenant_experiment(
    client,
    experiment_id: str,
    *,
    tenant_id: str = "tenant-workspace",
    sample_experiment_id: str = "exp-llm-core-v1",
    **extra,
):
    # Create/rows now require the caller to be authorized for the body's
    # tenant, so present that identity before either call rather than relying
    # on whatever tenant the client happened to be acting as already.
    act_as(client, tenant_id)
    samples = client.get("/evaluation/sample-experiments").json()
    source = next(
        experiment
        for experiment in samples
        if experiment["experiment_id"] == sample_experiment_id
    )
    body = {
        **source,
        "experiment_id": experiment_id,
        "tenant_id": tenant_id,
        "name": f"{source['name']} tenant fixture",
        **extra,
    }
    created = client.post("/evaluation/experiments", json=body)
    assert created.status_code == 201, created.text
    rows = client.get(
        f"/evaluation/experiments/{sample_experiment_id}/rows"
    ).json()
    rows = [
        {**row, "row_id": f"{experiment_id}-{row['row_id']}"}
        for row in rows
    ]
    added = client.post(f"/evaluation/experiments/{experiment_id}/rows", json=rows)
    assert added.status_code == 201, added.text
    return body


def _run_definition(client, experiment: dict, correlation_id: str):
    response = client.post(
        f"/evaluation/runs?correlation_id={correlation_id}", json=experiment
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_create_experiment_with_governance_fields(client):
    data = _seed_experiment(client)
    assert data["objective"]
    assert data["hypothesis"]
    assert data["owner"] == "evalai-data-squad"
    assert data["status"] == "active"
    assert data["tags"]["engagement"] == "santander-gqef"
    assert data["target_version"] == "prompt-v7"


def test_patch_and_archive_experiment(client):
    _seed_experiment(client, "exp-patch-1")
    patched = client.patch(
        "/evaluation/experiments/exp-patch-1",
        json={"status": "paused", "owner": "new-owner"},
    )
    assert patched.status_code == 200
    assert patched.json()["status"] == "paused"
    assert patched.json()["owner"] == "new-owner"

    archived = client.post("/evaluation/experiments/exp-patch-1/archive")
    assert archived.status_code == 200
    assert archived.json()["status"] == "archived"


def test_patch_cannot_forge_approval_via_evaluation_run_permission(client, monkeypatch):
    """PATCH is not a side door around the decision flow's approver-role gate.

    A caller who can only ``evaluation.run`` (the base permission PATCH needs)
    must not be able to set ``status=approved`` directly -- approval must go
    through POST .../decisions, which separately requires the approver role
    and release_eligibility.
    """
    experiment = _tenant_experiment(
        client,
        f"exp-patch-approve-{uuid4().hex[:8]}",
        tenant_id=TENANT,
        quality_profile_id="qp-release",
        gate_policy_id="gate-default",
    )
    run = _run_definition(client, experiment, "patch-approve-1")
    exp_id = run["experiment"]["experiment_id"]

    previous_auth_required = settings.platform_auth_required
    settings.platform_auth_required = True
    try:
        async def _run_only(request, permission):
            request.state.proofgrove_permissions = {
                authz.PERMISSION_EVALUATION_RUN,
                authz.PERMISSION_EVALUATION_READ,
            }
            return permission in (authz.PERMISSION_EVALUATION_RUN, authz.PERMISSION_EVALUATION_READ)

        monkeypatch.setattr(authz, "check_permission", _run_only)

        patched = client.patch(f"/evaluation/experiments/{exp_id}", json={"status": "approved"})
        assert patched.status_code == 422, patched.text
        assert patched.json()["detail"]["code"] == "reserved_experiment_status"

        stored = client.get(f"/evaluation/experiments/{exp_id}")
        assert stored.status_code == 200, stored.text
        assert stored.json()["status"] != "approved"

        # The real decision route, with the approver permission granted, still
        # works -- the fix restricts PATCH, not release governance itself.
        async def _mark_complete_capture() -> None:
            async with async_session() as session:
                await session.execute(
                    update(EvaluationRunORM)
                    .where(EvaluationRunORM.run_id == run["run_id"])
                    .values(
                        verdict_status="conclusive",
                        overall_gate="pass",
                        evidence_capture_status="complete",
                        evidence_categories=[
                            {
                                "category": "final_output",
                                "required": True,
                                "status": "captured",
                                "record_count": 1,
                                "completeness_attested": True,
                                "provenance_status": "attested",
                            }
                        ],
                    )
                )
                await session.commit()

        asyncio.run(_mark_complete_capture())

        async def _approver(request, permission):
            request.state.proofgrove_permissions = {
                authz.PERMISSION_EVALUATION_RUN,
                authz.PERMISSION_GOVERNANCE_APPROVE,
            }
            return True

        monkeypatch.setattr(authz, "check_permission", _approver)

        decision = client.post(
            f"/evaluation/experiments/{exp_id}/decisions",
            json={
                "run_id": run["run_id"],
                "decision": "approved",
                "approved_by": "risk-governance",
            },
        )
        assert decision.status_code == 201, decision.text
    finally:
        settings.platform_auth_required = previous_auth_required


def test_create_experiment_cannot_forge_approval_via_evaluation_run_permission(client, monkeypatch):
    """POST /experiments and POST /runs are not side doors around PATCH's gate.

    Same forgery as PATCH, reached at creation instead of edit: a caller with
    only ``evaluation.run`` must not be able to persist ``status=approved``
    directly, whether the experiment is created via ``/experiments`` or
    implicitly by a first-time ``/runs`` submission (``EvaluationStore.save_run``
    persists a not-yet-existing run's ``experiment.status`` verbatim).
    """
    previous_auth_required = settings.platform_auth_required
    settings.platform_auth_required = True
    try:
        async def _run_only(request, permission):
            request.state.proofgrove_permissions = {
                authz.PERMISSION_EVALUATION_RUN,
                authz.PERMISSION_EVALUATION_READ,
            }
            return permission in (authz.PERMISSION_EVALUATION_RUN, authz.PERMISSION_EVALUATION_READ)

        monkeypatch.setattr(authz, "check_permission", _run_only)

        exp_id = f"exp-create-approve-{uuid4().hex[:8]}"
        forged = client.post(
            "/evaluation/experiments",
            json={
                "experiment_id": exp_id,
                "name": "Forged on create",
                "dataset_version": "risk_v1",
                "target_endpoint": "tenant/risk-advisor",
                "scenario": "agentic",
                "tenant_id": TENANT,
                "status": "approved",
            },
        )
        assert forged.status_code == 422, forged.text
        assert forged.json()["detail"]["code"] == "reserved_experiment_status"

        # Nothing persisted at all -- not even a draft under this id.
        missing = client.get(f"/evaluation/experiments/{exp_id}")
        assert missing.status_code == 404, missing.text

        # Default/draft creation (no status field) is unaffected.
        draft_id = f"exp-create-draft-{uuid4().hex[:8]}"
        draft = client.post(
            "/evaluation/experiments",
            json={
                "experiment_id": draft_id,
                "name": "Untouched draft",
                "dataset_version": "risk_v1",
                "target_endpoint": "tenant/risk-advisor",
                "scenario": "agentic",
                "tenant_id": TENANT,
            },
        )
        assert draft.status_code == 201, draft.text
        assert draft.json()["status"] == "active"

        # Same field, same forgery, through the run-creation path instead: a
        # run body for an experiment_id that does not exist yet is what
        # persists that experiment's row on first save.
        forged_run = client.post(
            "/evaluation/runs",
            json={
                "experiment_id": f"exp-create-run-approve-{uuid4().hex[:8]}",
                "name": "Forged run create",
                "dataset_version": "risk_v1",
                "target_endpoint": "tenant/risk-advisor",
                "scenario": "agentic",
                "tenant_id": TENANT,
                "status": "approved",
            },
        )
        assert forged_run.status_code == 422, forged_run.text
        assert forged_run.json()["detail"]["code"] == "reserved_experiment_status"
    finally:
        settings.platform_auth_required = previous_auth_required

    # The real decision route, unaffected: with the approver permission it
    # still approves normally end to end.
    experiment = _tenant_experiment(
        client,
        f"exp-create-approve-real-{uuid4().hex[:8]}",
        tenant_id=TENANT,
        quality_profile_id="qp-release",
        gate_policy_id="gate-default",
    )
    run = _run_definition(client, experiment, "create-approve-real-1")
    exp_id = run["experiment"]["experiment_id"]
    _mark_run_release_ready(run["run_id"])

    settings.platform_auth_required = True
    try:
        async def _approver(request, permission):
            request.state.proofgrove_permissions = {
                authz.PERMISSION_EVALUATION_RUN,
                authz.PERMISSION_GOVERNANCE_APPROVE,
            }
            return True

        monkeypatch.setattr(authz, "check_permission", _approver)

        decision = client.post(
            f"/evaluation/experiments/{exp_id}/decisions",
            json={
                "run_id": run["run_id"],
                "decision": "approved",
                "approved_by": "risk-governance",
            },
        )
        assert decision.status_code == 201, decision.text
    finally:
        settings.platform_auth_required = previous_auth_required


def test_multi_run_history_and_run_number(client):
    r1 = _run_sample(client, correlation_id="c1")
    r2 = _run_sample(client, correlation_id="c2")
    exp_id = r1["experiment"]["experiment_id"]

    history = client.get(f"/evaluation/experiments/{exp_id}/runs")
    assert history.status_code == 200
    runs = history.json()
    assert len(runs) >= 2
    numbers = sorted(r["run_number"] for r in runs if r["run_number"] is not None)
    assert numbers == list(range(1, len(numbers) + 1))

    summary = client.get(f"/evaluation/experiments/{exp_id}/summary")
    assert summary.status_code == 200
    body = summary.json()
    assert body["run_count"] >= 2
    assert body["latest_run_id"] in {r1["run_id"], r2["run_id"]}
    assert body["latest_gate"] is None
    assert r1["verdict_status"] == "inconclusive"
    assert r2["verdict_status"] == "inconclusive"


def test_version_persisted_on_run(client):
    run = _run_sample(client)
    exp_id = run["experiment"]["experiment_id"]
    assert run["experiment_version_id"]

    versions = client.get(f"/evaluation/experiments/{exp_id}/versions")
    assert versions.status_code == 200
    ids = [v["experiment_version_id"] for v in versions.json()]
    assert run["experiment_version_id"] in ids


def test_promote_champion_and_compare(client):
    r1 = _run_sample(client, correlation_id="cmp-1")
    r2 = _run_sample(client, correlation_id="cmp-2")
    exp_id = r1["experiment"]["experiment_id"]

    promote = client.post(
        f"/evaluation/experiments/{exp_id}/runs/{r1['run_id']}/promote",
        json={"role": "champion"},
    )
    assert promote.status_code == 200
    assert promote.json()["role"] == "champion"

    # Second promote demotes the first champion.
    promote2 = client.post(
        f"/evaluation/experiments/{exp_id}/runs/{r2['run_id']}/promote",
        json={"role": "champion"},
    )
    assert promote2.status_code == 200
    assert promote2.json()["role"] == "champion"

    summary = client.get(f"/evaluation/experiments/{exp_id}/summary").json()
    assert summary["champion_run_id"] == r2["run_id"]

    compare = client.get(
        f"/evaluation/experiments/{exp_id}/compare"
        f"?base_run_id={r1['run_id']}&candidate_run_id={r2['run_id']}"
        f"&tenant_id={SAMPLE_TENANT_ID}"
    )
    assert compare.status_code == 200
    body = compare.json()
    assert body["base_run_id"] == r1["run_id"]
    assert body["candidate_run_id"] == r2["run_id"]
    assert "kpi_deltas" in body
    assert "sample_deltas" in body
    assert set(body["sample_counts"]) == {"improved", "regressed", "same", "unavailable"}
    assert "quality_delta" in body
    assert "latency_delta_percent" in body
    assert set(body["metric_failures"]) == {"new", "fixed", "persistent"}

    filtered = client.get(
        f"/evaluation/experiments/{exp_id}/compare"
        f"?base_run_id={r1['run_id']}&candidate_run_id={r2['run_id']}"
        f"&metric_id=llm.correctness&tenant_id={SAMPLE_TENANT_ID}"
    )
    assert filtered.status_code == 200, filtered.text
    assert "sample_deltas" in filtered.json()


def test_promote_release_evidence_enforces_the_same_gate_as_decisions(client, monkeypatch):
    """RELEASE_EVIDENCE via /promote must clear the same bar as /decisions.

    /promote is a generic role-assignment endpoint; without this check it is
    a side door that lets an ungoverned or ineligible run become release
    evidence without ever going through the approver-role + release-
    eligibility checks the decision endpoint enforces.
    """
    ungoverned_experiment = _tenant_experiment(
        client, f"exp-promote-ungoverned-{uuid4().hex[:8]}", tenant_id=TENANT
    )
    ungoverned_run = _run_definition(client, ungoverned_experiment, "promote-ungoverned")
    exp_id = ungoverned_run["experiment"]["experiment_id"]
    assert ungoverned_run["quality_profile_id"] is None

    ungoverned = client.post(
        f"/evaluation/experiments/{exp_id}/runs/{ungoverned_run['run_id']}/promote",
        json={"role": "release_evidence"},
    )
    assert ungoverned.status_code == 409, ungoverned.text
    assert ungoverned.json()["detail"]["code"] == "run_not_governed"

    governed_experiment = _tenant_experiment(
        client,
        f"exp-promote-governed-{uuid4().hex[:8]}",
        tenant_id=TENANT,
        quality_profile_id="qp-release",
        gate_policy_id="gate-default",
    )
    governed_run = _run_definition(client, governed_experiment, "promote-governed")
    governed_exp_id = governed_run["experiment"]["experiment_id"]
    _mark_run_release_ready(governed_run["run_id"])

    previous_auth_required = settings.platform_auth_required
    settings.platform_auth_required = True
    try:
        async def _no_approver(request, permission):
            request.state.proofgrove_permissions = set()
            return False

        monkeypatch.setattr(authz, "check_permission", _no_approver)

        denied = client.post(
            f"/evaluation/experiments/{governed_exp_id}/runs/{governed_run['run_id']}/promote",
            json={"role": "release_evidence"},
        )
        assert denied.status_code == 403, denied.text

        async def _approver(request, permission):
            request.state.proofgrove_permissions = {authz.PERMISSION_GOVERNANCE_APPROVE}
            return permission == authz.PERMISSION_GOVERNANCE_APPROVE

        monkeypatch.setattr(authz, "check_permission", _approver)

        promoted = client.post(
            f"/evaluation/experiments/{governed_exp_id}/runs/{governed_run['run_id']}/promote",
            json={"role": "release_evidence"},
        )
        assert promoted.status_code == 200, promoted.text
        assert promoted.json()["role"] == "release_evidence"
    finally:
        settings.platform_auth_required = previous_auth_required

    # A non-release role is unaffected by the added gate.
    champion = client.post(
        f"/evaluation/experiments/{exp_id}/runs/{ungoverned_run['run_id']}/promote",
        json={"role": "champion"},
    )
    assert champion.status_code == 200, champion.text


def test_promote_release_evidence_requires_the_configured_approver_role(client, monkeypatch):
    """The 403 comes from the new check, not from /promote's own middleware gate.

    /promote already requires ``governance.approve`` at the middleware layer
    (see ``permission_for_request``'s governance markers), so a stub that
    revokes every permission can pass through that gate refusing and never
    exercise the handler's own ``require_configured_approver_roles`` call. This
    seeds a gate policy with a role OTHER than the default
    (``proofgrove-reviewer`` -> ``governance.review``) so a caller holding
    ``governance.approve`` (middleware passes) but not ``governance.review``
    (the run's configured role) is refused specifically by the new check.
    """
    gate_policy_id = f"gate-reviewer-role-{uuid4().hex[:8]}"

    async def _seed_gate_policy() -> None:
        async with async_session() as session:
            store = EvaluationStore(session)
            await store.save_gate_policy(
                ReleaseGatePolicyVersion(
                    gate_policy_id=gate_policy_id,
                    version="1",
                    tenant_id=TENANT,
                    name="Reviewer-gated release",
                    required_approver_roles=["proofgrove-reviewer"],
                )
            )

    asyncio.run(_seed_gate_policy())

    experiment = _tenant_experiment(
        client,
        f"exp-promote-reviewer-role-{uuid4().hex[:8]}",
        tenant_id=TENANT,
        quality_profile_id="qp-release",
        gate_policy_id=gate_policy_id,
        gate_policy_version="1",
    )
    run = _run_definition(client, experiment, "promote-reviewer-role-1")
    exp_id = run["experiment"]["experiment_id"]
    assert run["gate_policy_id"] == gate_policy_id
    assert run["gate_policy_version"] == "1"
    _mark_run_release_ready(run["run_id"])

    async def _link_role() -> str | None:
        async with async_session() as session:
            from proofgrove.db.models import ExperimentRunLinkORM

            link = await session.get(ExperimentRunLinkORM, (exp_id, run["run_id"]))
            return link.role if link else None

    previous_auth_required = settings.platform_auth_required
    settings.platform_auth_required = True
    try:
        # Holds the middleware's own required permission (governance.approve)
        # but not the run's configured role (governance.review) -- proves the
        # 403 comes from require_configured_approver_roles, not the middleware.
        async def _wrong_role(request, permission):
            request.state.proofgrove_permissions = {authz.PERMISSION_GOVERNANCE_APPROVE}
            return permission == authz.PERMISSION_GOVERNANCE_APPROVE

        monkeypatch.setattr(authz, "check_permission", _wrong_role)

        denied = client.post(
            f"/evaluation/experiments/{exp_id}/runs/{run['run_id']}/promote",
            json={"role": "release_evidence"},
        )
        assert denied.status_code == 403, denied.text
        assert asyncio.run(_link_role()) != "release_evidence"

        async def _reviewer(request, permission):
            request.state.proofgrove_permissions = {
                authz.PERMISSION_GOVERNANCE_APPROVE,
                authz.PERMISSION_GOVERNANCE_REVIEW,
            }
            return True

        monkeypatch.setattr(authz, "check_permission", _reviewer)

        promoted = client.post(
            f"/evaluation/experiments/{exp_id}/runs/{run['run_id']}/promote",
            json={"role": "release_evidence"},
        )
        assert promoted.status_code == 200, promoted.text
        assert promoted.json()["role"] == "release_evidence"
        assert asyncio.run(_link_role()) == "release_evidence"

        async def _audit_events() -> list:
            async with async_session() as session:
                store = EvaluationStore(session)
                return await store.list_audit_events(tenant_id=TENANT)

        events = asyncio.run(_audit_events())
        assert any(
            e.action == "experiment.release_evidence_promoted"
            and e.resource_id == exp_id
            and e.details.get("run_id") == run["run_id"]
            for e in events
        )
    finally:
        settings.platform_auth_required = previous_auth_required


def test_compare_does_not_infer_basis_across_different_evaluation_ids(client):
    base = _run_sample(client, correlation_id="historical-base")
    base_experiment = base["experiment"]
    base_experiment_id = base_experiment["experiment_id"]
    rows = client.get(f"/evaluation/experiments/{base_experiment_id}/rows").json()

    historical_experiment = {
        **base_experiment,
        "experiment_id": "exp-historical-copy",
    }
    created = client.post("/evaluation/experiments", json=historical_experiment)
    assert created.status_code == 201, created.text
    added = client.post(
        "/evaluation/experiments/exp-historical-copy/rows",
        json=rows,
    )
    assert added.status_code == 201, added.text

    candidate_response = client.post(
        "/evaluation/runs?correlation_id=historical-candidate",
        json=historical_experiment,
    )
    assert candidate_response.status_code == 201, candidate_response.text
    candidate = candidate_response.json()
    assert candidate["experiment_version_id"] == base["experiment_version_id"]

    comparison = client.get(
        f"/evaluation/experiments/{base_experiment_id}/compare"
        f"?base_run_id={base['run_id']}&candidate_run_id={candidate['run_id']}"
        f"&tenant_id={SAMPLE_TENANT_ID}"
    )
    assert comparison.status_code == 404
    assert "not found for experiment" in comparison.json()["detail"]


def test_create_experiment_workspace_from_compatible_historical_runs(client):
    experiment = _tenant_experiment(client, "exp-workspace-source")
    first = _run_definition(client, experiment, "workspace-1")
    second = _run_definition(client, experiment, "workspace-2")

    act_as(client, "tenant-workspace")
    created = client.post(
        "/evaluation/experiments/from-runs",
        json={
            "tenant_id": "tenant-workspace",
            "name": "Prompt iteration",
            "objective": "Compare prompt variants",
            "hypothesis": "The candidate improves groundedness",
            "run_ids": [first["run_id"], second["run_id"]],
            "baseline_run_id": first["run_id"],
        },
    )
    assert created.status_code == 201, created.text
    summary = created.json()
    workspace_id = summary["experiment"]["experiment_id"]
    assert summary["experiment"]["tags"]["workspace_kind"] == "experiment"
    assert summary["baseline_run_id"] == first["run_id"]
    assert summary["run_count"] == 2

    act_as(client, "tenant-workspace")
    listed = client.get(
        "/evaluation/experiments/workspaces?tenant_id=tenant-workspace"
    )
    assert listed.status_code == 200, listed.text
    assert [item["experiment"]["experiment_id"] for item in listed.json()] == [
        workspace_id
    ]

    history = client.get(f"/evaluation/experiments/{workspace_id}/runs")
    assert history.status_code == 200, history.text
    assert {run["run_id"] for run in history.json()} == {
        first["run_id"],
        second["run_id"],
    }

    act_as(client, "tenant-workspace")
    comparison = client.get(
        f"/evaluation/experiments/{workspace_id}/compare"
        f"?base_run_id={first['run_id']}&candidate_run_id={second['run_id']}"
        "&tenant_id=tenant-workspace"
    )
    assert comparison.status_code == 200, comparison.text


def test_experiment_workspace_rejects_a_different_comparison_basis(client):
    first_experiment = _tenant_experiment(client, "exp-workspace-basis-1")
    second_experiment = _tenant_experiment(
        client,
        "exp-workspace-basis-2",
        sample_experiment_id="exp-rag-v1",
    )
    first = _run_definition(client, first_experiment, "basis-1")
    different = _run_definition(client, second_experiment, "basis-2")
    act_as(client, "tenant-workspace")
    response = client.post(
        "/evaluation/experiments/from-runs",
        json={
            "tenant_id": "tenant-workspace",
            "name": "Invalid comparison",
            "run_ids": [first["run_id"], different["run_id"]],
            "baseline_run_id": first["run_id"],
        },
    )
    assert response.status_code == 409
    assert "does not share" in response.json()["detail"]


def test_attach_runs_returns_structured_per_run_incompatibility(client):
    first_experiment = _tenant_experiment(client, "exp-attach-basis-1")
    second_experiment = _tenant_experiment(
        client,
        "exp-attach-basis-2",
        sample_experiment_id="exp-rag-v1",
    )
    baseline = _run_definition(client, first_experiment, "attach-base")
    compatible = _run_definition(client, first_experiment, "attach-ok")
    incompatible = _run_definition(client, second_experiment, "attach-bad")
    act_as(client, "tenant-workspace")
    created = client.post(
        "/evaluation/experiments/from-runs",
        json={
            "tenant_id": "tenant-workspace",
            "name": "Attach target",
            "run_ids": [baseline["run_id"], compatible["run_id"]],
            "baseline_run_id": baseline["run_id"],
        },
        headers={"x-evalai-tenant": "tenant-workspace"},
    )
    assert created.status_code == 201, created.text
    workspace_id = created.json()["experiment"]["experiment_id"]

    act_as(client, "tenant-workspace")
    denied = client.post(
        f"/evaluation/experiments/{workspace_id}/runs/attach",
        json={
            "tenant_id": "tenant-workspace",
            "run_ids": [incompatible["run_id"]],
        },
        headers={"x-evalai-tenant": "tenant-workspace"},
    )
    assert denied.status_code == 422, denied.text
    detail = denied.json()["detail"]
    assert detail["code"] == "experiment_runs_incompatible"
    assert detail["message"]
    assert len(detail["details"]) == 1
    failure = detail["details"][0]
    assert failure["code"] == "comparison_basis_mismatch"
    assert failure["field"] == incompatible["run_id"]
    assert incompatible["run_id"] in failure["message"]


def test_decision_approves_and_marks_release_evidence(client):
    # Use a unique tenant-scoped experiment (not the shared sample) so the run
    # is readable through the tenant-scoped report endpoint. The experiment is
    # governed (quality profile + gate policy) so its run is release-eligible.
    experiment = _tenant_experiment(
        client,
        f"exp-decision-{uuid4().hex[:8]}",
        tenant_id=TENANT,
        quality_profile_id="qp-release",
        gate_policy_id="gate-default",
    )
    run = _run_definition(client, experiment, "decision-1")
    exp_id = run["experiment"]["experiment_id"]
    assert run["verdict_status"] == "inconclusive"
    assert run["quality_profile_id"] == "qp-release"
    assert run["gate_policy_id"] == "gate-default"

    # A release decision requires confirmed complete capture. This endpoint does
    # not classify evidence, so the run is stamped with what a classified run
    # would carry; without it the decision is refused, which
    # ``test_decision_rejects_run_whose_evidence_was_never_examined`` asserts.
    async def _mark_complete_capture() -> None:
        async with async_session() as session:
            await session.execute(
                update(EvaluationRunORM)
                .where(EvaluationRunORM.run_id == run["run_id"])
                .values(
                    verdict_status="conclusive",
                    overall_gate="pass",
                    evidence_capture_status="complete",
                    evidence_categories=[
                        {
                            "category": "final_output",
                            "required": True,
                            "status": "captured",
                            "record_count": 1,
                            "completeness_attested": True,
                            "provenance_status": "attested",
                        }
                    ],
                )
            )
            await session.commit()

    asyncio.run(_mark_complete_capture())

    decision = client.post(
        f"/evaluation/experiments/{exp_id}/decisions",
        json={
            "run_id": run["run_id"],
            "decision": "approved",
            "approved_by": "risk-governance",
            "reason": "Meets release bar",
        },
    )
    assert decision.status_code == 201, decision.text
    assert decision.json()["decision"] == "approved"

    summary = client.get(f"/evaluation/experiments/{exp_id}/summary").json()
    assert summary["experiment"]["status"] == "approved"
    assert summary["release_evidence_run_id"] == run["run_id"]
    assert summary["latest_decision"]["approved_by"] == "risk-governance"

    report = client.get(f"/evaluation/runs/{run['run_id']}/report?tenant_id={TENANT}").json()
    assert report["decision"]["decision"] == "approved"
    assert report["run_number"] is not None
    assert "report://" in (report.get("artifact_refs") or [""])[0]


def test_decision_rejects_ungoverned_run(client):
    # A run without a resolved quality profile / gate policy in its lineage is
    # not governed and can never receive a release decision.
    experiment = _tenant_experiment(
        client, f"exp-decision-ungov-{uuid4().hex[:8]}", tenant_id=TENANT
    )
    run = _run_definition(client, experiment, "decision-ungoverned")
    exp_id = run["experiment"]["experiment_id"]
    assert run["quality_profile_id"] is None

    decision = client.post(
        f"/evaluation/experiments/{exp_id}/decisions",
        json={
            "run_id": run["run_id"],
            "decision": "approved",
            "approved_by": "risk-governance",
        },
    )
    assert decision.status_code == 409, decision.text
    assert decision.json()["detail"]["code"] == "run_not_governed"


def test_decision_rejects_diagnostic_only_run(client):
    # A diagnostic rescore is never release evidence, even on a governed
    # experiment.
    experiment = _tenant_experiment(
        client,
        f"exp-decision-diag-{uuid4().hex[:8]}",
        tenant_id=TENANT,
        quality_profile_id="qp-release",
        gate_policy_id="gate-default",
    )
    source = _run_definition(client, experiment, "decision-diag-source")
    exp_id = source["experiment"]["experiment_id"]

    rescore = client.post(
        f"/evaluation/experiments/{exp_id}/rescores",
        json={"source_run_id": source["run_id"], "created_by": "ci"},
    )
    assert rescore.status_code == 202, rescore.text
    assert asyncio.run(process_one_job()) is True
    diagnostic_run_id = rescore.json()["run_id"]
    diagnostic = client.get(
        f"/evaluation/runs/{diagnostic_run_id}?tenant_id={TENANT}"
    ).json()
    assert diagnostic["diagnostic_only"] is True

    decision = client.post(
        f"/evaluation/experiments/{exp_id}/decisions",
        json={
            "run_id": diagnostic_run_id,
            "decision": "approved",
            "approved_by": "risk-governance",
        },
    )
    assert decision.status_code == 409, decision.text
    assert decision.json()["detail"]["code"] == "diagnostic_run_not_releasable"


def test_decision_rejects_inconclusive_run(client):
    experiment = _tenant_experiment(
        client,
        f"exp-decision-inconc-{uuid4().hex[:8]}",
        tenant_id=TENANT,
        quality_profile_id="qp-release",
        gate_policy_id="gate-default",
    )
    run = _run_definition(client, experiment, "decision-inconclusive")
    exp_id = run["experiment"]["experiment_id"]

    async def _mark_inconclusive() -> None:
        async with async_session() as session:
            await session.execute(
                update(EvaluationRunORM)
                .where(EvaluationRunORM.run_id == run["run_id"])
                .values(verdict_status="inconclusive")
            )
            await session.commit()

    asyncio.run(_mark_inconclusive())

    decision = client.post(
        f"/evaluation/experiments/{exp_id}/decisions",
        json={
            "run_id": run["run_id"],
            "decision": "approved",
            "approved_by": "risk-governance",
        },
    )
    assert decision.status_code == 409, decision.text
    assert decision.json()["detail"]["code"] == "verdict_not_conclusive"


def test_decision_rejects_run_with_missing_required_evidence(client):
    experiment = _tenant_experiment(
        client,
        f"exp-decision-evid-{uuid4().hex[:8]}",
        tenant_id=TENANT,
        quality_profile_id="qp-release",
        gate_policy_id="gate-default",
    )
    run = _run_definition(client, experiment, "decision-evidence")
    exp_id = run["experiment"]["experiment_id"]

    async def _mark_partial_capture() -> None:
        async with async_session() as session:
            await session.execute(
                update(EvaluationRunORM)
                .where(EvaluationRunORM.run_id == run["run_id"])
                .values(
                    verdict_status="conclusive",
                    overall_gate="pass",
                    evidence_capture_status="partial",
                    evidence_categories=[
                        {
                            "category": "final_output",
                            "required": True,
                            "status": "partial",
                            "record_count": 1,
                            "completeness_attested": False,
                            "provenance_status": "attested",
                        }
                    ],
                )
            )
            await session.commit()

    asyncio.run(_mark_partial_capture())

    decision = client.post(
        f"/evaluation/experiments/{exp_id}/decisions",
        json={
            "run_id": run["run_id"],
            "decision": "approved",
            "approved_by": "risk-governance",
        },
    )
    assert decision.status_code == 409, decision.text
    assert decision.json()["detail"]["code"] == "evidence_incomplete"


def test_decision_rejects_run_whose_evidence_was_never_examined(client):
    """An empty evidence record is unexamined, not clean.

    The gate used to refuse only when it could name a missing category, so a run
    that never classified its evidence — carrying UNKNOWN and no categories —
    had nothing to name and was released on evidence no one had looked at.
    """

    experiment = _tenant_experiment(
        client,
        f"exp-decision-unexamined-{uuid4().hex[:8]}",
        tenant_id=TENANT,
        quality_profile_id="qp-release",
        gate_policy_id="gate-default",
    )
    run = _run_definition(client, experiment, "decision-unexamined")
    exp_id = run["experiment"]["experiment_id"]
    assert run["verdict_status"] == "inconclusive"
    assert run["evidence_capture_status"] == "unknown"
    assert run["evidence_categories"] == []

    async def _mark_conclusive() -> None:
        async with async_session() as session:
            await session.execute(
                update(EvaluationRunORM)
                .where(EvaluationRunORM.run_id == run["run_id"])
                .values(verdict_status="conclusive", overall_gate="pass")
            )
            await session.commit()

    asyncio.run(_mark_conclusive())

    decision = client.post(
        f"/evaluation/experiments/{exp_id}/decisions",
        json={
            "run_id": run["run_id"],
            "decision": "approved",
            "approved_by": "risk-governance",
        },
    )
    assert decision.status_code == 409, decision.text
    assert decision.json()["detail"]["code"] == "evidence_incomplete"


def _mark_run_release_ready(run_id: str) -> None:
    """Stamp a run with the complete-capture evidence a release decision needs.

    Mirrors ``test_decision_approves_and_marks_release_evidence``'s inline
    fixture -- factored out so tests that only need "this run is eligible"
    (not the decision-endpoint behaviour itself) can reuse it.
    """

    async def _mark() -> None:
        async with async_session() as session:
            await session.execute(
                update(EvaluationRunORM)
                .where(EvaluationRunORM.run_id == run_id)
                .values(
                    verdict_status="conclusive",
                    overall_gate="pass",
                    evidence_capture_status="complete",
                    evidence_categories=[
                        {
                            "category": "final_output",
                            "required": True,
                            "status": "captured",
                            "record_count": 1,
                            "completeness_attested": True,
                            "provenance_status": "attested",
                        }
                    ],
                )
            )
            await session.commit()

    asyncio.run(_mark())


def test_decision_approves_a_run_linked_via_from_runs_workspace(client):
    """A run keeps its ORIGINAL experiment_id after being linked elsewhere.

    ``/experiments/from-runs`` records the new membership in the
    experiment-run link table; it never rewrites the run's own
    ``experiment_id``. The decision endpoint must gate on that link table, not
    the run's own field, or every run approved through a from-runs/attach
    workspace 404s forever.
    """
    experiment = _tenant_experiment(
        client,
        f"exp-decision-source-{uuid4().hex[:8]}",
        tenant_id=TENANT,
        quality_profile_id="qp-release",
        gate_policy_id="gate-default",
    )
    run = _run_definition(client, experiment, "decision-linked-1")
    original_exp_id = run["experiment"]["experiment_id"]
    _mark_run_release_ready(run["run_id"])

    act_as(client, TENANT)
    workspace = client.post(
        "/evaluation/experiments/from-runs",
        json={
            "tenant_id": TENANT,
            "name": "Linked workspace",
            "run_ids": [run["run_id"]],
            "baseline_run_id": run["run_id"],
        },
    )
    assert workspace.status_code == 201, workspace.text
    workspace_id = workspace.json()["experiment"]["experiment_id"]
    assert workspace_id != original_exp_id

    # The bug: approving against the workspace the run was actually linked
    # into used to 404 because the handler compared the run's ORIGINAL
    # experiment_id instead of checking the link table.
    decision = client.post(
        f"/evaluation/experiments/{workspace_id}/decisions",
        json={
            "run_id": run["run_id"],
            "decision": "approved",
            "approved_by": "risk-governance",
        },
    )
    assert decision.status_code == 201, decision.text
    assert decision.json()["decision"] == "approved"


def test_report_reads_a_linked_workspace_decision_only_when_named(client):
    """The report must not silently pick a decision across workspaces.

    A decision approved through a from-runs workspace is filed under the
    WORKSPACE's experiment_id (fixed above), so the report needs the same
    workspace named explicitly to read it back -- reading the run's own
    experiment_id (today's default, unchanged) will not find it.
    """
    experiment = _tenant_experiment(
        client,
        f"exp-report-source-{uuid4().hex[:8]}",
        tenant_id=TENANT,
        quality_profile_id="qp-release",
        gate_policy_id="gate-default",
    )
    run = _run_definition(client, experiment, "report-linked-1")
    original_exp_id = run["experiment"]["experiment_id"]
    _mark_run_release_ready(run["run_id"])

    act_as(client, TENANT)
    workspace = client.post(
        "/evaluation/experiments/from-runs",
        json={
            "tenant_id": TENANT,
            "name": "Report linked workspace",
            "run_ids": [run["run_id"]],
            "baseline_run_id": run["run_id"],
        },
    )
    assert workspace.status_code == 201, workspace.text
    workspace_id = workspace.json()["experiment"]["experiment_id"]

    decision = client.post(
        f"/evaluation/experiments/{workspace_id}/decisions",
        json={
            "run_id": run["run_id"],
            "decision": "approved",
            "approved_by": "risk-governance",
        },
    )
    assert decision.status_code == 201, decision.text

    # No ``experiment_id`` query: today's original-experiment behaviour is
    # unchanged -- the original experiment has no decision of its own.
    default_report = client.get(f"/evaluation/runs/{run['run_id']}/report?tenant_id={TENANT}")
    assert default_report.status_code == 200, default_report.text
    assert default_report.json()["decision"] is None

    # Naming the workspace explicitly reads its decision.
    workspace_report = client.get(
        f"/evaluation/runs/{run['run_id']}/report?tenant_id={TENANT}&experiment_id={workspace_id}"
    )
    assert workspace_report.status_code == 200, workspace_report.text
    assert workspace_report.json()["decision"]["decision"] == "approved"

    # A foreign/unrelated experiment_id (real experiment, run never linked
    # to it) is refused, not silently ignored.
    unrelated = _tenant_experiment(
        client,
        f"exp-report-unrelated-{uuid4().hex[:8]}",
        tenant_id=TENANT,
    )
    act_as(client, TENANT)
    unrelated_report = client.get(
        f"/evaluation/runs/{run['run_id']}/report?tenant_id={TENANT}&experiment_id={unrelated['experiment_id']}"
    )
    assert unrelated_report.status_code == 404, unrelated_report.text

    # Naming the run's own original experiment still works too.
    original_report = client.get(
        f"/evaluation/runs/{run['run_id']}/report?tenant_id={TENANT}&experiment_id={original_exp_id}"
    )
    assert original_report.status_code == 200, original_report.text
    assert original_report.json()["decision"] is None


def test_decision_rejects_a_run_not_linked_to_the_experiment(client):
    """The membership fix must still 404 a run that was never linked here."""
    workspace_owner = _tenant_experiment(
        client,
        f"exp-decision-owner-{uuid4().hex[:8]}",
        tenant_id=TENANT,
        quality_profile_id="qp-release",
        gate_policy_id="gate-default",
    )
    anchor_run = _run_definition(client, workspace_owner, "decision-anchor")
    _mark_run_release_ready(anchor_run["run_id"])
    act_as(client, TENANT)
    workspace = client.post(
        "/evaluation/experiments/from-runs",
        json={
            "tenant_id": TENANT,
            "name": "Decision membership workspace",
            "run_ids": [anchor_run["run_id"]],
            "baseline_run_id": anchor_run["run_id"],
        },
    )
    assert workspace.status_code == 201, workspace.text
    workspace_id = workspace.json()["experiment"]["experiment_id"]

    # Same-tenant run that was never attached to this workspace.
    unrelated_experiment = _tenant_experiment(
        client,
        f"exp-decision-unrelated-{uuid4().hex[:8]}",
        tenant_id=TENANT,
    )
    unrelated_run = _run_definition(client, unrelated_experiment, "decision-unrelated")
    unrelated = client.post(
        f"/evaluation/experiments/{workspace_id}/decisions",
        json={
            "run_id": unrelated_run["run_id"],
            "decision": "approved",
            "approved_by": "risk-governance",
        },
    )
    assert unrelated.status_code == 404, unrelated.text

    # Foreign-tenant run: never linkable into this tenant's workspace at all.
    foreign_experiment = _tenant_experiment(
        client,
        f"exp-decision-foreign-{uuid4().hex[:8]}",
        tenant_id="tenant-decision-foreign",
    )
    foreign_run = _run_definition(client, foreign_experiment, "decision-foreign")
    act_as(client, TENANT)
    foreign = client.post(
        f"/evaluation/experiments/{workspace_id}/decisions",
        json={
            "run_id": foreign_run["run_id"],
            "decision": "approved",
            "approved_by": "risk-governance",
        },
    )
    assert foreign.status_code == 404, foreign.text

    # The original-experiment run is still linked to its own experiment and
    # still approvable there -- the fix must not regress that path.
    act_as(client, TENANT)
    original = client.post(
        f"/evaluation/experiments/{workspace_owner['experiment_id']}/decisions",
        json={
            "run_id": anchor_run["run_id"],
            "decision": "approved",
            "approved_by": "risk-governance",
        },
    )
    assert original.status_code == 201, original.text


def test_rescore_accepts_a_run_linked_via_from_runs_workspace(client):
    """The rescore endpoint shares the decision endpoint's membership bug.

    Same shared cause as the decision endpoint: ``source.experiment.experiment_id``
    is the run's ORIGINAL experiment, not its from-runs/attach membership.
    """
    experiment = _tenant_experiment(
        client, f"exp-rescore-source-{uuid4().hex[:8]}", tenant_id=TENANT
    )
    run = _run_definition(client, experiment, "rescore-linked-1")

    act_as(client, TENANT)
    workspace = client.post(
        "/evaluation/experiments/from-runs",
        json={
            "tenant_id": TENANT,
            "name": "Rescore linked workspace",
            "run_ids": [run["run_id"]],
            "baseline_run_id": run["run_id"],
        },
    )
    assert workspace.status_code == 201, workspace.text
    workspace_id = workspace.json()["experiment"]["experiment_id"]
    assert workspace_id != experiment["experiment_id"]

    rescore = client.post(
        f"/evaluation/experiments/{workspace_id}/rescores",
        json={"source_run_id": run["run_id"], "created_by": "ci"},
    )
    assert rescore.status_code == 202, rescore.text


def test_saved_experiment_rescore_uses_explicit_source_evidence(client):
    # Seed a source run, then explicitly rescore its immutable evidence.
    experiment = _tenant_experiment(
        client, f"exp-rescore-{uuid4().hex[:8]}", tenant_id=TENANT
    )
    first = _run_definition(client, experiment, "rescore-source")
    exp_id = first["experiment"]["experiment_id"]

    second = client.post(
        f"/evaluation/experiments/{exp_id}/rescores",
        json={"source_run_id": first["run_id"], "created_by": "ci"},
    )
    assert second.status_code == 202, second.text
    assert asyncio.run(process_one_job()) is True
    completed = client.get(f"/evaluation/runs/{second.json()['run_id']}?tenant_id={TENANT}")
    assert completed.status_code == 200, completed.text
    body = completed.json()
    assert body["experiment"]["experiment_id"] == exp_id
    assert body["diagnostic_only"] is True
    assert body["overall_gate"] is None
    assert body["created_by"] == "ci"
    assert body["run_number"] == (first.get("run_number") or 0) + 1


def test_deprecated_run_alias_never_selects_paused_experiment_evidence_implicitly(client):
    run = _run_sample(client)
    exp_id = run["experiment"]["experiment_id"]
    client.patch(f"/evaluation/experiments/{exp_id}", json={"status": "paused"})

    blocked = client.post(
        f"/evaluation/experiments/{exp_id}/runs",
        json={"row_count": 1},
    )
    assert blocked.status_code == 422
    assert "source_run_id is required" in blocked.text


@pytest.mark.parametrize("action", ["decision", "promote"])
def test_release_changes_roll_back_when_audit_insert_fails(client, action):
    experiment = _tenant_experiment(
        client, f"audit-{uuid4().hex[:8]}", tenant_id=TENANT,
        quality_profile_id="qp-release", gate_policy_id="gate-default",
    )
    exp_id = experiment["experiment_id"]
    old_run = _run_definition(client, experiment, "audit-old")
    new_run = _run_definition(client, experiment, "audit-new")
    for run in (old_run, new_run):
        _mark_run_release_ready(run["run_id"])
    base = f"/evaluation/experiments/{exp_id}"
    promoted = client.post(f"{base}/runs/{old_run['run_id']}/promote", json={"role": "release_evidence"})
    assert promoted.status_code == 200

    async def snapshot():
        async with async_session() as session:
            status = await session.scalar(select(ExperimentORM.status).where(ExperimentORM.experiment_id == exp_id))
            links = (await session.execute(select(ExperimentRunLinkORM.run_id, ExperimentRunLinkORM.role).where(ExperimentRunLinkORM.experiment_id == exp_id))).all()
            decisions = (await session.scalars(select(ExperimentDecisionORM.decision_id).where(ExperimentDecisionORM.experiment_id == exp_id))).all()
            audits = (await session.scalars(select(AuditEventORM.audit_event_id).where(AuditEventORM.resource_id == exp_id))).all()
            return status, sorted(links), sorted(decisions), sorted(audits)

    before = asyncio.run(snapshot())
    if action == "decision":
        url, body = f"{base}/decisions", {"run_id": new_run["run_id"], "decision": "approved", "approved_by": "test-reviewer", "reason": "test"}
    else:
        url, body = f"{base}/runs/{new_run['run_id']}/promote", {"role": "release_evidence"}

    def fail_audit(*_args):
        raise RuntimeError("synthetic audit insert failure")

    event.listen(AuditEventORM, "before_insert", fail_audit)
    try:
        with pytest.raises(RuntimeError, match="synthetic audit insert failure"):
            client.post(url, json=body)
    finally:
        event.remove(AuditEventORM, "before_insert", fail_audit)
    assert asyncio.run(snapshot()) == before

    response = client.post(url, json=body)
    assert response.status_code == (201 if action == "decision" else 200), response.text
    after = asyncio.run(snapshot())
    assert dict(after[1])[new_run["run_id"]] == "release_evidence"
    assert dict(after[1])[old_run["run_id"]] == "exploratory"
    assert len(after[3]) == len(before[3]) + 1
    if action == "decision":
        assert after[0] == "approved"
        assert len(after[2]) == len(before[2]) + 1
