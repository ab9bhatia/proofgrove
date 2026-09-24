"""Enumerations for the Evaluation Engine."""

from enum import StrEnum


class Scenario(StrEnum):
    """Evaluation scenario category."""

    LLM_CORE = "llm_core"
    RAG = "rag"
    AGENTIC = "agentic"


class GateResult(StrEnum):
    """Release gate decision."""

    PASS = "pass"
    WARN = "warn"
    FAIL = "fail"


class ScoreSubjectKind(StrEnum):
    """What a metric result evaluates."""

    CASE = "case"
    SPAN = "span"


class ScoringType(StrEnum):
    """How a metric score is interpreted."""

    BINARY = "binary"
    SCALE = "scale"
    FLOAT = "float"
    SEVERITY = "severity"
    OPERATIONAL = "operational"


class Adapter(StrEnum):
    """SDK adapter binding."""

    NATIVE = "native"
    AZURE_AI_EVAL = "azure_ai_eval"
    DEEPEVAL = "deepeval"
    RAGAS = "ragas"
    # Pure, reproducible scorers that do not call a judge model.
    DETERMINISTIC = "deterministic"
    # Deterministic scoring from a captured agent tool-call trace (no LLM).
    TRACE = "trace"
    CUSTOM = "custom"
    MOCK = "mock"


class RunStatus(StrEnum):
    """Evaluation run lifecycle."""

    PENDING = "pending"
    RUNNING = "running"
    # Invoke finished; scoring waits for the archived root span to close and
    # the ordered child-span trajectory to be finalized (fits VARCHAR(16)).
    AWAITING_TRACE = "awaiting_trace"
    COMPLETED = "completed"
    # Response-safe metrics completed, while one or more trace-dependent
    # metrics were deliberately left unscored because lifecycle evidence was
    # incomplete at the configured deadline.
    COMPLETED_WITH_PARTIAL_EVIDENCE = "completed_with_partial_evidence"
    BLOCKED = "blocked"
    FAILED = "failed"
    CANCELLED = "cancelled"


class EvaluationScope(StrEnum):
    """Evidence boundary selected for an evaluation run."""

    FINAL_RESPONSE = "final_response"
    TOOL_INTERACTIONS = "tool_interactions"
    FULL_EXECUTION = "full_execution"


class MetricRequirement(StrEnum):
    """Whether a metric participates in governed coverage and gating."""

    REQUIRED = "required"
    OPTIONAL = "optional"


class MetricRequirementSource(StrEnum):
    """Why a metric was resolved as required or optional for a run."""

    QUALITY_CONTRACT = "quality_contract"
    CATALOG_DIAGNOSTIC_DEFAULT = "catalog_diagnostic_default"
    EXPLICIT_SELECTION = "explicit_selection"
    LEGACY_SCENARIO_PRIMARY = "legacy_scenario_primary"
    LEGACY_CROSS_CUTTING = "legacy_cross_cutting"


class MetricApplicability(StrEnum):
    """Whether a selected metric applies to one evaluation case."""

    APPLICABLE = "applicable"
    NOT_APPLICABLE = "not_applicable"


class MetricStatus(StrEnum):
    """Outcome of attempting one applicable metric evaluation."""

    SCORED = "scored"
    UNSCORED = "unscored"
    TECHNICAL_ERROR = "technical_error"


class UnscoredReason(StrEnum):
    """Why an applicable metric has no score."""

    INPUT_MISSING = "input_missing"
    EVIDENCE_UNAVAILABLE = "evidence_unavailable"
    EVALUATOR_ABSTAINED = "evaluator_abstained"
    TELEMETRY_NOT_CAPTURED = "telemetry_not_captured"
    INCOMPLETE_TRACE = "incomplete_trace"
    SIMULATED = "simulated"


class CoverageLabel(StrEnum):
    """Coverage of expected applicable required row-metric pairs."""

    COMPLETE = "complete"
    PARTIAL = "partial"
    INCOMPLETE = "incomplete"


class VerdictStatus(StrEnum):
    """Confidence state of an evaluation decision, separate from workflow."""

    CONCLUSIVE = "conclusive"
    INCONCLUSIVE = "inconclusive"
    BLOCKED = "blocked"


class EvidenceReadiness(StrEnum):
    """Whether a configured source can produce the required evidence."""

    READY = "ready"
    BLOCKED = "blocked"
    UNSUPPORTED = "unsupported"
    UNKNOWN = "unknown"


class EvidenceCaptureStatus(StrEnum):
    """Overall observed completeness of evidence after execution."""

    COMPLETE = "complete"
    PARTIAL = "partial"
    NOT_CAPTURED = "not_captured"
    UNKNOWN = "unknown"


class EvidenceCategoryStatus(StrEnum):
    """Observed completeness for one evidence category."""

    CAPTURED = "captured"
    PARTIAL = "partial"
    NOT_CAPTURED = "not_captured"
    UNKNOWN = "unknown"
    NOT_REQUIRED = "not_required"


class ProvenanceStatus(StrEnum):
    """Trust classification for a provenance assertion."""

    ATTESTED = "attested"
    SELF_REPORTED = "self_reported"
    UNAVAILABLE = "unavailable"
    NOT_APPLICABLE = "not_applicable"


class TargetIdentityStatus(StrEnum):
    """Backend-owned comparison of resolved and observed target identity."""

    MATCHED = "matched"
    MISMATCHED = "mismatched"
    UNVERIFIED = "unverified"
    NOT_APPLICABLE = "not_applicable"


class PreRunApplicability(StrEnum):
    """Applicability knowledge available before target execution."""

    KNOWN_APPLICABLE = "known_applicable"
    POTENTIALLY_APPLICABLE = "potentially_applicable"
    KNOWN_NOT_APPLICABLE = "known_not_applicable"


class TriggerReason(StrEnum):
    """Why an evaluation run was triggered (TDD trigger taxonomy)."""

    MANUAL = "manual"
    CI = "ci"
    DATASET_CHANGE = "dataset_change"
    MODEL_RELEASE = "model_release"
    SCHEDULED = "scheduled"
    REPLAY = "replay"
    BACKFILL = "backfill"


class ExperimentStatus(StrEnum):
    """Experiment lifecycle (governance workspace)."""

    DRAFT = "draft"
    ACTIVE = "active"
    PAUSED = "paused"
    APPROVED = "approved"
    ARCHIVED = "archived"


class RunRole(StrEnum):
    """Role of a run within an experiment."""

    BASELINE = "baseline"
    CHALLENGER = "challenger"
    CHAMPION = "champion"
    RELEASE_EVIDENCE = "release_evidence"
    EXPLORATORY = "exploratory"


class DecisionType(StrEnum):
    """Human release / quality decision for a run."""

    APPROVED = "approved"
    REJECTED = "rejected"
    APPROVED_WITH_EXCEPTION = "approved_with_exception"


class RunType(StrEnum):
    """Why this trial was executed within the experiment."""

    PRE_RELEASE = "pre_release"
    REGRESSION = "regression"
    AD_HOC = "ad_hoc"
    CI = "ci"
    REPLAY = "replay"
