"""Tests for deterministic trace-based groundedness scoring."""

import pytest

from proofgrove.evaluation.adapters.dispatcher import AdapterDispatchJudge
from proofgrove.evaluation.adapters.trace_adapter import TraceJudge, supported_metrics
from proofgrove.evaluation.dataset_bridge import record_to_row
from proofgrove.evaluation.enums import Adapter, ScoringType
from proofgrove.evaluation.metrics import METRIC_CATALOG
from proofgrove.evaluation.models import EvaluationRow, EvaluatorConfig, ToolCall
from proofgrove.settings import Settings


def _config(metric_id: str) -> EvaluatorConfig:
    metric = METRIC_CATALOG[metric_id]
    return EvaluatorConfig(
        metric_id=metric_id,
        instance_id=f"{metric_id}-1",
        adapter=metric.default_adapter,
        adapter_class=metric.adapter_class,
        scoring_type=metric.scoring_type,
        score_range=metric.score_range,
    )


def _row(**kwargs) -> EvaluationRow:
    base = dict(row_id="r1", query="q", response="a", from_agent=True)
    base.update(kwargs)
    return EvaluationRow(**base)


def test_metric_catalog_binds_tool_metrics_to_trace():
    assert METRIC_CATALOG["agent.tool_call_accuracy"].default_adapter == Adapter.TRACE
    assert METRIC_CATALOG["agent.tool_selection"].default_adapter == Adapter.TRACE
    assert METRIC_CATALOG["agent.tool_input_accuracy"].default_adapter == Adapter.TRACE
    # The deterministic trace judge owns the three tool metrics: they are graded
    # against expected_tools, not judged. The two semantic agent metrics are a
    # different question — whether the agent finished, and whether it understood
    # — and each now goes to the framework that scores that question directly
    # rather than to the unclaimed native default.
    assert METRIC_CATALOG["agent.task_adherence"].default_adapter == Adapter.DEEPEVAL
    assert METRIC_CATALOG["agent.intent_resolution"].default_adapter == Adapter.RAGAS


def test_tool_call_accuracy_pass_when_expected_tool_called():
    judge = TraceJudge()
    row = _row(
        expected_tools=["search"],
        tool_calls=[ToolCall(name="search", args={"q": "AAPL"})],
    )
    result = judge.evaluate(_config("agent.tool_call_accuracy"), row)
    assert result.score == 1.0
    assert result.label == "yes"


def test_tool_call_accuracy_fail_when_expected_tool_missing():
    judge = TraceJudge()
    row = _row(expected_tools=["search"], tool_calls=[ToolCall(name="calculator")])
    result = judge.evaluate(_config("agent.tool_call_accuracy"), row)
    assert result.score == 0.0
    assert "not called" in result.rationale


def test_tool_call_accuracy_is_unscored_when_trace_unavailable():
    judge = TraceJudge()
    row = _row(expected_tools=["search"], tool_calls=[], trace_unavailable=True)
    result = judge.evaluate(_config("agent.tool_call_accuracy"), row)
    assert result.score is None
    assert result.label is None
    assert result.missing_evidence == ["tool_calls"]
    assert "unavailable" in result.rationale.lower()


def test_no_expected_tools_is_unscored_not_a_vacuous_pass():
    # Inverted deliberately. This used to assert score == 1.0: a row that
    # declares no expected tools was passed vacuously, which reported a green
    # tool score the agent never earned. Absence of a declared expectation is
    # missing evidence, not proof of correct tool use.
    judge = TraceJudge()
    row = _row(expected_tools=[], tool_calls=[ToolCall(name="search")])
    for metric_id in ("agent.tool_call_accuracy", "agent.tool_selection"):
        result = judge.evaluate(_config(metric_id), row)
        assert result.score is None, metric_id
        assert result.label is None, metric_id
        assert result.missing_evidence == ["expected_tools"], metric_id
        assert "no expected tools declared" in result.rationale.lower(), metric_id


def test_no_expected_tools_and_no_calls_is_unscored():
    # The literal shape of the old vacuous pass: nothing expected, nothing
    # called. At judge level this is unscored. (The engine resolves the *trusted*
    # zero-capture form of this to NOT_APPLICABLE before the judge is reached —
    # see test_engine_reports_unscored_when_no_expected_tools_declared.)
    judge = TraceJudge()
    row = _row(expected_tools=[], tool_calls=[])
    for metric_id in ("agent.tool_call_accuracy", "agent.tool_selection"):
        result = judge.evaluate(_config(metric_id), row)
        assert result.score is None, metric_id
        assert result.missing_evidence == ["expected_tools"], metric_id


def test_bridge_row_without_declared_actions_is_unscored_on_every_tool_metric():
    # End-to-end through the real bridge rather than a hand-built row.
    # `expected_tools` and the argument expectations are parsed from the *same*
    # keys (dataset_bridge._EXPECTED_ACTION_KEYS), so a record declaring no
    # actions yields neither — and no tool metric may claim a score.
    row = record_to_row(
        {
            "dataset_record_id": "rec-no-tools",
            "inputs": {"question": "latest AAPL price?"},
            "expectations": {"expected_response": "AAPL is up 2%."},
        },
        response_source="agent",
    )
    assert row.expected_tools == []
    judge = TraceJudge()
    for metric_id in supported_metrics():
        result = judge.evaluate(_config(metric_id), row)
        assert result.score is None, metric_id
        assert result.label is None, metric_id


def test_no_expected_tools_does_not_fail_tool_selection():
    # The mirror-image error: with nothing expected, every observed call would
    # look "unexpected". Undeclared expectations must not manufacture a defect.
    judge = TraceJudge()
    row = _row(expected_tools=[], tool_calls=[ToolCall(name="delete_db")])
    result = judge.evaluate(_config("agent.tool_selection"), row)
    assert result.score is None
    assert "unexpected" not in result.rationale.lower()


def test_no_expected_tools_leaves_input_accuracy_on_its_own_evidence_check():
    # tool_input_accuracy grades declared arguments, not expected_tools. The
    # vacuous return used to shadow its score=None branch; it must now reach it.
    # These rows are the persisted shape, not the bridge shape: store._row_from_orm
    # loads expected_tools and expected_data from separate columns, so arguments
    # can be declared against an empty tool list. record_to_row cannot produce
    # this, because it derives both from the same expectation keys.
    judge = TraceJudge()
    unscored = judge.evaluate(
        _config("agent.tool_input_accuracy"),
        _row(expected_tools=[], tool_calls=[ToolCall(name="search", args={"q": "AAPL"})]),
    )
    assert unscored.score is None
    assert unscored.missing_evidence == ["expected_tool_arguments"]

    scored = judge.evaluate(
        _config("agent.tool_input_accuracy"),
        _row(
            expected_tools=[],
            expected_data={"expected_actions": "search(q='AAPL')"},
            tool_calls=[ToolCall(name="search", args={"q": "AAPL"})],
        ),
    )
    assert scored.score == 1.0


def test_a_supported_metric_with_no_branch_raises_instead_of_scoring(monkeypatch):
    # The dispatch used to end in an implicit else: anything not matched by the
    # two explicit branches inherited tool_selection's logic. A tool metric added
    # to supported_metrics but not given a branch would therefore compute
    # `called - expected` against an unrelated expectation and report 0.0 — a
    # defect nobody caused, which is this module's own bug in reverse.
    monkeypatch.setattr(
        "proofgrove.evaluation.adapters.trace_adapter.supported_metrics",
        lambda: {
            "agent.tool_call_accuracy",
            "agent.tool_selection",
            "agent.tool_input_accuracy",
            "agent.tool_future_metric",
        },
    )
    config = EvaluatorConfig(
        metric_id="agent.tool_future_metric",
        instance_id="agent.tool_future_metric-1",
        adapter=Adapter.TRACE,
        adapter_class="trace.future",
        scoring_type=ScoringType.BINARY,
        score_range=(0, 1),
    )
    row = _row(expected_tools=["search"], tool_calls=[ToolCall(name="delete_db")])

    with pytest.raises(ValueError, match="no scoring branch"):
        TraceJudge().evaluate(config, row)


def test_unsupported_metric_still_raises_before_any_scoring():
    judge = TraceJudge()
    with pytest.raises(ValueError, match="cannot score metric"):
        judge.evaluate(
            EvaluatorConfig(
                metric_id="llm.correctness",
                instance_id="llm.correctness-1",
                adapter=Adapter.TRACE,
                adapter_class="trace.nope",
                scoring_type=ScoringType.BINARY,
                score_range=(0, 1),
            ),
            _row(expected_tools=["search"]),
        )


def test_tool_selection_fails_on_unexpected_tool():
    judge = TraceJudge()
    row = _row(
        expected_tools=["search"],
        tool_calls=[ToolCall(name="search"), ToolCall(name="delete_db")],
    )
    result = judge.evaluate(_config("agent.tool_selection"), row)
    assert result.score == 0.0
    assert "unexpected" in result.rationale.lower()


def test_tool_selection_passes_when_only_expected_called():
    judge = TraceJudge()
    row = _row(expected_tools=["search"], tool_calls=[ToolCall(name="search")])
    result = judge.evaluate(_config("agent.tool_selection"), row)
    assert result.score == 1.0


def test_tool_input_accuracy_matches_declared_arguments():
    judge = TraceJudge()
    row = _row(
        expected_tools=["search"],
        expected_data={"expected_actions": "search(q='AAPL')"},
        tool_calls=[ToolCall(name="search", args={"q": "AAPL"})],
    )
    result = judge.evaluate(_config("agent.tool_input_accuracy"), row)
    assert result.score == 1.0


def test_tool_input_accuracy_fails_for_argument_mismatch():
    judge = TraceJudge()
    row = _row(
        expected_tools=["search"],
        expected_data={"expected_tool_calls": [{"name": "search", "args": {"q": "AAPL"}}]},
        tool_calls=[ToolCall(name="search", args={"q": "MSFT"})],
    )
    result = judge.evaluate(_config("agent.tool_input_accuracy"), row)
    assert result.score == 0.0
    assert "mismatch" in result.rationale.lower()


def test_tool_input_accuracy_without_expected_arguments_is_unscored():
    judge = TraceJudge()
    row = _row(
        expected_tools=["search"],
        tool_calls=[ToolCall(name="search", args={"q": "AAPL"})],
    )
    result = judge.evaluate(_config("agent.tool_input_accuracy"), row)
    assert result.score is None
    assert result.missing_evidence == ["expected_tool_arguments"]


def test_dispatcher_routes_trace_metric_for_agent_row_even_in_mock_mode():
    # TraceJudge is deterministic; it must run even when the native judge is mock.
    judge = AdapterDispatchJudge(Settings(judge_mode="mock"))
    row = _row(expected_tools=["search"], tool_calls=[ToolCall(name="search")])
    result = judge.evaluate(_config("agent.tool_call_accuracy"), row)
    assert result.score == 1.0
    assert result.executed_scorer == "trace"
    assert "expected tool" in result.rationale.lower()


def test_dispatcher_uses_native_for_non_agent_row():
    # A judge-only / baseline row (from_agent=False) keeps the native path.
    judge = AdapterDispatchJudge(Settings(judge_mode="mock"))
    row = _row(from_agent=False, expected_tools=["search"], tool_calls=[])
    result = judge.evaluate(_config("agent.tool_call_accuracy"), row)
    # MockJudge rationale is templated ("Tool call accuracy: ..."), not the
    # TraceJudge's "expected tool" wording.
    assert "expected tool(s)" not in result.rationale.lower()
    assert result.executed_scorer == "mock"


def test_scoring_type_is_binary():
    assert METRIC_CATALOG["agent.tool_call_accuracy"].scoring_type == ScoringType.BINARY


def test_bridge_parses_expected_tools_and_agent_source():
    record = {
        "dataset_record_id": "rec-1",
        "inputs": {"query": "latest AAPL price?", "tools": "search;summarize"},
        "expectations": {
            "expected_response": "AAPL is up 2%.",
            "expected_actions": "search(q='AAPL');summarize(text)",
        },
        "tags": {"domain": "finance"},
    }
    row = record_to_row(record, response_source="agent")
    assert row.expected_tools == ["search", "summarize"]
    assert row.from_agent is True
    assert row.response == ""  # filled later by the agent runner
    assert row.expected_response == "AAPL is up 2%."


def test_new_target_execution_does_not_inherit_dataset_trace_identity():
    record = {
        "dataset_record_id": "rec-with-source-trace",
        "inputs": {
            "query": "latest AAPL price?",
            "trace_id": "source-trace",
            "span_id": "source-span",
            "parent_span_id": "source-parent",
            "trace_provider": "otel",
        },
        "expectations": {"expected_response": "AAPL is up 2%."},
    }

    agent_row = record_to_row(record, response_source="agent")
    llm_row = record_to_row(record, response_source="llm")
    baseline_row = record_to_row(record, response_source="baseline")

    for row in (agent_row, llm_row):
        assert row.trace_id is None
        assert row.span_id is None
        assert row.parent_span_id is None
        assert row.trace_provider is None
    assert baseline_row.trace_id == "source-trace"
    assert baseline_row.span_id == "source-span"


def test_bridge_baseline_row_is_not_from_agent():
    record = {"inputs": {"question": "q"}, "expectations": {"expected_response": "a"}}
    row = record_to_row(record, response_source="baseline")
    assert row.from_agent is False
    assert row.response == "a"
    assert row.row_id.startswith("generated-")
    assert record_to_row(record).row_id == row.row_id
    assert record_to_row({"inputs": {"question": "different"}, "expectations": {}}).row_id != row.row_id
