"""Operational measurements compare on their own values, not on a score."""

from proofgrove.db.store import measurement_values
from proofgrove.evaluation.models import MetricResult, RunResult


def _run(*results: MetricResult) -> RunResult:
    return RunResult.model_construct(metric_results=list(results))


def _result(metric_id: str, score, normalised=None) -> MetricResult:
    return MetricResult.model_construct(
        metric_id=metric_id, score=score, normalised_score=normalised
    )


def test_measurements_are_read_from_the_captured_value():
    """The score comparison skips these, because they have no normalised form.

    A measurement carries no verdict, so nothing normalises it — which is
    exactly why comparing runs on normalised scores left latency and token use
    out. They are the metrics whose whole purpose is "did this run cost more
    than that one".
    """
    run = _run(
        _result("ops.latency", 1.007),
        _result("ops.latency", 2.013),
        _result("ops.total_token_count", 4200.0),
        _result("llm.coherence", 5.0, normalised=1.0),
    )

    values = measurement_values(run)

    assert values == {"ops.latency": [1.007, 2.013], "ops.total_token_count": [4200.0]}
    assert "llm.coherence" not in values, "a judged metric is compared on its score, not here"


def test_a_metric_with_no_captured_value_is_skipped():
    """An unscored measurement contributes nothing rather than a zero.

    A provided-response run cannot measure latency at all; averaging in a
    missing value would report a run as faster than it was.
    """
    assert measurement_values(_run(_result("ops.latency", None))) == {}


def test_a_boolean_is_not_a_measurement():
    """`bool` subclasses `int`, so True would otherwise average in as 1.0."""
    assert measurement_values(_run(_result("ops.latency", True))) == {}


def test_a_single_metric_can_be_isolated():
    run = _run(_result("ops.latency", 1.5), _result("ops.total_token_count", 900.0))

    assert measurement_values(run, "ops.latency") == {"ops.latency": [1.5]}


async def _comparison_for_scores(candidate_scores):
    from unittest.mock import AsyncMock, MagicMock

    from proofgrove.db.store import EvaluationStore
    from proofgrove.evaluation.enums import Scenario
    from proofgrove.evaluation.models import ExperimentDefinition

    experiment = ExperimentDefinition(
        name="comparison", dataset_version="v", target_endpoint="https://target.example", scenario=Scenario.LLM_CORE,
    )

    def run(scores):
        results = [MetricResult.model_construct(
            metric_id=metric, row_id="r", evaluator_instance_id=metric,
            score=score, normalised_score=score,
            passed=None if score is None else score >= 0.5,
        ) for metric, score in scores.items()]
        return RunResult.model_construct(
            experiment=experiment, metric_results=results, kpi_results=[],
            experiment_version_id="same-version", lineage=None, overall_gate=None,
        )

    session = MagicMock()
    records = MagicMock()
    records.scalars.return_value.all.return_value = []
    session.execute = AsyncMock(return_value=records)
    store = EvaluationStore(session)
    store.get_run = AsyncMock(side_effect=[
        run({"llm.correctness": 0.0, "llm.relevance": 1.0}), run(candidate_scores),
    ])
    store.experiment_has_run = AsyncMock(return_value=True)
    return await store.compare_runs("experiment", "base", "candidate")


def test_unscored_or_missing_metric_is_not_a_fix_or_improvement():
    import asyncio

    for candidate in [
        {"llm.correctness": None, "llm.relevance": 1.0},
        {"llm.relevance": 1.0},
    ]:
        comparison = asyncio.run(_comparison_for_scores(candidate))
        assert comparison.metric_failures["fixed"] == []
        assert comparison.sample_counts["unavailable"] == 1
        assert comparison.sample_deltas[0]["delta"] is None


def test_completed_matching_scores_can_show_a_fix_and_improvement():
    import asyncio

    comparison = asyncio.run(_comparison_for_scores({"llm.correctness": 1.0, "llm.relevance": 1.0}))
    assert comparison.metric_failures["fixed"] == ["llm.correctness"]
    assert comparison.sample_counts["improved"] == 1
    assert comparison.sample_deltas[0]["delta"] == 0.5
