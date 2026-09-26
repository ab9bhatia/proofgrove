import json

import pytest

from proofgrove.api.v1.datasets import _job_response
from proofgrove.generation.prompt_generator import PromptGenerationError, generate_records_from_prompt


def row(q):
    return {"question": q, "expected_output": "Review the evidence first.", "risk": "High"}


@pytest.mark.asyncio
async def test_invalid_json_retried_once_without_echoing_output():
    calls = []
    replies = iter(['private-model-output', json.dumps({"records": [row("First?"), row("Second?")]})])
    async def complete(messages):
        calls.append(messages)
        return next(replies)
    records = await generate_records_from_prompt(instruction="Two refund cases", num_rows=2, complete=complete)
    assert len(records) == 2 and len(calls) == 2
    assert "private-model-output" not in json.dumps(calls)
    assert "exactly 2 distinct records" in calls[1][-1]["content"]


@pytest.mark.asyncio
@pytest.mark.parametrize('records', [[row("First?")], [row("One?"), row("Two?"), row("Three?")], [row("Same?"), row("Same?")], [row("First?"), {"question": ["bad type"], "expected_output": "A"}]])
async def test_incomplete_or_duplicate_batch_is_never_reported_as_success(records):
    calls = []
    async def complete(messages):
        calls.append(messages)
        return json.dumps({"records": records})
    with pytest.raises(PromptGenerationError, match="distinct complete records"):
        await generate_records_from_prompt(instruction="Two cases", num_rows=2, complete=complete)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_provider_failure_is_not_retried_as_a_format_error():
    calls = []
    async def complete(messages):
        calls.append(messages)
        raise TimeoutError('upstream')
    with pytest.raises(TimeoutError):
        await generate_records_from_prompt(instruction="A case", num_rows=1, complete=complete)
    assert len(calls) == 1


def test_historical_known_format_failure_gets_actionable_copy():
    result = _job_response({"error": "LLM returned non-JSON", "params": {"private": "input"}})
    assert "did not return valid dataset JSON" in result['error']
    assert 'params' not in result


def test_unrecognized_historical_errors_remain_private():
    secret = "LLM returned non-JSON and private prompt content with api_key=test"
    result = _job_response({"error": secret})
    assert result['error'] == 'Dataset generation failed. Check the generation inputs and try again.'
    assert secret not in str(result)


def test_trusted_interruption_keeps_recoverable_ui_state():
    assert _job_response({"error": "interrupted"})["error"] == "interrupted"
