"""Evaluator registry and metric-pack compatibility tests."""

from uuid import uuid4

from tests.conftest import act_as


def test_builtin_evaluators_are_seeded_and_versioned(client):
    act_as(client, "tenant-a")
    response = client.get("/platform/evaluators?tenant_id=tenant-a")
    assert response.status_code == 200
    definitions = response.json()
    ragas = next(item for item in definitions if item["evaluator_id"] == "builtin.ragas")
    assert ragas["version"] == "1.0.0"
    assert ragas["status"] == "approved"
    assert ragas["execution_mode"] == "judge"

    deterministic = next(
        item for item in definitions if item["evaluator_id"] == "builtin.deterministic"
    )
    assert deterministic["execution_mode"] == "deterministic"
    assert deterministic["execution_policy"]["network"] is False

    custom = next(
        item for item in definitions if item["evaluator_id"] == "builtin.custom"
    )
    assert custom["execution_mode"] == "isolated"


def test_approved_metric_pack_can_supply_a_profile_metric_without_core_changes(client):
    suffix = uuid4().hex[:8]
    tenant = f"tenant-{suffix}"
    act_as(client, tenant)
    project = f"project-{suffix}"
    target = f"target-{suffix}"
    evaluator = f"team.policy-{suffix}"
    pack = f"team-pack-{suffix}"
    profile = f"team-profile-{suffix}"

    assert client.post("/platform/projects", json={
        "project_id": project, "tenant_id": tenant, "name": "Generic assistant", "system_type": "application", "owner": "team-a"
    }).status_code == 201
    assert client.post(f"/platform/projects/{project}/target-versions", json={
        "target_version_id": target, "target_id": "generic", "project_id": project, "tenant_id": tenant,
        "name": "Generic", "version": "1", "endpoint": "http://generic", "target_type": "application"
    }).status_code == 201

    definition = client.post("/platform/evaluators", json={
        "evaluator_id": evaluator,
        "version": "1.0.0",
        "tenant_id": tenant,
        "name": "Policy evaluator",
        "execution_mode": "isolated",
        "adapter": "custom",
        "implementation": "oci://tenant-registry/policy-evaluator:1.0.0",
        "trusted": False,
        "metric_definitions": [{
            "metric_id": "team.policy_conformance",
            "name": "Policy conformance",
            "description": "Tenant-defined policy check",
            "scoring_type": "binary",
            "default_adapter": "custom",
            "adapter_class": "team.policy.Conformance",
            "kpi_ids": ["kpi.response_quality"],
        }],
    })
    assert definition.status_code == 201, definition.text
    assert client.post(f"/platform/evaluators/{evaluator}/versions/1.0.0/approve?tenant_id={tenant}").status_code == 200

    installed = client.post("/platform/metric-packs", json={
        "metric_pack_id": pack,
        "version": "1.0.0",
        "tenant_id": tenant,
        "name": "Team policy pack",
        "evaluator_refs": [f"{evaluator}@1.0.0"],
        "metric_ids": ["team.policy_conformance"],
    })
    assert installed.status_code == 201, installed.text
    assert client.post(f"/platform/metric-packs/{pack}/versions/1.0.0/approve?tenant_id={tenant}").status_code == 200

    created_profile = client.post("/platform/quality-profiles", json={
        "profile_id": profile,
        "version": "1.0.0",
        "tenant_id": tenant,
        "project_id": project,
        "name": "Team profile",
        "scenario": "llm_core",
        "metric_ids": ["team.policy_conformance"],
        "metric_requirements": {"team.policy_conformance": "optional"},
        "evaluator_refs": {"team.policy_conformance": f"{evaluator}@1.0.0"},
        "metric_pack_refs": [f"{pack}@1.0.0"],
    })
    assert created_profile.status_code == 201, created_profile.text
    assert client.post(f"/platform/quality-profiles/{profile}/versions/1.0.0/validate?tenant_id={tenant}").status_code == 200
    assert client.post(
        f"/platform/quality-profiles/{profile}/versions/1.0.0/mark-tested?tenant_id={tenant}",
        json={"mode": "overridden", "note": "fixture profile: no dry run in this test"},
    ).status_code == 200
    assert client.post(f"/platform/quality-profiles/{profile}/versions/1.0.0/approve?tenant_id={tenant}").status_code == 200

    resolved = client.post("/platform/run-manifests", json={
        "tenant_id": tenant,
        "project_id": project,
        "target_version_id": target,
        "profile_id": profile,
        "profile_version": "1.0.0",
    })
    assert resolved.status_code == 201, resolved.text
    manifest = resolved.json()
    assert manifest["metric_ids"] == ["team.policy_conformance"]
    assert manifest["evaluator_refs"]["team.policy_conformance"] == f"{evaluator}@1.0.0"
    assert manifest["metric_definitions"][0]["metric_id"] == "team.policy_conformance"
    assert manifest["diagnostic_only"] is True
