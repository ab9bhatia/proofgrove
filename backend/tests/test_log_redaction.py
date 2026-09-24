"""Operational logs redact credentials independently of evidence retention."""

import json
import logging
import sys

import pytest

from evalhub.logging_config import JsonLogFormatter
from evalhub.settings import settings


@pytest.mark.parametrize("persistence_redaction", [True, False])
def test_log_message_exception_and_extra_redact_credentials(monkeypatch, persistence_redaction):
    monkeypatch.setattr(settings, "payload_redaction_enabled", persistence_redaction)
    bearer = "synthetic-private-token"
    key = "sk-synthetic_private_key_123456"
    try:
        raise ValueError(f"Authorization: Bearer {bearer}; key={key}")
    except ValueError:
        record = logging.LogRecord("evalhub.test", logging.ERROR, "test.py", 1, "Failed: Bearer %s %s", (bearer, key), sys.exc_info())
    record.password = "synthetic-password"
    record.prompt_tokens = 12
    payload = json.loads(JsonLogFormatter().format(record))
    rendered = json.dumps(payload)
    assert bearer not in rendered
    assert key not in rendered
    assert "synthetic-password" not in rendered
    assert "Failed: Bearer [REDACTED]" in payload["message"]
    assert "ValueError" in payload["exc_info"]
    assert payload["prompt_tokens"] == 12
    # Formatting must not alter a record another handler may still consume.
    assert bearer in record.getMessage()


@pytest.mark.parametrize("persistence_redaction", [True, False])
def test_opaque_extra_value_is_redacted_after_string_conversion(monkeypatch, persistence_redaction):
    monkeypatch.setattr(settings, "payload_redaction_enabled", persistence_redaction)
    record = logging.LogRecord("evalhub.test", logging.ERROR, "test.py", 1, "Failed", (), None)
    record.detail = ValueError("Bearer synthetic_private_token")
    payload = json.loads(JsonLogFormatter().format(record))
    assert payload["detail"] == "Bearer [REDACTED]"
