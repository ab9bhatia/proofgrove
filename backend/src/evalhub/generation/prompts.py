"""Prompt for turning grounding material into a golden Q&A row."""

from __future__ import annotations

_OUTPUT_CONTRACT = """
Respond with ONLY valid JSON (no markdown fences):
{
  "question": "<a clear, self-contained question a user would ask>",
  "expected_response": "<the correct answer, grounded ONLY in the provided material>",
  "expected_facts": ["<key fact 1>", "<key fact 2>"],
  "difficulty": "simple|medium|complex"
}

Rules:
- The expected_response MUST be supported by the provided material. Do NOT invent
  numbers or facts that are not in the material.
- If the material is insufficient to answer, set expected_response to
  "INSUFFICIENT_MATERIAL" and expected_facts to [].
- Keep the question answerable by an agent that has the relevant tool available.
"""

_PROMPT_BATCH_CONTRACT = """
Respond with ONLY valid JSON (no markdown fences):
{
  "records": [
    {
      "question": "<a clear, self-contained question or user prompt>",
      "expected_output": "<the ideal / ground-truth answer>",
      "risk": "Low|Medium|High"
    }
  ]
}

Rules:
- Return exactly the requested number of records.
- Each record must be unique and useful for evaluation.
- Follow the user's instruction carefully for topic, style, and constraints.
- Prefer realistic evaluation cases (not meta commentary about generating data).
- Use Risk = Low unless the instruction implies a higher risk case.
"""


def build_generation_messages(seed: str, material: str, tool_name: str) -> list[dict[str, str]]:
    """Build chat messages that synthesise one golden row from grounding material."""

    tool_hint = (
        f"An agent answering this question is expected to call the '{tool_name}' tool "
        "to retrieve the data."
        if tool_name
        else "Answer using only the provided material."
    )
    system = (
        "You are a meticulous evaluation dataset author. You write golden Q&A rows "
        "for grounded evaluation. Every expected answer must be faithful to the "
        "provided source material. Return ONLY valid JSON."
    )
    user = "\n".join(
        [
            f"## Seed topic\n{seed}",
            f"\n## Source material (ground truth)\n{material}",
            f"\n## Guidance\n{tool_hint}",
            f"\n{_OUTPUT_CONTRACT}",
        ]
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def build_prompt_batch_messages(
    instruction: str,
    *,
    num_rows: int,
    domain: str = "",
) -> list[dict[str, str]]:
    """Build chat messages that expand one instruction into ``num_rows`` golden rows."""

    system = (
        "You are a meticulous evaluation dataset author. You synthesize high-quality "
        "golden evaluation cases from a single user instruction. Return ONLY valid JSON."
    )
    domain_line = f"\n## Domain / use case\n{domain}" if domain.strip() else ""
    user = "\n".join(
        [
            f"## Generation instruction\n{instruction.strip()}",
            domain_line,
            f"\n## Requested size\nGenerate exactly {num_rows} records.",
            f"\n{_PROMPT_BATCH_CONTRACT}",
        ]
    ).strip()
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


_SEED_EXPAND_CONTRACT = """
Respond with ONLY valid JSON (no markdown fences):
{
  "seeds": ["<short seed topic or search query 1>", "<seed 2>"]
}

Rules:
- Return exactly the requested number of seeds.
- Each seed must be a concrete, distinct topic or lookup query suitable for a
  grounding tool (search / MCP tool call).
- Seeds must follow the user's instruction for domain, style, and constraints.
- Prefer short phrases (a few words to one sentence), not full Q&A pairs.
"""


def build_seed_expansion_messages(
    instruction: str,
    *,
    num_rows: int,
    domain: str = "",
) -> list[dict[str, str]]:
    """Build chat messages that expand one instruction into ``num_rows`` seed topics."""

    system = (
        "You plan grounded evaluation datasets. From one user instruction you produce "
        "distinct seed topics that an MCP grounding tool can look up. Return ONLY valid JSON."
    )
    domain_line = f"\n## Domain / use case\n{domain}" if domain.strip() else ""
    user = "\n".join(
        [
            f"## Generation instruction\n{instruction.strip()}",
            domain_line,
            f"\n## Requested size\nProduce exactly {num_rows} seed topics.",
            f"\n{_SEED_EXPAND_CONTRACT}",
        ]
    ).strip()
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
