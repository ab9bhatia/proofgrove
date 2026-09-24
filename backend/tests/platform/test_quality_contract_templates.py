"""InEval quality-contract template onboarding."""

from evalhub.evaluation.metrics import METRIC_CATALOG
from evalhub.evaluation.prompts import build_judge_messages

#: The tenant this module's client acts as, the way the gateway sets it.
TENANT = "tenant-a"


def test_builtin_quality_contract_templates_are_executable_metrics(client):
    response = client.get("/platform/quality-contract-templates")
    assert response.status_code == 200

    templates = response.json()
    assert {item["template_id"] for item in templates} == {
        "qc_tpl_task_completion",
        "qc_tpl_tool_correctness",
        "qc_tpl_plan_quality",
        "qc_tpl_groundedness",
        "qc_tpl_safety_policy",
        "qc_tpl_error_recovery",
        "qc_tpl_response_clarity",
        "qc_tpl_efficiency",
    }
    for template in templates:
        metric = METRIC_CATALOG[template["metric_id"]]
        assert metric.criteria == template["criteria"]
        assert metric.evaluation_steps == template["evaluation_steps"]
        assert metric.default_threshold_pass == template["threshold"]
        assert metric.default_adapter.value == "deepeval"


def test_template_instantiation_creates_governed_draft_profile(client):
    response = client.post(
        "/platform/quality-contract-templates/qc_tpl_task_completion/instantiate",
        json={"tenant_id": "tenant-a", "created_by": "quality-owner"},
    )
    assert response.status_code == 201, response.text

    profile = response.json()
    assert profile["status"] == "draft"
    assert profile["scenario"] == "agentic"
    assert profile["metric_ids"] == ["quality.task_completion"]
    assert profile["hard_blocker_metric_ids"] == ["quality.task_completion"]
    assert profile["source_template_id"] == "qc_tpl_task_completion"
    assert profile["source_template_snapshot"]["criteria"]
    assert profile["source_template_snapshot"]["threshold"] == 0.75

    listed = client.get("/platform/quality-profiles?tenant_id=tenant-a")
    assert listed.status_code == 200
    assert any(item["profile_id"] == profile["profile_id"] for item in listed.json())

    assert (
        client.post(
            "/platform/projects",
            json={
                "project_id": "template-project",
                "tenant_id": "tenant-a",
                "name": "Template target",
                "system_type": "agent",
                "owner": "quality-owner",
            },
        ).status_code
        == 201
    )
    assert (
        client.post(
            "/platform/projects/template-project/target-versions",
            json={
                "target_version_id": "template-target-v1",
                "target_id": "template-target",
                "project_id": "template-project",
                "tenant_id": "tenant-a",
                "name": "Template target",
                "version": "1",
                "endpoint": "http://template-target.local",
                "target_type": "agent",
            },
        ).status_code
        == 201
    )
    # Approval refuses a profile that is still Not tested, so record the audited
    # override first. A template instantiation has no dry-run behind it.
    assert (
        client.post(
            f"/platform/quality-profiles/{profile['profile_id']}/versions/1.0.0/mark-tested?tenant_id=tenant-a",
            json={"mode": "overridden", "note": "template instantiation has no dry-run"},
        ).status_code
        == 200
    )
    for action in ("validate", "approve"):
        transitioned = client.post(f"/platform/quality-profiles/{profile['profile_id']}/versions/1.0.0/{action}?tenant_id=tenant-a")
        assert transitioned.status_code == 200, transitioned.text

    resolved = client.post(
        "/platform/run-manifests",
        json={
            "tenant_id": "tenant-a",
            "project_id": "template-project",
            "target_version_id": "template-target-v1",
            "profile_id": profile["profile_id"],
            "profile_version": "1.0.0",
        },
    )
    assert resolved.status_code == 201, resolved.text
    manifest = resolved.json()
    assert manifest["source_template_id"] == "qc_tpl_task_completion"
    assert manifest["source_template_snapshot"]["criteria"] == profile["source_template_snapshot"]["criteria"]
    assert manifest["metric_definitions"][0]["default_threshold_pass"] == 0.75


def test_every_builtin_template_resolves_to_a_manifest(client):
    """One enumerating check: every first-party template can become a run contract."""

    templates = client.get("/platform/quality-contract-templates").json()
    assert templates, "built-in templates must be published"
    assert (
        client.post(
            "/platform/projects",
            json={
                "project_id": "all-templates-project",
                "tenant_id": TENANT,
                "name": "Template resolution",
                "system_type": "agent",
                "owner": "quality-owner",
            },
        ).status_code
        == 201
    )
    assert (
        client.post(
            "/platform/projects/all-templates-project/target-versions",
            json={
                "target_version_id": "all-templates-target",
                "target_id": "all-templates-target",
                "project_id": "all-templates-project",
                "tenant_id": TENANT,
                "name": "Template target",
                "version": "1",
                "endpoint": "http://template-target.local",
                "target_type": "agent",
            },
        ).status_code
        == 201
    )

    for template in templates:
        created = client.post(
            f"/platform/quality-contract-templates/{template['template_id']}/instantiate",
            json={"tenant_id": TENANT, "created_by": "quality-owner"},
        )
        assert created.status_code == 201, created.text
        profile = created.json()
        assert profile["status"] == "draft"
        assert profile["evidence_requirements"] == list(
            METRIC_CATALOG[template["metric_id"]].required_evidence_categories
        )
        assert (
            client.post(
                f"/platform/quality-profiles/{profile['profile_id']}/versions/{profile['version']}/mark-tested?tenant_id={TENANT}",
                json={"mode": "overridden", "note": "template instantiation has no dry-run"},
            ).status_code
            == 200
        )
        for action in ("validate", "approve"):
            transitioned = client.post(
                f"/platform/quality-profiles/{profile['profile_id']}/versions/{profile['version']}/{action}?tenant_id={TENANT}"
            )
            assert transitioned.status_code == 200, transitioned.text
        resolved = client.post(
            "/platform/run-manifests",
            json={
                "tenant_id": TENANT,
                "project_id": "all-templates-project",
                "target_version_id": "all-templates-target",
                "profile_id": profile["profile_id"],
                "profile_version": profile["version"],
            },
        )
        assert resolved.status_code == 201, (
            f"{template['template_id']} failed to resolve: {resolved.text}"
        )
        manifest = resolved.json()
        assert template["metric_id"] in manifest["metric_ids"]
        assert manifest["quality_profile_id"] == profile["profile_id"]


def test_contract_rubric_is_present_in_native_fallback_prompt():
    messages = build_judge_messages(
        "quality.error_recovery",
        "Complete the task",
        "The tool failed, so I stopped",
        ["tool error: timeout"],
    )
    prompt = messages[1]["content"]
    assert "recover gracefully" in prompt
    assert "Penalize fabricated success after failures" in prompt


def test_unknown_quality_contract_template_returns_404(client):
    response = client.post(
        "/platform/quality-contract-templates/not-real/instantiate",
        json={"tenant_id": "tenant-a"},
    )
    assert response.status_code == 404
