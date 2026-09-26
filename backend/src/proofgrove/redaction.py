"""Shared PII/credential redaction pattern used by logging and by persisted evidence.

Split out of :mod:`proofgrove.platform.payloads` so :mod:`proofgrove.logging_config`
-- a process-wide concern configured before any request-handling layer exists
-- doesn't have to reach into ``platform/`` (an application layer) to redact
log fields. ``proofgrove.platform.payloads`` re-uses these same patterns for its
larger, persistence-specific redaction surface (unbounded artifact redaction,
truncation, credential-naming for prompt refusal).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from proofgrove.settings import settings

_SENSITIVE_KEY = re.compile(r"(api[-_]?key|authorization|cookie|password|secret|token|credential)", re.IGNORECASE)
# Every numeric usage-count key the runners and OTLP conventions persist.
# ``completion_tokens``/``input_tokens`` were missing, so a stored usage dict
# came back with "[REDACTED]" counts and broke cost estimation downstream.
# The int-only guard in ``_is_usage_token_count`` keeps the exemption narrow.
_USAGE_TOKEN_COUNT_KEYS = frozenset(
    {"prompt_tokens", "completion_tokens", "input_tokens", "output_tokens", "total_tokens"}
)
_BEARER_TOKEN = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_OPENAI_KEY = re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b")
# ``scheme://user:password@host`` -- the shape a database DSN or an object-store
# endpoint takes when a driver error echoes its connection target.
_URL_CREDENTIALS = re.compile(r"(\b[a-z][a-z0-9+.-]*://[^/\s:@]+:)[^@\s/]+@", re.IGNORECASE)
# ``password=...`` / ``token: ...`` fragments as libpq, psycopg and HTTP clients
# format them in exception text.
_KEY_VALUE_SECRET = re.compile(r"\b(password|passwd|pwd|secret|token|api[-_]?key)\b(\s*[=:]\s*)\S+", re.IGNORECASE)

#: Credential shapes and how to name them to a user. Shared so a caller that
#: must REFUSE a credential (a prompt, which is executed verbatim) recognises
#: exactly what this module would otherwise redact.
CREDENTIAL_PATTERNS = (
    (_BEARER_TOKEN, "a bearer token"),
    (_OPENAI_KEY, "an API key"),
)
_EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
_CARD_NUMBER = re.compile(r"\b(?:\d[ -]*?){13,19}\b")
_IBAN = re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b", re.IGNORECASE)

#: Appended to any persisted string cut at ``max_persisted_sample_chars``.
#: Shared with the promotion builder, which refuses truncated text as a
#: golden expectation.
TRUNCATION_MARKER = "[TRUNCATED]"


def _is_usage_token_count(key: Any, value: Any) -> bool:
    return (
        str(key).lower() in _USAGE_TOKEN_COUNT_KEYS
        and isinstance(value, (int, float))
        and not isinstance(value, bool)
    )


def _truncate(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    limit = settings.max_persisted_sample_chars
    if len(value) <= limit:
        return value
    marker = TRUNCATION_MARKER
    if limit <= 0:
        return ""
    if limit <= len(marker):
        return marker[:limit]
    return f"{value[: limit - len(marker)]}{marker}"


def redact_for_persistence(value: Any, *, force: bool = False) -> Any:
    """Return a bounded, recursively redacted representation of a payload.

    Proofgrove must retain enough evidence for review without persisting bearer
    credentials, API keys, or unconstrained user payloads in its tenant-local
    evidence tables. This is intentionally deterministic so audits remain
    comparable across reruns. Logs use ``force=True`` so evidence-retention
    settings cannot disable credential redaction in operational output.
    """
    if isinstance(value, Mapping):
        return {
            str(key): (
                "[REDACTED]"
                if (force or settings.payload_redaction_enabled)
                and _SENSITIVE_KEY.search(str(key))
                and not _is_usage_token_count(key, item)
                else redact_for_persistence(item, force=force)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_for_persistence(item, force=force) for item in value]
    if isinstance(value, tuple):
        return [redact_for_persistence(item, force=force) for item in value]
    if isinstance(value, str):
        if not (force or settings.payload_redaction_enabled):
            return _truncate(value)
        result = _BEARER_TOKEN.sub("Bearer [REDACTED]", value)
        result = _OPENAI_KEY.sub("[REDACTED]", result)
        result = _URL_CREDENTIALS.sub(r"\1[REDACTED]@", result)
        result = _KEY_VALUE_SECRET.sub(r"\1\2[REDACTED]", result)
        result = _EMAIL.sub("[REDACTED_EMAIL]", result)
        result = _CARD_NUMBER.sub("[REDACTED_CARD]", result)
        result = _IBAN.sub("[REDACTED_IBAN]", result)
        return _truncate(result)
    return value


def safe_error_message(exc: BaseException) -> str:
    """A failure description that can be persisted as tenant-visible evidence.

    Only a ``TenantVisibleError`` keeps its message -- the explicit contract
    that every raise site of that class authors the text itself (see
    ``proofgrove.errors``). Everything else -- a database driver error carrying
    host, user and statement, an HTTP client error echoing a URL, a bare
    ``ValueError`` from any library -- is reduced to its type name. The
    readiness probe applies the same rule to its log line for the same
    reason: foreign text cannot be made safe by a pattern-based scrub, so the
    scrub applied to authored messages here is defence in depth, not the
    guarantee. ``ExceptionGroup`` noise is flattened to its first member;
    ``pydantic.ValidationError`` repeats the offending input and is never kept.
    """
    from pydantic import ValidationError

    from proofgrove.errors import TenantVisibleError

    if isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        return safe_error_message(exc.exceptions[0])
    if isinstance(exc, TenantVisibleError) and not isinstance(exc, ValidationError):
        message = str(exc).strip()
        if message:
            return str(redact_for_persistence(message, force=True))
    return f"{type(exc).__name__}: the failure detail is withheld from stored evidence"
