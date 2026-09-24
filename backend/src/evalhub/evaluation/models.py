"""Pydantic models for the Evaluation Engine (TDD section 14)."""

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, computed_field, field_validator, model_validator

from evalhub.evaluation.enums import (
    Adapter,
    CoverageLabel,
    DecisionType,
    EvaluationScope,
    EvidenceCaptureStatus,
    EvidenceCategoryStatus,
    EvidenceReadiness,
    ExperimentStatus,
    GateResult,
    MetricApplicability,
    MetricRequirement,
    MetricRequirementSource,
    MetricStatus,
    PreRunApplicability,
    ProvenanceStatus,
    RunRole,
    RunStatus,
    RunType,
    Scenario,
    ScoreSubjectKind,
    ScoringType,
    TargetIdentityStatus,
    TriggerReason,
    UnscoredReason,
    VerdictStatus,
)
from evalhub.evaluation.telemetry_compat import operation_type
from evalhub.version import PROMPT_VERSION


class MetricDefinition(BaseModel):
    """Logical metric contract."""

    metric_id: str
    name: str
    description: str
    scenario: Scenario | None = None
    scoring_type: ScoringType
    score_range: tuple[float, float] | None = None
    normalisation_formula: str | None = None
    requires_ground_truth: bool = False
    requires_trace: bool = False
    required_evidence_categories: list[str] = Field(default_factory=list)
    default_adapter: Adapter = Adapter.MOCK
    adapter_class: str = "MockJudge"
    execution_mode: Literal["inline", "batch"] = "inline"
    available_in_run: bool = True
    # Explicit compatibility for evaluating a span's own input/output. An empty
    # list means the metric has only a case-level contract.
    span_kinds: list[str] = Field(default_factory=list)
    availability_note: str | None = None
    kpi_ids: list[str] = Field(default_factory=list)
    # Catalog-owned diagnostics remain optional when a user selects them. An
    # approved Quality Contract may elevate them only with a valid gate
    # composition.
    catalog_diagnostic_default: bool = False
    criteria: str | None = None
    evaluation_steps: list[str] = Field(default_factory=list)
    evaluation_params: list[str] = Field(default_factory=list)
    # What each point of a SCALE metric's range means, keyed by score. A Likert
    # rubric that names no band leaves the judge without a shared idea of what
    # separates a 3 from a 4, and it collapses the scale instead of dividing it.
    # Both scoring frameworks we run take anchors natively (DeepEval `Rubric`,
    # RAGAS `score{n}_description`), so one declaration serves either adapter.
    score_anchors: dict[int, str] = Field(default_factory=dict)
    default_threshold_pass: float = 0.8
    default_threshold_warn: float = 0.6


class KpiDefinition(BaseModel):
    """KPI composite definition."""

    kpi_id: str
    name: str
    description: str
    primary_scenario: Scenario | None = None
    constituent_metrics: dict[str, float]
    threshold_pass: float
    threshold_warn: float
    zero_tolerance: bool = False


class EvaluatorConfig(BaseModel):
    """Configuration for a single evaluator instance (TDD 14.1)."""

    metric_id: str
    version: str = "1.0"
    instance_id: str
    adapter: Adapter
    adapter_class: str
    adapter_config: dict[str, Any] = Field(default_factory=dict)
    judge_model: str | None = None
    judge_temperature: float = 0.0
    judge_max_tokens: int = 800
    scoring_type: ScoringType
    score_range: tuple[float, float] | None = None
    normalisation_formula: str | None = None
    prompt_version: str = PROMPT_VERSION
    threshold_pass: float = 0.8
    threshold_warn: float = 0.6
    threshold_fail: float = 0.6
    required_inputs: list[str] = Field(default_factory=list)
    requires_ground_truth: bool = False
    requires_trace: bool = False
    required_evidence_categories: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    created_by: str = "system"
    tags: dict[str, str] = Field(default_factory=dict)
    evaluator_id: str | None = None
    evaluator_version: str | None = None
    execution_mode: str | None = None
    execution_policy: dict[str, Any] = Field(default_factory=dict)


class ExperimentDefinition(BaseModel):
    """Experiment: evaluation study (contract + governance metadata).

    Contract fields (dataset/target/judge) still drive a single run. Governance
    fields (objective, status, owner, tags, …) support the experiment workspace.
    """

    experiment_id: str | None = None
    name: str
    dataset_version: str
    target_endpoint: str
    # Empty string is the pre-run workspace sentinel (no basis stamped yet).
    scenario: Scenario | Literal[""]
    domain: str | None = None
    market: str = "global"
    judge_model: str = "gpt-4o"
    judge_temperature: float = 0.0
    has_ground_truth: bool = True
    row_count: int | None = None
    safety_defect_tolerance: float = 0.02
    kpi_threshold_overrides: dict[str, dict[str, float]] = Field(default_factory=dict)
    created_by: str = "system"
    # Governance / tracking (optional; defaults keep existing callers working).
    description: str | None = None
    objective: str | None = None
    hypothesis: str | None = None
    tenant_id: str | None = None
    product_id: str | None = None
    owner: str | None = None
    status: ExperimentStatus = ExperimentStatus.ACTIVE
    tags: dict[str, str] = Field(default_factory=dict)
    quality_profile_id: str | None = None
    quality_profile_version: str | None = None
    benchmark_package_id: str | None = None
    benchmark_package_version: str | None = None
    target_id: str | None = None
    target_version: str | None = None
    environment: str | None = None
    # Versioned quality-contract control-plane references. These remain
    # optional while existing scenario-based experiments migrate.
    project_id: str | None = None
    target_version_id: str | None = None
    gate_policy_id: str | None = None
    gate_policy_version: str | None = None
    run_manifest_id: str | None = None
    # ``None`` is intentional for historical runs whose scope was not recorded.
    evaluation_scope: EvaluationScope | None = None
    requested_evaluation_scope: EvaluationScope | None = None
    # Selected-tools evaluation level: when the run's scope is
    # ``tool_interactions``, an explicit subset of the agent's declared tools to
    # evaluate. ``None`` means the whole tool layer (no named-tool scoping).
    selected_tool_ids: list[str] | None = None
    requested_target_provenance: dict[str, Any] = Field(default_factory=dict)
    resolved_target_provenance: dict[str, Any] = Field(default_factory=dict)
    observed_target_provenance: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None

    @field_validator("safety_defect_tolerance")
    @classmethod
    def _validate_tolerance(cls, v: float) -> float:
        if not 0.0 <= v <= 1.0:
            raise ValueError("safety_defect_tolerance must be between 0 and 1")
        return v

    @field_validator("kpi_threshold_overrides")
    @classmethod
    def _validate_overrides(cls, v: dict[str, dict[str, float]]) -> dict[str, dict[str, float]]:
        for kpi_id, thresholds in v.items():
            for key, value in thresholds.items():
                if not 0.0 <= value <= 1.0:
                    raise ValueError(f"threshold override {kpi_id}.{key} must be between 0 and 1")
            t_pass = thresholds.get("pass")
            t_warn = thresholds.get("warn")
            if t_pass is not None and t_warn is not None and t_warn > t_pass:
                raise ValueError(f"threshold override {kpi_id}: warn ({t_warn}) must be <= pass ({t_pass})")
        return v


class ToolCall(BaseModel):
    """A single tool/function call an agent made during a run.

    Captured from archived OTEL spans when the trace archive is enabled
    (Phoenix / Confident AI style), otherwise from kagent session events or
    A2A metadata. Agent-agnostic: ``name`` is whatever tool the agent
    invoked — no tool name is hardcoded. Used by the agentic groundedness metrics
    (was the expected tool actually called?) and to feed retrieved tool outputs
    into ``EvaluationRow.context`` for faithfulness scoring.
    """

    name: str
    args: dict[str, Any] = Field(default_factory=dict)
    # Preserve the exact JSON-compatible response for governed evidence. The
    # run service derives text separately when a scorer needs context.
    output: Any | None = None
    # Distinguishes a captured JSON null response from a call whose result was
    # never captured. ``None`` preserves compatibility with historical rows;
    # those infer capture from whether an output value exists.
    result_captured: bool | None = None

    @model_validator(mode="after")
    def infer_result_capture_from_value(self) -> "ToolCall":
        """Mark legacy non-null outputs captured without guessing about nulls."""

        if self.result_captured is None and self.output is not None:
            self.result_captured = True
        return self


class ToolResultArtifact(BaseModel):
    """Full content externalized from an oversized inline tool result."""

    artifact_id: str
    artifact_ref: str
    tool_name: str
    tool_call_index: int
    content_type: Literal["application/json", "text/plain"]
    content: str
    size_bytes: int
    preview: str
    preview_bytes: int


class ToolResultArtifactReference(BaseModel):
    """Inspectable artifact metadata returned with run-item evidence."""

    artifact_id: str
    artifact_ref: str
    tool_name: str
    tool_call_index: int
    content_type: str
    size_bytes: int
    preview: str
    preview_bytes: int


class ToolResultArtifactPage(BaseModel):
    """Bounded page of a large tool-result artifact."""

    artifact: ToolResultArtifactReference
    offset: int
    limit: int
    content: str
    next_offset: int | None = None
    complete: bool


class EvaluationRow(BaseModel):
    """Single row in an evaluation dataset."""

    row_id: str = Field(min_length=1, max_length=128)
    query: str
    response: str
    expected_response: str | None = None
    context: list[str] = Field(default_factory=list)
    trace_id: str | None = None
    # Tool names the golden row expects the agent to call (parsed from the
    # record's expected_actions). Dataset-driven — the groundedness scorer checks
    # the captured trace against these; no tool name is hardcoded.
    expected_tools: list[str] = Field(default_factory=list)
    # Structured tool-call trace used for scoring. When the trace archive is
    # enabled this is hydrated from OpenInference / GenAI spans; otherwise it
    # comes from a live agent run (empty for judge-only / baseline / provided
    # rows). Drives dataset-driven groundedness.
    tool_calls: list[ToolCall] = Field(default_factory=list)
    # Kept outside evaluator-facing trace payloads until immutable run evidence
    # is persisted.
    tool_result_artifacts: list[ToolResultArtifact] = Field(default_factory=list)
    # True when the target is a live agent but no tool-call trace could be
    # captured (archive miss, or a BYO agent that does not emit session events
    # when the archive is off); groundedness is flagged rather than silently
    # passed.
    trace_unavailable: bool = False
    # Spans the archive returned for this case, so post-run classification can
    # report `trace` from what landed rather than declaring it unknown. This is
    # the relevant-span count the scoring read requested, not the whole trace.
    trace_span_count: int | None = None
    # The archive reader completed pagination, observed the explicit
    # execution-complete marker, and allowed its snapshot to settle. This is
    # deliberately separate from ``trace_span_count``: spans arriving proves
    # presence, while this flag proves the captured trajectory is closed.
    trace_completion_attested: bool = False
    # The invocation is the canonical owner of aggregate model usage. A closed
    # trace freezes that report so it can be treated as complete for this
    # invocation without attempting to sum duplicated nested LLM spans.
    model_usage_completion_attested: bool = False
    # Full-execution lifecycle completion is represented by the trusted root
    # span's explicit ``evalai.execution.complete`` marker.
    lifecycle_completion_attested: bool = False
    # A successful session lookup is not a completion attestation. This is true
    # when a trusted completion source proves the captured tool event set is
    # complete, including the legitimate zero-event case: either a session
    # completion manifest, or a fully landed OTEL archive object.
    tool_evidence_completion_attested: bool = False
    tool_evidence_provenance_status: ProvenanceStatus = ProvenanceStatus.UNAVAILABLE
    tool_evidence_source: str | None = None
    # True when this row's response came from invoking a live agent
    # (response_source="agent"). Gates trace-based groundedness scoring: judge-only
    # / baseline / provided rows keep the LLM-judge path for agent metrics.
    from_agent: bool = False
    tags: dict[str, str] = Field(default_factory=dict)

    # Structured evidence carried from the source record into the immutable
    # per-run item snapshot. Normalized query/response fields above remain the
    # scoring contract; these preserve the original record shape for review.
    input_data: dict[str, Any] | None = None
    output_data: dict[str, Any] | None = None
    expected_data: dict[str, Any] | None = None
    retrieval_snippets: list[str] | None = None
    span_id: str | None = None
    parent_span_id: str | None = None
    trace_provider: str | None = None

    # Target-execution evidence. ``invocation_id`` is generated for each A2A
    # request and must never be confused with the kagent session/context id or
    # an observability trace id.
    invocation_id: str | None = None
    kagent_session_id: str | None = None
    latency_ms: float | None = None
    target_usage: dict[str, Any] | None = None
    invocation_error: str | None = None

    @field_validator("row_id")
    @classmethod
    def row_id_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("row_id must not be blank")
        return value


class MetricResult(BaseModel):
    """Result of a single metric evaluation for one row (TDD 14.2)."""

    metric_id: str
    evaluator_instance_id: str
    run_id: str
    row_id: str
    metric_requirement: MetricRequirement = MetricRequirement.REQUIRED
    metric_requirement_source: MetricRequirementSource | None = None
    metric_applicability: MetricApplicability = MetricApplicability.APPLICABLE
    metric_status: MetricStatus | None = MetricStatus.SCORED
    unscored_reason: UnscoredReason | None = None
    error_details: dict[str, Any] | None = None
    score: float | None
    normalised_score: float | None
    label: str | None = None
    passed: bool | None
    rationale: str | None = None
    error_message: str | None = None
    threshold: float
    threshold_result: GateResult | None
    prompt_version: str = PROMPT_VERSION
    judge_prompt_tokens: int | None = None
    judge_completion_tokens: int | None = None
    judge_total_tokens: int | None = None
    judge_model: str | None = None
    subject_kind: ScoreSubjectKind | None = ScoreSubjectKind.CASE
    # ``trace_id`` / ``span_id`` are retained as compatibility aliases for the
    # evaluated target for span/legacy scores. Case scores keep their execution
    # evidence link in target_span_id without acquiring a span subject.
    trace_id: str | None = None
    span_id: str | None = None
    target_trace_id: str | None = None
    target_span_id: str | None = None
    evaluator_trace_id: str | None = None
    evaluator_span_id: str | None = None
    feedback_scope: Literal["span", "trace"] = "span"
    annotator_kind: Literal["LLM", "CODE", "HUMAN"] | None = None
    evaluation_identifier: str | None = None
    dataset_version: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    sample_input: dict[str, Any] | None = None
    sample_output: dict[str, Any] | None = None
    evaluator_id: str | None = None
    evaluator_version: str | None = None
    execution_status: str = "success"
    execution_metadata: dict[str, Any] = Field(default_factory=dict)
    requested_scorer: str | None = None
    executed_scorer: str | None = None

    @model_validator(mode="after")
    def validate_result_state(self) -> "MetricResult":
        if self.target_trace_id is None:
            self.target_trace_id = self.trace_id
        if self.target_span_id is None:
            self.target_span_id = self.span_id
        if self.trace_id is None:
            self.trace_id = self.target_trace_id
        if self.span_id is None and self.subject_kind != ScoreSubjectKind.CASE:
            self.span_id = self.target_span_id
        if self.subject_kind == ScoreSubjectKind.CASE and self.span_id is not None:
            raise ValueError("case results require null span_id")
        if self.subject_kind == ScoreSubjectKind.SPAN:
            if not self.trace_id or not self.trace_id.strip() or not self.span_id or not self.span_id.strip():
                raise ValueError("span results require non-blank trace_id and span_id")
        scored_fields = (
            self.score,
            self.normalised_score,
            self.passed,
            self.threshold_result,
        )
        if self.metric_applicability == MetricApplicability.NOT_APPLICABLE:
            if self.metric_status is not None or self.unscored_reason is not None:
                raise ValueError("not-applicable metrics cannot have status or unscored reason")
            if any(value is not None for value in scored_fields):
                raise ValueError("not-applicable metrics cannot have score or threshold results")
            return self

        if self.metric_status is None:
            raise ValueError("applicable metrics require metric_status")
        if self.metric_status == MetricStatus.SCORED:
            if self.score is None:
                raise ValueError("scored metrics require a score")
            # A result either carries a verdict or it carries none. Operational
            # metrics are measurements — a latency has no declared budget to
            # grade against — so they record the captured value and leave the
            # graded fields empty rather than inventing a normalised score and a
            # gate. A half-populated verdict is the state to refuse.
            graded = (self.normalised_score, self.passed, self.threshold_result)
            if any(value is None for value in graded) and any(
                value is not None for value in graded
            ):
                raise ValueError(
                    "a scored metric must carry a complete verdict "
                    "(normalised score, pass, threshold result) or none at all"
                )
            if self.unscored_reason is not None:
                raise ValueError("scored metrics cannot have an unscored reason")
        else:
            if any(value is not None for value in scored_fields):
                raise ValueError("unscored and technical-error metrics cannot have score or threshold results")
            if self.metric_status == MetricStatus.UNSCORED and self.unscored_reason is None:
                raise ValueError("unscored metrics require an unscored reason")
            if self.metric_status == MetricStatus.TECHNICAL_ERROR and not self.error_details:
                raise ValueError("technical-error metrics require structured error details")
        return self


class RunItemSummary(BaseModel):
    """Compact, ordered summary of one evaluated example in a run."""

    run_id: str
    example_id: str
    query: str | None = None
    sequence_position: int
    dataset_version: str | None = None
    worst_gate: GateResult | None = None
    metric_count: int
    failing_count: int
    #: Failing metrics that were not required. They do not decide the verdict —
    #: a diagnostic scoring badly is information, not a failure of the case —
    #: but the reader is still told they exist.
    failing_optional_count: int = 0
    error_count: int = 0
    scored_count: int = 0
    unscored_count: int = 0
    #: Unscored metrics that were REQUIRED. A case is only "partially scored"
    #: when something it had to answer for went unmeasured; optional coverage
    #: gaps are reported, not treated as an unanswered case.
    unscored_required_count: int = 0
    not_applicable_count: int = 0
    evaluation_state: Literal["evaluated", "technical_error", "not_evaluated", "output_too_large"]
    latency_ms: int | None = None
    trace_available: bool = False
    evidence_ref: str
    capture_state: Literal["complete", "partial", "unknown"]
    error_type: str | None = None
    artifact_count: int = 0


class RunItemExecution(BaseModel):
    """Target-execution references kept distinct from scorer execution."""

    invocation_id: str | None = None
    kagent_session_id: str | None = None
    latency_ms: int | None = None
    usage: dict[str, Any] | None = None
    invocation_error: str | None = None
    trace_id: str | None = None
    span_id: str | None = None
    parent_span_id: str | None = None
    trace_provider: str | None = None
    trace_completion_attested: bool = False
    model_usage_completion_attested: bool = False
    lifecycle_completion_attested: bool = False
    tool_evidence_completion_attested: bool = False
    tool_evidence_provenance_status: ProvenanceStatus = ProvenanceStatus.UNAVAILABLE
    tool_evidence_source: str | None = None


class EvidencePolicy(BaseModel):
    """Governance policy recorded when a run-item snapshot is persisted."""

    redaction_enabled: bool | None
    max_persisted_string_size: int | None
    retention_policy: Literal["stored_with_run_lifecycle"] = "stored_with_run_lifecycle"


class RunItemDetail(BaseModel):
    """Master-detail evidence payload for one evaluated example."""

    run_id: str
    example_id: str
    sequence_position: int
    dataset_version: str | None = None
    input: dict[str, Any] | None = None
    output: dict[str, Any] | None = None
    expected: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    retrieval_snippets: list[str] | None = None
    expected_tools: list[str] | None = None
    tool_calls: list[ToolCall] | None = None
    tool_result_artifacts: list[ToolResultArtifactReference] = Field(default_factory=list)
    execution: RunItemExecution
    scorer_results: list[MetricResult] = Field(default_factory=list)
    evidence_ref: str
    evidence_policy: EvidencePolicy
    capture_state: Literal["complete", "partial", "unknown"]


class CaseReplay(BaseModel):
    """One recorded re-invocation of an evaluated case with a different prompt.

    Isolated evidence (#3317): a replay never joins case-facing results —
    reports, exports, comparisons and reviews must not read it.
    """

    replay_id: str
    tenant_id: str
    run_id: str
    example_id: str
    prompt_version_ref: str | None = None
    prompt_hash: str | None = None
    system_prompt: str | None = None
    target_model: str
    target_endpoint: str | None = None
    response: str | None = None
    latency_ms: int | None = None
    target_usage: dict[str, Any] | None = None
    invocation_error: str | None = None
    invocation_id: str | None = None
    trace_id: str | None = None
    span_id: str | None = None
    created_at: datetime
    created_by: str
    estimated_cost_usd: float | None = None


class ArchivedTraceSpan(BaseModel):
    """Bounded, post-redaction OTLP span evidence shown for one evaluation item."""

    trace_id: str
    span_id: str
    telemetry_backend: str | None = None
    retrieved_at: datetime | None = None
    parent_span_id: str | None = None
    name: str
    kind: int | None = None
    start_time_unix_nano: str | None = None
    end_time_unix_nano: str | None = None
    duration_ms: float | None = None
    status: dict[str, Any] | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)
    resource_attributes: dict[str, Any] = Field(default_factory=dict)
    events: list[dict[str, Any]] = Field(default_factory=list)


    @computed_field
    @property
    def semantic_kind(self) -> str | None:
        return operation_type(self.attributes)[0]

    @computed_field
    @property
    def semantic_kind_source(self) -> str | None:
        return operation_type(self.attributes)[1]


class RunItemTraceEvidence(BaseModel):
    """On-demand trace lookup result from the tenant archive partition."""

    state: Literal["available", "pending", "not_found", "not_configured"]
    trace_id: str | None = None
    spans: list[ArchivedTraceSpan] = Field(default_factory=list)
    object_refs: list[str] = Field(default_factory=list)
    pagination_complete: bool = False
    lifecycle_complete: bool = False
    evidence_complete: bool = False
    truncated: bool = False
    completion_diagnostic: Literal[
        "root_span_missing", "completion_marker_missing", "archive_not_settled"
    ] | None = None
    message: str | None = None


class ConstituentScore(BaseModel):
    """Per-metric breakdown within a KPI."""

    metric_id: str
    weight: float
    raw_score: float
    normalised_score: float
    sample_size: int


class KpiResult(BaseModel):
    """Composite KPI outcome for an evaluation run (TDD 14.3)."""

    kpi_id: str
    run_id: str
    composite_score: float | None
    gate_result: GateResult | None
    observed_score: float | None = None
    constituent_scores: list[ConstituentScore]
    threshold_pass: float
    threshold_warn: float
    threshold_fail: float
    dataset_version: str
    experiment_id: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    evaluated_target: str
    prompt_version: str | None = None
    required_applicable_pair_count: int = 0
    required_scored_count: int = 0
    required_unscored_count: int = 0
    required_technical_error_count: int = 0
    required_coverage_percentage: float | None = None
    coverage_label: CoverageLabel | None = None
    optional_applicable_pair_count: int = 0
    optional_scored_count: int = 0
    optional_coverage_percentage: float | None = None


class RootCauseDiagnosis(BaseModel):
    """Root-cause analysis for a failing evaluation."""

    root_cause_metric_id: str | None = None
    root_cause_label: str | None = None
    causal_chain: list[str] = Field(default_factory=list)
    failing_metrics: list[str] = Field(default_factory=list)
    recommended_remediation: str | None = None
    has_ground_truth: bool = True


class FailingMetricDetail(BaseModel):
    """What a metric scored, and what it needed to score.

    A finding used to carry metric ids alone, so a reviewer was told which checks
    failed and never by how much — the one number that separates "barely missed"
    from "nowhere near" and decides whether the finding is worth acting on.
    """

    metric_id: str
    score: float | None = None
    normalised_score: float | None = None
    threshold: float | None = None
    threshold_result: GateResult | None = None


class ReviewQueueItem(BaseModel):
    """Row flagged for human review."""

    row_id: str
    query: str
    response: str
    trace_id: str | None = None
    failing_metrics: list[str] = Field(default_factory=list)
    failing_metric_details: list[FailingMetricDetail] = Field(default_factory=list)
    gate_result: GateResult
    rationale: str | None = None


class RunLineage(BaseModel):
    """Reproducibility snapshot for an evaluation run.

    Captures everything needed to interpret and replay a run: the service and
    prompt versions, the deterministic experiment fingerprint, the judge
    configuration, and the installed scoring-framework versions.
    """

    service_version: str
    prompt_version: str = PROMPT_VERSION
    experiment_version_id: str
    comparison_basis_hash: str | None = None
    # Version of the comparison-basis algorithm that produced the hash above.
    # Historical (v1) runs deserialize as ``None``; runs are comparable only
    # when both hash and version match.
    comparison_basis_version: str | None = None
    source_run_id: str | None = None
    source_evidence_snapshot: str | None = None
    rescore_configuration: dict[str, Any] | None = None
    judge_mode: str
    judge_provider: str
    judge_model: str
    judge_temperature: float
    judge_max_tokens: int
    use_frameworks: bool
    framework_versions: dict[str, str | None] = Field(default_factory=dict)
    evaluation_scope: EvaluationScope | None = None
    requested_evaluation_scope: EvaluationScope | None = None
    resolved_evaluation_scope: EvaluationScope | None = None
    scope_promotion_reasons: list[dict[str, str]] = Field(default_factory=list)
    # Named tools this tool_interactions run was scoped to. ``None`` (also for
    # every historical run) means the whole tool layer was evaluated. Rides the
    # lineage JSON, like ``comparison_basis_version``, and feeds the v2
    # comparison basis: runs with different selections are not comparable.
    selected_tool_ids: list[str] | None = None
    # The agent's declared tool catalogue as it stood when the run launched, so
    # a later reader of a failed tool metric can tell whether a tool was never
    # offered to the agent or was offered and not called. ``None`` means it was
    # not captured (every historical run, and BYO agents that declare nothing).
    #
    # Lineage-only on purpose. It is descriptive, not part of the contract: it
    # never scopes scoring, is excluded from the comparison basis (two runs
    # differing only in the agent's catalogue stay comparable), and is kept off
    # ``ExperimentDefinition`` because every field there joins
    # ``EXPERIMENT_CONTRACT_FIELDS`` and is stamped as the immutable contract —
    # where an agent gaining a tool would read as a contract change.
    agent_tools_snapshot: list[str] | None = None
    run_manifest_id: str | None = None
    run_manifest_hash: str | None = None
    assignment_id: str | None = None
    assignment_version: str | None = None
    run_configuration_id: str | None = None
    run_configuration_hash: str | None = None
    metric_requirements: list[dict[str, Any]] = Field(default_factory=list)
    kpi_compositions: list[dict[str, Any]] = Field(default_factory=list)
    metric_evidence_requirements: dict[str, list[str]] = Field(default_factory=dict)
    effective_evidence_requirements: list[str] = Field(default_factory=list)
    # Gate outcomes the resolved policy flags for human review. Empty for
    # ungoverned runs (and every historical run), which fall back to the
    # policy default when a report asks whether review is required.
    review_trigger_gates: list[GateResult] = Field(default_factory=list)
    project_id: str | None = None
    target_version_id: str | None = None
    quality_profile_id: str | None = None
    quality_profile_version: str | None = None
    gate_policy_id: str | None = None
    gate_policy_version: str | None = None
    benchmark_package_id: str | None = None
    benchmark_package_version: str | None = None
    model_version: str | None = None
    target_prompt_version: str | None = None
    #: SHA-256 of the system prompt this run was invoked with, when one was
    #: supplied. A digest, not the prompt: enough to tell two runs apart or
    #: prove two shared a prompt, without Eval Hub storing prompt text.
    target_prompt_hash: str | None = None
    #: `prompt-id@version` when the run used a saved prompt. Always the concrete
    #: version, never the label that selected it.
    target_prompt_ref: str | None = None
    tool_versions: dict[str, str] = Field(default_factory=dict)
    requested_target_provenance: dict[str, Any] = Field(default_factory=dict)
    resolved_target_provenance: dict[str, Any] = Field(default_factory=dict)
    observed_target_provenance: dict[str, Any] = Field(default_factory=dict)
    exact_runtime_identity_required: bool = False
    target_identity_status: TargetIdentityStatus | None = None
    captured_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ReadinessDetail(BaseModel):
    """One structured capability or prerequisite result."""

    code: str
    message: str
    evidence_category: str | None = None


class MetricPreRunApplicability(BaseModel):
    """Pre-run applicability classification for a selected metric."""

    metric_id: str
    applicability: PreRunApplicability
    reason: str | None = None


class EvidenceReadinessResult(BaseModel):
    """Backend-owned answer to whether a run may be created or invoked."""

    status: EvidenceReadiness
    evaluation_scope: EvaluationScope
    requested_evaluation_scope: EvaluationScope
    resolved_evaluation_scope: EvaluationScope
    scope_promotion_reasons: list[dict[str, str]] = Field(default_factory=list)
    # Consequences of the depth this run actually resolved to, stated whether the
    # caller chose that depth or was promoted into it. The per-depth caveat on
    # the options list is only seen by someone who selected that option; a
    # promotion silently moved the run somewhere the caller never looked.
    effective_evidence_requirements: list[str] = Field(default_factory=list)
    metric_evidence_requirements: dict[str, list[str]] = Field(default_factory=dict)
    metric_requirements: list[dict[str, Any]] = Field(default_factory=list)
    metric_applicability: list[MetricPreRunApplicability] = Field(default_factory=list)
    details: list[ReadinessDetail] = Field(default_factory=list)
    requested_provenance: dict[str, Any] = Field(default_factory=dict)
    resolved_provenance: dict[str, Any] = Field(default_factory=dict)
    # Declared tool inventory of the resolved agent target (``None`` until an
    # agent is resolved, or when the target's tools cannot be known — e.g. BYO).
    # Lets the UI render an honest named-tool picker.
    agent_tools: list[str] | None = None
    # The caller's requested named-tool selection, echoed (and validated against
    # ``agent_tools``) so it rides the persisted readiness snapshot into the
    # worker. ``None`` means the whole tool layer.
    selected_tool_ids: list[str] | None = None

    @model_validator(mode="before")
    @classmethod
    def preserve_legacy_scope_construction(cls, values: Any) -> Any:
        """Accept the former single-scope shape while always emitting both axes."""

        if not isinstance(values, dict):
            return values
        scope = values.get("evaluation_scope")
        if scope is not None:
            values.setdefault("requested_evaluation_scope", scope)
            values.setdefault("resolved_evaluation_scope", scope)
        return values


class EvidenceCategorySummary(BaseModel):
    """Observed post-run completeness for one evidence category."""

    category: str
    required: bool
    status: EvidenceCategoryStatus
    record_count: int = 0
    completeness_attested: bool = False
    provenance_status: ProvenanceStatus
    provenance_source: str | None = None
    diagnostic: str | None = None


class RunResult(BaseModel):
    """Complete evaluation run result."""

    run_id: str
    experiment: ExperimentDefinition
    status: RunStatus
    # Traceability / lineage (TDD run schema: trigger_reason, experiment
    # version, correlation id, retry count).
    trigger_reason: TriggerReason = TriggerReason.MANUAL
    correlation_id: str | None = None
    retry_count: int = 0
    experiment_version_id: str | None = None
    prompt_version: str = PROMPT_VERSION
    lineage: RunLineage | None = None
    metric_results: list[MetricResult] = Field(default_factory=list)
    kpi_results: list[KpiResult] = Field(default_factory=list)
    verdict_status: VerdictStatus | None = None
    overall_gate: GateResult | None = None
    diagnostic_only: bool = False
    evidence_readiness: EvidenceReadinessResult | None = None
    evidence_capture_status: EvidenceCaptureStatus = EvidenceCaptureStatus.UNKNOWN
    evidence_categories: list[EvidenceCategorySummary] = Field(default_factory=list)
    root_cause: RootCauseDiagnosis | None = None
    review_queue: list[ReviewQueueItem] = Field(default_factory=list)
    started_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    completed_at: datetime | None = None
    active_metrics: list[str] = Field(default_factory=list)
    evaluator_configs: list[EvaluatorConfig] = Field(default_factory=list)
    # Experiment-tracking fields
    run_number: int | None = None
    run_type: RunType = RunType.AD_HOC
    created_by: str = "system"
    git_sha: str | None = None
    build_id: str | None = None
    deployment_id: str | None = None
    duration_ms: int | None = None
    artifact_refs: list[str] = Field(default_factory=list)
    role: RunRole | None = None
    run_manifest_id: str | None = None
    # Governed-run lineage surfaced on the response. A run is *governed* only
    # when an approved quality profile / gate policy resolves it — the presence
    # of ``run_manifest_id`` alone does not make a run governed. These stay
    # ``None`` for ungoverned runs.
    quality_profile_id: str | None = None
    quality_profile_version: str | None = None
    gate_policy_id: str | None = None
    gate_policy_version: str | None = None
    # Optional user annotations from Agent / RAG / LLM Evaluation.
    label: str | None = None
    labels: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _surface_governance_from_lineage(self) -> "RunResult":
        """Backfill governance ids from the run lineage when not set directly.

        The engine records the resolved quality profile / gate policy on the
        run's ``lineage``; mirroring them onto the run response lets callers
        determine governance without unpacking the lineage snapshot.
        """

        if self.lineage is None:
            return self
        for field in (
            "quality_profile_id",
            "quality_profile_version",
            "gate_policy_id",
            "gate_policy_version",
        ):
            if getattr(self, field) is None:
                setattr(self, field, getattr(self.lineage, field, None))
        return self


def scenario_value(experiment: ExperimentDefinition) -> str | None:
    """The experiment's scenario as a plain string, or ``None`` when unstamped.

    ``scenario`` carries the empty-string sentinel while a pre-run workspace has
    no comparison basis yet, so ``.value`` is not always available. Callers that
    need a serialisable scenario go through here instead of crashing on the
    sentinel.
    """

    scenario = experiment.scenario
    if isinstance(scenario, Scenario):
        return scenario.value
    return scenario or None


ComparisonBasis = tuple[str, str, str | None]


def recorded_comparison_basis(run: RunResult) -> ComparisonBasis | None:
    """The one rule for "were these runs produced against the same basis?".

    Two runs share a basis when this returns an equal, non-``None`` value for
    both. A recorded ``comparison_basis_hash`` only counts together with the
    ``comparison_basis_version`` that produced it, so a v1 run (version
    ``None``) never matches a v2 run that happens to share its hash. When
    neither run recorded a hash the only fallback is exact repetition of the
    same ``experiment_version_id``; a wider basis is never inferred.

    Every attach and compare path must call this. A second, laxer copy lets
    incompatible runs into a workspace that ``compare_runs`` then refuses,
    leaving the workspace permanently dead-ended.
    """

    lineage = run.lineage
    if lineage is not None and lineage.comparison_basis_hash:
        return (
            "comparison_basis",
            lineage.comparison_basis_hash,
            lineage.comparison_basis_version,
        )
    if run.experiment_version_id:
        return ("historical_exact_version", run.experiment_version_id, None)
    return None


class PaginatedRuns(BaseModel):
    """Server-paginated run-history envelope.

    ``items`` are ``RunResult`` payloads for a single page; ``total`` is the full
    (unpaged) match count and ``next_cursor`` is the opaque offset of the next
    page (``None`` when the last page has been returned).
    """

    items: list[dict[str, Any]] = Field(default_factory=list)
    total: int = 0
    limit: int = 50
    offset: int = 0
    next_cursor: str | None = None


class ExperimentVersion(BaseModel):
    """Immutable evaluation-contract snapshot for an experiment."""

    experiment_version_id: str
    experiment_id: str
    contract_json: dict[str, Any] = Field(default_factory=dict)
    contract_hash: str
    created_by: str = "system"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ExperimentRunLink(BaseModel):
    """Links a run to an experiment with an ordinal and role."""

    experiment_id: str
    run_id: str
    run_number: int
    role: RunRole = RunRole.EXPLORATORY
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class BaselineChange(BaseModel):
    """Audit record for a single baseline promotion or undo.

    Captures who changed the experiment's baseline, when, and which run was the
    baseline before and after the change. ``action`` distinguishes an ordinary
    ``promote`` from an ``undo`` (which re-promotes the previous baseline).
    """

    baseline_change_id: str
    experiment_id: str
    tenant_id: str | None = None
    actor: str = "system"
    action: str = "promote"
    previous_baseline_run_id: str | None = None
    new_baseline_run_id: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ExperimentDecision(BaseModel):
    """Human approval / rejection / exception for a run."""

    decision_id: str | None = None
    experiment_id: str
    run_id: str
    decision: DecisionType
    reason: str | None = None
    approved_by: str
    expires_at: datetime | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ExperimentSummary(BaseModel):
    """Roll-up for the experiment workspace list/detail header."""

    experiment: ExperimentDefinition
    run_count: int = 0
    latest_run_id: str | None = None
    latest_score: float | None = None
    latest_gate: GateResult | None = None
    latest_completed_at: datetime | None = None
    baseline_run_id: str | None = None
    champion_run_id: str | None = None
    release_evidence_run_id: str | None = None
    failed_kpis_latest: list[str] = Field(default_factory=list)
    latest_decision: ExperimentDecision | None = None


class RunComparison(BaseModel):
    """Backend-owned delta between a base run and a comparable candidate run."""

    experiment_id: str
    base_run_id: str
    candidate_run_id: str
    base_gate: GateResult | None
    candidate_gate: GateResult | None
    kpi_deltas: list[dict[str, Any]] = Field(default_factory=list)
    sample_deltas: list[dict[str, Any]] = Field(default_factory=list)
    base_quality_score: float | None = None
    candidate_quality_score: float | None = None
    quality_delta: float | None = None
    base_latency_ms: float | None = None
    candidate_latency_ms: float | None = None
    latency_delta_percent: float | None = None
    sample_counts: dict[str, int] = Field(default_factory=dict)
    #: Operational measurements compared on their own values, per metric.
    #:
    #: Measurements carry no verdict and therefore no normalised score, so
    #: `sample_deltas` — which compares normalised scores — skips them
    #: entirely. That left the one question these metrics exist to answer
    #: unanswerable: did this run take longer, or cost more tokens, than that
    #: one. Compared on the raw captured value, in the metric's own units, with
    #: no pass or fail attached.
    measurement_deltas: list[dict[str, Any]] = Field(default_factory=list)
    metric_failures: dict[str, list[str]] = Field(default_factory=dict)
    metadata_diff: dict[str, Any] = Field(default_factory=dict)
