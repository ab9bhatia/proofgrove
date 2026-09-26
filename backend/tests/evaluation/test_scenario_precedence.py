"""One precedence order decides a run's scenario, and it is pinned here.

Four sources claim to know a run's scenario (resolved configuration, run
wiring, target declaration, dataset label). ``evaluation.scenario_policy``
ranks them once; both the ad-hoc run path and the governed manifest path go
through it. These tests pin the ranking, the single default for a
missing/unknown label, and — because ``scenario`` is part of the experiment
identity hash — that the derived identity is byte-for-byte what it was before
the consolidation.
"""

import pytest

from proofgrove.evaluation.enums import Scenario
from proofgrove.evaluation.run_service import stable_experiment_id
from proofgrove.evaluation.scenario_policy import DEFAULT_SCENARIO, resolve_scenario
from proofgrove.platform.contracts import (
    EvaluationProject,
    QualityProfileVersion,
    TargetType,
    TargetVersion,
    VersionLifecycle,
)
from proofgrove.platform.resolver import ContractResolutionError, resolve_run_manifest


@pytest.mark.parametrize(
    ("sources", "expected"),
    [
        # 1. Resolved configuration outranks everything below it.
        (
            {
                "configured": Scenario.RAG,
                "response_source": "llm",
                "target_type": "agent",
            },
            Scenario.RAG,
        ),
        # 2. Run wiring: an LLM target cannot produce retrieval/tool evidence,
        #    so it outranks the target declaration.
        (
            {"response_source": "llm", "target_type": "agent"},
            Scenario.LLM_CORE,
        ),
        # 3. A target's own declared scenario outranks its type.
        (
            {"target_scenario": "rag", "target_type": "agent"},
            Scenario.RAG,
        ),
        ({"target_type": "agent"}, Scenario.AGENTIC),
        ({"target_type": "rag_system"}, Scenario.RAG),
        # A non-"llm" response source never speaks at all.
        ({"response_source": "agent", "target_type": "rag_system"}, Scenario.RAG),
        ({"response_source": "baseline", "target_type": "agent"}, Scenario.AGENTIC),
    ],
)
def test_precedence_order_is_configuration_then_wiring_then_target(
    sources, expected
):
    assert resolve_scenario(**sources) is expected


@pytest.mark.parametrize(
    "sources",
    [
        {},
        {"target_type": None},
        {"target_type": ""},
        {"target_type": "endpoint"},
        {"target_type": "application"},
        {"response_source": "agent"},
    ],
)
def test_missing_or_unknown_label_resolves_to_one_default(sources):
    """One default, not two.

    The API call site used to substitute ``"agent"`` (i.e. ``agentic``) for a
    missing label. ``llm_core`` wins the reconciliation: it is the only scenario
    whose metrics need nothing beyond a query and a response, so an
    undeclared run is never asked for retrieval or tool evidence it has no
    reason to have.
    """

    assert DEFAULT_SCENARIO is Scenario.LLM_CORE
    assert resolve_scenario(**sources) is Scenario.LLM_CORE


# --- governed manifest path -------------------------------------------------


def _project() -> EvaluationProject:
    return EvaluationProject(
        project_id="project-scenario",
        tenant_id="tenant-scenario",
        name="Scenario precedence",
        system_type="agent",
        owner="qa",
    )


def _target(*, target_type: TargetType, configuration: dict | None = None) -> TargetVersion:
    return TargetVersion(
        target_id="target-scenario",
        project_id="project-scenario",
        tenant_id="tenant-scenario",
        name="Target",
        version="1.0.0",
        endpoint="https://example.invalid/agent",
        target_type=target_type,
        configuration=configuration or {},
    )


def _profile(*, scenario: Scenario | None) -> QualityProfileVersion:
    return QualityProfileVersion(
        profile_id="profile-scenario",
        version="1.0.0",
        tenant_id="tenant-scenario",
        project_id="project-scenario",
        name="Profile",
        status=VersionLifecycle.APPROVED,
        scenario=scenario,
    )


def _manifest_scenario(
    *,
    profile_scenario: Scenario | None,
    target_type: TargetType,
    target_configuration: dict | None = None,
) -> Scenario:
    manifest = resolve_run_manifest(
        project=_project(),
        target=_target(target_type=target_type, configuration=target_configuration),
        profile=_profile(scenario=profile_scenario),
        gate_policy=None,
        benchmark_package_id=None,
        benchmark_package_version=None,
        benchmark_family=None,
        judge_config={},
        resolved_by="tester",
    )
    return manifest.scenario


@pytest.mark.parametrize(
    ("profile_scenario", "target_type", "target_configuration", "expected"),
    [
        (Scenario.LLM_CORE, TargetType.AGENT, None, Scenario.LLM_CORE),
        (None, TargetType.AGENT, {"scenario": "rag"}, Scenario.RAG),
        (None, TargetType.AGENT, None, Scenario.AGENTIC),
        (None, TargetType.RAG_SYSTEM, None, Scenario.RAG),
        (None, TargetType.ENDPOINT, None, Scenario.LLM_CORE),
        (None, TargetType.APPLICATION, None, Scenario.LLM_CORE),
    ],
)
def test_governed_manifest_uses_the_same_precedence(
    profile_scenario, target_type, target_configuration, expected
):
    assert (
        _manifest_scenario(
            profile_scenario=profile_scenario,
            target_type=target_type,
            target_configuration=target_configuration,
        )
        is expected
    )


def test_resolve_run_manifest_accepts_equivalent_tenant_spellings(monkeypatch):
    """The project's namespace spelling and the target's gateway-slug spelling
    of the same tenant must both resolve — ``tenants_match`` is the same
    normalization the tenant-scoped store queries use, not a raw ``==``.
    """
    from proofgrove.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", "tenant-scenario")
    project = _project()
    target = _target(target_type=TargetType.AGENT).model_copy(update={"tenant_id": "scenario"})

    manifest = resolve_run_manifest(
        project=project,
        target=target,
        profile=_profile(scenario=None),
        gate_policy=None,
        benchmark_package_id=None,
        benchmark_package_version=None,
        benchmark_family=None,
        judge_config={},
        resolved_by="tester",
    )
    assert manifest.scenario is Scenario.AGENTIC


def test_resolve_run_manifest_rejects_a_genuinely_foreign_tenant():
    project = _project()
    target = _target(target_type=TargetType.AGENT).model_copy(update={"tenant_id": "tenant-other"})

    with pytest.raises(ContractResolutionError, match="does not belong to the requested"):
        resolve_run_manifest(
            project=project,
            target=target,
            profile=_profile(scenario=None),
            gate_policy=None,
            benchmark_package_id=None,
            benchmark_package_version=None,
            benchmark_family=None,
            judge_config={},
            resolved_by="tester",
        )


# --- experiment identity ----------------------------------------------------


# Literal ids captured from the pre-consolidation derivation. They are pinned,
# not recomputed: a change here means an existing named evaluation stops
# grouping with its own run history.
@pytest.mark.parametrize(
    ("response_source", "configured", "expected_scenario", "experiment_id"),
    [
        ("agent", None, Scenario.LLM_CORE, "exp-6903bf016547422d87f4"),
        ("agent", Scenario.RAG, Scenario.RAG, "exp-f22c38ce01922ac6cb68"),
        ("agent", Scenario.AGENTIC, Scenario.AGENTIC, "exp-b05b9b93482c39d311f7"),
        ("llm", None, Scenario.LLM_CORE, "exp-1023dc2a0ed5c5cb6f06"),
        ("baseline", None, Scenario.LLM_CORE, "exp-31205064f6168f2a8131"),
        ("provided", None, Scenario.LLM_CORE, "exp-14b34ae30eaf02951fd5"),
        ("llm", Scenario.RAG, Scenario.RAG, "exp-deedae8c2201577d698a"),
    ],
)
def test_experiment_identity_is_unchanged_by_the_consolidation(
    response_source, configured, expected_scenario, experiment_id
):
    scenario = resolve_scenario(
        configured=configured,
        response_source=response_source,
    )
    assert scenario is expected_scenario
    assert (
        stable_experiment_id(
            tenant_id="tenant-x",
            evaluation_name="nightly",
            dataset_name="ds_pin",
            response_source=response_source,
            target_endpoint="agent://target",
            target_model="model-a",
            scenario=scenario,
        )
        == experiment_id
    )
