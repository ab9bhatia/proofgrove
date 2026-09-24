"""Run label normalization shared by API, workers, and persistence."""

from __future__ import annotations

MAX_RUN_LABELS = 10
MAX_RUN_LABEL_LENGTH = 64


def normalize_run_labels(
    *,
    label: str | None = None,
    labels: list[str] | None = None,
    name: str | None = None,
) -> tuple[str | None, list[str]]:
    """Return the legacy label alias plus the canonical labels list.

    ``labels`` is authoritative when supplied, including an explicit empty
    list. The legacy ``label`` / ``name`` path is accepted only when ``labels``
    is absent, and ``label`` is derived back from the first normalized label so
    older readers keep seeing a single annotation.
    """

    if labels is not None:
        raw_labels = labels
    else:
        legacy = label if label is not None else name
        raw_labels = [legacy] if legacy is not None else []

    normalized: list[str] = []
    seen: set[str] = set()
    for raw in raw_labels:
        value = str(raw).strip()
        if not value:
            continue
        value = value[:MAX_RUN_LABEL_LENGTH]
        if value in seen:
            continue
        seen.add(value)
        normalized.append(value)
        if len(normalized) >= MAX_RUN_LABELS:
            break

    return (normalized[0] if normalized else None), normalized
