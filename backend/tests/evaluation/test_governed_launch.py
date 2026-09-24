"""Explicit Assignments must be selected at launch; never inferred."""

from unittest.mock import MagicMock

from evalhub.api.dependencies import get_registry_service
from evalhub.main import app
from tests.platform.test_assignments import TENANT, _create_assignment, _ids
from tests.platform.test_quality_contracts import (
    _approve_profile_and_gate,
    _profile,
    _project,
    _target,
)


def _published_dataset(tenant: str = TENANT):
    registry = MagicMock()
    registry.get_dataset.return_value = MagicMock(
        status="PUBLISHED",
        tenant_id=tenant,
        version_number=1,
        product_id="claims",
    )
    registry.get_records.return_value = [
        {"inputs": {"query": "q"}, "expectations": {"answer": "a"}}
    ]
    return registry


def _launch(client, dataset: str, **body):
    return client.post(f"/evaluation/runs/from-dataset/{dataset}", json=body)


def _prepare_launchable(client, ids, *, with_gate=False):
    """Profile/gate stay at final-response evidence so a baseline dataset can enqueue."""
    _project(client, ids)
    _target(client, ids)
    _profile(
        client,
        ids,
        metric_ids=["llm.correctness"],
        hard_blocker_metric_ids=[],
    )
    if with_gate:
        response = client.post(
            "/platform/gate-policies",
            json={
                "gate_policy_id": ids["gate"],
                "version": "1.0.0",
                "tenant_id": TENANT,
                "name": "Claims release",
                "required_evidence": ["input", "final_output"],
                "required_approver_roles": ["eval-hub-approver"],
            },
        )
        assert response.status_code == 201, response.text
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


def test_assignment_id_without_version_is_rejected(client):
    response = _launch(
        client,
        "claims-golden",
        response_source="baseline",
        assignment_id="claims-release",
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "assignment_version_required"


def test_unknown_assignment_is_not_found(client):
    app.dependency_overrides[get_registry_service] = lambda: _published_dataset()
    try:
        response = _launch(
            client,
            "claims-golden",
            response_source="baseline",
            assignment_id="missing",
            assignment_version="1.0.0",
        )
        assert response.status_code == 404, response.text
        assert response.json()["detail"]["code"] == "assignment_not_found"
    finally:
        app.dependency_overrides.clear()


def test_project_id_alone_never_infers_an_assignment(client):
    ids = _ids()
    _prepare_launchable(client, ids)
    created = _create_assignment(
        client,
        ids,
        gate_policy_id=...,
        gate_policy_version=...,
        name="Claims standardized",
    )
    assert created.status_code == 201, created.text

    app.dependency_overrides[get_registry_service] = lambda: _published_dataset()
    try:
        response = _launch(
            client,
            "claims-golden",
            response_source="baseline",
            project_id=ids["project"],
        )
        assert response.status_code == 202, response.text
        payload = response.json()
        assert payload.get("assignment_id") is None
        assert payload.get("run_manifest_id") is None

        configuration = client.get(
            f"/evaluation/runs/{payload['run_id']}/configuration?tenant_id={TENANT}"
        )
        assert configuration.status_code == 200
        assert configuration.json().get("assignment_id") is None
        assert configuration.json()["dataset_name"] == "claims-golden"
        assert configuration.json()["project_id"] == ids["project"]
    finally:
        app.dependency_overrides.clear()


def test_explicit_assignment_pins_manifest_and_keeps_dataset_on_the_path(client):
    ids = _ids()
    _prepare_launchable(client, ids)
    created = _create_assignment(
        client,
        ids,
        gate_policy_id=...,
        gate_policy_version=...,
        name="Claims standardized",
    )
    assert created.status_code == 201, created.text
    assignment = created.json()

    app.dependency_overrides[get_registry_service] = lambda: _published_dataset()
    try:
        conflict = _launch(
            client,
            "claims-golden",
            response_source="baseline",
            assignment_id=assignment["assignment_id"],
            assignment_version=assignment["version"],
            quality_contract_ids=["qc_tpl_response_clarity"],
        )
        assert conflict.status_code == 422, conflict.text
        assert conflict.json()["detail"]["code"] == "assignment_and_templates_conflict"

        response = _launch(
            client,
            "claims-golden",
            response_source="baseline",
            assignment_id=assignment["assignment_id"],
            assignment_version=assignment["version"],
            evaluation_name="Claims eval",
            labels=["candidate"],
        )
        assert response.status_code == 202, response.text
        payload = response.json()
        assert payload["assignment_id"] == assignment["assignment_id"]
        assert payload["assignment_version"] == assignment["version"]
        assert payload["run_manifest_id"] == assignment["run_manifest_id"]
        assert payload["governance_state"] == "standardized_evaluation"
        assert payload["dataset_name"] == "claims-golden"
        assert payload["project_id"] == ids["project"]
        assert payload["resolved_active_metrics"]
        assert payload["run_configuration_hash"]

        configuration = client.get(
            f"/evaluation/runs/{payload['run_id']}/configuration?tenant_id={TENANT}"
        )
        assert configuration.status_code == 200
        snapshot = configuration.json()
        assert snapshot["dataset_name"] == "claims-golden"
        assert snapshot["assignment_id"] == assignment["assignment_id"]
        assert snapshot["assignment_version"] == assignment["version"]
        assert snapshot["run_manifest_id"] == assignment["run_manifest_id"]
        assert snapshot["quality_contract_ids"] == []
    finally:
        app.dependency_overrides.clear()


def test_archived_assignment_cannot_launch(client):
    ids = _ids()
    _prepare_launchable(client, ids)
    created = _create_assignment(
        client,
        ids,
        gate_policy_id=...,
        gate_policy_version=...,
    )
    assert created.status_code == 201, created.text
    assignment = created.json()
    archived = client.post(
        f"/platform/assignments/{assignment['assignment_id']}/versions/{assignment['version']}/archive"
        f"?tenant_id={TENANT}"
    )
    assert archived.status_code == 200, archived.text

    app.dependency_overrides[get_registry_service] = lambda: _published_dataset()
    try:
        response = _launch(
            client,
            "claims-golden",
            response_source="baseline",
            assignment_id=assignment["assignment_id"],
            assignment_version=assignment["version"],
        )
        assert response.status_code == 422, response.text
        assert response.json()["detail"]["code"] == "assignment_archived"
    finally:
        app.dependency_overrides.clear()


def test_release_governed_assignment_is_labelled_at_enqueue(client):
    ids = _ids()
    _prepare_launchable(client, ids, with_gate=True)
    created = _create_assignment(client, ids, name="Claims release")
    assert created.status_code == 201, created.text
    assignment = created.json()
    assert assignment["governance_state"] == "release_governed"

    app.dependency_overrides[get_registry_service] = lambda: _published_dataset()
    try:
        response = _launch(
            client,
            "claims-golden",
            response_source="baseline",
            assignment_id=assignment["assignment_id"],
            assignment_version=assignment["version"],
        )
        assert response.status_code == 202, response.text
        assert response.json()["governance_state"] == "release_governed"
        assert response.json()["gate_policy_id"] == ids["gate"]
    finally:
        app.dependency_overrides.clear()
