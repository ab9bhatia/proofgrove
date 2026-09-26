"""Finding -> review -> regression -> replay -> evidence flow."""

from uuid import uuid4

from proofgrove.settings import settings
from tests.conftest import act_as


def test_closed_loop_persists_review_regression_replay_and_evidence(client, monkeypatch):
    from proofgrove.evaluation.engine import EvaluationEngine
    from proofgrove.evaluation.models import MetricResult

    execute = EvaluationEngine.execute

    def execute_with_span(self, *args, **kwargs):
        result = execute(self, *args, **kwargs)
        result.metric_results.append(MetricResult.model_validate({
            **result.metric_results[0].model_dump(), "subject_kind": "span", "trace_id": "trace", "span_id": "span",
        }))
        return result

    monkeypatch.setattr(EvaluationEngine, "execute", execute_with_span)
    suffix = uuid4().hex[:8]
    tenant, project, target = f"tenant-{suffix}", f"project-{suffix}", f"target-{suffix}"
    act_as(client, tenant)
    profile, experiment = f"profile-{suffix}", f"experiment-{suffix}"

    assert client.post("/platform/projects", json={
        "project_id": project, "tenant_id": tenant, "name": "Assistant", "system_type": "application", "owner": "owner"
    }).status_code == 201
    assert client.post(f"/platform/projects/{project}/target-versions", json={
        "target_version_id": target, "target_id": "assistant", "project_id": project, "tenant_id": tenant,
        "name": "Assistant", "version": "v2", "endpoint": "http://assistant", "target_type": "application"
    }).status_code == 201
    assert client.post("/platform/quality-profiles", json={
        "profile_id": profile, "version": "1.0.0", "tenant_id": tenant, "project_id": project,
        "name": "Quality", "scenario": "rag", "metric_ids": ["rag.document_recall"]
    }).status_code == 201
    assert client.post(f"/platform/quality-profiles/{profile}/versions/1.0.0/validate?tenant_id={tenant}").status_code == 200
    assert client.post(
        f"/platform/quality-profiles/{profile}/versions/1.0.0/mark-tested?tenant_id={tenant}",
        json={"mode": "overridden", "note": "fixture profile: no dry run in this test"},
    ).status_code == 200
    assert client.post(f"/platform/quality-profiles/{profile}/versions/1.0.0/approve?tenant_id={tenant}").status_code == 200
    manifest = client.post("/platform/run-manifests", json={
        "tenant_id": tenant, "project_id": project, "target_version_id": target, "profile_id": profile, "profile_version": "1.0.0"
    }).json()

    assert client.post("/evaluation/experiments", json={
        "experiment_id": experiment, "name": "Candidate", "dataset_version": "cases-v1", "target_endpoint": "http://placeholder", "scenario": "rag", "tenant_id": tenant
    }).status_code == 201
    assert client.post(f"/platform/experiments/{experiment}/run-manifest", json={"manifest_id": manifest["manifest_id"]}).status_code == 200
    assert client.post(f"/evaluation/experiments/{experiment}/rows", json=[{
        "row_id": f"case-{suffix}", "query": "Where is my claim?", "response": "I do not know.", "expected_response": "Your claim is in review.",
        "expected_data": {"expected_doc_ids": ["doc-1"]}, "output_data": {"retrieved_doc_ids": []}
    }]).status_code == 201

    definition = client.get(f"/evaluation/experiments/{experiment}").json()
    run = client.post("/evaluation/runs", json=definition)
    assert run.status_code == 201, run.text
    assert all(result["subject_kind"] == "case" for result in run.json()["metric_results"])
    run_id = run.json()["run_id"]

    findings = client.get(f"/platform/findings?run_id={run_id}&tenant_id={tenant}")
    assert findings.status_code == 200
    finding = findings.json()[0]
    task = client.get(f"/platform/findings/{finding['finding_id']}/review-tasks").json()[0]
    decision = client.post("/platform/review-decisions", json={
        "finding_id": finding["finding_id"], "task_id": task["task_id"], "reviewer": "reviewer", "outcome": "agree", "rationale": "Confirmed failure", "severity": "high", "root_cause_category": "response-quality"
    })
    assert decision.status_code == 201, decision.text
    remediation = client.post(f"/platform/findings/{finding['finding_id']}/remediations", json={
        "finding_id": finding["finding_id"], "owner": "agent-team", "description": "Correct the response policy"
    })
    assert remediation.status_code == 201, remediation.text
    remediations = client.get(f"/platform/remediations?finding_id={finding['finding_id']}&tenant_id={tenant}")
    assert remediations.status_code == 200
    assert remediations.json()[0]["owner"] == "agent-team"
    promoted = client.post(f"/platform/findings/{finding['finding_id']}/promote-regression", json={"kind": "regression", "created_by": "reviewer"})
    assert promoted.status_code == 201, promoted.text

    replay = client.post(
        f"/platform/regressions/{promoted.json()['regression_case_id']}/replay",
        json={
            "experiment_id": experiment,
            "created_by": "ci",
            "dry_run": True,
            "seed": 42,
            "frozen_mcp_responses": {"claim-search": {"result": "frozen"}},
        },
    )
    assert replay.status_code == 201, replay.text
    assert replay.json()["run_type"] == "replay"
    assert all(result["subject_kind"] == "case" for result in replay.json()["metric_results"])
    assert any(ref.startswith("replay://") for ref in replay.json()["artifact_refs"])

    evidence = client.get(f"/platform/evidence-packs/{run_id}")
    assert evidence.status_code == 200
    assert evidence.json()["manifest_id"] == manifest["manifest_id"]
    assert evidence.json()["contents"]["metric_result_count"] == len(run.json()["metric_results"])
    replay_evidence = client.get(f"/platform/evidence-packs/{replay.json()['run_id']}")
    assert replay_evidence.json()["contents"]["metric_result_count"] == len(replay.json()["metric_results"])
    assert replay_evidence.json()["contents"]["replay"]["frozen_mcp_responses"] == {"claim-search": {"result": "frozen"}}
    report = client.get(f"/evaluation/runs/{run_id}/report?tenant_id={tenant}")
    assert report.status_code == 200
    assert report.json()["evidence_pack"]["evidence_pack_id"] == evidence.json()["evidence_pack_id"]
    actions = client.get(f"/platform/audit-events?tenant_id={tenant}")
    assert actions.status_code == 200
    assert {event["action"] for event in actions.json()} >= {
        "quality_profile.approved", "finding.reviewed", "finding.promoted_to_regression", "regression.replayed"
    }


def test_platform_auth_requires_identity_permission_and_matching_tenant(client, monkeypatch):
    from unittest.mock import AsyncMock

    from proofgrove.platform import authz

    prior = settings.platform_auth_required
    settings.platform_auth_required = True
    try:
        body = {
            "project_id": f"project-{uuid4().hex[:8]}", "tenant_id": "tenant-auth", "name": "Auth", "system_type": "agent", "owner": "owner"
        }
        assert client.post("/platform/projects", json=body).status_code == 401
        monkeypatch.setattr(authz, "check_permission", AsyncMock(return_value=False))
        headers = {"x-evalai-tenant": "tenant-auth", "x-evalai-sub": "viewer@example.com"}
        assert client.post("/platform/projects", json=body, headers=headers).status_code == 403
        monkeypatch.setattr(authz, "check_permission", AsyncMock(return_value=True))
        mismatch = {"x-evalai-tenant": "another-tenant", "x-evalai-sub": "admin@example.com"}
        assert client.post("/platform/projects", json=body, headers=mismatch).status_code == 403
        allowed = {"x-evalai-tenant": "tenant-auth", "x-evalai-sub": "admin@example.com"}
        assert client.post("/platform/projects", json=body, headers=allowed).status_code == 201
    finally:
        settings.platform_auth_required = prior
