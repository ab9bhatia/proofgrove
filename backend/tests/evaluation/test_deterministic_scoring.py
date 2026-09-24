"""Tests for deterministic NLP reference scorers."""

import math

import pytest

from evalhub.evaluation.adapters.deterministic_adapter import (
    DeterministicJudge,
    _bleu,
    _gleu,
    _meteor,
)
from evalhub.evaluation.adapters.dispatcher import AdapterDispatchJudge
from evalhub.evaluation.engine import _metric_not_applicable, _recorded_judge_model
from evalhub.evaluation.enums import Scenario
from evalhub.evaluation.metrics import METRIC_CATALOG
from evalhub.evaluation.models import (
    EvaluationRow,
    EvaluatorConfig,
    ExperimentDefinition,
)
from evalhub.settings import Settings


def _config(metric_id: str) -> EvaluatorConfig:
    metric = METRIC_CATALOG[metric_id]
    return EvaluatorConfig(
        metric_id=metric_id,
        instance_id=f"{metric_id}-1",
        adapter=metric.default_adapter,
        adapter_class=metric.adapter_class,
        scoring_type=metric.scoring_type,
        score_range=metric.score_range,
    )


@pytest.mark.parametrize(
    "metric_id",
    ["nlp.f1_score", "nlp.bleu", "nlp.rouge", "nlp.meteor", "nlp.gleu"],
)
def test_identical_text_scores_one(metric_id):
    row = EvaluationRow(
        row_id="r1",
        query="q",
        response="The cat sat.",
        expected_response="The cat sat.",
    )
    result = DeterministicJudge().evaluate(_config(metric_id), row)
    # Standard METEOR retains a small fragmentation penalty even for an exact
    # multi-token match; every deterministic scorer should still be near-perfect.
    assert result.score == pytest.approx(1.0, abs=0.02)
    assert result.prompt_tokens == 0


def test_missing_reference_is_unscored():
    row = EvaluationRow(row_id="r1", query="q", response="answer")
    result = DeterministicJudge().evaluate(_config("nlp.rouge"), row)
    assert result.score is None
    assert result.missing_evidence == ["expected_response"]


def test_dispatcher_runs_deterministic_metric_with_frameworks_disabled():
    row = EvaluationRow(row_id="r1", query="q", response="same", expected_response="same")
    judge = AdapterDispatchJudge(Settings(judge_mode="mock", judge_use_frameworks=False))
    result = judge.evaluate(_config("nlp.f1_score"), row)
    assert result.score == 1.0
    assert result.executed_scorer == "deterministic"


def test_document_recall_uses_declared_document_identifiers():
    row = EvaluationRow(
        row_id="r1",
        query="q",
        response="answer",
        expected_response="answer",
        input_data={"retrieved_doc_ids": ["doc-a", "doc-c"]},
        expected_data={"expected_doc_ids": "doc-a doc-b"},
    )
    result = DeterministicJudge().evaluate(_config("rag.document_recall"), row)
    assert result.score == 0.5
    assert "doc-b" in result.rationale


def test_document_recall_does_not_fabricate_zero_when_ids_are_missing():
    row = EvaluationRow(
        row_id="r1",
        query="q",
        response="answer",
        expected_response="answer",
        expected_data={"expected_doc_ids": ["doc-a"]},
    )
    result = DeterministicJudge().evaluate(_config("rag.document_recall"), row)
    assert result.score is None
    assert result.missing_evidence == ["retrieved_document_ids"]


def test_empty_declared_document_expectation_is_not_applicable():
    row = EvaluationRow(
        row_id="r1",
        query="q",
        response="answer",
        expected_response="answer",
        expected_data={"expected_doc_ids": []},
    )
    # The helper returns the reason it does not apply, which is recorded on the
    # result — a bare flag left one hardcoded string describing several causes.
    assert _metric_not_applicable("rag.document_recall", row) == ("the case declares no expected documents")


@pytest.mark.parametrize(
    ("metric_id", "expected"),
    [
        ("ops.latency", 1.25),
        ("ops.input_token_count", 10.0),
        ("ops.output_token_count", 4.0),
        ("ops.total_token_count", 14.0),
    ],
)
def test_operational_metrics_use_target_telemetry(metric_id, expected):
    row = EvaluationRow(
        row_id="r1",
        query="q",
        response="answer",
        latency_ms=1250,
        target_usage={"prompt_tokens": 10, "completion_tokens": 4},
    )
    result = DeterministicJudge().evaluate(_config(metric_id), row)
    assert result.score == expected
    assert result.prompt_tokens == 0


def test_missing_target_usage_is_unscored():
    row = EvaluationRow(row_id="r1", query="q", response="answer")
    result = DeterministicJudge().evaluate(_config("ops.total_token_count"), row)
    assert result.score is None
    assert result.missing_evidence == ["target_usage"]


def test_deterministic_metric_does_not_record_configured_judge_model():
    config = _config("ops.latency").model_copy(update={"judge_model": "gpt-4.1-mini"})
    experiment = ExperimentDefinition(
        name="deterministic provenance",
        dataset_version="dataset.v1",
        target_endpoint="llm-catalog:gpt-4.1-mini",
        scenario=Scenario.LLM_CORE,
        judge_model="gpt-4.1-mini",
    )
    row = EvaluationRow(row_id="r1", query="q", response="answer", latency_ms=1250)

    assert _recorded_judge_model(config, experiment, row) is None


# ---------------------------------------------------------------------------
# BLEU / METEOR / GLEU against hand-computed values from the published
# formulas (Papineni et al. 2002 + Chen & Cherry 2014; Banerjee & Lavie 2005;
# Wu et al. 2016). No nltk/sacrebleu/evaluate package is installed in this
# project (checked via `uv pip list`), and neither ragas's BleuScore nor
# deepeval's sentence_bleu_score is usable without one of those, so these
# scorers are hand-rolled and verified directly against the papers' formulas
# rather than against a library.
# ---------------------------------------------------------------------------


def test_bleu_clipped_precision_is_not_inflated_by_smoothing():
    """Every n-gram order here has nonzero overlap, so no smoothing should
    apply at all. The previous implementation added +1 to every order
    unconditionally, which would have inflated this to (1+1)/(2+1) = 0.667."""
    reference = ["the"]
    candidate = ["the", "the"]
    assert _bleu(reference, candidate) == pytest.approx(0.5)


def test_bleu_smoothing_only_touches_the_zero_order():
    """order 1: overlap=1/total=2 -> 0.5 (untouched, real overlap).
    order 2: overlap=0/total=1 -> Chen & Cherry method-1 smoothing gives
    epsilon/total = 0.1/1 = 0.1, not 0."""
    reference = ["a", "b"]
    candidate = ["a", "c"]
    expected = math.exp((math.log(0.5) + math.log(0.1)) / 2)
    assert _bleu(reference, candidate) == pytest.approx(expected)


def test_bleu_identical_text_is_one():
    tokens = ["the", "cat", "sat", "on", "the", "mat"]
    assert _bleu(tokens, list(tokens)) == pytest.approx(1.0)


def test_bleu_empty_candidate_is_zero():
    assert _bleu(["a", "b"], []) == 0.0


def test_meteor_prefers_chunk_continuing_alignment():
    """reference has 'a' at indices 0 and 6, with 'm' at index 5 right before
    the second 'a'. candidate = ['m', 'a'] should align 'a' to index 6
    (continuing the 'm'->'a' chunk) rather than to the lower index 0.

    matches=2, precision=1, recall=2/7 -> harmonic = 10*(2/7) / (2/7 + 9) = 4/13.
    Correct (chunk-continuing) alignment: chunks=1 -> penalty=0.5*(1/2)**3=0.0625
      -> score = (4/13) * 0.9375 = 3.75/13.
    The previous lowest-index-first alignment gets chunks=2 -> penalty=0.5
      -> score = (4/13) * 0.5 = 2/13 -- noticeably lower for no real reason.
    """
    reference = ["a", "p", "q", "r", "s", "m", "a"]
    candidate = ["m", "a"]
    expected = (4 / 13) * (1 - 0.5 * (1 / 2) ** 3)
    assert _meteor(reference, candidate) == pytest.approx(expected)
    assert _meteor(reference, candidate) > (4 / 13) * 0.5  # strictly beats the old alignment


def test_meteor_identical_text_is_near_one():
    tokens = ["the", "cat", "sat"]
    assert _meteor(tokens, list(tokens)) == pytest.approx(1.0, abs=0.02)


def test_meteor_empty_candidate_is_zero():
    assert _meteor(["a", "b"], []) == 0.0


def test_gleu_pools_ngram_counts_across_orders_instead_of_averaging_per_order():
    """order1: overlap=3/4 each side. order2: overlap=1/3 each side.
    order3: overlap=0/2. order4: overlap=0/1.
    Pooled (Wu et al. 2016): overlap=3+1+0+0=4, totals=4+3+2+1=10 each side
      -> min(0.4, 0.4) = 0.4 exactly.
    Per-order average (the previous, non-standard behaviour):
      mean([0.75, 1/3, 0, 0]) = 0.270833... -- a different, lower number.
    """
    reference = ["a", "b", "c", "d"]
    candidate = ["a", "x", "c", "d"]
    assert _gleu(reference, candidate) == pytest.approx(0.4)
    per_order_average = sum([0.75, 1 / 3, 0.0, 0.0]) / 4
    assert _gleu(reference, candidate) != pytest.approx(per_order_average)


def test_gleu_identical_text_is_one():
    tokens = ["the", "cat", "sat"]
    assert _gleu(tokens, list(tokens)) == pytest.approx(1.0)


def test_gleu_empty_candidate_is_zero():
    assert _gleu(["a", "b"], []) == 0.0


def test_meteor_repeated_tokens_prefer_chunk_continuation():
    """Alignment contract regression (stack2-recovery 2026-09-15).

    Reference ``a b a`` vs candidate ``b a a``: preferring the reference
    occurrence adjacent to the previous match keeps the ``b a`` chunk intact
    (2 chunks -> 0.8518...). An earliest-unused-occurrence queue fragments the
    alignment into 3 chunks and scores 0.5 -- a scoring change, not a speedup.
    Any future performance rewrite must keep this exact value.
    """
    assert _meteor(["a", "b", "a"], ["b", "a", "a"]) == pytest.approx(0.8518518518518519)


def test_meteor_repeated_tokens_out_of_order_occurrences():
    """Repeated words with mismatched occurrence order still align fully."""
    score = _meteor(["x", "y", "x", "x"], ["x", "x", "y", "x"])
    assert 0.0 < score <= 1.0
    assert score == pytest.approx(_meteor(["x", "y", "x", "x"], ["x", "x", "y", "x"]))


def test_rouge_l_beyond_the_token_limit_is_unscored_not_distorted():
    """Batch-1 review regression, round 2: a truncated ROUGE-L window scored
    1,000 matching tokens followed by 1,000 different ones as a perfect 1.0,
    and the round-1 cap scored identical 2,000-token texts as 0.5. Beyond the
    DoS bound the metric now returns score=None with an explicit rationale —
    an unscored metric, never a distorted number."""
    from evalhub.evaluation.adapters.deterministic_adapter import _rouge_l
    from evalhub.evaluation.models import EvaluationRow

    matching = [f"token{i}" for i in range(1000)]
    text = " ".join(matching + [f"other{i}" for i in range(1000)])
    result = DeterministicJudge().evaluate(
        _config("nlp.rouge"),
        EvaluationRow(row_id="r", query="q", response=text, expected_response=" ".join(matching * 2)),
    )
    assert result.score is None
    assert "not scored" in result.rationale

    # Below the bound the score is EXACT — no truncation of either side.
    assert _rouge_l(["a", "b", "c"], ["a", "x", "c"]) == pytest.approx(2 / 3)
