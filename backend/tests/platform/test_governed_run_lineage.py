"""Governed-run lineage: a run is governed only when a quality profile / gate
policy governs it — not merely when a run_manifest_id exists.

A run resolved against an approved Quality Contract must expose
``quality_profile_id`` / ``quality_profile_version`` and (when a gate policy
governs it) ``gate_policy_id`` / ``gate_policy_version`` on its API response and
after a persisted round-trip. An ungoverned run exposes ``None`` for all four.
"""

from uuid import uuid4

from proofgrove.evaluation.judge import set_row_overrides
from tests.conftest import act_as

_GOVERNANCE_FIELDS = (
    "quality_profile_id",
    "quality_profile_version",
    "gate_policy_id",
    "gate_policy_version",
)


def _approve_quality_profile(client, tenant, project, profile):
    act_as(client, tenant)
    assert client.post(
        "/platform/quality-profiles",
        json={
            "profile_id": profile,
            "version": "1.0.0",
            "tenant_id": tenant,
            "project_id": project,
            "name": "Quality",
            "scenario": "llm_core",
            "metric_ids": ["llm.relevance"],
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


def _approve_gate_policy(client, tenant, gate_policy):
    act_as(client, tenant)
    assert client.post(
        "/platform/gate-policies",
        json={
            "gate_policy_id": gate_policy,
            "version": "1.0.0",
            "tenant_id": tenant,
            "name": "Release gate",
        },
    ).status_code == 201
    assert client.post(
        f"/platform/gate-policies/{gate_policy}/versions/1.0.0/validate?tenant_id={tenant}"
    ).status_code == 200
    assert client.post(
        f"/platform/gate-policies/{gate_policy}/versions/1.0.0/approve?tenant_id={tenant}"
    ).status_code == 200


def _run_governed(client, suffix):
    tenant, project, target = f"tenant-{suffix}", f"project-{suffix}", f"target-{suffix}"
    act_as(client, tenant)
    profile, gate_policy = f"profile-{suffix}", f"gate-{suffix}"
    experiment = f"experiment-{suffix}"

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
    _approve_quality_profile(client, tenant, project, profile)
    _approve_gate_policy(client, tenant, gate_policy)

    manifest = client.post(
        "/platform/run-manifests",
        json={
            "tenant_id": tenant,
            "project_id": project,
            "target_version_id": target,
            "profile_id": profile,
            "profile_version": "1.0.0",
            "gate_policy_id": gate_policy,
            "gate_policy_version": "1.0.0",
        },
    ).json()

    assert client.post(
        "/evaluation/experiments",
        json={
            "experiment_id": experiment,
            "name": "Candidate",
            "dataset_version": "cases-v1",
            "target_endpoint": "http://placeholder",
            "scenario": "llm_core",
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
                "response": "It is in review.",
                "expected_response": "Your claim is in review.",
            }
        ],
    ).status_code == 201

    set_row_overrides({f"case-{suffix}": {"llm.relevance": 1.0}})
    try:
        definition = client.get(f"/evaluation/experiments/{experiment}").json()
        run = client.post("/evaluation/runs", json=definition)
    finally:
        set_row_overrides({})
    assert run.status_code == 201, run.text
    return run.json(), profile, gate_policy


def _run_ungoverned(client, suffix):
    tenant = f"tenant-{suffix}"
    act_as(client, tenant)
    experiment = f"experiment-{suffix}"
    assert client.post(
        "/evaluation/experiments",
        json={
            "experiment_id": experiment,
            "name": "Ungoverned",
            "dataset_version": "cases-v1",
            "target_endpoint": "http://placeholder",
            "scenario": "llm_core",
            "tenant_id": tenant,
        },
    ).status_code == 201
    assert client.post(
        f"/evaluation/experiments/{experiment}/rows",
        json=[
            {
                "row_id": f"case-{suffix}",
                "query": "Where is my claim?",
                "response": "It is in review.",
                "expected_response": "Your claim is in review.",
            }
        ],
    ).status_code == 201
    set_row_overrides({f"case-{suffix}": {"llm.relevance": 1.0}})
    try:
        definition = client.get(f"/evaluation/experiments/{experiment}").json()
        run = client.post("/evaluation/runs", json=definition)
    finally:
        set_row_overrides({})
    assert run.status_code == 201, run.text
    return run.json()


def test_governed_run_exposes_quality_profile_and_gate_policy(client):
    suffix = uuid4().hex[:8]
    payload, profile, gate_policy = _run_governed(client, suffix)

    assert payload["quality_profile_id"] == profile
    assert payload["quality_profile_version"] == "1.0.0"
    assert payload["gate_policy_id"] == gate_policy
    assert payload["gate_policy_version"] == "1.0.0"

    # Persisted round-trip must expose the same governance lineage.
    reloaded = client.get(
        f"/evaluation/runs/{payload['run_id']}?tenant_id=tenant-{suffix}"
    )
    assert reloaded.status_code == 200, reloaded.text
    reloaded_body = reloaded.json()
    assert reloaded_body["quality_profile_id"] == profile
    assert reloaded_body["quality_profile_version"] == "1.0.0"
    assert reloaded_body["gate_policy_id"] == gate_policy
    assert reloaded_body["gate_policy_version"] == "1.0.0"


def test_ungoverned_run_exposes_null_governance(client):
    suffix = uuid4().hex[:8]
    payload = _run_ungoverned(client, suffix)
    for field in _GOVERNANCE_FIELDS:
        assert payload[field] is None, field

    reloaded = client.get(
        f"/evaluation/runs/{payload['run_id']}?tenant_id=tenant-{suffix}"
    ).json()
    for field in _GOVERNANCE_FIELDS:
        assert reloaded[field] is None, field
