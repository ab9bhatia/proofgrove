"""Tests for dataset versioning and lifecycle state machine."""

import pytest

from proofgrove.datasets.enums import DatasetStatus
from proofgrove.datasets.exceptions import DatasetImmutableError, InvalidTransitionError
from proofgrove.datasets.versioning import (
    assert_mutable,
    compute_target_status_from_dqs,
    validate_transition,
)


class TestValidateTransition:
    """Tests for lifecycle transition validation."""

    @pytest.mark.parametrize(
        "current,target",
        [
            (DatasetStatus.DRAFT, DatasetStatus.VALIDATED),
            (DatasetStatus.DRAFT, DatasetStatus.REJECTED),
            (DatasetStatus.VALIDATED, DatasetStatus.APPROVED),
            (DatasetStatus.VALIDATED, DatasetStatus.REJECTED),
            (DatasetStatus.APPROVED, DatasetStatus.PUBLISHED),
            (DatasetStatus.PUBLISHED, DatasetStatus.DEPRECATED),
            (DatasetStatus.DEPRECATED, DatasetStatus.RETIRED),
            (DatasetStatus.REJECTED, DatasetStatus.DRAFT),
        ],
    )
    def test_allowed_transitions(self, current: DatasetStatus, target: DatasetStatus) -> None:
        validate_transition(current, target)  # should not raise

    @pytest.mark.parametrize(
        "current,target",
        [
            (DatasetStatus.DRAFT, DatasetStatus.PUBLISHED),
            (DatasetStatus.DRAFT, DatasetStatus.APPROVED),
            (DatasetStatus.VALIDATED, DatasetStatus.PUBLISHED),
            (DatasetStatus.PUBLISHED, DatasetStatus.DRAFT),
            (DatasetStatus.RETIRED, DatasetStatus.DRAFT),
            (DatasetStatus.PUBLISHED, DatasetStatus.VALIDATED),
        ],
    )
    def test_disallowed_transitions(self, current: DatasetStatus, target: DatasetStatus) -> None:
        with pytest.raises(InvalidTransitionError):
            validate_transition(current, target)


class TestAssertMutable:
    """Tests for mutability assertions."""

    def test_draft_is_mutable(self) -> None:
        assert_mutable(DatasetStatus.DRAFT)  # should not raise

    @pytest.mark.parametrize(
        "status",
        [
            DatasetStatus.VALIDATED,
            DatasetStatus.APPROVED,
            DatasetStatus.PUBLISHED,
            DatasetStatus.DEPRECATED,
            DatasetStatus.RETIRED,
        ],
    )
    def test_non_draft_is_immutable(self, status: DatasetStatus) -> None:
        with pytest.raises(DatasetImmutableError):
            assert_mutable(status)


class TestComputeTargetStatusFromDqs:
    """Tests for DQS-based status determination."""

    def test_high_dqs_validates(self) -> None:
        assert compute_target_status_from_dqs(0.90) == DatasetStatus.VALIDATED

    def test_threshold_dqs_validates(self) -> None:
        assert compute_target_status_from_dqs(0.85) == DatasetStatus.VALIDATED

    def test_low_dqs_rejects(self) -> None:
        assert compute_target_status_from_dqs(0.50) == DatasetStatus.REJECTED

    def test_review_band_raises(self) -> None:
        with pytest.raises(ValueError, match="review band"):
            compute_target_status_from_dqs(0.75)
