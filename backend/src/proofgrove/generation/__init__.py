"""Synthetic golden-dataset generation.

Generates evaluation golden rows grounded in real source material. The pipeline
is generic via a pluggable ``GroundingSource`` (fetch context material for a
seed), plus an LLM that turns the material into a golden Q&A row. Kensho
(``kensho-mcp`` ``search``) is the first grounding source; an uploaded corpus is
another. Manual CSV/JSON upload stays the always-available path.

Delivered as a script (scripts/generate_dataset.py) for M3; the same code backs a
UI-facing generation endpoint later (M4). The MCP-backed source needs the
optional ``generation`` extra (``uv sync --extra generation``); it is imported
lazily so the core service is unaffected.
"""

from proofgrove.generation.generator import DatasetGenerator, GeneratedRow
from proofgrove.generation.sources import (
    GroundingSource,
    McpToolGroundingSource,
)

__all__ = [
    "DatasetGenerator",
    "GeneratedRow",
    "GroundingSource",
    "McpToolGroundingSource",
]
