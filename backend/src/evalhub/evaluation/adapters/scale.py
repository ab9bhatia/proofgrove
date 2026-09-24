"""Convert a framework's [0, 1] unit score into a metric's raw scale.

RAGAS and DeepEval both return scores in ``[0, 1]`` where higher is better
(a "goodness unit"). The engine, however, feeds the raw score through
``normalise_score`` using each metric's declared :class:`ScoringType`, so an
adapter must hand back a value in that metric's *raw* scale — otherwise a
RAGAS faithfulness of ``0.8`` would be treated as a BINARY ``0`` (since
``normalise_score`` only maps ``>= 1.0`` to pass).

``unit_to_raw`` inverts each normalisation rule so that, after the engine
normalises the returned raw score, the result matches the framework's unit
score as closely as the scoring type allows.
"""

import math

from evalhub.evaluation.enums import ScoringType

# Fixed denominator used by ``normalise_score`` for SEVERITY metrics.
_SEVERITY_DENOMINATOR = 7.0


def unit_to_raw(
    unit: float,
    scoring_type: ScoringType,
    score_range: tuple[float, float] | None = None,
) -> float:
    """Map a goodness unit in ``[0, 1]`` to the metric's raw score scale."""
    if not math.isfinite(unit):
        raise ValueError("Framework score must be finite")
    unit = max(0.0, min(1.0, unit))

    if scoring_type == ScoringType.BINARY:
        return 1.0 if unit >= 0.5 else 0.0

    if scoring_type == ScoringType.SCALE:
        lo, hi = score_range or (1.0, 5.0)
        return lo + unit * (hi - lo)

    if scoring_type == ScoringType.SEVERITY:
        # normalise_score computes ``1 - severity / 7`` regardless of range.
        return _SEVERITY_DENOMINATOR * (1.0 - unit)

    # FLOAT / OPERATIONAL / fallback: the unit is already the raw score.
    return unit


def binary_label(unit: float) -> str:
    """Return the yes/no label a BINARY metric expects from a unit score."""
    return "yes" if unit >= 0.5 else "no"
