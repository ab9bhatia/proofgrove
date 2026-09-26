"""Helpers for the LLM-as-a-Judge model catalogue."""

from __future__ import annotations

from collections.abc import Iterable


def is_judge_model(model_id: str) -> bool:
    """Return True when ``model_id`` is suitable for LLM-as-a-Judge scoring."""
    lower = model_id.lower().strip()
    if not lower:
        return False
    if lower.startswith("text-embedding-") or lower.startswith("embed-"):
        return False
    if lower.startswith("whisper") or lower.startswith("gpt-image-"):
        return False
    if lower.endswith("-tts") or lower.endswith("-transcribe") or lower.endswith("-reranker"):
        return False
    if lower in {"gpt-realtime", "qwen3-embedding"}:
        return False
    return True


def filter_judge_model_ids(model_ids: Iterable[str]) -> list[str]:
    """Deduplicate and drop non-chat modalities from a model id iterable."""
    return sorted({mid for mid in model_ids if is_judge_model(mid)})


def order_judge_models(models: list[str], preferred: str | None) -> list[str]:
    """Put the configured default first when it is present in ``models``."""
    if not preferred or preferred not in models:
        return models
    return [preferred, *[m for m in models if m != preferred]]
