"""Structured (JSON) logging configuration.

Replaces ad-hoc free-text logging with a single JSON formatter so lifecycle
events (see :mod:`proofgrove.events`) and ordinary logs are machine-parseable and
carry their structured fields. Call :func:`configure_logging` once at startup.
"""

import json
import logging
from datetime import UTC, datetime
from typing import Any

from proofgrove.redaction import redact_for_persistence

# Attributes always present on a LogRecord; anything else is treated as an
# explicit structured field and merged into the output.
_RESERVED = set(
    logging.makeLogRecord({}).__dict__.keys()
) | {"message", "asctime", "eval_event", "eval_fields", "taskName"}


class JsonLogFormatter(logging.Formatter):
    """Render each log record as a single JSON object."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "time": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        event = getattr(record, "eval_event", None)
        if event is not None:
            payload["event"] = event
            payload.update(getattr(record, "eval_fields", {}) or {})

        # Collect all fields before redacting, including message and traceback.
        extra = {
            key: value
            for key, value in record.__dict__.items()
            if key not in _RESERVED and key not in payload
        }
        if extra:
            payload.update(extra)

        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)

        return json.dumps(
            redact_for_persistence(payload, force=True),
            default=lambda value: redact_for_persistence(str(value), force=True),
        )


def configure_logging(level: str = "INFO") -> None:
    """Install the JSON formatter on the root logger (idempotent)."""
    handler = logging.StreamHandler()
    handler.setFormatter(JsonLogFormatter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())
