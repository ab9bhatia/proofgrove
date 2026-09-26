"""Tests for traceability, versioning, lineage and lifecycle event logging."""

import logging

from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.enums import EvaluationScope, GateResult, TriggerReason
from proofgrove.evaluation.judge import MockJudge
from proofgrove.evaluation.lineage import compute_experiment_version_id
from proofgrove.evaluation.report import build_ci_callback, build_report
from proofgrove.evaluation.sample_data import SAMPLE_EXPERIMENTS, get_sample_rows
from proofgrove.evaluation.scenario_router import build_evaluator_configs
from proofgrove.events import EvalEvent, emit
from proofgrove.platform.resolver import resolve_scoring_configuration
from proofgrove.version import PROMPT_VERSION


def _run(trigger=TriggerReason.MANUAL, correlation_id=None):
    engine = EvaluationEngine(judge=MockJudge())
    exp = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")
    return engine.execute(exp, rows, None, trigger, correlation_id)


def test_experiment_version_id_is_deterministic_and_sensitive():
    exp = SAMPLE_EXPERIMENTS[1]
    metrics, _, _ = build_evaluator_configs(exp)
    ids = [m.metric_id for m in metrics]

    v1 = compute_experiment_version_id(exp, ids, PROMPT_VERSION)
    v2 = compute_experiment_version_id(exp, ids, PROMPT_VERSION)
    assert v1 == v2 and v1.startswith("exp-")

    # A different metric set (or prompt version) yields a different fingerprint.
    assert compute_experiment_version_id(exp, ids[:-1], PROMPT_VERSION) != v1
    assert compute_experiment_version_id(exp, ids, "rubrics.v2") != v1
    assert compute_experiment_version_id(
        exp,
        ids,
        PROMPT_VERSION,
        run_manifest_hash="manifest-hash-a",
    ) != compute_experiment_version_id(
        exp,
        ids,
        PROMPT_VERSION,
        run_manifest_hash="manifest-hash-b",
    )

    scoped = exp.model_copy(update={"evaluation_scope": EvaluationScope.TOOL_INTERACTIONS})
    assert compute_experiment_version_id(scoped, ids, PROMPT_VERSION) != v1


def test_run_carries_lineage_and_trigger_reason():
    run = _run(trigger=TriggerReason.CI, correlation_id="corr-123")

    assert run.trigger_reason == TriggerReason.CI
    assert run.correlation_id == "corr-123"
    assert run.experiment_version_id and run.experiment_version_id.startswith("exp-")
    assert run.prompt_version == PROMPT_VERSION

    lin = run.lineage
    assert lin is not None
    assert lin.judge_mode == "mock"
    assert lin.experiment_version_id == run.experiment_version_id
    assert lin.service_version
    assert set(lin.framework_versions) == {"ragas", "deepeval"}
    assert lin.evaluation_scope is None


def test_run_consumes_frozen_dataset_scoring_configuration():
    exp = SAMPLE_EXPERIMENTS[0]
    configuration = resolve_scoring_configuration(
        metric_ids=["llm.correctness", "ops.latency"],
        explicit_metric_ids=set(),
        scenario=exp.scenario,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
    )
    run = EvaluationEngine(judge=MockJudge()).execute(
        exp,
        get_sample_rows("exp-llm-core-v1"),
        scoring_configuration=configuration,
    )

    assert run.lineage is not None
    assert run.lineage.run_configuration_hash == configuration.configuration_hash
    assert run.lineage.metric_requirements == [item.model_dump(mode="json") for item in configuration.metric_requirements]
    assert run.lineage.kpi_compositions == [item.model_dump(mode="json") for item in configuration.kpi_compositions]
    source_by_metric = {result.metric_id: result.metric_requirement_source.value for result in run.metric_results}
    assert source_by_metric == {
        "llm.correctness": "legacy_scenario_primary",
        "ops.latency": "legacy_cross_cutting",
    }


def test_correlation_id_defaults_to_run_id():
    run = _run()
    assert run.correlation_id == run.run_id


def test_prompt_version_stamped_on_metric_results():
    run = _run()
    assert run.metric_results
    assert all(mr.prompt_version == PROMPT_VERSION for mr in run.metric_results)


def test_report_surfaces_lineage_and_trigger():
    run = _run(trigger=TriggerReason.DATASET_CHANGE)
    report = build_report(run)
    assert report["trigger_reason"] == "dataset_change"
    assert report["experiment_version_id"] == run.experiment_version_id
    assert report["lineage"]["judge_mode"] == "mock"
    assert report["scorer_provenance"][0]["unscored_reason"] == "simulated"
    assert report["scorer_provenance"][0]["executed_scorer"] == "mock"
    assert report["kpi_scorecards"][0]["coverage_label"] == "incomplete"


def test_ci_callback_review_required_follows_resolved_review_gates():
    """A failed run is flagged for review; a narrowed policy is honoured."""
    run = _run()
    assert run.lineage is not None

    run.overall_gate = GateResult.FAIL
    assert build_ci_callback(run)["review_required"] is True
    run.overall_gate = GateResult.WARN
    assert build_ci_callback(run)["review_required"] is True

    run.lineage.review_trigger_gates = [GateResult.FAIL]
    assert build_ci_callback(run)["review_required"] is False
    run.overall_gate = GateResult.PASS
    assert build_ci_callback(run)["review_required"] is False


def test_emit_returns_payload_and_logs(caplog):
    with caplog.at_level(logging.INFO, logger="proofgrove.events"):
        payload = emit(EvalEvent.RUN_CREATED, correlation_id="c1", run_id="r1", dropped=None)

    assert payload == {"event": "RUN_CREATED", "run_id": "r1", "correlation_id": "c1"}
    assert "dropped" not in payload  # None fields are dropped
    record = next(r for r in caplog.records if getattr(r, "eval_event", None) == "RUN_CREATED")
    assert record.eval_fields["run_id"] == "r1"


def test_run_emits_lifecycle_events(caplog):
    with caplog.at_level(logging.INFO, logger="proofgrove.events"):
        _run()
    events = {getattr(r, "eval_event", None) for r in caplog.records}
    assert {
        "RUN_CREATED",
        "FRAMEWORK_EVALUATION_STARTED",
        "FRAMEWORK_EVALUATED",
        "RUN_COMPLETED",
    } <= events
