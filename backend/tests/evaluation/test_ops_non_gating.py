"""Operations metrics (``ops.*``) are optional and non-gating by default.

Latency / token / efficiency metrics describe operational cost, not release
quality. They must never drag the release gate or verdict on their own, and
missing telemetry must surface as UNSCORED (not-captured) rather than a
fabricated zero. A metric only gates when an approved Quality Contract
explicitly elevates it to ``required``.
"""

from evalhub.evaluation.adapters.dispatcher import AdapterDispatchJudge
from evalhub.evaluation.engine import EvaluationEngine
from evalhub.evaluation.enums import (
    GateResult,
    MetricRequirement,
    MetricRequirementSource,
    MetricStatus,
    UnscoredReason,
    VerdictStatus,
)
from evalhub.evaluation.judge import MockJudge, set_row_overrides
from evalhub.evaluation.models import EvaluationRow, MetricResult
from evalhub.evaluation.sample_data import SAMPLE_EXPERIMENTS
from evalhub.platform.contracts import (
    ResolvedKpiComposition,
    ResolvedMetricRequirement,
    ResolvedScoringConfiguration,
)
from evalhub.settings import Settings

LLM_CORE = SAMPLE_EXPERIMENTS[0]


def _dispatch_engine() -> EvaluationEngine:
    # The real production judge routing: deterministic ops scorers report
    # missing telemetry instead of fabricating a value, quality metrics fall
    # back to the deterministic mock.
    judge = AdapterDispatchJudge(Settings(judge_mode="mock"))
    judge._native = _ScoredTestJudge()
    return EvaluationEngine(judge=judge)


class _ScoredTestJudge:
    def evaluate(self, config, row):
        result = MockJudge().evaluate(config, row)
        result.executed_scorer = "native"
        return result


def _result_for(results, metric_id):
    return next(r for r in results if r.metric_id == metric_id)


def _kpi(result, kpi_id):
    return next(k for k in result.kpi_results if k.kpi_id == kpi_id)


def test_missing_ops_telemetry_is_unscored_and_does_not_gate_the_verdict():
    """(a) Missing latency/token telemetry -> unscored, verdict unaffected."""
    row = EvaluationRow(
        row_id="ops-missing-1",
        query="What is the capital of France?",
        response="Paris.",
        expected_response="Paris",
    )
    set_row_overrides({"ops-missing-1": {"llm.relevance": 5.0}})
    try:
        result = _dispatch_engine().execute(
            LLM_CORE,
            [row],
            metric_ids=["llm.relevance", "ops.latency", "ops.total_token_count"],
        )
    finally:
        set_row_overrides({})

    latency = _result_for(result.metric_results, "ops.latency")
    tokens = _result_for(result.metric_results, "ops.total_token_count")

    # Missing telemetry -> unscored with a reason, never a fabricated zero.
    for ops in (latency, tokens):
        assert ops.metric_status == MetricStatus.UNSCORED
        assert ops.unscored_reason == UnscoredReason.EVIDENCE_UNAVAILABLE
        assert ops.score is None
        assert ops.normalised_score is None
        # Non-gating by default: no contract, so requirement stays optional.
        assert ops.metric_requirement == MetricRequirement.OPTIONAL

    # The unscored ops metrics must not block the verdict or the gate.
    assert result.verdict_status == VerdictStatus.CONCLUSIVE
    assert result.overall_gate == GateResult.PASS

    # There is no Operational Efficiency KPI to contribute a gate: it composed
    # measurements against thresholds nobody declared.
    assert all(kpi.kpi_id != "kpi.operational_efficiency" for kpi in result.kpi_results)


def test_captured_but_poor_ops_telemetry_is_non_gating_by_default():
    """Present-but-bad ops telemetry still cannot drag the release gate down."""
    row = EvaluationRow(
        row_id="ops-bad-1",
        query="What is the capital of France?",
        response="Paris.",
        expected_response="Paris",
        latency_ms=15000,  # 15s, recorded as a measurement
        target_usage={"total_tokens": 9000},  # -> normalises to 0.2
    )
    set_row_overrides({"ops-bad-1": {"llm.relevance": 5.0}})
    try:
        result = _dispatch_engine().execute(
            LLM_CORE,
            [row],
            metric_ids=["llm.relevance", "ops.latency", "ops.total_token_count"],
        )
    finally:
        set_row_overrides({})

    latency = _result_for(result.metric_results, "ops.latency")
    # Real telemetry is captured — as a measurement, not a judgement. The
    # normalised score used to bucket 15s to 0.3 against a five-and-ten-second
    # rule nobody declared; a latency with no budget carries the seconds and no
    # verdict.
    assert latency.metric_status == MetricStatus.SCORED
    assert latency.score == 15.0
    assert latency.normalised_score is None
    assert latency.threshold_result is None
    assert latency.passed is None
    assert latency.metric_requirement == MetricRequirement.OPTIONAL

    # Operational telemetry must not gate. There is no operational KPI to
    # carry one: a composite built from measurements nobody set a budget for
    # was a number without a meaning.
    assert all(kpi.kpi_id != "kpi.operational_efficiency" for kpi in result.kpi_results)
    assert result.overall_gate == GateResult.PASS
    assert result.verdict_status == VerdictStatus.CONCLUSIVE


def test_quality_contract_cannot_gate_an_ops_metric_without_a_budget():
    """(b) A contract may require an ops metric, but cannot grade it.

    Elevating latency to REQUIRED is honoured. Producing a verdict from it is
    not: nothing declares what an acceptable latency is, so the run says so
    instead of inventing one. A real gate needs a budget on the contract.
    """
    row = EvaluationRow(
        row_id="ops-elevated-1",
        query="What is the capital of France?",
        response="Paris.",
        expected_response="Paris",
        latency_ms=15000,  # -> normalises to 0.3 -> FAIL against pass 0.8
    )
    scoring_configuration = ResolvedScoringConfiguration(
        configuration_id="cfg-ops-elevated",
        configuration_hash="cfg-ops-elevated-hash",
        scenario="llm_core",
        evaluation_scope="final_response",
        metric_ids=["ops.latency"],
        metric_requirements=[
            ResolvedMetricRequirement(
                metric_id="ops.latency",
                requirement=MetricRequirement.REQUIRED,
                source=MetricRequirementSource.QUALITY_CONTRACT,
            )
        ],
        kpi_compositions=[
            ResolvedKpiComposition(
                kpi_id="kpi.operational_efficiency",
                required_gate_constituents=["ops.latency"],
                optional_diagnostic_constituents=[],
                fixed_gate_weights={"ops.latency": 1.0},
                thresholds={"pass": 0.8, "warn": 0.6, "fail": 0.6},
            )
        ],
    )

    result = _dispatch_engine().execute(
        LLM_CORE,
        [row],
        scoring_configuration=scoring_configuration,
    )

    latency = _result_for(result.metric_results, "ops.latency")
    assert latency.metric_status == MetricStatus.SCORED
    assert latency.metric_requirement == MetricRequirement.REQUIRED
    assert latency.metric_requirement_source == MetricRequirementSource.QUALITY_CONTRACT

    # Elevating an ops metric by contract is still honoured as a requirement,
    # but a measurement with no declared budget cannot produce a verdict: the
    # contract says "latency must gate" without saying what good looks like.
    # The run goes non-conclusive rather than inventing a FAIL.
    assert all(kpi.kpi_id != "kpi.operational_efficiency" for kpi in result.kpi_results)
    # Asking to gate on a measurement with no declared budget is answered
    # honestly: no gate and a non-conclusive verdict, rather than the FAIL the
    # old five-and-ten-second buckets would have produced.
    assert result.overall_gate is None
    assert result.verdict_status == VerdictStatus.INCONCLUSIVE


def test_token_efficiency_without_token_telemetry_is_unscored_not_fabricated():
    """No captured token usage -> ops.token_efficiency is UNSCORED, never judged."""
    row = EvaluationRow(
        row_id="ops-eff-missing-1",
        query="What is the capital of France?",
        response="Paris.",
        expected_response="Paris",
    )
    set_row_overrides({"ops-eff-missing-1": {"llm.relevance": 5.0}})
    try:
        result = _dispatch_engine().execute(
            LLM_CORE,
            [row],
            metric_ids=["llm.relevance", "ops.token_efficiency"],
        )
    finally:
        set_row_overrides({})

    efficiency = _result_for(result.metric_results, "ops.token_efficiency")
    assert efficiency.metric_status == MetricStatus.UNSCORED
    assert efficiency.unscored_reason == UnscoredReason.TELEMETRY_NOT_CAPTURED
    assert efficiency.score is None
    assert efficiency.normalised_score is None
    assert efficiency.passed is None
    # Still non-gating and non-blocking for the run.
    assert result.verdict_status == VerdictStatus.CONCLUSIVE
    assert result.overall_gate == GateResult.PASS


def test_token_efficiency_with_token_telemetry_is_scored():
    """Captured token usage -> ops.token_efficiency is measured, not unscored.

    Without telemetry it must be UNSCORED rather than judged; with telemetry it
    records the measurement. Neither case earns a pass or a fail.
    """
    row = EvaluationRow(
        row_id="ops-eff-present-1",
        query="What is the capital of France?",
        response="Paris.",
        expected_response="Paris",
        target_usage={"prompt_tokens": 800, "completion_tokens": 400},
    )
    set_row_overrides({"ops-eff-present-1": {"llm.relevance": 5.0}})
    try:
        result = _dispatch_engine().execute(
            LLM_CORE,
            [row],
            metric_ids=["llm.relevance", "ops.token_efficiency"],
        )
    finally:
        set_row_overrides({})

    efficiency = _result_for(result.metric_results, "ops.token_efficiency")
    assert efficiency.metric_status == MetricStatus.SCORED
    assert efficiency.unscored_reason is None
    assert efficiency.score is not None
    # Captured, not graded. The measurement is kept on `score`; there is no
    # normalised form and no verdict, because the 0.8 it would be graded
    # against is a field default nobody chose for this metric. Everything under
    # ops.* reads the same way — see
    # test_no_operational_metric_carries_a_pass_or_fail.
    assert efficiency.normalised_score is None
    assert efficiency.threshold_result is None


def test_explicitly_selected_ops_metric_resolves_optional():
    # Resolver path (not just the engine fallback): an ad-hoc explicitly selected
    # ops metric is OPTIONAL/non-gating unless a contract elevates it.
    from evalhub.evaluation.enums import EvaluationScope, MetricRequirement, Scenario
    from evalhub.platform.resolver import resolve_scoring_configuration

    config = resolve_scoring_configuration(
        metric_ids=["ops.latency", "llm.relevance"],
        explicit_metric_ids={"ops.latency", "llm.relevance"},
        scenario=Scenario.LLM_CORE,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
        quality_contract_template_snapshots=[],
    )
    reqs = {r.metric_id: r.requirement for r in config.metric_requirements}
    assert reqs["ops.latency"] == MetricRequirement.OPTIONAL
    assert reqs["llm.relevance"] == MetricRequirement.REQUIRED


def test_operational_metrics_have_no_invented_scale():
    """The buckets that made these metrics look judged are gone.

    ``normalise_operational`` used to return 1.0 / 0.7 / 0.3 for a latency at
    five and ten seconds, and 1.0 / 0.6 / 0.2 for a token count at four and
    eight thousand. Nobody declared those numbers: the token buckets sat three
    orders of magnitude above real usage, so counts always passed, and a slower
    agent failed latency on every case forever. Both were constants dressed as
    findings.
    """
    from evalhub.evaluation.normalization import normalise_operational

    for seconds in (0.5, 4.9, 9.1, 15.0, 120.0):
        assert normalise_operational(seconds, "ops.latency") is None
    for tokens in (1.0, 301.0, 4000.0, 99_999.0):
        assert normalise_operational(tokens, "ops.total_token_count") is None
    # And the caller cannot smuggle a scale back in by omitting the metric id.
    assert normalise_operational(9.1) is None


def test_review_queue_names_only_the_gating_metric_that_failed():
    """A slow-but-correct case must not arrive as a CRITICAL token/latency finding.

    The queue drives Finding severity — CRITICAL whenever its gate is FAIL — so an
    unbudgeted latency (threshold_result None, read as "not PASS") produced
    CRITICAL findings titled by token counts, while the run report labelled those
    same metrics "Diagnostic - does not gate". Both screens cannot be true.

    The gate must be non-PASS here, or the queue is empty for an unrelated reason
    and the assertion proves nothing.
    """
    row = EvaluationRow(
        row_id="ops-queue-1",
        query="What is 2 + 2?",
        response="2 plus 2 is 4.",
        expected_response="4",
        latency_ms=15000,
        target_usage={"total_tokens": 9000},
    )
    set_row_overrides({"ops-queue-1": {"llm.relevance": 1.0}})
    try:
        result = _dispatch_engine().execute(
            LLM_CORE,
            [row],
            metric_ids=["llm.relevance", "ops.latency", "ops.total_token_count"],
        )
    finally:
        set_row_overrides({})

    assert result.overall_gate != GateResult.PASS
    assert _result_for(result.metric_results, "ops.latency").threshold_result is None
    assert [item.failing_metrics for item in result.review_queue] == [["llm.relevance"]]


def test_a_diagnostic_metric_raises_no_finding_even_with_a_real_threshold():
    """The rule is the requirement, not the ``ops.`` prefix.

    A catalog-diagnostic quality metric carries a real threshold and can genuinely
    reach FAIL, unlike an unbudgeted operational reading. It is still diagnostic,
    so it must not put a case in front of a reviewer as a CRITICAL finding while
    the run report labels that same metric "does not gate".
    """
    from evalhub.evaluation.rca import metric_result_failed

    def result(requirement: MetricRequirement, threshold: GateResult | None) -> MetricResult:
        # The model requires a complete verdict or none at all, so the no-verdict
        # case drops the score with it — the same shape an unbudgeted metric records.
        verdict = threshold is not None
        return MetricResult(
            metric_id="llm.text_overlap",
            evaluator_instance_id="llm.text_overlap-instance",
            run_id="run-1",
            row_id="row-1",
            score=0.1,
            normalised_score=0.1 if verdict else None,
            metric_status=MetricStatus.SCORED,
            metric_requirement=requirement,
            threshold_result=threshold,
            passed=(threshold == GateResult.PASS) if verdict else None,
            threshold=0.5,
            dataset_version="dataset-v1",
        )

    assert metric_result_failed(result(MetricRequirement.REQUIRED, GateResult.FAIL)) is True
    assert metric_result_failed(result(MetricRequirement.REQUIRED, GateResult.WARN)) is True
    assert metric_result_failed(result(MetricRequirement.OPTIONAL, GateResult.FAIL)) is False
    # No verdict is not a failure, whatever the requirement says.
    assert metric_result_failed(result(MetricRequirement.REQUIRED, None)) is False
    assert metric_result_failed(result(MetricRequirement.REQUIRED, GateResult.PASS)) is False
