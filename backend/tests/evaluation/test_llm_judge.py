"""Tests for LLM judge JSON parsing and AI Gateway request shaping."""

import json
from unittest.mock import MagicMock, patch

import pytest

from evalhub.evaluation.enums import Adapter, ScoringType
from evalhub.evaluation.llm_judge import (
    LLMJudge,
    _strip_markdown_fence,
    completion_token_params,
    extract_completion_text,
    gateway_model_headers,
    reshape_messages_for_model,
    supports_json_response_format,
    uses_completion_tokens,
)
from evalhub.evaluation.models import EvaluationRow, EvaluatorConfig
from evalhub.settings import Settings


def test_llm_judge_parses_json_response():
    settings = Settings(
        openai_api_key="test-key",
        judge_model="gpt-4o-mini",
        judge_mode="llm",
    )
    judge = LLMJudge(settings)

    mock_completion = MagicMock()
    mock_completion.choices = [MagicMock(message=MagicMock(content=json.dumps({
        "score": 1.0,
        "label": "yes",
        "rationale": "Correct answer.",
    })))]
    mock_completion.usage = MagicMock(prompt_tokens=100, completion_tokens=50)

    config = EvaluatorConfig(
        metric_id="llm.correctness",
        instance_id="llm.correctness::test",
        adapter=Adapter.MOCK,
        adapter_class="LLMJudge",
        scoring_type=ScoringType.BINARY,
    )
    row = EvaluationRow(
        row_id="r1",
        query="What is 2+2?",
        response="4",
        expected_response="4",
    )

    with patch.object(judge.client.chat.completions, "create", return_value=mock_completion) as create:
        result = judge.evaluate(config, row)

    assert result.score == 1.0
    assert result.label == "yes"
    assert result.prompt_tokens == 100
    kwargs = create.call_args.kwargs
    assert kwargs["extra_headers"] == {"x-model-id": "gpt-4o-mini"}
    assert kwargs["max_tokens"] == config.judge_max_tokens
    assert "max_completion_tokens" not in kwargs
    assert kwargs["temperature"] == config.judge_temperature


def test_llm_judge_sends_per_request_model_header_and_gpt5_token_params():
    settings = Settings(
        openai_api_key="test-key",
        judge_model="gpt-4.1-mini",
        judge_mode="llm",
    )
    judge = LLMJudge(settings)

    mock_completion = MagicMock()
    mock_completion.choices = [MagicMock(message=MagicMock(content=json.dumps({
        "score": 0.8,
        "label": None,
        "rationale": "Mostly correct.",
    })))]
    mock_completion.usage = MagicMock(prompt_tokens=10, completion_tokens=5)

    config = EvaluatorConfig(
        metric_id="llm.relevance",
        instance_id="llm.relevance::test",
        adapter=Adapter.MOCK,
        adapter_class="LLMJudge",
        scoring_type=ScoringType.SCALE,
        judge_model="gpt-5.1",
        judge_max_tokens=256,
        judge_temperature=0.2,
    )
    row = EvaluationRow(row_id="r1", query="q", response="r")

    with patch.object(judge.client.chat.completions, "create", return_value=mock_completion) as create:
        result = judge.evaluate(config, row)

    assert result.score == 0.8
    kwargs = create.call_args.kwargs
    assert kwargs["model"] == "gpt-5.1"
    assert kwargs["extra_headers"] == gateway_model_headers("gpt-5.1")
    assert kwargs["max_completion_tokens"] == 256
    assert "max_tokens" not in kwargs
    assert "temperature" not in kwargs


def test_llm_judge_failure_has_no_opinion(caplog):
    """A judge that could not run must not leave a number behind.

    This returned 0.5 — a midpoint on the unit scale, and a raw 3.0 once
    ``unit_to_raw`` mapped it onto a 1-5 metric. Fifteen rows in the local
    database carry exactly that value from connection errors, indistinguishable
    from a considered middling verdict, counted in every mean and histogram.
    """
    settings = Settings(openai_api_key="test-key", judge_mode="llm")
    judge = LLMJudge(settings)
    config = EvaluatorConfig(
        metric_id="llm.relevance",
        instance_id="test",
        adapter=Adapter.MOCK,
        adapter_class="LLMJudge",
        scoring_type=ScoringType.SCALE,
    )
    row = EvaluationRow(row_id="r1", query="q", response="r")

    with patch.object(judge.client.chat.completions, "create", side_effect=Exception("private provider response")):
        result = judge.evaluate(config, row)

    assert result.error_code == "JUDGE_FAILURE"
    assert result.execution_status == "error"
    assert result.score is None
    assert "LLM judge failed" in caplog.text
    assert "private provider response" not in caplog.text


def test_llm_judge_strips_markdown_fence_before_parsing_json():
    settings = Settings(openai_api_key="test-key", judge_model="gpt-4o-mini", judge_mode="llm")
    judge = LLMJudge(settings)

    fenced = "```json\n" + json.dumps({"score": 1.0, "label": "yes", "rationale": "ok"}) + "\n```"
    mock_completion = MagicMock()
    mock_completion.choices = [MagicMock(message=MagicMock(content=fenced))]
    mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1)

    config = EvaluatorConfig(
        metric_id="llm.correctness",
        instance_id="test",
        adapter=Adapter.MOCK,
        adapter_class="LLMJudge",
        scoring_type=ScoringType.BINARY,
    )
    row = EvaluationRow(row_id="r1", query="q", response="r")

    with patch.object(judge.client.chat.completions, "create", return_value=mock_completion):
        result = judge.evaluate(config, row)

    assert result.score == 1.0
    assert result.execution_status == "success"


def test_llm_judge_missing_score_key_is_a_failure_not_zero(caplog):
    """A malformed judge response must not silently become the worst score."""
    settings = Settings(openai_api_key="test-key", judge_model="gpt-4o-mini", judge_mode="llm")
    judge = LLMJudge(settings)

    mock_completion = MagicMock()
    mock_completion.choices = [MagicMock(message=MagicMock(content=json.dumps({"rationale": "no score field"})))]
    mock_completion.usage = MagicMock(prompt_tokens=1, completion_tokens=1)

    config = EvaluatorConfig(
        metric_id="llm.correctness",
        instance_id="test",
        adapter=Adapter.MOCK,
        adapter_class="LLMJudge",
        scoring_type=ScoringType.BINARY,
    )
    row = EvaluationRow(row_id="r1", query="q", response="r")

    with patch.object(judge.client.chat.completions, "create", return_value=mock_completion):
        result = judge.evaluate(config, row)

    assert result.score is None
    assert result.execution_status == "error"
    assert result.error_code == "JUDGE_FAILURE"
    assert "LLM judge failed" in caplog.text
    assert "no score field" not in caplog.text


def test_strip_markdown_fence_variants():
    body = '{"score": 1.0}'
    assert _strip_markdown_fence(f"```json\n{body}\n```") == body
    assert _strip_markdown_fence(f"```\n{body}\n```") == body
    assert _strip_markdown_fence(body) == body


def test_completion_token_params_by_model_family():
    assert uses_completion_tokens("gpt-5.1")
    assert uses_completion_tokens("o4-mini")
    assert not uses_completion_tokens("claude-sonnet-4.6")
    assert completion_token_params("gpt-5.4", 100) == {"max_completion_tokens": 100}
    assert completion_token_params("claude-opus-4.6", 100) == {"max_tokens": 100}


def test_supports_json_response_format_by_model_family():
    assert supports_json_response_format("gpt-4.1-mini")
    assert supports_json_response_format("gpt-5.1")
    assert not supports_json_response_format("claude-sonnet-4.6")
    assert not supports_json_response_format("anthropic.claude-3-5-sonnet")


def test_reshape_messages_for_claude_moves_system_to_extra_body():
    messages = [
        {"role": "system", "content": "You are a dataset author."},
        {"role": "user", "content": "Generate 2 rows."},
    ]
    adapted, extra = reshape_messages_for_model("claude-sonnet-4.6", messages)
    assert adapted == [{"role": "user", "content": "Generate 2 rows."}]
    assert extra == {"system": "You are a dataset author."}

    untouched, empty = reshape_messages_for_model("gpt-4.1-mini", messages)
    assert untouched == messages
    assert empty == {}


def test_extract_completion_text_openai_and_anthropic_shapes():
    openai_shaped = MagicMock()
    openai_shaped.choices = [
        MagicMock(message=MagicMock(content='{"records":[]}'))
    ]
    assert extract_completion_text(openai_shaped) == '{"records":[]}'

    anthropic_shaped = MagicMock(spec=["content", "choices"])
    anthropic_shaped.choices = None
    anthropic_shaped.content = [MagicMock(text='{"records":[{"question":"Q"}]}')]
    assert '"question":"Q"' in extract_completion_text(anthropic_shaped)

    dumped = MagicMock(spec=["choices", "model_dump"])
    dumped.choices = None
    dumped.model_dump.return_value = {
        "content": [{"type": "text", "text": '{"ok": true}'}],
    }
    assert extract_completion_text(dumped) == '{"ok": true}'


def test_llm_judge_omits_response_format_for_claude():
    settings = Settings(
        openai_api_key="test-key",
        judge_model="claude-sonnet-4.6",
        judge_mode="llm",
    )
    judge = LLMJudge(settings)

    mock_completion = MagicMock()
    mock_completion.choices = [MagicMock(message=MagicMock(content=json.dumps({
        "score": 1.0,
        "label": "yes",
        "rationale": "Correct.",
    })))]
    mock_completion.usage = MagicMock(prompt_tokens=10, completion_tokens=5)

    config = EvaluatorConfig(
        metric_id="llm.correctness",
        instance_id="llm.correctness::test",
        adapter=Adapter.MOCK,
        adapter_class="LLMJudge",
        scoring_type=ScoringType.BINARY,
        judge_model="claude-sonnet-4.6",
    )
    row = EvaluationRow(row_id="r1", query="q", response="r", expected_response="r")

    with patch.object(judge.client.chat.completions, "create", return_value=mock_completion) as create:
        judge.evaluate(config, row)

    kwargs = create.call_args.kwargs
    assert "response_format" not in kwargs
    assert kwargs["extra_headers"] == {"x-model-id": "claude-sonnet-4.6"}
    assert kwargs["max_tokens"] == config.judge_max_tokens
    assert all(message.get("role") != "system" for message in kwargs["messages"])
    assert "system" in kwargs.get("extra_body", {})


@pytest.mark.parametrize("score", [float("nan"), float("inf"), float("-inf")])
def test_nonfinite_judge_scores_are_errors(score):
    from evalhub.evaluation.adapters.scale import unit_to_raw
    from evalhub.evaluation.llm_judge import JudgeResult

    with pytest.raises(ValueError, match="finite"):
        JudgeResult(score, None, "", 0, 0)
    for scoring_type in ScoringType:
        with pytest.raises(ValueError, match="finite"):
            unit_to_raw(score, scoring_type)

    judge = LLMJudge(Settings(openai_api_key="test-key", judge_mode="llm"))
    completion = MagicMock()
    completion.choices = [MagicMock(message=MagicMock(content=json.dumps({"score": score})))]
    completion.usage = None
    with patch.object(judge.client.chat.completions, "create", return_value=completion):
        result = judge.evaluate(
            EvaluatorConfig(metric_id="llm.correctness", instance_id="finite", adapter=Adapter.NATIVE, adapter_class="LLMJudge", scoring_type=ScoringType.BINARY),
            EvaluationRow(row_id="r", query="q", response="r"),
        )
    assert result.execution_status == "error"
    assert result.score is None
