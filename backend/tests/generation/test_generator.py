"""Tests for synthetic golden-dataset generation (offline; mock source + LLM)."""

import json

import pytest

from evalhub.datasets.csv_parser import parse_csv
from evalhub.evaluation.dataset_bridge import records_to_rows
from evalhub.generation.generator import DatasetGenerator, rows_to_csv


class _FakeSource:
    """A grounding source that returns canned material for a fixed tool."""

    def __init__(self, tool: str = "search", material: str = "Apple FY2023 revenue: $383.285B") -> None:
        self._tool = tool
        self._material = material

    @property
    def tool_name(self) -> str:
        return self._tool

    async def fetch(self, query: str) -> str:  # noqa: ARG002
        return self._material


def _complete_returning(payload: dict):
    return lambda messages: json.dumps(payload)  # noqa: ARG005


@pytest.mark.asyncio
async def test_generate_row_builds_agent_schema():
    gen = DatasetGenerator(
        source=_FakeSource(),
        complete=_complete_returning(
            {
                "question": "What was Apple's FY2023 revenue?",
                "expected_response": "Apple's FY2023 revenue was $383.285 billion.",
                "expected_facts": ["Apple", "$383.285B", "FY2023"],
                "difficulty": "simple",
            }
        ),
        domain="finance",
    )
    row = await gen.generate_row("Apple annual revenue")
    assert row is not None
    assert row.input_tools == "search"
    assert row.expect_expected_actions.startswith("search(query=")
    assert row.expect_expected_facts == "Apple;$383.285B;FY2023"
    assert row.tag_domain == "finance"


@pytest.mark.asyncio
async def test_insufficient_material_is_skipped():
    gen = DatasetGenerator(
        source=_FakeSource(material="(no data)"),
        complete=_complete_returning({"question": "q", "expected_response": "INSUFFICIENT_MATERIAL"}),
    )
    assert await gen.generate_row("obscure") is None


@pytest.mark.asyncio
async def test_non_json_output_is_skipped_in_generate():
    gen = DatasetGenerator(source=_FakeSource(), complete=lambda m: "not json")  # noqa: ARG005
    rows = await gen.generate(["a", "b"])
    assert rows == []


@pytest.mark.asyncio
async def test_generated_csv_round_trips_to_expected_tools():
    gen = DatasetGenerator(
        source=_FakeSource(tool="search"),
        complete=_complete_returning(
            {
                "question": "What was Apple's FY2023 revenue?",
                "expected_response": "$383.285 billion.",
                "expected_facts": ["revenue"],
                "difficulty": "simple",
            }
        ),
    )
    rows = await gen.generate(["Apple revenue"])
    csv_text = rows_to_csv(rows)

    # The generated CSV must parse back through the registry parser + bridge and
    # yield expected_tools == [search] (closing the generation -> eval loop).
    records = parse_csv(csv_text)
    eval_rows = records_to_rows(records, response_source="agent")
    assert len(eval_rows) == 1
    assert eval_rows[0].expected_tools == ["search"]
    assert eval_rows[0].expected_response == "$383.285 billion."


@pytest.mark.asyncio
async def test_generation_logs_never_carry_the_seed_text(caplog):
    """Seeds are the caller's prompt/instruction text; a skipped seed is logged
    without it, as every other generation failure logs only the error type."""
    import logging

    sentinel = "customer-wording-sentinel"
    insufficient = DatasetGenerator(source=_FakeSource(), complete=_complete_returning({"expected_response": "INSUFFICIENT_MATERIAL"}))
    invalid = DatasetGenerator(source=_FakeSource(), complete=lambda messages: "not json")  # noqa: ARG005
    with caplog.at_level(logging.WARNING, logger="evalhub"):
        assert await insufficient.generate([sentinel]) == []
        assert await invalid.generate([sentinel]) == []
    records = [record for record in caplog.records if record.name.startswith("evalhub")]
    assert len(records) == 2
    for record in records:
        assert sentinel not in record.getMessage()
        assert sentinel not in str(vars(record))
