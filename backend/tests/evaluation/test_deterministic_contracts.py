"""Standalone deterministic scorer contracts, available before engine integration."""

import pytest

from proofgrove.evaluation.adapters.deterministic_adapter import _gleu, _meteor


@pytest.mark.parametrize("reference,candidate,expected", [
    (["a"], ["a", "b", "c", "d"], 0.1),
    (["a", "b", "c", "d"], ["a"], 0.1),
    (["a", "b"], ["a", "b", "c", "d"], 0.3),
])
def test_gleu_counts_orders_present_only_on_the_longer_side(reference, candidate, expected):
    # The four-token side contributes 4+3+2+1 n-grams even when the
    # shorter side has no matching higher-order n-grams.
    assert _gleu(reference, candidate) == pytest.approx(expected)


@pytest.mark.parametrize("reference,candidate,expected", [
    (["a", "b"], ["a", "x", "b"], 10 / 21),
    (["a", "x", "b"], ["a", "b"], 10 / 29),
    (["a", "b"], ["x", "a", "b"], 25 / 28),
    (["a", "b", "a"], ["b", "a", "a"], 0.8518518518518519),
])
def test_meteor_chunks_require_adjacency_in_both_sequences(reference, candidate, expected):
    # An internal gap splits the matched tokens into two chunks; an
    # unmatched prefix leaves the adjacent matched tokens in one chunk.
    assert _meteor(reference, candidate) == pytest.approx(expected)
