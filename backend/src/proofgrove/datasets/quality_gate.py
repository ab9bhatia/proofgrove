"""Dataset Quality Score (DQS) — validation gate before publishing.

Three-band scoring model (per diagram):
    ≥ 0.85         → VALIDATED
    0.60 – 0.84    → DRAFT (needs review / improvement)
    < 0.60         → REJECTED (must fix and re-upload)

BLOCKER checks short-circuit to REJECTED regardless of DQS:
    - record_count: must have ≥ 1 record
    - schema_compliance: every record must have non-empty inputs

DQS checks (scored 0–1, averaged):
    - null_values: no nulls in input fields
    - duplicates: no duplicate inputs
    - expectation_coverage: ≥ 80% records have expectations

Returns a DQS score in [0, 1] and the target lifecycle status.
"""

import logging
from dataclasses import dataclass, field
from typing import Any

from proofgrove.datasets.enums import DatasetStatus

logger = logging.getLogger(__name__)

# Three-band thresholds (from diagram)
DQS_VALIDATED_THRESHOLD = 0.85
DQS_REJECTED_THRESHOLD = 0.60
MIN_RECORD_COUNT = 1


@dataclass
class QualityCheck:
    """Result of a single quality check.

    Attributes
    ----------
    name : str
        Check identifier.
    passed : bool
        Whether this check passed.
    score : float
        Score in [0, 1].
    message : str
        Human-readable result description.
    is_blocker : bool
        If True, failure short-circuits to REJECTED.
    """

    name: str
    passed: bool
    score: float
    message: str
    is_blocker: bool = False


@dataclass
class QualityGateResult:
    """Aggregate quality gate result.

    Attributes
    ----------
    dqs : float
        Dataset Quality Score in [0, 1].
    passed : bool
        Whether the dataset meets VALIDATED threshold.
    target_status : DatasetStatus
        VALIDATED (≥0.85), DRAFT (0.60–0.84), or REJECTED (<0.60 / blocker).
    checks : list[QualityCheck]
        Individual check results.
    blocker_failures : list[str]
        Names of blocker checks that failed (empty if none).
    """

    dqs: float
    passed: bool
    target_status: DatasetStatus
    checks: list[QualityCheck] = field(default_factory=list)
    blocker_failures: list[str] = field(default_factory=list)


def _check_record_count(records: list[dict[str, Any]]) -> QualityCheck:
    """BLOCKER: dataset must have at least one record."""
    count = len(records)
    passed = count >= MIN_RECORD_COUNT
    return QualityCheck(
        name="record_count",
        passed=passed,
        score=1.0 if passed else 0.0,
        message=f"{count} records (min={MIN_RECORD_COUNT})",
        is_blocker=True,
    )


def _check_schema_compliance(records: list[dict[str, Any]]) -> QualityCheck:
    """BLOCKER: every record must have non-empty inputs."""
    if not records:
        return QualityCheck(
            name="schema_compliance",
            passed=False,
            score=0.0,
            message="No records to validate",
            is_blocker=True,
        )
    valid = sum(1 for r in records if r.get("inputs") and len(r["inputs"]) > 0)
    score = valid / len(records)
    return QualityCheck(
        name="schema_compliance",
        passed=score == 1.0,
        score=score,
        message=f"{valid}/{len(records)} records have non-empty inputs",
        is_blocker=True,
    )


def _check_null_values(records: list[dict[str, Any]]) -> QualityCheck:
    """Check for null values in inputs."""
    if not records:
        return QualityCheck(
            name="null_values",
            passed=False,
            score=0.0,
            message="No records to validate",
        )
    clean = 0
    for r in records:
        inputs = r.get("inputs", {})
        if inputs and all(v is not None for v in inputs.values()):
            clean += 1
    score = clean / len(records)
    return QualityCheck(
        name="null_values",
        passed=score == 1.0,
        score=score,
        message=f"{clean}/{len(records)} records have no null input values",
    )


def _check_duplicates(records: list[dict[str, Any]]) -> QualityCheck:
    """Check for duplicate inputs."""
    if not records:
        return QualityCheck(
            name="duplicates",
            passed=False,
            score=0.0,
            message="No records to validate",
        )
    seen: set[str] = set()
    unique = 0
    for r in records:
        key = str(sorted(r.get("inputs", {}).items()))
        if key not in seen:
            seen.add(key)
            unique += 1
    score = unique / len(records)
    duplicates = len(records) - unique
    return QualityCheck(
        name="duplicates",
        passed=duplicates == 0,
        score=score,
        message=f"{duplicates} duplicate(s) found in {len(records)} records",
    )


def _check_expectation_coverage(records: list[dict[str, Any]]) -> QualityCheck:
    """Check that records have expectations defined."""
    if not records:
        return QualityCheck(
            name="expectation_coverage",
            passed=False,
            score=0.0,
            message="No records to validate",
        )
    with_expectations = sum(
        1 for r in records if r.get("expectations") and len(r["expectations"]) > 0
    )
    score = with_expectations / len(records)
    return QualityCheck(
        name="expectation_coverage",
        passed=score >= 0.8,
        score=score,
        message=f"{with_expectations}/{len(records)} records have expectations",
    )


def _classify_status(dqs: float, blocker_failures: list[str]) -> DatasetStatus:
    """Map DQS + blockers to a target lifecycle status.

    Three-band model (per diagram)
    ------------------------------
    - Any blocker failure → REJECTED
    - DQS < 0.60         → REJECTED
    - 0.60 ≤ DQS < 0.85  → DRAFT (needs review / improvement)
    - DQS ≥ 0.85         → VALIDATED

    Parameters
    ----------
    dqs : float
        Dataset Quality Score in [0, 1].
    blocker_failures : list[str]
        Names of failed blocker checks.

    Returns
    -------
    DatasetStatus
        Target status.
    """
    if blocker_failures:
        return DatasetStatus.REJECTED
    if dqs < DQS_REJECTED_THRESHOLD:
        return DatasetStatus.REJECTED
    if dqs >= DQS_VALIDATED_THRESHOLD:
        return DatasetStatus.VALIDATED
    return DatasetStatus.DRAFT


def run_quality_gate(
    current_status: DatasetStatus,
    records: list[dict[str, Any]],
) -> QualityGateResult:
    """Run all quality checks and compute the DQS.

    Blocker checks (record_count, schema_compliance) short-circuit
    to REJECTED regardless of DQS. Remaining checks contribute
    equally to the DQS score.

    Parameters
    ----------
    current_status : DatasetStatus
        Current dataset status (must be DRAFT).
    records : list[dict]
        Dataset records to validate.

    Returns
    -------
    QualityGateResult
        Aggregate result with DQS score and target status.
    """
    checks = [
        _check_record_count(records),
        _check_schema_compliance(records),
        _check_null_values(records),
        _check_duplicates(records),
        _check_expectation_coverage(records),
    ]

    # DQS is the average of the *scored* checks only (per the module docstring:
    # null_values, duplicates, expectation_coverage). Blocker checks gate the
    # target status in `_classify_status` below -- they must not also dilute
    # or inflate the averaged score by being folded into it.
    scoring_checks = [c for c in checks if not c.is_blocker]
    dqs = sum(c.score for c in scoring_checks) / len(scoring_checks) if scoring_checks else 0.0
    dqs = round(dqs, 4)

    blocker_failures = [c.name for c in checks if c.is_blocker and not c.passed]
    target_status = _classify_status(dqs, blocker_failures)
    passed = target_status == DatasetStatus.VALIDATED

    logger.info(
        "Quality gate: DQS=%.3f, target=%s, blockers=%s, checks=%d",
        dqs,
        target_status.value,
        blocker_failures or "none",
        len(checks),
    )
    return QualityGateResult(
        dqs=dqs,
        passed=passed,
        target_status=target_status,
        checks=checks,
        blocker_failures=blocker_failures,
    )
