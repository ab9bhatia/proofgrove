"""Tests for the generation pipeline + worker dispatch (offline)."""

import json
from unittest.mock import MagicMock

import pytest
from sqlalchemy import update

from proofgrove import runs_worker
from proofgrove.db.models import RunJobORM
from proofgrove.db.session import async_session
from proofgrove.db.store import EvaluationStore
from proofgrove.generation import pipeline


class _FakeSource:
    def __init__(self, *args, **kwargs):  # noqa: ARG002 — matches McpToolGroundingSource
        pass

    @property
    def tool_name(self) -> str:
        return "search"

    async def fetch(self, query: str) -> str:  # noqa: ARG002
        return "Apple FY2023 revenue: $383.285B"


async def _clear_pending() -> None:
    async with async_session() as s:
        await s.execute(update(RunJobORM).values(status="completed"))
        await s.commit()


@pytest.mark.asyncio
async def test_generate_and_register_creates_draft_agent_dataset(monkeypatch):
    monkeypatch.setattr(pipeline, "McpToolGroundingSource", _FakeSource)

    async def _complete(messages):  # noqa: ARG001
        return json.dumps(
            {
                "question": "What was Apple's FY2023 revenue?",
                "expected_response": "$383.285 billion.",
                "expected_facts": ["$383.285B"],
                "difficulty": "simple",
            }
        )

    monkeypatch.setattr(pipeline, "_build_gateway_complete", lambda model, *args, **kwargs: _complete)  # noqa: ARG005

    registry = MagicMock()
    registry.create_dataset.return_value = MagicMock(name="gen_ds")
    # MagicMock(name=...) sets the mock's name, not a .name attribute for the info object.
    info = MagicMock()
    info.name = "gen_ds"
    registry.create_dataset.return_value = info
    registry.replace_records.return_value = 1
    count = await pipeline.generate_and_register(
        dataset_name="gen_ds",
        params={
            "seeds": ["Apple revenue"],
            "grounding_url": "http://mcp/mcp",
            "grounding_tool": "search",
            "domain": "finance",
        },
        registry=registry,
    )

    assert count == 1
    registry.create_dataset.assert_called_once()
    records = registry.replace_records.call_args.args[1]
    assert records[0].expectations["expected_actions"].startswith("search(")
    assert records[0].tags["domain"] == "finance"


@pytest.mark.asyncio
async def test_llms_generation_writes_no_expected_actions(monkeypatch):
    """The llms path emits question + expected answer only — no tool ground truth."""

    async def _complete(messages):  # noqa: ARG001
        return json.dumps({"records": [{"question": "Q1", "expected_output": "A1"}]})

    monkeypatch.setattr(pipeline, "_build_gateway_complete", lambda model, *args, **kwargs: _complete)  # noqa: ARG005

    registry = MagicMock()
    info = MagicMock()
    info.name = "prompt_ds"
    registry.create_dataset.return_value = info
    registry.replace_records.return_value = 1
    await pipeline.generate_and_register(
        dataset_name="prompt_ds",
        params={
            "generation_method": "llms",
            "seeds": ["Create one support evaluation case"],
            "num_rows": 1,
            "model": "gpt-5.1",
        },
        registry=registry,
    )

    records = registry.replace_records.call_args.args[1]
    assert "expected_actions" not in records[0].expectations


@pytest.mark.asyncio
async def test_generate_and_register_rejects_no_seeds():
    with pytest.raises(ValueError, match="seed"):
        await pipeline.generate_and_register(
            dataset_name="x", params={"grounding_url": "u", "seeds": []}, registry=MagicMock()
        )


@pytest.mark.asyncio
async def test_generate_and_register_requires_grounding_url():
    with pytest.raises(ValueError, match="grounding_url"):
        await pipeline.generate_and_register(
            dataset_name="x", params={"seeds": ["a"]}, registry=MagicMock()
        )


@pytest.mark.asyncio
async def test_generate_and_register_llms_from_single_prompt(monkeypatch):
    async def _complete(messages):  # noqa: ARG001
        return json.dumps(
            {
                "records": [
                    {
                        "question": "Q1",
                        "expected_output": "A1",
                        "risk": "Low",
                    },
                    {
                        "question": "Q2",
                        "expected_output": "A2",
                        "risk": "High",
                    },
                ]
            }
        )

    monkeypatch.setattr(pipeline, "_build_gateway_complete", lambda model, *args, **kwargs: _complete)  # noqa: ARG005

    registry = MagicMock()
    info = MagicMock()
    info.name = "prompt_ds"
    registry.create_dataset.return_value = info
    registry.replace_records.return_value = 2
    count = await pipeline.generate_and_register(
        dataset_name="prompt_ds",
        params={
            "generation_method": "llms",
            "seeds": ["Create two support evaluation cases"],
            "num_rows": 2,
            "domain": "support",
            "model": "gpt-5.1",
        },
        registry=registry,
    )

    assert count == 2
    records = registry.replace_records.call_args.args[1]
    assert len(records) == 2
    assert records[0].inputs["question"] == "Q1"
    assert records[0].expectations["expected_output"] == "A1"
    assert records[1].tags["risk"] == "High"


@pytest.mark.asyncio
async def test_generate_and_register_llms_requires_num_rows():
    with pytest.raises(ValueError, match="num_rows"):
        await pipeline.generate_and_register(
            dataset_name="x",
            params={
                "generation_method": "llms",
                "seeds": ["Make cases"],
                "model": "gpt-5.1",
            },
            registry=MagicMock(),
        )


@pytest.mark.asyncio
async def test_generate_and_register_tools_expands_single_prompt(monkeypatch):
    monkeypatch.setattr(pipeline, "McpToolGroundingSource", _FakeSource)

    async def _complete(messages):
        user = messages[-1]["content"]
        if "seed topics" in user or '"seeds"' in user or "Produce exactly" in user:
            return json.dumps({"seeds": ["Apple revenue", "Apple services"]})
        return json.dumps(
            {
                "question": "What was Apple's FY2023 revenue?",
                "expected_response": "$383.285 billion.",
                "expected_facts": ["$383.285B"],
                "difficulty": "simple",
            }
        )

    monkeypatch.setattr(pipeline, "_build_gateway_complete", lambda model, *args, **kwargs: _complete)  # noqa: ARG005

    registry = MagicMock()
    info = MagicMock()
    info.name = "tools_ds"
    registry.create_dataset.return_value = info
    registry.replace_records.return_value = 2
    count = await pipeline.generate_and_register(
        dataset_name="tools_ds",
        params={
            "generation_method": "tools",
            "seeds": ["Create two finance evaluation cases about Apple"],
            "num_rows": 2,
            "grounding_url": "http://mcp/mcp",
            "grounding_tool": "search",
            "domain": "finance",
            "model": "gpt-5.1",
        },
        registry=registry,
    )

    assert count == 2
    records = registry.replace_records.call_args.args[1]
    assert len(records) == 2


@pytest.mark.asyncio
async def test_worker_dispatches_generation(monkeypatch):
    await _clear_pending()
    async with async_session() as s:
        job_id = await EvaluationStore(s).create_generation_job(
            dataset_name="gen_ds", params={"seeds": ["x"], "grounding_url": "u"}
        )

    seen: dict = {}

    async def _fake_gen(**kwargs):
        seen.update(kwargs)
        return 2

    monkeypatch.setattr(runs_worker, "generate_and_register", _fake_gen)

    assert await runs_worker.process_one_job() is True
    async with async_session() as s:
        job = await EvaluationStore(s).get_run_job(job_id)
    assert job.status == "completed"
    assert seen["dataset_name"] == "gen_ds"
    assert seen["params"]["grounding_url"] == "u"
