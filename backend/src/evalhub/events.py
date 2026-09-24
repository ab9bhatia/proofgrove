"""Structured lifecycle event logging.

Implements the fixed set of state transitions the TDD requires services to
record (section "State Transitions to Record"). Every transition is emitted as
a single structured log record on the ``evalhub.events`` logger with a stable
``event`` name and a ``correlation_id`` (dataset name or run id) so a full
dataset -> run flow can be traced end to end.

Use :func:`emit` at each transition instead of ad-hoc ``logger.info`` strings.
"""

import logging
from enum import StrEnum
from typing import Any

logger = logging.getLogger("evalhub.events")


class EvalEvent(StrEnum):
    """Canonical lifecycle events (TDD state-transition catalog)."""

    # Inputs plane — dataset registry
    DATASET_REGISTERED = "DATASET_REGISTERED"
    DATASET_VERSION_CREATED = "DATASET_VERSION_CREATED"
    RECORDS_MERGED = "RECORDS_MERGED"
    DATASET_VALIDATED = "DATASET_VALIDATED"
    DATASET_APPROVED = "DATASET_APPROVED"
    DATASET_PUBLISHED = "DATASET_PUBLISHED"
    DATASET_DEPRECATED = "DATASET_DEPRECATED"
    DATASET_RETIRED = "DATASET_RETIRED"
    LABELS_BOUND = "LABELS_BOUND"
    TARGET_REGISTERED = "TARGET_REGISTERED"
    METRIC_REGISTERED = "METRIC_REGISTERED"

    # Configuration plane
    EXPERIMENT_DEFINED = "EXPERIMENT_DEFINED"
    EXPERIMENT_PUBLISHED = "EXPERIMENT_PUBLISHED"

    # Execution plane
    EVALUATION_TRIGGERED = "EVALUATION_TRIGGERED"
    RUN_CREATED = "RUN_CREATED"
    RUN_SHARDED = "RUN_SHARDED"
    TARGET_INVOKED = "TARGET_INVOKED"
    TRACE_LINKED = "TRACE_LINKED"
    FRAMEWORK_EVALUATION_STARTED = "FRAMEWORK_EVALUATION_STARTED"
    FRAMEWORK_EVALUATED = "FRAMEWORK_EVALUATED"
    COMPONENT_EVALUATED = "COMPONENT_EVALUATED"
    SAFETY_EVALUATED = "SAFETY_EVALUATED"
    METRICS_PERSISTED = "METRICS_PERSISTED"
    ARTIFACTS_PERSISTED = "ARTIFACTS_PERSISTED"
    RUN_COMPLETED = "RUN_COMPLETED"
    RUN_FAILED = "RUN_FAILED"

    # Human-in-the-loop plane
    FLAGGED_FOR_REVIEW = "FLAGGED_FOR_REVIEW"
    REVIEW_QUEUED = "REVIEW_QUEUED"
    ANNOTATED = "ANNOTATED"
    FEEDBACK_PROPAGATED = "FEEDBACK_PROPAGATED"
    RE_EVALUATION_TRIGGERED = "RE_EVALUATION_TRIGGERED"


def emit(
    event: EvalEvent,
    *,
    correlation_id: str | None = None,
    **fields: Any,
) -> dict[str, Any]:
    """Emit a structured lifecycle event and return the payload.

    ``fields`` with a ``None`` value are dropped to keep records compact. The
    event name and fields are attached to the log record so a JSON formatter can
    render them as first-class keys (see :mod:`evalhub.logging_config`).
    """
    payload: dict[str, Any] = {k: v for k, v in fields.items() if v is not None}
    if correlation_id is not None:
        payload["correlation_id"] = correlation_id
    logger.info(str(event), extra={"eval_event": str(event), "eval_fields": payload})
    return {"event": str(event), **payload}
