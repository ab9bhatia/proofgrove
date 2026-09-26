"""RAGAS adapter -- no-score handling and loop-safe async scoring."""

import pytest

from proofgrove.evaluation.adapters.ragas_adapter import RagasJudge
from proofgrove.evaluation.enums import Adapter, ScoringType
from proofgrove.evaluation.models import EvaluationRow, EvaluatorConfig
from proofgrove.settings import Settings


class _ScoreResult:
    def __init__(self, value):
        self.value = value


class _FakeCollectionsMetric:
    """Stand-in for a collections-API RAGAS scorer (async ``ascore``)."""

    def __init__(self, value):
        self._value = value
        self.calls = 0

    async def ascore(self, **kwargs):
        self.calls += 1
        return _ScoreResult(self._value)


def _judge() -> RagasJudge:
    return RagasJudge(Settings(openai_api_key="test-key", judge_mode="llm"))


def _config() -> EvaluatorConfig:
    return EvaluatorConfig(
        metric_id="rag.chunk_relevance",
        instance_id="test",
        adapter=Adapter.MOCK,
        adapter_class="ragas",
        scoring_type=ScoringType.SCALE,
    )


def _row() -> EvaluationRow:
    return EvaluationRow(row_id="r1", query="q", response="r", context=["chunk one"])


def test_ragas_none_value_raises_instead_of_defaulting():
    judge = _judge()
    fake = _FakeCollectionsMetric(None)
    judge._metric = lambda metric_id: fake

    with pytest.raises(ValueError, match="returned no score"):
        judge.evaluate(_config(), _row())


def test_ragas_real_value_scores_successfully():
    judge = _judge()
    fake = _FakeCollectionsMetric(0.8)
    judge._metric = lambda metric_id: fake

    result = judge.evaluate(_config(), _row())

    assert result.score is not None
    assert fake.calls == 1


def test_ragas_reuses_one_event_loop_across_rows():
    """Per-row ``asyncio.run()`` builds/closes a loop each call; a threadpool
    worker thread is reused across a run's rows, so a second row's fresh loop
    used to be a different loop than any async resource RAGAS cached against
    the first. One loop for the judge's lifetime avoids that.
    """
    judge = _judge()
    fake = _FakeCollectionsMetric(0.8)
    judge._metric = lambda metric_id: fake

    judge.evaluate(_config(), _row())
    first_loop = judge._loop
    assert first_loop is not None
    assert not first_loop.is_closed()

    judge.evaluate(_config(), _row())
    assert judge._loop is first_loop
    assert not first_loop.is_closed()
    assert fake.calls == 2


def test_ragas_single_turn_none_score_also_raises():
    judge = _judge()

    class _FakeSyncMetric:
        def single_turn_score(self, sample):
            return None

    judge._metric = lambda metric_id: _FakeSyncMetric()

    config = EvaluatorConfig(
        metric_id="rag.groundedness",
        instance_id="test",
        adapter=Adapter.MOCK,
        adapter_class="ragas",
        scoring_type=ScoringType.FLOAT,
    )
    row = EvaluationRow(row_id="r1", query="q", response="r", context=["ctx"])

    with pytest.raises(ValueError, match="returned no score"):
        judge.evaluate(config, row)
