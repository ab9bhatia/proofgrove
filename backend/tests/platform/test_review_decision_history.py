"""Review decision-history read path.

Review decisions are append-only. The history endpoint returns the ordered
decision history for a finding (actor, outcome, rationale, timestamp,
superseded flag) with the latest decision marked current/superseding and every
earlier decision marked superseded.
"""

from uuid import uuid4

from tests.conftest import act_as


def _finding_with_task(client, suffix):
    tenant, project, target = f"tenant-{suffix}", f"project-{suffix}", f"target-{suffix}"
    act_as(client, tenant)
    profile, experiment = f"profile-{suffix}", f"experiment-{suffix}"

    assert client.post(
        "/platform/projects",
        json={
            "project_id": project,
            "tenant_id": tenant,
            "name": "Assistant",
            "system_type": "application",
            "owner": "owner",
        },
    ).status_code == 201
    assert client.post(
        f"/platform/projects/{project}/target-versions",
        json={
            "target_version_id": target,
            "target_id": "assistant",
            "project_id": project,
            "tenant_id": tenant,
            "name": "Assistant",
            "version": "v2",
            "endpoint": "http://assistant",
            "target_type": "application",
        },
    ).status_code == 201
    assert client.post(
        "/platform/quality-profiles",
        json={
            "profile_id": profile,
            "version": "1.0.0",
            "tenant_id": tenant,
            "project_id": project,
            "name": "Quality",
            "scenario": "rag",
            "metric_ids": ["rag.document_recall"],
        },
    ).status_code == 201
    assert client.post(
        f"/platform/quality-profiles/{profile}/versions/1.0.0/mark-tested?tenant_id={tenant}",
        json={"mode": "overridden", "note": "fixture profile: no dry run in this test"},
    ).status_code == 200
    assert client.post(
        f"/platform/quality-profiles/{profile}/versions/1.0.0/validate?tenant_id={tenant}"
    ).status_code == 200
    assert client.post(
        f"/platform/quality-profiles/{profile}/versions/1.0.0/approve?tenant_id={tenant}"
    ).status_code == 200
    manifest = client.post(
        "/platform/run-manifests",
        json={
            "tenant_id": tenant,
            "project_id": project,
            "target_version_id": target,
            "profile_id": profile,
            "profile_version": "1.0.0",
        },
    ).json()

    assert client.post(
        "/evaluation/experiments",
        json={
            "experiment_id": experiment,
            "name": "Candidate",
            "dataset_version": "cases-v1",
            "target_endpoint": "http://placeholder",
            "scenario": "rag",
            "tenant_id": tenant,
        },
    ).status_code == 201
    assert client.post(
        f"/platform/experiments/{experiment}/run-manifest",
        json={"manifest_id": manifest["manifest_id"]},
    ).status_code == 200
    assert client.post(
        f"/evaluation/experiments/{experiment}/rows",
        json=[
            {
                "row_id": f"case-{suffix}",
                "query": "Where is my claim?",
                "response": "I do not know.",
                "expected_response": "Your claim is in review.",
                "expected_data": {"expected_doc_ids": ["doc-1"]},
                "output_data": {"retrieved_doc_ids": []},
            }
        ],
    ).status_code == 201

    definition = client.get(f"/evaluation/experiments/{experiment}").json()
    run = client.post("/evaluation/runs", json=definition)
    assert run.status_code == 201, run.text
    run_id = run.json()["run_id"]

    findings = client.get(f"/platform/findings?run_id={run_id}&tenant_id={tenant}").json()
    assert findings, "expected a gate finding"
    finding_id = findings[0]["finding_id"]
    task = client.get(f"/platform/findings/{finding_id}/review-tasks").json()[0]
    return finding_id, task["task_id"]


def test_review_decision_history_orders_and_marks_supersession(client):
    suffix = uuid4().hex[:8]
    finding_id, task_id = _finding_with_task(client, suffix)

    first = client.post(
        "/platform/review-decisions",
        json={
            "finding_id": finding_id,
            "task_id": task_id,
            "reviewer": "reviewer-a",
            "outcome": "disagree",
            "rationale": "False positive on first pass",
        },
    )
    assert first.status_code == 201, first.text
    second = client.post(
        "/platform/review-decisions",
        json={
            "finding_id": finding_id,
            "task_id": task_id,
            "reviewer": "reviewer-b",
            "outcome": "agree",
            "rationale": "Confirmed regression after re-review",
        },
    )
    assert second.status_code == 201, second.text

    history = client.get(f"/platform/findings/{finding_id}/review-decisions")
    assert history.status_code == 200, history.text
    entries = history.json()
    assert len(entries) == 2

    # Ordered oldest -> newest.
    assert entries[0]["actor"] == "reviewer-a"
    assert entries[0]["outcome"] == "disagree"
    assert entries[0]["rationale"] == "False positive on first pass"
    assert entries[0]["timestamp"] is not None
    assert entries[0]["superseded"] is True
    assert entries[0]["is_current"] is False

    assert entries[1]["actor"] == "reviewer-b"
    assert entries[1]["outcome"] == "agree"
    assert entries[1]["superseded"] is False
    assert entries[1]["is_current"] is True


def test_review_decision_history_unknown_finding_404(client):
    response = client.get(f"/platform/findings/does-not-exist-{uuid4().hex}/review-decisions")
    assert response.status_code == 404


def test_regression_promotion_requires_current_agreement(client):
    suffix = uuid4().hex[:8]
    finding, task = _finding_with_task(client, suffix)
    tenant = f"tenant-{suffix}"
    promote = f"/platform/findings/{finding}/promote-regression"
    body = {"kind": "regression", "created_by": "reviewer"}
    assert client.post(promote, json=body).status_code == 422
    for outcome in ["agree", "disagree"]:
        response = client.post("/platform/review-decisions", json={
            "finding_id": finding, "task_id": task, "reviewer": "reviewer",
            "outcome": outcome, "rationale": "re-review",
        })
        assert response.status_code == 201, response.text
    before = client.get("/platform/findings", params={"tenant_id": tenant}).json()
    denied = client.post(promote, json=body)
    assert denied.status_code == 422, denied.text
    assert client.get("/platform/regressions", params={"tenant_id": tenant}).json() == []
    assert client.get("/platform/findings", params={"tenant_id": tenant}).json() == before

    latest = client.post("/platform/review-decisions", json={
        "finding_id": finding, "task_id": task, "reviewer": "reviewer",
        "outcome": "agree", "rationale": "confirmed on final review",
    })
    assert latest.status_code == 201, latest.text
    promoted = client.post(promote, json=body)
    assert promoted.status_code == 201, promoted.text
    assert promoted.json()["provenance"]["review_decision_id"] == latest.json()["decision_id"]
    history = client.get(f"/platform/findings/{finding}/review-decisions").json()
    assert [entry["is_current"] for entry in history] == [False, False, True]
