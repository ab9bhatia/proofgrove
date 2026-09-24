"""Assignment identity: named versions, revisions, and immutable manifests."""

from uuid import uuid4

from tests.conftest import act_as
from tests.platform.test_quality_contracts import (
    _approve_profile_and_gate,
    _gate,
    _profile,
    _project,
    _target,
)

TENANT = "tenant-a"


def _ids():
    suffix = uuid4().hex[:8]
    return {
        "project": f"project-{suffix}",
        "target": f"target-{suffix}",
        "profile": f"profile-{suffix}",
        "gate": f"gate-{suffix}",
        "assignment": f"assignment-{suffix}",
    }


def _prepare(client, ids, *, with_gate=True, approve=True):
    _project(client, ids)
    _target(client, ids)
    _profile(client, ids)
    if with_gate:
        _gate(client, ids)
    if not approve:
        return
    if with_gate:
        _approve_profile_and_gate(client, ids)
        return
    assert client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/mark-tested?tenant_id={TENANT}",
        json={"mode": "overridden", "note": "fixture profile: no dry run in this test"},
    ).status_code == 200
    for path in (
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/validate",
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/approve",
    ):
        response = client.post(f"{path}?tenant_id={TENANT}")
        assert response.status_code == 200, response.text


def _create_assignment(client, ids, **overrides):
    body = {
        "tenant_id": TENANT,
        "assignment_id": ids["assignment"],
        "version": "1.0.0",
        "project_id": ids["project"],
        "target_version_id": ids["target"],
        "profile_id": ids["profile"],
        "profile_version": "1.0.0",
        "purpose": "Release scoring for claims",
        "change_note": "Initial pin",
        "gate_policy_id": ids["gate"],
        "gate_policy_version": "1.0.0",
    }
    body.update(overrides)
    return client.post("/platform/assignments", json={key: value for key, value in body.items() if value is not ...})


def test_unapproved_controls_cannot_become_an_assignment(client):
    ids = _ids()
    _prepare(client, ids, approve=False)
    response = _create_assignment(client, ids)
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "CONTRACT_UNRESOLVABLE"


def test_assignment_without_gate_is_standardized_and_pins_an_immutable_manifest(client):
    ids = _ids()
    _prepare(client, ids, with_gate=False)
    response = client.post(
        "/platform/assignments",
        json={
            "tenant_id": TENANT,
            "assignment_id": ids["assignment"],
            "project_id": ids["project"],
            "target_version_id": ids["target"],
            "profile_id": ids["profile"],
            "profile_version": "1.0.0",
        },
    )
    assert response.status_code == 201, response.text
    assignment = response.json()
    assert assignment["governance_state"] == "standardized_evaluation"
    assert assignment["gate_policy_id"] is None
    assert assignment["name"] == "Claims assistant · Claims assistant 2026.07.31"
    assert assignment["run_manifest_id"]

    fetched = client.get(
        f"/platform/assignments/{ids['assignment']}/versions/1.0.0"
        f"?tenant_id={TENANT}&include_manifest=true"
    )
    assert fetched.status_code == 200
    manifest = fetched.json()["resolved_run_manifest"]
    assert manifest["manifest_id"] == assignment["run_manifest_id"]
    assert manifest["quality_profile_version"] == "1.0.0"
    assert manifest["gate_policy_id"] is None
    assert manifest["benchmark_package_id"] is None


def test_assignment_with_approved_gate_is_release_governed(client):
    ids = _ids()
    _prepare(client, ids)
    response = _create_assignment(client, ids, name="Claims release assignment")
    assert response.status_code == 201, response.text
    assignment = response.json()
    assert assignment["governance_state"] == "release_governed"
    assert assignment["gate_policy_id"] == ids["gate"]
    assert assignment["owner"] == "quality-team"


def test_duplicate_assignment_version_conflicts_and_revision_leaves_parent_unchanged(client):
    ids = _ids()
    _prepare(client, ids)
    first = _create_assignment(client, ids, name="Claims v1")
    assert first.status_code == 201, first.text
    parent_manifest = first.json()["run_manifest_id"]

    duplicate = _create_assignment(client, ids, name="Claims v1 again")
    assert duplicate.status_code == 409, duplicate.text

    _profile(client, ids, version="1.1.0")
    assert client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.1.0/mark-tested?tenant_id={TENANT}",
        json={"mode": "overridden", "note": "fixture profile: no dry run in this test"},
    ).status_code == 200
    for path in (
        f"/platform/quality-profiles/{ids['profile']}/versions/1.1.0/validate",
        f"/platform/quality-profiles/{ids['profile']}/versions/1.1.0/approve",
    ):
        assert client.post(f"{path}?tenant_id={TENANT}").status_code == 200

    revision = client.post(
        f"/platform/assignments/{ids['assignment']}/revisions",
        json={
            "tenant_id": TENANT,
            "version": "1.1.0",
            "parent_version": "1.0.0",
            "name": "Claims v2",
            "change_note": "Pin newer profile",
            "project_id": ids["project"],
            "target_version_id": ids["target"],
            "profile_id": ids["profile"],
            "profile_version": "1.1.0",
            "gate_policy_id": ids["gate"],
            "gate_policy_version": "1.0.0",
        },
    )
    assert revision.status_code == 201, revision.text
    assert revision.json()["parent_assignment_version_id"].endswith(
        f"{ids['assignment']}@1.0.0"
    )
    assert revision.json()["profile_version"] == "1.1.0"
    assert revision.json()["run_manifest_id"] != parent_manifest

    parent = client.get(
        f"/platform/assignments/{ids['assignment']}/versions/1.0.0?tenant_id={TENANT}"
    )
    assert parent.json()["name"] == "Claims v1"
    assert parent.json()["profile_version"] == "1.0.0"
    assert parent.json()["run_manifest_id"] == parent_manifest


def test_archive_hides_assignment_from_active_catalog_and_restore_returns_it(client):
    ids = _ids()
    _prepare(client, ids)
    created = _create_assignment(client, ids, name="Archivable")
    assert created.status_code == 201, created.text

    archived = client.post(
        f"/platform/assignments/{ids['assignment']}/versions/1.0.0/archive?tenant_id={TENANT}"
    )
    assert archived.status_code == 200
    assert archived.json()["archived_at"]

    listed = client.get(f"/platform/assignments?tenant_id={TENANT}").json()
    assert all(item["assignment_id"] != ids["assignment"] for item in listed)

    hidden = client.get(
        f"/platform/assignments?tenant_id={TENANT}&include_archived=true"
    ).json()
    assert any(item["assignment_id"] == ids["assignment"] for item in hidden)

    restored = client.post(
        f"/platform/assignments/{ids['assignment']}/versions/1.0.0/restore?tenant_id={TENANT}"
    )
    assert restored.status_code == 200
    assert restored.json()["archived_at"] is None
    listed_again = client.get(f"/platform/assignments?tenant_id={TENANT}").json()
    assert any(item["assignment_id"] == ids["assignment"] for item in listed_again)


def test_assignment_rejects_catalog_registry_and_archived_projects(client):
    ids = _ids()
    registry = client.post(
        "/platform/projects",
        json={
            "project_id": ids["project"],
            "tenant_id": TENANT,
            "name": "Catalog",
            "system_type": "agent",
            "owner": "quality-team",
            "purpose": "catalog_registry",
        },
    )
    assert registry.status_code == 201, registry.text
    _target(client, ids)
    _profile(client, ids)
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)
    blocked = _create_assignment(client, ids)
    assert blocked.status_code == 422, blocked.text
    assert "system Project" in blocked.json()["detail"]["message"]

    ids = _ids()
    _prepare(client, ids)
    archived = client.post(f"/platform/projects/{ids['project']}/archive?tenant_id={TENANT}")
    assert archived.status_code == 200, archived.text
    blocked_archived = _create_assignment(client, ids)
    assert blocked_archived.status_code == 422, blocked_archived.text
    assert "active Project" in blocked_archived.json()["detail"]["message"]


def test_two_tenants_can_own_the_same_assignment_identity(client):
    other = "tenant-b"
    for tenant in (TENANT, other):
        act_as(client, tenant)
        project_id = f"{tenant}-project"
        target_id = f"{tenant}-target"
        project = client.post(
            "/platform/projects",
            json={
                "project_id": project_id,
                "tenant_id": tenant,
                "name": f"{tenant} claims",
                "system_type": "agent",
                "owner": "quality-team",
            },
        )
        assert project.status_code == 201, project.text
        target = client.post(
            f"/platform/projects/{project_id}/target-versions",
            json={
                "target_version_id": target_id,
                "target_id": "claims-assistant",
                "project_id": project_id,
                "tenant_id": tenant,
                "name": "Claims assistant",
                "version": "2026.07.31",
                "endpoint": "http://claims-assistant.local/v1/chat",
                "target_type": "agent",
                "environment": "test",
            },
        )
        assert target.status_code == 201, target.text
        profile = client.post(
            "/platform/quality-profiles",
            json={
                "profile_id": "shared-profile",
                "version": "1.0.0",
                "tenant_id": tenant,
                "project_id": project_id,
                "name": f"{tenant} quality",
                "scenario": "agentic",
                "metric_ids": ["agent.task_adherence", "safety.general"],
                "evidence_requirements": ["input", "final_output"],
                "hard_blocker_metric_ids": ["safety.general"],
                "approver_roles": ["eval-hub-approver"],
            },
        )
        assert profile.status_code == 201, profile.text
        gate = client.post(
            "/platform/gate-policies",
            json={
                "gate_policy_id": "shared-gate",
                "version": "1.0.0",
                "tenant_id": tenant,
                "name": f"{tenant} gate",
                "required_evidence": ["tool_calls"],
                "required_approver_roles": ["eval-hub-approver"],
            },
        )
        assert gate.status_code == 201, gate.text
        assert client.post(
            f"/platform/quality-profiles/shared-profile/versions/1.0.0/mark-tested?tenant_id={tenant}",
            json={"mode": "overridden", "note": "fixture profile: no dry run in this test"},
        ).status_code == 200
        for path in (
            "/platform/quality-profiles/shared-profile/versions/1.0.0/validate",
            "/platform/quality-profiles/shared-profile/versions/1.0.0/approve",
            "/platform/gate-policies/shared-gate/versions/1.0.0/validate",
            "/platform/gate-policies/shared-gate/versions/1.0.0/approve",
        ):
            assert client.post(f"{path}?tenant_id={tenant}").status_code == 200
        created = client.post(
            "/platform/assignments",
            json={
                "tenant_id": tenant,
                "assignment_id": "shared-assignment",
                "name": f"{tenant} assignment",
                "project_id": project_id,
                "target_version_id": target_id,
                "profile_id": "shared-profile",
                "profile_version": "1.0.0",
                "gate_policy_id": "shared-gate",
                "gate_policy_version": "1.0.0",
            },
        )
        assert created.status_code == 201, created.text

    act_as(client, TENANT)
    own = client.get(
        f"/platform/assignments/shared-assignment/versions/1.0.0?tenant_id={TENANT}"
    )
    assert own.json()["name"] == "tenant-a assignment"
    listed = client.get(f"/platform/assignments?tenant_id={TENANT}").json()
    assert {item["name"] for item in listed if item["assignment_id"] == "shared-assignment"} == {
        "tenant-a assignment"
    }


def test_validate_and_retire_are_audited(client):
    """Every lifecycle transition leaves a record, not only approve and reinstate.

    Approve, reinstate, archive and restore recorded an audit event; validate and
    retire did not, and neither took a `Request` to record one with. A governance
    action that leaves no trace is indistinguishable afterwards from one that
    never happened.
    """
    ids = _ids()
    act_as(client, TENANT)
    _prepare(client, ids, with_gate=True, approve=True)

    assert client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/retire?tenant_id={TENANT}"
    ).status_code == 200
    assert client.post(
        f"/platform/gate-policies/{ids['gate']}/versions/1.0.0/retire?tenant_id={TENANT}"
    ).status_code == 200

    events = client.get(f"/platform/audit-events?tenant_id={TENANT}")
    assert events.status_code == 200, events.text

    actions = {event["action"] for event in events.json()}
    assert "quality_profile.validated" in actions
    assert "gate_policy.validated" in actions
    assert "quality_profile.retired" in actions
    assert "gate_policy.retired" in actions
