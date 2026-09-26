"""Deterministic scorers over immutable reference and target evidence.

These scorers remain available when judge frameworks are disabled and never
turn missing ground truth or target telemetry into a fabricated zero.
"""

from __future__ import annotations

import math
import re
from collections import Counter

from proofgrove.evaluation.llm_judge import JudgeResult
from proofgrove.evaluation.models import EvaluationRow, EvaluatorConfig

_SUPPORTED = {
    "rag.document_recall",
    "ops.latency",
    "ops.total_token_count",
    "ops.input_token_count",
    "ops.output_token_count",
    "nlp.f1_score",
    "nlp.bleu",
    "nlp.rouge",
    "nlp.meteor",
    "nlp.gleu",
}


def supported_metrics() -> set[str]:
    return set(_SUPPORTED)


class DeterministicJudge:
    """Score reference text, document recall, and target telemetry without an LLM."""

    def evaluate(self, config: EvaluatorConfig, row: EvaluationRow) -> JudgeResult:
        if config.metric_id not in _SUPPORTED:
            raise ValueError(f"DeterministicJudge cannot score metric {config.metric_id}")
        if config.metric_id == "rag.document_recall":
            return _document_recall(row)
        if config.metric_id.startswith("ops."):
            return _operational(config.metric_id, row)
        if not row.expected_response:
            return JudgeResult(
                score=None,
                label=None,
                rationale="Expected response unavailable — reference-text metric cannot be computed.",
                prompt_tokens=0,
                completion_tokens=0,
                missing_evidence=["expected_response"],
            )

        reference = _tokens(row.expected_response)
        candidate = _tokens(row.response)
        if config.metric_id == "nlp.rouge" and max(len(reference), len(candidate)) > _LCS_TOKEN_CAP:
            # Exact ROUGE-L is quadratic; beyond the bound the honest answer is
            # "not scored", never a truncated look-alike (see _LCS_TOKEN_CAP).
            return JudgeResult(
                score=None,
                label=None,
                rationale=(
                    f"Input exceeds the {_LCS_TOKEN_CAP}-token limit for exact ROUGE-L "
                    f"(reference {len(reference)}, response {len(candidate)}); metric not scored."
                ),
                prompt_tokens=0,
                completion_tokens=0,
            )
        scorers = {
            "nlp.f1_score": _token_f1,
            "nlp.bleu": _bleu,
            "nlp.rouge": _rouge_l,
            "nlp.meteor": _meteor,
            "nlp.gleu": _gleu,
        }
        score = scorers[config.metric_id](reference, candidate)
        return JudgeResult(
            score=score,
            label=None,
            rationale=f"Deterministic {config.metric_id} score: {score:.3f}.",
            prompt_tokens=0,
            completion_tokens=0,
        )


_EXPECTED_DOCUMENT_KEYS = (
    "expected_doc_ids",
    "expected_document_ids",
    "required_document_ids",
    "relevant_doc_ids",
)
_OBSERVED_DOCUMENT_KEYS = (
    "retrieved_doc_ids",
    "retrieved_document_ids",
    "document_ids",
)


def _document_recall(row: EvaluationRow) -> JudgeResult:
    expected, expected_declared = _document_ids(row.expected_data, _EXPECTED_DOCUMENT_KEYS)
    observed, observed_declared = _document_ids(
        {**(row.input_data or {}), **(row.output_data or {})},
        _OBSERVED_DOCUMENT_KEYS,
    )
    if not expected_declared:
        return _missing("Expected document identifiers are not declared.", "expected_document_ids")
    if not expected:
        return _missing("No documents are required for this row.", "not_applicable")
    if not observed_declared:
        return _missing("Retrieved document identifiers were not captured.", "retrieved_document_ids")
    score = len(expected.intersection(observed)) / len(expected)
    return JudgeResult(
        score=score,
        label=None,
        rationale=(
            f"Retrieved {len(expected.intersection(observed))} of {len(expected)} expected documents; "
            f"missing {sorted(expected - observed)}."
        ),
        prompt_tokens=0,
        completion_tokens=0,
    )


def document_expectation(row: EvaluationRow) -> tuple[set[str], bool]:
    """Expose expected document IDs so applicability can use the same parser."""

    return _document_ids(row.expected_data, _EXPECTED_DOCUMENT_KEYS)


def _document_ids(payload: dict | None, keys: tuple[str, ...]) -> tuple[set[str], bool]:
    if not isinstance(payload, dict):
        return set(), False
    key = next((candidate for candidate in keys if candidate in payload), None)
    if key is None:
        return set(), False
    raw = payload.get(key)
    if raw is None:
        return set(), True
    if isinstance(raw, str):
        values = re.split(r"[\s,;]+", raw)
    elif isinstance(raw, (list, tuple, set)):
        values = list(raw)
    else:
        values = [raw]
    return {str(value).strip() for value in values if str(value).strip()}, True


def usage_total_tokens(usage: dict | None) -> float | None:
    """Total token count from target usage telemetry, or None if not captured."""

    usage = usage if isinstance(usage, dict) else {}
    total = _usage_value(usage, "total_tokens", "total_token_count")
    if total is not None:
        return total
    input_tokens = _usage_value(usage, "prompt_tokens", "input_tokens", "prompt_token_count")
    output_tokens = _usage_value(usage, "output_tokens", "completion_tokens", "candidates_token_count")
    if input_tokens is not None and output_tokens is not None:
        return input_tokens + output_tokens
    return None


def _operational(metric_id: str, row: EvaluationRow) -> JudgeResult:
    if metric_id == "ops.latency":
        if row.latency_ms is None:
            return _missing("Target latency was not captured.", "latency_ms")
        value = row.latency_ms / 1000
        unit = "seconds"
    else:
        usage = row.target_usage or {}
        if metric_id == "ops.input_token_count":
            value = _usage_value(usage, "prompt_tokens", "input_tokens", "prompt_token_count")
        elif metric_id == "ops.output_token_count":
            value = _usage_value(usage, "output_tokens", "completion_tokens", "candidates_token_count")
        else:
            value = usage_total_tokens(usage)
        if value is None:
            return _missing("Target token usage was not captured.", "target_usage")
        unit = "tokens"
    return JudgeResult(
        score=float(value),
        label=None,
        rationale=f"Captured target {metric_id}: {value:g} {unit}.",
        prompt_tokens=0,
        completion_tokens=0,
    )


def usage_field_value(usage: dict, *keys: str) -> float | None:
    """Public reader for one usage field across the key spellings runners emit."""
    return _usage_value(usage, *keys)


def _usage_value(usage: dict, *keys: str) -> float | None:
    for key in keys:
        value = usage.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            return float(value)
    return None


def _missing(message: str, category: str) -> JudgeResult:
    return JudgeResult(
        score=None,
        label=None,
        rationale=message,
        prompt_tokens=0,
        completion_tokens=0,
        missing_evidence=[category],
    )


def _tokens(text: str) -> list[str]:
    return re.findall(r"\w+", text.casefold(), flags=re.UNICODE)


def _token_f1(reference: list[str], candidate: list[str]) -> float:
    if not reference and not candidate:
        return 1.0
    if not reference or not candidate:
        return 0.0
    overlap = sum((Counter(reference) & Counter(candidate)).values())
    precision = overlap / len(candidate)
    recall = overlap / len(reference)
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def _ngrams(tokens: list[str], size: int) -> Counter[tuple[str, ...]]:
    return Counter(tuple(tokens[index : index + size]) for index in range(len(tokens) - size + 1))


def _bleu(reference: list[str], candidate: list[str]) -> float:
    """Sentence-level BLEU (Papineni, Roukos, Ward & Zhu, 2002, "BLEU: a
    Method for Automatic Evaluation of Machine Translation", ACL):
    ``BP * exp(mean_n log p_n)`` for n-grams of order 1..4, ``p_n`` the
    clipped n-gram precision and ``BP`` the brevity penalty.

    Zero-count orders use Chen & Cherry (2014, "A Systematic Comparison of
    Smoothing Techniques for Sentence-Level BLEU", WMT) smoothing method 1:
    an order with no overlap gets ``epsilon / total`` instead of ``0`` so one
    absent high-order n-gram doesn't zero the whole score. This applies only
    to orders that actually have zero overlap -- the previous version added
    ``+1`` to every order unconditionally, which also inflated precisions
    that already had real, nonzero overlap.
    """
    if not candidate or not reference:
        return 0.0
    maximum_order = min(4, len(reference), len(candidate))
    if maximum_order == 0:
        return 0.0
    epsilon = 0.1
    log_precision_sum = 0.0
    for size in range(1, maximum_order + 1):
        reference_ngrams = _ngrams(reference, size)
        candidate_ngrams = _ngrams(candidate, size)
        overlap = sum((reference_ngrams & candidate_ngrams).values())
        total = sum(candidate_ngrams.values())
        precision = (epsilon / total) if overlap == 0 else (overlap / total)
        if precision <= 0:
            return 0.0
        log_precision_sum += math.log(precision)
    brevity_penalty = 1.0 if len(candidate) >= len(reference) else math.exp(1 - len(reference) / len(candidate))
    return max(0.0, min(1.0, brevity_penalty * math.exp(log_precision_sum / maximum_order)))


#: DoS bound for the O(n*m) LCS below. Inputs longer than this are not scored
#: at all (JudgeResult.score=None with an explicit rationale) rather than
#: truncated: capping only the LCS deflated scores silently, and truncating a
#: comparison window scored "1,000 equal tokens + 1,000 different ones" as a
#: perfect 1.0. No number beats a wrong number.
_LCS_TOKEN_CAP = 1000


def _lcs_length(left: list[str], right: list[str]) -> int:
    previous = [0] * (len(right) + 1)
    for left_token in left:
        current = [0]
        for index, right_token in enumerate(right, start=1):
            current.append(previous[index - 1] + 1 if left_token == right_token else max(current[-1], previous[index]))
        previous = current
    return previous[-1]


def _rouge_l(reference: list[str], candidate: list[str]) -> float:
    if not reference and not candidate:
        return 1.0
    if not reference or not candidate:
        return 0.0
    common = _lcs_length(reference, candidate)
    precision = common / len(candidate)
    recall = common / len(reference)
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def _meteor(reference: list[str], candidate: list[str]) -> float:
    """Corpus-free unigram METEOR (Banerjee & Lavie, 2005, "METEOR: An
    Automatic Metric for MT Evaluation with Improved Correlation with Human
    Judgments", ACL Workshop). Exact-token alignment only -- no stem or
    synonym modules, which the published metric also has and this
    implementation deliberately omits (no corpus / WordNet resources here).

    ``F_mean = 10PR / (R + 9P)`` weights recall 9x precision, then a
    fragmentation penalty ``0.5 * (chunks / matches) ** 3`` discounts
    scattered alignments: a chunk is contiguous in both token sequences.

    Alignment: for each candidate token, in order, prefer the reference
    occurrence immediately after the previous match (continuing its chunk)
    over any other unused occurrence of the same token. Occurrences of the
    same token are interchangeable, so this choice never removes an option a
    later match of that token could have used -- it can only reduce chunk
    count relative to always taking the lowest-index occurrence regardless
    of continuity, which is what the previous version did and which
    over-counts fragmentation whenever a repeated word's occurrences are not
    in matching left-to-right order between candidate and reference. This is
    a greedy heuristic, not an exhaustive minimum-chunk search -- the
    reference METEOR toolkit itself does not search exhaustively either,
    for the same combinatorial reason.
    """

    if not reference and not candidate:
        return 1.0
    if not reference or not candidate:
        return 0.0

    positions: dict[str, list[int]] = {}
    for index, token in enumerate(reference):
        positions.setdefault(token, []).append(index)

    aligned: list[tuple[int, int]] = []
    previous_index: int | None = None
    for candidate_index, token in enumerate(candidate):
        available = positions.get(token)
        if not available:
            continue
        if previous_index is not None and (previous_index + 1) in available:
            match = previous_index + 1
        else:
            match = available[0]
        available.remove(match)
        aligned.append((candidate_index, match))
        previous_index = match

    matches = len(aligned)
    if matches == 0:
        return 0.0
    precision = matches / len(candidate)
    recall = matches / len(reference)
    harmonic = (10 * precision * recall) / (recall + 9 * precision)
    chunks = 1 + sum(
        1 for left, right in zip(aligned, aligned[1:])
        if right[0] != left[0] + 1 or right[1] != left[1] + 1
    )
    return max(0.0, min(1.0, harmonic * (1 - 0.5 * (chunks / matches) ** 3)))


def _gleu(reference: list[str], candidate: list[str]) -> float:
    """Google-BLEU (Wu et al., 2016, "Google's Neural Machine Translation
    System: Bridging the Gap between Human and Machine Translation", App. A):
    ``min(precision, recall)`` over n-gram counts of order 1..4 *pooled*
    into one ratio -- a single clipped-overlap sum divided by a single
    total-count sum, each summed across every order together.

    This is not the same statistic as averaging a separately-computed
    min(precision, recall) per order (what the previous version did):
    pooling weights every matched n-gram equally regardless of its order,
    while per-order averaging weights each *order* equally regardless of how
    many n-grams it contains -- the two diverge whenever match density
    differs across orders, which is the common case.
    """
    if not reference and not candidate:
        return 1.0
    if not reference or not candidate:
        return 0.0
    total_overlap = 0
    total_candidate = 0
    total_reference = 0
    for size in range(1, 5):
        reference_ngrams = _ngrams(reference, size)
        candidate_ngrams = _ngrams(candidate, size)
        total_overlap += sum((reference_ngrams & candidate_ngrams).values())
        total_candidate += sum(candidate_ngrams.values())
        total_reference += sum(reference_ngrams.values())
    if total_candidate == 0 or total_reference == 0:
        return 0.0
    precision = total_overlap / total_candidate
    recall = total_overlap / total_reference
    return min(precision, recall)
