"""Tests for prompt-driven (LLM method) dataset generation."""

import json

import pytest

from evalhub.generation.prompt_generator import (
    PromptGenerationError,
    expand_instruction_to_seeds,
    generate_records_from_prompt,
)
from evalhub.generation.prompts import build_prompt_batch_messages, build_seed_expansion_messages


def test_build_prompt_batch_messages_includes_size_and_instruction():
    messages = build_prompt_batch_messages(
        "Create banking KYC cases",
        num_rows=7,
        domain="finance",
    )
    assert messages[0]["role"] == "system"
    user = messages[1]["content"]
    assert "Create banking KYC cases" in user
    assert "Generate exactly 7 records" in user
    assert "finance" in user


def test_build_seed_expansion_messages_includes_size():
    messages = build_seed_expansion_messages(
        "Create support cases about refunds",
        num_rows=4,
        domain="support",
    )
    user = messages[1]["content"]
    assert "Create support cases about refunds" in user
    assert "Produce exactly 4 seed topics" in user
    assert "support" in user


@pytest.mark.asyncio
async def test_expand_instruction_to_seeds():
    async def complete(_messages):
        return json.dumps({"seeds": ["refund policy", "account lockout", "shipping delay"]})

    seeds = await expand_instruction_to_seeds(
        instruction="Customer support topics",
        num_rows=3,
        complete=complete,
        domain="support",
    )
    assert seeds == ["refund policy", "account lockout", "shipping delay"]


@pytest.mark.asyncio
async def test_expand_instruction_to_seeds_cycles_through_underproduced_seeds():
    """Padding must round-robin the seeds the model DID produce, not repeat
    the first one forever.

    ``len(seeds) % len(seeds)`` is always 0 once the list being indexed is
    the same list being grown — that bug made every pad variant read
    "<seed[0]> (variant N)". The modulo must instead be taken against the
    seed count fixed BEFORE padding starts, so padding cycles seed[0],
    seed[1], seed[0], seed[1], ... .
    """

    async def complete(_messages):
        return json.dumps({"seeds": ["refund policy", "account lockout"]})

    seeds = await expand_instruction_to_seeds(
        instruction="Customer support topics",
        num_rows=5,
        complete=complete,
        domain="support",
    )
    assert seeds == [
        "refund policy",
        "account lockout",
        "refund policy (variant 3)",
        "account lockout (variant 4)",
        "refund policy (variant 5)",
    ]


@pytest.mark.asyncio
async def test_generate_records_from_prompt_builds_canonical_records():
    async def complete(_messages):
        return json.dumps(
            {
                "records": [
                    {
                        "question": "How do I reset my password?",
                        "expected_output": "Use the Forgot Password link on the login page.",
                        "risk": "Low",
                    },
                    {
                        "question": "Can I get a refund after 30 days?",
                        "expected_output": "Refunds are only available within 30 days of purchase.",
                        "risk": "Medium",
                    },
                ]
            }
        )

    records = await generate_records_from_prompt(
        instruction="Customer support Q&A",
        num_rows=2,
        complete=complete,
        domain="support",
    )

    assert len(records) == 2
    assert records[0]["inputs"]["question"] == "How do I reset my password?"
    assert records[0]["expectations"]["expected_output"].startswith("Use the Forgot Password")
    assert records[0]["tags"] == {"serial_no": "1", "risk": "Low", "domain": "support"}
    assert records[1]["tags"]["serial_no"] == "2"
    assert records[1]["tags"]["risk"] == "Medium"


@pytest.mark.asyncio
async def test_generate_records_from_prompt_requires_instruction():
    with pytest.raises(PromptGenerationError, match="instruction"):
        await generate_records_from_prompt(instruction="  ", num_rows=3, complete=lambda m: "{}")


@pytest.mark.asyncio
async def test_generate_records_from_prompt_rejects_empty_records():
    with pytest.raises(PromptGenerationError, match="records"):
        await generate_records_from_prompt(
            instruction="Make cases",
            num_rows=2,
            complete=lambda m: json.dumps({"records": []}),
        )


@pytest.mark.asyncio
async def test_generate_records_from_prompt_accepts_markdown_fenced_json():
    payload = {
        "records": [
            {"question": "Q", "expected_output": "A", "risk": "Low"},
        ]
    }

    records = await generate_records_from_prompt(
        instruction="Make one case",
        num_rows=1,
        complete=lambda m: f"```json\n{json.dumps(payload)}\n```",
    )
    assert len(records) == 1
    assert records[0]["inputs"]["question"] == "Q"
