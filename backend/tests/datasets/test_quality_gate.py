"""Tests for the quality gate / DQS validation framework."""

from evalhub.datasets.enums import DatasetStatus
from evalhub.datasets.quality_gate import (
    DQS_REJECTED_THRESHOLD,
    DQS_VALIDATED_THRESHOLD,
    run_quality_gate,
)


def _make_record(
    question: str = "What is X?",
    answer: str = "Y",
    has_expectations: bool = True,
    null_value: bool = False,
) -> dict:
    """Helper to build a test record dict."""
    inputs = {"question": question}
    if null_value:
        inputs["question"] = None
    expectations = {"answer": answer} if has_expectations else {}
    return {"inputs": inputs, "expectations": expectations, "tags": {}}


class TestQualityGate:
    """Tests for run_quality_gate."""

    def test_passing_dataset(self) -> None:
        """Good dataset should pass with DQS >= threshold."""
        records = [_make_record(f"q{i}", f"a{i}") for i in range(5)]
        result = run_quality_gate(DatasetStatus.DRAFT, records)

        assert result.passed is True
        assert result.dqs >= DQS_VALIDATED_THRESHOLD
        assert result.target_status == DatasetStatus.VALIDATED
        assert len(result.checks) == 5
        assert result.blocker_failures == []

    def test_empty_dataset_rejected_by_blocker(self) -> None:
        """Empty dataset triggers record_count blocker → REJECTED."""
        result = run_quality_gate(DatasetStatus.DRAFT, [])

        assert result.passed is False
        assert result.target_status == DatasetStatus.REJECTED
        assert "record_count" in result.blocker_failures

    def test_null_values_reduce_score(self) -> None:
        """Records with null inputs should reduce the DQS."""
        records = [
            _make_record("q1", "a1"),
            _make_record(null_value=True),
        ]
        result = run_quality_gate(DatasetStatus.DRAFT, records)

        null_check = next(c for c in result.checks if c.name == "null_values")
        assert null_check.score < 1.0

    def test_duplicates_reduce_score(self) -> None:
        """Duplicate inputs should reduce the DQS."""
        records = [
            _make_record("same_q", "a1"),
            _make_record("same_q", "a2"),
        ]
        result = run_quality_gate(DatasetStatus.DRAFT, records)

        dup_check = next(c for c in result.checks if c.name == "duplicates")
        assert dup_check.score < 1.0

    def test_missing_expectations_reduce_score(self) -> None:
        """Records without expectations reduce coverage score."""
        records = [
            _make_record("q1", has_expectations=False),
            _make_record("q2", has_expectations=False),
        ]
        result = run_quality_gate(DatasetStatus.DRAFT, records)

        exp_check = next(c for c in result.checks if c.name == "expectation_coverage")
        assert exp_check.score == 0.0

    def test_all_checks_present(self) -> None:
        """Verify all 5 checks run."""
        records = [_make_record()]
        result = run_quality_gate(DatasetStatus.DRAFT, records)

        check_names = {c.name for c in result.checks}
        expected = {"record_count", "schema_compliance", "null_values", "duplicates", "expectation_coverage"}
        assert check_names == expected

    def test_dqs_is_average_of_scored_checks_only(self) -> None:
        """DQS averages only the non-blocker checks (null_values, duplicates,
        expectation_coverage) -- blockers gate the target status instead of
        being folded into the average, per the module docstring."""
        records = [_make_record("q1", "a1")]
        result = run_quality_gate(DatasetStatus.DRAFT, records)

        scored = [c.score for c in result.checks if not c.is_blocker]
        expected_dqs = sum(scored) / len(scored)
        assert abs(result.dqs - round(expected_dqs, 4)) < 0.001

    def test_blocker_score_does_not_dilute_dqs(self) -> None:
        """A failing blocker gates target_status to REJECTED directly -- its
        own (low) score must not also feed the averaged DQS, per the module
        docstring's "blockers short-circuit, DQS checks are averaged" model.
        """
        records = [_make_record(f"q{i}", f"a{i}") for i in range(4)] + [
            {"inputs": {}, "expectations": {}, "tags": {}}
        ]
        result = run_quality_gate(DatasetStatus.DRAFT, records)

        assert result.target_status == DatasetStatus.REJECTED
        assert "schema_compliance" in result.blocker_failures

        scored_only = [c.score for c in result.checks if not c.is_blocker]
        all_five = [c.score for c in result.checks]
        correct_dqs = round(sum(scored_only) / len(scored_only), 4)
        buggy_dqs = round(sum(all_five) / len(all_five), 4)

        assert result.dqs == correct_dqs
        assert result.dqs != buggy_dqs

    def test_perfect_dataset_gets_dqs_1(self) -> None:
        """A perfect dataset with no issues should get DQS = 1.0."""
        records = [_make_record(f"q{i}", f"a{i}") for i in range(10)]
        result = run_quality_gate(DatasetStatus.DRAFT, records)

        assert result.dqs == 1.0
        assert result.passed is True
        assert all(c.passed for c in result.checks)
        assert result.blocker_failures == []

    def test_blocker_checks_are_tagged(self) -> None:
        """record_count and schema_compliance should be marked as blockers."""
        records = [_make_record()]
        result = run_quality_gate(DatasetStatus.DRAFT, records)

        blocker_names = {c.name for c in result.checks if c.is_blocker}
        assert blocker_names == {"record_count", "schema_compliance"}

    def test_three_band_rejected(self) -> None:
        """DQS < 0.60 should result in REJECTED."""
        # 1 record with empty inputs → schema_compliance blocker fails
        records = [{"inputs": {}, "expectations": {}, "tags": {}}]
        result = run_quality_gate(DatasetStatus.DRAFT, records)

        assert result.target_status == DatasetStatus.REJECTED
        assert result.passed is False
        assert "schema_compliance" in result.blocker_failures

    def test_three_band_review(self) -> None:
        """DQS in [0.60, 0.85) should stay DRAFT (review band)."""
        # 3 good records + 1 without expectations → coverage = 0.75
        # All other checks pass → DQS = (1+1+1+1+0.75)/5 = 0.95
        # Need a mix that lands in review band.
        # 4 records: 2 have nulls, 1 duplicate, 0 expectations.
        records = [
            _make_record("q1", "a1", has_expectations=True),
            _make_record("q2", "a2", has_expectations=False),
            _make_record("q3", "a3", has_expectations=False),
            _make_record("q4", "a4", has_expectations=False),
            _make_record("q5", "a5", has_expectations=False),
        ]
        result = run_quality_gate(DatasetStatus.DRAFT, records)

        # record_count=1.0, schema=1.0 (blockers, not averaged in).
        # null=1.0, dup=1.0, exp=0.2 -> DQS = 2.2/3 = 0.7333 -> DRAFT (review band)
        assert DQS_REJECTED_THRESHOLD <= result.dqs < DQS_VALIDATED_THRESHOLD
        assert result.target_status == DatasetStatus.DRAFT
        assert result.passed is False
        assert result.blocker_failures == []
