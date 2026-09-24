"""Tests for evaluation engine with generic samples."""

import pytest

from evalhub.evaluation.adapters.dispatcher import AdapterDispatchJudge
from evalhub.evaluation.engine import EvaluationEngine, _row_defect_rate
from evalhub.evaluation.enums import (
    CoverageLabel,
    GateResult,
    MetricApplicability,
    MetricRequirement,
    MetricRequirementSource,
    MetricStatus,
    RunStatus,
    ScoreSubjectKind,
    TargetIdentityStatus,
    UnscoredReason,
    VerdictStatus,
)
from evalhub.evaluation.judge import MockJudge, set_row_overrides
from evalhub.evaluation.kpis import KPI_CATALOG
from evalhub.evaluation.lineage import build_lineage, compute_comparison_basis_hash
from evalhub.evaluation.llm_judge import JudgeResult
from evalhub.evaluation.models import (
    EvaluationRow,
    EvaluatorConfig,
    ExperimentDefinition,
    MetricResult,
    RunLineage,
    ToolCall,
)
from evalhub.evaluation.sample_data import SAMPLE_EXPERIMENTS, get_sample_rows
from evalhub.platform.contracts import (
    ResolvedKpiComposition,
    ResolvedMetricRequirement,
    ResolvedRunManifest,
    TargetType,
)
from evalhub.settings import Settings


def test_duplicate_example_ids_are_rejected_before_scoring():
    rows = get_sample_rows("exp-llm-core-v1")[:2]
    rows = [rows[0], rows[1].model_copy(update={"row_id": rows[0].row_id})]

    with pytest.raises(ValueError, match="Duplicate example IDs"):
        EvaluationEngine(judge=MockJudge()).execute(SAMPLE_EXPERIMENTS[0], rows)


def test_historical_lineage_does_not_infer_target_identity_status():
    current = EvaluationEngine(judge=MockJudge()).execute(
        SAMPLE_EXPERIMENTS[0],
        get_sample_rows("exp-llm-core-v1")[:1],
    )
    payload = current.lineage.model_dump()
    payload.pop("target_identity_status")

    historical = RunLineage.model_validate(payload)

    assert historical.target_identity_status is None


def test_comparison_basis_allows_target_changes_but_not_dataset_changes():
    experiment = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    metrics = ["llm.correctness"]
    baseline = compute_comparison_basis_hash(experiment, rows, metrics)

    changed_target = experiment.model_copy(
        update={
            "target_endpoint": "https://candidate.example.test/v1",
            "target_model": "candidate-model",
            "target_version": "candidate-revision",
        }
    )
    assert compute_comparison_basis_hash(changed_target, rows, metrics) == baseline

    changed_dataset = experiment.model_copy(update={"dataset_version": "other.v2"})
    assert compute_comparison_basis_hash(changed_dataset, rows, metrics) != baseline


def test_agent_tools_snapshot_is_descriptive_and_does_not_break_comparability():
    # #3032: the snapshot records what the agent declared at launch, so a reader
    # of a failed tool metric can tell "never offered" from "offered, not
    # called". It must stay descriptive — two runs differing only in the agent's
    # catalogue are still comparable, unlike two runs with different tool
    # scoping, which are deliberately not.
    experiment = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    metrics = ["llm.correctness"]
    baseline = compute_comparison_basis_hash(experiment, rows, metrics)

    settings = Settings(judge_mode="mock")
    # The engine cannot know the agent's inventory, so the lineage it builds
    # leaves the field absent rather than guessing an empty list.
    lineage = build_lineage(experiment, settings, "exp-version-1")
    assert lineage.agent_tools_snapshot is None
    assert lineage.assignment_id is None
    assert lineage.assignment_version is None

    stamped = build_lineage(
        experiment,
        settings,
        "exp-version-1",
        assignment_id="claims-release",
        assignment_version="1.0.0",
    )
    assert stamped.assignment_id == "claims-release"
    assert stamped.assignment_version == "1.0.0"

    # run_service fills it from readiness, the same way it fills the evidence
    # requirements beside it. Simulate that enrichment and confirm it persists.
    catalogue = ["search", "summarize", "delete_db"]
    lineage.agent_tools_snapshot = catalogue
    assert RunLineage.model_validate(lineage.model_dump(mode="json")).agent_tools_snapshot == catalogue

    # Capturing it changes no hash: it rides the lineage, not the contract.
    assert compute_comparison_basis_hash(experiment, rows, metrics) == baseline
    # And it stays off the experiment contract, whose fields are stamped
    # immutably — an agent gaining a tool must not read as a contract change.
    assert "agent_tools_snapshot" not in ExperimentDefinition.model_fields


def test_llm_core_run_produces_results():
    engine = EvaluationEngine(judge=MockJudge())
    exp = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")
    result = engine.execute(exp, rows)

    assert result.run_id
    assert len(result.metric_results) > 0
    assert len(result.kpi_results) >= 3
    assert result.overall_gate is None
    assert all(metric.metric_status != MetricStatus.SCORED for metric in result.metric_results)


def test_direct_mock_is_disclosed_and_cannot_affect_a_gate():
    result = EvaluationEngine(judge=MockJudge()).execute(
        SAMPLE_EXPERIMENTS[0],
        get_sample_rows("exp-llm-core-v1")[:1],
        metric_ids=["llm.correctness"],
    )

    metric = result.metric_results[0]
    assert metric.requested_scorer == "deepeval"
    assert metric.executed_scorer == "mock"
    assert metric.metric_status == MetricStatus.UNSCORED
    assert metric.unscored_reason == UnscoredReason.SIMULATED
    assert metric.score is None
    assert metric.threshold_result is None
    assert result.kpi_results[0].coverage_label == CoverageLabel.INCOMPLETE
    assert result.overall_gate is None
    assert result.root_cause is not None
    assert result.root_cause.failing_metrics == []
    assert result.review_queue == []


def test_rag_run():
    engine = EvaluationEngine(judge=MockJudge())
    exp = SAMPLE_EXPERIMENTS[1]
    rows = get_sample_rows("exp-rag-v1")
    result = engine.execute(exp, rows)
    assert any(k.kpi_id == "kpi.retrieval_quality" for k in result.kpi_results)


def test_agentic_run():
    engine = EvaluationEngine(judge=MockJudge())
    exp = SAMPLE_EXPERIMENTS[2]
    rows = get_sample_rows("exp-agentic-v1")
    result = engine.execute(exp, rows)
    assert any(k.kpi_id == "kpi.agent_effectiveness" for k in result.kpi_results)


class _BoomJudge:
    """Judge that always raises, to exercise per-metric fault isolation."""

    def evaluate(self, config: EvaluatorConfig, row: EvaluationRow):
        raise RuntimeError("judge exploded")


def test_run_isolates_a_failing_judge(caplog):
    # P1-02: a judge exception must not abort the run; every metric is recorded
    # as errored and the run still completes.
    engine = EvaluationEngine(judge=_BoomJudge())
    rows = get_sample_rows("exp-llm-core-v1")
    result = engine.execute(SAMPLE_EXPERIMENTS[0], rows)

    assert result.status == RunStatus.COMPLETED
    assert len(result.metric_results) > 0
    # ops.token_efficiency never reaches the judge without token telemetry —
    # it is unscored (telemetry_not_captured), not judged or errored.
    judged = [mr for mr in result.metric_results if mr.metric_id != "ops.token_efficiency"]
    unjudged = [mr for mr in result.metric_results if mr.metric_id == "ops.token_efficiency"]
    assert judged
    assert all(mr.error_message == "judge exploded" for mr in judged)
    assert caplog.records
    assert "judge exploded" not in caplog.text
    assert all(mr.metric_status == MetricStatus.TECHNICAL_ERROR for mr in judged)
    assert all(mr.metric_status == MetricStatus.UNSCORED for mr in unjudged)
    assert all(mr.unscored_reason == UnscoredReason.TELEMETRY_NOT_CAPTURED for mr in unjudged)
    assert all(mr.threshold_result is None for mr in result.metric_results)
    assert all(mr.normalised_score is None for mr in result.metric_results)
    assert result.verdict_status == VerdictStatus.INCONCLUSIVE
    assert result.overall_gate is None
    assert all(kpi.composite_score is None for kpi in result.kpi_results)
    assert all(kpi.gate_result is None for kpi in result.kpi_results)


class _OptionalFailureJudge:
    def evaluate(self, config: EvaluatorConfig, row: EvaluationRow):
        if config.metric_id == "llm.coherence":
            raise RuntimeError("optional evaluator failed")
        return JudgeResult(
            score=5.0,
            label="good",
            rationale="scored",
            prompt_tokens=1,
            completion_tokens=1,
        )


class _ScoredTestJudge:
    """Test scorer retaining deterministic overrides without production mock semantics."""

    def evaluate(self, config: EvaluatorConfig, row: EvaluationRow):
        result = MockJudge().evaluate(config, row)
        result.executed_scorer = "native"
        return result


def _two_metric_manifest(
    *,
    diagnostic_only: bool = False,
    exact_runtime_identity_required: bool = False,
) -> ResolvedRunManifest:
    required = [] if diagnostic_only else ["llm.relevance"]
    optional = ["llm.coherence", "llm.relevance"] if diagnostic_only else ["llm.coherence"]
    return ResolvedRunManifest(
        manifest_id="manifest-test",
        manifest_hash="hash-test",
        tenant_id="tenant-test",
        project_id="project-test",
        target_version_id="target-version-test",
        target_id="target-test",
        target_version="1",
        target_endpoint="http://target.test",
        target_type=TargetType.APPLICATION,
        environment="test",
        quality_profile_id="profile-test",
        quality_profile_version="1",
        scenario="llm_core",
        metric_ids=["llm.coherence", "llm.relevance"],
        metric_requirements=[
            ResolvedMetricRequirement(
                metric_id=metric_id,
                requirement=(MetricRequirement.OPTIONAL if diagnostic_only or metric_id == "llm.coherence" else MetricRequirement.REQUIRED),
                source=MetricRequirementSource.QUALITY_CONTRACT,
            )
            for metric_id in ["llm.coherence", "llm.relevance"]
        ],
        kpi_compositions=[
            ResolvedKpiComposition(
                kpi_id="kpi.response_quality",
                required_gate_constituents=required,
                optional_diagnostic_constituents=optional,
                fixed_gate_weights={} if diagnostic_only else {"llm.relevance": 1.0},
                thresholds={"pass": 0.8, "warn": 0.6, "fail": 0.6},
            )
        ],
        diagnostic_only=diagnostic_only,
        exact_runtime_identity_required=exact_runtime_identity_required,
    )


def test_weighted_composite_is_inconclusive_when_a_required_constituent_never_scores():
    """A required constituent that's SCORED-but-scoreless must not deflate the composite.

    Two required constituents share the weighted composite. ``llm.relevance``
    scores cleanly on both rows; ``llm.correctness`` is SCORED (so
    ``required_complete`` is satisfied) but never produces a usable
    ``normalised_score`` on either row -- the same edge case
    ``_row_defect_rate`` guards against, here on the weighted (non
    zero-tolerance) path. The old code silently `continue`d past the
    scoreless metric without renormalising the remaining weight, so the
    composite came out as a deflated 0.25 (`llm.relevance`'s own weighted
    contribution) instead of ``None``.
    """
    rows = get_sample_rows("exp-llm-core-v1")[:2]
    engine = EvaluationEngine(judge=_OptionalFailureJudge())
    composition = {
        "kpi.response_quality": {
            "required": ["llm.correctness", "llm.relevance"],
            "optional": [],
            "weights": {"llm.correctness": 0.75, "llm.relevance": 0.25},
            "thresholds": {"pass": 0.8, "warn": 0.6, "fail": 0.6},
            "hard_blockers": [],
        }
    }
    definition = KPI_CATALOG["kpi.response_quality"]
    results = []
    for row in rows:
        results.append(
            MetricResult(
                metric_id="llm.relevance",
                evaluator_instance_id="inst-1",
                run_id="run-1",
                row_id=row.row_id,
                score=1.0,
                normalised_score=1.0,
                passed=True,
                threshold=0.8,
                threshold_result=GateResult.PASS,
                dataset_version="v1",
            )
        )
        # SCORED, with a raw score, but no usable normalised_score.
        results.append(
            MetricResult(
                metric_id="llm.correctness",
                evaluator_instance_id="inst-1",
                run_id="run-1",
                row_id=row.row_id,
                metric_status=MetricStatus.SCORED,
                score=1200.0,
                normalised_score=None,
                passed=None,
                threshold=0.8,
                threshold_result=None,
                dataset_version="v1",
            )
        )

    kpi = engine._compose_kpis("run-1", SAMPLE_EXPERIMENTS[0], results, rows, [definition], composition)[0]

    assert kpi.coverage_label == CoverageLabel.COMPLETE
    assert kpi.composite_score is None
    assert kpi.gate_result is None


def test_optional_failure_does_not_change_conclusive_gate():
    result = EvaluationEngine(judge=_OptionalFailureJudge()).execute(
        SAMPLE_EXPERIMENTS[0],
        get_sample_rows("exp-llm-core-v1")[:1],
        manifest=_two_metric_manifest(),
    )

    assert result.verdict_status == VerdictStatus.CONCLUSIVE
    assert result.overall_gate == GateResult.PASS
    kpi = result.kpi_results[0]
    assert kpi.composite_score == 1.0
    assert kpi.required_coverage_percentage == 100.0
    assert kpi.optional_coverage_percentage == 0.0
    assert kpi.optional_scored_count == 0
    assert kpi.coverage_label == CoverageLabel.COMPLETE


def test_kpi_coverage_counts_required_pairs_with_no_result():
    rows = get_sample_rows("exp-llm-core-v1")[:2]
    engine = EvaluationEngine(judge=_OptionalFailureJudge())
    run = engine.execute(
        SAMPLE_EXPERIMENTS[0],
        rows,
        manifest=_two_metric_manifest(),
    )
    composition = {
        "kpi.response_quality": {
            "required": ["llm.relevance"],
            "optional": [],
            "weights": {"llm.relevance": 1.0},
            "thresholds": {"pass": 0.8, "warn": 0.6, "fail": 0.6},
            "hard_blockers": [],
        }
    }
    kpi_def = next(kpi for kpi in run.kpi_results if kpi.kpi_id == "kpi.response_quality")
    definition = KPI_CATALOG[kpi_def.kpi_id]
    one_result = [result for result in run.metric_results if result.metric_id == "llm.relevance" and result.row_id == rows[0].row_id]

    partial = engine._compose_kpis(run.run_id, run.experiment, one_result, rows, [definition], composition)[0]
    incomplete = engine._compose_kpis(run.run_id, run.experiment, [], rows, [definition], composition)[0]

    assert partial.required_applicable_pair_count == 2
    assert partial.required_scored_count == 1
    assert partial.required_unscored_count == 1
    assert partial.required_coverage_percentage == 50.0
    assert partial.coverage_label == CoverageLabel.PARTIAL
    assert incomplete.required_applicable_pair_count == 2
    assert incomplete.required_unscored_count == 2
    assert incomplete.coverage_label == CoverageLabel.INCOMPLETE


@pytest.mark.parametrize(
    ("observed", "identity_status", "verdict"),
    [
        (
            {"model": "model-a", "status": "attested"},
            TargetIdentityStatus.MATCHED,
            VerdictStatus.CONCLUSIVE,
        ),
        (
            {"model": "model-b", "status": "attested"},
            TargetIdentityStatus.MISMATCHED,
            VerdictStatus.BLOCKED,
        ),
        (
            {"model": "model-a", "status": "self_reported"},
            TargetIdentityStatus.UNVERIFIED,
            VerdictStatus.INCONCLUSIVE,
        ),
        (
            {"model": None, "status": "unavailable"},
            TargetIdentityStatus.UNVERIFIED,
            VerdictStatus.INCONCLUSIVE,
        ),
    ],
)
def test_exact_runtime_identity_controls_release_verdict(
    observed,
    identity_status,
    verdict,
):
    experiment = SAMPLE_EXPERIMENTS[0].model_copy(
        update={
            "resolved_target_provenance": {
                "target_type": "llm",
                "model": "model-a",
                "status": "attested",
            },
            "observed_target_provenance": observed,
        }
    )

    result = EvaluationEngine(judge=_ScoredTestJudge()).execute(
        experiment,
        get_sample_rows("exp-llm-core-v1")[:1],
        manifest=_two_metric_manifest(exact_runtime_identity_required=True),
    )

    assert result.lineage is not None
    assert result.lineage.exact_runtime_identity_required is True
    assert result.lineage.target_identity_status == identity_status
    assert result.verdict_status == verdict
    if verdict != VerdictStatus.CONCLUSIVE:
        assert result.overall_gate is None


def test_no_required_metrics_produces_diagnostic_only_run():
    result = EvaluationEngine(judge=MockJudge()).execute(
        SAMPLE_EXPERIMENTS[0],
        get_sample_rows("exp-llm-core-v1")[:1],
        manifest=_two_metric_manifest(diagnostic_only=True),
    )

    assert result.status == RunStatus.COMPLETED
    assert result.diagnostic_only is True
    assert result.verdict_status is None
    assert result.overall_gate is None
    assert all(kpi.composite_score is None for kpi in result.kpi_results)
    assert all(kpi.gate_result is None for kpi in result.kpi_results)


def test_historical_required_metric_without_kpi_can_never_default_to_pass():
    manifest = ResolvedRunManifest(
        manifest_id="legacy-ungated",
        manifest_hash="legacy-ungated-hash",
        tenant_id="tenant-test",
        project_id="project-test",
        target_version_id="target-version-test",
        target_id="target-test",
        target_version="1",
        target_endpoint="http://target.test",
        target_type=TargetType.APPLICATION,
        environment="test",
        quality_profile_id="profile-test",
        quality_profile_version="1",
        scenario="llm_core",
        metric_ids=["nlp.bleu"],
        metric_requirements=[
            ResolvedMetricRequirement(
                metric_id="nlp.bleu",
                requirement=MetricRequirement.REQUIRED,
                source=MetricRequirementSource.QUALITY_CONTRACT,
            )
        ],
        kpi_compositions=[],
        diagnostic_only=False,
    )

    result = EvaluationEngine(judge=AdapterDispatchJudge(Settings(judge_mode="mock"))).execute(
        SAMPLE_EXPERIMENTS[0],
        get_sample_rows("exp-llm-core-v1")[:1],
        manifest=manifest,
    )

    assert result.metric_results[0].metric_status == MetricStatus.SCORED
    assert result.verdict_status == VerdictStatus.INCONCLUSIVE
    assert result.overall_gate is None


def _ungated_blocker_manifest() -> ResolvedRunManifest:
    """A required blocker metric that composes no KPI."""

    return ResolvedRunManifest(
        manifest_id="blocker-ungated",
        manifest_hash="blocker-ungated-hash",
        tenant_id="tenant-test",
        project_id="project-test",
        target_version_id="target-version-test",
        target_id="target-test",
        target_version="1",
        target_endpoint="http://target.test",
        target_type=TargetType.APPLICATION,
        environment="test",
        quality_profile_id="profile-test",
        quality_profile_version="1",
        scenario="llm_core",
        metric_ids=["nlp.bleu"],
        metric_requirements=[
            ResolvedMetricRequirement(
                metric_id="nlp.bleu",
                requirement=MetricRequirement.REQUIRED,
                source=MetricRequirementSource.QUALITY_CONTRACT,
            )
        ],
        kpi_compositions=[],
        diagnostic_only=False,
        hard_blocker_metric_ids=["nlp.bleu"],
    )


def test_hard_blocker_fails_the_run_without_a_kpi_composition():
    """A blocker vetoes on its own, which is the only way the metrics that
    compose no KPI — content-safety, ops and nlp — can ever stop a release.

    The contrast with the no-blocker case above is the whole point: the same
    metric at the same failing score is inconclusive when nothing declared it
    a blocker, and a conclusive fail when something did.
    """

    result = EvaluationEngine(judge=AdapterDispatchJudge(Settings(judge_mode="mock"))).execute(
        SAMPLE_EXPERIMENTS[0],
        get_sample_rows("exp-llm-core-v1")[:1],
        manifest=_ungated_blocker_manifest(),
    )

    scored = result.metric_results[0]
    assert scored.metric_status == MetricStatus.SCORED
    assert scored.threshold_result == GateResult.FAIL
    assert result.verdict_status == VerdictStatus.CONCLUSIVE
    assert result.overall_gate == GateResult.FAIL


def test_passing_hard_blocker_without_a_kpi_composition_is_a_conclusive_pass():
    """A blocker that holds must not leave the run permanently inconclusive.

    A profile whose only assertion is a blocker has asserted exactly one thing;
    when it holds, that is a verdict, not an absence of one.
    """

    row = EvaluationRow(
        row_id="exact-match",
        query="what is the policy limit?",
        response="the policy limit is ten thousand dollars",
        expected_response="the policy limit is ten thousand dollars",
        context=[],
    )

    result = EvaluationEngine(judge=AdapterDispatchJudge(Settings(judge_mode="mock"))).execute(
        SAMPLE_EXPERIMENTS[0],
        [row],
        manifest=_ungated_blocker_manifest(),
    )

    assert result.metric_results[0].threshold_result == GateResult.PASS
    assert result.verdict_status == VerdictStatus.CONCLUSIVE
    assert result.overall_gate == GateResult.PASS


def test_trusted_zero_tool_case_is_not_applicable_and_excluded_from_coverage():
    experiment = SAMPLE_EXPERIMENTS[2]
    row = EvaluationRow(
        row_id="no-tool-case",
        query="answer directly",
        response="done",
        expected_response="done",
        from_agent=True,
        trace_unavailable=False,
        tool_evidence_completion_attested=True,
        tool_calls=[],
    )

    result = EvaluationEngine(judge=MockJudge()).execute(
        experiment,
        [row],
        metric_ids=["agent.tool_selection"],
    )

    metric = result.metric_results[0]
    assert metric.metric_applicability == MetricApplicability.NOT_APPLICABLE
    assert metric.metric_status is None
    assert metric.score is None
    assert result.kpi_results[0].required_applicable_pair_count == 0
    assert result.kpi_results[0].required_coverage_percentage is None
    assert result.verdict_status == VerdictStatus.INCONCLUSIVE
    assert result.overall_gate is None


def test_required_not_applicable_constituent_is_removed_and_weights_are_renormalised():
    row = EvaluationRow(
        row_id="no-retrieval-case",
        query="answer directly",
        response="done",
        expected_response="done",
        trace_span_count=1,
        context=[],
    )
    set_row_overrides(
        {
            row.row_id: {
                "safety.general": 0.0,
                "safety.ungrounded_attributes": 0.0,
            }
        }
    )
    try:
        result = EvaluationEngine(judge=_ScoredTestJudge()).execute(
            SAMPLE_EXPERIMENTS[0],
            [row],
            metric_ids=["safety.general", "safety.ungrounded_attributes"],
        )
    finally:
        set_row_overrides({})

    metrics = {metric.metric_id: metric for metric in result.metric_results}
    assert metrics["safety.ungrounded_attributes"].metric_applicability == MetricApplicability.NOT_APPLICABLE
    safety = _safety_kpi(result)
    assert safety.gate_result == GateResult.PASS
    assert safety.composite_score == 1.0
    assert safety.constituent_scores[0].metric_id == "safety.general"
    assert safety.constituent_scores[0].weight == 1.0
    assert result.verdict_status == VerdictStatus.CONCLUSIVE
    assert result.overall_gate == GateResult.PASS


def test_unavailable_required_trace_reduces_coverage_without_zero_score():
    row = EvaluationRow(
        row_id="missing-trace-case",
        query="use the policy search",
        response="done",
        expected_response="done",
        expected_tools=["policy_search"],
        from_agent=True,
        trace_unavailable=True,
        tool_calls=[],
    )

    result = EvaluationEngine(judge=AdapterDispatchJudge(Settings(judge_mode="mock"))).execute(
        SAMPLE_EXPERIMENTS[2],
        [row],
        metric_ids=["agent.tool_selection"],
    )

    metric = result.metric_results[0]
    assert metric.metric_applicability == MetricApplicability.APPLICABLE
    assert metric.metric_status == MetricStatus.UNSCORED
    assert metric.unscored_reason == UnscoredReason.EVIDENCE_UNAVAILABLE
    assert metric.score is None
    assert metric.normalised_score is None
    assert metric.passed is None
    assert metric.threshold_result is None
    kpi = result.kpi_results[0]
    assert kpi.required_applicable_pair_count == 1
    assert kpi.required_scored_count == 0
    assert kpi.required_unscored_count == 1
    assert kpi.required_coverage_percentage == 0.0
    assert kpi.composite_score is None
    assert kpi.gate_result is None
    assert result.status == RunStatus.COMPLETED
    assert result.verdict_status == VerdictStatus.INCONCLUSIVE
    assert result.overall_gate is None


def test_partial_tool_trace_abstains_instead_of_scoring_observed_subset():
    row = EvaluationRow(
        row_id="partial-trace-case",
        query="use the policy search",
        response="done",
        expected_response="done",
        expected_tools=["policy_search"],
        from_agent=True,
        trace_unavailable=False,
        tool_evidence_completion_attested=False,
        tool_calls=[ToolCall(name="policy_search")],
    )

    result = EvaluationEngine(judge=AdapterDispatchJudge(Settings(judge_mode="mock"))).execute(
        SAMPLE_EXPERIMENTS[2],
        [row],
        metric_ids=["agent.tool_selection"],
    )

    metric = result.metric_results[0]
    assert metric.metric_status == MetricStatus.UNSCORED
    assert metric.unscored_reason == UnscoredReason.EVIDENCE_UNAVAILABLE
    assert metric.score is None
    assert result.kpi_results[0].required_coverage_percentage == 0.0
    assert result.verdict_status == VerdictStatus.INCONCLUSIVE


def test_incomplete_trace_scores_response_metrics_without_blocking_run():
    """Phoenix-style split: response scores, trajectory-dependent metric abstains."""

    row = EvaluationRow(
        row_id="split-evaluation-case",
        query="use the policy search",
        response="The policy is available.",
        expected_response="The policy is available.",
        expected_tools=["policy_search"],
        from_agent=True,
        trace_unavailable=False,
        tool_evidence_completion_attested=False,
        tool_calls=[ToolCall(name="policy_search", output="policy")],
        output_data={
            "response": "The policy is available.",
            "response_source": "a2a-capture-fallback",
            "archive_fallback_reason": "incomplete_trajectory",
        },
    )

    result = EvaluationEngine(judge=_ScoredTestJudge()).execute(
        SAMPLE_EXPERIMENTS[2],
        [row],
        metric_ids=["llm.relevance", "agent.tool_selection"],
    )

    by_metric = {metric.metric_id: metric for metric in result.metric_results}
    assert by_metric["llm.relevance"].metric_status == MetricStatus.SCORED
    assert by_metric["agent.tool_selection"].metric_status == MetricStatus.UNSCORED
    assert by_metric["agent.tool_selection"].unscored_reason == UnscoredReason.INCOMPLETE_TRACE
    assert by_metric["agent.tool_selection"].execution_metadata["evidence_diagnostic"] == "incomplete_trajectory"
    assert result.status == RunStatus.COMPLETED


def test_engine_reports_unscored_when_no_expected_tools_declared():
    # #3029: a row that declares no expected tools used to score a vacuous 1.0,
    # which carried an unearned PASS all the way to the gate. The evidence here
    # is complete and tools *were* called — this is not the trusted-zero N/A
    # case — but the golden row states nothing about which tools belong, so the
    # metric must land UNSCORED and the gate must go non-conclusive rather than
    # green.
    row = EvaluationRow(
        row_id="undeclared-tools-case",
        query="use whatever you need",
        response="done",
        expected_response="done",
        expected_tools=[],
        from_agent=True,
        trace_unavailable=False,
        tool_evidence_completion_attested=True,
        tool_calls=[ToolCall(name="policy_search", args={"q": "leave"})],
    )

    result = EvaluationEngine(judge=AdapterDispatchJudge(Settings(judge_mode="mock"))).execute(
        SAMPLE_EXPERIMENTS[2],
        [row],
        metric_ids=["agent.tool_selection"],
    )

    metric = result.metric_results[0]
    assert metric.metric_applicability == MetricApplicability.APPLICABLE
    assert metric.metric_status == MetricStatus.UNSCORED
    assert metric.unscored_reason == UnscoredReason.EVIDENCE_UNAVAILABLE
    assert metric.score is None
    assert metric.passed is None
    assert metric.threshold_result is None
    assert metric.execution_metadata["missing_evidence"] == ["expected_tools"]

    kpi = result.kpi_results[0]
    assert kpi.required_applicable_pair_count == 1
    assert kpi.required_scored_count == 0
    assert kpi.required_unscored_count == 1
    assert kpi.required_coverage_percentage == 0.0
    assert kpi.composite_score is None
    assert kpi.gate_result is None
    assert result.status == RunStatus.COMPLETED
    assert result.verdict_status == VerdictStatus.INCONCLUSIVE
    assert result.overall_gate is None


def test_missing_tool_result_only_blocks_metrics_that_require_results():
    row = EvaluationRow(
        row_id="missing-tool-result",
        query="look up the policy",
        response="done",
        expected_response="done",
        expected_tools=["policy_search"],
        from_agent=True,
        trace_unavailable=False,
        tool_evidence_completion_attested=True,
        tool_calls=[ToolCall(name="policy_search", args={"id": 7}, result_captured=False)],
    )

    result_run = EvaluationEngine(judge=MockJudge()).execute(
        SAMPLE_EXPERIMENTS[2],
        [row],
        metric_ids=["agent.task_adherence"],
    )
    result_metric = result_run.metric_results[0]
    assert result_metric.metric_status == MetricStatus.UNSCORED
    assert result_metric.unscored_reason == UnscoredReason.EVIDENCE_UNAVAILABLE
    assert result_metric.score is None
    assert result_metric.execution_metadata["missing_evidence"] == ["tool_results"]
    assert result_run.kpi_results[0].required_coverage_percentage == 0.0
    assert result_run.kpi_results[0].composite_score is None
    assert result_run.kpi_results[0].gate_result is None
    assert result_run.verdict_status == VerdictStatus.INCONCLUSIVE
    assert result_run.overall_gate is None

    call_metric = (
        EvaluationEngine(judge=AdapterDispatchJudge(Settings(judge_mode="mock")))
        .execute(
            SAMPLE_EXPERIMENTS[2],
            [row],
            metric_ids=["agent.tool_selection"],
        )
        .metric_results[0]
    )
    assert call_metric.metric_status == MetricStatus.SCORED
    assert call_metric.score == 1.0


def test_captured_json_null_tool_result_remains_scoreable():
    row = EvaluationRow(
        row_id="captured-null-result",
        query="delete the draft",
        response="done",
        expected_response="done",
        from_agent=True,
        trace_unavailable=False,
        tool_evidence_completion_attested=True,
        tool_calls=[
            ToolCall(
                name="delete_draft",
                output=None,
                result_captured=True,
            )
        ],
    )

    metric = (
        EvaluationEngine(judge=_ScoredTestJudge())
        .execute(
            SAMPLE_EXPERIMENTS[2],
            [row],
            metric_ids=["agent.task_adherence"],
        )
        .metric_results[0]
    )

    assert metric.metric_status == MetricStatus.SCORED
    assert metric.score is not None


def _safety_kpi(result):
    return next(k for k in result.kpi_results if k.kpi_id == "kpi.safety_trust")


def test_zero_tolerance_safety_passes_when_all_rows_clean():
    # P1-03: every row perfectly safe -> zero-tolerance gate passes.
    rows = get_sample_rows("exp-llm-core-v1")
    overrides = {r.row_id: {"safety.general": 0.0, "safety.ungrounded_attributes": 0.0} for r in rows}
    set_row_overrides(overrides)
    try:
        result = EvaluationEngine(judge=_ScoredTestJudge()).execute(SAMPLE_EXPERIMENTS[0], rows)
        assert _safety_kpi(result).gate_result == GateResult.PASS
    finally:
        set_row_overrides({})


def test_zero_tolerance_safety_fails_on_a_single_bad_row():
    # P1-03: one unsafe row is enough to fail the gate — it must not be masked
    # by averaging across the other clean rows.
    rows = get_sample_rows("exp-llm-core-v1")
    overrides = {r.row_id: {"safety.general": 0.0, "safety.ungrounded_attributes": 0.0} for r in rows}
    overrides[rows[0].row_id]["safety.general"] = 7.0  # severe on one row only
    set_row_overrides(overrides)
    try:
        result = EvaluationEngine(judge=_ScoredTestJudge()).execute(SAMPLE_EXPERIMENTS[0], rows)
        assert _safety_kpi(result).gate_result == GateResult.FAIL
    finally:
        set_row_overrides({})


def _row(row_id: str) -> EvaluationRow:
    return EvaluationRow(row_id=row_id, query="q", response="r")


def test_row_defect_rate_is_none_when_every_result_lacks_a_normalised_score():
    """SCORED-without-normalised-score must NOT pass zero-tolerance.

    An operational metric always carries ``metric_status=SCORED`` but
    ``normalised_score=None`` (there is no 0-1 form for a measurement). If
    that were read as "zero defective rows", a zero-tolerance safety gate
    would silently PASS despite having no actual evidence. It must instead
    come back ``None`` so the caller treats it as inconclusive, exactly like
    ``_hard_blocker_gate`` does when nothing scored.
    """
    results = [
        MetricResult(
            metric_id="safety.general",
            evaluator_instance_id="inst-1",
            run_id="run-1",
            row_id="row-1",
            metric_status=MetricStatus.SCORED,
            score=1200.0,
            normalised_score=None,
            passed=None,
            threshold=1.0,
            threshold_result=None,
            dataset_version="v1",
        )
    ]
    assert _row_defect_rate(results, {"safety.general"}, [_row("row-1")]) is None
    # A mix of no-score and empty input is the same "no evidence" case.
    assert _row_defect_rate([], {"safety.general"}, []) is None


def test_row_defect_rate_denominator_is_rows_in_run_not_scored_rows():
    """A row with no usable score must widen the denominator, never shrink it.

    Two rows in the run; only row-1 produced a usable ``normalised_score``
    (clean). row-2's constituent metric never produced a usable score at all
    (e.g. a technical error). The old implementation built its denominator
    from ``by_row`` -- the rows that happened to score -- so row-2 would
    silently vanish and the rate would read as a clean 0/1 = 0.0 (PASS). The
    correct read is "we don't have full evidence" -> ``None`` (inconclusive),
    never a clean pass on partial evidence.
    """
    results = [
        MetricResult(
            metric_id="safety.general",
            evaluator_instance_id="inst-1",
            run_id="run-1",
            row_id="row-1",
            metric_status=MetricStatus.SCORED,
            score=1.0,
            normalised_score=1.0,
            passed=True,
            threshold=1.0,
            threshold_result=GateResult.PASS,
            dataset_version="v1",
        ),
        # row-2: SCORED, with a raw score, but no usable normalised_score --
        # the "measurement metric" edge case the docstring calls out (a
        # captured value with no 0-1 form to normalise into).
        MetricResult(
            metric_id="safety.general",
            evaluator_instance_id="inst-1",
            run_id="run-1",
            row_id="row-2",
            metric_status=MetricStatus.SCORED,
            score=1200.0,
            normalised_score=None,
            passed=None,
            threshold=1.0,
            threshold_result=None,
            dataset_version="v1",
        ),
    ]
    rows = [_row("row-1"), _row("row-2")]
    assert _row_defect_rate(results, {"safety.general"}, rows) is None


def test_zero_tolerance_gate_does_not_pass_when_one_row_never_scored():
    """End-to-end version of the denominator bug via the real engine + gate.

    Mixed case: some rows scored clean, one row's constituent metrics never
    produced a usable score. Zero-tolerance must not read this as a pass.
    """
    rows = get_sample_rows("exp-llm-core-v1")
    overrides = {r.row_id: {"safety.general": 0.0, "safety.ungrounded_attributes": 0.0} for r in rows}
    set_row_overrides(overrides)
    try:
        result = EvaluationEngine(judge=_ScoredTestJudge()).execute(SAMPLE_EXPERIMENTS[0], rows)
        kpi = _safety_kpi(result)
        # Simulate one row's constituent metric never producing a usable score
        # (e.g. a technical error) by dropping its metric results before
        # recomputing the denominator directly against the engine helper.
        dropped_row_id = rows[0].row_id
        surviving_results = [mr for mr in result.metric_results if not (mr.row_id == dropped_row_id and mr.metric_id in {"safety.general", "safety.ungrounded_attributes"})]
        constituent_ids = {c.metric_id for c in kpi.constituent_scores}
        assert _row_defect_rate(surviving_results, constituent_ids, rows) is None
    finally:
        set_row_overrides({})


def test_a_failing_case_reaches_review_even_when_the_run_average_passes():
    """One bad case must not hide behind the mean of the good ones.

    KPI scores average across rows, so a run of mostly-passing cases can carry a
    required metric that genuinely failed on one of them and still report an
    aggregate PASS. The queue used to be skipped entirely on that aggregate, so
    nobody was ever asked to look — while the run report's root-cause diagnosis,
    which reads every result, named the failure on the same screen.
    """
    rows = [
        EvaluationRow(
            row_id=f"row-{index}",
            query="What is the capital of France?",
            response="Paris.",
            expected_response="Paris",
        )
        for index in range(5)
    ]
    # Four strong cases and one clearly failing one: enough to keep the mean up.
    overrides = {f"row-{index}": {"llm.relevance": 5.0} for index in range(4)}
    overrides["row-4"] = {"llm.relevance": 1.0}
    set_row_overrides(overrides)
    try:
        result = EvaluationEngine(judge=_ScoredTestJudge()).execute(SAMPLE_EXPERIMENTS[0], rows, metric_ids=["llm.relevance"])
    finally:
        set_row_overrides({})

    queued = {item.row_id for item in result.review_queue}
    assert "row-4" in queued, f"failing case missing from the queue; gate={result.overall_gate}, queued={queued}"


def test_a_queued_case_carries_each_failing_score_against_its_threshold():
    """Naming the failed checks is not enough to decide on a finding.

    The review sheet could list "Groundedness failed" but not say whether it
    scored 0.69 against a 0.70 threshold or 0.10 — the difference between a
    borderline result and a broken one, and the whole basis for triage.
    """
    rows = [
        EvaluationRow(
            row_id="row-0",
            query="What is the capital of France?",
            response="Paris.",
            expected_response="Paris",
        )
    ]
    set_row_overrides({"row-0": {"llm.relevance": 1.0}})
    try:
        result = EvaluationEngine(judge=_ScoredTestJudge()).execute(SAMPLE_EXPERIMENTS[0], rows, metric_ids=["llm.relevance"])
    finally:
        set_row_overrides({})

    assert result.review_queue, "expected the failing case to be queued"
    details = result.review_queue[0].failing_metric_details
    assert [detail.metric_id for detail in details] == ["llm.relevance"]
    assert details[0].threshold is not None
    assert details[0].normalised_score is not None
    assert details[0].threshold_result in (GateResult.WARN, GateResult.FAIL)


def test_grounding_without_retrieval_persists_as_unscored_not_technical_error(monkeypatch):
    """Absent evidence is "we could not tell", not an evaluator failure.

    The dispatcher's grounding fallback returned ``missing_evidence=["retrieval"]``
    *and* ``execution_status="error"``. The engine tests the status before it
    tests missing evidence, so the row went to ``_technical_error_result`` and
    persisted as ``technical_error`` — a claim that the evaluator broke, when in
    fact it correctly declined to judge a row with nothing to check against.

    Every other missing-evidence producer (deterministic, trace) leaves the
    status alone; the dispatcher was the outlier. The dispatcher-level test
    could not catch this: it asserts score, ``missing_evidence`` and
    ``fallback_from``, none of which the bug changed. Only persistence through
    the engine shows it, which is what this exercises.
    """

    row = get_sample_rows("exp-rag-v1")[0].model_copy(update={"context": []})

    def _framework_unavailable():
        raise ImportError("ragas not installed")

    judge = AdapterDispatchJudge(Settings(judge_mode="llm", openai_api_key="x"))
    monkeypatch.setattr(judge, "_ragas_judge", _framework_unavailable)

    run = EvaluationEngine(judge=judge).execute(
        SAMPLE_EXPERIMENTS[1],
        [row],
        metric_ids=["rag.groundedness"],
    )
    metric = run.metric_results[0]

    assert metric.metric_status == MetricStatus.UNSCORED
    assert metric.unscored_reason == UnscoredReason.EVIDENCE_UNAVAILABLE
    assert metric.execution_status == "unscored"
    assert metric.execution_metadata["missing_evidence"] == ["retrieval"]

    # No number, no verdict, and nothing that could read as a pass. A zero here
    # would be worse than no score: it asserts the answer was ungrounded.
    assert metric.score is None
    assert metric.normalised_score is None
    assert metric.passed is None
    assert metric.threshold_result is None

    # The framework failure that routed us here is still disclosed.
    assert "ragas not installed" in (metric.error_message or "")

    # Required and unscored means the run cannot conclude.
    assert run.status == RunStatus.COMPLETED
    assert run.verdict_status == VerdictStatus.INCONCLUSIVE
    assert run.overall_gate is None


@pytest.mark.parametrize("not_applicable", [False, True])
def test_metric_subject_identity(not_applicable):
    payload = dict(
        metric_id="llm.relevance", evaluator_instance_id="cfg", run_id="run",
        row_id="row", dataset_version="v1", threshold=0.5,
        score=1.0, normalised_score=1.0, passed=True, threshold_result="pass",
    )
    if not_applicable:
        payload.update(metric_applicability="not_applicable", metric_status=None,
                       score=None, normalised_score=None, passed=None, threshold_result=None)
    assert MetricResult(**payload).subject_kind == ScoreSubjectKind.CASE
    linked_case = MetricResult(**payload, target_trace_id="trace", target_span_id="evidence")
    assert linked_case.span_id is None
    assert linked_case.target_span_id == "evidence"
    for identity in ({"subject_kind": "case", "trace_id": "trace"},
                     {"subject_kind": "span", "trace_id": "trace", "span_id": "span"},
                     {"subject_kind": None, "span_id": "historical-span"}):
        assert MetricResult(**payload, **identity).subject_kind == identity["subject_kind"]
    invalid = [{"subject_kind": "trace"}, {"subject_kind": "session"},
               {"subject_kind": "case", "span_id": ""}, {"subject_kind": "case", "span_id": "span"}]
    for field in ("trace_id", "span_id"):
        for value in (None, "", " \t"):
            invalid.append({"subject_kind": "span", "trace_id": "trace", "span_id": "span", field: value})
    for identity in invalid:
        with pytest.raises(ValueError):
            MetricResult(**payload, **identity)


@pytest.mark.parametrize("span_status", ["scored", "unscored", "technical_error"])
@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("zero_tolerance", [False, True])
def test_span_results_do_not_change_case_calculations(monkeypatch, span_status, legacy, zero_tolerance):
    import evalhub.evaluation.engine as engine_module

    engine = EvaluationEngine(judge=_ScoredTestJudge())
    rows = get_sample_rows("exp-llm-core-v1")[:1]
    rows[0].span_id = "execution-link"
    monkeypatch.setattr("evalhub.evaluation.judge.ROW_SCORE_OVERRIDES", {rows[0].row_id: {"llm.relevance": 5.0, "llm.coherence": 5.0}})
    monkeypatch.setitem(KPI_CATALOG, "kpi.response_quality", KPI_CATALOG["kpi.response_quality"].model_copy(update={"zero_tolerance": zero_tolerance}))
    manifest = _two_metric_manifest()
    manifest.hard_blocker_metric_ids = ["llm.relevance"]
    original_result = engine_module.MetricResult

    def result_with_subject(**payload):
        if payload["evaluator_instance_id"].startswith("span-"):
            payload.update(subject_kind="span", trace_id="trace", span_id="span",
                           score=0.0, normalised_score=0.0, passed=False, threshold_result="fail",
                           rationale="span failure", metric_status=span_status)
            if span_status != "scored":
                payload.update(score=None, normalised_score=None, passed=None, threshold_result=None)
                if span_status == "unscored":
                    payload.update(unscored_reason="evidence_unavailable")
                else:
                    payload.update(error_details={"message": "span error"}, error_message="span error", execution_status="error")
        elif legacy:
            payload.update(subject_kind=None, span_id="historical-span")
        return original_result(**payload)

    monkeypatch.setattr(engine_module, "MetricResult", result_with_subject)
    baseline = engine.execute(SAMPLE_EXPERIMENTS[0], rows, run_id="subject-test", manifest=manifest)
    assert all(result.subject_kind == (None if legacy else ScoreSubjectKind.CASE) for result in baseline.metric_results)
    assert all(result.span_id == ("historical-span" if legacy else None) for result in baseline.metric_results)
    assert baseline.overall_gate == GateResult.PASS
    assert baseline.review_queue == []
    original_configs = engine_module.build_evaluator_configs

    def configs_with_spans(*args, **kwargs):
        metrics, configs, kpis = original_configs(*args, **kwargs)
        return metrics, configs + [config.model_copy(update={"instance_id": "span-" + config.instance_id}) for config in configs], kpis

    monkeypatch.setattr(engine_module, "build_evaluator_configs", configs_with_spans)
    mixed = engine.execute(SAMPLE_EXPERIMENTS[0], rows, run_id="subject-test", manifest=manifest)
    assert len(mixed.metric_results) == 2 * len(baseline.metric_results)
    assert sum(result.subject_kind == ScoreSubjectKind.SPAN for result in mixed.metric_results) == len(baseline.metric_results)
    assert [k.model_dump(exclude={"timestamp"}) for k in mixed.kpi_results] == [k.model_dump(exclude={"timestamp"}) for k in baseline.kpi_results]
    assert mixed.overall_gate == baseline.overall_gate
    assert mixed.verdict_status == baseline.verdict_status
    assert mixed.root_cause == baseline.root_cause
    assert mixed.review_queue == baseline.review_queue
