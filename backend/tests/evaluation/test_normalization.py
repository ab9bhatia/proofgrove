"""Tests for score normalisation."""

from evalhub.evaluation.enums import GateResult, ScoringType
from evalhub.evaluation.normalization import normalise_score, threshold_result, worst_gate


def test_binary_normalisation():
    assert normalise_score(1.0, ScoringType.BINARY) == 1.0
    assert normalise_score(0.0, ScoringType.BINARY) == 0.0


def test_scale_normalisation():
    assert normalise_score(5.0, ScoringType.SCALE, (1, 5)) == 1.0
    assert normalise_score(1.0, ScoringType.SCALE, (1, 5)) == 0.0
    assert normalise_score(3.0, ScoringType.SCALE, (1, 5)) == 0.5


def test_severity_normalisation():
    assert normalise_score(0.0, ScoringType.SEVERITY) == 1.0
    assert normalise_score(7.0, ScoringType.SEVERITY) == 0.0


def test_threshold_result():
    assert threshold_result(0.85, 0.80, 0.60) == GateResult.PASS
    assert threshold_result(0.70, 0.80, 0.60) == GateResult.WARN
    assert threshold_result(0.50, 0.80, 0.60) == GateResult.FAIL


def test_worst_gate():
    assert worst_gate([GateResult.PASS, GateResult.WARN]) == GateResult.WARN
    assert worst_gate([GateResult.PASS, GateResult.FAIL]) == GateResult.FAIL
    assert worst_gate([GateResult.PASS]) == GateResult.PASS
