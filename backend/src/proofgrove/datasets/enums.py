"""Enumerations for the Golden Dataset Registry."""

from enum import StrEnum


class DatasetStatus(StrEnum):
    """Readiness state lifecycle for dataset versions.

    Lifecycle transitions:
        DRAFT → VALIDATED → APPROVED → PUBLISHED → DEPRECATED → RETIRED
        REJECTED → DRAFT (fix & re-upload)

    Rules
    -----
    - Only DRAFT is mutable.
    - VALIDATED requires DQS >= 0.85.
    - APPROVED requires human sign-off.
    - PUBLISHED is immutable.
    - REJECTED when DQS < 0.60 (blocker).
    """

    DRAFT = "DRAFT"
    VALIDATED = "VALIDATED"
    APPROVED = "APPROVED"
    PUBLISHED = "PUBLISHED"
    DEPRECATED = "DEPRECATED"
    RETIRED = "RETIRED"
    REJECTED = "REJECTED"



class ChangeReason(StrEnum):
    """Reason a new dataset version was created."""

    CONTENT_UPDATE = "content_update"
    LABEL_UPDATE = "label_update"
    SCHEMA_EVOLUTION = "schema_evolution"
    FEEDBACK_PROMOTION = "feedback_promotion"
    CDL_DEPENDENCY_CHANGE = "cdl_dependency_change"
