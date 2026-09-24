"""Versioned fair-comparison controls; historical hashes remain recorded."""

from types import SimpleNamespace

import pytest

from evalhub.evaluation.lineage import (
    COMPARISON_BASIS_VERSION,
    build_lineage,
    compute_comparison_basis_hash,
    compute_comparison_basis_hash_v1,
    compute_experiment_version_id,
)
from evalhub.evaluation.models import recorded_comparison_basis
from evalhub.evaluation.sample_data import SAMPLE_EXPERIMENTS, get_sample_rows
from evalhub.evaluation.scenario_router import build_evaluator_configs
from evalhub.platform.contracts import EvaluationProject, QualityProfileVersion, TargetVersion, VersionLifecycle
from evalhub.platform.resolver import resolve_run_manifest
from evalhub.settings import settings


def _exp_rows_metrics():
    exp = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")
    metrics, _configs, _kpis = build_evaluator_configs(exp)
    return exp, rows, [m.metric_id for m in metrics]


def test_basis_version_constant_is_v3():
    assert COMPARISON_BASIS_VERSION == "v3"


def test_current_hash_changes_when_only_judge_config_changes():
    exp, rows, ids = _exp_rows_metrics()
    base = compute_comparison_basis_hash(exp, rows, ids)

    hotter = exp.model_copy(update={"judge_temperature": exp.judge_temperature + 0.5})
    assert compute_comparison_basis_hash(hotter, rows, ids) != base

    other_model = exp.model_copy(update={"judge_model": "some-other-judge-model"})
    assert compute_comparison_basis_hash(other_model, rows, ids) != base


def test_current_hash_changes_when_only_evaluator_versions_change():
    exp, rows, ids = _exp_rows_metrics()
    manifest_a = _manifest().model_copy(update={"evaluator_refs": {"llm.correctness": "eval@1.0.0"}})
    manifest_b = manifest_a.model_copy(update={"evaluator_refs": {"llm.correctness": "eval@2.0.0"}})
    hash_a = compute_comparison_basis_hash(exp, rows, ids, manifest=manifest_a)
    hash_b = compute_comparison_basis_hash(exp, rows, ids, manifest=manifest_b)
    assert hash_a != hash_b


# Golden hash captured from the pre-v2 v1 implementation over the sample
# experiment. Pins the v1 wire format so any edit to compute_comparison_basis_hash_v1
# (or the sample inputs it hashes) is caught instead of silently rehashing
# historical runs. Regenerate only on a deliberate, documented v1 change.
#
# Regenerated when the two token-count halves joined the default metric set.
# The algorithm is untouched; the basis folds in the active metric list, so
# measuring something new means runs before and after form separate comparison
# cohorts. That is the basis working: two runs measuring different things were
# never like-for-like.
_V1_GOLDEN = "0ef982ff6d9d04daccdfd4edd2c0b1049dabad4f67f3f7a8a39f4042dd95e0da"


def test_v1_historical_hash_is_unchanged_and_ignores_judge():
    exp, rows, ids = _exp_rows_metrics()
    v1 = compute_comparison_basis_hash_v1(exp, rows, ids)

    # Byte-for-byte guard against any drift in the historical v1 algorithm.
    assert v1 == _V1_GOLDEN

    # The preserved v1 algorithm never folded judge config into the basis, so a
    # historical run's recorded hash stays stable regardless of judge changes.
    hotter = exp.model_copy(update={"judge_temperature": exp.judge_temperature + 0.5})
    assert compute_comparison_basis_hash_v1(hotter, rows, ids) == v1

    # New runs live in a different hash space than the historical v1 value.
    assert compute_comparison_basis_hash(exp, rows, ids) != v1


def test_build_lineage_stamps_basis_version_alongside_hash():
    exp, _rows, _ids = _exp_rows_metrics()
    lineage = build_lineage(
        exp,
        settings,
        "exp-abc123",
        comparison_basis_hash="deadbeef",
    )
    assert lineage.comparison_basis_hash == "deadbeef"
    assert lineage.comparison_basis_version == COMPARISON_BASIS_VERSION

    # A run with no recorded basis carries no version either.
    unstamped = build_lineage(exp, settings, "exp-abc123")
    assert unstamped.comparison_basis_hash is None
    assert unstamped.comparison_basis_version is None


def _manifest(**target_changes):
    project = EvaluationProject(project_id="project", tenant_id="tenant-test", name="Test", system_type="llm", owner="test")
    target = TargetVersion(
        target_version_id="target-v1", target_id="target", project_id="project", tenant_id="tenant-test",
        name="Test", version="1", endpoint="https://example.test", model_version="model-v1",
        prompt_version="prompt-v1", tool_versions={"search": "1"},
    ).model_copy(update=target_changes)
    profile = QualityProfileVersion(
        profile_id="profile", version="1", tenant_id="tenant-test", name="Test",
        scenario="llm_core", status=VersionLifecycle.APPROVED,
    )
    return resolve_run_manifest(
        project=project, target=target, profile=profile, gate_policy=None,
        benchmark_package_id="benchmark", benchmark_package_version="1", benchmark_family="qa",
        judge_config={"model": "judge-v1"}, resolved_by="test",
    )


@pytest.mark.parametrize("change", [
    {"target_version_id": "target-v2", "version": "2", "endpoint": "https://candidate.test"},
    {"model_version": "model-v2"},
    {"prompt_version": "prompt-v2"},
    {"tool_versions": {"search": "2"}},
])
def test_target_variants_share_comparison_basis_but_not_reproducibility_identity(change):
    exp, rows, ids = _exp_rows_metrics()
    baseline, candidate = _manifest(), _manifest(**change)
    assert baseline.manifest_hash != candidate.manifest_hash
    assert baseline.manifest_id != candidate.manifest_id
    assert compute_comparison_basis_hash(exp, rows, ids, manifest=baseline) == compute_comparison_basis_hash(exp, rows, ids, manifest=candidate)
    assert compute_experiment_version_id(exp, ids, run_manifest_hash=baseline.manifest_hash) != compute_experiment_version_id(exp, ids, run_manifest_hash=candidate.manifest_hash)


@pytest.mark.parametrize("control", [
    {"quality_profile_version": "2"},
    {"gate_policy_id": "policy", "gate_policy_version": "2"},
    {"benchmark_package_version": "2"},
    {"kpi_threshold_overrides": {"quality": {"pass": 0.99}}},
    {"hard_blocker_metric_ids": ["llm.correctness"]},
    {"evidence_requirements": ["trace"]},
    {"effective_evidence_requirements": ["trace"]},
    {"exact_runtime_identity_required": True},
    {"approver_roles": ["eval-hub-approver"]},
    {"review_trigger_gates": []},
    {"resolved_evaluation_scope": "full_execution"},
    {"metric_pack_refs": ["quality@2"]},
    {"source_template_snapshot": {"threshold": 0.99}},
])
def test_manifest_evaluation_controls_still_change_comparison_basis(control):
    exp, rows, ids = _exp_rows_metrics()
    baseline = _manifest()
    changed = type(baseline).model_validate({**baseline.model_dump(), **control})
    # Same manifest identity deliberately proves the actual controls are hashed.
    assert compute_comparison_basis_hash(exp, rows, ids, manifest=baseline) != compute_comparison_basis_hash(exp, rows, ids, manifest=changed)


def test_dataset_and_named_tool_selection_remain_comparison_controls():
    exp, rows, ids = _exp_rows_metrics()
    baseline = compute_comparison_basis_hash(exp, rows, ids)
    for changes in ({"dataset_version": "different"}, {"selected_tool_ids": []}, {"selected_tool_ids": ["search"]}):
        assert compute_comparison_basis_hash(exp.model_copy(update=changes), rows, ids) != baseline
    selected = exp.model_copy(update={"selected_tool_ids": ["search", "lookup"]})
    reordered = selected.model_copy(update={"selected_tool_ids": ["lookup", "search"]})
    assert compute_comparison_basis_hash(selected, rows, ids) == compute_comparison_basis_hash(reordered, rows, ids)


def test_recorded_v2_and_v3_bases_stay_incompatible_even_with_same_hash():
    historical = SimpleNamespace(lineage=SimpleNamespace(comparison_basis_hash="same", comparison_basis_version="v2"))
    current = SimpleNamespace(lineage=SimpleNamespace(comparison_basis_hash="same", comparison_basis_version=COMPARISON_BASIS_VERSION))
    assert recorded_comparison_basis(historical) != recorded_comparison_basis(current)
