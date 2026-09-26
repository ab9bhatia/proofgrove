"""Trace adapter — deterministic groundedness scoring from a captured tool-call trace.

Unlike the RAGAS/DeepEval adapters (which call an LLM), this scorer is pure: it
compares the tools an agent *actually* called (``EvaluationRow.tool_calls``,
hydrated from archived OTEL spans when the trace archive is enabled, otherwise
captured from the kagent session) against the tools the golden row *expects*
(``EvaluationRow.expected_tools``, parsed from the dataset). This is the
"proven tool use" groundedness signal.

Scored metrics:
- ``agent.tool_call_accuracy`` — every expected tool was actually called.
- ``agent.tool_selection`` — the agent called only expected tools (no wrong-tool
  calls / wandering).

If the trace is unavailable (a live-agent run that produced no session/trace,
e.g. a BYO agent that does not emit ADK events), the metric reports missing
evidence rather than fabricating a failure score. A row that declares no
expected tools is reported the same way: the golden case states nothing about
which tools belong, so neither a pass nor a failure can be justified.
"""

from __future__ import annotations

import ast
from typing import Any

from proofgrove.evaluation.llm_judge import JudgeResult
from proofgrove.evaluation.models import EvaluationRow, EvaluatorConfig

#: Metrics graded against ``expected_tools``, a subset of ``supported_metrics``.
#:
#: ``agent.tool_input_accuracy`` is excluded because it grades declared arguments
#: (``expected_data``) and carries its own evidence check, which must not be
#: short-circuited: a persisted row loads the two from separate columns
#: (``store._row_from_orm``) and can declare arguments with an empty tool list.
#:
#: Drift from ``supported_metrics`` is caught by the terminal raise in
#: ``evaluate`` rather than left to score against whatever happens to be in
#: scope.
_EXPECTED_TOOL_METRICS = {"agent.tool_call_accuracy", "agent.tool_selection"}


def supported_metrics() -> set[str]:
    """Return the metric ids this adapter scores."""
    return {
        "agent.tool_call_accuracy",
        "agent.tool_selection",
        "agent.tool_input_accuracy",
    }


class TraceJudge:
    """Deterministic judge that scores agent tool metrics from the captured trace."""

    def evaluate(self, config: EvaluatorConfig, row: EvaluationRow) -> JudgeResult:
        if config.metric_id not in supported_metrics():
            raise ValueError(f"TraceJudge cannot score metric {config.metric_id}")

        # A live-agent row with no obtainable trace: do not claim groundedness.
        if row.trace_unavailable:
            return JudgeResult(
                score=None,
                label=None,
                rationale="Agent trace unavailable — cannot verify tool use.",
                prompt_tokens=0,
                completion_tokens=0,
                missing_evidence=["tool_calls"],
            )

        expected = _normalise(row.expected_tools)
        called = _normalise([tc.name for tc in row.tool_calls])

        if not expected and config.metric_id in _EXPECTED_TOOL_METRICS:
            # The golden row names no tools, so there is no claim to check the
            # trace against. Scoring either way would be an invention: 1.0 is a
            # pass nobody earned, 0.0 a failure nobody caused.
            return JudgeResult(
                score=None,
                label=None,
                rationale="No expected tools declared for this row — tool use cannot be verified.",
                prompt_tokens=0,
                completion_tokens=0,
                missing_evidence=["expected_tools"],
            )

        if config.metric_id == "agent.tool_call_accuracy":
            missing = expected - called
            if missing:
                return _result(
                    0.0,
                    "no",
                    f"Expected tool(s) not called: {sorted(missing)}. Called: {sorted(called)}.",
                )
            return _result(1.0, "yes", f"All expected tool(s) called: {sorted(expected)}.")

        if config.metric_id == "agent.tool_input_accuracy":
            expected_calls = _expected_calls(row.expected_data or {})
            if not expected_calls:
                return JudgeResult(
                    score=None,
                    label=None,
                    rationale="Expected tool arguments are not declared for this row.",
                    prompt_tokens=0,
                    completion_tokens=0,
                    missing_evidence=["expected_tool_arguments"],
                )
            unmatched = list(row.tool_calls)
            mismatches: list[str] = []
            for name, expected_args in expected_calls:
                match_index = next(
                    (index for index, call in enumerate(unmatched) if call.name.strip().casefold() == name.casefold()),
                    None,
                )
                if match_index is None:
                    mismatches.append(f"{name}: tool was not called")
                    continue
                actual = unmatched.pop(match_index)
                if _canonical(actual.args) != _canonical(expected_args):
                    mismatches.append(f"{name}: expected {expected_args!r}, observed {actual.args!r}")
            if mismatches:
                return _result(0.0, "no", "Tool argument mismatch: " + "; ".join(mismatches) + ".")
            return _result(1.0, "yes", "All declared tool arguments matched the captured calls.")

        if config.metric_id == "agent.tool_selection":
            # No tools outside the expected set.
            unexpected = called - expected
            if unexpected:
                return _result(
                    0.0,
                    "no",
                    f"Agent called unexpected tool(s): {sorted(unexpected)}. Expected: {sorted(expected)}.",
                )
            return _result(1.0, "yes", f"Agent called only expected tool(s): {sorted(called) or 'none'}.")

        # Every supported metric is dispatched explicitly above. A metric added
        # to ``supported_metrics`` but not given a branch must fail loudly here
        # rather than inherit the last one: when it used to fall through to
        # tool_selection it scored 0.0 against whatever `expected` happened to
        # hold, which is this module's own bug in reverse — a defect nobody
        # caused, reported as fact.
        raise ValueError(f"TraceJudge has no scoring branch for metric {config.metric_id}")


def _normalise(names: list[str]) -> set[str]:
    """Lower-case, strip, and drop blanks from a list of tool names."""
    return {n.strip().lower() for n in names if isinstance(n, str) and n.strip()}


def _expected_calls(expectations: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """Read structured calls or conservatively parse ``tool(key=value)`` actions."""

    raw = next(
        (
            expectations.get(key)
            for key in ("expected_tool_calls", "expected_actions", "actions")
            if expectations.get(key)
        ),
        None,
    )
    if isinstance(raw, list):
        parsed: list[tuple[str, dict[str, Any]]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or item.get("tool") or "").strip()
            args = item.get("args") or item.get("arguments") or item.get("input")
            if name and isinstance(args, dict):
                parsed.append((name, args))
        return parsed
    if not isinstance(raw, str):
        return []

    parsed = []
    for action in raw.split(";"):
        try:
            expression = ast.parse(action.strip(), mode="eval").body
        except (SyntaxError, ValueError):
            continue
        if not isinstance(expression, ast.Call) or not isinstance(expression.func, ast.Name):
            continue
        args: dict[str, Any] = {}
        valid = not expression.args
        if valid:
            try:
                args = {keyword.arg: ast.literal_eval(keyword.value) for keyword in expression.keywords if keyword.arg}
            except (ValueError, TypeError):
                valid = False
        if valid and args:
            parsed.append((expression.func.id, args))
    return parsed


def _canonical(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _canonical(item) for key, item in sorted(value.items(), key=lambda entry: str(entry[0]))}
    if isinstance(value, list):
        return [_canonical(item) for item in value]
    return value


def _result(score: float, label: str, rationale: str) -> JudgeResult:
    return JudgeResult(
        score=score,
        label=label,
        rationale=rationale,
        prompt_tokens=0,
        completion_tokens=0,
    )
