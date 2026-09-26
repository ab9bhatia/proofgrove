"""SQLAlchemy ORM models aligned to TDD section 18."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, ForeignKeyConstraint, Index, Integer, String, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from proofgrove.db.session import Base
from proofgrove.db.types import JsonType


def _uuid() -> str:
    return str(uuid.uuid4())


class MetricDefinitionORM(Base):
    __tablename__ = "metric_definitions"

    metric_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    version: Mapped[str] = mapped_column(String(32), primary_key=True, default="1.0")
    display_name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str] = mapped_column(String(64))
    scoring_type: Mapped[str] = mapped_column(String(32))
    score_range_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    score_range_max: Mapped[float | None] = mapped_column(Float, nullable=True)
    primary_adapter: Mapped[str] = mapped_column(String(64))
    requires_ground_truth: Mapped[bool] = mapped_column(Boolean, default=False)
    default_threshold_pass: Mapped[float | None] = mapped_column(Float, nullable=True)
    default_threshold_warn: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class KpiDefinitionORM(Base):
    __tablename__ = "kpi_definitions"

    kpi_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    version: Mapped[str] = mapped_column(String(32), primary_key=True, default="1.0")
    display_name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    primary_scenario: Mapped[str | None] = mapped_column(String(64), nullable=True)
    constituent_metrics: Mapped[dict] = mapped_column(JsonType, default=dict)
    threshold_pass: Mapped[float] = mapped_column(Float)
    threshold_warn: Mapped[float] = mapped_column(Float)
    is_zero_tolerance: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class ExperimentORM(Base):
    __tablename__ = "experiments"

    experiment_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(512))
    dataset_version: Mapped[str] = mapped_column(String(128))
    target_endpoint: Mapped[str] = mapped_column(String(1024))
    scenario: Mapped[str] = mapped_column(String(64))
    domain: Mapped[str | None] = mapped_column(String(64), nullable=True)
    market: Mapped[str] = mapped_column(String(64), default="global")
    judge_model: Mapped[str] = mapped_column(String(128), default="gpt-4o-mini")
    judge_temperature: Mapped[float] = mapped_column(Float, default=0.0)
    has_ground_truth: Mapped[bool] = mapped_column(Boolean, default=True)
    safety_defect_tolerance: Mapped[float] = mapped_column(Float, default=0.02)
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    # Governance / experiment tracking
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    objective: Mapped[str | None] = mapped_column(Text, nullable=True)
    hypothesis: Mapped[str | None] = mapped_column(Text, nullable=True)
    tenant_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    product_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    owner: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="active")
    tags: Mapped[dict] = mapped_column(JsonType, default=dict)
    quality_profile_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    quality_profile_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    benchmark_package_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    benchmark_package_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    target_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    target_version: Mapped[str | None] = mapped_column(String(128), nullable=True)
    environment: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # References into the versioned quality-contract control plane. Existing
    # experiment callers can remain scenario-driven until they opt in.
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    target_version_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    gate_policy_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    gate_policy_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    run_manifest_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # Contract depth and target identity recorded by the run that stamped this
    # experiment. Nullable/empty for historical rows whose depth predates the
    # columns — never backfilled with an invented default.
    evaluation_scope: Mapped[str | None] = mapped_column(String(32), nullable=True)
    requested_evaluation_scope: Mapped[str | None] = mapped_column(String(32), nullable=True)
    selected_tool_ids: Mapped[list | None] = mapped_column(JsonType, nullable=True)
    kpi_threshold_overrides: Mapped[dict] = mapped_column(JsonType, default=dict)
    requested_target_provenance: Mapped[dict] = mapped_column(JsonType, default=dict)
    resolved_target_provenance: Mapped[dict] = mapped_column(JsonType, default=dict)
    observed_target_provenance: Mapped[dict] = mapped_column(JsonType, default=dict)

    rows: Mapped[list["DatasetRowORM"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")
    runs: Mapped[list["EvaluationRunORM"]] = relationship(back_populates="experiment")
    versions: Mapped[list["ExperimentVersionORM"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")
    run_links: Mapped[list["ExperimentRunLinkORM"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")
    decisions: Mapped[list["ExperimentDecisionORM"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")


class DatasetRowORM(Base):
    __tablename__ = "dataset_rows"
    __table_args__ = (
        UniqueConstraint(
            "experiment_id",
            "sequence_position",
            name="uq_dataset_rows_experiment_position",
        ),
    )

    row_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    experiment_id: Mapped[str] = mapped_column(String(36), ForeignKey("experiments.experiment_id"))
    sequence_position: Mapped[int | None] = mapped_column(Integer, nullable=True)
    query: Mapped[str] = mapped_column(Text)
    response: Mapped[str] = mapped_column(Text)
    expected_response: Mapped[str | None] = mapped_column(Text, nullable=True)
    context: Mapped[list] = mapped_column(JsonType, default=list)
    trace_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # Tool names the golden row expects the agent to call (dataset-driven).
    expected_tools: Mapped[list] = mapped_column(JsonType, default=list)
    # Structured tool-call trace from a live agent run (list of {name, args,
    # output}); empty for judge-only rows. Drives dataset-driven groundedness.
    tool_calls: Mapped[list] = mapped_column(JsonType, default=list)
    trace_unavailable: Mapped[bool] = mapped_column(Boolean, default=False)
    tool_evidence_completion_attested: Mapped[bool] = mapped_column(Boolean, default=False)
    tool_evidence_provenance_status: Mapped[str] = mapped_column(String(24), default="unavailable")
    tool_evidence_source: Mapped[str | None] = mapped_column(String(256), nullable=True)
    from_agent: Mapped[bool] = mapped_column(Boolean, default=False)
    tags: Mapped[dict] = mapped_column(JsonType, default=dict)
    input_data: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    output_data: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    expected_data: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    retrieval_snippets: Mapped[list | None] = mapped_column(JsonType, nullable=True)
    span_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    parent_span_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    trace_provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    invocation_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    kagent_session_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    target_usage: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    invocation_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    experiment: Mapped[ExperimentORM] = relationship(back_populates="rows")


class RunJobORM(Base):
    """Async run job (queue + status) for a dataset evaluation.

    A run against a live agent does network I/O per row, so it is executed by a
    background worker rather than in the request. POST creates a PENDING job; the
    worker claims it (RUNNING), executes, persists the full EvaluationRunORM under
    the same run_id, and marks the job COMPLETED (or FAILED with an error).
    Mirrors the memory service's job-status + worker-poll pattern.
    """

    __tablename__ = "run_jobs"
    __table_args__ = (Index("ix_run_jobs_tenant_created", "tenant_id", "created_at"),)

    run_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    # "eval" (evaluate a dataset) | "generate" (synthesise a dataset). The worker
    # dispatches on this. Eval jobs use the typed columns below; generate jobs
    # carry their config in ``params``.
    kind: Mapped[str] = mapped_column(String(16), default="eval")
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    # Owning tenant of the in-flight job (mirrors the experiment's tenant).
    # NULL marks legacy rows created before tenant attribution; those are only
    # visible to unscoped (non-tenant) queries.
    tenant_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    dataset_name: Mapped[str] = mapped_column(String(256))
    response_source: Mapped[str] = mapped_column(String(32), default="agent")
    agent: Mapped[str | None] = mapped_column(String(512), nullable=True)
    row_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    judge_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    params: Mapped[dict] = mapped_column(JsonType, default=dict)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC), onupdate=lambda: datetime.now(UTC))


class EvaluationRunORM(Base):
    __tablename__ = "evaluation_runs"
    __table_args__ = (
        Index("ix_evaluation_runs_experiment_id", "experiment_id"),
        Index("ix_evaluation_runs_started_at", "started_at"),
    )

    run_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    experiment_id: Mapped[str] = mapped_column(String(36), ForeignKey("experiments.experiment_id"))
    status: Mapped[str] = mapped_column(String(32))
    verdict_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    overall_gate: Mapped[str | None] = mapped_column(String(16), nullable=True)
    diagnostic_only: Mapped[bool] = mapped_column(Boolean, default=False)
    evidence_readiness: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    evidence_capture_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    evidence_categories: Mapped[list] = mapped_column(JsonType, default=list)
    active_metrics: Mapped[list] = mapped_column(JsonType, default=list)
    # Traceability / lineage (TDD run schema).
    trigger_reason: Mapped[str] = mapped_column(String(32), default="manual")
    correlation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    experiment_version_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    prompt_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    lineage: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Experiment tracking
    run_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    run_type: Mapped[str] = mapped_column(String(32), default="ad_hoc")
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    git_sha: Mapped[str | None] = mapped_column(String(64), nullable=True)
    build_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    deployment_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    artifact_refs: Mapped[list] = mapped_column(JsonType, default=list)
    # Immutable quality-contract manifest used to execute this run.
    run_manifest_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # Governed-run lineage. Populated only when an approved quality profile /
    # gate policy governs the run; ``NULL`` marks an ungoverned run. Kept as
    # first-class columns (not only inside the ``lineage`` JSON) so runs can be
    # filtered by governance without unpacking the snapshot.
    quality_profile_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    quality_profile_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    gate_policy_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    gate_policy_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Optional user-supplied annotations from the evaluation workbench.
    label: Mapped[str | None] = mapped_column(String(256), nullable=True)
    labels: Mapped[list] = mapped_column(JsonType, nullable=True, default=list)

    experiment: Mapped[ExperimentORM] = relationship(back_populates="runs")
    evaluator_configs: Mapped[list["EvaluatorConfigORM"]] = relationship(back_populates="run", cascade="all, delete-orphan")
    metric_results: Mapped[list["MetricResultORM"]] = relationship(back_populates="run", cascade="all, delete-orphan")
    run_items: Mapped[list["EvaluationRunItemORM"]] = relationship(back_populates="run", cascade="all, delete-orphan")
    kpi_results: Mapped[list["KpiResultORM"]] = relationship(back_populates="run", cascade="all, delete-orphan")
    review_queue: Mapped[list["ReviewQueueORM"]] = relationship(back_populates="run", cascade="all, delete-orphan")
    root_cause: Mapped["RootCauseORM | None"] = relationship(back_populates="run", cascade="all, delete-orphan", uselist=False)


class EvaluationRunItemORM(Base):
    """Immutable evidence snapshot for one evaluated example in one run."""

    __tablename__ = "evaluation_run_items"
    __table_args__ = (UniqueConstraint("run_id", "sequence_position", name="uq_evaluation_run_items_position"),)

    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation_runs.run_id", ondelete="CASCADE"), primary_key=True)
    example_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    sequence_position: Mapped[int] = mapped_column(Integer)
    dataset_version: Mapped[str] = mapped_column(String(128))
    query: Mapped[str | None] = mapped_column(Text, nullable=True)
    input_data: Mapped[dict] = mapped_column("input", JsonType, default=dict)
    output_data: Mapped[dict | None] = mapped_column("output", JsonType, nullable=True)
    expected_data: Mapped[dict | None] = mapped_column("expected", JsonType, nullable=True)
    row_metadata: Mapped[dict] = mapped_column(JsonType, default=dict)
    retrieval_snippets: Mapped[list] = mapped_column(JsonType, default=list)
    expected_tools: Mapped[list] = mapped_column(JsonType, default=list)
    tool_calls: Mapped[list] = mapped_column(JsonType, default=list)
    tool_call_count: Mapped[int] = mapped_column(Integer, default=0)
    invocation_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    kagent_session_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    target_usage: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    invocation_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    trace_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    span_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    parent_span_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    trace_provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    evidence_ref: Mapped[str] = mapped_column(String(512))
    redaction_enabled: Mapped[bool] = mapped_column(Boolean)
    max_persisted_string_size: Mapped[int] = mapped_column(Integer)
    capture_state: Mapped[str] = mapped_column(String(16), default="complete")
    tool_evidence_completion_attested: Mapped[bool] = mapped_column(Boolean, default=False)
    tool_evidence_provenance_status: Mapped[str] = mapped_column(String(24), default="unavailable")
    tool_evidence_source: Mapped[str | None] = mapped_column(String(256), nullable=True)
    # Spans the archive returned for this case. Persisted because the `trace`
    # evidence category is derived from it: without it a reload reports the
    # trace as never captured when it was.
    trace_span_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    trace_completion_attested: Mapped[bool] = mapped_column(Boolean, default=False)
    model_usage_completion_attested: Mapped[bool] = mapped_column(Boolean, default=False)
    lifecycle_completion_attested: Mapped[bool] = mapped_column(Boolean, default=False)

    run: Mapped[EvaluationRunORM] = relationship(back_populates="run_items")


class ToolResultArtifactORM(Base):
    """Large tool output stored outside evaluator-facing run-item JSON."""

    __tablename__ = "tool_result_artifacts"
    __table_args__ = (
        ForeignKeyConstraint(
            ["run_id", "example_id"],
            ["evaluation_run_items.run_id", "evaluation_run_items.example_id"],
            ondelete="CASCADE",
        ),
        Index("ix_tool_result_artifacts_run_item", "run_id", "example_id"),
    )

    artifact_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(String(36), nullable=False)
    example_id: Mapped[str] = mapped_column(String(128), nullable=False)
    tool_name: Mapped[str] = mapped_column(String(256), nullable=False)
    tool_call_index: Mapped[int] = mapped_column(Integer, nullable=False)
    content_type: Mapped[str] = mapped_column(String(64), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    preview: Mapped[str] = mapped_column(Text, nullable=False)
    preview_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class CaseReplayORM(Base):
    """One ad-hoc re-invocation of an evaluated case with a different prompt.

    Replay evidence is deliberately isolated: no report, export, comparison,
    review-queue, or run-item query may join this table. A replay is a
    side-experiment on one case — it must never change or appear among the
    case-facing results of the run it came from.
    """

    __tablename__ = "case_replays"
    __table_args__ = (Index("ix_case_replays_case", "tenant_id", "run_id", "example_id"),)

    replay_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(128), nullable=False)
    run_id: Mapped[str] = mapped_column(String(36), nullable=False)
    example_id: Mapped[str] = mapped_column(String(128), nullable=False)
    prompt_version_ref: Mapped[str | None] = mapped_column(String(256), nullable=True)
    prompt_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    system_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_model: Mapped[str] = mapped_column(String(128), nullable=False)
    target_endpoint: Mapped[str | None] = mapped_column(String(512), nullable=True)
    response: Mapped[str | None] = mapped_column(Text, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    target_usage: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    invocation_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    invocation_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    trace_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    span_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    created_by: Mapped[str] = mapped_column(String(128), default="system")


class ExperimentVersionORM(Base):
    """Immutable contract snapshot keyed by experiment_version_id fingerprint."""

    __tablename__ = "experiment_versions"

    experiment_version_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    experiment_id: Mapped[str] = mapped_column(String(36), ForeignKey("experiments.experiment_id"), index=True)
    contract_json: Mapped[dict] = mapped_column(JsonType, default=dict)
    contract_hash: Mapped[str] = mapped_column(String(64))
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    experiment: Mapped[ExperimentORM] = relationship(back_populates="versions")


class ExperimentRunLinkORM(Base):
    """Associates a run with an experiment ordinal + role (baseline/champion/…)."""

    __tablename__ = "experiment_run_links"
    __table_args__ = (
        # At most one BASELINE link per experiment. Partial unique index so
        # concurrent promotions cannot commit two baselines; other roles are
        # unconstrained. Works on SQLite and Postgres via dialect-specific
        # WHERE clauses.
        Index(
            "uq_experiment_run_links_baseline",
            "experiment_id",
            unique=True,
            sqlite_where=text("role = 'baseline'"),
            postgresql_where=text("role = 'baseline'"),
        ),
    )

    experiment_id: Mapped[str] = mapped_column(String(36), ForeignKey("experiments.experiment_id"), primary_key=True)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation_runs.run_id"), primary_key=True)
    run_number: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(32), default="exploratory")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    experiment: Mapped[ExperimentORM] = relationship(back_populates="run_links")


class BaselineChangeORM(Base):
    """Immutable audit row for one baseline promotion or undo on an experiment."""

    __tablename__ = "baseline_changes"

    baseline_change_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    experiment_id: Mapped[str] = mapped_column(String(36), ForeignKey("experiments.experiment_id"), index=True)
    tenant_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    actor: Mapped[str] = mapped_column(String(128), default="system")
    action: Mapped[str] = mapped_column(String(32), default="promote")
    previous_baseline_run_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    new_baseline_run_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class ExperimentDecisionORM(Base):
    """Human release / quality decision recorded against a run."""

    __tablename__ = "experiment_decisions"

    decision_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    experiment_id: Mapped[str] = mapped_column(String(36), ForeignKey("experiments.experiment_id"), index=True)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation_runs.run_id"))
    decision: Mapped[str] = mapped_column(String(64))
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    approved_by: Mapped[str] = mapped_column(String(128))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    experiment: Mapped[ExperimentORM] = relationship(back_populates="decisions")


class EvaluationProjectORM(Base):
    """Tenant-local evaluation project; owns target registrations."""

    __tablename__ = "evaluation_projects"

    project_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(String(128), index=True)
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    system_type: Mapped[str] = mapped_column(String(128))
    owner: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(32), default="active")
    purpose: Mapped[str | None] = mapped_column(String(32), nullable=True)
    tags: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class TargetVersionORM(Base):
    """Immutable deployable target snapshot registered beneath a project."""

    __tablename__ = "target_versions"

    target_version_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    target_id: Mapped[str] = mapped_column(String(256), index=True)
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation_projects.project_id"), index=True)
    tenant_id: Mapped[str] = mapped_column(String(128), index=True)
    name: Mapped[str] = mapped_column(String(256))
    version: Mapped[str] = mapped_column(String(128))
    endpoint: Mapped[str] = mapped_column(String(1024))
    target_type: Mapped[str] = mapped_column(String(64), default="endpoint")
    environment: Mapped[str] = mapped_column(String(64), default="dev")
    model_version: Mapped[str | None] = mapped_column(String(256), nullable=True)
    prompt_version: Mapped[str | None] = mapped_column(String(256), nullable=True)
    tool_versions: Mapped[dict] = mapped_column(JsonType, default=dict)
    configuration: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class TargetProjectBindingORM(Base):
    """Binds a logical target (+ environment) to a tenant *system* Project.

    Stored separately from the immutable ``TargetVersionORM`` so historical
    versions are never mutated. ``target_id`` is the logical target id, not a
    ``target_version_id``. One binding per (tenant, target, environment).
    """

    __tablename__ = "target_project_bindings"

    binding_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(String(128), index=True)
    target_id: Mapped[str] = mapped_column(String(256), index=True)
    environment: Mapped[str] = mapped_column(String(64))
    system_project_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation_projects.project_id"), index=True)
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    __table_args__ = (
        UniqueConstraint("tenant_id", "target_id", "environment", name="uq_target_project_binding"),
    )


class QualityProfileVersionORM(Base):
    """Immutable version of a tenant-local quality profile."""

    __tablename__ = "quality_profile_versions"

    profile_version_id: Mapped[str] = mapped_column(String(324), primary_key=True)
    profile_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[str] = mapped_column(String(64))
    tenant_id: Mapped[str] = mapped_column(String(128), index=True)
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="draft")
    scenario: Mapped[str | None] = mapped_column(String(64), nullable=True)
    contract_json: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class ReleaseGatePolicyVersionORM(Base):
    """Immutable version of a tenant-local release gate policy."""

    __tablename__ = "release_gate_policy_versions"

    gate_policy_version_id: Mapped[str] = mapped_column(String(324), primary_key=True)
    gate_policy_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[str] = mapped_column(String(64))
    tenant_id: Mapped[str] = mapped_column(String(128), index=True)
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="draft")
    policy_json: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class RunManifestORM(Base):
    """Content-addressed immutable resolved contract consumed by a run."""

    __tablename__ = "run_manifests"

    manifest_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    manifest_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    tenant_id: Mapped[str] = mapped_column(String(128), index=True)
    project_id: Mapped[str] = mapped_column(String(36), index=True)
    target_version_id: Mapped[str] = mapped_column(String(36), index=True)
    profile_id: Mapped[str] = mapped_column(String(128), index=True)
    profile_version: Mapped[str] = mapped_column(String(64))
    gate_policy_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    gate_policy_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    manifest_json: Mapped[dict] = mapped_column(JsonType, default=dict)
    resolved_by: Mapped[str] = mapped_column(String(128), default="system")
    resolved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class AssignmentVersionORM(Base):
    """Named, versioned binding of a target to approved Profile and optional Gate Policy."""

    __tablename__ = "assignment_versions"
    __table_args__ = (
        UniqueConstraint("tenant_id", "assignment_id", "version", name="uq_assignment_version"),
        Index("ix_assignment_versions_tenant_project", "tenant_id", "project_id"),
        Index("ix_assignment_versions_tenant_target", "tenant_id", "target_version_id"),
    )

    assignment_version_id: Mapped[str] = mapped_column(String(324), primary_key=True)
    assignment_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[str] = mapped_column(String(64))
    tenant_id: Mapped[str] = mapped_column(String(128), index=True)
    name: Mapped[str] = mapped_column(String(256))
    purpose: Mapped[str | None] = mapped_column(Text, nullable=True)
    owner: Mapped[str | None] = mapped_column(String(128), nullable=True)
    change_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    project_id: Mapped[str] = mapped_column(String(36), index=True)
    target_version_id: Mapped[str] = mapped_column(String(36), index=True)
    profile_id: Mapped[str] = mapped_column(String(128), index=True)
    profile_version: Mapped[str] = mapped_column(String(64))
    gate_policy_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    gate_policy_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    run_manifest_id: Mapped[str] = mapped_column(String(64), index=True)
    parent_assignment_version_id: Mapped[str | None] = mapped_column(String(324), nullable=True)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class PromptVersionORM(Base):
    """One immutable saved revision of a named prompt."""

    __tablename__ = "prompt_versions"
    __table_args__ = (Index("ix_prompt_versions_max", "tenant_id", "prompt_id", "version"),)

    # Tenant is inside the key, not merely a column beside it: two tenants must
    # both be able to own `support-prompt@1`.
    prompt_version_id: Mapped[str] = mapped_column(String(324), primary_key=True)
    prompt_id: Mapped[str] = mapped_column(String(128), index=True)
    version: Mapped[int] = mapped_column(Integer)
    tenant_id: Mapped[str] = mapped_column(String(128), index=True)
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    content: Mapped[str] = mapped_column(Text)
    #: Same digest a run records, so a stored version and an ad-hoc run of the
    #: same text are recognisably the same prompt.
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    created_by: Mapped[str] = mapped_column(String(128), default="user")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    #: Retired from the pickers, never deleted: runs cite a version by number and
    #: an exact rerun has to replay it, so the row has to outlive its usefulness.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PromptLabelORM(Base):
    """A moveable pointer at one version, e.g. `production`.

    A label is an update, not an append: rolling back means pointing it at an
    older version. What a label used to point at is recorded on the runs that
    resolved it, never here.
    """

    __tablename__ = "prompt_labels"
    __table_args__ = (
        UniqueConstraint("tenant_id", "prompt_id", "label", name="uq_prompt_label"),
    )

    prompt_label_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(String(128), index=True)
    prompt_id: Mapped[str] = mapped_column(String(128), index=True)
    label: Mapped[str] = mapped_column(String(64))
    prompt_version_id: Mapped[str] = mapped_column(String(324), index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class EvaluatorDefinitionORM(Base):
    """Versioned evaluator implementation metadata."""

    __tablename__ = "evaluator_definitions"

    evaluator_version_id: Mapped[str] = mapped_column(String(324), primary_key=True)
    evaluator_id: Mapped[str] = mapped_column(String(256), index=True)
    version: Mapped[str] = mapped_column(String(64))
    tenant_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="draft")
    execution_mode: Mapped[str] = mapped_column(String(32))
    adapter: Mapped[str] = mapped_column(String(64))
    implementation: Mapped[str] = mapped_column(String(512))
    definition_json: Mapped[dict] = mapped_column(JsonType, default=dict)
    trusted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class MetricPackVersionORM(Base):
    """Versioned collection of evaluator references and metric declarations."""

    __tablename__ = "metric_pack_versions"

    metric_pack_version_id: Mapped[str] = mapped_column(String(324), primary_key=True)
    metric_pack_id: Mapped[str] = mapped_column(String(256), index=True)
    version: Mapped[str] = mapped_column(String(64))
    tenant_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="draft")
    pack_json: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class FindingORM(Base):
    __tablename__ = "findings"

    finding_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation_runs.run_id"), index=True)
    experiment_id: Mapped[str] = mapped_column(String(36), ForeignKey("experiments.experiment_id"), index=True)
    row_id: Mapped[str] = mapped_column(String(128), index=True)
    metric_ids: Mapped[list] = mapped_column(JsonType, default=list)
    gate_result: Mapped[str] = mapped_column(String(16))
    severity: Mapped[str] = mapped_column(String(16))
    root_cause_category: Mapped[str | None] = mapped_column(String(128), nullable=True)
    evidence: Mapped[dict] = mapped_column(JsonType, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="open")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class ReviewTaskORM(Base):
    __tablename__ = "review_tasks"

    task_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    finding_id: Mapped[str] = mapped_column(String(36), ForeignKey("findings.finding_id"), index=True)
    tenant_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    assigned_to: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="open")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class ReviewDecisionORM(Base):
    __tablename__ = "review_decisions"

    decision_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    finding_id: Mapped[str] = mapped_column(String(36), ForeignKey("findings.finding_id"), index=True)
    task_id: Mapped[str] = mapped_column(String(36), ForeignKey("review_tasks.task_id"), index=True)
    reviewer: Mapped[str] = mapped_column(String(128))
    outcome: Mapped[str] = mapped_column(String(32))
    rationale: Mapped[str] = mapped_column(Text)
    score_override: Mapped[float | None] = mapped_column(Float, nullable=True)
    severity: Mapped[str | None] = mapped_column(String(16), nullable=True)
    root_cause_category: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class WaiverORM(Base):
    __tablename__ = "waivers"

    waiver_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    finding_id: Mapped[str] = mapped_column(String(36), ForeignKey("findings.finding_id"), index=True)
    approved_by: Mapped[str] = mapped_column(String(128))
    rationale: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class FindingCommentORM(Base):
    """Append-only collaboration comments on a finding (F6). No edit/delete."""

    __tablename__ = "finding_comments"

    comment_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    finding_id: Mapped[str] = mapped_column(String(36), ForeignKey("findings.finding_id"), index=True)
    tenant_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    author: Mapped[str] = mapped_column(String(128))
    body: Mapped[str] = mapped_column(Text)
    mentions: Mapped[list] = mapped_column(JsonType, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class RemediationORM(Base):
    __tablename__ = "remediations"

    remediation_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    finding_id: Mapped[str] = mapped_column(String(36), ForeignKey("findings.finding_id"), index=True)
    owner: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="open")
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC), onupdate=lambda: datetime.now(UTC))


class RegressionCaseORM(Base):
    __tablename__ = "regression_cases"

    regression_case_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tenant_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32), default="approved")
    finding_id: Mapped[str] = mapped_column(String(36), ForeignKey("findings.finding_id"), index=True)
    source_run_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation_runs.run_id"), index=True)
    source_target_version_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    record: Mapped[dict] = mapped_column(JsonType, default=dict)
    provenance: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class EvidencePackORM(Base):
    __tablename__ = "evidence_packs"

    evidence_pack_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation_runs.run_id"), unique=True, index=True)
    experiment_id: Mapped[str] = mapped_column(String(36), ForeignKey("experiments.experiment_id"), index=True)
    overall_gate: Mapped[str | None] = mapped_column(String(16), nullable=True)
    manifest_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    contents: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class AuditEventORM(Base):
    __tablename__ = "audit_events"

    audit_event_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tenant_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    actor: Mapped[str] = mapped_column(String(128))
    action: Mapped[str] = mapped_column(String(128), index=True)
    resource_type: Mapped[str] = mapped_column(String(128))
    resource_id: Mapped[str] = mapped_column(String(256), index=True)
    details: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class EvaluatorConfigORM(Base):
    __tablename__ = "evaluator_configs"

    config_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation_runs.run_id"), index=True)
    metric_id: Mapped[str] = mapped_column(String(128))
    adapter: Mapped[str] = mapped_column(String(64))
    adapter_class: Mapped[str] = mapped_column(String(256))
    judge_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    scoring_type: Mapped[str] = mapped_column(String(32))
    threshold_pass: Mapped[float] = mapped_column(Float, default=0.8)
    threshold_warn: Mapped[float] = mapped_column(Float, default=0.6)
    config_json: Mapped[dict] = mapped_column(JsonType, default=dict)

    run: Mapped[EvaluationRunORM] = relationship(back_populates="evaluator_configs")


class MetricResultORM(Base):
    __tablename__ = "metric_results"
    __table_args__ = (Index("ix_metric_results_run_row", "run_id", "row_id"),)

    result_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation_runs.run_id"))
    metric_id: Mapped[str] = mapped_column(String(128))
    evaluator_config_id: Mapped[str] = mapped_column(String(36))
    row_id: Mapped[str] = mapped_column(String(128))
    metric_requirement: Mapped[str] = mapped_column(String(16), default="required")
    metric_requirement_source: Mapped[str | None] = mapped_column(String(64), nullable=True)
    metric_applicability: Mapped[str] = mapped_column(String(32), default="applicable")
    metric_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    unscored_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error_details: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    normalised_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    passed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    threshold_result: Mapped[str | None] = mapped_column(String(16), nullable=True)
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    threshold: Mapped[float] = mapped_column(Float)
    prompt_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    judge_prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    judge_completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    judge_total_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    judge_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    subject_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    trace_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    span_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    target_trace_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    target_span_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    evaluator_trace_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    evaluator_span_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    feedback_scope: Mapped[str] = mapped_column(String(16), default="span")
    annotator_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    evaluation_identifier: Mapped[str | None] = mapped_column(String(256), nullable=True)
    dataset_version: Mapped[str] = mapped_column(String(128))
    sample_input: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    sample_output: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    evaluator_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    evaluator_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    execution_status: Mapped[str] = mapped_column(String(32), default="success")
    execution_metadata: Mapped[dict] = mapped_column(JsonType, default=dict)
    requested_scorer: Mapped[str | None] = mapped_column(String(32), nullable=True)
    executed_scorer: Mapped[str | None] = mapped_column(String(32), nullable=True)
    evaluated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    run: Mapped[EvaluationRunORM] = relationship(back_populates="metric_results")


class KpiResultORM(Base):
    __tablename__ = "kpi_results"

    result_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation_runs.run_id"), index=True)
    kpi_id: Mapped[str] = mapped_column(String(128))
    composite_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    gate_result: Mapped[str | None] = mapped_column(String(16), nullable=True)
    observed_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    constituent_scores: Mapped[list] = mapped_column(JsonType, default=list)
    threshold_pass: Mapped[float] = mapped_column(Float)
    threshold_warn: Mapped[float] = mapped_column(Float)
    threshold_fail: Mapped[float] = mapped_column(Float)
    dataset_version: Mapped[str] = mapped_column(String(128))
    evaluated_target: Mapped[str] = mapped_column(String(1024))
    required_applicable_pair_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    required_scored_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    required_unscored_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    required_technical_error_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    required_coverage_percentage: Mapped[float | None] = mapped_column(Float, nullable=True)
    coverage_label: Mapped[str | None] = mapped_column(String(16), nullable=True)
    optional_applicable_pair_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    optional_scored_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    optional_coverage_percentage: Mapped[float | None] = mapped_column(Float, nullable=True)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    run: Mapped[EvaluationRunORM] = relationship(back_populates="kpi_results")


class ReviewQueueORM(Base):
    __tablename__ = "review_queue"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation_runs.run_id"), index=True)
    row_id: Mapped[str] = mapped_column(String(128))
    query: Mapped[str] = mapped_column(Text)
    response: Mapped[str] = mapped_column(Text)
    trace_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    failing_metrics: Mapped[list] = mapped_column(JsonType, default=list)
    gate_result: Mapped[str] = mapped_column(String(16))
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)

    run: Mapped[EvaluationRunORM] = relationship(back_populates="review_queue")


class RootCauseORM(Base):
    __tablename__ = "root_cause_diagnoses"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation_runs.run_id"), unique=True)
    root_cause_metric_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    root_cause_label: Mapped[str | None] = mapped_column(String(256), nullable=True)
    causal_chain: Mapped[list] = mapped_column(JsonType, default=list)
    failing_metrics: Mapped[list] = mapped_column(JsonType, default=list)
    recommended_remediation: Mapped[str | None] = mapped_column(Text, nullable=True)
    has_ground_truth: Mapped[bool] = mapped_column(Boolean, default=True)

    run: Mapped[EvaluationRunORM] = relationship(back_populates="root_cause")


# ---------------------------------------------------------------------------
# Golden Dataset Registry (Postgres-backed)
# ---------------------------------------------------------------------------


class GoldenDatasetORM(Base):
    """Governance metadata + identity for a golden dataset version."""

    __tablename__ = "golden_datasets"

    # Composite identity: dataset names are unique PER TENANT, not globally —
    # two tenants may both own a dataset called "smoke-test".
    tenant_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    dataset_name: Mapped[str] = mapped_column(String(256), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(String(36), default=_uuid)
    product_id: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(32), default="DRAFT")
    version_number: Mapped[int] = mapped_column(Integer, default=1)
    parent_dataset_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    dqs: Mapped[float | None] = mapped_column(Float, nullable=True)
    change_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by: Mapped[str] = mapped_column(String(128), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    records: Mapped[list["GoldenDatasetRecordORM"]] = relationship(back_populates="dataset", cascade="all, delete-orphan")
    version_events: Mapped[list["GoldenDatasetVersionEventORM"]] = relationship(back_populates="dataset", cascade="all, delete-orphan")


class GoldenDatasetRecordORM(Base):
    """A single record (inputs / expectations / tags)."""

    __tablename__ = "golden_dataset_records"
    __table_args__ = (
        ForeignKeyConstraint(
            ["tenant_id", "dataset_name"],
            ["golden_datasets.tenant_id", "golden_datasets.dataset_name"],
            ondelete="CASCADE",
        ),
    )

    dataset_record_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    dataset_name: Mapped[str] = mapped_column(String(256), primary_key=True)
    inputs: Mapped[dict] = mapped_column(JsonType, default=dict)
    expectations: Mapped[dict] = mapped_column(JsonType, default=dict)
    tags: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    dataset: Mapped[GoldenDatasetORM] = relationship(back_populates="records")


class GoldenDatasetVersionEventORM(Base):
    """Append-only history of mutating operations on a dataset."""

    __tablename__ = "golden_dataset_version_events"
    __table_args__ = (
        ForeignKeyConstraint(
            ["tenant_id", "dataset_name"],
            ["golden_datasets.tenant_id", "golden_datasets.dataset_name"],
            ondelete="CASCADE",
        ),
        Index("ix_golden_dataset_version_events_tenant_dataset", "tenant_id", "dataset_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(String(128))
    dataset_name: Mapped[str] = mapped_column(String(256))
    version: Mapped[int] = mapped_column(Integer)
    operation: Mapped[str] = mapped_column(String(64))
    num_records: Mapped[int] = mapped_column(Integer, default=0)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    # Who caused the event, bound the way every other audit actor is (the
    # authenticated subject when auth is on, the request-supplied actor when it
    # is off). Nullable: rows written before this column stay unknown rather
    # than being backfilled with an invented identity. Text, not a bounded
    # varchar: the request models and the gateway subject carry no length
    # limit, and a status change must not roll back because its audit line
    # was long.
    actor: Mapped[str | None] = mapped_column(Text, nullable=True)

    dataset: Mapped[GoldenDatasetORM] = relationship(back_populates="version_events")


# ── Collector-confirmed trace catalog (tracing index) ────────────────────────


class CapturedTraceIndexORM(Base):
    """One tenant-scoped observability trace known to proofgrove.

    Langfuse-style worker→index projection: raw spans stay in the S3 archive;
    this row records only what has actually been observed. ``lifecycle_state``
    holds honest values (``requested`` / ``pending_export`` /
    ``archive_confirmed`` / ``archive_unavailable``) and the span statistics
    stay NULL until spans were genuinely read from the archive.
    """

    __tablename__ = "captured_trace_index"
    __table_args__ = (
        # Keyset paging index: (tenant, project, started_at DESC, trace_id).
        Index(
            "ix_captured_trace_index_keyset",
            "tenant_id",
            "project_id",
            text("started_at DESC"),
            "trace_id",
        ),
    )

    tenant_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    trace_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    # NULL = Unassigned: a real production trace whose resource attributes did
    # not resolve to a Project via TargetProjectBinding. Never guessed.
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    root_span_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    root_span_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    span_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    model: Mapped[str | None] = mapped_column(String(256), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    estimated_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_evaluated: Mapped[bool] = mapped_column(Boolean, default=False)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    lifecycle_state: Mapped[str] = mapped_column(String(32), default="requested")
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Derivation revision of this trace's span rows; a row stamped below the
    # current SPAN_INDEX_REV is rebuilt by the worker. NULL means never derived.
    span_index_rev: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))


class CapturedSpanIndexORM(Base):
    """Bounded span summary rows for one archive-confirmed trace.

    Summary columns and bounded previews — never full span payloads — populated
    by the trace-index worker when a trace is confirmed, replacing prior rows
    idempotently. Previews are redacted when payload redaction is enabled.
    """

    __tablename__ = "captured_span_index"
    __table_args__ = (
        Index(
            "ix_captured_span_index_keyset",
            "tenant_id",
            "project_id",
            text("started_at DESC"),
            "trace_id",
            "span_id",
        ),
    )

    tenant_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    trace_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    span_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    parent_span_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    name: Mapped[str] = mapped_column(String(512))
    # OTLP transport kind. Orthogonal to semantic_kind below: neither replaces
    # the other, and the trace tree still reads this one.
    kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # What the span did — llm / agent / tool / … — or NULL for transport and
    # framework plumbing, which the span listing filters out.
    semantic_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    input_preview: Mapped[str | None] = mapped_column(Text, nullable=True)
    output_preview: Mapped[str | None] = mapped_column(Text, nullable=True)
    llm_token_count_prompt: Mapped[int | None] = mapped_column(Integer, nullable=True)
    llm_token_count_completion: Mapped[int | None] = mapped_column(Integer, nullable=True)
    estimated_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    # "ok" / "error" / "unset" straight from the archived OTLP status.
    status: Mapped[str] = mapped_column(String(16), default="unset")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
