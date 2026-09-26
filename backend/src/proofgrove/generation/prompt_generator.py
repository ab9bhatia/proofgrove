"""Prompt-driven synthetic dataset generation (no MCP grounding).

Expands a single user instruction into N golden CSV-shaped records:
Serial No, Question, Expected Output, Risk.

Also expands one instruction into N grounding seed topics for tools/agents.
"""

from __future__ import annotations

import inspect
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from proofgrove.errors import TenantVisibleError
from proofgrove.generation.prompts import build_prompt_batch_messages, build_seed_expansion_messages

logger = logging.getLogger(__name__)

MAX_PROMPT_ROWS = 50


class PromptGenerationError(RuntimeError, TenantVisibleError):
    """Raised when prompt-based generation cannot produce usable rows."""


def _parse_json_payload(raw: str) -> Any:
    """Parse JSON, tolerating optional markdown fences from Claude-style models."""
    text = raw.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        # Drop opening ``` / ```json and closing ```
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return json.loads(text)


async def _call_complete(
    complete: Callable[[list[dict[str, str]]], str | Awaitable[str]],
    messages: list[dict[str, str]],
) -> str:
    raw = complete(messages)
    if inspect.isawaitable(raw):
        raw = await raw
    return str(raw)


async def expand_instruction_to_seeds(
    *,
    instruction: str,
    num_rows: int,
    complete: Callable[[list[dict[str, str]]], str | Awaitable[str]],
    domain: str = "",
) -> list[str]:
    """Expand one generation instruction into ``num_rows`` grounding seed topics."""
    prompt = instruction.strip()
    if not prompt:
        raise PromptGenerationError("generation instruction is required")
    if num_rows < 1:
        raise PromptGenerationError("num_rows must be at least 1")
    if num_rows > MAX_PROMPT_ROWS:
        raise PromptGenerationError(f"num_rows exceeds max allowed ({MAX_PROMPT_ROWS})")

    messages = build_seed_expansion_messages(prompt, num_rows=num_rows, domain=domain)
    raw = await _call_complete(complete, messages)
    try:
        parsed = _parse_json_payload(raw)
    except json.JSONDecodeError as exc:
        raise PromptGenerationError("LLM returned a non-JSON seed list") from exc

    items = parsed.get("seeds") if isinstance(parsed, dict) else None
    if not isinstance(items, list) or not items:
        raise PromptGenerationError("LLM response missing a non-empty seeds array")

    seeds: list[str] = []
    for item in items:
        text = str(item).strip()
        if text and text not in seeds:
            seeds.append(text)
        if len(seeds) >= num_rows:
            break

    if not seeds:
        raise PromptGenerationError("no usable seeds generated from the instruction")
    # If the model under-produced, pad so Size is honored — cycling through
    # the seeds the model DID produce, not just repeating the first one.
    # ``len(seeds) % len(seeds)`` is always 0 once the list being indexed is
    # the same list being grown, so the modulo must be taken against the
    # PRE-PAD count, fixed before the loop starts.
    seed_count = len(seeds)
    while len(seeds) < num_rows:
        base = seeds[len(seeds) % seed_count]
        seeds.append(f"{base} (variant {len(seeds) + 1})")
    return seeds[:num_rows]


async def generate_records_from_prompt(
    *,
    instruction: str,
    num_rows: int,
    complete: Callable[[list[dict[str, str]]], str | Awaitable[str]],
    domain: str = "",
) -> list[dict[str, Any]]:
    """Generate ``num_rows`` dataset record dicts from one instruction.

    Returns dicts compatible with ``DatasetRecord``
    (``inputs`` / ``expectations`` / ``tags``).
    """
    prompt = instruction.strip()
    if not prompt:
        raise PromptGenerationError("generation instruction is required")
    if num_rows < 1:
        raise PromptGenerationError("num_rows must be at least 1")
    if num_rows > MAX_PROMPT_ROWS:
        raise PromptGenerationError(f"num_rows exceeds max allowed ({MAX_PROMPT_ROWS})")

    messages = build_prompt_batch_messages(prompt, num_rows=num_rows, domain=domain)
    for attempt in range(2):
        raw = await _call_complete(complete, messages)
        try:
            return _parse_records(raw, num_rows=num_rows, domain=domain)
        except PromptGenerationError:
            if attempt:
                raise
            # Retry the same selected model once; never fabricate or pad rows.
            # Do not echo untrusted model output (or hidden reasoning) back.
            messages = [*messages, {"role": "user", "content": (
                f"The previous response did not satisfy the dataset format. Generate exactly {num_rows} distinct records "
                "as a JSON object with a records array. Every record needs non-empty question and expected_output strings "
                "and a risk string. Return the complete JSON only, without explanations."
            )}]
    raise AssertionError("unreachable")


def _parse_records(raw: str, *, num_rows: int, domain: str) -> list[dict[str, Any]]:
    try:
        parsed = _parse_json_payload(raw)
    except json.JSONDecodeError as exc:
        raise PromptGenerationError("LLM returned non-JSON") from exc
    items = parsed.get("records") if isinstance(parsed, dict) else None
    if not isinstance(items, list) or not items:
        raise PromptGenerationError("LLM response missing a non-empty records array")

    if len(items) != num_rows:
        raise PromptGenerationError("Model did not return the requested number of distinct complete records. Reduce Size or choose another model.")
    records: list[dict[str, Any]] = []
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        question = str(
            item.get("question")
            or item.get("query")
            or item.get("prompt")
            or ""
        ).strip()
        expected = str(
            item.get("expected_output")
            or item.get("expected_response")
            or item.get("expected_answer")
            or item.get("answer")
            or ""
        ).strip()
        risk = str(item.get("risk") or "Low").strip() or "Low"
        raw_question = item.get("question") or item.get("query") or item.get("prompt")
        raw_expected = item.get("expected_output") or item.get("expected_response") or item.get("expected_answer") or item.get("answer")
        if not isinstance(raw_question, str) or not isinstance(raw_expected, str) or not question or not expected:
            logger.warning(
                "proofgrove.generation: skipping incomplete prompt row %s", index
            )
            continue
        records.append(
            {
                "inputs": {"question": question, "query": question},
                "expectations": {
                    "expected_output": expected,
                    "expected_response": expected,
                },
                "tags": {
                    "serial_no": str(index),
                    "risk": risk,
                    **({"domain": domain} if domain.strip() else {}),
                },
            }
        )

    if not records:
        raise PromptGenerationError("no usable records generated from the instruction")
    if len(records) != num_rows or len({record["inputs"]["question"] for record in records}) != num_rows:
        raise PromptGenerationError("Model did not return the requested number of distinct complete records. Reduce Size or choose another model.")
    return records
