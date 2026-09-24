"""Closed-loop finding, review, regression, and evidence contracts."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field

from evalhub.evaluation.enums import GateResult


class FindingStatus(StrEnum):
    OPEN = "open"
    IN_REVIEW = "in_review"
    RESOLVED = "resolved"
    WAIVED = "waived"
    PROMOTED = "promoted"


class Severity(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ReviewOutcome(StrEnum):
    AGREE = "agree"
    DISAGREE = "disagree"
    ABSTAIN = "abstain"


class RegressionKind(StrEnum):
    REGRESSION = "regression"
    HOLDOUT = "holdout"


class RemediationStatus(StrEnum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class Finding(BaseModel):
    finding_id: str = Field(default_factory=lambda: str(uuid4()))
    run_id: str
    experiment_id: str
    row_id: str
    metric_ids: list[str]
    gate_result: GateResult
    severity: Severity
    root_cause_category: str | None = None
    evidence: dict[str, Any] = Field(default_factory=dict)
    status: FindingStatus = FindingStatus.OPEN
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ReviewTask(BaseModel):
    task_id: str = Field(default_factory=lambda: str(uuid4()))
    finding_id: str
    tenant_id: str | None = None
    assigned_to: str | None = None
    status: FindingStatus = FindingStatus.OPEN
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ReviewDecision(BaseModel):
    decision_id: str = Field(default_factory=lambda: str(uuid4()))
    finding_id: str
    task_id: str
    reviewer: str
    outcome: ReviewOutcome
    rationale: str
    score_override: float | None = None
    severity: Severity | None = None
    root_cause_category: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ReviewDecisionRecord(BaseModel):
    """One entry in the ordered, append-only decision history for a finding.

    Decisions are never mutated or deleted; supersession is derived. The most
    recent decision for a finding is the current one, and every earlier
    decision it supersedes is marked ``superseded``.
    """

    decision_id: str
    finding_id: str
    task_id: str
    actor: str
    outcome: ReviewOutcome
    rationale: str
    score_override: float | None = None
    severity: Severity | None = None
    root_cause_category: str | None = None
    timestamp: datetime
    superseded: bool = False
    is_current: bool = False


FINDING_COMMENT_MAX_LENGTH = 4000

# An @token: a word-ish handle, optionally followed by an email-style domain
# (so both ``@alice`` and ``@alice@example.com`` resolve). A bare ``@`` or an
# email address embedded mid-word is not a mention.
_MENTION_PATTERN = re.compile(r"(?<![\w.\-])@([A-Za-z0-9][\w.\-]*(?:@[\w.\-]+)?)")


def parse_mentions(body: str) -> list[str]:
    """Extract unique ``@token`` mentions from a comment body, in order.

    Mentions are recorded alongside the comment so collaborators are queryable;
    there is intentionally no notification delivery.
    """

    seen: set[str] = set()
    mentions: list[str] = []
    for token in _MENTION_PATTERN.findall(body):
        if token not in seen:
            seen.add(token)
            mentions.append(token)
    return mentions


class FindingComment(BaseModel):
    """A collaboration comment on a finding.

    Comments are append-only: there is no edit or delete, so the recorded body
    and author are exactly what was said. ``mentions`` is parsed server-side
    from ``body`` and merely recorded — nothing is delivered.
    """

    comment_id: str = Field(default_factory=lambda: str(uuid4()))
    finding_id: str
    tenant_id: str | None = None
    author: str
    body: str = Field(min_length=1, max_length=FINDING_COMMENT_MAX_LENGTH)
    mentions: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ActivityKind(StrEnum):
    FINDING_CREATED = "finding_created"
    REVIEW_DECISION = "review_decision"
    REMEDIATION_CREATED = "remediation_created"
    REMEDIATION_STATUS_CHANGED = "remediation_status_changed"
    WAIVER_GRANTED = "waiver_granted"
    COMMENT = "comment"


class ActivityEvent(BaseModel):
    """One entry in a finding's derived, read-only activity timeline.

    The timeline is assembled from data that is already persisted (the finding
    row, review decisions, remediations, the audit log, waivers, and comments)
    — there is no separate event table. Consequences to be honest about:
    edits and deletes are not tracked, and remediation status transitions
    appear only when they were performed through the API (they are derived
    from the audit log, which records the acting identity).
    """

    kind: ActivityKind
    actor: str
    timestamp: datetime
    summary: str
    reference_id: str
    details: dict[str, Any] = Field(default_factory=dict)


class Waiver(BaseModel):
    waiver_id: str = Field(default_factory=lambda: str(uuid4()))
    finding_id: str
    approved_by: str
    rationale: str
    expires_at: datetime
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class Remediation(BaseModel):
    """An owned action created from a reviewed evaluation finding."""

    remediation_id: str = Field(default_factory=lambda: str(uuid4()))
    finding_id: str
    owner: str
    description: str
    status: RemediationStatus = RemediationStatus.OPEN
    due_at: datetime | None = None
    created_by: str = "system"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class RegressionCase(BaseModel):
    regression_case_id: str = Field(default_factory=lambda: str(uuid4()))
    tenant_id: str | None = None
    kind: RegressionKind
    status: str = "approved"
    finding_id: str
    source_run_id: str
    source_target_version_id: str | None = None
    record: dict[str, Any]
    provenance: dict[str, Any] = Field(default_factory=dict)
    created_by: str = "system"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class EvidencePack(BaseModel):
    evidence_pack_id: str = Field(default_factory=lambda: str(uuid4()))
    run_id: str
    experiment_id: str
    overall_gate: GateResult | None
    manifest_id: str | None = None
    contents: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
