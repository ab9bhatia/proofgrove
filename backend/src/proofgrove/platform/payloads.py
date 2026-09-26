"""Payload-size and redaction controls for persisted evaluation evidence."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from proofgrove.redaction import (
    _BEARER_TOKEN,
    _CARD_NUMBER,
    _EMAIL,
    _IBAN,
    _OPENAI_KEY,
    _SENSITIVE_KEY,
    CREDENTIAL_PATTERNS,
    TRUNCATION_MARKER,
    _is_usage_token_count,
    redact_for_persistence,
)
from proofgrove.settings import settings

__all__ = [
    "CREDENTIAL_PATTERNS",
    "TRUNCATION_MARKER",
    "redact_for_persistence",
    "redact_artifact_content",
]


def redact_artifact_content(content: str, content_type: str) -> str:
    """Redact artifact content without applying the inline evidence truncation."""

    if not settings.payload_redaction_enabled:
        return content
    if content_type == "application/json":
        try:
            value = json.loads(content)
        except json.JSONDecodeError:
            value = content
        redacted = _redact_unbounded(value)
        if not isinstance(redacted, str):
            return json.dumps(redacted, ensure_ascii=False, default=str)
        return redacted
    redacted = _redact_unbounded(content)
    return redacted if isinstance(redacted, str) else str(redacted)


def _redact_unbounded(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): (
                "[REDACTED]"
                if settings.payload_redaction_enabled
                and _SENSITIVE_KEY.search(str(key))
                and not _is_usage_token_count(key, item)
                else _redact_unbounded(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact_unbounded(item) for item in value]
    if isinstance(value, tuple):
        return [_redact_unbounded(item) for item in value]
    if isinstance(value, str):
        result = _BEARER_TOKEN.sub("Bearer [REDACTED]", value)
        result = _OPENAI_KEY.sub("[REDACTED]", result)
        result = _EMAIL.sub("[REDACTED_EMAIL]", result)
        result = _CARD_NUMBER.sub("[REDACTED_CARD]", result)
        return _IBAN.sub("[REDACTED_IBAN]", result)
    return value
