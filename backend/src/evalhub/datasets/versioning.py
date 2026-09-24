"""Dataset versioning and lifecycle state management.

Implements the readiness state lifecycle:
    DRAFT → VALIDATED → APPROVED → PUBLISHED → DEPRECATED → RETIRED
    REJECTED → DRAFT (fix & re-upload)

Rules
-----
- Only DRAFT versions are mutable.
- VALIDATED requires DQS >= 0.85.
- DQS < 0.60 triggers REJECTED (blocker).
- APPROVED requires human sign-off.
- PUBLISHED versions are immutable (frozen).
- Evaluation runs bind to an exact dataset_version_id at execution time.
- New versions maintain parent-child lineage.
"""

import logging

from evalhub.datasets.enums import DatasetStatus
from evalhub.datasets.exceptions import (
    DatasetImmutableError,
    InvalidTransitionError,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lifecycle transition rules
# ---------------------------------------------------------------------------

ALLOWED_TRANSITIONS: dict[DatasetStatus, set[DatasetStatus]] = {
    DatasetStatus.DRAFT: {DatasetStatus.VALIDATED, DatasetStatus.REJECTED},
    DatasetStatus.VALIDATED: {DatasetStatus.APPROVED, DatasetStatus.REJECTED},
    DatasetStatus.APPROVED: {DatasetStatus.PUBLISHED},
    DatasetStatus.PUBLISHED: {DatasetStatus.DEPRECATED},
    DatasetStatus.DEPRECATED: {DatasetStatus.RETIRED},
    DatasetStatus.RETIRED: set(),
    DatasetStatus.REJECTED: {DatasetStatus.DRAFT},
}

# DQS thresholds
DQS_VALIDATED_THRESHOLD = 0.85
DQS_REVIEW_LOWER = 0.60


def validate_transition(current: DatasetStatus, target: DatasetStatus) -> None:
    """Check that a lifecycle transition is allowed.

    Parameters
    ----------
    current : DatasetStatus
        Current status of the dataset version.
    target : DatasetStatus
        Desired target status.

    Raises
    ------
    InvalidTransitionError
        If the transition is not allowed.
    """
    allowed = ALLOWED_TRANSITIONS.get(current, set())
    if target not in allowed:
        msg = f"Transition from '{current}' to '{target}' is not allowed. Allowed: {sorted(allowed)}"
        raise InvalidTransitionError(msg)


def assert_mutable(status: DatasetStatus) -> None:
    """Ensure the dataset version is in a mutable state (DRAFT).

    Parameters
    ----------
    status : DatasetStatus
        Current status of the dataset version.

    Raises
    ------
    DatasetImmutableError
        If the version is not DRAFT.
    """
    if status != DatasetStatus.DRAFT:
        msg = f"Dataset version with status '{status}' is immutable. Only DRAFT versions can be modified."
        raise DatasetImmutableError(msg)



#: Statuses the lifecycle has ruled out. Branching one back into a DRAFT is a
#: lifecycle action (``restore``, RETIRED-only; ``reopen``, REJECTED-only), not
#: something an annotation or a promotion may do by setting a boolean.
NON_BRANCHABLE_STATUSES = frozenset({DatasetStatus.REJECTED, DatasetStatus.RETIRED})


def assert_branchable(status: DatasetStatus, dataset_name: str) -> None:
    """Refuse to copy a ruled-out dataset into a new DRAFT version.

    Deliberately a denylist of the two ruled-out statuses rather than an
    allowlist: a status added later is branchable unless the lifecycle says
    otherwise, and ``assert_mutable`` already governs whether a branch is
    needed at all.
    """
    if status in NON_BRANCHABLE_STATUSES:
        msg = (
            f"Dataset '{dataset_name}' is {status.value}; it cannot be branched "
            "back into a DRAFT. Use restore (RETIRED) or reopen (REJECTED)."
        )
        raise InvalidTransitionError(msg)

def compute_target_status_from_dqs(dqs: float) -> DatasetStatus:
    """Determine the target status based on DQS score.

    Parameters
    ----------
    dqs : float
        Data Quality Score (0.0–1.0).

    Returns
    -------
    DatasetStatus
        VALIDATED if dqs >= 0.85, REJECTED if dqs < 0.60.

    Raises
    ------
    ValueError
        If DQS is in the review band (0.60–0.85) and requires manual decision.
    """
    if dqs >= DQS_VALIDATED_THRESHOLD:
        return DatasetStatus.VALIDATED
    if dqs < DQS_REVIEW_LOWER:
        return DatasetStatus.REJECTED
    msg = f"DQS {dqs:.2f} is in the review band ({DQS_REVIEW_LOWER}–{DQS_VALIDATED_THRESHOLD}). Manual review required."
    raise ValueError(msg)
