"""Score normalisation — deterministic rules from TDD section 11.2."""

from proofgrove.evaluation.enums import GateResult, ScoringType


def normalise_score(
    score: float,
    scoring_type: ScoringType,
    score_range: tuple[float, float] | None = None,
) -> float:
    """Normalise a raw score to [0, 1]."""
    if scoring_type == ScoringType.BINARY:
        return 1.0 if score >= 1.0 else 0.0

    if scoring_type == ScoringType.SCALE:
        lo, hi = score_range or (1, 5)
        if hi == lo:
            return 0.0
        return max(0.0, min(1.0, (score - lo) / (hi - lo)))

    if scoring_type == ScoringType.FLOAT:
        return max(0.0, min(1.0, score))

    if scoring_type == ScoringType.SEVERITY:
        return max(0.0, min(1.0, 1.0 - (score / 7.0)))

    if scoring_type == ScoringType.OPERATIONAL:
        # Callers that need the operational answer use normalise_operational
        # directly; it has no 0-1 form.
        return 0.0

    return max(0.0, min(1.0, score))


def normalise_operational(score: float, metric_id: str = "") -> float | None:
    """Operational metrics are measurements, not judgements — there is no score.

    This used to bucket a latency into 1.0 / 0.7 / 0.3 at five and ten seconds,
    and a token count at four and eight thousand. Nobody declared those numbers:
    they made every token count pass (the first bucket is three orders of
    magnitude above real usage) and, for a slower agent, made every latency
    fail. A verdict nobody set is exactly the fabricated confidence this product
    refuses elsewhere.

    Returning ``None`` keeps the captured measurement on ``score`` and leaves
    ``normalised_score`` and the gate empty. A real latency gate needs a
    declared budget on the Quality Contract first; until then there is nothing
    honest to grade against.
    """
    return None


def threshold_result(
    normalised_score: float,
    threshold_pass: float,
    threshold_warn: float,
) -> GateResult:
    """Map a normalised score to pass/warn/fail."""
    if normalised_score >= threshold_pass:
        return GateResult.PASS
    if normalised_score >= threshold_warn:
        return GateResult.WARN
    return GateResult.FAIL


def worst_gate(results: list[GateResult | None]) -> GateResult:
    """Return the worst gate result (fail > warn > pass).

    Measurements carry no gate, so ``None`` entries are skipped rather than
    ranked — a metric with no verdict cannot be the worst one.
    """
    priority = {GateResult.FAIL: 3, GateResult.WARN: 2, GateResult.PASS: 1}
    graded = [result for result in results if result is not None]
    if not graded:
        return GateResult.PASS
    return max(graded, key=lambda g: priority[g])
