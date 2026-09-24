"""What makes a dataset usable: a question AND an expected output on its rows.

A dataset carries a question, an expected output and a metadata blob. A run
sends the question to its target and grades the answer against the expected
output, so both halves are required — a question with nothing to grade against
is as unusable as no question at all. What the metadata declares (expected
tools, context, annotations) decides which metrics can be graded, never which
mode can run, so it is deliberately not consulted here.
"""

from __future__ import annotations

from evalhub.evaluation.dataset_bridge import missing_row_fields


def _record(inputs=None, expectations=None):
    return {"inputs": inputs or {}, "expectations": expectations or {}}


AGENT_ROW = _record(
    {"question": "refund order 42?"},
    {"expected_answer": "yes", "expected_actions": "lookup_order(id=42);refund(id=42)"},
)
PLAIN_ROW = _record({"question": "capital of France?"}, {"expected_answer": "Paris"})


def test_a_question_with_an_expected_output_is_usable():
    assert missing_row_fields([PLAIN_ROW]) == []
    assert missing_row_fields([AGENT_ROW]) == []


def test_every_key_pair_the_bridge_grades_with_counts():
    for question_key in ("question", "query", "prompt", "input"):
        for expected_key in (
            "expected_output",
            "expected_response",
            "expected_sql",
            "expected_answer",
            "answer",
        ):
            record = _record({question_key: "ask me"}, {expected_key: "the answer"})
            assert missing_row_fields([record]) == []


def test_a_question_alone_is_not_usable():
    # Nothing to grade the response against.
    assert missing_row_fields([_record({"question": "capital of France?"})]) == ["expected output"]


def test_an_expected_output_alone_is_not_usable():
    assert missing_row_fields([_record({}, {"expected_output": "Paris"})]) == ["question"]


def test_both_missing_halves_are_named():
    assert missing_row_fields([_record({"note": "nothing"}, {"expected_actions": "search(q=1)"})]) == [
        "question",
        "expected output",
    ]


def test_one_complete_row_speaks_for_the_dataset():
    assert missing_row_fields([_record({"note": "nothing"}), PLAIN_ROW]) == []


def test_halves_from_different_rows_both_count():
    # The verdict is a property of the dataset, and the scan is bounded, so a
    # signal seen on any read row counts.
    rows = [_record({"question": "q"}), _record({}, {"expected_output": "a"})]
    assert missing_row_fields(rows) == []


def test_empty_values_do_not_count():
    assert missing_row_fields([_record({"question": "", "context": []}, {"expected_output": ""})]) == [
        "question",
        "expected output",
    ]


def test_a_dataset_with_no_records_is_missing_both():
    assert missing_row_fields([]) == ["question", "expected output"]


def test_scan_stops_once_both_halves_are_seen():
    def records():
        yield PLAIN_ROW
        raise AssertionError("scan should have stopped once both halves were seen")

    assert missing_row_fields(records()) == []
