"""Quality-contract control plane behaviour."""

from uuid import uuid4

from proofgrove.evaluation.enums import EvaluationScope, Scenario
from proofgrove.evaluation.metrics import METRIC_CATALOG
from proofgrove.platform.resolver import resolve_scoring_configuration

TENANT = "tenant-a"


def test_dataset_scoring_configuration_freezes_sources_weights_and_hash():
    legacy = resolve_scoring_configuration(
        metric_ids=["llm.correctness", "ops.latency"],
        explicit_metric_ids=set(),
        scenario=Scenario.LLM_CORE,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
    )
    source_by_metric = {
        item.metric_id: item.source.value for item in legacy.metric_requirements
    }
    assert source_by_metric == {
        "llm.correctness": "legacy_scenario_primary",
        "ops.latency": "legacy_cross_cutting",
    }
    assert all(
        abs(sum(item.fixed_gate_weights.values()) - 1.0) < 1e-9
        for item in legacy.kpi_compositions
        if item.required_gate_constituents
    )

    explicit = resolve_scoring_configuration(
        metric_ids=["llm.correctness", "ops.latency"],
        explicit_metric_ids={"llm.correctness"},
        scenario=Scenario.LLM_CORE,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
    )
    assert explicit.configuration_hash != legacy.configuration_hash
    assert next(
        item for item in explicit.metric_requirements if item.metric_id == "llm.correctness"
    ).source.value == "explicit_selection"


def test_catalog_diagnostic_metric_does_not_accidentally_become_a_release_gate():
    resolved = resolve_scoring_configuration(
        metric_ids=["nlp.bleu"],
        explicit_metric_ids={"nlp.bleu"},
        scenario=Scenario.LLM_CORE,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
    )

    requirement = resolved.metric_requirements[0]
    assert requirement.requirement.value == "optional"
    assert requirement.source.value == "catalog_diagnostic_default"
    assert resolved.diagnostic_only is True
    assert resolved.kpi_compositions == []


def test_metric_evidence_promotes_scope_and_removal_reverses_it():
    promoted = resolve_scoring_configuration(
        metric_ids=["agent.task_adherence"],
        explicit_metric_ids={"agent.task_adherence"},
        scenario=Scenario.AGENTIC,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
    )
    assert promoted.requested_evaluation_scope == EvaluationScope.FINAL_RESPONSE
    assert promoted.resolved_evaluation_scope == EvaluationScope.TOOL_INTERACTIONS
    assert promoted.evaluation_scope == EvaluationScope.TOOL_INTERACTIONS
    assert {reason["source_id"] for reason in promoted.scope_promotion_reasons} == {
        "agent.task_adherence"
    }

    reversed_scope = resolve_scoring_configuration(
        metric_ids=["llm.correctness"],
        explicit_metric_ids={"llm.correctness"},
        scenario=Scenario.LLM_CORE,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
    )
    assert reversed_scope.resolved_evaluation_scope == EvaluationScope.FINAL_RESPONSE
    assert reversed_scope.scope_promotion_reasons == []


def _ids():
    suffix = uuid4().hex[:8]
    return {
        "project": f"project-{suffix}",
        "target": f"target-{suffix}",
        "profile": f"profile-{suffix}",
        "gate": f"gate-{suffix}",
        "experiment": f"experiment-{suffix}",
    }


def _project(client, ids):
    response = client.post(
        "/platform/projects",
        json={
            "project_id": ids["project"],
            "tenant_id": TENANT,
            "name": "Claims assistant",
            "system_type": "agent",
            "owner": "quality-team",
        },
    )
    assert response.status_code == 201, response.text


def _target(client, ids):
    response = client.post(
        f"/platform/projects/{ids['project']}/target-versions",
        json={
            "target_version_id": ids["target"],
            "target_id": "claims-assistant",
            "project_id": ids["project"],
            "tenant_id": TENANT,
            "name": "Claims assistant",
            "version": "2026.07.31",
            "endpoint": "http://claims-assistant.local/v1/chat",
            "target_type": "agent",
            "environment": "test",
            "model_version": "model-2026-07",
            "prompt_version": "prompt-7",
            "tool_versions": {"claims-search": "3.1.0"},
        },
    )
    assert response.status_code == 201, response.text


def _profile(
    client,
    ids,
    version="1.0.0",
    metric_ids=None,
    metric_requirements=None,
    kpi_gate_weights=None,
    hard_blocker_metric_ids=None,
    exact_runtime_identity_required=False,
):
    response = client.post(
        "/platform/quality-profiles",
        json={
            "profile_id": ids["profile"],
            "version": version,
            "tenant_id": TENANT,
            "project_id": ids["project"],
            "name": "Claims quality",
            "scenario": "agentic",
            "metric_ids": (
                metric_ids
                if metric_ids is not None
                else ["agent.task_adherence", "safety.general"]
            ),
            "metric_requirements": metric_requirements or {},
            "kpi_gate_weights": kpi_gate_weights or {},
            "evidence_requirements": ["input", "final_output"],
            "exact_runtime_identity_required": exact_runtime_identity_required,
            "hard_blocker_metric_ids": (
                hard_blocker_metric_ids
                if hard_blocker_metric_ids is not None
                else ["safety.general"]
            ),
            "approver_roles": ["proofgrove-approver"],
            "gate_policy_id": ids["gate"],
            "gate_policy_version": "1.0.0",
        },
    )
    assert response.status_code == 201, response.text


def _gate(client, ids):
    response = client.post(
        "/platform/gate-policies",
        json={
            "gate_policy_id": ids["gate"],
            "version": "1.0.0",
            "tenant_id": TENANT,
            "name": "Claims release",
            "required_evidence": ["tool_calls"],
            "required_approver_roles": ["proofgrove-approver"],
        },
    )
    assert response.status_code == 201, response.text


def _approve_profile_and_gate(client, ids):
    marked = client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/mark-tested?tenant_id={TENANT}",
        json={"mode": "overridden", "note": "fixture profile: no dry run in this test"},
    )
    assert marked.status_code == 200, marked.text
    for path in (
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/validate",
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/approve",
        f"/platform/gate-policies/{ids['gate']}/versions/1.0.0/validate",
        f"/platform/gate-policies/{ids['gate']}/versions/1.0.0/approve",
    ):
        response = client.post(f"{path}?tenant_id={TENANT}")
        assert response.status_code == 200, response.text


def _project_and_target(client) -> dict:
    """Create a fresh project + target version under one set of ids."""
    ids = _ids()
    _project(client, ids)
    _target(client, ids)
    return ids


def _manifest(client, ids):
    response = client.post(
        "/platform/run-manifests",
        json={
            "tenant_id": TENANT,
            "project_id": ids["project"],
            "target_version_id": ids["target"],
            "profile_id": ids["profile"],
            "profile_version": "1.0.0",
            "gate_policy_id": ids["gate"],
            "gate_policy_version": "1.0.0",
            "benchmark_package_id": "claims-golden",
            "benchmark_package_version": "2.1.0",
            "benchmark_family": "regression",
            "judge_config": {"model": "gateway/model-a", "temperature": 0},
            "resolved_by": "quality-owner",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_profile_requires_approval_and_manifest_pins_all_references(client):
    ids = _project_and_target(client)
    _profile(client, ids)
    _gate(client, ids)

    before_approval = client.post(
        "/platform/run-manifests",
        json={
            "tenant_id": TENANT,
            "project_id": ids["project"],
            "target_version_id": ids["target"],
            "profile_id": ids["profile"],
            "profile_version": "1.0.0",
        },
    )
    assert before_approval.status_code == 422

    _approve_profile_and_gate(client, ids)
    manifest = _manifest(client, ids)

    assert manifest["target_version_id"] == ids["target"]
    assert manifest["quality_profile_version"] == "1.0.0"
    assert manifest["gate_policy_version"] == "1.0.0"
    assert manifest["benchmark_package_version"] == "2.1.0"
    assert manifest["model_version"] == "model-2026-07"
    assert manifest["prompt_version"] == "prompt-7"
    assert manifest["tool_versions"] == {"claims-search": "3.1.0"}
    assert manifest["hard_blocker_metric_ids"] == ["safety.general"]
    assert set(manifest["evidence_requirements"]) == {"input", "final_output", "tool_calls"}
    assert manifest["metric_evidence_requirements"] == {
        "agent.task_adherence": ["tool_calls", "tool_results"],
        "safety.general": [],
    }
    assert manifest["effective_evidence_requirements"] == [
        "input",
        "final_output",
        "tool_calls",
        "tool_results",
    ]
    requirements = {item["metric_id"]: item for item in manifest["metric_requirements"]}
    assert requirements["agent.task_adherence"] == {
        "metric_id": "agent.task_adherence",
        "requirement": "required",
        "source": "explicit_selection",
    }
    assert requirements["safety.general"]["source"] == "explicit_selection"
    compositions = {item["kpi_id"]: item for item in manifest["kpi_compositions"]}
    assert compositions["kpi.agent_effectiveness"]["fixed_gate_weights"] == {
        "agent.task_adherence": 1.0
    }
    assert compositions["kpi.safety_trust"]["fixed_gate_weights"] == {
        "safety.general": 1.0
    }
    assert compositions["kpi.safety_trust"]["hard_blocker_metric_ids"] == ["safety.general"]
    assert manifest["diagnostic_only"] is False
    assert manifest["exact_runtime_identity_required"] is False


def test_manifest_fingerprints_exact_runtime_identity_requirement(client):
    ids = _project_and_target(client)
    _profile(client, ids, exact_runtime_identity_required=True)
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)

    manifest = _manifest(client, ids)

    assert manifest["exact_runtime_identity_required"] is True


def test_metric_evidence_dependencies_participate_in_manifest_hash(client, monkeypatch):
    ids = _project_and_target(client)
    _profile(client, ids)
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)
    original = _manifest(client, ids)

    metric = METRIC_CATALOG["agent.task_adherence"]
    monkeypatch.setitem(
        METRIC_CATALOG,
        "agent.task_adherence",
        metric.model_copy(update={"required_evidence_categories": ["tool_calls"]}),
    )
    changed = _manifest(client, ids)

    assert original["manifest_hash"] != changed["manifest_hash"]
    assert original["manifest_id"] != changed["manifest_id"]
    assert changed["metric_evidence_requirements"]["agent.task_adherence"] == [
        "tool_calls"
    ]
    assert changed["effective_evidence_requirements"] == [
        "input",
        "final_output",
        "tool_calls",
        "tool_results",
    ]


def test_optional_constituent_renormalises_the_gate_composition(client):
    """Demoting a constituent no longer demands hand-written replacement weights.

    The interface can select several checks from one KPI and blocker only some
    of them; it has no way to supply weights, so requiring them made every
    profile authored there impossible to bind to a Gate Policy. The remaining
    required constituents are renormalised with the same rule already used when
    nothing is demoted, and the result is still pinned into the manifest.
    """

    ids = _project_and_target(client)
    _profile(
        client,
        ids,
        metric_ids=["agent.task_adherence", "agent.intent_resolution"],
        metric_requirements={"agent.intent_resolution": "optional"},
        hard_blocker_metric_ids=[],
    )
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)

    manifest = _manifest(client, ids)

    composition = next(
        item
        for item in manifest["kpi_compositions"]
        if item["kpi_id"] == "kpi.agent_effectiveness"
    )
    assert composition["required_gate_constituents"] == ["agent.task_adherence"]
    assert composition["optional_diagnostic_constituents"] == ["agent.intent_resolution"]
    assert composition["fixed_gate_weights"] == {"agent.task_adherence": 1.0}


def test_replacement_gate_composition_is_fixed_and_hashed(client):
    ids = _project_and_target(client)
    _profile(
        client,
        ids,
        metric_ids=["agent.task_adherence", "agent.intent_resolution"],
        metric_requirements={"agent.intent_resolution": "optional"},
        kpi_gate_weights={"kpi.agent_effectiveness": {"agent.task_adherence": 1.0}},
        hard_blocker_metric_ids=[],
    )
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)
    manifest = _manifest(client, ids)

    assert manifest["metric_requirements"] == [
        {
            "metric_id": "agent.intent_resolution",
            "requirement": "optional",
            "source": "quality_contract",
        },
        {
            "metric_id": "agent.task_adherence",
            "requirement": "required",
            "source": "explicit_selection",
        },
    ]
    composition = next(
        item
        for item in manifest["kpi_compositions"]
        if item["kpi_id"] == "kpi.agent_effectiveness"
    )
    assert composition["required_gate_constituents"] == ["agent.task_adherence"]
    assert composition["optional_diagnostic_constituents"] == ["agent.intent_resolution"]
    assert composition["fixed_gate_weights"] == {"agent.task_adherence": 1.0}


def test_optional_hard_blocker_fails_resolution(client):
    ids = _project_and_target(client)
    _profile(
        client,
        ids,
        metric_ids=["agent.task_adherence", "agent.intent_resolution"],
        metric_requirements={"agent.intent_resolution": "optional"},
        kpi_gate_weights={"kpi.agent_effectiveness": {"agent.task_adherence": 0.8}},
        hard_blocker_metric_ids=["agent.intent_resolution"],
    )
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)
    rejected = client.post(
        "/platform/run-manifests",
        json={
            "tenant_id": TENANT,
            "project_id": ids["project"],
            "target_version_id": ids["target"],
            "profile_id": ids["profile"],
            "profile_version": "1.0.0",
            "gate_policy_id": ids["gate"],
            "gate_policy_version": "1.0.0",
        },
    )
    assert rejected.status_code == 422
    assert "hard-blocker metrics must be selected and required" in rejected.json()["detail"]["message"]


def test_replacement_gate_weights_must_sum_to_one(client):
    ids = _project_and_target(client)
    _profile(
        client,
        ids,
        metric_ids=["agent.task_adherence", "agent.intent_resolution"],
        metric_requirements={"agent.intent_resolution": "optional"},
        kpi_gate_weights={"kpi.agent_effectiveness": {"agent.task_adherence": 0.8}},
        hard_blocker_metric_ids=[],
    )
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)
    rejected = client.post(
        "/platform/run-manifests",
        json={
            "tenant_id": TENANT,
            "project_id": ids["project"],
            "target_version_id": ids["target"],
            "profile_id": ids["profile"],
            "profile_version": "1.0.0",
            "gate_policy_id": ids["gate"],
            "gate_policy_version": "1.0.0",
        },
    )
    assert rejected.status_code == 422
    assert "required gate weights must sum to 1.0" in rejected.json()["detail"]["message"]


def test_all_optional_contract_resolves_as_diagnostic_only(client):
    ids = _project_and_target(client)
    _profile(
        client,
        ids,
        metric_ids=["agent.task_adherence", "agent.intent_resolution"],
        metric_requirements={
            "agent.task_adherence": "optional",
            "agent.intent_resolution": "optional",
        },
        hard_blocker_metric_ids=[],
    )
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)
    manifest = _manifest(client, ids)

    assert manifest["diagnostic_only"] is True
    composition = next(
        item
        for item in manifest["kpi_compositions"]
        if item["kpi_id"] == "kpi.agent_effectiveness"
    )
    assert composition["required_gate_constituents"] == []
    assert composition["fixed_gate_weights"] == {}


def test_legacy_default_battery_preserves_requirement_sources(client):
    ids = _project_and_target(client)
    _profile(client, ids, metric_ids=[])
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)
    manifest = _manifest(client, ids)

    requirements = {item["metric_id"]: item for item in manifest["metric_requirements"]}
    assert requirements["agent.task_adherence"]["source"] == "legacy_scenario_primary"
    assert requirements["safety.general"]["source"] == "legacy_cross_cutting"
    # Operations metrics are optional/non-gating by default (Task 1); every other
    # legacy-default metric stays required.
    assert all(
        item["requirement"] == ("optional" if item["metric_id"].startswith("ops.") else "required")
        for item in requirements.values()
    )
    for composition in manifest["kpi_compositions"]:
        if composition["required_gate_constituents"]:
            assert abs(sum(composition["fixed_gate_weights"].values()) - 1.0) < 1e-9


def test_profile_versions_are_immutable_and_do_not_change_existing_manifest(client):
    ids = _project_and_target(client)
    _profile(client, ids)
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)
    first_manifest = _manifest(client, ids)

    _profile(client, ids, version="1.1.0", metric_ids=["llm.relevance", "safety.general"])
    assert client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.1.0/mark-tested?tenant_id={TENANT}",
        json={"mode": "overridden", "note": "fixture profile: no dry run in this test"},
    ).status_code == 200
    assert client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.1.0/validate?tenant_id={TENANT}"
    ).status_code == 200
    assert client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.1.0/approve?tenant_id={TENANT}"
    ).status_code == 200

    original = client.get(
        f"/platform/run-manifests/{first_manifest['manifest_id']}?tenant_id={TENANT}"
    )
    assert original.status_code == 200
    assert original.json()["quality_profile_version"] == "1.0.0"
    assert original.json()["metric_ids"] == ["agent.task_adherence", "safety.general"]

    listed = client.get(f"/platform/run-manifests?tenant_id={TENANT}&project_id={ids['project']}")
    assert listed.status_code == 200
    assert [item["manifest_id"] for item in listed.json()] == [first_manifest["manifest_id"]]

    archived = client.post(
        f"/platform/run-manifests/{first_manifest['manifest_id']}/archive?tenant_id={TENANT}"
    )
    assert archived.status_code == 200
    assert archived.json()["archived"] is True
    assert client.get(
        f"/platform/run-manifests?tenant_id={TENANT}&project_id={ids['project']}"
    ).json() == []
    assert client.get(
        f"/platform/run-manifests/{first_manifest['manifest_id']}?tenant_id={TENANT}"
    ).status_code == 200


def test_bound_manifest_controls_the_saved_evaluation_snapshot(client):
    ids = _project_and_target(client)
    _profile(client, ids, metric_ids=["llm.relevance", "safety.general"])
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)
    manifest = _manifest(client, ids)

    experiment = client.post(
        "/evaluation/experiments",
        json={
            "experiment_id": ids["experiment"],
            "name": "Claims candidate",
            "dataset_version": "claims-v2",
            "target_endpoint": "ignored-by-manifest",
            "scenario": "llm_core",
            "tenant_id": TENANT,
        },
    )
    assert experiment.status_code == 201, experiment.text
    assert client.post(
        f"/platform/experiments/{ids['experiment']}/run-manifest",
        json={"manifest_id": manifest["manifest_id"]},
    ).status_code == 200
    rows = client.post(
        f"/evaluation/experiments/{ids['experiment']}/rows",
        json=[
            {
                "row_id": "claims-case-1",
                "query": "What documents are needed?",
                "response": "Please provide the requested documents.",
                "expected_response": "Please provide the requested documents.",
            }
        ],
    )
    assert rows.status_code == 201, rows.text

    version = client.post(
        f"/evaluation/experiments/{ids['experiment']}/versions",
        json={"created_by": "quality-owner"},
    )
    assert version.status_code == 201, version.text
    payload = version.json()["contract_json"]
    assert payload["run_manifest_id"] == manifest["manifest_id"]
    assert payload["metrics"] == ["llm.relevance", "safety.general"]
    assert payload["run_manifest_hash"] == manifest["manifest_hash"]
    assert payload["metric_evidence_requirements"] == (
        manifest["metric_evidence_requirements"]
    )
    assert payload["effective_evidence_requirements"] == (
        manifest["effective_evidence_requirements"]
    )


def test_contract_may_gate_on_a_metric_the_catalog_calls_diagnostic(client):
    """A hard blocker is an elevation, so a catalog default must not outrank it.

    Every profile the shipped templates produce looks like this: the metric is
    selected and named a hard blocker, and ``metric_requirements`` is empty.
    While the catalog's diagnostic-by-default flag was checked first, such a
    profile could be created and approved and then failed to resolve at the last
    step, reporting only that "hard-blocker metrics must be selected and
    required" for the metric the contract had just named.
    """
    from proofgrove.platform.resolver import _catalog_diagnostic_default

    assert _catalog_diagnostic_default("quality.task_completion"), (
        "fixture assumes this metric is diagnostic by default; pick another if that changes"
    )

    ids = _project_and_target(client)
    _profile(
        client,
        ids,
        metric_ids=["quality.task_completion"],
        metric_requirements={},
        hard_blocker_metric_ids=["quality.task_completion"],
    )
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)

    response = client.post(
        "/platform/run-manifests",
        json={
            "tenant_id": TENANT,
            "project_id": ids["project"],
            "target_version_id": ids["target"],
            "profile_id": ids["profile"],
            "profile_version": "1.0.0",
            "resolved_by": "quality-owner",
        },
    )
    assert response.status_code == 201, response.text
    manifest = response.json()
    assert manifest["hard_blocker_metric_ids"] == ["quality.task_completion"]
    requirements = {
        item["metric_id"]: item["requirement"]
        for item in manifest["metric_requirements"]
    }
    assert requirements["quality.task_completion"] == "required"


def test_unresolvable_contract_explains_itself_in_the_public_error_shape(client):
    """The reason must survive the browser-facing proxy, which drops string details.

    A bare ``detail: "..."`` string is refused by the UI's error contract, so the
    user saw only generic "some information is invalid" copy naming no field.
    """
    ids = _project_and_target(client)
    # Contradictory on purpose: named a blocker, declared optional.
    _profile(
        client,
        ids,
        metric_ids=["quality.task_completion"],
        metric_requirements={"quality.task_completion": "optional"},
        hard_blocker_metric_ids=["quality.task_completion"],
    )
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)

    response = client.post(
        "/platform/run-manifests",
        json={
            "tenant_id": TENANT,
            "project_id": ids["project"],
            "target_version_id": ids["target"],
            "profile_id": ids["profile"],
            "profile_version": "1.0.0",
            "resolved_by": "quality-owner",
        },
    )
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert isinstance(detail, dict), "a bare string never reaches the browser"
    assert detail["code"] == "CONTRACT_UNRESOLVABLE"
    assert "quality.task_completion" in detail["message"]
    assert detail["recovery"]


def test_a_manifest_remembers_its_target_name(client):
    """The name is snapshotted, not looked up later.

    A contract outlives its target. Resolving the name live meant an archived or
    renamed target left the catalog showing a raw `kagent-…` id.
    """
    ids = _project_and_target(client)
    _profile(client, ids)
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)
    manifest = _manifest(client, ids)

    assert manifest["target_name"], "the manifest must carry a display name"
    assert manifest["target_name"] != manifest["target_id"]


def test_approve_blocked_while_not_tested(client):
    ids = _ids()
    _project(client, ids)
    _profile(client, ids)
    assert client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/validate?tenant_id={TENANT}"
    ).status_code == 200
    blocked = client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/approve?tenant_id={TENANT}"
    )
    assert blocked.status_code == 409, blocked.text
    assert "Not tested" in blocked.text


def test_mark_tested_then_approve(client):
    ids = _ids()
    _project(client, ids)
    _profile(client, ids)
    # TESTED has to be earned now: it names the run whose stored evidence was
    # scored against these checks, rather than asserting a dry run happened.
    unevidenced = client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/mark-tested?tenant_id={TENANT}",
        json={"mode": "tested"},
    )
    assert unevidenced.status_code == 422, unevidenced.text
    assert unevidenced.json()["detail"]["code"] == "dry_run_required"

    missing_run = client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/mark-tested?tenant_id={TENANT}",
        json={"mode": "tested", "source_run_id": "run-that-does-not-exist"},
    )
    assert missing_run.status_code == 422, missing_run.text
    assert missing_run.json()["detail"]["code"] == "dry_run_not_found"

    # This fixture never ran anything, so there is no run to point at. The
    # audited override is the honest route to approval without a dry run.
    marked = client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/mark-tested?tenant_id={TENANT}",
        json={"mode": "overridden", "note": "no dry run performed for this fixture"},
    )
    assert marked.status_code == 200, marked.text
    assert marked.json()["test_status"] == "overridden"
    assert marked.json()["tested_by"]
    assert client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/validate?tenant_id={TENANT}"
    ).status_code == 200
    approved = client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/approve?tenant_id={TENANT}"
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "approved"


def test_override_requires_note_and_unlocks_approve(client):
    ids = _ids()
    _project(client, ids)
    _profile(client, ids)
    missing_note = client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/mark-tested?tenant_id={TENANT}",
        json={"mode": "overridden"},
    )
    assert missing_note.status_code == 409, missing_note.text
    overridden = client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/mark-tested?tenant_id={TENANT}",
        json={"mode": "overridden", "note": "No compatible published dataset yet"},
    )
    assert overridden.status_code == 200, overridden.text
    assert overridden.json()["test_status"] == "overridden"
    assert client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/validate?tenant_id={TENANT}"
    ).status_code == 200
    assert client.post(
        f"/platform/quality-profiles/{ids['profile']}/versions/1.0.0/approve?tenant_id={TENANT}"
    ).status_code == 200


def test_hard_blocker_outside_every_kpi_still_resolves(client):
    """A blocker needs no KPI composition, because it gates by veto.

    Seventeen catalogue metrics — every content-safety, ops and nlp one —
    constitute no KPI, so requiring a composition made them impossible to
    block on. The manifest carries the blocker at run level for the engine's
    veto instead.
    """

    ids = _project_and_target(client)
    _profile(
        client,
        ids,
        metric_ids=["safety.violence"],
        hard_blocker_metric_ids=["safety.violence"],
    )
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)

    manifest = _manifest(client, ids)

    assert manifest["hard_blocker_metric_ids"] == ["safety.violence"]
    assert manifest["kpi_compositions"] == []
    assert manifest["diagnostic_only"] is False
    assert manifest["metric_requirements"] == [
        {
            "metric_id": "safety.violence",
            "requirement": "required",
            "source": "explicit_selection",
        }
    ]


def test_required_non_blocker_outside_every_kpi_is_still_refused(client):
    """The veto exemption is for blockers only, not for required metrics.

    A required metric that neither composes a KPI nor blocks would be scored
    and then silently ignored by the gate, which is the accidental-pass the
    original guard exists to prevent.
    """

    ids = _project_and_target(client)
    _profile(
        client,
        ids,
        metric_ids=["nlp.rouge"],
        metric_requirements={"nlp.rouge": "required"},
        hard_blocker_metric_ids=[],
    )
    _gate(client, ids)
    _approve_profile_and_gate(client, ids)

    rejected = client.post(
        "/platform/run-manifests",
        json={
            "tenant_id": TENANT,
            "project_id": ids["project"],
            "target_version_id": ids["target"],
            "profile_id": ids["profile"],
            "profile_version": "1.0.0",
            "gate_policy_id": ids["gate"],
            "gate_policy_version": "1.0.0",
        },
    )
    assert rejected.status_code == 422
    assert "no release-gate composition" in rejected.json()["detail"]["message"]
