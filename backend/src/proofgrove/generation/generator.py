"""Generate golden dataset rows grounded in real source material.

For each seed: fetch grounding material via a ``GroundingSource``, ask an LLM to
write a faithful Q&A row, and emit it in Proofgrove's ``agent`` golden CSV schema
(``input_*`` / ``expect_*`` / ``tag_*``). Output is written to CSV for light
human review, then uploaded via the dataset registry API.

The LLM call is injected as a ``complete`` callable so this is testable offline
and provider-agnostic (the CLI wires an OpenAI-compatible client at the AI
Gateway).
"""

from __future__ import annotations

import csv
import inspect
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from io import StringIO

from proofgrove.errors import TenantVisibleError
from proofgrove.generation.prompts import build_generation_messages
from proofgrove.generation.sources import GroundingSource

logger = logging.getLogger(__name__)

# CSV header for the agent golden schema (matches services/proofgrove/scripts/sample_datasets).
CSV_FIELDS = [
    "input_query",
    "input_tools",
    "expect_expected_response",
    "expect_expected_actions",
    "expect_expected_facts",
    "tag_domain",
    "tag_difficulty",
]


@dataclass
class GeneratedRow:
    """One synthesised golden row (agent schema)."""

    input_query: str
    input_tools: str
    expect_expected_response: str
    expect_expected_actions: str
    expect_expected_facts: str
    tag_domain: str = ""
    tag_difficulty: str = "simple"

    def as_csv_dict(self) -> dict[str, str]:
        return {
            "input_query": self.input_query,
            "input_tools": self.input_tools,
            "expect_expected_response": self.expect_expected_response,
            "expect_expected_actions": self.expect_expected_actions,
            "expect_expected_facts": self.expect_expected_facts,
            "tag_domain": self.tag_domain,
            "tag_difficulty": self.tag_difficulty,
        }


class GenerationError(RuntimeError, TenantVisibleError):
    """Raised when a row cannot be generated (LLM output unparseable, etc.)."""


class DatasetGenerator:
    """Generate golden rows from seeds using a grounding source + an LLM."""

    def __init__(
        self,
        *,
        source: GroundingSource,
        complete: Callable[[list[dict[str, str]]], str | Awaitable[str]],
        domain: str = "",
    ) -> None:
        self._source = source
        self._complete = complete
        self._domain = domain

    async def generate_row(self, seed: str) -> GeneratedRow | None:
        """Generate one row for a seed. Returns None when the material is
        insufficient (so the row is skipped rather than fabricated)."""

        material = await self._source.fetch(seed)
        messages = build_generation_messages(seed, material, self._source.tool_name)
        raw = self._complete(messages)
        # complete may be sync (tests, CLI) or async (worker offloads the blocking
        # OpenAI call to a thread so it does not freeze the event loop).
        if inspect.isawaitable(raw):
            raw = await raw
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise GenerationError("LLM returned invalid JSON for a generation seed") from exc

        expected = str(parsed.get("expected_response", "")).strip()
        if not expected or expected == "INSUFFICIENT_MATERIAL":
            # The seed is the caller's own prompt text: not for operational logs.
            logger.warning("proofgrove.generation: insufficient material for a seed; skipping")
            return None

        question = str(parsed.get("question") or seed).strip()
        facts = parsed.get("expected_facts") or []
        facts_str = ";".join(str(f).strip() for f in facts if str(f).strip()) if isinstance(facts, list) else str(facts)
        difficulty = str(parsed.get("difficulty") or "simple").strip()

        tool = self._source.tool_name
        # Record the expected tool call (dataset-driven groundedness). The query
        # arg is informational; the tool NAME is what grounds the metric.
        expected_actions = f"{tool}(query='{_escape(seed)}')" if tool else ""
        input_tools = tool

        return GeneratedRow(
            input_query=question,
            input_tools=input_tools,
            expect_expected_response=expected,
            expect_expected_actions=expected_actions,
            expect_expected_facts=facts_str,
            tag_domain=self._domain,
            tag_difficulty=difficulty,
        )

    async def generate(self, seeds: list[str]) -> list[GeneratedRow]:
        """Generate rows for all seeds, skipping any with insufficient material."""

        rows: list[GeneratedRow] = []
        for seed in seeds:
            try:
                row = await self.generate_row(seed)
            except GenerationError as exc:
                logger.warning("proofgrove.generation: seed skipped", extra={"error_type": type(exc).__name__})
                continue
            if row is not None:
                rows.append(row)
        return rows


def rows_to_csv(rows: list[GeneratedRow]) -> str:
    """Render generated rows as agent-schema CSV text."""

    buf = StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_FIELDS)
    writer.writeheader()
    for row in rows:
        writer.writerow(row.as_csv_dict())
    return buf.getvalue()


def _escape(value: str) -> str:
    return value.replace("'", " ").replace("\n", " ").strip()
