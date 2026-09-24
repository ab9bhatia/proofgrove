"""DeepEval adapter -- a metric with no score must error, never report safe."""

import pytest

from evalhub.evaluation.adapters.deepeval_adapter import DeepEvalJudge
from evalhub.evaluation.enums import Adapter, ScoringType
from evalhub.evaluation.models import EvaluationRow, EvaluatorConfig
from evalhub.settings import Settings


class _NoneScoreMetric:
    score = None
    reason = "could not compute"

    def measure(self, test_case):
        return None


def _judge() -> DeepEvalJudge:
    return DeepEvalJudge(Settings(openai_api_key="test-key", judge_mode="llm"))


def test_deepeval_none_score_raises_instead_of_defaulting():
    judge = _judge()
    judge._metric = lambda config: _NoneScoreMetric()

    config = EvaluatorConfig(
        metric_id="llm.correctness",
        instance_id="test",
        adapter=Adapter.MOCK,
        adapter_class="deepeval",
        scoring_type=ScoringType.BINARY,
    )
    row = EvaluationRow(row_id="r1", query="q", response="r", expected_response="r")

    with pytest.raises(ValueError, match="returned no score"):
        judge.evaluate(config, row)


def test_deepeval_toxicity_none_score_does_not_report_safe():
    """``safety.general`` is inverted (goodness = 1 - badness).

    A ``None`` score previously defaulted to 0.0 badness, which computed as
    unit=1.0 -- the maximally "safe" verdict for content the scorer never
    actually judged. It must error instead.
    """
    judge = _judge()
    judge._metric = lambda config: _NoneScoreMetric()

    config = EvaluatorConfig(
        metric_id="safety.general",
        instance_id="test",
        adapter=Adapter.MOCK,
        adapter_class="deepeval",
        scoring_type=ScoringType.SEVERITY,
    )
    row = EvaluationRow(row_id="r1", query="q", response="r")

    with pytest.raises(ValueError, match="returned no score"):
        judge.evaluate(config, row)


def test_deepeval_real_score_is_unaffected():
    class _RealMetric:
        score = 0.75
        reason = "mostly correct"

        def measure(self, test_case):
            return None

    judge = _judge()
    judge._metric = lambda config: _RealMetric()

    config = EvaluatorConfig(
        metric_id="llm.correctness",
        instance_id="test",
        adapter=Adapter.MOCK,
        adapter_class="deepeval",
        scoring_type=ScoringType.BINARY,
    )
    row = EvaluationRow(row_id="r1", query="q", response="r", expected_response="r")

    result = judge.evaluate(config, row)
    # llm.correctness is BINARY: unit 0.75 maps to raw 1.0 ("yes").
    assert result.score == 1.0
