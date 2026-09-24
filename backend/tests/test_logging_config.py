"""extra= fields must be redacted before they reach the JSON log line."""

import json
import logging

from evalhub.logging_config import JsonLogFormatter


def _format(**extra) -> dict:
    record = logging.getLogger("test").makeRecord(
        "test", logging.INFO, __file__, 1, "msg", (), None, extra=extra
    )
    return json.loads(JsonLogFormatter().format(record))


def test_sensitive_extra_key_is_redacted() -> None:
    payload = _format(password="x", authorization="Bearer abc123")
    assert payload["password"] == "[REDACTED]"
    assert payload["authorization"] == "[REDACTED]"


def test_sensitive_eval_field_is_redacted() -> None:
    record = logging.getLogger("test").makeRecord(
        "test",
        logging.INFO,
        __file__,
        1,
        "msg",
        (),
        None,
        extra={"eval_event": "RUN_CREATED", "eval_fields": {"api_key": "sk-secret"}},
    )
    payload = json.loads(JsonLogFormatter().format(record))
    assert payload["api_key"] == "[REDACTED]"


def test_non_sensitive_extra_passes_through() -> None:
    payload = _format(run_id="abc-123")
    assert payload["run_id"] == "abc-123"
