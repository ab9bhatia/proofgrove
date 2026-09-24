"""Persistence layer for evaluation runs."""

import base64
import hashlib
import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from datetime import time as time_of_day
from enum import Enum
from statistics import quantiles
from typing import Any
from urllib.parse import quote

from sqlalchemy import Select, String, case, cast, delete, exists, func, literal, or_, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from evalhub.datasets.naming import dataset_version_label
from evalhub.db.models import (
    AssignmentVersionORM,
    AuditEventORM,
    BaselineChangeORM,
    CapturedSpanIndexORM,
    CapturedTraceIndexORM,
    CaseReplayORM,
    DatasetRowORM,
    EvaluationProjectORM,
    EvaluationRunItemORM,
    EvaluationRunORM,
    EvaluatorConfigORM,
    EvaluatorDefinitionORM,
    EvidencePackORM,
    ExperimentDecisionORM,
    ExperimentORM,
    ExperimentRunLinkORM,
    ExperimentVersionORM,
    FindingCommentORM,
    FindingORM,
    KpiDefinitionORM,
    KpiResultORM,
    MetricDefinitionORM,
    MetricPackVersionORM,
    MetricResultORM,
    PromptLabelORM,
    PromptVersionORM,
    QualityProfileVersionORM,
    RegressionCaseORM,
    ReleaseGatePolicyVersionORM,
    RemediationORM,
    ReviewDecisionORM,
    ReviewQueueORM,
    ReviewTaskORM,
    RootCauseORM,
    RunJobORM,
    RunManifestORM,
    TargetProjectBindingORM,
    TargetVersionORM,
    ToolResultArtifactORM,
    WaiverORM,
)
from evalhub.evaluation.enums import (
    CoverageLabel,
    DecisionType,
    EvaluationScope,
    EvidenceCaptureStatus,
    ExperimentStatus,
    GateResult,
    MetricApplicability,
    MetricRequirement,
    MetricRequirementSource,
    MetricStatus,
    ProvenanceStatus,
    RunRole,
    RunStatus,
    RunType,
    Scenario,
    TriggerReason,
    UnscoredReason,
    VerdictStatus,
)
from evalhub.evaluation.evidence_requirements import canonicalize_capture_requirements
from evalhub.evaluation.kpis import KPI_CATALOG
from evalhub.evaluation.labels import normalize_run_labels
from evalhub.evaluation.lineage import hash_system_prompt
from evalhub.evaluation.metrics import METRIC_CATALOG
from evalhub.evaluation.models import (
    BaselineChange,
    CaseReplay,
    ConstituentScore,
    EvaluationRow,
    EvaluatorConfig,
    EvidenceCategorySummary,
    EvidencePolicy,
    EvidenceReadinessResult,
    ExperimentDecision,
    ExperimentDefinition,
    ExperimentRunLink,
    ExperimentSummary,
    ExperimentVersion,
    FailingMetricDetail,
    KpiResult,
    MetricResult,
    ReviewQueueItem,
    RootCauseDiagnosis,
    RunComparison,
    RunItemDetail,
    RunItemExecution,
    RunItemSummary,
    RunLineage,
    RunResult,
    ToolCall,
    ToolResultArtifactPage,
    ToolResultArtifactReference,
    recorded_comparison_basis,
)
from evalhub.events import EvalEvent, emit
from evalhub.platform.audit import AuditEvent
from evalhub.platform.authz import namespace_for_tenant, tenant_id_candidates, tenants_match, validate_governance_roles
from evalhub.platform.contracts import (
    CreateAssignmentRequest,
    EvaluationAssignmentVersion,
    EvaluationProject,
    ProfileTestStatus,
    ProjectPurpose,
    ProjectStatus,
    QualityProfileVersion,
    ReleaseGatePolicyVersion,
    ResolvedRunManifest,
    TargetType,
    TargetVersion,
    VersionLifecycle,
    assignment_version_key,
    gate_policy_version_key,
    generated_assignment_name,
    legacy_gate_policy_version_key,
    legacy_profile_version_key,
    profile_version_key,
)
from evalhub.platform.evaluators import (
    EvaluatorDefinition,
    EvaluatorStatus,
    MetricPackVersion,
    builtin_evaluator_definitions,
    evaluator_version_key,
    metric_definition_for_id,
    metric_pack_version_key,
    parse_evaluator_ref,
)
from evalhub.platform.payloads import redact_artifact_content, redact_for_persistence
from evalhub.platform.prompts import (
    AUTOMATIC_LABELS,
    PromptVersion,
    parse_prompt_ref,
    prompt_version_key,
)
from evalhub.platform.resolver import ContractResolutionError, resolve_run_manifest
from evalhub.platform.review import (
    ActivityEvent,
    ActivityKind,
    EvidencePack,
    Finding,
    FindingComment,
    FindingStatus,
    RegressionCase,
    RegressionKind,
    Remediation,
    RemediationStatus,
    ReviewDecision,
    ReviewDecisionRecord,
    ReviewOutcome,
    ReviewTask,
    Severity,
    Waiver,
)
from evalhub.platform.target_binding import TargetProjectBinding
from evalhub.settings import settings
from evalhub.tracing.models import SPAN_INDEX_REV, TraceLifecycleState
from evalhub.version import PROMPT_VERSION


class RunCancelledError(RuntimeError):
    """Raised when a stopped async run attempts to persist a late result."""


# Fields that say WHO owns an experiment workspace rather than WHAT it
# evaluates. Everything else on ``ExperimentDefinition`` is contract-bearing:
# it feeds ``compute_experiment_version_id`` and the evidence depth a run is
# scored at, so the first run that joins a pre-run workspace has to stamp all
# of it. The contract is enumerated FROM the model rather than hand-listed, so
# a field added later is stamped by default instead of silently left at its
# sentinel.
_WORKSPACE_OWNED_EXPERIMENT_FIELDS = frozenset(
    {
        "experiment_id",
        "name",
        "description",
        "objective",
        "hypothesis",
        "tenant_id",
        "product_id",
        "owner",
        "status",
        "tags",
        "created_by",
        "created_at",
        # Counts the rows attached to a lineage, not the contract they run under.
        "row_count",
    }
)

EXPERIMENT_CONTRACT_FIELDS: tuple[str, ...] = tuple(name for name in ExperimentDefinition.model_fields if name not in _WORKSPACE_OWNED_EXPERIMENT_FIELDS)

# Patchable = the whole contract plus the governance fields a workspace owner
# edits. Identity and creation stamps are never patched.
_PATCHABLE_EXPERIMENT_FIELDS = frozenset(EXPERIMENT_CONTRACT_FIELDS) | (_WORKSPACE_OWNED_EXPERIMENT_FIELDS - {"experiment_id", "created_by", "created_at", "row_count"})


@dataclass(frozen=True, slots=True)
class _RunItemMetricSummary:
    """Compact scorer projection used by the run-item list endpoint."""

    example_id: str
    dataset_version: str
    sample_query: str | None
    worst_gate: GateResult | None
    metric_count: int
    failing_count: int
    failing_optional_count: int
    error_count: int
    scored_count: int
    unscored_count: int
    unscored_required_count: int
    not_applicable_count: int


@dataclass(frozen=True, slots=True)
class _RunItemListRecord:
    """Columns required to render a complete-capture run-item summary."""

    run_id: str
    example_id: str
    query: str | None
    sequence_position: int
    dataset_version: str
    latency_ms: int | None
    trace_id: str | None
    evidence_ref: str
    invocation_error: str | None = None
    capture_state: str = "complete"


#: Enough that realistic contention on one prompt resolves; small enough that a
#: genuinely stuck allocation surfaces instead of spinning.
_PROMPT_SAVE_ATTEMPTS = 8

# A RUNNING job untouched this long is presumed orphaned by a dead worker.
# See reclaim_running_jobs's ponytail note for the upgrade path.
_RECLAIM_STALE_AFTER_SECONDS = 900.0
#: ``run_jobs.params`` key stamped once the durable runtime accepted the job's
#: workflow (see ``orchestrator.temporal``).
WORKFLOW_SUBMITTED_AT_KEY = "workflow_submitted_at"


def tenant_clause(model: Any, tenant_id: str) -> Any:
    """``model.tenant_id IN tenant_id_candidates(tenant_id)`` — the one place
    every tenant-scoped query builds its filter, so the gateway-slug vs.
    namespace spelling widening (see ``tenant_id_candidates``) can't drift
    out of sync between call sites.
    """
    return model.tenant_id.in_(tenant_id_candidates(tenant_id))


def _tenant_namespace_sql(column: Any) -> Any:
    """Match storage aliases only for the configured deployment tenant."""
    namespace = (settings.pod_namespace or "").strip()
    if not namespace.startswith("tenant-"):
        return column
    return case((column.in_(tenant_id_candidates(namespace)), literal(namespace)), else_=column)


def measurement_values(run: RunResult, metric_id: str | None = None) -> dict[str, list[float]]:
    """Raw captured values per operational metric, for comparing two runs.

    Read from ``score``, never ``normalised_score``: a measurement has no
    normalised form precisely because it carries no verdict, which is why the
    score-based sample comparison skips these metrics entirely. That left the
    one question they exist to answer — did this run take longer, or cost more
    tokens, than that one — unanswerable.

    A boolean is rejected explicitly: ``bool`` subclasses ``int``, so ``True``
    would otherwise be averaged in as 1.0.
    """
    grouped: dict[str, list[float]] = {}
    for result in run.metric_results:
        if metric_id and result.metric_id != metric_id:
            continue
        if not result.metric_id.startswith("ops."):
            continue
        if isinstance(result.score, bool) or not isinstance(result.score, (int, float)):
            continue
        grouped.setdefault(result.metric_id, []).append(float(result.score))
    return grouped


def _builtin_definition_json(definition: EvaluatorDefinition) -> dict[str, Any]:
    """The part of a built-in definition that lives in the JSON column.

    The excluded keys are the ones stored as real columns; keeping them out of
    the blob stops the two copies drifting apart.
    """
    return definition.model_dump(
        mode="json",
        exclude={
            "evaluator_id",
            "version",
            "tenant_id",
            "name",
            "description",
            "status",
            "execution_mode",
            "adapter",
            "implementation",
            "trusted",
            "created_by",
            "created_at",
        },
    )


def _case_replay_from_orm(orm: CaseReplayORM) -> CaseReplay:
    return CaseReplay(
        replay_id=orm.replay_id,
        tenant_id=orm.tenant_id,
        run_id=orm.run_id,
        example_id=orm.example_id,
        prompt_version_ref=orm.prompt_version_ref,
        prompt_hash=orm.prompt_hash,
        system_prompt=orm.system_prompt,
        target_model=orm.target_model,
        target_endpoint=orm.target_endpoint,
        response=orm.response,
        latency_ms=orm.latency_ms,
        target_usage=orm.target_usage,
        invocation_error=orm.invocation_error,
        invocation_id=orm.invocation_id,
        trace_id=orm.trace_id,
        span_id=orm.span_id,
        created_at=orm.created_at,
        created_by=orm.created_by,
    )


def _prompt_from_orm(orm: PromptVersionORM, *, labels: list[str]) -> PromptVersion:
    return PromptVersion(
        prompt_id=orm.prompt_id,
        version=orm.version,
        tenant_id=orm.tenant_id,
        name=orm.name,
        description=orm.description,
        content=orm.content,
        content_hash=orm.content_hash,
        labels=sorted(labels),
        created_by=orm.created_by,
        created_at=orm.created_at,
        archived_at=orm.archived_at,
    )


class EvaluationStore:
    """Async store for experiments, rows, and evaluation runs."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def seed_definitions(self) -> None:
        """Seed metric and KPI definition tables from in-code catalog."""
        if self.session.get_bind().dialect.name == "postgresql":
            await self.session.execute(text("SELECT pg_advisory_xact_lock(1129271892, 2)"))
        for mid, m in METRIC_CATALOG.items():
            existing = await self.session.get(MetricDefinitionORM, (mid, "1.0"))
            if existing:
                continue
            self.session.add(
                MetricDefinitionORM(
                    metric_id=mid,
                    version="1.0",
                    display_name=m.name,
                    description=m.description,
                    category=m.scenario.value if m.scenario else "cross_cutting",
                    scoring_type=m.scoring_type.value,
                    score_range_min=m.score_range[0] if m.score_range else None,
                    score_range_max=m.score_range[1] if m.score_range else None,
                    primary_adapter=m.default_adapter.value,
                    requires_ground_truth=m.requires_ground_truth,
                    default_threshold_pass=m.default_threshold_pass,
                    default_threshold_warn=m.default_threshold_warn,
                )
            )
        for kid, k in KPI_CATALOG.items():
            existing = await self.session.get(KpiDefinitionORM, (kid, "1.0"))
            if existing:
                continue
            self.session.add(
                KpiDefinitionORM(
                    kpi_id=kid,
                    version="1.0",
                    display_name=k.name,
                    description=k.description,
                    primary_scenario=k.primary_scenario.value if k.primary_scenario else None,
                    constituent_metrics=k.constituent_metrics,
                    threshold_pass=k.threshold_pass,
                    threshold_warn=k.threshold_warn,
                    is_zero_tolerance=k.zero_tolerance,
                )
            )
        await self._seed_builtin_evaluator_definitions()
        await self.session.commit()

    async def _seed_builtin_evaluator_definitions(self) -> None:
        """Seed first-party adapter declarations without changing tenant data.

        Existing rows are refreshed, not skipped. ``builtin_evaluator_definitions``
        is derived from the metric catalogue in code and always emits version
        1.0.0, so skipping an existing row froze the catalogue at whatever the
        code said the first time this database was seeded. After metrics moved
        between adapters, ``builtin.native`` went on advertising metrics that no
        longer route to it and ``builtin.ragas`` never listed the ones it had
        gained — a catalogue that disagreed with what the runs actually did.

        Only first-party ``builtin.*`` rows at the version the code emits are
        touched. Versions created through the platform API are somebody's
        deliberate record and are left alone.
        """
        for definition in builtin_evaluator_definitions():
            key = evaluator_version_key(definition.evaluator_id, definition.version)
            existing = await self.session.get(EvaluatorDefinitionORM, key)
            if existing is not None:
                existing.name = definition.name
                existing.description = definition.description
                existing.status = definition.status.value
                existing.execution_mode = definition.execution_mode.value
                existing.adapter = definition.adapter.value
                existing.implementation = definition.implementation
                existing.definition_json = _builtin_definition_json(definition)
                continue
            self.session.add(
                EvaluatorDefinitionORM(
                    evaluator_version_id=key,
                    evaluator_id=definition.evaluator_id,
                    version=definition.version,
                    tenant_id=None,
                    name=definition.name,
                    description=definition.description,
                    status=definition.status.value,
                    execution_mode=definition.execution_mode.value,
                    adapter=definition.adapter.value,
                    implementation=definition.implementation,
                    definition_json=_builtin_definition_json(definition),
                    trusted=True,
                    created_by=definition.created_by,
                    created_at=definition.created_at,
                )
            )

    async def save_experiment(self, exp: ExperimentDefinition, *, commit: bool = True) -> ExperimentDefinition:
        exp_id = exp.experiment_id or str(uuid.uuid4())
        exp.experiment_id = exp_id
        orm = ExperimentORM(
            experiment_id=exp_id,
            name=exp.name,
            dataset_version=exp.dataset_version,
            target_endpoint=exp.target_endpoint,
            scenario=exp.scenario.value if isinstance(exp.scenario, Scenario) else exp.scenario,
            domain=exp.domain,
            market=exp.market,
            judge_model=exp.judge_model,
            judge_temperature=exp.judge_temperature,
            has_ground_truth=exp.has_ground_truth,
            safety_defect_tolerance=exp.safety_defect_tolerance,
            created_by=exp.created_by,
            description=exp.description,
            objective=exp.objective,
            hypothesis=exp.hypothesis,
            tenant_id=exp.tenant_id,
            product_id=exp.product_id,
            owner=exp.owner,
            status=exp.status.value if isinstance(exp.status, ExperimentStatus) else exp.status,
            tags=exp.tags or {},
            quality_profile_id=exp.quality_profile_id,
            quality_profile_version=exp.quality_profile_version,
            benchmark_package_id=exp.benchmark_package_id,
            benchmark_package_version=exp.benchmark_package_version,
            target_id=exp.target_id,
            target_version=exp.target_version,
            environment=exp.environment,
            project_id=exp.project_id,
            target_version_id=exp.target_version_id,
            gate_policy_id=exp.gate_policy_id,
            gate_policy_version=exp.gate_policy_version,
            run_manifest_id=exp.run_manifest_id,
            evaluation_scope=exp.evaluation_scope.value if exp.evaluation_scope else None,
            requested_evaluation_scope=(exp.requested_evaluation_scope.value if exp.requested_evaluation_scope else None),
            selected_tool_ids=(list(exp.selected_tool_ids) if exp.selected_tool_ids is not None else None),
            kpi_threshold_overrides=exp.kpi_threshold_overrides or {},
            requested_target_provenance=exp.requested_target_provenance or {},
            resolved_target_provenance=exp.resolved_target_provenance or {},
            observed_target_provenance=exp.observed_target_provenance or {},
        )
        self.session.add(orm)
        if commit:
            await self.session.commit()
        else:
            await self.session.flush()
        return _experiment_from_orm(orm)

    async def _update_experiment_core(self, orm: ExperimentORM, patch: dict) -> ExperimentDefinition:
        """Shared patch-and-save body for ``update_experiment``.

        Split out so an already-authorized internal caller (e.g.
        ``attach_run_to_experiment_workspace``, which validates ownership
        itself via ``_reject_foreign_workspace_run``) can apply a patch to an
        ORM row it already holds, without re-deriving a tenant_id it may not
        have (the worker-attach path can run with none).
        """
        for key, value in patch.items():
            if key not in _PATCHABLE_EXPERIMENT_FIELDS or value is None and key == "status":
                continue
            if not hasattr(type(orm), key):
                # A contract field with no column would be dropped in silence,
                # leaving the row describing a contract nobody ran.
                raise ValueError(f"Experiment field '{key}' has no persisted column")
            if isinstance(value, Enum):
                value = value.value
            setattr(orm, key, value)
        await self.session.commit()
        await self.session.refresh(orm)
        return _experiment_from_orm(orm)

    async def update_experiment(self, experiment_id: str, tenant_id: str, patch: dict) -> ExperimentDefinition | None:
        """Patch governance / contract fields on an existing experiment, scoped to ``tenant_id``."""
        result = await self.session.execute(select(ExperimentORM).where(ExperimentORM.experiment_id == experiment_id, tenant_clause(ExperimentORM, tenant_id)))
        orm = result.scalar_one_or_none()
        if not orm:
            return None
        return await self._update_experiment_core(orm, patch)

    async def _update_experiment_unscoped(self, experiment_id: str, patch: dict) -> ExperimentDefinition | None:
        """Internal-only, no tenant filter — mirrors ``_get_experiment_unscoped``."""
        orm = await self.session.get(ExperimentORM, experiment_id)
        if not orm:
            return None
        return await self._update_experiment_core(orm, patch)

    async def _get_experiment_unscoped(self, experiment_id: str) -> ExperimentDefinition | None:
        """Internal-only, no tenant filter.

        Reserved for call sites that carry their own, more nuanced ownership
        check (``_reject_foreign_workspace_run``'s run-tenant fallback for the
        worker's no-request-context path) — never call this from a route.
        """
        orm = await self.session.get(ExperimentORM, experiment_id)
        if not orm:
            return None
        return _experiment_from_orm(orm)

    async def get_experiment(self, experiment_id: str, tenant_id: str) -> ExperimentDefinition | None:
        result = await self.session.execute(select(ExperimentORM).where(ExperimentORM.experiment_id == experiment_id, tenant_clause(ExperimentORM, tenant_id)))
        orm = result.scalar_one_or_none()
        if not orm:
            return None
        return _experiment_from_orm(orm)

    async def list_experiments(self, tenant_id: str) -> list[ExperimentDefinition]:
        result = await self.session.execute(select(ExperimentORM).where(tenant_clause(ExperimentORM, tenant_id)).order_by(ExperimentORM.created_at.desc()))
        return [_experiment_from_orm(e) for e in result.scalars().all()]

    async def _experiment_tenant_ok(self, experiment_id: str, tenant_id: str) -> bool:
        """True iff ``experiment_id`` exists and belongs to ``tenant_id``.

        Guards writes on tables that have no ``tenant_id`` column of their own
        (dataset rows, experiment versions, decisions, run links) — ownership
        is only knowable via the parent experiment.
        """
        result = await self.session.execute(select(ExperimentORM.experiment_id).where(ExperimentORM.experiment_id == experiment_id, tenant_clause(ExperimentORM, tenant_id)))
        return result.scalar_one_or_none() is not None

    async def add_rows(self, experiment_id: str, tenant_id: str, rows: list[EvaluationRow]) -> int:
        if not await self._experiment_tenant_ok(experiment_id, tenant_id):
            return 0
        # Serialise position allocation for this experiment. PostgreSQL holds
        # the row lock until commit; the unique constraint is the final
        # invariant backstop.
        await self.session.execute(select(ExperimentORM.experiment_id).where(ExperimentORM.experiment_id == experiment_id).with_for_update())
        position_result = await self.session.execute(select(func.max(DatasetRowORM.sequence_position)).where(DatasetRowORM.experiment_id == experiment_id))
        max_position = position_result.scalar_one_or_none()
        start_position = 0 if max_position is None else max_position + 1
        for offset, row in enumerate(rows):
            self.session.add(
                DatasetRowORM(
                    row_id=row.row_id,
                    experiment_id=experiment_id,
                    sequence_position=start_position + offset,
                    query=redact_for_persistence(row.query),
                    response=redact_for_persistence(row.response),
                    expected_response=redact_for_persistence(row.expected_response),
                    context=redact_for_persistence(row.context),
                    trace_id=row.trace_id,
                    expected_tools=redact_for_persistence(row.expected_tools),
                    tool_calls=redact_for_persistence([tc.model_dump(mode="json") for tc in row.tool_calls]),
                    trace_unavailable=row.trace_unavailable,
                    tool_evidence_completion_attested=row.tool_evidence_completion_attested,
                    tool_evidence_provenance_status=row.tool_evidence_provenance_status.value,
                    tool_evidence_source=row.tool_evidence_source,
                    from_agent=row.from_agent,
                    tags=redact_for_persistence(row.tags),
                    input_data=redact_for_persistence(row.input_data),
                    output_data=redact_for_persistence(row.output_data),
                    expected_data=redact_for_persistence(row.expected_data),
                    retrieval_snippets=redact_for_persistence(row.retrieval_snippets),
                    span_id=row.span_id,
                    parent_span_id=row.parent_span_id,
                    trace_provider=row.trace_provider,
                    invocation_id=row.invocation_id,
                    kagent_session_id=row.kagent_session_id,
                    latency_ms=row.latency_ms,
                    target_usage=redact_for_persistence(row.target_usage),
                    invocation_error=redact_for_persistence(row.invocation_error),
                )
            )
        await self.session.commit()
        return len(rows)

    async def get_rows(self, experiment_id: str, tenant_id: str) -> list[EvaluationRow]:
        if not await self._experiment_tenant_ok(experiment_id, tenant_id):
            return []
        result = await self.session.execute(
            select(DatasetRowORM)
            .where(DatasetRowORM.experiment_id == experiment_id)
            .order_by(
                case(
                    (DatasetRowORM.sequence_position.is_(None), 0),
                    else_=1,
                ),
                DatasetRowORM.sequence_position.asc(),
                DatasetRowORM.row_id.asc(),
            )
        )
        return [_row_from_orm(r) for r in result.scalars().all()]

    # ------------------------------------------------------------------
    # Async run jobs (queue + status) — see RunJobORM.
    # ------------------------------------------------------------------

    async def create_run_job(
        self,
        *,
        dataset_name: str,
        response_source: str,
        agent: str | None,
        target_endpoint: str | None = None,
        target_model: str | None = None,
        system_prompt: str | None = None,
        prompt_version_ref: str | None = None,
        row_count: int | None,
        judge_model: str | None,
        active_metrics: list[str] | None = None,
        span_checks: dict | None = None,
        requested_active_metrics: list[str] | None = None,
        enable_llm_judge: bool = True,
        parallel_requests: int = 5,
        run_human_review: bool = True,
        quality_contract_ids: list[str] | None = None,
        trigger_reason: TriggerReason = TriggerReason.MANUAL,
        correlation_id: str | None = None,
        scenario: str | None = None,
        dataset_version: str | None = None,
        label: str | None = None,
        labels: list[str] | None = None,
        evaluation_name: str | None = None,
        evaluation_scope: str = "final_response",
        requested_evaluation_scope: str | None = None,
        evidence_readiness: dict | None = None,
        requested_provenance: dict | None = None,
        resolved_scoring_configuration: dict | None = None,
        project_id: str | None = None,
        tenant_id: str | None = None,
        assignment_id: str | None = None,
        assignment_version: str | None = None,
        run_manifest_id: str | None = None,
    ) -> str:
        """Create a PENDING run job and return its run_id.

        ``trigger_reason``/``correlation_id`` are carried in ``params`` and
        threaded through the worker into the run's lineage for traceability.
        ``scenario``/``dataset_version`` are stored so in-flight jobs can appear
        on the Evaluation Runs list before a full RunResult exists.
        ``labels`` is canonical; ``label`` remains the first-label alias for
        older readers and is only used when ``labels`` is absent.
        ``evaluation_name`` groups related runs on Monitor / Experiments.
        """
        run_id = str(uuid.uuid4())
        trimmed_label, normalized_labels = normalize_run_labels(label=label, labels=labels)
        trimmed_evaluation_name = (evaluation_name or "").strip() or None
        self.session.add(
            RunJobORM(
                run_id=run_id,
                status=RunStatus.PENDING.value,
                tenant_id=tenant_id,
                dataset_name=dataset_name,
                response_source=response_source,
                agent=agent,
                row_count=row_count,
                judge_model=judge_model,
                params={
                    "trigger_reason": trigger_reason.value,
                    "correlation_id": correlation_id or run_id,
                    "active_metrics": active_metrics,
                    "span_checks": span_checks,
                    "resolved_active_metrics": active_metrics,
                    "requested_active_metrics": requested_active_metrics,
                    "enable_llm_judge": enable_llm_judge,
                    "parallel_requests": parallel_requests,
                    "run_human_review": run_human_review,
                    "quality_contract_ids": quality_contract_ids or [],
                    "target_endpoint": target_endpoint,
                    "target_model": target_model,
                    "system_prompt": system_prompt,
                    "prompt_version_ref": prompt_version_ref,
                    "scenario": scenario,
                    "dataset_version": dataset_version or dataset_version_label(dataset_name, 1),
                    "label": trimmed_label,
                    "labels": normalized_labels,
                    # Back-compat alias for older readers / UI clients.
                    "name": trimmed_label,
                    "evaluation_name": trimmed_evaluation_name,
                    "evaluation_scope": evaluation_scope,
                    "requested_evaluation_scope": requested_evaluation_scope or evaluation_scope,
                    "resolved_evaluation_scope": evaluation_scope,
                    "evidence_readiness": evidence_readiness,
                    "requested_provenance": requested_provenance or {},
                    "resolved_scoring_configuration": resolved_scoring_configuration,
                    "project_id": project_id,
                    "assignment_id": assignment_id,
                    "assignment_version": assignment_version,
                    "run_manifest_id": run_manifest_id,
                },
            )
        )
        await self.session.commit()
        return run_id

    async def create_span_scoring_job(self, *, job_id: str, tenant_id: str, params: dict, judge_model: str) -> RunJobORM:
        """Queue an immutable span snapshot; identical request retries reuse it."""
        existing = await self.get_run_job(job_id, tenant_id=tenant_id)
        if existing is not None:
            if existing.kind != "span_score" or existing.params.get("request_hash") != params["request_hash"]:
                raise ValueError("This request ID was already used with different scoring options")
            return existing
        self.session.add(RunJobORM(
            run_id=job_id, tenant_id=tenant_id, kind="span_score",
            status=RunStatus.PENDING.value, dataset_name="captured spans",
            response_source="span", judge_model=judge_model, params=params,
        ))
        try:
            await self.session.commit()
        except IntegrityError:
            await self.session.rollback()
            existing = await self.get_run_job(job_id, tenant_id=tenant_id)
            if existing is None or existing.kind != "span_score" or existing.params.get("request_hash") != params["request_hash"]:
                raise ValueError("This request ID was already used with different scoring options") from None
            return existing
        return await self.get_run_job(job_id, tenant_id=tenant_id)

    async def list_span_scoring_jobs(self, *, tenant_id: str, project_id: str, trace_id: str, span_id: str) -> list[RunJobORM]:
        query = select(RunJobORM).where(
            RunJobORM.kind == "span_score", RunJobORM.tenant_id.in_(tenant_id_candidates(tenant_id)),
            RunJobORM.params["project_id"].as_string() == project_id,
            RunJobORM.params["span_keys"][f"{trace_id}:{span_id}"].as_boolean().is_(True),
        ).order_by(RunJobORM.created_at.desc()).limit(20)
        return list((await self.session.execute(query)).scalars().all())

    async def list_automatic_span_scoring_sources(self, *, tenant_id: str, project_id: str, trace_id: str) -> list[RunJobORM]:
        query = select(RunJobORM).where(
            RunJobORM.kind == "eval", RunJobORM.tenant_id.in_(tenant_id_candidates(tenant_id)),
            RunJobORM.params["project_id"].as_string() == project_id,
            RunJobORM.run_id.in_(select(EvaluationRunItemORM.run_id).where(EvaluationRunItemORM.trace_id == trace_id)),
        )
        return [job for job in (await self.session.execute(query)).scalars().all() if job.params.get("span_checks")]

    async def automatic_span_scoring_counts(self, *, tenant_id: str, run_id: str) -> dict[str, int]:
        rows = await self.session.execute(select(RunJobORM.status, func.count()).where(
            RunJobORM.kind == "span_score", RunJobORM.tenant_id.in_(tenant_id_candidates(tenant_id)),
            RunJobORM.params["source_run_id"].as_string() == run_id,
        ).group_by(RunJobORM.status))
        return {status: count for status, count in rows.all()}

    async def save_span_scoring_results(self, job_id: str, results: list[dict]) -> None:
        """Save span results on their job, never through the case-run projection."""
        job = await self.session.get(RunJobORM, job_id)
        if job is None or job.kind != "span_score":
            raise ValueError("Span scoring job not found")
        params = {**job.params, "results": results}
        updated = await self.session.execute(update(RunJobORM).where(
            RunJobORM.run_id == job_id,
            RunJobORM.status == RunStatus.RUNNING.value,
        ).values(params=params))
        if not updated.rowcount:
            await self.session.rollback()
            raise RunCancelledError("Span scoring stopped before results were saved")
        await self.session.commit()

    async def create_generation_job(self, *, dataset_name: str, params: dict) -> str:
        """Create a PENDING dataset-generation job and return its run_id."""
        run_id = str(uuid.uuid4())
        self.session.add(
            RunJobORM(
                run_id=run_id,
                kind="generate",
                status=RunStatus.PENDING.value,
                dataset_name=dataset_name,
                response_source="n/a",
                params=params,
            )
        )
        await self.session.commit()
        return run_id

    async def create_rescore_job(
        self,
        *,
        source_run: RunResult,
        active_metrics: list[str] | None,
        judge_model: str | None,
        created_by: str,
    ) -> str:
        """Queue a diagnostic replay over one immutable source evidence snapshot."""

        run_id = str(uuid.uuid4())
        self.session.add(
            RunJobORM(
                run_id=run_id,
                kind="rescore",
                status=RunStatus.PENDING.value,
                tenant_id=source_run.experiment.tenant_id,
                dataset_name=source_run.experiment.dataset_version,
                response_source="rescore",
                judge_model=judge_model,
                params={
                    "source_run_id": source_run.run_id,
                    "source_evidence_snapshot": f"evidence-pack://{source_run.run_id}",
                    "active_metrics": active_metrics or source_run.active_metrics,
                    "created_by": created_by,
                    "experiment_id": source_run.experiment.experiment_id,
                },
            )
        )
        await self.session.commit()
        return run_id

    async def load_run_evidence_rows(self, run_id: str) -> list[EvaluationRow]:
        result = await self.session.execute(select(EvaluationRunItemORM).where(EvaluationRunItemORM.run_id == run_id).order_by(EvaluationRunItemORM.sequence_position.asc()))
        rows: list[EvaluationRow] = []
        for item in result.scalars().all():
            output = item.output_data if isinstance(item.output_data, dict) else {}
            expected = item.expected_data if isinstance(item.expected_data, dict) else {}
            rows.append(
                EvaluationRow(
                    row_id=item.example_id,
                    query=item.query or str((item.input_data or {}).get("query") or ""),
                    response=str(output.get("response") or ""),
                    expected_response=(str(expected.get("response")) if expected.get("response") is not None else None),
                    context=list(item.retrieval_snippets or []),
                    trace_id=item.trace_id,
                    span_id=item.span_id,
                    parent_span_id=item.parent_span_id,
                    trace_provider=item.trace_provider,
                    expected_tools=list(item.expected_tools or []),
                    tool_calls=[ToolCall.model_validate(call) for call in (item.tool_calls or [])],
                    input_data=item.input_data,
                    output_data=item.output_data,
                    expected_data=item.expected_data,
                    retrieval_snippets=list(item.retrieval_snippets or []),
                    invocation_id=item.invocation_id,
                    kagent_session_id=item.kagent_session_id,
                    latency_ms=item.latency_ms,
                    target_usage=item.target_usage,
                    invocation_error=item.invocation_error,
                    from_agent=bool(item.kagent_session_id or item.invocation_id),
                    trace_unavailable=False,
                    tool_evidence_completion_attested=bool(item.tool_evidence_completion_attested),
                    tool_evidence_provenance_status=ProvenanceStatus(item.tool_evidence_provenance_status or "unavailable"),
                    tool_evidence_source=item.tool_evidence_source,
                    trace_span_count=item.trace_span_count,
                    trace_completion_attested=bool(item.trace_completion_attested),
                    model_usage_completion_attested=bool(item.model_usage_completion_attested),
                    lifecycle_completion_attested=bool(item.lifecycle_completion_attested),
                    tags=dict(item.row_metadata or {}),
                )
            )
        return rows

    async def claim_next_pending_job(self) -> RunJobORM | None:
        """Claim the oldest PENDING job (mark RUNNING) and return it, else None.

        PostgreSQL skips jobs locked by another claimant. SQLite is supported
        only for single-process development.
        """
        result = await self.session.execute(select(RunJobORM).where(RunJobORM.status == RunStatus.PENDING.value).order_by(RunJobORM.created_at.asc()).limit(1).with_for_update(skip_locked=True))
        job = result.scalar_one_or_none()
        if job is None:
            return None
        job.status = RunStatus.RUNNING.value
        await self.session.commit()
        return job

    async def mark_run_job_submitted(self, run_id: str) -> None:
        """Record that the durable runtime accepted this job's workflow.

        The reconciliation pass skips marked rows, so a pending job that is
        merely queued behind other work is not resubmitted every tick.
        """
        job = (await self.session.execute(select(RunJobORM).where(
            RunJobORM.run_id == run_id, RunJobORM.status == RunStatus.PENDING.value,
        ).with_for_update())).scalar_one_or_none()
        if job is None:
            return
        params = dict(job.params or {})
        params[WORKFLOW_SUBMITTED_AT_KEY] = datetime.now(UTC).isoformat()
        await self.session.execute(update(RunJobORM).where(RunJobORM.run_id == run_id).values(params=params))
        await self.session.commit()

    async def list_pending_run_job_page(
        self, *, older_than: datetime, limit: int = 500,
        after: tuple[datetime, str] | None = None,
    ) -> list[RunJobORM]:
        """Read one stable keyset page, including submitted jobs for cursor progress."""
        query = select(RunJobORM).where(RunJobORM.status == RunStatus.PENDING.value, RunJobORM.created_at < older_than)
        if after is not None:
            created_at, run_id = after
            query = query.where((RunJobORM.created_at > created_at) | ((RunJobORM.created_at == created_at) & (RunJobORM.run_id > run_id)))
        result = await self.session.execute(query.order_by(RunJobORM.created_at.asc(), RunJobORM.run_id.asc()).limit(limit))
        return list(result.scalars().all())

    async def claim_run_job(self, run_id: str) -> RunJobORM | None:
        """Claim a known job for a durable workflow activity.

        A Temporal activity retry may see an existing RUNNING job after a worker
        interruption. It is safe to return it because the activity first checks
        for a persisted evaluation result using the same run id.
        """
        job = await self.session.get(RunJobORM, run_id)
        if not job or job.status in (
            RunStatus.COMPLETED.value,
            RunStatus.BLOCKED.value,
            RunStatus.FAILED.value,
            RunStatus.CANCELLED.value,
        ):
            return None
        job.status = RunStatus.RUNNING.value
        await self.session.commit()
        return job

    async def park_run_job_waiting_for_telemetry(self, run_id: str, snapshot: dict) -> None:
        """Keep an invoked run queued until the archived trajectory is complete."""

        job = await self.session.get(RunJobORM, run_id)
        if job is None:
            raise ValueError(f"Run job {run_id} was not found")
        params = dict(job.params or {})
        params["telemetry_score_snapshot"] = snapshot
        params["deferred_telemetry_score"] = True
        await self.session.execute(
            update(RunJobORM)
            .where(
                RunJobORM.run_id == run_id,
                RunJobORM.status.in_(
                    [
                        RunStatus.PENDING.value,
                        RunStatus.RUNNING.value,
                        RunStatus.AWAITING_TRACE.value,
                    ]
                ),
            )
            .values(params=params, status=RunStatus.AWAITING_TRACE.value)
        )
        await self.session.commit()

    async def update_run_job_telemetry_watch(self, run_id: str, snapshot: dict) -> None:
        """Persist late-telemetry watch state without changing the job status."""

        job = await self.session.get(RunJobORM, run_id)
        if job is None:
            raise ValueError(f"Run job {run_id} was not found")
        params = dict(job.params or {})
        params["telemetry_score_snapshot"] = snapshot
        params["telemetry_watch_last_checked_at"] = datetime.now(UTC).isoformat()
        job.params = params
        await self.session.commit()

    async def disable_run_job_telemetry_watch(self, run_id: str) -> None:
        """Stop bounded late-span checks while retaining their audit metadata."""

        job = await self.session.get(RunJobORM, run_id)
        if job is None:
            return
        params = dict(job.params or {})
        snapshot = dict(params.get("telemetry_score_snapshot") or {})
        snapshot["watch_completed_run"] = False
        snapshot["watch_stopped_at"] = datetime.now(UTC).isoformat()
        params["telemetry_score_snapshot"] = snapshot
        params["telemetry_watch_last_checked_at"] = datetime.now(UTC).isoformat()
        job.params = params
        await self.session.commit()

    async def list_completed_telemetry_watch_jobs(
        self,
        *,
        limit: int = 20,
        min_check_interval_seconds: float = 15.0,
    ) -> list[RunJobORM]:
        """Return completed runs whose bounded late-span watch is due."""

        result = await self.session.execute(
            select(RunJobORM)
            .where(
                RunJobORM.kind == "eval",
                RunJobORM.status == RunStatus.COMPLETED.value,
                RunJobORM.params["telemetry_score_snapshot"]["watch_completed_run"]
                .as_boolean()
                .is_(True),
            )
            .order_by(RunJobORM.updated_at.asc())
            # ponytail: over-fetch to skip rows not yet due for a re-check
            # (min_check_interval_seconds isn't filterable in SQL — it's
            # computed from a JSON timestamp). Capped at 4x/40 instead of the
            # prior 10x/100 to shrink the FOR UPDATE lock footprint; promote
            # telemetry_watch_last_checked_at to a real column if this still
            # under-returns in practice.
            .limit(max(limit * 4, 40))
            .with_for_update(skip_locked=True)
        )
        now = datetime.now(UTC)
        due: list[RunJobORM] = []
        for job in result.scalars().all():
            params = dict(job.params or {})
            snapshot = dict(params.get("telemetry_score_snapshot") or {})
            if not snapshot.get("watch_completed_run"):
                continue
            raw_checked = params.get("telemetry_watch_last_checked_at")
            try:
                checked = datetime.fromisoformat(str(raw_checked)) if raw_checked else None
            except ValueError:
                checked = None
            if checked is not None:
                if checked.tzinfo is None:
                    checked = checked.replace(tzinfo=UTC)
                if (now - checked).total_seconds() < max(0.0, min_check_interval_seconds):
                    continue
            due.append(job)
            if len(due) >= limit:
                break
        return due

    async def list_jobs_awaiting_trace(self, *, limit: int = 20) -> list[RunJobORM]:
        """Oldest invoked jobs still waiting for a completed archived trajectory."""

        result = await self.session.execute(select(RunJobORM).where(RunJobORM.status == RunStatus.AWAITING_TRACE.value).order_by(RunJobORM.updated_at.asc()).limit(limit))
        return list(result.scalars().all())

    async def complete_run_job(self, run_id: str) -> None:
        await self.session.execute(
            update(RunJobORM)
            .where(
                RunJobORM.run_id == run_id,
                RunJobORM.status.in_(
                    [
                        RunStatus.PENDING.value,
                        RunStatus.RUNNING.value,
                        RunStatus.AWAITING_TRACE.value,
                    ]
                ),
            )
            .values(status=RunStatus.COMPLETED.value)
        )
        await self.session.commit()

    async def fail_run_job(self, run_id: str, error: str) -> None:
        await self.session.execute(
            update(RunJobORM)
            .where(
                RunJobORM.run_id == run_id,
                RunJobORM.status.in_(
                    [
                        RunStatus.PENDING.value,
                        RunStatus.RUNNING.value,
                        RunStatus.AWAITING_TRACE.value,
                    ]
                ),
            )
            .values(status=RunStatus.FAILED.value, error_message=error[:2000])
        )
        await self.session.commit()

    async def block_run_job(self, run_id: str, reason: str, details: dict | None = None) -> None:
        """Record readiness loss separately from a platform execution failure."""

        job = await self.session.get(RunJobORM, run_id)
        if job is None:
            return
        params = dict(job.params or {})
        if details is not None:
            params["evidence_readiness"] = details
        await self.session.execute(
            update(RunJobORM)
            .where(
                RunJobORM.run_id == run_id,
                RunJobORM.status.in_(
                    [
                        RunStatus.PENDING.value,
                        RunStatus.RUNNING.value,
                        RunStatus.AWAITING_TRACE.value,
                    ]
                ),
            )
            .values(
                status=RunStatus.BLOCKED.value,
                error_message=reason[:2000],
                params=params,
            )
        )
        await self.session.commit()

    async def cancel_run_job(
        self,
        run_id: str,
        *,
        tenant_id: str,
        reason: str = "Stopped by user",
    ) -> RunJobORM | None:
        """Atomically stop an active evaluation job and return its latest state.

        The status predicate ensures cancellation wins over late worker writes;
        terminal jobs are left unchanged so the API can return an honest 409.
        """

        await self.session.execute(
            update(RunJobORM)
            .where(
                RunJobORM.run_id == run_id,
                RunJobORM.kind == "eval",
                RunJobORM.tenant_id.in_(tenant_id_candidates(tenant_id)),
                RunJobORM.status.in_(
                    [
                        RunStatus.PENDING.value,
                        RunStatus.RUNNING.value,
                        RunStatus.AWAITING_TRACE.value,
                    ]
                ),
            )
            .values(status=RunStatus.CANCELLED.value, error_message=reason[:2000])
        )
        await self.session.commit()
        return await self.get_run_job(run_id, tenant_id=tenant_id)

    async def get_run_job(self, run_id: str, *, tenant_id: str | None = None) -> RunJobORM | None:
        """Return a job, optionally scoped to one tenant.

        When ``tenant_id`` is given, jobs of other tenants — and legacy jobs
        with no tenant attribution (NULL) — are invisible.
        """
        job = await self.session.get(RunJobORM, run_id)
        if job is not None and tenant_id is not None and job.tenant_id not in tenant_id_candidates(tenant_id):
            return None
        return job

    async def get_run_jobs(self, run_ids: list[str], tenant_id: str) -> dict[str, RunJobORM]:
        if not run_ids:
            return {}
        result = await self.session.scalars(select(RunJobORM).where(RunJobORM.run_id.in_(run_ids), tenant_clause(RunJobORM, tenant_id)))
        return {job.run_id: job for job in result}

    async def list_eval_jobs(
        self,
        *,
        statuses: list[str] | None = None,
        limit: int = 100,
        tenant_id: str | None = None,
    ) -> list[RunJobORM]:
        """List evaluation jobs (excludes dataset-generation jobs).

        ``tenant_id`` scopes the listing to one tenant; legacy jobs without a
        tenant (NULL) only appear on unscoped queries.
        """
        query = select(RunJobORM).where(RunJobORM.kind == "eval")
        if statuses:
            query = query.where(RunJobORM.status.in_(statuses))
        if tenant_id is not None:
            query = query.where(RunJobORM.tenant_id.in_(tenant_id_candidates(tenant_id)))
        result = await self.session.execute(query.order_by(RunJobORM.created_at.desc()).limit(limit))
        return list(result.scalars().all())

    async def reclaim_running_jobs(self, *, stale_after_seconds: float = _RECLAIM_STALE_AFTER_SECONDS) -> int:
        """Recover interrupted jobs only while holding compatibility-worker ownership.

        Only reclaims a RUNNING job whose ``updated_at`` is older than
        ``stale_after_seconds`` — a fresh RUNNING row belongs to a still-live
        worker, so a second replica starting up must not steal a peer's
        in-flight job out from under it. ``skip_locked`` lets two replicas
        run this at the same moment without both reclaiming the same row —
        on PostgreSQL; SQLite ignores ``FOR UPDATE``/``SKIP LOCKED`` (no
        row-level locking there), so this only matters in production.

        # ponytail: updated_at-age heuristic, not a real worker lease/owner
        # column. Upgrade to a lease (owner id + heartbeat) if multi-replica
        # contention gets worse than "new replica starts up occasionally".
        """
        cutoff = datetime.now(UTC) - timedelta(seconds=stale_after_seconds)
        result = await self.session.execute(
            select(RunJobORM)
            .where(RunJobORM.status == RunStatus.RUNNING.value, RunJobORM.updated_at < cutoff)
            .with_for_update(skip_locked=True)
            # ponytail: ceiling on one reclaim pass; this method is idempotent
            # so a backlog beyond 500 just gets picked up on the next tick.
            .limit(500)
        )
        jobs = list(result.scalars().all())
        for job in jobs:
            if (job.params or {}).get("deferred_telemetry_score"):
                # Invoke already finished; do not re-run the agent on reclaim.
                job.status = RunStatus.AWAITING_TRACE.value
            else:
                # A target may have accepted the request before its worker died.
                # Retrying without a target idempotency contract can duplicate effects.
                job.status = RunStatus.FAILED.value
                job.error_message = "Worker interrupted before completion. Start a new run to retry."
        if jobs:
            await self.session.commit()
        return len(jobs)

    async def save_run(
        self,
        run: RunResult,
        evaluated_rows: list[EvaluationRow],
        *,
        finalize_job: bool = True,
        replace_existing: bool = False,
        allow_completed_telemetry_refresh: bool = False,
    ) -> RunResult:
        """Persist a complete run and one governed snapshot per evaluated row.

        ``replace_existing`` is reserved for automatic late-telemetry
        enrichment. It replaces the previously published partial snapshot in
        one transaction while preserving the run id, run number, experiment
        link, durable job identity, and immutable human-review records.
        """
        exp_id = run.experiment.experiment_id or run.run_id
        # Lock before checking whether the experiment exists, and hold through
        # the run commit. A row lock alone cannot protect first-time creation.
        if self.session.get_bind().dialect.name == "postgresql":
            lock_id = int.from_bytes(hashlib.sha256(f"evalhub:save_run:{exp_id}".encode()).digest()[:8], signed=True)
            await self.session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_id})
        else:
            # SQLite has no row locks; a write acquires its transaction lock
            # even if the experiment does not yet exist.
            await self.session.execute(update(ExperimentORM).where(ExperimentORM.experiment_id == exp_id).values(experiment_id=exp_id))
        job = await self.session.get(RunJobORM, run.run_id)
        if job is not None and job.status == RunStatus.CANCELLED.value:
            raise RunCancelledError(f"Run {run.run_id} was stopped")
        existing_run = await self.session.get(EvaluationRunORM, run.run_id)
        if existing_run is not None and not replace_existing:
            raise ValueError(f"Run {run.run_id} already exists")
        if (
            existing_run is not None
            and existing_run.status != RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE.value
            and not (
                allow_completed_telemetry_refresh
                and existing_run.status == RunStatus.COMPLETED.value
            )
        ):
            raise ValueError(f"Run {run.run_id} cannot be replaced from status {existing_run.status}")
        example_ids = [row.row_id for row in evaluated_rows]
        if len(example_ids) != len(set(example_ids)):
            duplicates = sorted(example_id for example_id in set(example_ids) if example_ids.count(example_id) > 1)
            raise ValueError("Duplicate example IDs are not allowed within a run: " + ", ".join(duplicates))
        unknown_result_examples = sorted({result.row_id for result in run.metric_results if result.row_id not in set(example_ids)})
        if unknown_result_examples:
            raise ValueError("Metric results reference examples outside this run: " + ", ".join(unknown_result_examples))
        if any(result.run_id != run.run_id for result in run.metric_results):
            raise ValueError("Metric results must use the run ID being persisted")
        existing_link = None
        if existing_run is not None:
            if existing_run.experiment_id != exp_id:
                raise ValueError("A telemetry enrichment cannot move a run to another experiment")
            existing_link = await self.session.get(
                ExperimentRunLinkORM,
                (existing_run.experiment_id, run.run_id),
            )
            await self._clear_replaceable_run_snapshot(run.run_id)
        trimmed_label, normalized_labels = normalize_run_labels(label=run.label, labels=(run.labels or None))
        run.label = trimmed_label
        run.labels = normalized_labels
        if trimmed_label:
            run.experiment.tags = {
                **(run.experiment.tags or {}),
                "label": trimmed_label,
            }
        exp_orm = await self.session.get(ExperimentORM, exp_id)
        if not exp_orm:
            await self.save_experiment(run.experiment, commit=False)
        else:
            # Keep annotations / intent tags on the lineage experiment when the
            # run reuses a stable experiment id.
            incoming = dict(run.experiment.tags or {})
            if trimmed_label:
                incoming["label"] = trimmed_label
            if incoming:
                tags = dict(exp_orm.tags or {})
                tags.update(incoming)
                exp_orm.tags = tags

        run_number = existing_run.run_number if existing_run is not None and existing_run.run_number is not None else run.run_number or await self._next_run_number(exp_id)
        run.run_number = run_number

        duration_ms = run.duration_ms
        if duration_ms is None and run.completed_at and run.started_at:
            duration_ms = int((run.completed_at - run.started_at).total_seconds() * 1000)
            run.duration_ms = duration_ms

        artifact_refs = list(run.artifact_refs or [])
        report_ref = f"report://{run.run_id}"
        if report_ref not in artifact_refs:
            artifact_refs.append(report_ref)
        evidence_ref = f"evidence-pack://{run.run_id}"
        if evidence_ref not in artifact_refs:
            artifact_refs.append(evidence_ref)
        for row in evaluated_rows:
            for artifact in row.tool_result_artifacts:
                if artifact.artifact_ref not in artifact_refs:
                    artifact_refs.append(artifact.artifact_ref)
        run.artifact_refs = artifact_refs

        run_values = {
            "experiment_id": exp_id,
            "status": run.status.value,
            "verdict_status": run.verdict_status.value if run.verdict_status else None,
            "overall_gate": run.overall_gate.value if run.overall_gate else None,
            "diagnostic_only": run.diagnostic_only,
            "evidence_readiness": (run.evidence_readiness.model_dump(mode="json") if run.evidence_readiness else None),
            "evidence_capture_status": run.evidence_capture_status.value,
            "evidence_categories": [category.model_dump(mode="json") for category in run.evidence_categories],
            "active_metrics": run.active_metrics,
            "trigger_reason": run.trigger_reason.value,
            "correlation_id": run.correlation_id,
            "retry_count": run.retry_count,
            "experiment_version_id": run.experiment_version_id,
            "prompt_version": run.prompt_version,
            "lineage": run.lineage.model_dump(mode="json") if run.lineage else None,
            "started_at": run.started_at,
            "completed_at": run.completed_at,
            "run_number": run_number,
            "run_type": run.run_type.value if isinstance(run.run_type, RunType) else run.run_type,
            "created_by": run.created_by,
            "git_sha": run.git_sha,
            "build_id": run.build_id,
            "deployment_id": run.deployment_id,
            "duration_ms": duration_ms,
            "artifact_refs": artifact_refs,
            "run_manifest_id": run.run_manifest_id,
            "quality_profile_id": run.quality_profile_id,
            "quality_profile_version": run.quality_profile_version,
            "gate_policy_id": run.gate_policy_id,
            "gate_policy_version": run.gate_policy_version,
            "label": trimmed_label,
            "labels": normalized_labels,
        }
        if existing_run is None:
            self.session.add(EvaluationRunORM(run_id=run.run_id, **run_values))
        else:
            for field, value in run_values.items():
                setattr(existing_run, field, value)

        for position, row in enumerate(evaluated_rows):
            input_data = row.input_data if row.input_data is not None else {"query": row.query}
            expected_data = row.expected_data
            if expected_data is None and row.expected_response is not None:
                expected_data = {"response": row.expected_response}
            retrieval_snippets = row.retrieval_snippets if row.retrieval_snippets is not None else row.context
            evidence_ref = f"evidence-pack://{run.run_id}/items/{quote(row.row_id, safe='')}"
            self.session.add(
                EvaluationRunItemORM(
                    run_id=run.run_id,
                    example_id=row.row_id,
                    sequence_position=position,
                    dataset_version=run.experiment.dataset_version,
                    query=redact_for_persistence(row.query),
                    input_data=redact_for_persistence(input_data),
                    output_data=redact_for_persistence(row.output_data if row.output_data is not None else {"response": row.response}),
                    expected_data=redact_for_persistence(expected_data),
                    row_metadata=redact_for_persistence(row.tags),
                    retrieval_snippets=redact_for_persistence(retrieval_snippets),
                    expected_tools=redact_for_persistence(row.expected_tools),
                    tool_calls=redact_for_persistence([tool_call.model_dump(mode="json") for tool_call in row.tool_calls]),
                    tool_call_count=len(row.tool_calls),
                    invocation_id=row.invocation_id,
                    kagent_session_id=row.kagent_session_id,
                    latency_ms=row.latency_ms,
                    target_usage=redact_for_persistence(row.target_usage),
                    invocation_error=redact_for_persistence(row.invocation_error),
                    trace_id=row.trace_id,
                    span_id=row.span_id,
                    parent_span_id=row.parent_span_id,
                    trace_provider=row.trace_provider,
                    captured_at=run.completed_at,
                    evidence_ref=evidence_ref,
                    redaction_enabled=settings.payload_redaction_enabled,
                    max_persisted_string_size=settings.max_persisted_sample_chars,
                    # Externalizing a large payload is a storage decision. It
                    # does not by itself prove that evidence capture was
                    # partial; capture completeness is recorded independently.
                    capture_state="complete",
                    tool_evidence_completion_attested=row.tool_evidence_completion_attested,
                    tool_evidence_provenance_status=row.tool_evidence_provenance_status.value,
                    tool_evidence_source=row.tool_evidence_source,
                    trace_span_count=row.trace_span_count,
                    trace_completion_attested=row.trace_completion_attested,
                    model_usage_completion_attested=row.model_usage_completion_attested,
                    lifecycle_completion_attested=row.lifecycle_completion_attested,
                )
            )
            for artifact in row.tool_result_artifacts:
                content = redact_artifact_content(artifact.content, artifact.content_type)
                preview = content.encode("utf-8")[: artifact.preview_bytes].decode("utf-8", errors="ignore")
                self.session.add(
                    ToolResultArtifactORM(
                        artifact_id=artifact.artifact_id,
                        run_id=run.run_id,
                        example_id=row.row_id,
                        tool_name=artifact.tool_name,
                        tool_call_index=artifact.tool_call_index,
                        content_type=artifact.content_type,
                        content=content,
                        size_bytes=artifact.size_bytes,
                        preview=preview,
                        preview_bytes=len(preview.encode("utf-8")),
                    )
                )

        if run.experiment_version_id:
            await self._upsert_experiment_version(
                experiment_id=exp_id,
                experiment_version_id=run.experiment_version_id,
                experiment=run.experiment,
                active_metrics=run.active_metrics,
                created_by=run.created_by,
            )

        champion = await self._find_run_with_role(exp_id, RunRole.CHAMPION)
        default_role = RunRole.CHALLENGER if champion else RunRole.EXPLORATORY
        role = RunRole(existing_link.role) if existing_link is not None else run.role or default_role
        run.role = role
        if existing_link is None:
            self.session.add(
                ExperimentRunLinkORM(
                    experiment_id=exp_id,
                    run_id=run.run_id,
                    run_number=run_number,
                    role=role.value,
                )
            )

        config_id_map: dict[str, str] = {}
        for cfg in run.evaluator_configs:
            cid = str(uuid.uuid4())
            config_id_map[cfg.instance_id] = cid
            self.session.add(
                EvaluatorConfigORM(
                    config_id=cid,
                    run_id=run.run_id,
                    metric_id=cfg.metric_id,
                    adapter=cfg.adapter.value if hasattr(cfg.adapter, "value") else str(cfg.adapter),
                    adapter_class=cfg.adapter_class,
                    judge_model=cfg.judge_model,
                    scoring_type=cfg.scoring_type.value,
                    threshold_pass=cfg.threshold_pass,
                    threshold_warn=cfg.threshold_warn,
                    config_json=cfg.model_dump(mode="json"),
                )
            )

        for mr in run.metric_results:
            self.session.add(
                MetricResultORM(
                    result_id=str(uuid.uuid4()),
                    run_id=run.run_id,
                    metric_id=mr.metric_id,
                    evaluator_config_id=config_id_map.get(mr.evaluator_instance_id, mr.evaluator_instance_id),
                    row_id=mr.row_id,
                    metric_requirement=mr.metric_requirement.value,
                    metric_requirement_source=(mr.metric_requirement_source.value if mr.metric_requirement_source else None),
                    metric_applicability=mr.metric_applicability.value,
                    metric_status=mr.metric_status.value if mr.metric_status else None,
                    unscored_reason=mr.unscored_reason.value if mr.unscored_reason else None,
                    error_details=mr.error_details,
                    score=mr.score,
                    normalised_score=mr.normalised_score,
                    label=mr.label,
                    passed=mr.passed,
                    threshold_result=(mr.threshold_result.value if mr.threshold_result else None),
                    rationale=mr.rationale,
                    error_message=mr.error_message,
                    threshold=mr.threshold,
                    prompt_version=mr.prompt_version,
                    judge_prompt_tokens=mr.judge_prompt_tokens,
                    judge_completion_tokens=mr.judge_completion_tokens,
                    judge_total_tokens=mr.judge_total_tokens,
                    judge_model=mr.judge_model,
                    subject_kind=mr.subject_kind.value if mr.subject_kind is not None else None,
                    trace_id=mr.trace_id,
                    span_id=mr.span_id,
                    target_trace_id=mr.target_trace_id,
                    target_span_id=mr.target_span_id,
                    evaluator_trace_id=mr.evaluator_trace_id,
                    evaluator_span_id=mr.evaluator_span_id,
                    feedback_scope=mr.feedback_scope,
                    annotator_kind=mr.annotator_kind,
                    evaluation_identifier=mr.evaluation_identifier,
                    dataset_version=mr.dataset_version,
                    sample_input=redact_for_persistence(mr.sample_input),
                    sample_output=redact_for_persistence(mr.sample_output),
                    evaluator_id=mr.evaluator_id,
                    evaluator_version=mr.evaluator_version,
                    execution_status=mr.execution_status,
                    execution_metadata=mr.execution_metadata,
                    requested_scorer=mr.requested_scorer,
                    executed_scorer=mr.executed_scorer,
                    evaluated_at=mr.timestamp,
                )
            )

        for kr in run.kpi_results:
            self.session.add(
                KpiResultORM(
                    result_id=str(uuid.uuid4()),
                    run_id=run.run_id,
                    kpi_id=kr.kpi_id,
                    composite_score=kr.composite_score,
                    gate_result=kr.gate_result.value if kr.gate_result else None,
                    observed_score=kr.observed_score,
                    constituent_scores=[c.model_dump() for c in kr.constituent_scores],
                    threshold_pass=kr.threshold_pass,
                    threshold_warn=kr.threshold_warn,
                    threshold_fail=kr.threshold_fail,
                    dataset_version=kr.dataset_version,
                    evaluated_target=kr.evaluated_target,
                    required_applicable_pair_count=kr.required_applicable_pair_count,
                    required_scored_count=kr.required_scored_count,
                    required_unscored_count=kr.required_unscored_count,
                    required_technical_error_count=kr.required_technical_error_count,
                    required_coverage_percentage=kr.required_coverage_percentage,
                    coverage_label=kr.coverage_label.value if kr.coverage_label else None,
                    optional_applicable_pair_count=kr.optional_applicable_pair_count,
                    optional_scored_count=kr.optional_scored_count,
                    optional_coverage_percentage=kr.optional_coverage_percentage,
                    computed_at=kr.timestamp,
                )
            )

        # Findings are immutable review snapshots, independent of calculated rows.
        finding_snapshots: dict[str, list[FindingORM]] = {}
        for previous in (await self.session.scalars(
            select(FindingORM).where(FindingORM.run_id == run.run_id)
        )).all():
            finding_snapshots.setdefault(previous.row_id, []).append(previous)
        for rq in run.review_queue:
            self.session.add(
                ReviewQueueORM(
                    id=str(uuid.uuid4()),
                    run_id=run.run_id,
                    row_id=rq.row_id,
                    query=redact_for_persistence(rq.query),
                    response=redact_for_persistence(rq.response),
                    trace_id=rq.trace_id,
                    failing_metrics=rq.failing_metrics,
                    gate_result=rq.gate_result.value,
                    rationale=rq.rationale,
                )
            )
            finding_id = str(uuid.uuid4())
            severity = Severity.CRITICAL if rq.gate_result == GateResult.FAIL else Severity.MEDIUM
            finding = FindingORM(
                finding_id=finding_id,
                run_id=run.run_id,
                experiment_id=exp_id,
                row_id=rq.row_id,
                metric_ids=rq.failing_metrics,
                gate_result=rq.gate_result.value,
                severity=severity.value,
                root_cause_category=run.root_cause.root_cause_label if run.root_cause else None,
                evidence=redact_for_persistence(
                    {
                        "trace_id": rq.trace_id,
                        "rationale": rq.rationale,
                        "query": rq.query,
                        "response": rq.response,
                        # Score against threshold, per failing metric. Without it
                        # the review sheet can name the checks that failed but
                        # not say by how much, which is what a reviewer decides on.
                        "failing_metric_details": [
                            detail.model_dump(mode="json")
                            for detail in rq.failing_metric_details
                        ],
                    }
                ),
            )
            # A retry with unchanged evidence reuses the same historical finding.
            # Changed evidence gets a new task without rewriting an earlier verdict.
            if any(
                all(getattr(previous, key) == getattr(finding, key) for key in
                    ("row_id", "metric_ids", "gate_result", "severity", "root_cause_category", "evidence"))
                for previous in finding_snapshots.get(rq.row_id, [])
            ):
                continue
            self.session.add(finding)
            finding_snapshots.setdefault(rq.row_id, []).append(finding)
            self.session.add(
                ReviewTaskORM(
                    finding_id=finding_id,
                    tenant_id=run.experiment.tenant_id,
                    status=FindingStatus.OPEN.value,
                )
            )

        if run.root_cause:
            rc = run.root_cause
            self.session.add(
                RootCauseORM(
                    id=str(uuid.uuid4()),
                    run_id=run.run_id,
                    root_cause_metric_id=rc.root_cause_metric_id,
                    root_cause_label=rc.root_cause_label,
                    causal_chain=rc.causal_chain,
                    failing_metrics=rc.failing_metrics,
                    recommended_remediation=rc.recommended_remediation,
                    has_ground_truth=rc.has_ground_truth,
                )
            )

        self.session.add(
            EvidencePackORM(
                evidence_pack_id=str(uuid.uuid4()),
                run_id=run.run_id,
                experiment_id=exp_id,
                overall_gate=run.overall_gate.value if run.overall_gate else None,
                manifest_id=run.run_manifest_id,
                contents={
                    "metric_result_count": sum(result.subject_kind in (None, "case") for result in run.metric_results),
                    "run_item_count": len(evaluated_rows),
                    "kpi_result_count": len(run.kpi_results),
                    "review_queue_count": len(run.review_queue),
                    "experiment_version_id": run.experiment_version_id,
                    "artifact_refs": artifact_refs,
                },
            )
        )

        if job is not None:
            writable_statuses = [
                RunStatus.PENDING.value,
                RunStatus.RUNNING.value,
                RunStatus.AWAITING_TRACE.value,
            ]
            if allow_completed_telemetry_refresh and not finalize_job:
                writable_statuses.append(RunStatus.COMPLETED.value)
            # Guard partial publication too: a stopped worker may finish after
            # ownership expires. A no-op update locks/checks the current job
            # atomically without changing its nonfinal workflow state.
            transition = await self.session.execute(
                update(RunJobORM)
                .where(
                    RunJobORM.run_id == run.run_id,
                    RunJobORM.status.in_(writable_statuses),
                )
                .values(status=RunStatus.COMPLETED.value if finalize_job else RunJobORM.status)
            )
            if not transition.rowcount:
                await self.session.rollback()
                raise RunCancelledError(f"Run {run.run_id} was stopped")
        await self.session.commit()
        emit(
            EvalEvent.METRICS_PERSISTED,
            correlation_id=run.correlation_id or run.run_id,
            run_id=run.run_id,
            metric_results=len(run.metric_results),
            kpi_results=len(run.kpi_results),
        )
        return run

    async def _clear_replaceable_run_snapshot(self, run_id: str) -> None:
        """Remove derived rows before replacing one partial run snapshot."""

        # Findings, review tasks, and their human records are append-only.
        for model, predicate in (
            (ToolResultArtifactORM, ToolResultArtifactORM.run_id == run_id),
            (EvaluationRunItemORM, EvaluationRunItemORM.run_id == run_id),
            (EvaluatorConfigORM, EvaluatorConfigORM.run_id == run_id),
            (MetricResultORM, MetricResultORM.run_id == run_id),
            (KpiResultORM, KpiResultORM.run_id == run_id),
            (ReviewQueueORM, ReviewQueueORM.run_id == run_id),
            (RootCauseORM, RootCauseORM.run_id == run_id),
            (EvidencePackORM, EvidencePackORM.run_id == run_id),
        ):
            await self.session.execute(delete(model).where(predicate))
        await self.session.flush()

    async def record_telemetry_enrichment(
        self,
        run_id: str,
        *,
        enrichment_run_id: str,
    ) -> None:
        """Record completion of late telemetry enrichment on the durable job."""

        job = await self.session.get(RunJobORM, run_id)
        if job is None:
            return
        params = dict(job.params or {})
        snapshot = dict(params.get("telemetry_score_snapshot") or {})
        snapshot["enrichment_run_id"] = enrichment_run_id
        snapshot["enriched_at"] = datetime.now(UTC).isoformat()
        snapshot["identity_preserved"] = enrichment_run_id == run_id
        params["telemetry_score_snapshot"] = snapshot
        params["telemetry_enrichment_run_id"] = enrichment_run_id
        job.params = params
        await self.session.commit()

    async def list_run_items(self, run_id: str, tenant_id: str | None = None) -> list[RunItemSummary]:
        """Return ordered run-item summaries, reconstructing legacy rows if needed.

        When ``tenant_id`` is provided the run must belong to that tenant; a
        cross-tenant run id yields an empty list rather than another tenant's
        evidence.
        """
        if tenant_id is not None and not await self.run_exists(run_id, tenant_id):
            return []
        item_result = await self.session.execute(
            select(
                EvaluationRunItemORM.run_id,
                EvaluationRunItemORM.example_id,
                EvaluationRunItemORM.query,
                EvaluationRunItemORM.sequence_position,
                EvaluationRunItemORM.dataset_version,
                EvaluationRunItemORM.latency_ms,
                EvaluationRunItemORM.trace_id,
                EvaluationRunItemORM.evidence_ref,
                EvaluationRunItemORM.invocation_error,
                EvaluationRunItemORM.capture_state,
            )
            .where(EvaluationRunItemORM.run_id == run_id)
            .order_by(EvaluationRunItemORM.sequence_position.asc())
        )
        items = [_RunItemListRecord(*row) for row in item_result.all()]

        if items:
            artifact_result = await self.session.execute(
                select(
                    ToolResultArtifactORM.example_id,
                    func.count(ToolResultArtifactORM.artifact_id),
                )
                .where(ToolResultArtifactORM.run_id == run_id)
                .group_by(ToolResultArtifactORM.example_id)
            )
            artifact_counts = dict(artifact_result.all())
            metric_summaries = await self._metric_summaries_for_run(run_id)
            metrics_by_example = {summary.example_id: summary for summary in metric_summaries}
            return [
                _run_item_summary(
                    item,
                    metrics_by_example.get(item.example_id),
                    artifact_counts.get(item.example_id, 0),
                )
                for item in items
            ]

        metric_summaries = await self._metric_summaries_for_run(run_id)
        summaries: list[RunItemSummary] = []
        for position, metric_summary in enumerate(metric_summaries):
            example_id = metric_summary.example_id
            summaries.append(
                RunItemSummary(
                    run_id=run_id,
                    example_id=example_id,
                    query=metric_summary.sample_query,
                    sequence_position=position,
                    dataset_version=metric_summary.dataset_version,
                    worst_gate=metric_summary.worst_gate,
                    metric_count=metric_summary.metric_count,
                    failing_count=metric_summary.failing_count,
                    failing_optional_count=metric_summary.failing_optional_count,
                    error_count=metric_summary.error_count,
                    scored_count=metric_summary.scored_count,
                    unscored_count=metric_summary.unscored_count,
                    unscored_required_count=metric_summary.unscored_required_count,
                    not_applicable_count=metric_summary.not_applicable_count,
                    evaluation_state=("technical_error" if metric_summary.error_count > 0 else "evaluated"),
                    latency_ms=None,
                    # A scorer trace identifier on a legacy result is not proof
                    # of a captured target-execution trace.
                    trace_available=False,
                    evidence_ref=(f"evidence-pack://{run_id}/items/{quote(example_id, safe='')}"),
                    capture_state="unknown",
                )
            )
        return summaries

    async def get_run_item(self, run_id: str, example_id: str, tenant_id: str | None = None) -> RunItemDetail | None:
        """Return complete item evidence or a conservative legacy reconstruction.

        When ``tenant_id`` is provided the owning run must belong to that tenant;
        otherwise ``None`` is returned so items never leak across tenants.
        """
        if tenant_id is not None and not await self.run_exists(run_id, tenant_id):
            return None
        item = await self.session.get(EvaluationRunItemORM, (run_id, example_id))
        if item:
            metrics = await self._metric_results_for_run(run_id, example_id)
            artifacts = await self._tool_result_artifacts_for_item(run_id, example_id)
            return _run_item_detail(item, metrics, artifacts)

        metrics = await self._metric_results_for_run(run_id, example_id)
        if not metrics:
            return None
        metric_summaries = await self._metric_summaries_for_run(run_id)
        sequence_position = next(
            (position for position, summary in enumerate(metric_summaries) if summary.example_id == example_id),
            0,
        )
        return _legacy_run_item_detail(run_id, example_id, sequence_position, metrics)

    async def _tool_result_artifacts_for_item(self, run_id: str, example_id: str) -> list[ToolResultArtifactReference]:
        result = await self.session.execute(
            select(ToolResultArtifactORM)
            .where(
                ToolResultArtifactORM.run_id == run_id,
                ToolResultArtifactORM.example_id == example_id,
            )
            .order_by(ToolResultArtifactORM.tool_call_index.asc())
        )
        return [_artifact_reference(artifact) for artifact in result.scalars().all()]

    async def get_tool_result_artifact(
        self,
        run_id: str,
        example_id: str,
        artifact_id: str,
        *,
        offset: int = 0,
        limit: int = 131_072,
        tenant_id: str | None = None,
    ) -> ToolResultArtifactPage | None:
        if tenant_id is not None and not await self.run_exists(run_id, tenant_id):
            return None
        artifact = await self.session.get(ToolResultArtifactORM, artifact_id)
        if artifact is None or artifact.run_id != run_id or artifact.example_id != example_id:
            return None
        encoded = artifact.content.encode("utf-8")
        bounded_offset = max(0, min(offset, len(encoded)))
        while bounded_offset < len(encoded) and encoded[bounded_offset] & 0b1100_0000 == 0b1000_0000:
            bounded_offset += 1
        bounded_limit = max(1, min(limit, settings.artifact_page_max_bytes))
        end = min(len(encoded), bounded_offset + bounded_limit)
        while end > bounded_offset:
            try:
                content = encoded[bounded_offset:end].decode("utf-8")
                break
            except UnicodeDecodeError:
                end -= 1
        else:
            content = ""
        return ToolResultArtifactPage(
            artifact=_artifact_reference(artifact),
            offset=bounded_offset,
            limit=bounded_limit,
            content=content,
            next_offset=end if end < len(encoded) else None,
            complete=end >= len(encoded),
        )

    async def _metric_summaries_for_run(self, run_id: str) -> list[_RunItemMetricSummary]:
        """Select one compact, aggregated scorer row per evaluated example."""
        partition = MetricResultORM.row_id
        ordering = (
            MetricResultORM.evaluated_at.asc(),
            MetricResultORM.result_id.asc(),
        )
        # A case answers for what was REQUIRED of it, the same rule the run
        # verdict already uses (KPI compositions + hard blockers, both
        # requirement-aware). Ranking every metric equally let one failing
        # optional diagnostic — nlp.bleu scoring 0.03 against a 0.8 threshold it
        # cannot reach on free text — mark the case Fail, so a run could read
        # Pass while every one of its cases read Fail. Both numbers were right
        # by their own rule and the pair was nonsense.
        is_required = MetricResultORM.metric_requirement == MetricRequirement.REQUIRED.value
        gate_rank = case(
            (is_required & (MetricResultORM.threshold_result == GateResult.FAIL.value), 2),
            (is_required & (MetricResultORM.threshold_result == GateResult.WARN.value), 1),
            (is_required & (MetricResultORM.threshold_result == GateResult.PASS.value), 0),
            else_=None,
        )
        failing = case(
            (is_required & (MetricResultORM.threshold_result == GateResult.FAIL.value), 1),
            else_=0,
        )
        # Not hidden, just not a verdict. A reader still sees that a diagnostic
        # scored badly; it no longer decides whether the case passed.
        failing_optional = case(
            (
                (MetricResultORM.metric_requirement != MetricRequirement.REQUIRED.value)
                & (MetricResultORM.threshold_result == GateResult.FAIL.value),
                1,
            ),
            else_=0,
        )
        has_error = case(
            (MetricResultORM.metric_status == MetricStatus.TECHNICAL_ERROR.value, 1),
            else_=0,
        )
        is_scored = case(
            (MetricResultORM.metric_status == MetricStatus.SCORED.value, 1),
            else_=0,
        )
        is_unscored = case(
            (MetricResultORM.metric_status == MetricStatus.UNSCORED.value, 1),
            else_=0,
        )
        # Unscored counts, split the same way the verdict is. A provided-response
        # run cannot measure latency or token usage — five optional metrics with
        # nothing to measure — and counting those made every case read
        # "Partially scored", which hid the cases where a REQUIRED metric
        # actually failed. Coverage of the optional set is worth reporting; it is
        # not what decides whether a case was answered.
        is_unscored_required = case(
            (
                is_required & (MetricResultORM.metric_status == MetricStatus.UNSCORED.value),
                1,
            ),
            else_=0,
        )
        is_not_applicable = case(
            (
                MetricResultORM.metric_applicability == MetricApplicability.NOT_APPLICABLE.value,
                1,
            ),
            else_=0,
        )
        columns = [
            MetricResultORM.row_id.label("example_id"),
            MetricResultORM.dataset_version,
            MetricResultORM.sample_input["query"].as_string().label("sample_query"),
            MetricResultORM.evaluated_at,
            MetricResultORM.result_id,
            func.row_number().over(partition_by=partition, order_by=ordering).label("example_row_number"),
            func.count().over(partition_by=partition).label("metric_count"),
            func.sum(failing).over(partition_by=partition).label("failing_count"),
            func.sum(failing_optional).over(partition_by=partition).label("failing_optional_count"),
            func.sum(has_error).over(partition_by=partition).label("error_count"),
            func.sum(is_scored).over(partition_by=partition).label("scored_count"),
            func.sum(is_unscored).over(partition_by=partition).label("unscored_count"),
            func.sum(is_unscored_required).over(partition_by=partition).label("unscored_required_count"),
            func.sum(is_not_applicable).over(partition_by=partition).label("not_applicable_count"),
            func.max(gate_rank).over(partition_by=partition).label("worst_gate_rank"),
        ]
        ranked = select(*columns).where(MetricResultORM.run_id == run_id, (MetricResultORM.subject_kind.is_(None) | (MetricResultORM.subject_kind == "case"))).subquery()
        result = await self.session.execute(select(ranked).where(ranked.c.example_row_number == 1).order_by(ranked.c.evaluated_at.asc(), ranked.c.result_id.asc()))
        gate_by_rank = {
            0: GateResult.PASS,
            1: GateResult.WARN,
            2: GateResult.FAIL,
        }
        return [
            _RunItemMetricSummary(
                example_id=row.example_id,
                dataset_version=row.dataset_version,
                sample_query=row.sample_query,
                # Withheld only when something REQUIRED went unmeasured. Keyed
                # on total unscored, a provided-response run — where five
                # optional ops metrics can never be measured — reported no gate
                # for any case, so every row read "Not recorded" while the case
                # itself showed Fail and its own failing metric.
                worst_gate=(
                    gate_by_rank[int(row.worst_gate_rank)]
                    if row.worst_gate_rank is not None
                    and int(row.unscored_required_count) == 0
                    and int(row.error_count) == 0
                    else None
                ),
                metric_count=int(row.metric_count),
                failing_count=int(row.failing_count),
                failing_optional_count=int(row.failing_optional_count),
                error_count=int(row.error_count),
                scored_count=int(row.scored_count),
                unscored_count=int(row.unscored_count),
                unscored_required_count=int(row.unscored_required_count),
                not_applicable_count=int(row.not_applicable_count),
            )
            for row in result
        ]

    async def _metric_results_for_run(self, run_id: str, example_id: str | None = None) -> list[MetricResult]:
        query = select(MetricResultORM).where(MetricResultORM.run_id == run_id, (MetricResultORM.subject_kind.is_(None) | (MetricResultORM.subject_kind == "case")))
        if example_id is not None:
            query = query.where(MetricResultORM.row_id == example_id)
        result = await self.session.execute(
            query.order_by(
                MetricResultORM.evaluated_at.asc(),
                MetricResultORM.result_id.asc(),
            )
        )
        return [_metric_result_from_orm(metric) for metric in result.scalars().all()]

    async def run_exists(self, run_id: str, tenant_id: str | None = None) -> bool:
        """Check run existence without hydrating the full report graph.

        When ``tenant_id`` is provided the run only "exists" for that tenant,
        i.e. the owning experiment must belong to it. This keeps cross-tenant
        run-item reads from confirming another tenant's run ids.
        """
        if tenant_id is None:
            return await self.session.get(EvaluationRunORM, run_id) is not None
        result = await self.session.execute(
            select(EvaluationRunORM.run_id)
            .join(
                ExperimentORM,
                ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
            )
            .where(
                EvaluationRunORM.run_id == run_id,
                # Same value-space as ``get_run``: the spellings tenants_match
                # accepts, not one literal spelling.
                ExperimentORM.tenant_id.in_(tenant_id_candidates(tenant_id)),
            )
        )
        return result.first() is not None

    async def get_run(self, run_id: str, tenant_id: str | None = None) -> RunResult | None:
        """Load a full run.

        When ``tenant_id`` is provided the run is scoped to that tenant's
        experiments in SQL, so a caller can never read another tenant's run.

        The scope is the same value-space attachment uses (``tenants_match``):
        a workspace stored as ``tenant-x`` owns runs whose experiment is stored
        as ``x`` and vice versa, so ``IN`` over ``tenant_id_candidates`` rather
        than ``==`` on one spelling. The candidate set is exactly the spellings
        ``tenants_match`` accepts, so a genuinely foreign tenant is still
        unreadable.
        """
        stmt = select(EvaluationRunORM).where(EvaluationRunORM.run_id == run_id)
        if tenant_id is not None:
            stmt = stmt.join(
                ExperimentORM,
                ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
            ).where(ExperimentORM.tenant_id.in_(tenant_id_candidates(tenant_id)))
        result = await self.session.execute(
            stmt.options(
                selectinload(EvaluationRunORM.experiment),
                selectinload(EvaluationRunORM.evaluator_configs),
                selectinload(EvaluationRunORM.metric_results),
                selectinload(EvaluationRunORM.kpi_results),
                selectinload(EvaluationRunORM.review_queue),
                selectinload(EvaluationRunORM.root_cause),
            )
        )
        orm = result.scalar_one_or_none()
        if not orm:
            return None
        run = _run_from_orm(orm)
        link = await self.session.get(ExperimentRunLinkORM, (orm.experiment_id, orm.run_id))
        if link:
            run.role = RunRole(link.role)
        return run

    async def list_runs(self, limit: int = 50, tenant_id: str | None = None) -> list[RunResult]:
        """List recent runs, scoped to ``tenant_id``'s experiments when provided."""
        stmt = select(EvaluationRunORM)
        if tenant_id is not None:
            stmt = stmt.join(ExperimentORM).where(tenant_clause(ExperimentORM, tenant_id))
        return await self._load_runs(stmt.order_by(EvaluationRunORM.started_at.desc()).limit(limit))

    # Usage-dashboard windows: span + the bucket granularity that follows it.
    # Granularity is derived, never a caller-facing knob (#3334 v2).
    _USAGE_WINDOW_MAP = {
        "24h": (timedelta(hours=24), "hour"),
        "7d": (timedelta(days=7), "day"),
        "30d": (timedelta(days=30), "day"),
        "90d": (timedelta(days=90), "day"),
    }
    _USAGE_TOP_N = 5

    async def usage_overview(
        self,
        tenant_id: str,
        *,
        days: int = 30,
        window: str | None = None,
        target_model: str | None = None,
    ) -> dict:
        """Aggregate evaluation activity for the usage dashboard (#3334).

        Covers evaluation traffic Eval Hub itself recorded: completed runs from
        ``evaluation_runs`` (scoped through their experiment's tenant), failed
        launches from ``run_jobs`` (a failed job never becomes a run row), and
        per-case latency/token evidence from ``evaluation_run_items``. Rows are
        fetched narrow and bucketed in Python — the service has no portable
        ``date_trunc`` precedent and local volumes are thousands of rows, not
        millions. Missing measurements stay ``None``: a bucket with runs but no
        priceable model reports a null cost, never zero.

        ``window`` ("24h" | "7d" | "30d" | "90d") wins over ``days`` when given;
        "24h" buckets by hour, the rest by day — granularity follows the window,
        it is never a caller-facing knob. The response also carries
        ``previous_totals`` (the same aggregation shifted back by exactly the
        span — equal elapsed length, never overlapping; up to one bucket
        between the windows belongs to neither, the price of comparability)
        and top-N breakdowns. Every breakdown follows the selected model filter.
        """
        if window is not None and window not in self._USAGE_WINDOW_MAP:
            raise ValueError(f"unknown usage window: {window!r}")
        if window is not None:
            window_key = window
            span, bucket_kind = self._USAGE_WINDOW_MAP[window]
        else:
            clamped = max(1, min(int(days), 90))
            window_key = f"{clamped}d"
            span, bucket_kind = timedelta(days=clamped), "day"

        now = datetime.now(UTC)
        # Anchored to the start of the earliest bucket, so the query window and
        # the buckets cover exactly the same instants and totals equal the sum
        # of the buckets by construction.
        if bucket_kind == "hour":
            since = now.replace(minute=0, second=0, microsecond=0) - (span - timedelta(hours=1))
        else:
            since = datetime.combine((now - (span - timedelta(days=1))).date(), time_of_day.min, tzinfo=UTC)
        tenants = tenant_id_candidates(tenant_id)

        # until=now (not open-ended) so the fetched rows and the bucket range
        # are bounded by the same instant — the totals == sum(buckets)
        # invariant cannot be raced by a row landing microseconds past `now`.
        current = await self._usage_aggregate(
            tenants, since=since, until=now, now=now, bucket_kind=bucket_kind, target_model=target_model
        )
        # Shifted back by exactly the span, ending at now - span: the previous
        # window covers the same elapsed length as the (in-progress) current
        # one, so deltas compare like against like instead of a partial period
        # against a complete one.
        previous = await self._usage_aggregate(
            tenants, since=since - span, until=now - span, now=now, bucket_kind=bucket_kind,
            target_model=target_model, with_buckets=False,
        )
        breakdowns = await self._usage_breakdowns(
            tenants, since=since, until=now, target_model=target_model, current=current
        )

        return {
            "window": window_key,
            "window_days": max(1, round(span.total_seconds() / 86_400)),
            "bucket": bucket_kind,
            "target_model": target_model,
            "models": current["models"],
            "totals": current["totals"],
            "previous_totals": previous["totals"],
            "days": current["buckets"],
            "recent_runs": current["recent_runs"],
            "failed_launches": current["failed_launches"],
            **breakdowns,
        }

    async def _usage_aggregate(
        self,
        tenants: Sequence[str],
        *,
        since: datetime,
        until: datetime | None,
        now: datetime,
        bucket_kind: str,
        target_model: str | None,
        with_buckets: bool = True,
    ) -> dict:
        """One usage-window aggregation pass. See ``usage_overview`` for rules."""
        # Local to avoid a store->evaluation import at module load; neither
        # module imports the store back, so this is caution, not a cycle.
        from evalhub.evaluation.adapters.deterministic_adapter import usage_field_value
        from evalhub.tracing.cost import estimate_tokens_cost_usd

        def _bucket_key(moment: datetime) -> str:
            # A naive datetime.astimezone(UTC) assumes the LOCAL system
            # timezone, not UTC — the same class of bug the trace-window
            # helper below already guards against. Reuse it instead of
            # trusting astimezone to convert a naive value correctly.
            aware = _normalize_trace_window_bound(moment)
            if bucket_kind == "hour":
                return aware.strftime("%Y-%m-%dT%H:00")
            return aware.date().isoformat()

        run_query = (
            select(
                EvaluationRunORM.run_id,
                EvaluationRunORM.started_at,
                ExperimentORM.target_version,
                ExperimentORM.name,
                ExperimentORM.dataset_version,
                EvaluationRunORM.status,
            )
            .join(ExperimentORM, ExperimentORM.experiment_id == EvaluationRunORM.experiment_id)
            .where(ExperimentORM.tenant_id.in_(tenants), EvaluationRunORM.started_at >= since)
        )
        if until is not None:
            run_query = run_query.where(EvaluationRunORM.started_at < until)
        all_runs = (await self.session.execute(run_query)).all()

        # A user cancelling a run is a decision, not a reliability signal, so
        # cancelled jobs are not failures here.
        job_query = select(
            RunJobORM.run_id, RunJobORM.created_at, RunJobORM.params,
            RunJobORM.dataset_name, RunJobORM.status,
        ).where(
            RunJobORM.kind == "eval",
            RunJobORM.tenant_id.in_(tenants),
            RunJobORM.created_at >= since,
            RunJobORM.status.in_(["failed", "blocked"]),
        )
        if until is not None:
            job_query = job_query.where(RunJobORM.created_at < until)
        all_jobs = (await self.session.execute(job_query)).all()
        # A deferred run can complete a run row and later fail its job; counting
        # both sides would put one attempt in the numerator and denominator.
        run_id_set = {run.run_id for run in all_runs}
        all_jobs = [job for job in all_jobs if job.run_id not in run_id_set]

        # The model list is derived before filtering, so choosing a model never
        # collapses the dropdown to the current selection.
        model_names = sorted(
            {run.target_version for run in all_runs if run.target_version}
            | {(job.params or {}).get("target_model") for job in all_jobs if (job.params or {}).get("target_model")}
        )
        runs = [run for run in all_runs if not target_model or run.target_version == target_model]
        jobs = [job for job in all_jobs if not target_model or (job.params or {}).get("target_model") == target_model]

        # Items join through their run's experiment rather than an IN-list of
        # run ids: a busy 90-day window would otherwise exceed bind-parameter
        # limits. The model filter is applied through run membership below.
        item_query = (
            select(
                EvaluationRunItemORM.run_id,
                EvaluationRunItemORM.latency_ms,
                EvaluationRunItemORM.target_usage,
            )
            .join(EvaluationRunORM, EvaluationRunORM.run_id == EvaluationRunItemORM.run_id)
            .join(ExperimentORM, ExperimentORM.experiment_id == EvaluationRunORM.experiment_id)
            .where(ExperimentORM.tenant_id.in_(tenants), EvaluationRunORM.started_at >= since)
        )
        if until is not None:
            item_query = item_query.where(EvaluationRunORM.started_at < until)
        items = (await self.session.execute(item_query)).all()

        run_day = {run.run_id: _bucket_key(run.started_at) for run in runs if run.started_at}

        def _day_bucket() -> dict:
            return {
                "runs": 0,
                "failed_runs": 0,
                "cases": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "latencies": [],
                "cost": None,
                "unpriced_cases": 0,
                "cases_without_usage": 0,
                "prompt_measured_cases": 0,
                "completion_measured_cases": 0,
            }

        buckets: dict[str, dict] = {}
        if with_buckets:
            # Every bucket in the window exists, so a quiet hour/day is a
            # genuine zero-run period rather than a hole the chart could misread.
            # `now` is the same instant the window was anchored to, so the
            # bucket range always covers every fetched row — which is what
            # keeps the totals == sum(buckets) invariant safe below.
            step = timedelta(hours=1) if bucket_kind == "hour" else timedelta(days=1)
            count = int((until or now).timestamp() - since.timestamp()) // int(step.total_seconds()) + 1
            for offset in range(count):
                buckets[_bucket_key(since + step * offset)] = _day_bucket()

        for run in runs:
            key = run_day.get(run.run_id)
            if key in buckets:
                buckets[key]["runs"] += 1
        for job in jobs:
            key = _bucket_key(job.created_at) if job.created_at else None
            if key in buckets:
                buckets[key]["failed_runs"] += 1

        totals = _day_bucket()
        totals["runs"] = len(runs)
        totals["failed_runs"] = len(jobs)

        # Rank the same filtered population as the charts. Use the configured
        # model for grouping and the provider-reported variant only for pricing.
        all_run_model = {run.run_id: run.target_version for run in all_runs}
        model_rollup: dict[str, dict] = {}

        def _rollup_row(model: str) -> dict:
            return model_rollup.setdefault(
                model, {"runs": 0, "cases": 0, "tokens": 0, "unpriced_cases": 0, "estimated_cost_usd": None}
            )

        if with_buckets:
            for run in runs:
                if run.target_version:
                    _rollup_row(run.target_version)["runs"] += 1

        for item in items:
            usage = item.target_usage if isinstance(item.target_usage, dict) else {}
            prompt = usage_field_value(usage, "prompt_tokens", "input_tokens", "prompt_token_count")
            completion = usage_field_value(usage, "output_tokens", "completion_tokens", "candidates_token_count")
            cost = estimate_tokens_cost_usd(
                usage.get("model") or all_run_model.get(item.run_id),
                int(prompt) if prompt is not None else None,
                int(completion) if completion is not None else None,
            ) if prompt is not None and completion is not None else None

            if with_buckets and item.run_id in run_day:
                rollup_model = all_run_model.get(item.run_id)
                if rollup_model:
                    row = _rollup_row(rollup_model)
                    row["cases"] += 1
                    row["tokens"] += int(prompt or 0) + int(completion or 0)
                    if cost is None:
                        row["unpriced_cases"] += 1
                    else:
                        row["estimated_cost_usd"] = (row["estimated_cost_usd"] or 0.0) + cost

            if item.run_id not in run_day:
                continue
            # In the with_buckets pass every fetched item's bucket exists (the
            # range is built from the same `now` the rows were bounded by), so
            # the None branch only fires in the totals-only previous pass —
            # the totals == sum(buckets) invariant is not at risk here.
            bucket = buckets.get(run_day[item.run_id])
            targets = [totals] if bucket is None else [bucket, totals]
            for target in targets:
                target["cases"] += 1
            if item.latency_ms is not None:
                for target in targets:
                    target["latencies"].append(item.latency_ms)
            if prompt is None and completion is None:
                # A case with no recorded usage is counted, never zeroed into
                # the token totals — the same honesty rule cost follows.
                for target in targets:
                    target["cases_without_usage"] += 1
            for target in targets:
                target["prompt_measured_cases"] += int(prompt is not None)
                target["completion_measured_cases"] += int(completion is not None)
                target["prompt_tokens"] += int(prompt or 0)
                target["completion_tokens"] += int(completion or 0)
                if cost is None:
                    target["unpriced_cases"] += 1
                else:
                    target["cost"] = (target["cost"] or 0.0) + cost

        def _percentile(values: list, fraction: float) -> int | None:
            if not values:
                return None
            if len(values) == 1:
                return int(values[0])
            cuts = quantiles(sorted(values), n=100, method="inclusive")
            return round(cuts[max(0, min(98, round(fraction * 100) - 1))])

        def _finish(bucket: dict) -> dict:
            latencies = bucket.pop("latencies")
            bucket["latency_ms_p50"] = _percentile(latencies, 0.50)
            bucket["latency_ms_p90"] = _percentile(latencies, 0.90)
            cost = bucket.pop("cost")
            bucket["estimated_cost_usd"] = round(cost, 6) if cost is not None else None
            return bucket

        return {
            "recent_runs": [
                {"run_id": run.run_id, "name": run.name, "dataset": run.dataset_version,
                 "model": run.target_version, "status": run.status,
                 "started_at": run.started_at.isoformat()}
                for run in sorted(runs, key=lambda run: (run.started_at, run.run_id), reverse=True)[:8]
            ] if with_buckets else [],
            "failed_launches": [
                {"run_id": job.run_id, "name": job.dataset_name, "dataset": job.dataset_name,
                 "model": (job.params or {}).get("target_model"), "status": job.status,
                 "started_at": job.created_at.isoformat()}
                for job in sorted(jobs, key=lambda job: (job.created_at, job.run_id), reverse=True)[:5]
            ] if with_buckets else [],
            "models": model_names,
            "totals": _finish(totals),
            "buckets": [{"date": key, **_finish(bucket)} for key, bucket in sorted(buckets.items())],
            "model_rollup": model_rollup,
            # For the breakdowns' deferred-job dedup — same rule as run_id_set above.
            "run_ids": {run.run_id for run in all_runs},
        }

    async def _usage_breakdowns(
        self, tenants: Sequence[str], *, since: datetime, until: datetime,
        target_model: str | None, current: dict,
    ) -> dict:
        """Top-N lists sharing the dashboard's time and target-model filters."""
        top_models = sorted(
            (
                {**row, "name": name, "estimated_cost_usd": (
                    round(row["estimated_cost_usd"], 6) if row["estimated_cost_usd"] is not None else None
                )}
                for name, row in current["model_rollup"].items()
            ),
            key=lambda row: (-row["cases"], -row["runs"], row["name"]),
        )

        # Dataset/agent lists count ATTEMPTS from run_jobs across every status
        # — a different denominator from the completed-runs headline, so the
        # field names say so. A deferred job whose run row exists is not a
        # failure here either (same dedup rule as the aggregate pass), and a
        # cancelled attempt is a decision, not a failure.
        run_ids: set = current["run_ids"]
        job_query = select(RunJobORM.run_id, RunJobORM.dataset_name, RunJobORM.agent, RunJobORM.status).where(
            RunJobORM.kind == "eval",
            RunJobORM.tenant_id.in_(tenants),
            RunJobORM.created_at >= since,
            RunJobORM.created_at < until,
        )
        if target_model:
            # Filtered in SQL (established `params[...].as_string()` pattern
            # elsewhere in this module) so the params JSON blob never has to be
            # fetched just to be thrown away after one field read.
            job_query = job_query.where(RunJobORM.params["target_model"].as_string() == target_model)
        job_rows = (await self.session.execute(job_query)).all()
        datasets: dict[str, dict] = {}
        agents: dict[str, dict] = {}
        for row in job_rows:
            failed = 1 if row.status in ("failed", "blocked") and row.run_id not in run_ids else 0
            if row.dataset_name:
                bucket = datasets.setdefault(row.dataset_name, {"attempts": 0, "failed_attempts": 0})
                bucket["attempts"] += 1
                bucket["failed_attempts"] += failed
            if row.agent:  # LLM-target runs carry no agent; skipping is honest, not lossy.
                bucket = agents.setdefault(row.agent, {"attempts": 0, "failed_attempts": 0})
                bucket["attempts"] += 1
                bucket["failed_attempts"] += failed

        def _ranked(rollup: dict[str, dict]) -> list[dict]:
            return sorted(
                ({"name": name, **row} for name, row in rollup.items()),
                key=lambda row: (-row["attempts"], row["name"]),
            )

        def _top(rows: list[dict]) -> dict:
            return {"rows": rows[: self._USAGE_TOP_N], "others": max(0, len(rows) - self._USAGE_TOP_N)}

        return {
            "top_models": _top(top_models),
            "top_datasets": _top(_ranked(datasets)),
            "top_agents": _top(_ranked(agents)),
        }

    async def list_runs_page(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        search: str | None = None,
        sort: str = "started_at",
        order: str = "desc",
        tenant_id: str | None = None,
        run_manifest_id: str | None = None,
    ) -> tuple[list[RunResult], int]:
        """Return one page of runs plus the total match count.

        Paging, filtering and ordering are pushed into SQL (LIMIT/OFFSET, COUNT,
        WHERE/ORDER BY) so large histories are never materialised in Python. When
        ``tenant_id`` is provided the page is scoped to that tenant's experiments.

        Hydration is bulk, not per-row: one SELECT for the page of run rows and
        one batched (``IN``-style) SELECT per associated collection via
        ``selectinload``, plus one batched SELECT for experiment-run link roles.
        The query count per page is therefore constant regardless of page size,
        and the assembled ``RunResult`` payload is identical to ``get_run``'s.
        """
        base = select(EvaluationRunORM).join(
            ExperimentORM,
            ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
        )
        if tenant_id is not None:
            base = base.where(ExperimentORM.tenant_id.in_(tenant_id_candidates(tenant_id)))
        if run_manifest_id is not None:
            # Counted in SQL. Filtering a fixed-size page client-side reports
            # "no runs" for anything outside it, which on an evidence record is
            # a false negative rather than a slow page.
            base = base.where(EvaluationRunORM.run_manifest_id == run_manifest_id)
        if search:
            like = f"%{search}%"
            base = base.where(
                or_(
                    ExperimentORM.name.ilike(like),
                    EvaluationRunORM.label.ilike(like),
                    cast(EvaluationRunORM.labels, String).ilike(like),
                    EvaluationRunORM.run_id.ilike(like),
                )
            )

        sort_columns = {
            "started_at": EvaluationRunORM.started_at,
            "completed_at": EvaluationRunORM.completed_at,
            "duration_ms": EvaluationRunORM.duration_ms,
            "run_number": EvaluationRunORM.run_number,
        }
        sort_col = sort_columns.get(sort, EvaluationRunORM.started_at)
        direction = sort_col.asc() if order == "asc" else sort_col.desc()

        total = (await self.session.execute(select(func.count()).select_from(base.subquery()))).scalar_one()

        runs = await self._load_runs(base.order_by(direction, EvaluationRunORM.run_id.asc()).limit(limit).offset(offset))
        return runs, int(total)

    async def _load_runs(self, stmt: Select) -> list[RunResult]:
        """Hydrate runs and their roles in batches for all list readers."""
        result = await self.session.execute(stmt.options(
            selectinload(EvaluationRunORM.experiment),
            selectinload(EvaluationRunORM.evaluator_configs),
            selectinload(EvaluationRunORM.metric_results),
            selectinload(EvaluationRunORM.kpi_results),
            selectinload(EvaluationRunORM.review_queue),
            selectinload(EvaluationRunORM.root_cause),
        ))
        orms = list(result.scalars().all())
        roles = await self._run_link_roles([(orm.experiment_id, orm.run_id) for orm in orms])
        runs: list[RunResult] = []
        for orm in orms:
            run = _run_from_orm(orm)
            role = roles.get((orm.experiment_id, orm.run_id))
            if role is not None:
                run.role = RunRole(role)
            runs.append(run)
        return runs

    async def _run_link_roles(self, keys: list[tuple[str, str]]) -> dict[tuple[str, str], str]:
        """Batch-load experiment-run link roles for a page of runs.

        One ``IN`` query replaces the per-run primary-key ``get`` that
        ``get_run`` performs, keeping page hydration O(1) in query count.
        """
        run_ids = {run_id for _, run_id in keys}
        if not run_ids:
            return {}
        result = await self.session.execute(select(ExperimentRunLinkORM).where(ExperimentRunLinkORM.run_id.in_(run_ids)))
        wanted = set(keys)
        return {(link.experiment_id, link.run_id): link.role for link in result.scalars().all() if (link.experiment_id, link.run_id) in wanted}

    async def list_runs_for_experiment(self, experiment_id: str, *, tenant_id: str | None = None) -> list[RunResult]:
        """Runs linked to ``experiment_id``, scoped to ``tenant_id`` when given.

        The link table and a run's OWNING experiment are different relations, so a
        link alone does not prove tenancy: a foreign run linked into this experiment
        would otherwise be hydrated and returned. Callers that know the tenant must
        pass it; ``None`` keeps the historical unscoped behaviour for internal call
        sites whose experiment was already tenant-checked upstream.
        """
        stmt = (
            select(EvaluationRunORM)
            .join(ExperimentRunLinkORM, ExperimentRunLinkORM.run_id == EvaluationRunORM.run_id)
            .where(ExperimentRunLinkORM.experiment_id == experiment_id)
            .order_by(EvaluationRunORM.started_at.desc())
        )
        if tenant_id is not None:
            stmt = stmt.join(ExperimentORM, ExperimentORM.experiment_id == EvaluationRunORM.experiment_id).where(
                ExperimentORM.tenant_id.in_(tenant_id_candidates(tenant_id))
            )
        return await self._load_runs(stmt)

    async def experiment_has_run(self, experiment_id: str, run_id: str) -> bool:
        return (await self.session.get(ExperimentRunLinkORM, (experiment_id, run_id))) is not None

    async def link_runs_to_experiment(
        self,
        experiment_id: str,
        run_ids: list[str],
        *,
        baseline_run_id: str | None = None,
    ) -> list[ExperimentRunLink]:
        existing = await self._list_run_links(experiment_id)
        existing_ids = {link.run_id for link in existing}
        next_number = max((link.run_number for link in existing), default=0) + 1
        for run_id in run_ids:
            if run_id in existing_ids:
                continue
            if not await self.run_exists(run_id):
                raise ValueError(f"Run {run_id} not found")
            # Always link as exploratory; ``promote_run`` below elevates the
            # baseline after demoting any current one, so the direct insert can
            # never collide with the unique-baseline index.
            self.session.add(
                ExperimentRunLinkORM(
                    experiment_id=experiment_id,
                    run_id=run_id,
                    run_number=next_number,
                    role=RunRole.EXPLORATORY.value,
                )
            )
            next_number += 1
        await self.session.commit()
        if baseline_run_id:
            await self._promote_run_unscoped(experiment_id, baseline_run_id, RunRole.BASELINE)
        return await self._list_run_links(experiment_id)

    @staticmethod
    def _reject_foreign_workspace_run(
        workspace: ExperimentDefinition,
        run: RunResult,
        tenant_id: str | None,
    ) -> None:
        """Raise ``ValueError`` unless ``run`` and ``tenant_id`` own ``workspace``.

        The worker attaches with no request context, so an enqueue-time header
        check cannot be the only guard: a run may only join a workspace owned by
        its own tenant. The message repeats the not-found wording so a foreign
        workspace is never confirmed to exist.
        """
        expected = (workspace.tenant_id or "").strip()
        if not expected:
            return
        for candidate in (tenant_id, run.experiment.tenant_id):
            value = (candidate or "").strip()
            if not value or not tenants_match(value, expected):
                raise ValueError(f"Experiment workspace {workspace.experiment_id} not found")

    async def ensure_workspace_accepts_run(
        self,
        workspace_id: str,
        run: RunResult,
        *,
        tenant_id: str | None,
    ) -> None:
        """Raise ``ValueError`` if ``run`` could not join ``workspace_id``.

        Read-only counterpart to :meth:`attach_run_to_experiment_workspace`, so a
        caller can reject an incompatible attachment BEFORE persisting the run and
        leaving a completed-but-unattached run behind a failed job.
        """
        workspace = await self._get_experiment_unscoped(workspace_id)
        if not workspace or workspace.tags.get("workspace_kind") != "experiment":
            raise ValueError(f"Experiment workspace {workspace_id} not found")
        self._reject_foreign_workspace_run(workspace, run, tenant_id)
        if workspace.tags.get("pending_first_run") == "true":
            return
        existing = await self.list_runs_for_experiment(workspace_id, tenant_id=tenant_id)
        if not existing:
            return
        expected = recorded_comparison_basis(existing[0])
        if not expected or recorded_comparison_basis(run) != expected:
            raise ValueError("Run does not share the experiment workspace comparison basis")

    async def attach_run_to_experiment_workspace(
        self,
        workspace_id: str,
        run: RunResult,
        *,
        tenant_id: str | None,
    ) -> ExperimentDefinition:
        """Link a completed run to a governance workspace, stamping on first run.

        Compatibility for later attaches mirrors ``_validated_workspace_runs``:
        shared comparison basis (or historical experiment version id).
        """
        workspace = await self._get_experiment_unscoped(workspace_id)
        if not workspace or workspace.tags.get("workspace_kind") != "experiment":
            raise ValueError(f"Experiment workspace {workspace_id} not found")
        self._reject_foreign_workspace_run(workspace, run, tenant_id)
        pending = workspace.tags.get("pending_first_run") == "true"
        if pending:
            tags = {k: v for k, v in (workspace.tags or {}).items() if k != "pending_first_run"}
            # Stamp the WHOLE contract, not a subset: a workspace left holding
            # default scope / tool selection / provenance would describe a
            # different contract from the run that stamped it, and later
            # versions would snapshot that invented basis instead of the
            # recorded one.
            stamp = {field: getattr(run.experiment, field) for field in EXPERIMENT_CONTRACT_FIELDS}
            stamp["tags"] = tags
            await self._update_experiment_unscoped(workspace_id, stamp)
        else:
            existing = await self.list_runs_for_experiment(workspace_id, tenant_id=tenant_id)
            if existing:
                expected = recorded_comparison_basis(existing[0])
                if not expected or recorded_comparison_basis(run) != expected:
                    raise ValueError("Run does not share the experiment workspace comparison basis")
        await self.link_runs_to_experiment(workspace_id, [run.run_id])
        updated = await self._get_experiment_unscoped(workspace_id)
        assert updated is not None
        return updated

    async def get_experiment_summary(
        self,
        experiment_id: str,
        *,
        exclude_run_ids: set[str] | None = None,
    ) -> ExperimentSummary | None:
        """Summarise an experiment, optionally ignoring some of its runs.

        ``exclude_run_ids`` lets a caller summarise the part of a lineage that is
        not already represented elsewhere (a run linked to a governance workspace
        is reported there, not twice).
        """
        exp = await self._get_experiment_unscoped(experiment_id)
        if not exp:
            return None
        summaries = await self.list_experiment_summaries(
            [exp], exclude_run_ids={experiment_id: exclude_run_ids} if exclude_run_ids else None,
        )
        return summaries[experiment_id]

    async def run_ids_for_experiments(self, experiment_ids: list[str]) -> dict[str, set[str]]:
        """Linked run ids per experiment, in one query.

        Lets a listing decide what it can show — run counts, empty drafts, runs
        already promoted into a workspace — without hydrating a single run.
        """
        if not experiment_ids:
            return {}
        result = await self.session.execute(select(ExperimentRunLinkORM.experiment_id, ExperimentRunLinkORM.run_id).where(ExperimentRunLinkORM.experiment_id.in_(experiment_ids)))
        grouped: dict[str, set[str]] = {}
        for experiment_id, run_id in result.all():
            grouped.setdefault(experiment_id, set()).add(run_id)
        return grouped

    async def list_experiment_summaries(
        self,
        experiments: list[ExperimentDefinition],
        *,
        exclude_run_ids: dict[str, set[str]] | None = None,
    ) -> dict[str, ExperimentSummary]:
        """Batched :meth:`get_experiment_summary` for a whole listing.

        Same fields, but the per-run ``get_run`` hydration is replaced by four
        statements for the entire page: the run links (joined to runs so the
        latest-first ordering stays in SQL), the latest run of each experiment
        with its KPI rows, and the decisions. Query count is flat in both
        experiment and run count.

        ``exclude_run_ids`` maps an experiment id to runs it must not report,
        mirroring the single-experiment ``exclude_run_ids`` argument.
        """
        ids = [exp.experiment_id for exp in experiments if exp.experiment_id]
        if not ids:
            return {}
        excluded = exclude_run_ids or {}

        link_rows = (
            await self.session.execute(
                select(
                    ExperimentRunLinkORM.experiment_id,
                    ExperimentRunLinkORM.run_id,
                    ExperimentRunLinkORM.role,
                    ExperimentRunLinkORM.run_number,
                )
                .join(
                    EvaluationRunORM,
                    EvaluationRunORM.run_id == ExperimentRunLinkORM.run_id,
                )
                .where(ExperimentRunLinkORM.experiment_id.in_(ids))
                .order_by(EvaluationRunORM.started_at.desc())
            )
        ).all()

        links: dict[str, list[Any]] = {}
        for row in link_rows:
            skip = excluded.get(row.experiment_id)
            if skip and row.run_id in skip:
                continue
            links.setdefault(row.experiment_id, []).append(row)

        latest_runs: dict[str, EvaluationRunORM] = {}
        latest_run_ids = [rows[0].run_id for rows in links.values()]
        if latest_run_ids:
            result = await self.session.execute(select(EvaluationRunORM).where(EvaluationRunORM.run_id.in_(latest_run_ids)).options(selectinload(EvaluationRunORM.kpi_results)))
            latest_runs = {orm.run_id: orm for orm in result.scalars().all()}

        decision_rows = await self.session.execute(select(ExperimentDecisionORM).where(ExperimentDecisionORM.experiment_id.in_(ids)).order_by(ExperimentDecisionORM.created_at.desc()))
        latest_decision: dict[str, ExperimentDecision] = {}
        for orm in decision_rows.scalars().all():
            latest_decision.setdefault(orm.experiment_id, _decision_from_orm(orm))

        summaries: dict[str, ExperimentSummary] = {}
        for exp in experiments:
            if not exp.experiment_id:
                continue
            rows = links.get(exp.experiment_id, [])
            # Roles are read in run_number order, exactly as ``_list_run_links``
            # returns them; the rows themselves stay latest-run-first.
            by_number = sorted(rows, key=lambda row: row.run_number)

            def role_run(role: RunRole, ordered: list[Any] = by_number) -> str | None:
                return next((row.run_id for row in ordered if row.role == role.value), None)

            latest = latest_runs.get(rows[0].run_id) if rows else None
            kpis = latest.kpi_results if latest else []
            scores = [kpi.composite_score for kpi in kpis if kpi.composite_score is not None] if latest and latest.verdict_status == VerdictStatus.CONCLUSIVE.value else []
            summaries[exp.experiment_id] = ExperimentSummary(
                experiment=exp,
                run_count=len(rows),
                latest_run_id=latest.run_id if latest else None,
                latest_score=round(sum(scores) / len(scores), 4) if scores else None,
                latest_gate=(GateResult(latest.overall_gate) if latest and latest.overall_gate else None),
                latest_completed_at=latest.completed_at if latest else None,
                baseline_run_id=role_run(RunRole.BASELINE),
                champion_run_id=role_run(RunRole.CHAMPION),
                release_evidence_run_id=role_run(RunRole.RELEASE_EVIDENCE),
                failed_kpis_latest=[kpi.kpi_id for kpi in kpis if kpi.gate_result == GateResult.FAIL.value],
                latest_decision=latest_decision.get(exp.experiment_id),
            )
        return summaries

    async def save_experiment_version(
        self,
        *,
        experiment_id: str,
        tenant_id: str,
        experiment_version_id: str,
        contract_json: dict,
        created_by: str = "system",
    ) -> ExperimentVersion:
        if not await self._experiment_tenant_ok(experiment_id, tenant_id):
            raise ValueError(f"Experiment {experiment_id} not found")
        existing = await self.session.get(ExperimentVersionORM, experiment_version_id)
        if existing:
            return _version_from_orm(existing)
        contract_hash = experiment_version_id.removeprefix("exp-")
        orm = ExperimentVersionORM(
            experiment_version_id=experiment_version_id,
            experiment_id=experiment_id,
            contract_json=contract_json,
            contract_hash=contract_hash,
            created_by=created_by,
        )
        self.session.add(orm)
        await self.session.commit()
        return _version_from_orm(orm)

    async def list_experiment_versions(self, experiment_id: str, tenant_id: str) -> list[ExperimentVersion]:
        if not await self._experiment_tenant_ok(experiment_id, tenant_id):
            return []
        # A version row is keyed by the contract fingerprint alone, so two
        # experiments with identical contracts share one row and its
        # ``experiment_id`` column records only the FIRST writer. Resolve the
        # per-experiment view through this experiment's runs as well, so a run's
        # recorded version always appears in its own experiment's version list.
        run_version_ids = (
            select(EvaluationRunORM.experiment_version_id)
            .where(
                EvaluationRunORM.experiment_id == experiment_id,
                EvaluationRunORM.experiment_version_id.is_not(None),
            )
            .scalar_subquery()
        )
        result = await self.session.execute(
            select(ExperimentVersionORM)
            .where(
                or_(
                    ExperimentVersionORM.experiment_id == experiment_id,
                    ExperimentVersionORM.experiment_version_id.in_(run_version_ids),
                )
            )
            .order_by(ExperimentVersionORM.created_at.desc())
        )
        return [_version_from_orm(v) for v in result.scalars().all()]

    async def promote_run(self, experiment_id: str, tenant_id: str, run_id: str, role: RunRole, *, commit: bool = True) -> ExperimentRunLink:
        """Tenant-scoped wrapper for :meth:`_promote_run_unscoped`.

        ``ExperimentRunLinkORM`` has no ``tenant_id`` column of its own, so
        ownership is only knowable via the parent experiment.
        """
        if not await self._experiment_tenant_ok(experiment_id, tenant_id):
            raise ValueError(f"Run {run_id} is not linked to experiment {experiment_id}")
        return await self._promote_run_unscoped(experiment_id, run_id, role, commit=commit)

    async def _promote_run_unscoped(self, experiment_id: str, run_id: str, role: RunRole, *, commit: bool = True) -> ExperimentRunLink:
        link = await self.session.get(ExperimentRunLinkORM, (experiment_id, run_id))
        if not link:
            raise ValueError(f"Run {run_id} is not linked to experiment {experiment_id}")

        # Single champion / baseline / release_evidence at a time.
        if role in (RunRole.CHAMPION, RunRole.BASELINE, RunRole.RELEASE_EVIDENCE):
            result = await self.session.execute(
                select(ExperimentRunLinkORM).where(
                    ExperimentRunLinkORM.experiment_id == experiment_id,
                    ExperimentRunLinkORM.role == role.value,
                )
            )
            for other in result.scalars().all():
                if other.run_id != run_id:
                    other.role = RunRole.EXPLORATORY.value
            # Flush demotions before the promotion so the partial unique index
            # on BASELINE never sees both rows as baseline mid-transaction.
            await self.session.flush()

        link.role = role.value
        if commit:
            await self.session.commit()
        else:
            await self.session.flush()
        return ExperimentRunLink(
            experiment_id=link.experiment_id,
            run_id=link.run_id,
            run_number=link.run_number,
            role=RunRole(link.role),
            created_at=link.created_at,
        )

    # ------------------------------------------------------------------
    # Baseline promotion audit trail + undo.
    # ------------------------------------------------------------------

    async def _current_baseline_run_id(self, experiment_id: str) -> str | None:
        # Tolerate (and resolve) more than one BASELINE link: there is no
        # DB-level uniqueness guard, so a race between two promotions could
        # briefly leave duplicates. The newest link is the current baseline;
        # the next promotion demotes the rest via _demote_current_baselines.
        result = await self.session.execute(
            select(ExperimentRunLinkORM.run_id)
            .where(
                ExperimentRunLinkORM.experiment_id == experiment_id,
                ExperimentRunLinkORM.role == RunRole.BASELINE.value,
            )
            .order_by(ExperimentRunLinkORM.created_at.desc())
            .limit(1)
        )
        return result.scalars().first()

    async def _demote_current_baselines(self, experiment_id: str, keep_run_id: str | None) -> None:
        result = await self.session.execute(
            select(ExperimentRunLinkORM).where(
                ExperimentRunLinkORM.experiment_id == experiment_id,
                ExperimentRunLinkORM.role == RunRole.BASELINE.value,
            )
        )
        for other in result.scalars().all():
            if other.run_id != keep_run_id:
                other.role = RunRole.EXPLORATORY.value

    async def _record_baseline_change(
        self,
        experiment_id: str,
        *,
        actor: str,
        action: str,
        previous_baseline_run_id: str | None,
        new_baseline_run_id: str | None,
    ) -> BaselineChangeORM:
        exp = await self.session.get(ExperimentORM, experiment_id)
        orm = BaselineChangeORM(
            experiment_id=experiment_id,
            tenant_id=exp.tenant_id if exp else None,
            actor=actor,
            action=action,
            previous_baseline_run_id=previous_baseline_run_id,
            new_baseline_run_id=new_baseline_run_id,
        )
        self.session.add(orm)
        return orm

    async def promote_baseline(
        self,
        experiment_id: str,
        run_id: str,
        *,
        actor: str = "system",
        action: str = "promote",
    ) -> BaselineChange:
        """Promote ``run_id`` to baseline and record an audit row.

        The partial unique index on ``(experiment_id) WHERE role='baseline'``
        rejects a promotion that raced another one (the demotion read missed a
        concurrently-committed baseline). In that case the transaction is
        rolled back and retried once: the retry re-reads and re-demotes the
        now-visible baseline before promoting.
        """
        try:
            return await self._promote_baseline_once(experiment_id, run_id, actor=actor, action=action)
        except IntegrityError:
            await self.session.rollback()
            return await self._promote_baseline_once(experiment_id, run_id, actor=actor, action=action)

    async def _promote_baseline_once(
        self,
        experiment_id: str,
        run_id: str,
        *,
        actor: str,
        action: str,
    ) -> BaselineChange:
        link = await self.session.get(ExperimentRunLinkORM, (experiment_id, run_id))
        if not link:
            raise ValueError(f"Run {run_id} is not linked to experiment {experiment_id}")
        previous = await self._current_baseline_run_id(experiment_id)
        await self._demote_current_baselines(experiment_id, keep_run_id=run_id)
        # Flush demotions first so the unique baseline index never sees the
        # outgoing and incoming baseline at the same time within this
        # transaction.
        await self.session.flush()
        link.role = RunRole.BASELINE.value
        change = await self._record_baseline_change(
            experiment_id,
            actor=actor,
            action=action,
            previous_baseline_run_id=previous,
            new_baseline_run_id=run_id,
        )
        await self.session.commit()
        return _baseline_change_from_orm(change)

    async def list_baseline_changes(self, experiment_id: str) -> list[BaselineChange]:
        """Return the baseline-change audit trail, newest first."""
        result = await self.session.execute(select(BaselineChangeORM).where(BaselineChangeORM.experiment_id == experiment_id).order_by(BaselineChangeORM.created_at.desc()))
        return [_baseline_change_from_orm(orm) for orm in result.scalars().all()]

    async def undo_baseline(self, experiment_id: str, *, actor: str = "system") -> BaselineChange:
        """Revert to the previous baseline, itself recorded as an audited change."""
        result = await self.session.execute(select(BaselineChangeORM).where(BaselineChangeORM.experiment_id == experiment_id).order_by(BaselineChangeORM.created_at.desc()).limit(1))
        last = result.scalar_one_or_none()
        if last is None:
            raise ValueError("No baseline change to undo")
        target = last.previous_baseline_run_id
        if target is not None:
            return await self.promote_baseline(experiment_id, target, actor=actor, action="undo")
        # The last change created the first baseline; undo means "no baseline".
        current = await self._current_baseline_run_id(experiment_id)
        await self._demote_current_baselines(experiment_id, keep_run_id=None)
        change = await self._record_baseline_change(
            experiment_id,
            actor=actor,
            action="undo",
            previous_baseline_run_id=current,
            new_baseline_run_id=None,
        )
        await self.session.commit()
        return _baseline_change_from_orm(change)

    async def create_decision(self, decision: ExperimentDecision, tenant_id: str, *, commit: bool = True) -> ExperimentDecision:
        if not await self._experiment_tenant_ok(decision.experiment_id, tenant_id):
            raise ValueError(f"Experiment {decision.experiment_id} not found")
        decision_id = decision.decision_id or str(uuid.uuid4())
        orm = ExperimentDecisionORM(
            decision_id=decision_id,
            experiment_id=decision.experiment_id,
            run_id=decision.run_id,
            decision=decision.decision.value,
            reason=decision.reason,
            approved_by=decision.approved_by,
            expires_at=decision.expires_at,
        )
        self.session.add(orm)

        if decision.decision in (
            DecisionType.APPROVED,
            DecisionType.APPROVED_WITH_EXCEPTION,
        ):
            exp = await self.session.get(ExperimentORM, decision.experiment_id)
            if exp:
                exp.status = ExperimentStatus.APPROVED.value
            # Single release_evidence; demote any previous.
            result = await self.session.execute(
                select(ExperimentRunLinkORM).where(
                    ExperimentRunLinkORM.experiment_id == decision.experiment_id,
                    ExperimentRunLinkORM.role == RunRole.RELEASE_EVIDENCE.value,
                )
            )
            for other in result.scalars().all():
                if other.run_id != decision.run_id:
                    other.role = RunRole.EXPLORATORY.value
            link = await self.session.get(ExperimentRunLinkORM, (decision.experiment_id, decision.run_id))
            if link:
                link.role = RunRole.RELEASE_EVIDENCE.value

        if commit:
            await self.session.commit()
        else:
            await self.session.flush()
        saved = await self.session.get(ExperimentDecisionORM, decision_id)
        assert saved is not None
        return _decision_from_orm(saved)

    async def list_decisions(self, experiment_id: str, tenant_id: str) -> list[ExperimentDecision]:
        if not await self._experiment_tenant_ok(experiment_id, tenant_id):
            return []
        result = await self.session.execute(select(ExperimentDecisionORM).where(ExperimentDecisionORM.experiment_id == experiment_id).order_by(ExperimentDecisionORM.created_at.desc()))
        return [_decision_from_orm(d) for d in result.scalars().all()]

    async def archive_experiment(self, experiment_id: str, tenant_id: str) -> ExperimentDefinition | None:
        return await self.update_experiment(experiment_id, tenant_id, {"status": ExperimentStatus.ARCHIVED})

    # ------------------------------------------------------------------
    # Closed-loop findings, review, regression, and release evidence.
    # ------------------------------------------------------------------

    async def open_case_for_review(
        self, run_id: str, row_id: str, metric_id: str
    ) -> tuple[Finding, bool]:
        """Make one scored case reviewable, whether or not the judge failed it.

        Findings are only raised for failures, so review can only ever catch
        false alarms — a judge that passes everything scores a perfect
        agreement. Opening a passing case for review is what supplies the other
        half: the reviewer can say the judge was wrong to pass it, or right.

        Idempotent on re-send: a case already under review returns its existing
        finding, so sending the same case twice does not create rival histories.
        The check is a SELECT followed by an INSERT, not a database constraint,
        so two genuinely simultaneous sends can still both miss and both write.
        Closing that needs a unique index on (run_id, row_id, metric_ids) and
        the migration to add it; the UI's already-queued state covers the
        ordinary case. Returns ``(finding, created)``.
        """

        result = await self.session.execute(
            select(MetricResultORM).where(
                MetricResultORM.run_id == run_id,
                MetricResultORM.row_id == row_id,
                MetricResultORM.metric_id == metric_id,
                (MetricResultORM.subject_kind.is_(None) | (MetricResultORM.subject_kind == "case")),
            )
        )
        metric_row = result.scalars().first()
        if metric_row is None:
            raise ValueError(f"{metric_id} was not scored for row {row_id} in run {run_id}")
        if metric_row.execution_status == "error":
            # A crashed scorer formed no opinion. Confirming or rejecting it
            # says nothing about the judge, and counted in the agreement ratio
            # it is indistinguishable from a real disagreement.
            raise ValueError(
                f"{metric_id} did not run for row {row_id} (scorer error); there is no judgement to review"
            )
        if metric_row.metric_status != MetricStatus.SCORED.value:
            # Nothing to agree or disagree with. An unscored row carries no
            # judge opinion, so a verdict on it would not be about the judge.
            raise ValueError(f"{metric_id} is {metric_row.metric_status} for row {row_id}; nothing to review")
        if metric_row.threshold_result is None:
            # A measurement is not a judgement. Latency and token counts are
            # recorded facts — 1.007 seconds is not right or wrong — and a
            # metric only carries a verdict when a threshold was configured for
            # it. Sending one to review produced a finding whose gate_result
            # came from `bool(None)`, so "1.007s" was filed as a CRITICAL
            # failure of a check nobody had set. Operational metrics that DO
            # have a configured threshold keep their verdict and stay
            # reviewable; this refuses only the ones with nothing to review.
            raise ValueError(
                f"{metric_id} recorded a measurement for row {row_id} with no pass/fail threshold; "
                "there is no verdict to agree or disagree with"
            )

        run = await self.session.get(EvaluationRunORM, run_id)
        if run is None:
            raise ValueError(f"Run {run_id} not found")

        existing = (
            await self.session.execute(
                select(FindingORM).where(
                    FindingORM.run_id == run_id,
                    FindingORM.row_id == row_id,
                )
            )
        ).scalars().all()
        for finding in existing:
            if finding.metric_ids == [metric_id]:
                return _finding_from_orm(finding), False

        experiment = await self.session.get(ExperimentORM, run.experiment_id)
        finding_id = str(uuid.uuid4())
        # Read from the verdict itself, not coerced from a nullable flag: a
        # missing verdict is refused above, so this is now a real pass/fail.
        passed = metric_row.threshold_result == GateResult.PASS.value
        self.session.add(
            FindingORM(
                finding_id=finding_id,
                run_id=run_id,
                experiment_id=run.experiment_id,
                row_id=row_id,
                metric_ids=[metric_id],
                # The judge's own verdict, not the reviewer's. The reviewer has
                # not decided anything yet — they are being given the case.
                gate_result=(GateResult.PASS if passed else GateResult.FAIL).value,
                # A passing case carries no asserted problem — it was sent for a
                # second opinion, not raised as one. MEDIUM put a severity badge
                # on a case nobody has claimed is wrong, which pushes the reader
                # toward the misreading the pass-path labels exist to prevent.
                severity=(Severity.LOW if passed else Severity.CRITICAL).value,
                # Same shape the automatic path writes, so the review sheet can
                # show the case rather than "not captured" and the queue row can
                # name it by its question rather than a bare id. Redacted on the
                # way in, exactly as findings raised by a run are.
                evidence=redact_for_persistence(
                    {
                        "opened_for_review": True,
                        "trace_id": metric_row.trace_id,
                        "rationale": metric_row.rationale,
                        "query": (metric_row.sample_input or {}).get("query"),
                        "response": (metric_row.sample_output or {}).get("response"),
                        "judge_score": metric_row.score,
                        "judge_passed": passed,
                        "executed_scorer": metric_row.executed_scorer,
                        # Built from the model rather than by hand: the review
                        # sheet reads `normalised_score`, and writing the
                        # normalised value into `score` left every case sent for
                        # review reading "score not recorded" — the one number
                        # that separates "barely missed" from "nowhere near".
                        "failing_metric_details": [
                            FailingMetricDetail(
                                metric_id=metric_id,
                                score=metric_row.score,
                                normalised_score=metric_row.normalised_score,
                                threshold=metric_row.threshold,
                                threshold_result=(
                                    GateResult(metric_row.threshold_result)
                                    if metric_row.threshold_result
                                    else None
                                ),
                            ).model_dump(mode="json")
                        ],
                    }
                ),
            )
        )
        self.session.add(
            ReviewTaskORM(
                finding_id=finding_id,
                tenant_id=experiment.tenant_id if experiment else None,
                status=FindingStatus.OPEN.value,
            )
        )
        await self.session.commit()
        created = await self.session.get(FindingORM, finding_id)
        return _finding_from_orm(created), True

    async def judge_agreement_by_metric(
        self, tenant_id: str, *, project_id: str | None = None
    ) -> list[dict[str, Any]]:
        """How often reviewers agreed with the judge, per metric AND scorer.

        Split by the scorer that actually produced the reviewed score, because
        "the judge" is not one thing over time. A metric that moved from the
        native judge to RAGAS keeps its id, so pooling by metric alone would let
        verdicts about the old implementation vouch for the new one — a metric
        could read "agreed 100 of 100" without a single one of those cases
        having been scored by the code running today. A trust signal has to be
        about something specific enough to trust.

        Only findings naming exactly ONE metric are counted. A reviewer rejects
        a finding as a whole; on a multi-metric finding there is no way to tell
        which judge they disagreed with, and attributing the verdict to all of
        them would mark judges wrong for calls they got right. Those cases are
        excluded and counted so the screen can say what it skipped rather than
        quietly reporting a number built on guesses.

        ``abstain`` is not a verdict on the judge, so it is excluded too. Only
        the latest decision per finding counts — review history is append-only
        and a later decision supersedes an earlier one.
        """

        decisions = (
            await self.session.execute(
                select(ReviewDecisionORM, FindingORM, ExperimentORM.project_id)
                .join(FindingORM, FindingORM.finding_id == ReviewDecisionORM.finding_id)
                .join(ExperimentORM, ExperimentORM.experiment_id == FindingORM.experiment_id)
                .where(ExperimentORM.tenant_id.in_(tenant_id_candidates(tenant_id)))
                .order_by(ReviewDecisionORM.finding_id, ReviewDecisionORM.created_at.asc())
            )
        ).all()

        # A scorer error is not a judgement, so a verdict on one is not evidence
        # about the judge. Counted, a RAGAS import failure looks exactly like a
        # reviewer saying the judge was wrong.
        #
        # Keyed by metric, not merely by row. A metric result is per
        # (run, row, metric), so dropping the metric would let one crashed
        # scorer discard every reviewed verdict on that row — including
        # disagreements about metrics that scored cleanly. That silently
        # rounds the number in the judge's favour, which is the one direction
        # a trust signal must never round.
        reviewed_runs = {finding.run_id for _, finding, _ in decisions}
        errored: set[tuple[str, str, str]] = set()
        # Which scorer actually produced each reviewed score. One pass over the
        # same rows serves both the error exclusion and the scorer split.
        scorer_by_result: dict[tuple[str, str, str], str | None] = {}
        # A measurement is not a judgement, so a verdict on one is not evidence
        # about the judge either. Findings for these are refused at creation
        # now; the ones already recorded before that guard existed must not
        # count, or a reviewer's opinion about a latency reading would move a
        # figure that claims to describe judge accuracy.
        verdictless: set[tuple[str, str, str]] = set()
        if reviewed_runs:
            for run_id, row_id, metric_id, execution_status, executed_scorer, threshold_result in (
                await self.session.execute(
                    select(
                        MetricResultORM.run_id,
                        MetricResultORM.row_id,
                        MetricResultORM.metric_id,
                        MetricResultORM.execution_status,
                        MetricResultORM.executed_scorer,
                        MetricResultORM.threshold_result,
                    ).where(MetricResultORM.run_id.in_(reviewed_runs), (MetricResultORM.subject_kind.is_(None) | (MetricResultORM.subject_kind == "case")))
                )
            ).all():
                key = (run_id, row_id, metric_id)
                scorer_by_result[key] = executed_scorer
                if execution_status == "error":
                    errored.add(key)
                if threshold_result is None:
                    verdictless.add(key)

        latest: dict[str, tuple[ReviewDecisionORM, FindingORM, str | None]] = {}
        for decision, finding, finding_project in decisions:
            latest[decision.finding_id] = (decision, finding, finding_project)

        counts: dict[tuple[str, str | None], dict[str, int]] = {}

        def bucket_for(metric_id: str, finding: FindingORM) -> dict[str, int]:
            scorer = scorer_by_result.get((finding.run_id, finding.row_id, metric_id))
            return counts.setdefault(
                (metric_id, scorer), {"agreed": 0, "reviewed": 0, "ambiguous": 0}
            )

        for decision, finding, finding_project in latest.values():
            if project_id is not None and finding_project != project_id:
                continue
            # Abstaining says nothing about the judge either way. Checked before
            # the multi-metric branch so an abstained multi-metric finding is not
            # reported as "excluded because it covered more than one metric" —
            # a true sentence about the wrong reason.
            if decision.outcome == ReviewOutcome.ABSTAIN.value:
                continue
            if len(finding.metric_ids) != 1:
                for metric_id in finding.metric_ids:
                    bucket_for(metric_id, finding)["ambiguous"] += 1
                continue
            metric_id = finding.metric_ids[0]
            result_key = (finding.run_id, finding.row_id, metric_id)
            if result_key in errored or result_key in verdictless:
                continue
            bucket = bucket_for(metric_id, finding)
            bucket["reviewed"] += 1
            if decision.outcome == ReviewOutcome.AGREE.value:
                bucket["agreed"] += 1

        return [
            {"metric_id": metric_id, "executed_scorer": scorer, **bucket}
            for (metric_id, scorer), bucket in sorted(
                counts.items(), key=lambda entry: (entry[0][0], entry[0][1] or "")
            )
            if bucket["reviewed"] or bucket["ambiguous"]
        ]

    async def get_finding(self, finding_id: str) -> Finding | None:
        orm = await self.session.get(FindingORM, finding_id)
        return _finding_from_orm(orm) if orm else None

    async def list_findings(
        self,
        run_id: str | None = None,
        experiment_id: str | None = None,
        tenant_id: str | None = None,
        limit: int | None = None,
    ) -> list[Finding]:
        """Findings, newest first, bounded by ``limit`` when one is given.

        A queue item writes a finding per failing *row*, and a run whose average
        passes can still carry a failing row on every case — so this list grows
        without a ceiling and every caller reads all of it at once. The bound is
        the read side's, not a cap on what is recorded.
        """
        statement = select(FindingORM)
        if run_id:
            statement = statement.where(FindingORM.run_id == run_id)
        if experiment_id:
            statement = statement.where(FindingORM.experiment_id == experiment_id)
        if tenant_id:
            # Scope through the owning experiment, mirroring run reads: a
            # finding whose run is not readable in this tenant must not be
            # listed either (an unscoped list + scoped run read produced
            # deep links that 404).
            statement = statement.join(ExperimentORM, ExperimentORM.experiment_id == FindingORM.experiment_id).where(tenant_clause(ExperimentORM, tenant_id))
        statement = statement.order_by(FindingORM.created_at.desc())
        if limit is not None:
            statement = statement.limit(limit)
        result = await self.session.execute(statement)
        return [_finding_from_orm(orm) for orm in result.scalars().all()]

    async def list_review_tasks(self, finding_id: str) -> list[ReviewTask]:
        result = await self.session.execute(select(ReviewTaskORM).where(ReviewTaskORM.finding_id == finding_id).order_by(ReviewTaskORM.created_at.asc()))
        return [_review_task_from_orm(orm) for orm in result.scalars().all()]

    async def create_review_decision(self, decision: ReviewDecision) -> ReviewDecision:
        task = await self.session.get(ReviewTaskORM, decision.task_id)
        finding = await self.session.get(FindingORM, decision.finding_id)
        if not task or task.finding_id != decision.finding_id or not finding:
            raise ValueError("Review task and finding do not match")
        self.session.add(
            ReviewDecisionORM(
                decision_id=decision.decision_id,
                finding_id=decision.finding_id,
                task_id=decision.task_id,
                reviewer=decision.reviewer,
                outcome=decision.outcome.value,
                rationale=decision.rationale,
                score_override=decision.score_override,
                severity=decision.severity.value if decision.severity else None,
                root_cause_category=decision.root_cause_category,
                created_at=decision.created_at,
            )
        )
        task.status = FindingStatus.RESOLVED.value if decision.outcome == ReviewOutcome.AGREE else FindingStatus.IN_REVIEW.value
        finding.status = task.status
        if decision.severity:
            finding.severity = decision.severity.value
        if decision.root_cause_category:
            finding.root_cause_category = decision.root_cause_category
        await self.session.commit()
        return decision

    async def list_review_decision_history(self, finding_id: str) -> list[ReviewDecisionRecord]:
        """Return the append-only decision history for a finding, oldest first.

        The most recent decision is the current one; every earlier decision is
        marked ``superseded``. Supersession is derived from insertion order —
        decisions are never mutated in place.
        """

        result = await self.session.execute(
            select(ReviewDecisionORM)
            .where(ReviewDecisionORM.finding_id == finding_id)
            .order_by(
                ReviewDecisionORM.created_at.asc(),
                ReviewDecisionORM.decision_id.asc(),
            )
        )
        rows = list(result.scalars().all())
        history: list[ReviewDecisionRecord] = []
        last_index = len(rows) - 1
        for index, orm in enumerate(rows):
            is_current = index == last_index
            history.append(
                ReviewDecisionRecord(
                    decision_id=orm.decision_id,
                    finding_id=orm.finding_id,
                    task_id=orm.task_id,
                    actor=orm.reviewer,
                    outcome=ReviewOutcome(orm.outcome),
                    rationale=orm.rationale,
                    score_override=orm.score_override,
                    severity=Severity(orm.severity) if orm.severity else None,
                    root_cause_category=orm.root_cause_category,
                    timestamp=orm.created_at,
                    superseded=not is_current,
                    is_current=is_current,
                )
            )
        return history

    async def create_finding_comment(self, comment: FindingComment) -> FindingComment:
        """Append a collaboration comment to a finding. Comments are never edited or deleted."""

        finding = await self.session.get(FindingORM, comment.finding_id)
        if not finding:
            raise ValueError(f"Finding {comment.finding_id} not found")
        self.session.add(
            FindingCommentORM(
                comment_id=comment.comment_id,
                finding_id=comment.finding_id,
                tenant_id=comment.tenant_id,
                author=comment.author,
                body=comment.body,
                mentions=comment.mentions,
                created_at=comment.created_at,
            )
        )
        await self.session.commit()
        return comment

    async def list_finding_comments(self, finding_id: str) -> list[FindingComment]:
        result = await self.session.execute(select(FindingCommentORM).where(FindingCommentORM.finding_id == finding_id).order_by(FindingCommentORM.created_at.asc(), FindingCommentORM.comment_id.asc()))
        return [_finding_comment_from_orm(orm) for orm in result.scalars().all()]

    async def list_finding_activity(self, finding_id: str) -> list[ActivityEvent]:
        """Assemble the finding's activity timeline from already-persisted data.

        Read-only merge of the finding row, review decisions, remediations,
        waivers, comments, and audit-logged remediation status transitions —
        no dedicated event table exists. Honest limits: edits/deletes are not
        tracked, and remediation status changes appear only when they were
        made through the API (the audit log is their only persisted record).
        """

        finding = await self.session.get(FindingORM, finding_id)
        if not finding:
            raise ValueError(f"Finding {finding_id} not found")

        events: list[ActivityEvent] = [
            ActivityEvent(
                kind=ActivityKind.FINDING_CREATED,
                actor="system",
                timestamp=finding.created_at,
                summary=f"Finding created with severity {finding.severity} (gate {finding.gate_result})",
                reference_id=finding.finding_id,
                details={
                    "severity": finding.severity,
                    "gate_result": finding.gate_result,
                },
            )
        ]

        decisions = await self.session.execute(select(ReviewDecisionORM).where(ReviewDecisionORM.finding_id == finding_id).order_by(ReviewDecisionORM.created_at.asc(), ReviewDecisionORM.decision_id.asc()))
        for decision in decisions.scalars().all():
            events.append(
                ActivityEvent(
                    kind=ActivityKind.REVIEW_DECISION,
                    actor=decision.reviewer,
                    timestamp=decision.created_at,
                    summary=f"Review decision recorded: {decision.outcome}",
                    reference_id=decision.decision_id,
                    details={
                        "outcome": decision.outcome,
                        "rationale": decision.rationale,
                    },
                )
            )

        remediations = await self.session.execute(select(RemediationORM).where(RemediationORM.finding_id == finding_id).order_by(RemediationORM.created_at.asc(), RemediationORM.remediation_id.asc()))
        remediation_rows = list(remediations.scalars().all())
        for remediation in remediation_rows:
            events.append(
                ActivityEvent(
                    kind=ActivityKind.REMEDIATION_CREATED,
                    actor=remediation.created_by,
                    timestamp=remediation.created_at,
                    summary=f"Remediation assigned to {remediation.owner}",
                    reference_id=remediation.remediation_id,
                    details={
                        "owner": remediation.owner,
                        "description": remediation.description,
                    },
                )
            )
        if remediation_rows:
            remediation_ids = [row.remediation_id for row in remediation_rows]
            status_changes = await self.session.execute(
                select(AuditEventORM)
                .where(
                    AuditEventORM.action == "finding.remediation_updated",
                    AuditEventORM.resource_id.in_(remediation_ids),
                )
                .order_by(AuditEventORM.created_at.asc(), AuditEventORM.audit_event_id.asc())
            )
            for audit in status_changes.scalars().all():
                status = (audit.details or {}).get("status", "unknown")
                events.append(
                    ActivityEvent(
                        kind=ActivityKind.REMEDIATION_STATUS_CHANGED,
                        actor=audit.actor,
                        timestamp=audit.created_at,
                        summary=f"Remediation status changed to {status}",
                        reference_id=audit.resource_id,
                        details={"status": status},
                    )
                )

        waivers = await self.session.execute(select(WaiverORM).where(WaiverORM.finding_id == finding_id).order_by(WaiverORM.created_at.asc(), WaiverORM.waiver_id.asc()))
        for waiver in waivers.scalars().all():
            events.append(
                ActivityEvent(
                    kind=ActivityKind.WAIVER_GRANTED,
                    actor=waiver.approved_by,
                    timestamp=waiver.created_at,
                    summary=f"Waiver granted until {waiver.expires_at.date().isoformat()}",
                    reference_id=waiver.waiver_id,
                    details={
                        "rationale": waiver.rationale,
                        "expires_at": waiver.expires_at.isoformat(),
                    },
                )
            )

        for comment in await self.list_finding_comments(finding_id):
            events.append(
                ActivityEvent(
                    kind=ActivityKind.COMMENT,
                    actor=comment.author,
                    timestamp=comment.created_at,
                    summary=comment.body,
                    reference_id=comment.comment_id,
                    details={"mentions": comment.mentions},
                )
            )

        # Stable sort: assembly order above breaks timestamp ties deterministically.
        events.sort(key=lambda event: event.timestamp)
        return events

    async def create_waiver(self, waiver: Waiver) -> Waiver:
        finding = await self.session.get(FindingORM, waiver.finding_id)
        if not finding:
            raise ValueError(f"Finding {waiver.finding_id} not found")
        self.session.add(
            WaiverORM(
                waiver_id=waiver.waiver_id,
                finding_id=waiver.finding_id,
                approved_by=waiver.approved_by,
                rationale=waiver.rationale,
                expires_at=waiver.expires_at,
                created_at=waiver.created_at,
            )
        )
        finding.status = FindingStatus.WAIVED.value
        task_result = await self.session.execute(select(ReviewTaskORM).where(ReviewTaskORM.finding_id == waiver.finding_id))
        for task in task_result.scalars().all():
            task.status = FindingStatus.WAIVED.value
        await self.session.commit()
        return waiver

    async def create_remediation(self, remediation: Remediation) -> Remediation:
        finding = await self.session.get(FindingORM, remediation.finding_id)
        if not finding:
            raise ValueError(f"Finding {remediation.finding_id} not found")
        self.session.add(
            RemediationORM(
                remediation_id=remediation.remediation_id,
                finding_id=remediation.finding_id,
                owner=remediation.owner,
                description=remediation.description,
                status=remediation.status.value,
                due_at=remediation.due_at,
                created_by=remediation.created_by,
                created_at=remediation.created_at,
                updated_at=remediation.updated_at,
            )
        )
        await self.session.commit()
        return remediation

    async def list_remediations(self, finding_id: str | None = None, tenant_id: str | None = None) -> list[Remediation]:
        statement = select(RemediationORM)
        if finding_id:
            statement = statement.where(RemediationORM.finding_id == finding_id)
        if tenant_id:
            # Scope through the owning finding -> experiment, mirroring
            # list_findings: a remediation whose finding is not readable in
            # this tenant must not be listed either.
            statement = (
                statement.join(FindingORM, FindingORM.finding_id == RemediationORM.finding_id)
                .join(ExperimentORM, ExperimentORM.experiment_id == FindingORM.experiment_id)
                .where(tenant_clause(ExperimentORM, tenant_id))
            )
        result = await self.session.execute(statement.order_by(RemediationORM.updated_at.desc()))
        return [_remediation_from_orm(orm) for orm in result.scalars().all()]

    async def get_remediation(self, remediation_id: str) -> Remediation | None:
        orm = await self.session.get(RemediationORM, remediation_id)
        return _remediation_from_orm(orm) if orm else None

    async def update_remediation_status(self, remediation_id: str, status: RemediationStatus) -> Remediation:
        orm = await self.session.get(RemediationORM, remediation_id)
        if not orm:
            raise ValueError(f"Remediation {remediation_id} not found")
        orm.status = status.value
        orm.updated_at = datetime.now(UTC)
        await self.session.commit()
        return _remediation_from_orm(orm)

    async def promote_finding_to_regression(self, finding_id: str, kind: RegressionKind, created_by: str) -> RegressionCase:
        finding = await self.session.get(FindingORM, finding_id)
        if not finding:
            raise ValueError(f"Finding {finding_id} not found")
        history = await self.list_review_decision_history(finding_id)
        decision = history[-1] if history else None
        if not decision or decision.outcome != ReviewOutcome.AGREE:
            raise ValueError("The current review must agree with a finding before regression promotion")
        run = await self.get_run(finding.run_id)
        if not run:
            raise ValueError("Source run is unavailable")
        case = RegressionCase(
            tenant_id=run.experiment.tenant_id,
            kind=kind,
            finding_id=finding_id,
            source_run_id=finding.run_id,
            source_target_version_id=run.experiment.target_version_id,
            record={
                "row_id": finding.row_id,
                "query": finding.evidence.get("query", ""),
                "response": finding.evidence.get("response", ""),
                "trace_id": finding.evidence.get("trace_id"),
            },
            provenance={
                "finding_id": finding_id,
                "review_decision_id": decision.decision_id,
                "source_experiment_version_id": run.experiment_version_id,
                "source_manifest_id": run.run_manifest_id,
            },
            created_by=created_by,
        )
        self.session.add(
            RegressionCaseORM(
                regression_case_id=case.regression_case_id,
                tenant_id=case.tenant_id,
                kind=case.kind.value,
                status=case.status,
                finding_id=case.finding_id,
                source_run_id=case.source_run_id,
                source_target_version_id=case.source_target_version_id,
                record=case.record,
                provenance=case.provenance,
                created_by=case.created_by,
                created_at=case.created_at,
            )
        )
        finding.status = FindingStatus.PROMOTED.value
        await self.session.commit()
        return case

    async def get_regression_case(self, regression_case_id: str) -> RegressionCase | None:
        orm = await self.session.get(RegressionCaseORM, regression_case_id)
        return _regression_case_from_orm(orm) if orm else None

    async def list_regression_cases(self, tenant_id: str | None = None) -> list[RegressionCase]:
        statement = select(RegressionCaseORM)
        if tenant_id:
            statement = statement.where(tenant_clause(RegressionCaseORM, tenant_id))
        result = await self.session.execute(statement.order_by(RegressionCaseORM.created_at.desc()))
        return [_regression_case_from_orm(orm) for orm in result.scalars().all()]

    async def get_evidence_pack(self, run_id: str, tenant_id: str) -> EvidencePack | None:
        if not await self.run_exists(run_id, tenant_id):
            return None
        result = await self.session.execute(select(EvidencePackORM).where(EvidencePackORM.run_id == run_id))
        orm = result.scalar_one_or_none()
        return _evidence_pack_from_orm(orm) if orm else None

    async def annotate_evidence_pack(self, run_id: str, tenant_id: str, additions: dict) -> EvidencePack | None:
        if not await self.run_exists(run_id, tenant_id):
            return None
        result = await self.session.execute(select(EvidencePackORM).where(EvidencePackORM.run_id == run_id))
        orm = result.scalar_one_or_none()
        if not orm:
            return None
        orm.contents = {**(orm.contents or {}), **redact_for_persistence(additions)}
        await self.session.commit()
        return _evidence_pack_from_orm(orm)

    async def record_audit(self, event: AuditEvent) -> AuditEvent:
        self.session.add(
            AuditEventORM(
                audit_event_id=event.audit_event_id,
                tenant_id=event.tenant_id,
                actor=event.actor,
                action=event.action,
                resource_type=event.resource_type,
                resource_id=event.resource_id,
                details=redact_for_persistence(event.details),
                created_at=event.created_at,
            )
        )
        await self.session.commit()
        return event

    async def list_audit_events(self, tenant_id: str | None = None, limit: int = 100) -> list[AuditEvent]:
        statement = select(AuditEventORM)
        if tenant_id:
            statement = statement.where(tenant_clause(AuditEventORM, tenant_id))
        result = await self.session.execute(statement.order_by(AuditEventORM.created_at.desc()).limit(limit))
        return [_audit_event_from_orm(orm) for orm in result.scalars().all()]

    async def compare_runs(
        self,
        experiment_id: str,
        base_run_id: str,
        candidate_run_id: str,
        *,
        metric_id: str | None = None,
        tenant_id: str | None = None,
    ) -> RunComparison:
        base = await self.get_run(base_run_id, tenant_id=tenant_id)
        candidate = await self.get_run(candidate_run_id, tenant_id=tenant_id)
        if not base or not await self.experiment_has_run(experiment_id, base_run_id):
            raise ValueError(f"Base run {base_run_id} not found for experiment")
        if not candidate or not await self.experiment_has_run(experiment_id, candidate_run_id):
            raise ValueError(f"Candidate run {candidate_run_id} not found for experiment")
        # Comparable only when both runs report the same recorded basis: hash
        # AND basis version, or — when neither recorded a hash — the same exact
        # ``experiment_version_id``. Same rule as every attach path.
        base_basis = recorded_comparison_basis(base)
        if not base_basis or recorded_comparison_basis(candidate) != base_basis:
            raise ValueError(f"Candidate run {candidate_run_id} does not share the recorded comparison basis")

        base_kpis = {k.kpi_id: k for k in base.kpi_results}
        cand_kpis = {k.kpi_id: k for k in candidate.kpi_results}
        kpi_ids = sorted(set(base_kpis) | set(cand_kpis))
        kpi_deltas = []
        for kid in kpi_ids:
            b = base_kpis.get(kid)
            c = cand_kpis.get(kid)
            b_score = b.composite_score if b else None
            c_score = c.composite_score if c else None
            delta = None if b_score is None or c_score is None else round(c_score - b_score, 4)
            kpi_deltas.append(
                {
                    "kpi_id": kid,
                    "base_score": b_score,
                    "candidate_score": c_score,
                    "delta": delta,
                    "base_gate": b.gate_result.value if b and b.gate_result else None,
                    "candidate_gate": c.gate_result.value if c and c.gate_result else None,
                }
            )

        def _failed_metrics(run: RunResult) -> set[str]:
            failed: set[str] = set()
            for mr in run.metric_results:
                if mr.passed is False:
                    failed.add(mr.metric_id)
            return failed

        base_fail = _failed_metrics(base)
        cand_fail = _failed_metrics(candidate)
        def _complete_metric_cases(run: RunResult, metric: str) -> set[str] | None:
            results = [result for result in run.metric_results if result.metric_id == metric]
            if not results or any(result.passed is None for result in results):
                return None
            return {result.row_id for result in results}

        comparable_metrics = {
            metric for metric in base_fail | cand_fail
            if (cases := _complete_metric_cases(base, metric)) is not None
            and cases == _complete_metric_cases(candidate, metric)
        }
        metric_failures = {
            "new": sorted((cand_fail - base_fail) & comparable_metrics),
            "fixed": sorted((base_fail - cand_fail) & comparable_metrics),
            "persistent": sorted(base_fail & cand_fail),
        }

        def _quality_score(run: RunResult) -> float | None:
            values = [result.composite_score for result in run.kpi_results if result.composite_score is not None]
            return round(sum(values) / len(values), 4) if values else None

        def _row_scores(run: RunResult) -> dict[str, dict[str, float | None]]:
            grouped: dict[str, dict[str, float | None]] = {}
            for result in run.metric_results:
                if metric_id and result.metric_id != metric_id:
                    continue
                if result.metric_id.startswith("ops.") or result.metric_applicability == MetricApplicability.NOT_APPLICABLE:
                    continue
                grouped.setdefault(result.row_id, {})[result.metric_id] = result.normalised_score
            return grouped

        def _row_mean(values: dict[str, float | None]) -> float | None:
            if not values or any(value is None for value in values.values()):
                return None
            return round(sum(values.values()) / len(values), 4)

        base_rows = _row_scores(base)
        candidate_rows = _row_scores(candidate)
        sample_counts = {"improved": 0, "regressed": 0, "same": 0, "unavailable": 0}
        sample_deltas = []
        for row_id in sorted(set(base_rows) | set(candidate_rows)):
            base_values = base_rows.get(row_id, {})
            candidate_values = candidate_rows.get(row_id, {})
            base_score = _row_mean(base_values)
            candidate_score = _row_mean(candidate_values)
            delta = (
                round(candidate_score - base_score, 4)
                if base_score is not None and candidate_score is not None
                and base_values.keys() == candidate_values.keys()
                else None
            )
            if delta is None:
                result = "unavailable"
            elif abs(delta) < 0.005:
                result = "same"
            elif delta > 0:
                result = "improved"
            else:
                result = "regressed"
            sample_counts[result] += 1
            sample_deltas.append(
                {
                    "row_id": row_id,
                    "base_score": base_score,
                    "candidate_score": candidate_score,
                    "delta": delta,
                    "result": result,
                }
            )

        async def _average_latency(run_id: str) -> float | None:
            result = await self.session.execute(
                select(EvaluationRunItemORM.latency_ms).where(
                    EvaluationRunItemORM.run_id == run_id,
                    EvaluationRunItemORM.latency_ms.is_not(None),
                )
            )
            values = [value for value in result.scalars().all() if value is not None]
            return round(sum(values) / len(values), 2) if values else None

        base_quality_score = _quality_score(base)
        candidate_quality_score = _quality_score(candidate)
        quality_delta = None if base_quality_score is None or candidate_quality_score is None else round(candidate_quality_score - base_quality_score, 4)
        base_latency_ms = await _average_latency(base_run_id)
        candidate_latency_ms = await _average_latency(candidate_run_id)
        latency_delta_percent = None if base_latency_ms in (None, 0) or candidate_latency_ms is None else round(((candidate_latency_ms - base_latency_ms) / base_latency_ms) * 100, 2)

        base_measurements = measurement_values(base, metric_id)
        candidate_measurements = measurement_values(candidate, metric_id)
        measurement_deltas = []
        for measured_metric in sorted(set(base_measurements) | set(candidate_measurements)):
            base_values = base_measurements.get(measured_metric) or []
            candidate_values = candidate_measurements.get(measured_metric) or []
            base_mean = round(sum(base_values) / len(base_values), 4) if base_values else None
            candidate_mean = (
                round(sum(candidate_values) / len(candidate_values), 4) if candidate_values else None
            )
            measurement_deltas.append(
                {
                    "metric_id": measured_metric,
                    "base": base_mean,
                    "candidate": candidate_mean,
                    # Signed, and deliberately unjudged: more tokens is not a
                    # failure, it is a fact the reader weighs. Naming a winner
                    # here would reintroduce the verdict these metrics do not
                    # carry.
                    "delta": (
                        None
                        if base_mean is None or candidate_mean is None
                        else round(candidate_mean - base_mean, 4)
                    ),
                    "base_sample_size": len(base_values),
                    "candidate_sample_size": len(candidate_values),
                }
            )

        metadata_diff = {
            "experiment_version_id": {
                "base": base.experiment_version_id,
                "candidate": candidate.experiment_version_id,
            },
            "dataset_version": {
                "base": base.experiment.dataset_version,
                "candidate": candidate.experiment.dataset_version,
            },
            "target_endpoint": {
                "base": base.experiment.target_endpoint,
                "candidate": candidate.experiment.target_endpoint,
            },
            "judge_model": {
                "base": base.experiment.judge_model,
                "candidate": candidate.experiment.judge_model,
            },
            "target_version": {
                "base": base.experiment.target_version,
                "candidate": candidate.experiment.target_version,
            },
        }

        return RunComparison(
            experiment_id=experiment_id,
            base_run_id=base_run_id,
            candidate_run_id=candidate_run_id,
            base_gate=base.overall_gate,
            candidate_gate=candidate.overall_gate,
            kpi_deltas=kpi_deltas,
            sample_deltas=sample_deltas,
            measurement_deltas=measurement_deltas,
            base_quality_score=base_quality_score,
            candidate_quality_score=candidate_quality_score,
            quality_delta=quality_delta,
            base_latency_ms=base_latency_ms,
            candidate_latency_ms=candidate_latency_ms,
            latency_delta_percent=latency_delta_percent,
            sample_counts=sample_counts,
            metric_failures=metric_failures,
            metadata_diff=metadata_diff,
        )

    async def _next_run_number(self, experiment_id: str) -> int:
        result = await self.session.execute(select(func.max(EvaluationRunORM.run_number)).where(EvaluationRunORM.experiment_id == experiment_id))
        return (result.scalar() or 0) + 1

    async def _upsert_experiment_version(
        self,
        *,
        experiment_id: str,
        experiment_version_id: str,
        experiment: ExperimentDefinition,
        active_metrics: list[str],
        created_by: str,
    ) -> None:
        existing = await self.session.get(ExperimentVersionORM, experiment_version_id)
        if existing:
            return
        contract = {
            "dataset_version": experiment.dataset_version,
            "target_endpoint": experiment.target_endpoint,
            "scenario": experiment.scenario.value,
            "has_ground_truth": experiment.has_ground_truth,
            "judge_model": experiment.judge_model,
            "judge_temperature": experiment.judge_temperature,
            "safety_defect_tolerance": experiment.safety_defect_tolerance,
            "kpi_threshold_overrides": experiment.kpi_threshold_overrides,
            "metrics": sorted(active_metrics),
            "prompt_version": experiment.quality_profile_version,
            "target_id": experiment.target_id,
            "target_version": experiment.target_version,
            "target_version_id": experiment.target_version_id,
            "project_id": experiment.project_id,
            "quality_profile_id": experiment.quality_profile_id,
            "quality_profile_version": experiment.quality_profile_version,
            "gate_policy_id": experiment.gate_policy_id,
            "gate_policy_version": experiment.gate_policy_version,
            "benchmark_package_id": experiment.benchmark_package_id,
            "benchmark_package_version": experiment.benchmark_package_version,
            "run_manifest_id": experiment.run_manifest_id,
        }
        self.session.add(
            ExperimentVersionORM(
                experiment_version_id=experiment_version_id,
                experiment_id=experiment_id,
                contract_json=contract,
                contract_hash=experiment_version_id.removeprefix("exp-"),
                created_by=created_by,
            )
        )

    async def _find_run_with_role(self, experiment_id: str, role: RunRole) -> ExperimentRunLinkORM | None:
        result = await self.session.execute(
            select(ExperimentRunLinkORM).where(
                ExperimentRunLinkORM.experiment_id == experiment_id,
                ExperimentRunLinkORM.role == role.value,
            )
        )
        return result.scalar_one_or_none()

    async def _list_run_links(self, experiment_id: str) -> list[ExperimentRunLink]:
        result = await self.session.execute(select(ExperimentRunLinkORM).where(ExperimentRunLinkORM.experiment_id == experiment_id).order_by(ExperimentRunLinkORM.run_number.asc()))
        return [
            ExperimentRunLink(
                experiment_id=lnk.experiment_id,
                run_id=lnk.run_id,
                run_number=lnk.run_number,
                role=RunRole(lnk.role),
                created_at=lnk.created_at,
            )
            for lnk in result.scalars().all()
        ]

    # ------------------------------------------------------------------
    # Versioned quality-contract control plane.
    # ------------------------------------------------------------------

    async def save_project(self, project: EvaluationProject) -> EvaluationProject:
        existing = await self.session.get(EvaluationProjectORM, project.project_id)
        if existing:
            raise ValueError(f"Evaluation project {project.project_id} already exists")
        orm = EvaluationProjectORM(
            project_id=project.project_id,
            tenant_id=project.tenant_id,
            name=project.name,
            description=project.description,
            system_type=project.system_type,
            owner=project.owner,
            status=project.status.value,
            purpose=project.purpose.value if project.purpose else None,
            tags=project.tags,
            created_by=project.created_by,
            created_at=project.created_at,
        )
        self.session.add(orm)
        await self.session.commit()
        return _project_from_orm(orm)

    async def get_project(self, project_id: str, tenant_id: str | None = None) -> EvaluationProject | None:
        orm = await self.session.get(EvaluationProjectORM, project_id)
        if not orm or (tenant_id and not tenants_match(orm.tenant_id, tenant_id)):
            return None
        return _project_from_orm(orm)

    async def list_projects(self, tenant_id: str) -> list[EvaluationProject]:
        result = await self.session.execute(select(EvaluationProjectORM).where(tenant_clause(EvaluationProjectORM, tenant_id)).order_by(EvaluationProjectORM.created_at.desc()))
        return [_project_from_orm(orm) for orm in result.scalars().all()]

    async def set_project_purpose(self, project_id: str, tenant_id: str, purpose: ProjectPurpose) -> EvaluationProject | None:
        orm = await self.session.get(EvaluationProjectORM, project_id)
        if not orm or not tenants_match(orm.tenant_id, tenant_id):
            return None
        orm.purpose = purpose.value
        await self.session.commit()
        return _project_from_orm(orm)

    async def list_trace_projects(self, tenant_id: str) -> list[dict]:
        """List evaluation trace Projects without inventing historical purpose."""

        result = await self.session.execute(
            select(
                EvaluationProjectORM,
                func.count(func.distinct(EvaluationRunItemORM.trace_id)),
                func.max(EvaluationRunItemORM.captured_at),
            )
            .outerjoin(
                ExperimentORM,
                ExperimentORM.project_id == EvaluationProjectORM.project_id,
            )
            .outerjoin(
                EvaluationRunORM,
                EvaluationRunORM.experiment_id == ExperimentORM.experiment_id,
            )
            .outerjoin(
                EvaluationRunItemORM,
                (EvaluationRunItemORM.run_id == EvaluationRunORM.run_id) & EvaluationRunItemORM.trace_id.is_not(None) & (EvaluationRunItemORM.trace_id != ""),
            )
            .where(
                tenant_clause(EvaluationProjectORM, tenant_id),
                or_(
                    EvaluationProjectORM.purpose == ProjectPurpose.SYSTEM.value,
                    EvaluationProjectORM.purpose.is_(None),
                ),
            )
            .group_by(EvaluationProjectORM.project_id)
            .order_by(EvaluationProjectORM.name.asc())
        )
        return [
            {
                **_project_from_orm(project).model_dump(mode="json"),
                "classification_state": ("classified" if project.purpose else "unclassified_historical"),
                "trace_count": int(trace_count or 0),
                "last_activity_at": last_activity,
            }
            for project, trace_count, last_activity in result.all()
        ]

    async def list_project_traces(
        self,
        project_id: str,
        tenant_id: str,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        """Return bounded genuine trace identities for one evaluation Project."""

        ranked = (
            select(
                EvaluationRunItemORM.run_id.label("run_id"),
                EvaluationRunItemORM.example_id.label("example_id"),
                func.row_number()
                .over(
                    partition_by=EvaluationRunItemORM.trace_id,
                    order_by=(
                        EvaluationRunItemORM.captured_at.desc(),
                        EvaluationRunItemORM.sequence_position.asc(),
                    ),
                )
                .label("trace_row_number"),
            )
            .join(
                EvaluationRunORM,
                EvaluationRunORM.run_id == EvaluationRunItemORM.run_id,
            )
            .join(
                ExperimentORM,
                ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
            )
            .join(
                EvaluationProjectORM,
                EvaluationProjectORM.project_id == ExperimentORM.project_id,
            )
            .where(
                EvaluationProjectORM.project_id == project_id,
                tenant_clause(EvaluationProjectORM, tenant_id),
                or_(
                    EvaluationProjectORM.purpose == ProjectPurpose.SYSTEM.value,
                    EvaluationProjectORM.purpose.is_(None),
                ),
                EvaluationRunItemORM.trace_id.is_not(None),
                EvaluationRunItemORM.trace_id != "",
            )
            .subquery()
        )
        result = await self.session.execute(
            select(EvaluationRunItemORM, EvaluationRunORM, ExperimentORM)
            .join(
                ranked,
                (ranked.c.run_id == EvaluationRunItemORM.run_id) & (ranked.c.example_id == EvaluationRunItemORM.example_id),
            )
            .join(EvaluationRunORM, EvaluationRunORM.run_id == EvaluationRunItemORM.run_id)
            .join(
                ExperimentORM,
                ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
            )
            .where(ranked.c.trace_row_number == 1)
            .order_by(
                EvaluationRunItemORM.captured_at.desc(),
                EvaluationRunItemORM.sequence_position.asc(),
            )
            .offset(offset)
            .limit(limit)
        )
        return [_trace_summary(item, run, experiment) for item, run, experiment in result.all()]

    async def list_project_traces_page(
        self,
        project_id: str,
        tenant_id: str,
        *,
        limit: int = 50,
        cursor: str | None = None,
        search: str | None = None,
        run_id: str | None = None,
        status: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> dict:
        """Cursor-paginated trace identities for one evaluation Project.

        Keyset paging on ``(captured_at DESC, trace_id ASC)`` — stable under
        insertion, unlike offset. Returns ``{items, next_cursor, has_more,
        total}`` where ``total`` is the distinct-trace count for the Project
        (honest "N of M"). Covers only eval-derived traces; a collector-backed
        index for non-eval executions is deferred.

        Optional filters, all applied in SQL so the keyset cursor and the
        distinct-trace ``total`` stay correct under them:

        - ``search``: case-insensitive substring over trace id, evaluation
          (experiment) name and example id.
        - ``run_id``: exact evaluation-run identity.
        - ``status``: invocation outcome (``succeeded``/``error``/``unknown``),
          derived exactly as :func:`_trace_summary` derives it.
        - ``since``/``until``: inclusive bounds on the same coalesced
          captured-at expression the sort and cursor use.
        """

        # The displayed capture time coalesces item/run timestamps; cursor on the
        # same expression so ordering and the keyset filter never disagree.
        sort_key = func.coalesce(
            EvaluationRunItemORM.captured_at,
            EvaluationRunORM.completed_at,
            EvaluationRunORM.started_at,
        )
        project_filter = (
            EvaluationProjectORM.project_id == project_id,
            tenant_clause(EvaluationProjectORM, tenant_id),
            or_(
                EvaluationProjectORM.purpose == ProjectPurpose.SYSTEM.value,
                EvaluationProjectORM.purpose.is_(None),
            ),
            EvaluationRunItemORM.trace_id.is_not(None),
            EvaluationRunItemORM.trace_id != "",
            # Row-level query filters live here so the representative-row
            # ranking, the page rows and the distinct-trace total all see the
            # same universe of rows: a trace matches when any of its captured
            # rows match, and its representative (hence its keyset sort_key) is
            # the newest matching row.
            *_trace_query_filters(
                search=search,
                run_id=run_id,
                status=status,
                since=since,
                until=until,
                sort_key=sort_key,
            ),
        )

        ranked = (
            select(
                EvaluationRunItemORM.run_id.label("run_id"),
                EvaluationRunItemORM.example_id.label("example_id"),
                func.row_number()
                .over(
                    partition_by=EvaluationRunItemORM.trace_id,
                    # Pick the representative row per trace by the SAME coalesced
                    # sort_key the outer keyset uses, with run_id/example_id as
                    # stable tie-breakers. Without this, a trace whose rows share
                    # (NULL captured_at, equal position) could resolve to a
                    # different run between requests, shifting its sort_key and
                    # repeating/skipping the trace across page boundaries.
                    order_by=(
                        sort_key.desc(),
                        EvaluationRunItemORM.run_id.asc(),
                        EvaluationRunItemORM.example_id.asc(),
                    ),
                )
                .label("trace_row_number"),
            )
            .join(EvaluationRunORM, EvaluationRunORM.run_id == EvaluationRunItemORM.run_id)
            .join(
                ExperimentORM,
                ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
            )
            .join(
                EvaluationProjectORM,
                EvaluationProjectORM.project_id == ExperimentORM.project_id,
            )
            .where(*project_filter)
            .subquery()
        )

        base = (
            select(
                EvaluationRunItemORM,
                EvaluationRunORM,
                ExperimentORM,
                sort_key.label("sort_key"),
            )
            .join(
                ranked,
                (ranked.c.run_id == EvaluationRunItemORM.run_id) & (ranked.c.example_id == EvaluationRunItemORM.example_id),
            )
            .join(EvaluationRunORM, EvaluationRunORM.run_id == EvaluationRunItemORM.run_id)
            .join(
                ExperimentORM,
                ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
            )
            .where(ranked.c.trace_row_number == 1)
        )

        decoded = _decode_trace_cursor(cursor)
        if decoded is not None:
            cursor_at, cursor_trace_id = decoded
            base = base.where(
                or_(
                    sort_key < cursor_at,
                    (sort_key == cursor_at) & (EvaluationRunItemORM.trace_id > cursor_trace_id),
                )
            )

        # Fetch one extra row to decide has_more without a second query.
        result = await self.session.execute(base.order_by(sort_key.desc(), EvaluationRunItemORM.trace_id.asc()).limit(limit + 1))
        rows = result.all()
        has_more = len(rows) > limit
        rows = rows[:limit]

        total = await self.session.scalar(
            select(func.count(func.distinct(EvaluationRunItemORM.trace_id)))
            .join(EvaluationRunORM, EvaluationRunORM.run_id == EvaluationRunItemORM.run_id)
            .join(
                ExperimentORM,
                ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
            )
            .join(
                EvaluationProjectORM,
                EvaluationProjectORM.project_id == ExperimentORM.project_id,
            )
            .where(*project_filter)
        )

        items = [_trace_summary(item, run, experiment) for item, run, experiment, _ in rows]
        next_cursor = None
        if has_more and rows:
            last_item, _run, _exp, last_sort = rows[-1]
            next_cursor = _encode_trace_cursor(last_sort, last_item.trace_id)
        return {
            "items": items,
            "next_cursor": next_cursor,
            "has_more": has_more,
            "total": int(total or 0),
            "hidden_count": 0,
            # Eval-derived projection (fallback when the collector-confirmed
            # index has no rows for this Project yet).
            "source": "projection",
        }

    async def get_project_trace(self, project_id: str, tenant_id: str, trace_id: str) -> dict | None:
        """Return a genuine trace identity without fabricating an OTel lifecycle.

        Evaluation run items are case-level evidence references. They are not
        archived OpenTelemetry spans, even when a runtime trace/span identity is
        attached to the case. The archive reader is owned by the collector and
        storage path, so this endpoint keeps the lifecycle unavailable until
        those real span records can be loaded.
        """

        indexed = await self.session.scalar(
            select(CapturedTraceIndexORM).where(
                tenant_clause(CapturedTraceIndexORM, tenant_id),
                CapturedTraceIndexORM.project_id.is_(None) if project_id == "unassigned" else CapturedTraceIndexORM.project_id == project_id,
                CapturedTraceIndexORM.trace_id == trace_id,
            )
        )
        if indexed is not None:
            summaries = await self._eval_trace_summaries(tenant_id, [trace_id] if indexed.is_evaluated else [])
            return {
                **_index_trace_item(indexed, summaries.get(trace_id)),
                "spans": [],
                "tree_available": False,
                "lifecycle_state": "unknown",
            }
        if project_id == "unassigned":
            return None

        result = await self.session.execute(
            select(EvaluationRunItemORM, EvaluationRunORM, ExperimentORM)
            .join(EvaluationRunORM, EvaluationRunORM.run_id == EvaluationRunItemORM.run_id)
            .join(
                ExperimentORM,
                ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
            )
            .join(
                EvaluationProjectORM,
                EvaluationProjectORM.project_id == ExperimentORM.project_id,
            )
            .where(
                EvaluationProjectORM.project_id == project_id,
                tenant_clause(EvaluationProjectORM, tenant_id),
                or_(
                    EvaluationProjectORM.purpose == ProjectPurpose.SYSTEM.value,
                    EvaluationProjectORM.purpose.is_(None),
                ),
                EvaluationRunItemORM.trace_id == trace_id,
            )
            .order_by(
                EvaluationRunItemORM.captured_at.desc(),
                EvaluationRunItemORM.sequence_position.asc(),
            )
            .limit(100)
        )
        rows = result.all()
        if not rows:
            return None
        # One trace is one execution. Re-evaluating the same captured evidence
        # may persist the same trace ID on another run; never merge those rows
        # into a synthetic cross-run span tree.
        selected_run_id = rows[0][0].run_id
        rows = [row for row in rows if row[0].run_id == selected_run_id]
        first_item, first_run, first_experiment = rows[0]
        summary = _trace_summary(first_item, first_run, first_experiment)
        return {
            **summary,
            "spans": [],
            "tree_available": False,
            "lifecycle_state": "archive_unavailable",
            "lifecycle_message": ("A genuine trace ID was recorded, but archived OpenTelemetry spans are not available through this service yet."),
        }

    # ── Collector-confirmed trace index (tracing) ────────────────────────
    # Worker→index projection over the S3 trace archive. These methods are the
    # only writers/readers of captured_trace_index / captured_span_index.

    async def _insert_trace_rows_ignore_conflicts(self, rows: list[dict]) -> int:
        """Atomic ``INSERT ... ON CONFLICT DO NOTHING`` for trace-index rows.

        Concurrent workers can race a check-then-insert on the same
        (tenant, trace) primary key; letting the database ignore the duplicate
        keeps every tick commit-safe. Returns the number of rows inserted.
        """

        if not rows:
            return 0
        dialect = self.session.get_bind().dialect.name
        if dialect == "postgresql":
            from sqlalchemy.dialects.postgresql import insert as dialect_insert
        else:
            from sqlalchemy.dialects.sqlite import insert as dialect_insert
        statement = dialect_insert(CapturedTraceIndexORM).on_conflict_do_nothing(index_elements=["tenant_id", "trace_id"])
        inserted = 0
        # Single-row executes: executemany with ON CONFLICT does not report a
        # reliable rowcount on every driver.
        for row in rows:
            result = await self.session.execute(statement.values(**row))
            inserted += int(result.rowcount or 0)
        return inserted

    async def upsert_requested_traces_from_run_items(self, default_tenant: str, *, limit: int = 500) -> int:
        """Index evaluation run items that carry genuine trace ids.

        New rows start honest: ``requested`` (nothing checked), statistics NULL,
        ``is_evaluated=True``. Rows previously discovered from the archive are
        marked evaluated (and given a Project home) once a run item references
        them. Idempotent; returns the number of newly inserted rows.
        """

        tenant_expr = func.coalesce(ExperimentORM.tenant_id, default_tenant)
        candidates = await self.session.execute(
            select(
                EvaluationRunItemORM.trace_id,
                tenant_expr.label("tenant_id"),
                ExperimentORM.project_id,
                func.max(EvaluationRunItemORM.captured_at).label("captured_at"),
            )
            .join(EvaluationRunORM, EvaluationRunORM.run_id == EvaluationRunItemORM.run_id)
            .join(
                ExperimentORM,
                ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
            )
            .outerjoin(
                CapturedTraceIndexORM,
                (CapturedTraceIndexORM.trace_id == EvaluationRunItemORM.trace_id)
                & (_tenant_namespace_sql(CapturedTraceIndexORM.tenant_id) == _tenant_namespace_sql(tenant_expr)),
            )
            .where(
                EvaluationRunItemORM.trace_id.is_not(None),
                EvaluationRunItemORM.trace_id != "",
                CapturedTraceIndexORM.trace_id.is_(None),
            )
            .group_by(EvaluationRunItemORM.trace_id, tenant_expr, ExperimentORM.project_id)
            .limit(limit)
        )
        seen: set[tuple[str, str]] = set()
        pending_rows: list[dict] = []
        for trace_id, tenant_id, project_id, captured_at in candidates.all():
            # Normalise to the namespace spelling before dedup/insert — the join
            # already compares namespace-normalised, but two experiments storing
            # "x" and "tenant-x" would otherwise produce two index rows for the
            # same trace (the tenant_id_candidates dup-row finding).
            tenant_id = namespace_for_tenant(tenant_id)
            key = (tenant_id, trace_id)
            if key in seen:
                continue
            seen.add(key)
            pending_rows.append(
                {
                    "tenant_id": tenant_id,
                    "trace_id": trace_id,
                    "project_id": project_id,
                    "started_at": captured_at,
                    "is_evaluated": True,
                    "lifecycle_state": TraceLifecycleState.REQUESTED.value,
                }
            )
        inserted = await self._insert_trace_rows_ignore_conflicts(pending_rows)

        # Archive-discovered rows referenced by an evaluation item afterwards.
        referenced = await self.session.execute(
            select(
                CapturedTraceIndexORM,
                ExperimentORM.project_id,
                EvaluationRunItemORM.captured_at,
            )
            .join(
                EvaluationRunItemORM,
                EvaluationRunItemORM.trace_id == CapturedTraceIndexORM.trace_id,
            )
            .join(EvaluationRunORM, EvaluationRunORM.run_id == EvaluationRunItemORM.run_id)
            .join(
                ExperimentORM,
                ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
            )
            .where(
                or_(
                    CapturedTraceIndexORM.is_evaluated.is_(False),
                    CapturedTraceIndexORM.started_at.is_(None),
                ),
                _tenant_namespace_sql(CapturedTraceIndexORM.tenant_id) == _tenant_namespace_sql(tenant_expr),
            )
            .order_by(EvaluationRunItemORM.captured_at.desc())
            .limit(limit)
        )
        referenced_seen: set[tuple[str, str]] = set()
        for orm, project_id, captured_at in referenced.all():
            key = (orm.tenant_id, orm.trace_id)
            if key in referenced_seen:
                continue
            referenced_seen.add(key)
            if not orm.is_evaluated:
                # Revisit a production trace once a case adopts it, including
                # any span checks explicitly configured on that evaluation.
                orm.lifecycle_state = TraceLifecycleState.REQUESTED.value
            orm.is_evaluated = True
            if orm.project_id is None and project_id:
                orm.project_id = project_id
            if orm.started_at is None and captured_at is not None:
                orm.started_at = captured_at
        await self.session.commit()
        return inserted

    async def insert_discovered_traces(
        self,
        tenant_id: str,
        trace_ids: list[str],
        *,
        created_at: datetime | None = None,
    ) -> int:
        """Record archive-discovered (non-evaluation) trace ids, idempotently.

        Rows start ``requested`` with ``is_evaluated=False`` and no Project —
        the confirm pass reads the spans, records real statistics and resolves
        a Project through TargetProjectBinding when resource attributes allow.
        """

        cleaned = [t for t in dict.fromkeys(trace_ids) if t]
        if not cleaned:
            return 0
        rows = []
        for trace_id in cleaned:
            row = {
                "tenant_id": tenant_id,
                "trace_id": trace_id,
                "is_evaluated": False,
                "lifecycle_state": TraceLifecycleState.REQUESTED.value,
            }
            if created_at is not None:
                row["created_at"] = created_at
            rows.append(row)
        inserted = await self._insert_trace_rows_ignore_conflicts(rows)
        await self.session.commit()
        return inserted

    async def list_trace_index_rows_to_check(self, tenant_id: str, *, limit: int, pending_recheck_cutoff: datetime) -> list[dict]:
        """Unconfirmed rows due for an archive check, oldest-checked first.

        ``pending_export`` rows older than the grace window are left alone
        (their export never landed; re-checking every tick is pure churn).
        ``archive_unavailable`` rows are always retried — the archive may
        recover.
        """

        result = await self.session.execute(
            select(CapturedTraceIndexORM)
            .where(
                tenant_clause(CapturedTraceIndexORM, tenant_id),
                CapturedTraceIndexORM.lifecycle_state != TraceLifecycleState.ARCHIVE_CONFIRMED.value,
                or_(
                    CapturedTraceIndexORM.lifecycle_state != TraceLifecycleState.PENDING_EXPORT.value,
                    CapturedTraceIndexORM.created_at >= pending_recheck_cutoff,
                ),
            )
            .order_by(
                case((CapturedTraceIndexORM.last_checked_at.is_(None), 0), else_=1),
                CapturedTraceIndexORM.last_checked_at.asc(),
                CapturedTraceIndexORM.created_at.asc(),
                CapturedTraceIndexORM.trace_id.asc(),
            )
            .limit(limit)
        )
        return [
            {
                "trace_id": orm.trace_id,
                "project_id": orm.project_id,
                "lifecycle_state": orm.lifecycle_state,
                "is_evaluated": orm.is_evaluated,
                "started_at": orm.started_at,
                "created_at": orm.created_at,
            }
            for orm in result.scalars().all()
        ]

    async def list_trace_rows_needing_span_rebuild(self, tenant_id: str, *, limit: int) -> list[dict]:
        """Bounded rebuild candidates: confirmed traces whose span rows are stale.

        Selected on the derivation revision rather than on missing rows, so a
        trace indexed by an older derivation is re-read and re-summarised. A
        trace that never got span rows has a NULL revision and is covered by the
        same predicate.
        """

        result = await self.session.execute(
            select(CapturedTraceIndexORM)
            .where(
                tenant_clause(CapturedTraceIndexORM, tenant_id),
                CapturedTraceIndexORM.lifecycle_state == TraceLifecycleState.ARCHIVE_CONFIRMED.value,
                CapturedTraceIndexORM.span_count.is_not(None),
                or_(
                    CapturedTraceIndexORM.span_index_rev.is_(None),
                    # Strictly older only. During a rolling deploy an outgoing
                    # worker would otherwise keep reclaiming rows the incoming
                    # one just derived, and the two would overwrite each other.
                    CapturedTraceIndexORM.span_index_rev < SPAN_INDEX_REV,
                ),
            )
            .order_by(
                CapturedTraceIndexORM.last_checked_at.asc(),
                CapturedTraceIndexORM.created_at.asc(),
                CapturedTraceIndexORM.trace_id.asc(),
            )
            .limit(limit)
        )
        return [
            {
                "trace_id": orm.trace_id,
                "project_id": orm.project_id,
                "lifecycle_state": orm.lifecycle_state,
                "is_evaluated": orm.is_evaluated,
                "started_at": orm.started_at,
                "created_at": orm.created_at,
                # What is already indexed, so a rebuild can refuse to replace a
                # complete summary with a truncated re-read.
                "span_count": orm.span_count,
            }
            for orm in result.scalars().all()
        ]

    async def confirm_trace_index_row(
        self,
        tenant_id: str,
        trace_id: str,
        *,
        project_id: str | None,
        root_span_name: str | None,
        root_span_kind: str | None,
        span_count: int,
        error_count: int,
        model: str | None,
        started_at: datetime | None,
        duration_ms: float | None,
        estimated_cost_usd: float | None,
        span_rows: list[dict],
        checked_at: datetime,
    ) -> None:
        """Record a genuine archive confirmation plus bounded span summaries."""

        orm = await self.session.get(CapturedTraceIndexORM, (tenant_id, trace_id))
        if orm is None:
            return
        if project_id is not None:
            orm.project_id = project_id
        orm.root_span_name = root_span_name
        orm.root_span_kind = root_span_kind
        orm.span_count = span_count
        orm.error_count = error_count
        orm.model = model
        orm.started_at = started_at
        orm.duration_ms = duration_ms
        orm.estimated_cost_usd = estimated_cost_usd
        orm.lifecycle_state = TraceLifecycleState.ARCHIVE_CONFIRMED.value
        orm.last_checked_at = checked_at
        orm.span_index_rev = SPAN_INDEX_REV
        await self.session.execute(
            delete(CapturedSpanIndexORM).where(
                tenant_clause(CapturedSpanIndexORM, tenant_id),
                CapturedSpanIndexORM.trace_id == trace_id,
            )
        )
        for row in span_rows:
            self.session.add(
                CapturedSpanIndexORM(
                    tenant_id=tenant_id,
                    trace_id=trace_id,
                    project_id=orm.project_id,
                    **row,
                )
            )
        await self.session.commit()

    async def mark_trace_index_checked(
        self,
        tenant_id: str,
        trace_id: str,
        lifecycle_state: str,
        *,
        checked_at: datetime,
    ) -> None:
        """Record a check outcome; a confirmed row is never demoted."""

        # Atomic conditional update: the never-demote guard must be evaluated by
        # the database, not against a possibly stale ORM snapshot — a tick that
        # loaded before another tick's confirmation could otherwise regress the
        # confirmed state at commit time.
        await self.session.execute(
            update(CapturedTraceIndexORM)
            .where(
                tenant_clause(CapturedTraceIndexORM, tenant_id),
                CapturedTraceIndexORM.trace_id == trace_id,
                CapturedTraceIndexORM.lifecycle_state != TraceLifecycleState.ARCHIVE_CONFIRMED.value,
            )
            .values(lifecycle_state=lifecycle_state, last_checked_at=checked_at)
        )
        # Confirmed rows still record the check time. A read that came back
        # empty deliberately does NOT stamp the derivation revision: "the
        # archive returned nothing this time" is not "this trace can never be
        # summarised", and recording it as a completed derivation would strand
        # the rows against every later attempt. Bumping the check time is
        # enough — the rebuild pass takes the least-recently-checked traces
        # first, so an unreadable one costs one read per queue rotation.
        await self.session.execute(
            update(CapturedTraceIndexORM)
            .where(
                tenant_clause(CapturedTraceIndexORM, tenant_id),
                CapturedTraceIndexORM.trace_id == trace_id,
                CapturedTraceIndexORM.lifecycle_state == TraceLifecycleState.ARCHIVE_CONFIRMED.value,
            )
            .values(last_checked_at=checked_at)
        )
        await self.session.commit()

    async def count_trace_index(self, tenant_id: str, project_id: str | None) -> int:
        return int(
            await self.session.scalar(
                select(func.count())
                .select_from(CapturedTraceIndexORM)
                .where(
                    tenant_clause(CapturedTraceIndexORM, tenant_id),
                    CapturedTraceIndexORM.project_id.is_(None) if project_id is None else CapturedTraceIndexORM.project_id == project_id,
                )
            )
            or 0
        )

    async def unassigned_trace_stats(self, tenant_id: str) -> tuple[int, datetime | None]:
        """Count + last activity for indexed traces without a Project home."""

        row = (
            await self.session.execute(
                select(
                    func.count(),
                    func.max(
                        func.coalesce(
                            CapturedTraceIndexORM.started_at,
                            CapturedTraceIndexORM.created_at,
                        )
                    ),
                ).where(
                    tenant_clause(CapturedTraceIndexORM, tenant_id),
                    CapturedTraceIndexORM.project_id.is_(None),
                )
            )
        ).one()
        return int(row[0] or 0), row[1]

    def _trace_index_filters(
        self,
        tenant_id: str,
        project_id: str | None,
        *,
        search: str | None,
        run_id: str | None,
        status: str | None,
        since: datetime | None,
        until: datetime | None,
        sort_key,
        include_hidden: bool = False,
    ) -> list:
        clauses: list = [
            tenant_clause(CapturedTraceIndexORM, tenant_id),
            CapturedTraceIndexORM.project_id.is_(None) if project_id is None else CapturedTraceIndexORM.project_id == project_id,
        ]
        if not include_hidden:
            clauses.append(CapturedTraceIndexORM.hidden.is_(False))
        term = (search or "").strip()
        if term:
            pattern = f"%{_escape_like(term)}%"
            clauses.append(
                or_(
                    CapturedTraceIndexORM.trace_id.ilike(pattern, escape="\\"),
                    CapturedTraceIndexORM.root_span_name.ilike(pattern, escape="\\"),
                    CapturedTraceIndexORM.model.ilike(pattern, escape="\\"),
                )
            )
        exact_run_id = (run_id or "").strip()
        if exact_run_id:
            clauses.append(
                exists(
                    select(1)
                    .select_from(EvaluationRunItemORM)
                    .join(
                        EvaluationRunORM,
                        EvaluationRunORM.run_id == EvaluationRunItemORM.run_id,
                    )
                    .join(
                        ExperimentORM,
                        ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
                    )
                    .where(
                        EvaluationRunItemORM.trace_id == CapturedTraceIndexORM.trace_id,
                        EvaluationRunItemORM.run_id == exact_run_id,
                        tenant_clause(ExperimentORM, tenant_id),
                    )
                )
            )
        if status:
            # Index-path outcome classifies by archived span errors: `error`
            # means confirmed spans reported errors; `succeeded` means the
            # trace is archive-confirmed without span errors; anything not yet
            # confirmed is honestly `unknown`.
            confirmed = CapturedTraceIndexORM.lifecycle_state == TraceLifecycleState.ARCHIVE_CONFIRMED.value
            errored = func.coalesce(CapturedTraceIndexORM.error_count, 0) > 0
            if status == "error":
                clauses.append(errored)
            elif status == "succeeded":
                clauses.append(confirmed)
                clauses.append(~errored)
            elif status == "unknown":
                clauses.append(~confirmed)
            else:
                raise ValueError(f"Unsupported invocation-outcome filter: {status!r}")
        since = _normalize_trace_window_bound(since)
        until = _normalize_trace_window_bound(until)
        if since is not None:
            clauses.append(sort_key >= since)
        if until is not None:
            clauses.append(sort_key <= until)
        return clauses

    async def _eval_trace_summaries(
        self,
        tenant_id: str,
        trace_ids: list[str],
        *,
        run_id: str | None = None,
    ) -> dict[str, dict]:
        """Representative eval-run-item projection per trace id (page-bounded)."""

        if not trace_ids:
            return {}
        sort_key = func.coalesce(
            EvaluationRunItemORM.captured_at,
            EvaluationRunORM.completed_at,
            EvaluationRunORM.started_at,
        )
        ranked_query = (
            select(
                EvaluationRunItemORM.run_id.label("run_id"),
                EvaluationRunItemORM.example_id.label("example_id"),
                func.row_number()
                .over(
                    partition_by=EvaluationRunItemORM.trace_id,
                    order_by=(
                        sort_key.desc(),
                        EvaluationRunItemORM.run_id.asc(),
                        EvaluationRunItemORM.example_id.asc(),
                    ),
                )
                .label("trace_row_number"),
            )
            .join(EvaluationRunORM, EvaluationRunORM.run_id == EvaluationRunItemORM.run_id)
            .join(
                ExperimentORM,
                ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
            )
            .where(
                EvaluationRunItemORM.trace_id.in_(trace_ids),
                tenant_clause(ExperimentORM, tenant_id),
            )
        )
        exact_run_id = (run_id or "").strip()
        if exact_run_id:
            ranked_query = ranked_query.where(
                EvaluationRunItemORM.run_id == exact_run_id
            )
        ranked = ranked_query.subquery()
        result = await self.session.execute(
            select(EvaluationRunItemORM, EvaluationRunORM, ExperimentORM)
            .join(
                ranked,
                (ranked.c.run_id == EvaluationRunItemORM.run_id) & (ranked.c.example_id == EvaluationRunItemORM.example_id),
            )
            .join(EvaluationRunORM, EvaluationRunORM.run_id == EvaluationRunItemORM.run_id)
            .join(
                ExperimentORM,
                ExperimentORM.experiment_id == EvaluationRunORM.experiment_id,
            )
            .where(ranked.c.trace_row_number == 1)
        )
        return {item.trace_id: _trace_summary(item, run, experiment) for item, run, experiment in result.all() if item.trace_id}

    async def list_trace_index_page(
        self,
        tenant_id: str,
        project_id: str | None,
        *,
        limit: int = 50,
        cursor: str | None = None,
        search: str | None = None,
        run_id: str | None = None,
        status: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        include_hidden: bool = False,
    ) -> dict:
        """Index-served trace page. ``project_id=None`` lists Unassigned rows.

        Same envelope and keyset semantics as the eval-derived projection, plus
        the honest index extensions (lifecycle_state, span/error counts, root
        span, model). ``search`` matches trace id / root span name / model.
        """

        sort_key = func.coalesce(CapturedTraceIndexORM.started_at, CapturedTraceIndexORM.created_at)
        filters = self._trace_index_filters(
            tenant_id,
            project_id,
            search=search,
            run_id=run_id,
            status=status,
            since=since,
            until=until,
            sort_key=sort_key,
            include_hidden=include_hidden,
        )
        base = select(CapturedTraceIndexORM, sort_key.label("sort_key")).where(*filters)
        decoded = _decode_trace_cursor(cursor)
        if decoded is not None:
            cursor_at, cursor_trace_id = decoded
            base = base.where(
                or_(
                    sort_key < cursor_at,
                    (sort_key == cursor_at) & (CapturedTraceIndexORM.trace_id > cursor_trace_id),
                )
            )
        result = await self.session.execute(base.order_by(sort_key.desc(), CapturedTraceIndexORM.trace_id.asc()).limit(limit + 1))
        rows = result.all()
        has_more = len(rows) > limit
        rows = rows[:limit]

        total = await self.session.scalar(select(func.count()).select_from(CapturedTraceIndexORM).where(*filters))
        hidden_filters = self._trace_index_filters(
            tenant_id,
            project_id,
            search=search,
            run_id=run_id,
            status=status,
            since=since,
            until=until,
            sort_key=sort_key,
            include_hidden=True,
        )
        hidden_count = await self.session.scalar(
            select(func.count())
            .select_from(CapturedTraceIndexORM)
            .where(
                *hidden_filters,
                CapturedTraceIndexORM.hidden.is_(True),
            )
        )
        summaries = await self._eval_trace_summaries(
            tenant_id,
            [orm.trace_id for orm, _ in rows if orm.is_evaluated],
            run_id=run_id,
        )
        items = [_index_trace_item(orm, summaries.get(orm.trace_id)) for orm, _ in rows]
        next_cursor = None
        if has_more and rows:
            last_orm, last_sort = rows[-1]
            next_cursor = _encode_trace_cursor(last_sort, last_orm.trace_id)
        return {
            "items": items,
            "next_cursor": next_cursor,
            "has_more": has_more,
            "total": int(total or 0),
            "hidden_count": int(hidden_count or 0),
            "source": "index",
        }

    async def set_trace_hidden(
        self,
        tenant_id: str,
        project_id: str | None,
        trace_id: str,
        *,
        hidden: bool,
    ) -> bool:
        result = await self.session.execute(
            update(CapturedTraceIndexORM)
            .where(
                tenant_clause(CapturedTraceIndexORM, tenant_id),
                CapturedTraceIndexORM.trace_id == trace_id,
                CapturedTraceIndexORM.project_id.is_(None) if project_id is None else CapturedTraceIndexORM.project_id == project_id,
            )
            .values(hidden=hidden)
        )
        await self.session.commit()
        return bool(result.rowcount)

    async def list_span_index_page(
        self,
        tenant_id: str,
        project_id: str | None,
        *,
        limit: int = 50,
        cursor: str | None = None,
        search: str | None = None,
        status: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> dict:
        """Project-wide span summaries from the span index, keyset-paged.

        One row per archived span, carrying bounded previews rather than
        payloads. ``project_id=None`` lists spans of Unassigned traces.
        ``status`` filters the archived OTLP status (``ok`` / ``error``);
        ``search`` matches span name or trace id.

        Only spans with a derived semantic kind are listed — transport and
        framework plumbing outnumber real work by roughly a hundred to one and
        are never what a reviewer came for. This is deliberately unconditional:
        the filter applies to the count as well as the page, so the total stays
        honest under pagination rather than shrinking a page at a time.
        """

        sort_key = func.coalesce(CapturedSpanIndexORM.started_at, CapturedSpanIndexORM.created_at)
        # ponytail: no partial index — the table is small. If it grows, add
        # postgresql_where="semantic_kind IS NOT NULL" to the keyset index.
        clauses: list = [
            tenant_clause(CapturedSpanIndexORM, tenant_id),
            CapturedSpanIndexORM.semantic_kind.is_not(None),
            CapturedSpanIndexORM.project_id.is_(None) if project_id is None else CapturedSpanIndexORM.project_id == project_id,
        ]
        term = (search or "").strip()
        if term:
            pattern = f"%{_escape_like(term)}%"
            clauses.append(
                or_(
                    CapturedSpanIndexORM.name.ilike(pattern, escape="\\"),
                    CapturedSpanIndexORM.trace_id.ilike(pattern, escape="\\"),
                )
            )
        if status:
            if status not in {"ok", "error", "unset"}:
                raise ValueError(f"Unsupported span status filter: {status!r}")
            clauses.append(CapturedSpanIndexORM.status == status)
        since = _normalize_trace_window_bound(since)
        until = _normalize_trace_window_bound(until)
        if since is not None:
            clauses.append(sort_key >= since)
        if until is not None:
            clauses.append(sort_key <= until)

        base = select(CapturedSpanIndexORM, sort_key.label("sort_key")).where(*clauses)
        decoded = _decode_span_cursor(cursor)
        if decoded is not None:
            cursor_at, cursor_trace_id, cursor_span_id = decoded
            base = base.where(
                or_(
                    sort_key < cursor_at,
                    (sort_key == cursor_at)
                    & or_(
                        CapturedSpanIndexORM.trace_id > cursor_trace_id,
                        (CapturedSpanIndexORM.trace_id == cursor_trace_id) & (CapturedSpanIndexORM.span_id > cursor_span_id),
                    ),
                )
            )
        result = await self.session.execute(
            base.order_by(
                sort_key.desc(),
                CapturedSpanIndexORM.trace_id.asc(),
                CapturedSpanIndexORM.span_id.asc(),
            ).limit(limit + 1)
        )
        rows = result.all()
        has_more = len(rows) > limit
        rows = rows[:limit]
        total = await self.session.scalar(select(func.count()).select_from(CapturedSpanIndexORM).where(*clauses))
        summaries = await self._eval_trace_summaries(
            tenant_id,
            list({orm.trace_id for orm, _ in rows}),
        )
        items = [
            {
                "project_id": orm.project_id,
                "trace_id": orm.trace_id,
                "run_id": summaries.get(orm.trace_id, {}).get("run_id"),
                "run_name": summaries.get(orm.trace_id, {}).get("run_name"),
                "run_number": summaries.get(orm.trace_id, {}).get("run_number"),
                "evaluation_name": summaries.get(orm.trace_id, {}).get("evaluation_name"),
                "span_id": orm.span_id,
                "parent_span_id": orm.parent_span_id,
                "name": orm.name,
                "kind": orm.kind,
                "semantic_kind": orm.semantic_kind,
                "input_preview": orm.input_preview,
                "output_preview": orm.output_preview,
                "llm_token_count_prompt": orm.llm_token_count_prompt,
                "llm_token_count_completion": orm.llm_token_count_completion,
                "estimated_cost_usd": orm.estimated_cost_usd,
                "started_at": orm.started_at,
                "duration_ms": orm.duration_ms,
                "status": orm.status,
            }
            for orm, _ in rows
        ]
        next_cursor = None
        if has_more and rows:
            last_orm, last_sort = rows[-1]
            next_cursor = _encode_span_cursor(last_sort, last_orm.trace_id, last_orm.span_id)
        return {
            "items": items,
            "next_cursor": next_cursor,
            "has_more": has_more,
            "total": int(total or 0),
        }

    async def set_project_status(self, project_id: str, tenant_id: str, status: ProjectStatus) -> EvaluationProject | None:
        orm = await self.session.get(EvaluationProjectORM, project_id)
        if not orm or not tenants_match(orm.tenant_id, tenant_id):
            return None
        orm.status = status.value
        await self.session.commit()
        return _project_from_orm(orm)

    async def delete_project(self, project_id: str, tenant_id: str) -> int | None:
        """Permanently delete an archived Project and its captured trace index.

        Returns the number of indexed traces removed, or ``None`` when the
        Project does not exist in this tenant. Raises ``ValueError`` when the
        Project is not archived, or is still referenced by something that would
        be left pointing at a Project that no longer exists.

        Span payloads are deliberately NOT removed from the archive. Archive
        objects are keyed ``tenant/environment/date/hour``
        (``TraceArchiveReader._hour_prefixes``) with no Project dimension, so
        each object is an hourly batch shared by every Project in the tenant —
        deleting one would take other Projects' evidence with it. Removing the
        index rows is what takes these traces out of the product: listings read
        the index, and the archive is only ever read for a trace id the index
        already knows. The raw payloads age out under the archive's own
        retention, which is the only mechanism that owns them.
        """

        orm = await self.session.get(EvaluationProjectORM, project_id)
        if not orm or not tenants_match(orm.tenant_id, tenant_id):
            return None
        if orm.status != ProjectStatus.ARCHIVED.value:
            raise ValueError("Only an archived Project can be deleted. Archive it first.")

        # Two of these are enforced by foreign keys and would fail the delete
        # anyway; the rest carry the Project id without one and would silently
        # become dangling labels. Refuse while any of them hold it, and name
        # what does, so the operator can act rather than guess.
        holders: list[str] = []
        for noun, model, column in (
            ("target version", TargetVersionORM, TargetVersionORM.project_id),
            (
                "target project binding",
                TargetProjectBindingORM,
                TargetProjectBindingORM.system_project_id,
            ),
            ("experiment", ExperimentORM, ExperimentORM.project_id),
            ("run manifest", RunManifestORM, RunManifestORM.project_id),
            (
                "quality profile version",
                QualityProfileVersionORM,
                QualityProfileVersionORM.project_id,
            ),
        ):
            count = (await self.session.execute(select(func.count()).select_from(model).where(column == project_id))).scalar_one()
            if count:
                holders.append(f"{count} {noun}{'' if count == 1 else 's'}")
        if holders:
            raise ValueError("Project is still referenced by " + ", ".join(holders) + ". Remove or reassign them before deleting the Project.")

        traces = (
            await self.session.execute(
                select(func.count())
                .select_from(CapturedTraceIndexORM)
                .where(
                    tenant_clause(CapturedTraceIndexORM, tenant_id),
                    CapturedTraceIndexORM.project_id == project_id,
                )
            )
        ).scalar_one()
        await self.session.execute(
            delete(CapturedSpanIndexORM).where(
                tenant_clause(CapturedSpanIndexORM, tenant_id),
                CapturedSpanIndexORM.project_id == project_id,
            )
        )
        await self.session.execute(
            delete(CapturedTraceIndexORM).where(
                tenant_clause(CapturedTraceIndexORM, tenant_id),
                CapturedTraceIndexORM.project_id == project_id,
            )
        )
        await self.session.delete(orm)
        await self.session.commit()
        return traces

    async def save_target_version(self, target: TargetVersion) -> TargetVersion:
        project = await self.get_project(target.project_id, target.tenant_id)
        if not project:
            raise ValueError("Target version project was not found in the requested tenant")
        existing = await self.session.get(TargetVersionORM, target.target_version_id)
        if existing:
            raise ValueError(f"Target version {target.target_version_id} already exists")
        orm = TargetVersionORM(
            target_version_id=target.target_version_id,
            target_id=target.target_id,
            project_id=target.project_id,
            tenant_id=target.tenant_id,
            name=target.name,
            version=target.version,
            endpoint=target.endpoint,
            target_type=target.target_type.value,
            environment=target.environment,
            model_version=target.model_version,
            prompt_version=target.prompt_version,
            tool_versions=target.tool_versions,
            configuration=target.configuration,
            created_by=target.created_by,
            created_at=target.created_at,
        )
        self.session.add(orm)
        await self.session.commit()
        return _target_from_orm(orm)

    async def get_target_version(self, target_version_id: str, tenant_id: str | None = None) -> TargetVersion | None:
        orm = await self.session.get(TargetVersionORM, target_version_id)
        if not orm or (tenant_id and not tenants_match(orm.tenant_id, tenant_id)):
            return None
        return _target_from_orm(orm)

    async def create_target_project_binding(self, binding: TargetProjectBinding) -> TargetProjectBinding:
        """Bind a logical target (+ environment) to a tenant *system* Project.

        Enforces one binding per ``(tenant, target, environment)`` and requires
        the referenced Project to exist in the same tenant with ``purpose=system``
        (a ``catalog_registry`` Project is a version registry, not a system home).
        Never touches immutable ``TargetVersion`` rows.
        """

        project = await self.get_project(binding.system_project_id, binding.tenant_id)
        if not project:
            raise ValueError("System project was not found in the requested tenant")
        if project.purpose != ProjectPurpose.SYSTEM:
            raise ValueError("Target project binding requires a system Project")

        existing = await self.get_target_project_binding(
            tenant_id=binding.tenant_id,
            target_id=binding.target_id,
            environment=binding.environment,
        )
        if existing:
            raise ValueError("A binding already exists for this tenant, target and environment")

        orm = TargetProjectBindingORM(
            binding_id=binding.binding_id,
            tenant_id=binding.tenant_id,
            target_id=binding.target_id,
            environment=binding.environment,
            system_project_id=binding.system_project_id,
            created_by=binding.created_by,
            created_at=binding.created_at,
        )
        self.session.add(orm)
        try:
            await self.session.commit()
        except IntegrityError as exc:
            # A concurrent writer won the UNIQUE(tenant, target, environment) race.
            await self.session.rollback()
            raise ValueError("A binding already exists for this tenant, target and environment") from exc
        return _target_project_binding_from_orm(orm)

    async def get_target_project_binding(self, *, tenant_id: str, target_id: str, environment: str) -> TargetProjectBinding | None:
        result = await self.session.execute(
            select(TargetProjectBindingORM).where(
                tenant_clause(TargetProjectBindingORM, tenant_id),
                TargetProjectBindingORM.target_id == target_id,
                TargetProjectBindingORM.environment == environment,
            )
        )
        orm = result.scalar_one_or_none()
        return _target_project_binding_from_orm(orm) if orm else None

    async def resolve_target_system_project(self, *, tenant_id: str, target_id: str, environment: str) -> EvaluationProject | None:
        """Resolve the bound *system* Project for a logical target/environment.

        Returns ``None`` when no binding exists — the caller must require an
        explicit choice rather than fabricate a system Project. Never returns the
        ``catalog_registry`` Project the immutable ``TargetVersion`` points at.
        """

        binding = await self.get_target_project_binding(tenant_id=tenant_id, target_id=target_id, environment=environment)
        if not binding:
            return None
        project = await self.get_project(binding.system_project_id, tenant_id)
        if project is None or project.purpose != ProjectPurpose.SYSTEM or project.status != ProjectStatus.ACTIVE:
            # Stale binding — the project was deleted or reclassified away from
            # system, or it was archived. Never resolve to a catalog_registry or
            # inactive project.
            return None
        return project

    async def target_system_projects(self, tenant_id: str, targets: list[tuple[str, str]]) -> dict[tuple[str, str], str]:
        """Resolve a catalog's target/environment bindings in one query."""
        if not targets:
            return {}
        result = await self.session.execute(
            select(TargetProjectBindingORM.target_id, TargetProjectBindingORM.environment, EvaluationProjectORM.project_id)
            .join(EvaluationProjectORM, EvaluationProjectORM.project_id == TargetProjectBindingORM.system_project_id)
            .where(
                tenant_clause(TargetProjectBindingORM, tenant_id),
                TargetProjectBindingORM.target_id.in_({target_id for target_id, _ in targets}),
                tenant_clause(EvaluationProjectORM, tenant_id),
                EvaluationProjectORM.purpose == ProjectPurpose.SYSTEM.value,
                EvaluationProjectORM.status == ProjectStatus.ACTIVE.value,
            )
        )
        wanted = set(targets)
        return {(target_id, environment): project_id for target_id, environment, project_id in result if (target_id, environment) in wanted}

    async def list_target_versions(self, project_id: str, tenant_id: str) -> list[TargetVersion]:
        result = await self.session.execute(
            select(TargetVersionORM)
            .where(
                TargetVersionORM.project_id == project_id,
                tenant_clause(TargetVersionORM, tenant_id),
            )
            .order_by(TargetVersionORM.created_at.desc())
        )
        return [_target_from_orm(orm) for orm in result.scalars().all()]

    async def list_agent_targets(self, tenant_id: str) -> list[TargetVersion]:
        """List tenant-scoped agent targets for the Eval Hub Agent Catalog."""

        result = await self.session.execute(
            select(TargetVersionORM)
            .where(
                tenant_clause(TargetVersionORM, tenant_id),
                TargetVersionORM.target_type == TargetType.AGENT.value,
            )
            .order_by(TargetVersionORM.created_at.desc())
        )
        return [_target_from_orm(orm) for orm in result.scalars().all()]

    async def list_llm_targets(self, tenant_id: str) -> list[TargetVersion]:
        """List tenant-scoped custom LLM targets for the Eval Hub LLM Catalog."""

        result = await self.session.execute(
            select(TargetVersionORM)
            .where(
                tenant_clause(TargetVersionORM, tenant_id),
                TargetVersionORM.target_type == TargetType.ENDPOINT.value,
            )
            .order_by(TargetVersionORM.created_at.desc())
        )
        targets = [_target_from_orm(orm) for orm in result.scalars().all()]
        return [target for target in targets if (target.configuration or {}).get("catalog_source") == "custom_llm"]

    async def save_prompt_version(
        self,
        *,
        tenant_id: str,
        prompt_id: str,
        name: str,
        content: str,
        description: str | None = None,
        created_by: str = "user",
    ) -> PromptVersion:
        """Save the next version of a prompt, allocating the number here.

        Read-max-then-insert: concurrent saves of the same prompt can pick the
        same number, and the tenant-qualified primary key is what catches it.
        Each retry re-reads the maximum, so N contenders serialise into N
        versions rather than one of them losing its request.
        """

        for _ in range(_PROMPT_SAVE_ATTEMPTS):
            highest = await self.session.scalar(
                select(func.max(PromptVersionORM.version)).where(
                    tenant_clause(PromptVersionORM, tenant_id),
                    PromptVersionORM.prompt_id == prompt_id,
                )
            )
            version = int(highest or 0) + 1
            orm = PromptVersionORM(
                prompt_version_id=prompt_version_key(prompt_id, version, tenant_id),
                prompt_id=prompt_id,
                version=version,
                tenant_id=tenant_id,
                name=name,
                description=description,
                content=content,
                content_hash=hash_system_prompt(content) or "",
                created_by=created_by,
            )
            self.session.add(orm)
            try:
                await self.session.commit()
            except IntegrityError:
                await self.session.rollback()
                continue
            return _prompt_from_orm(orm, labels=[])
        raise ValueError(f"Could not allocate a version for prompt {prompt_id}")

    async def list_prompt_ids(self, tenant_id: str, *, prompt_id: str | None = None, include_archived: bool = False) -> list[str]:
        """Distinct prompt ids, ordered — the unit an index pages over.

        A catalog page holds prompts, not versions. Paging the flat version list
        splits a prompt across two pages, and each page then reports a partial
        version count and the wrong production version for it.
        """

        clauses = [tenant_clause(PromptVersionORM, tenant_id)]
        if prompt_id:
            clauses.append(PromptVersionORM.prompt_id == prompt_id)
        if not include_archived:
            clauses.append(PromptVersionORM.archived_at.is_(None))
        result = await self.session.execute(
            select(PromptVersionORM.prompt_id)
            .where(*clauses)
            .distinct()
            .order_by(PromptVersionORM.prompt_id.asc())
        )
        return list(result.scalars().all())

    async def list_prompt_versions(self, tenant_id: str, *, prompt_id: str | None = None, prompt_ids: list[str] | None = None, include_archived: bool = False) -> list[PromptVersion]:
        clauses = [tenant_clause(PromptVersionORM, tenant_id)]
        if prompt_id:
            clauses.append(PromptVersionORM.prompt_id == prompt_id)
        if prompt_ids is not None:
            clauses.append(PromptVersionORM.prompt_id.in_(prompt_ids))
        if not include_archived:
            clauses.append(PromptVersionORM.archived_at.is_(None))
        result = await self.session.execute(select(PromptVersionORM).where(*clauses).order_by(PromptVersionORM.prompt_id.asc(), PromptVersionORM.version.desc()))
        rows = list(result.scalars().all())
        labels = await self._prompt_labels_by_version(tenant_id)
        return [_prompt_from_orm(orm, labels=labels.get(orm.prompt_version_id, [])) for orm in rows]

    async def _prompt_labels_by_version(self, tenant_id: str) -> dict[str, list[str]]:
        result = await self.session.execute(select(PromptLabelORM).where(tenant_clause(PromptLabelORM, tenant_id)))
        by_version: dict[str, list[str]] = {}
        for row in result.scalars().all():
            by_version.setdefault(row.prompt_version_id, []).append(row.label)
        return by_version

    async def resolve_prompt_ref(self, reference: str, *, tenant_id: str) -> PromptVersion | None:
        """Resolve `prompt-id@version` or `prompt-id@label` to one version.

        A label is resolved here, at enqueue, and the caller records the
        concrete version: a run that only remembered `@production` would become
        unreadable the moment the label moved.
        """

        prompt_id, selector = parse_prompt_ref(reference)
        if selector == "latest":
            result = await self.session.execute(
                select(PromptVersionORM)
                .where(
                    tenant_clause(PromptVersionORM, tenant_id),
                    PromptVersionORM.prompt_id == prompt_id,
                    # `latest` means the newest *usable* version; an archived one
                    # is still reachable by its number, which is what reruns use.
                    PromptVersionORM.archived_at.is_(None),
                )
                .order_by(PromptVersionORM.version.desc())
                .limit(1)
            )
            orm = result.scalar_one_or_none()
        elif selector.isdigit():
            orm = await self.session.get(PromptVersionORM, prompt_version_key(prompt_id, int(selector), tenant_id))
        else:
            label = await self.session.execute(
                select(PromptLabelORM).where(
                    tenant_clause(PromptLabelORM, tenant_id),
                    PromptLabelORM.prompt_id == prompt_id,
                    PromptLabelORM.label == selector,
                )
            )
            pointer = label.scalar_one_or_none()
            orm = await self.session.get(PromptVersionORM, pointer.prompt_version_id) if pointer else None
        if not orm or not tenants_match(orm.tenant_id, tenant_id):
            return None
        labels = await self._prompt_labels_by_version(tenant_id)
        return _prompt_from_orm(orm, labels=labels.get(orm.prompt_version_id, []))

    async def create_case_replay(
        self,
        *,
        replay_id: str,
        tenant_id: str,
        run_id: str,
        example_id: str,
        prompt_version_ref: str | None,
        prompt_hash: str | None,
        system_prompt: str | None,
        target_model: str,
        target_endpoint: str | None,
        response: str | None,
        latency_ms: int | None,
        target_usage: dict | None,
        invocation_error: str | None,
        invocation_id: str | None,
        trace_id: str | None,
        span_id: str | None,
        created_by: str,
    ) -> CaseReplay:
        """Persist one case replay as isolated evidence (#3317).

        Response and prompt text pass through the same persistence redaction
        as run-item evidence; the original run's rows are never touched.
        """
        orm = CaseReplayORM(
            replay_id=replay_id,
            tenant_id=tenant_id,
            run_id=run_id,
            example_id=example_id,
            prompt_version_ref=prompt_version_ref,
            prompt_hash=prompt_hash,
            system_prompt=redact_for_persistence(system_prompt),
            target_model=target_model,
            target_endpoint=target_endpoint,
            response=redact_for_persistence(response),
            latency_ms=latency_ms,
            target_usage=redact_for_persistence(target_usage),
            invocation_error=redact_for_persistence(invocation_error),
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            created_by=created_by,
        )
        self.session.add(orm)
        await self.session.commit()
        await self.session.refresh(orm)
        return _case_replay_from_orm(orm)

    async def list_case_replays(self, run_id: str, example_id: str, *, tenant_id: str) -> list[CaseReplay]:
        result = await self.session.execute(
            select(CaseReplayORM)
            .where(
                tenant_clause(CaseReplayORM, tenant_id),
                CaseReplayORM.run_id == run_id,
                CaseReplayORM.example_id == example_id,
            )
            .order_by(CaseReplayORM.created_at.desc(), CaseReplayORM.replay_id.desc())
        )
        return [_case_replay_from_orm(orm) for orm in result.scalars().all()]

    async def archive_prompt_version(self, *, tenant_id: str, prompt_id: str, version: int) -> PromptVersion | None:
        """Retire a version from the pickers, keeping the row resolvable.

        Deliberately not a delete: a run records `prompt-id@version` and an exact
        rerun replays it, so removing the row would turn a run's own provenance
        into a dangling reference. Any labels pointing here are dropped — a
        retired version must not still be somebody's `production`.

        Idempotent: archiving an already-archived version keeps the first
        timestamp, so a double-click cannot rewrite when it was retired.
        """

        target = await self.session.get(PromptVersionORM, prompt_version_key(prompt_id, version, tenant_id))
        if not target or not tenants_match(target.tenant_id, tenant_id):
            return None
        if target.archived_at is None:
            target.archived_at = datetime.now(UTC)
        await self.session.execute(
            delete(PromptLabelORM).where(
                tenant_clause(PromptLabelORM, tenant_id),
                PromptLabelORM.prompt_version_id == target.prompt_version_id,
            )
        )
        await self.session.commit()
        # Reloaded explicitly: the commit expires the instance, and building the
        # response from an expired attribute triggers lazy IO outside the async
        # context. Archiving an already-archived version writes nothing, so
        # nothing would refresh it on the way out.
        await self.session.refresh(target)
        return _prompt_from_orm(target, labels=[])

    async def move_prompt_label(self, *, tenant_id: str, prompt_id: str, label: str, version: int) -> PromptVersion | None:
        """Point a label at a version, creating it if this is its first use."""

        if label in AUTOMATIC_LABELS:
            raise ValueError(f"{label} is resolved automatically and cannot be assigned")
        if label.isdigit():
            # A reference resolves digits as a version number, so a digit label
            # could be created and then never reached.
            raise ValueError("labels must not be digits only")
        target = await self.session.get(PromptVersionORM, prompt_version_key(prompt_id, version, tenant_id))
        if not target or not tenants_match(target.tenant_id, tenant_id):
            return None
        if target.archived_at is not None:
            raise ValueError("an archived version cannot carry a label")
        existing = await self.session.execute(
            select(PromptLabelORM).where(
                tenant_clause(PromptLabelORM, tenant_id),
                PromptLabelORM.prompt_id == prompt_id,
                PromptLabelORM.label == label,
            )
        )
        pointer = existing.scalar_one_or_none()
        if pointer:
            pointer.prompt_version_id = target.prompt_version_id
            pointer.updated_at = datetime.now(UTC)
        else:
            self.session.add(
                PromptLabelORM(
                    tenant_id=tenant_id,
                    prompt_id=prompt_id,
                    label=label,
                    prompt_version_id=target.prompt_version_id,
                )
            )
        await self.session.commit()
        labels = await self._prompt_labels_by_version(tenant_id)
        return _prompt_from_orm(target, labels=labels.get(target.prompt_version_id, []))

    async def save_quality_profile(self, profile: QualityProfileVersion) -> QualityProfileVersion:
        if profile.status != VersionLifecycle.DRAFT:
            raise ValueError("new quality profile versions must be created as draft")
        # Test evidence is earned by the dry-run/override operation, never imported
        # from a create request (including a copied profile version).
        profile = profile.model_copy(update={
            "test_status": ProfileTestStatus.NOT_TESTED, "tested_at": None,
            "tested_by": None, "test_note": None, "test_run_id": None,
        })
        profile.evidence_requirements = canonicalize_capture_requirements(profile.evidence_requirements)
        profile.approver_roles = validate_governance_roles(profile.approver_roles)
        key = profile_version_key(profile.profile_id, profile.version, profile.tenant_id)
        existing = await self.session.get(QualityProfileVersionORM, key)
        if existing:
            raise ValueError(f"Quality profile version {key} already exists")
        if profile.project_id and not await self.get_project(profile.project_id, profile.tenant_id):
            raise ValueError("Quality profile project was not found in the requested tenant")
        payload = profile.model_dump(
            mode="json",
            exclude={
                "profile_id",
                "version",
                "tenant_id",
                "name",
                "description",
                "project_id",
                "status",
                "scenario",
                "created_by",
                "created_at",
            },
        )
        orm = QualityProfileVersionORM(
            profile_version_id=key,
            profile_id=profile.profile_id,
            version=profile.version,
            tenant_id=profile.tenant_id,
            project_id=profile.project_id,
            name=profile.name,
            description=profile.description,
            status=profile.status.value,
            scenario=profile.scenario.value if profile.scenario else None,
            contract_json=payload,
            created_by=profile.created_by,
            created_at=profile.created_at,
        )
        self.session.add(orm)
        await self.session.commit()
        return _profile_from_orm(orm)

    async def get_quality_profile(self, profile_id: str, version: str, tenant_id: str | None = None) -> QualityProfileVersion | None:
        orm = await self._quality_profile_orm(profile_id, version, tenant_id)
        if not orm or (tenant_id and not tenants_match(orm.tenant_id, tenant_id)):
            return None
        return _profile_from_orm(orm)

    async def _quality_profile_orm(
        self, profile_id: str, version: str, tenant_id: str | None
    ) -> QualityProfileVersionORM | None:
        if tenant_id:
            orm = await self.session.get(
                QualityProfileVersionORM,
                profile_version_key(profile_id, version, tenant_id),
            )
            if orm:
                return orm
        return await self.session.get(
            QualityProfileVersionORM,
            legacy_profile_version_key(profile_id, version),
        )

    async def list_quality_profiles(self, tenant_id: str, project_id: str | None = None) -> list[QualityProfileVersion]:
        statement = select(QualityProfileVersionORM).where(tenant_clause(QualityProfileVersionORM, tenant_id))
        if project_id:
            statement = statement.where((QualityProfileVersionORM.project_id == project_id) | (QualityProfileVersionORM.project_id.is_(None)))
        result = await self.session.execute(statement.order_by(QualityProfileVersionORM.created_at.desc()))
        return [_profile_from_orm(orm) for orm in result.scalars().all()]

    async def transition_quality_profile(self, profile_id: str, version: str, tenant_id: str, target: VersionLifecycle, *, commit: bool = True) -> QualityProfileVersion | None:
        orm = await self._quality_profile_orm(profile_id, version, tenant_id)
        if not orm or not tenants_match(orm.tenant_id, tenant_id):
            return None
        _validate_lifecycle_transition(VersionLifecycle(orm.status), target)
        if VersionLifecycle(orm.status) == VersionLifecycle.RETIRED and target == VersionLifecycle.DRAFT:
            # Evidence of testing ages with the data it was gathered against. A
            # profile coming back from retirement re-tests before it can be
            # approved again.
            contract = dict(orm.contract_json or {})
            contract["test_status"] = ProfileTestStatus.NOT_TESTED.value
            contract["tested_at"] = None
            contract["tested_by"] = None
            contract["test_note"] = None
            # Including the dataset the test ran against: leaving it behind gives a
            # profile that reads "Not tested" while still naming the data of a test
            # it no longer claims.
            contract["test_dataset_name"] = None
            contract["test_run_id"] = None
            orm.contract_json = contract
        if target == VersionLifecycle.APPROVED:
            status = str((orm.contract_json or {}).get("test_status") or ProfileTestStatus.NOT_TESTED.value)
            if status not in {ProfileTestStatus.TESTED.value, ProfileTestStatus.OVERRIDDEN.value}:
                raise ValueError(
                    "quality profile remains Not tested; dry-run or record an override before approval"
                )
        orm.status = target.value
        if commit:
            await self.session.commit()
        else:
            await self.session.flush()
        return _profile_from_orm(orm)


    async def mark_quality_profile_tested(
        self,
        profile_id: str,
        version: str,
        tenant_id: str,
        *,
        commit: bool = True,
        mode: ProfileTestStatus,
        actor: str,
        note: str | None = None,
        dataset_name: str | None = None,
        test_run_id: str | None = None,
    ) -> QualityProfileVersion | None:
        """Record that a draft Quality Profile was dry-run tested or overridden.

        Only draft profiles can change test status. Override requires a note so
        the catalogue can show why approval was allowed without a dry-run.
        """
        orm = await self._quality_profile_orm(profile_id, version, tenant_id)
        if not orm or not tenants_match(orm.tenant_id, tenant_id):
            return None
        if orm.status not in {VersionLifecycle.DRAFT.value, VersionLifecycle.VALIDATED.value}:
            raise ValueError("only draft or validated quality profiles can update test status")
        if mode == ProfileTestStatus.OVERRIDDEN and not (note or "").strip():
            raise ValueError("override requires a note")
        payload = dict(orm.contract_json or {})
        now = datetime.now(UTC)
        payload["test_status"] = mode.value
        # The run whose stored evidence was scored against this Profile. Named
        # rather than described, so the claim can be opened and checked.
        payload["test_run_id"] = test_run_id
        payload["tested_at"] = now.isoformat()
        payload["tested_by"] = actor
        if note:
            payload["test_note"] = note.strip()
        if dataset_name:
            payload["test_dataset_name"] = dataset_name.strip()
        orm.contract_json = payload
        if commit:
            await self.session.commit()
        else:
            await self.session.flush()
        return _profile_from_orm(orm)


    async def save_gate_policy(self, policy: ReleaseGatePolicyVersion) -> ReleaseGatePolicyVersion:
        if policy.status != VersionLifecycle.DRAFT:
            raise ValueError("new gate policy versions must be created as draft")
        policy.required_evidence = canonicalize_capture_requirements(policy.required_evidence)
        policy.required_approver_roles = validate_governance_roles(policy.required_approver_roles)
        key = gate_policy_version_key(policy.gate_policy_id, policy.version, policy.tenant_id)
        existing = await self.session.get(ReleaseGatePolicyVersionORM, key)
        if existing:
            raise ValueError(f"Release gate policy version {key} already exists")
        payload = policy.model_dump(
            mode="json",
            exclude={
                "gate_policy_id",
                "version",
                "tenant_id",
                "name",
                "description",
                "status",
                "created_by",
                "created_at",
            },
        )
        orm = ReleaseGatePolicyVersionORM(
            gate_policy_version_id=key,
            gate_policy_id=policy.gate_policy_id,
            version=policy.version,
            tenant_id=policy.tenant_id,
            name=policy.name,
            description=policy.description,
            status=policy.status.value,
            policy_json=payload,
            created_by=policy.created_by,
            created_at=policy.created_at,
        )
        self.session.add(orm)
        await self.session.commit()
        return _gate_policy_from_orm(orm)

    async def get_gate_policy(self, gate_policy_id: str, version: str, tenant_id: str | None = None) -> ReleaseGatePolicyVersion | None:
        orm = await self._gate_policy_orm(gate_policy_id, version, tenant_id)
        if not orm or (tenant_id and not tenants_match(orm.tenant_id, tenant_id)):
            return None
        return _gate_policy_from_orm(orm)

    async def _gate_policy_orm(
        self, gate_policy_id: str, version: str, tenant_id: str | None
    ) -> ReleaseGatePolicyVersionORM | None:
        if tenant_id:
            orm = await self.session.get(
                ReleaseGatePolicyVersionORM,
                gate_policy_version_key(gate_policy_id, version, tenant_id),
            )
            if orm:
                return orm
        return await self.session.get(
            ReleaseGatePolicyVersionORM,
            legacy_gate_policy_version_key(gate_policy_id, version),
        )

    async def list_gate_policies(self, tenant_id: str) -> list[ReleaseGatePolicyVersion]:
        result = await self.session.execute(select(ReleaseGatePolicyVersionORM).where(tenant_clause(ReleaseGatePolicyVersionORM, tenant_id)).order_by(ReleaseGatePolicyVersionORM.created_at.desc()))
        return [_gate_policy_from_orm(orm) for orm in result.scalars().all()]

    async def transition_gate_policy(
        self,
        gate_policy_id: str,
        version: str,
        tenant_id: str,
        target: VersionLifecycle,
        *,
        commit: bool = True,
    ) -> ReleaseGatePolicyVersion | None:
        orm = await self._gate_policy_orm(gate_policy_id, version, tenant_id)
        if not orm or not tenants_match(orm.tenant_id, tenant_id):
            return None
        _validate_lifecycle_transition(VersionLifecycle(orm.status), target)
        orm.status = target.value
        if commit:
            await self.session.commit()
        else:
            await self.session.flush()
        return _gate_policy_from_orm(orm)

    async def save_evaluator_definition(self, definition: EvaluatorDefinition) -> EvaluatorDefinition:
        key = evaluator_version_key(definition.evaluator_id, definition.version, definition.tenant_id)
        if await self.session.get(EvaluatorDefinitionORM, key):
            raise ValueError(f"Evaluator definition {definition.evaluator_id}@{definition.version} already exists")
        if not definition.trusted and definition.execution_mode.value != "isolated":
            raise ValueError("Untrusted evaluators must declare isolated execution mode")
        self.session.add(
            EvaluatorDefinitionORM(
                evaluator_version_id=key,
                evaluator_id=definition.evaluator_id,
                version=definition.version,
                tenant_id=definition.tenant_id,
                name=definition.name,
                description=definition.description,
                status=definition.status.value,
                execution_mode=definition.execution_mode.value,
                adapter=definition.adapter.value,
                implementation=definition.implementation,
                definition_json=definition.model_dump(
                    mode="json",
                    exclude={
                        "evaluator_id",
                        "version",
                        "tenant_id",
                        "name",
                        "description",
                        "status",
                        "execution_mode",
                        "adapter",
                        "implementation",
                        "trusted",
                        "created_by",
                        "created_at",
                    },
                ),
                trusted=definition.trusted,
                created_by=definition.created_by,
                created_at=definition.created_at,
            )
        )
        await self.session.commit()
        return definition

    async def get_evaluator_definition(self, evaluator_id: str, version: str, tenant_id: str | None = None) -> EvaluatorDefinition | None:
        if tenant_id:
            tenant = await self.session.get(
                EvaluatorDefinitionORM,
                evaluator_version_key(evaluator_id, version, tenant_id),
            )
            if tenant:
                return _evaluator_from_orm(tenant)
        platform = await self.session.get(EvaluatorDefinitionORM, evaluator_version_key(evaluator_id, version))
        return _evaluator_from_orm(platform) if platform else None

    async def list_evaluator_definitions(self, tenant_id: str | None = None) -> list[EvaluatorDefinition]:
        statement = select(EvaluatorDefinitionORM)
        if tenant_id:
            statement = statement.where((tenant_clause(EvaluatorDefinitionORM, tenant_id)) | (EvaluatorDefinitionORM.tenant_id.is_(None)))
        result = await self.session.execute(statement.order_by(EvaluatorDefinitionORM.evaluator_id, EvaluatorDefinitionORM.version))
        return [_evaluator_from_orm(orm) for orm in result.scalars().all()]

    async def transition_evaluator_definition(
        self,
        evaluator_id: str,
        version: str,
        tenant_id: str | None,
        status: EvaluatorStatus,
        *,
        commit: bool = True,
    ) -> EvaluatorDefinition | None:
        orm = await self.session.get(
            EvaluatorDefinitionORM,
            evaluator_version_key(evaluator_id, version, tenant_id),
        )
        if not orm:
            return None
        _validate_evaluator_transition(EvaluatorStatus(orm.status), status)
        orm.status = status.value
        if commit:
            await self.session.commit()
        else:
            await self.session.flush()
        return _evaluator_from_orm(orm)

    async def save_metric_pack(self, pack: MetricPackVersion) -> MetricPackVersion:
        key = metric_pack_version_key(pack.metric_pack_id, pack.version, pack.tenant_id)
        if await self.session.get(MetricPackVersionORM, key):
            raise ValueError(f"Metric pack {pack.metric_pack_id}@{pack.version} already exists")
        for reference in pack.evaluator_refs:
            evaluator_id, version = parse_evaluator_ref(reference)
            if not await self.get_evaluator_definition(evaluator_id, version, pack.tenant_id):
                raise ValueError(f"Metric pack references unknown evaluator {reference}")
        self.session.add(
            MetricPackVersionORM(
                metric_pack_version_id=key,
                metric_pack_id=pack.metric_pack_id,
                version=pack.version,
                tenant_id=pack.tenant_id,
                name=pack.name,
                description=pack.description,
                status=pack.status.value,
                pack_json=pack.model_dump(
                    mode="json",
                    exclude={
                        "metric_pack_id",
                        "version",
                        "tenant_id",
                        "name",
                        "description",
                        "status",
                        "created_by",
                        "created_at",
                    },
                ),
                created_by=pack.created_by,
                created_at=pack.created_at,
            )
        )
        await self.session.commit()
        return pack

    async def get_metric_pack(self, metric_pack_id: str, version: str, tenant_id: str | None = None) -> MetricPackVersion | None:
        if tenant_id:
            tenant = await self.session.get(
                MetricPackVersionORM,
                metric_pack_version_key(metric_pack_id, version, tenant_id),
            )
            if tenant:
                return _metric_pack_from_orm(tenant)
        platform = await self.session.get(MetricPackVersionORM, metric_pack_version_key(metric_pack_id, version))
        return _metric_pack_from_orm(platform) if platform else None

    async def list_metric_packs(self, tenant_id: str | None = None) -> list[MetricPackVersion]:
        statement = select(MetricPackVersionORM)
        if tenant_id:
            statement = statement.where((tenant_clause(MetricPackVersionORM, tenant_id)) | (MetricPackVersionORM.tenant_id.is_(None)))
        result = await self.session.execute(statement.order_by(MetricPackVersionORM.metric_pack_id, MetricPackVersionORM.version))
        return [_metric_pack_from_orm(orm) for orm in result.scalars().all()]

    async def transition_metric_pack(
        self,
        metric_pack_id: str,
        version: str,
        tenant_id: str | None,
        status: EvaluatorStatus,
        *,
        commit: bool = True,
    ) -> MetricPackVersion | None:
        orm = await self.session.get(
            MetricPackVersionORM,
            metric_pack_version_key(metric_pack_id, version, tenant_id),
        )
        if not orm:
            return None
        _validate_evaluator_transition(EvaluatorStatus(orm.status), status)
        orm.status = status.value
        if commit:
            await self.session.commit()
        else:
            await self.session.flush()
        return _metric_pack_from_orm(orm)

    async def _profile_metric_definitions(self, profile: QualityProfileVersion) -> list[dict]:
        """Resolve profile/pack evaluator references to declared metric contracts."""
        definitions: list[dict] = []
        for metric_id in profile.metric_ids:
            metric = METRIC_CATALOG.get(metric_id)
            if metric and metric.criteria:
                definitions.append(metric.model_dump(mode="json"))
        for pack_reference in profile.metric_pack_refs:
            pack_id, version = parse_evaluator_ref(pack_reference)
            pack = await self.get_metric_pack(pack_id, version, profile.tenant_id)
            if not pack or pack.status != EvaluatorStatus.APPROVED:
                raise ContractResolutionError(f"Metric pack {pack_reference} is not approved")
            for metric_id in pack.metric_ids:
                for evaluator_reference in pack.evaluator_refs:
                    evaluator_id, version = parse_evaluator_ref(evaluator_reference)
                    definition = await self.get_evaluator_definition(evaluator_id, version, profile.tenant_id)
                    metric = metric_definition_for_id(definition, metric_id) if definition else None
                    if metric:
                        definitions.append(metric.model_dump(mode="json"))
                        break
        for metric_id, reference in profile.evaluator_refs.items():
            evaluator_id, version = parse_evaluator_ref(reference)
            definition = await self.get_evaluator_definition(evaluator_id, version, profile.tenant_id)
            if not definition or definition.status != EvaluatorStatus.APPROVED:
                raise ContractResolutionError(f"Evaluator {reference} is not approved")
            metric = metric_definition_for_id(definition, metric_id)
            if not metric:
                raise ContractResolutionError(f"Evaluator {reference} does not support metric {metric_id}")
            definitions.append(metric.model_dump(mode="json"))
        return definitions

    async def resolve_and_save_manifest(
        self,
        *,
        tenant_id: str,
        project_id: str,
        target_version_id: str,
        profile_id: str,
        profile_version: str,
        gate_policy_id: str | None = None,
        gate_policy_version: str | None = None,
        benchmark_package_id: str | None = None,
        benchmark_package_version: str | None = None,
        benchmark_family: str | None = None,
        judge_config: dict | None = None,
        evaluation_scope: EvaluationScope = EvaluationScope.FINAL_RESPONSE,
        resolved_by: str = "system",
    ) -> ResolvedRunManifest:
        project = await self.get_project(project_id, tenant_id)
        target = await self.get_target_version(target_version_id, tenant_id)
        profile = await self.get_quality_profile(profile_id, profile_version, tenant_id)
        if not project or not target or not profile:
            raise ContractResolutionError("project, target version, or quality profile was not found in tenant")
        gate = None
        if gate_policy_id or gate_policy_version:
            if not gate_policy_id or not gate_policy_version:
                raise ContractResolutionError("gate policy id and version must be supplied together")
            gate = await self.get_gate_policy(gate_policy_id, gate_policy_version, tenant_id)
            if not gate:
                raise ContractResolutionError("release gate policy was not found in tenant")
        metric_definitions = await self._profile_metric_definitions(profile)
        manifest = resolve_run_manifest(
            project=project,
            target=target,
            profile=profile,
            gate_policy=gate,
            benchmark_package_id=benchmark_package_id,
            benchmark_package_version=benchmark_package_version,
            benchmark_family=benchmark_family,
            judge_config=judge_config or {},
            evaluation_scope=evaluation_scope,
            resolved_by=resolved_by,
            metric_definitions=metric_definitions,
        )
        existing = await self.session.get(RunManifestORM, manifest.manifest_id)
        if existing:
            return _manifest_from_orm(existing)
        self.session.add(
            RunManifestORM(
                manifest_id=manifest.manifest_id,
                manifest_hash=manifest.manifest_hash,
                tenant_id=manifest.tenant_id,
                project_id=manifest.project_id,
                target_version_id=manifest.target_version_id,
                profile_id=manifest.quality_profile_id,
                profile_version=manifest.quality_profile_version,
                gate_policy_id=manifest.gate_policy_id,
                gate_policy_version=manifest.gate_policy_version,
                manifest_json=manifest.model_dump(mode="json"),
                resolved_by=manifest.resolved_by,
                resolved_at=manifest.resolved_at,
            )
        )
        await self.session.commit()
        return manifest

    async def get_run_manifest(self, manifest_id: str, tenant_id: str | None = None) -> ResolvedRunManifest | None:
        orm = await self.session.get(RunManifestORM, manifest_id)
        if not orm or (tenant_id and not tenants_match(orm.tenant_id, tenant_id)):
            return None
        return _manifest_from_orm(orm)

    async def list_run_manifests(self, tenant_id: str, project_id: str | None = None) -> list[ResolvedRunManifest]:
        statement = select(RunManifestORM).where(tenant_clause(RunManifestORM, tenant_id))
        if project_id:
            statement = statement.where(RunManifestORM.project_id == project_id)
        result = await self.session.execute(statement.order_by(RunManifestORM.resolved_at.desc()))
        return [_manifest_from_orm(orm) for orm in result.scalars().all() if not (orm.manifest_json or {}).get("_archived")]

    async def archive_run_manifest(self, manifest_id: str, tenant_id: str) -> bool:
        """Hide a manifest from the active catalog without deleting audit evidence."""

        orm = await self.session.get(RunManifestORM, manifest_id)
        if not orm or not tenants_match(orm.tenant_id, tenant_id):
            return False
        payload = dict(orm.manifest_json or {})
        payload["_archived"] = {"at": datetime.now(UTC).isoformat()}
        orm.manifest_json = payload
        await self.session.commit()
        return True

    async def create_assignment(self, request: CreateAssignmentRequest) -> EvaluationAssignmentVersion:
        """Pin approved controls to one target and freeze an immutable manifest."""

        if bool(request.gate_policy_id) != bool(request.gate_policy_version):
            raise ValueError("gate policy id and version must be supplied together")

        project = await self.get_project(request.project_id, request.tenant_id)
        if project is None:
            raise ValueError("project was not found in the requested tenant")
        if project.status != ProjectStatus.ACTIVE:
            raise ValueError("Assignments can only bind an active Project")
        if project.purpose != ProjectPurpose.SYSTEM:
            raise ValueError("Assignments can only bind an active system Project")

        target = await self.get_target_version(request.target_version_id, request.tenant_id)
        if target is None or target.project_id != request.project_id:
            raise ValueError("target version was not found on the requested Project")

        assignment_id = request.assignment_id or str(uuid.uuid4())
        key = assignment_version_key(assignment_id, request.version, request.tenant_id)
        existing = await self.session.get(AssignmentVersionORM, key)
        if existing:
            raise ValueError(f"Assignment version {key} already exists")

        parent_key = None
        if request.parent_version:
            parent = await self.get_assignment(assignment_id, request.parent_version, request.tenant_id)
            if parent is None:
                raise ValueError("parent Assignment version was not found in the requested tenant")
            parent_key = assignment_version_key(assignment_id, request.parent_version, request.tenant_id)

        manifest = await self.resolve_and_save_manifest(
            tenant_id=request.tenant_id,
            project_id=request.project_id,
            target_version_id=request.target_version_id,
            profile_id=request.profile_id,
            profile_version=request.profile_version,
            gate_policy_id=request.gate_policy_id,
            gate_policy_version=request.gate_policy_version,
            judge_config=request.judge_config,
            evaluation_scope=request.evaluation_scope,
            resolved_by=request.created_by,
        )

        name = (request.name or "").strip() or generated_assignment_name(
            project.name, target.name, target.version
        )
        orm = AssignmentVersionORM(
            assignment_version_id=key,
            assignment_id=assignment_id,
            version=request.version,
            tenant_id=request.tenant_id,
            name=name,
            purpose=request.purpose,
            owner=request.owner or project.owner,
            change_note=request.change_note,
            project_id=request.project_id,
            target_version_id=request.target_version_id,
            profile_id=request.profile_id,
            profile_version=request.profile_version,
            gate_policy_id=request.gate_policy_id,
            gate_policy_version=request.gate_policy_version,
            run_manifest_id=manifest.manifest_id,
            parent_assignment_version_id=parent_key,
            created_by=request.created_by,
        )
        self.session.add(orm)
        await self.session.commit()
        return _assignment_from_orm(orm)

    async def get_assignment(
        self, assignment_id: str, version: str, tenant_id: str | None = None
    ) -> EvaluationAssignmentVersion | None:
        if tenant_id:
            orm = await self.session.get(
                AssignmentVersionORM,
                assignment_version_key(assignment_id, version, tenant_id),
            )
        else:
            orm = None
        if not orm or (tenant_id and not tenants_match(orm.tenant_id, tenant_id)):
            return None
        return _assignment_from_orm(orm)

    async def list_assignments(
        self,
        tenant_id: str,
        *,
        project_id: str | None = None,
        target_version_id: str | None = None,
        assignment_id: str | None = None,
        q: str | None = None,
        include_archived: bool = False,
    ) -> list[EvaluationAssignmentVersion]:
        statement = select(AssignmentVersionORM).where(tenant_clause(AssignmentVersionORM, tenant_id))
        if not include_archived:
            statement = statement.where(AssignmentVersionORM.archived_at.is_(None))
        if project_id:
            statement = statement.where(AssignmentVersionORM.project_id == project_id)
        if target_version_id:
            statement = statement.where(AssignmentVersionORM.target_version_id == target_version_id)
        if assignment_id:
            statement = statement.where(AssignmentVersionORM.assignment_id == assignment_id)
        if q:
            pattern = f"%{q}%"
            statement = statement.where(
                or_(
                    AssignmentVersionORM.name.ilike(pattern),
                    AssignmentVersionORM.purpose.ilike(pattern),
                    AssignmentVersionORM.assignment_id.ilike(pattern),
                )
            )
        result = await self.session.execute(
            statement.order_by(AssignmentVersionORM.created_at.desc())
        )
        return [_assignment_from_orm(orm) for orm in result.scalars().all()]

    async def archive_assignment(
        self, assignment_id: str, version: str, tenant_id: str
    ) -> EvaluationAssignmentVersion | None:
        orm = await self.session.get(
            AssignmentVersionORM,
            assignment_version_key(assignment_id, version, tenant_id),
        )
        if not orm or not tenants_match(orm.tenant_id, tenant_id):
            return None
        if orm.archived_at is None:
            orm.archived_at = datetime.now(UTC)
            await self.session.commit()
        return _assignment_from_orm(orm)

    async def restore_assignment(
        self, assignment_id: str, version: str, tenant_id: str
    ) -> EvaluationAssignmentVersion | None:
        orm = await self.session.get(
            AssignmentVersionORM,
            assignment_version_key(assignment_id, version, tenant_id),
        )
        if not orm or not tenants_match(orm.tenant_id, tenant_id):
            return None
        if orm.archived_at is not None:
            orm.archived_at = None
            await self.session.commit()
        return _assignment_from_orm(orm)

    async def bind_manifest_to_experiment(
        self, experiment_id: str, manifest_id: str, tenant_id: str
    ) -> ExperimentDefinition | None:
        """Rebind ``experiment_id`` onto ``manifest_id``, scoped to ``tenant_id``.

        The tenant check used to fire only when ``exp.tenant_id`` was already
        set, so an experiment with no tenant yet (or one whose tenant_id a
        caller could not otherwise influence) silently adopted whatever
        tenant the named manifest belonged to — with no check that the
        CALLER was ever authorized for that tenant. The caller's own
        authorized ``tenant_id`` (resolved and enforced by the route before
        this is called) is now required and checked unconditionally against
        the manifest, closing that gap regardless of the experiment's
        current tenant state.
        """
        exp = await self.session.get(ExperimentORM, experiment_id)
        manifest = await self.session.get(RunManifestORM, manifest_id)
        if not exp or not manifest:
            return None
        if not tenants_match(manifest.tenant_id, tenant_id):
            raise ValueError("Experiment tenant does not match run manifest tenant")
        payload = _manifest_from_orm(manifest)
        exp.tenant_id = manifest.tenant_id
        exp.project_id = manifest.project_id
        exp.target_id = payload.target_id
        exp.target_version = payload.target_version
        exp.target_version_id = payload.target_version_id
        exp.target_endpoint = payload.target_endpoint
        exp.environment = payload.environment
        exp.scenario = payload.scenario.value
        exp.quality_profile_id = payload.quality_profile_id
        exp.quality_profile_version = payload.quality_profile_version
        exp.gate_policy_id = payload.gate_policy_id
        exp.gate_policy_version = payload.gate_policy_version
        exp.benchmark_package_id = payload.benchmark_package_id
        exp.benchmark_package_version = payload.benchmark_package_version
        exp.run_manifest_id = payload.manifest_id
        await self.session.commit()
        return _experiment_from_orm(exp)


def _experiment_from_orm(orm: ExperimentORM) -> ExperimentDefinition:
    return ExperimentDefinition(
        experiment_id=orm.experiment_id,
        name=orm.name,
        dataset_version=orm.dataset_version,
        target_endpoint=orm.target_endpoint,
        scenario=("" if orm.scenario == "" else Scenario(orm.scenario)),
        domain=orm.domain,
        market=orm.market,
        judge_model=orm.judge_model,
        judge_temperature=orm.judge_temperature,
        has_ground_truth=orm.has_ground_truth,
        safety_defect_tolerance=orm.safety_defect_tolerance,
        created_by=orm.created_by,
        description=getattr(orm, "description", None),
        objective=getattr(orm, "objective", None),
        hypothesis=getattr(orm, "hypothesis", None),
        tenant_id=getattr(orm, "tenant_id", None),
        product_id=getattr(orm, "product_id", None),
        owner=getattr(orm, "owner", None),
        status=ExperimentStatus(getattr(orm, "status", None) or "active"),
        tags=getattr(orm, "tags", None) or {},
        quality_profile_id=getattr(orm, "quality_profile_id", None),
        quality_profile_version=getattr(orm, "quality_profile_version", None),
        benchmark_package_id=getattr(orm, "benchmark_package_id", None),
        benchmark_package_version=getattr(orm, "benchmark_package_version", None),
        target_id=getattr(orm, "target_id", None),
        target_version=getattr(orm, "target_version", None),
        environment=getattr(orm, "environment", None),
        project_id=getattr(orm, "project_id", None),
        target_version_id=getattr(orm, "target_version_id", None),
        gate_policy_id=getattr(orm, "gate_policy_id", None),
        gate_policy_version=getattr(orm, "gate_policy_version", None),
        run_manifest_id=getattr(orm, "run_manifest_id", None),
        evaluation_scope=(EvaluationScope(orm.evaluation_scope) if getattr(orm, "evaluation_scope", None) else None),
        requested_evaluation_scope=(EvaluationScope(orm.requested_evaluation_scope) if getattr(orm, "requested_evaluation_scope", None) else None),
        selected_tool_ids=getattr(orm, "selected_tool_ids", None),
        kpi_threshold_overrides=getattr(orm, "kpi_threshold_overrides", None) or {},
        requested_target_provenance=getattr(orm, "requested_target_provenance", None) or {},
        resolved_target_provenance=getattr(orm, "resolved_target_provenance", None) or {},
        observed_target_provenance=getattr(orm, "observed_target_provenance", None) or {},
        created_at=orm.created_at,
    )


def _project_from_orm(orm: EvaluationProjectORM) -> EvaluationProject:
    return EvaluationProject(
        project_id=orm.project_id,
        tenant_id=orm.tenant_id,
        name=orm.name,
        description=orm.description,
        system_type=orm.system_type,
        owner=orm.owner,
        status=ProjectStatus(orm.status),
        purpose=ProjectPurpose(orm.purpose) if orm.purpose else None,
        tags=orm.tags or {},
        created_by=orm.created_by,
        created_at=orm.created_at,
    )


def _escape_like(term: str) -> str:
    """Escape LIKE wildcards so user input matches literally."""
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _normalize_trace_window_bound(value: datetime | None) -> datetime | None:
    """Normalize a since/until bound to aware UTC (naive input is taken as UTC).

    Captured timestamps are persisted timezone-aware in UTC, so bounds must be
    normalized to the same representation for the SQL comparison to be exact.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _trace_query_filters(
    *,
    search: str | None,
    run_id: str | None,
    status: str | None,
    since: datetime | None,
    until: datetime | None,
    sort_key,
) -> list:
    """Row-level SQL predicates for the trace-list query contract.

    Applied identically to the representative-row ranking, the page query and
    the distinct-trace total so all three agree under filtering.
    """
    clauses: list = []
    term = (search or "").strip()
    if term:
        pattern = f"%{_escape_like(term)}%"
        clauses.append(
            or_(
                EvaluationRunItemORM.trace_id.ilike(pattern, escape="\\"),
                ExperimentORM.name.ilike(pattern, escape="\\"),
                EvaluationRunItemORM.example_id.ilike(pattern, escape="\\"),
            )
        )
    exact_run_id = (run_id or "").strip()
    if exact_run_id:
        clauses.append(EvaluationRunItemORM.run_id == exact_run_id)
    if status:
        # Mirror of _trace_summary's invocation_outcome derivation: a non-empty
        # invocation_error is an error; otherwise a persisted output means
        # succeeded and a missing output means unknown.
        is_error = EvaluationRunItemORM.invocation_error.is_not(None) & (EvaluationRunItemORM.invocation_error != "")
        if status == "error":
            clauses.append(is_error)
        elif status == "succeeded":
            clauses.append(~is_error)
            clauses.append(EvaluationRunItemORM.output_data.is_not(None))
        elif status == "unknown":
            clauses.append(~is_error)
            clauses.append(EvaluationRunItemORM.output_data.is_(None))
        else:
            raise ValueError(f"Unsupported invocation-outcome filter: {status!r}")
    since = _normalize_trace_window_bound(since)
    until = _normalize_trace_window_bound(until)
    if since is not None:
        clauses.append(sort_key >= since)
    if until is not None:
        clauses.append(sort_key <= until)
    return clauses


def _encode_trace_cursor(captured_at: datetime | None, trace_id: str) -> str | None:
    """Opaque keyset cursor for trace paging: (captured_at, trace_id)."""
    if captured_at is None:
        return None
    payload = {"at": captured_at.isoformat(), "tid": trace_id}
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


def _decode_trace_cursor(cursor: str | None) -> tuple[datetime, str] | None:
    """Decode a trace cursor; ignore a malformed value rather than error."""
    if not cursor:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
        return datetime.fromisoformat(payload["at"]), str(payload["tid"])
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


def _encode_span_cursor(started_at: datetime | None, trace_id: str, span_id: str) -> str | None:
    """Opaque keyset cursor for span-index paging: (started_at, trace, span)."""
    if started_at is None:
        return None
    payload = {"at": started_at.isoformat(), "tid": trace_id, "sid": span_id}
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


def _decode_span_cursor(cursor: str | None) -> tuple[datetime, str, str] | None:
    """Decode a span cursor; ignore a malformed value rather than error."""
    if not cursor:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
        return (
            datetime.fromisoformat(payload["at"]),
            str(payload["tid"]),
            str(payload["sid"]),
        )
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


def _index_trace_item(orm: CapturedTraceIndexORM, summary: dict | None) -> dict:
    """Trace-list item from an index row, merged with eval evidence when present.

    Keeps the eval-derived projection's field contract (so the existing UI keeps
    working) and extends it with the honest index columns. Nothing is invented:
    non-evaluation traces carry ``None`` for run/example/evaluation fields, and
    span statistics stay ``None`` until the archive genuinely confirmed spans.
    """

    summary = summary or {}
    confirmed = orm.lifecycle_state == TraceLifecycleState.ARCHIVE_CONFIRMED.value
    if summary.get("invocation_outcome"):
        invocation_outcome = summary["invocation_outcome"]
    elif confirmed:
        invocation_outcome = "error" if (orm.error_count or 0) > 0 else "succeeded"
    else:
        invocation_outcome = "unknown"
    latency_ms = summary.get("latency_ms")
    if latency_ms is None and orm.duration_ms is not None:
        latency_ms = int(orm.duration_ms)
    return {
        "project_id": orm.project_id,
        "trace_id": orm.trace_id,
        "trace_provider": summary.get("trace_provider"),
        "run_id": summary.get("run_id"),
        "run_name": summary.get("run_name"),
        "run_number": summary.get("run_number"),
        "example_id": summary.get("example_id"),
        "evaluation_name": summary.get("evaluation_name"),
        "input_summary": summary.get("input_summary"),
        "evaluation_status": "evaluated" if orm.is_evaluated else "not_evaluated",
        "target_revision": summary.get("target_revision"),
        "captured_at": orm.started_at or orm.created_at,
        "capture_state": "captured" if confirmed else summary.get("capture_state", "unknown"),
        "attestation_state": summary.get("attestation_state", "unknown"),
        "invocation_outcome": invocation_outcome,
        "latency_ms": latency_ms,
        "input_tokens": summary.get("input_tokens"),
        "output_tokens": summary.get("output_tokens"),
        "total_tokens": summary.get("total_tokens"),
        "cost": summary.get("cost") if summary.get("cost") is not None else orm.estimated_cost_usd,
        "run_status": summary.get("run_status"),
        "verdict_status": summary.get("verdict_status"),
        "overall_gate": summary.get("overall_gate"),
        # Honest index extensions.
        "lifecycle_state": orm.lifecycle_state,
        "span_count": orm.span_count,
        "error_count": orm.error_count,
        "root_span_name": orm.root_span_name,
        "root_span_kind": orm.root_span_kind,
        "model": orm.model,
        "duration_ms": orm.duration_ms,
        "is_evaluated": orm.is_evaluated,
        "hidden": orm.hidden,
        "last_checked_at": orm.last_checked_at,
    }


def _trace_summary(
    item: EvaluationRunItemORM,
    run: EvaluationRunORM,
    experiment: ExperimentORM,
) -> dict:
    """Project-tracing projection with independent capture, attestation and outcome."""

    provenance = item.tool_evidence_provenance_status or "unavailable"
    attestation_state = "attested" if item.tool_evidence_completion_attested else "not_attested" if provenance == ProvenanceStatus.SELF_REPORTED.value else "unknown"
    invocation_outcome = "error" if item.invocation_error else "succeeded" if item.output_data is not None else "unknown"
    usage = item.target_usage if isinstance(item.target_usage, dict) else {}
    return {
        "project_id": experiment.project_id,
        "trace_id": item.trace_id,
        "trace_provider": item.trace_provider,
        "run_id": item.run_id,
        "run_name": run.label or (experiment.tags or {}).get("label"),
        "run_number": run.run_number,
        "example_id": item.example_id,
        "evaluation_name": (experiment.tags or {}).get("evaluation_name") or experiment.name,
        "input_summary": item.query,
        "evaluation_status": ("evaluated" if run.status == RunStatus.COMPLETED.value else "partially_evaluated" if run.status == RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE.value else "not_evaluated"),
        "target_revision": experiment.target_version,
        "captured_at": item.captured_at or run.completed_at or run.started_at,
        # This endpoint exposes captured case evidence, not a collector-backed
        # complete lifecycle. Do not promote it to a complete trace.
        "capture_state": "partial",
        "attestation_state": attestation_state,
        "invocation_outcome": invocation_outcome,
        "latency_ms": item.latency_ms,
        "input_tokens": usage.get("input_tokens") or usage.get("prompt_tokens"),
        "output_tokens": usage.get("output_tokens") or usage.get("completion_tokens"),
        "total_tokens": usage.get("total_tokens"),
        "cost": usage.get("cost"),
        "run_status": run.status,
        "verdict_status": run.verdict_status,
        "overall_gate": run.overall_gate,
    }


def _target_from_orm(orm: TargetVersionORM) -> TargetVersion:
    return TargetVersion(
        target_version_id=orm.target_version_id,
        target_id=orm.target_id,
        project_id=orm.project_id,
        tenant_id=orm.tenant_id,
        name=orm.name,
        version=orm.version,
        endpoint=orm.endpoint,
        target_type=orm.target_type,
        environment=orm.environment,
        model_version=orm.model_version,
        prompt_version=orm.prompt_version,
        tool_versions=orm.tool_versions or {},
        configuration=orm.configuration or {},
        created_by=orm.created_by,
        created_at=orm.created_at,
    )


def _target_project_binding_from_orm(
    orm: TargetProjectBindingORM,
) -> TargetProjectBinding:
    return TargetProjectBinding(
        binding_id=orm.binding_id,
        tenant_id=orm.tenant_id,
        target_id=orm.target_id,
        environment=orm.environment,
        system_project_id=orm.system_project_id,
        created_by=orm.created_by,
        created_at=orm.created_at,
    )


def _profile_from_orm(orm: QualityProfileVersionORM) -> QualityProfileVersion:
    payload = dict(orm.contract_json or {})
    return QualityProfileVersion(
        profile_id=orm.profile_id,
        version=orm.version,
        tenant_id=orm.tenant_id,
        name=orm.name,
        description=orm.description,
        project_id=orm.project_id,
        status=VersionLifecycle(orm.status),
        scenario=orm.scenario,
        created_by=orm.created_by,
        created_at=orm.created_at,
        **payload,
    )


def _gate_policy_from_orm(orm: ReleaseGatePolicyVersionORM) -> ReleaseGatePolicyVersion:
    payload = dict(orm.policy_json or {})
    return ReleaseGatePolicyVersion(
        gate_policy_id=orm.gate_policy_id,
        version=orm.version,
        tenant_id=orm.tenant_id,
        name=orm.name,
        description=orm.description,
        status=VersionLifecycle(orm.status),
        created_by=orm.created_by,
        created_at=orm.created_at,
        **payload,
    )


def _manifest_from_orm(orm: RunManifestORM) -> ResolvedRunManifest:
    return ResolvedRunManifest.model_validate(orm.manifest_json)


def _assignment_from_orm(orm: AssignmentVersionORM) -> EvaluationAssignmentVersion:
    return EvaluationAssignmentVersion(
        assignment_id=orm.assignment_id,
        version=orm.version,
        tenant_id=orm.tenant_id,
        name=orm.name,
        purpose=orm.purpose,
        owner=orm.owner,
        change_note=orm.change_note,
        project_id=orm.project_id,
        target_version_id=orm.target_version_id,
        profile_id=orm.profile_id,
        profile_version=orm.profile_version,
        gate_policy_id=orm.gate_policy_id,
        gate_policy_version=orm.gate_policy_version,
        run_manifest_id=orm.run_manifest_id,
        parent_assignment_version_id=orm.parent_assignment_version_id,
        archived_at=orm.archived_at,
        created_by=orm.created_by,
        created_at=orm.created_at,
    )


def _evaluator_from_orm(orm: EvaluatorDefinitionORM) -> EvaluatorDefinition:
    payload = dict(orm.definition_json or {})
    return EvaluatorDefinition(
        evaluator_id=orm.evaluator_id,
        version=orm.version,
        tenant_id=orm.tenant_id,
        name=orm.name,
        description=orm.description,
        status=EvaluatorStatus(orm.status),
        execution_mode=orm.execution_mode,
        adapter=orm.adapter,
        implementation=orm.implementation,
        trusted=orm.trusted,
        created_by=orm.created_by,
        created_at=orm.created_at,
        **payload,
    )


def _metric_pack_from_orm(orm: MetricPackVersionORM) -> MetricPackVersion:
    payload = dict(orm.pack_json or {})
    return MetricPackVersion(
        metric_pack_id=orm.metric_pack_id,
        version=orm.version,
        tenant_id=orm.tenant_id,
        name=orm.name,
        description=orm.description,
        status=EvaluatorStatus(orm.status),
        created_by=orm.created_by,
        created_at=orm.created_at,
        **payload,
    )


def _finding_from_orm(orm: FindingORM) -> Finding:
    return Finding(
        finding_id=orm.finding_id,
        run_id=orm.run_id,
        experiment_id=orm.experiment_id,
        row_id=orm.row_id,
        metric_ids=orm.metric_ids or [],
        gate_result=GateResult(orm.gate_result),
        severity=Severity(orm.severity),
        root_cause_category=orm.root_cause_category,
        evidence=orm.evidence or {},
        status=FindingStatus(orm.status),
        created_at=orm.created_at,
    )


def _review_task_from_orm(orm: ReviewTaskORM) -> ReviewTask:
    return ReviewTask(
        task_id=orm.task_id,
        finding_id=orm.finding_id,
        tenant_id=orm.tenant_id,
        assigned_to=orm.assigned_to,
        status=FindingStatus(orm.status),
        created_at=orm.created_at,
    )


def _regression_case_from_orm(orm: RegressionCaseORM) -> RegressionCase:
    return RegressionCase(
        regression_case_id=orm.regression_case_id,
        tenant_id=orm.tenant_id,
        kind=RegressionKind(orm.kind),
        status=orm.status,
        finding_id=orm.finding_id,
        source_run_id=orm.source_run_id,
        source_target_version_id=orm.source_target_version_id,
        record=orm.record or {},
        provenance=orm.provenance or {},
        created_by=orm.created_by,
        created_at=orm.created_at,
    )


def _finding_comment_from_orm(orm: FindingCommentORM) -> FindingComment:
    return FindingComment(
        comment_id=orm.comment_id,
        finding_id=orm.finding_id,
        tenant_id=orm.tenant_id,
        author=orm.author,
        body=orm.body,
        mentions=list(orm.mentions or []),
        created_at=orm.created_at,
    )


def _remediation_from_orm(orm: RemediationORM) -> Remediation:
    return Remediation(
        remediation_id=orm.remediation_id,
        finding_id=orm.finding_id,
        owner=orm.owner,
        description=orm.description,
        status=RemediationStatus(orm.status),
        due_at=orm.due_at,
        created_by=orm.created_by,
        created_at=orm.created_at,
        updated_at=orm.updated_at,
    )


def _evidence_pack_from_orm(orm: EvidencePackORM) -> EvidencePack:
    return EvidencePack(
        evidence_pack_id=orm.evidence_pack_id,
        run_id=orm.run_id,
        experiment_id=orm.experiment_id,
        overall_gate=GateResult(orm.overall_gate) if orm.overall_gate else None,
        manifest_id=orm.manifest_id,
        contents=orm.contents or {},
        created_at=orm.created_at,
    )


def _audit_event_from_orm(orm: AuditEventORM) -> AuditEvent:
    return AuditEvent(
        audit_event_id=orm.audit_event_id,
        tenant_id=orm.tenant_id,
        actor=orm.actor,
        action=orm.action,
        resource_type=orm.resource_type,
        resource_id=orm.resource_id,
        details=orm.details or {},
        created_at=orm.created_at,
    )


def _validate_lifecycle_transition(current: VersionLifecycle, target: VersionLifecycle) -> None:
    allowed = {
        VersionLifecycle.DRAFT: {VersionLifecycle.VALIDATED, VersionLifecycle.RETIRED},
        VersionLifecycle.VALIDATED: {
            VersionLifecycle.APPROVED,
            VersionLifecycle.RETIRED,
        },
        VersionLifecycle.APPROVED: {VersionLifecycle.RETIRED},
        # Retirement is reversible, but only back to DRAFT — never straight to
        # APPROVED. An approved version is what a release decision binds to, so
        # a reinstated one must earn approval again through the normal path
        # (dry-run or audited override, then validate, then approve) rather than
        # regaining release authority by being un-retired.
        VersionLifecycle.RETIRED: {VersionLifecycle.DRAFT},
    }
    if target not in allowed[current]:
        raise ValueError(f"Invalid version lifecycle transition: {current.value} -> {target.value}")


def _validate_evaluator_transition(current: EvaluatorStatus, target: EvaluatorStatus) -> None:
    allowed = {
        EvaluatorStatus.DRAFT: {EvaluatorStatus.APPROVED, EvaluatorStatus.RETIRED},
        EvaluatorStatus.APPROVED: {EvaluatorStatus.RETIRED},
        EvaluatorStatus.RETIRED: set(),
    }
    if target not in allowed[current]:
        raise ValueError(f"Invalid evaluator lifecycle transition: {current.value} -> {target.value}")


def _version_from_orm(orm: ExperimentVersionORM) -> ExperimentVersion:
    return ExperimentVersion(
        experiment_version_id=orm.experiment_version_id,
        experiment_id=orm.experiment_id,
        contract_json=orm.contract_json or {},
        contract_hash=orm.contract_hash,
        created_by=orm.created_by,
        created_at=orm.created_at,
    )


def _baseline_change_from_orm(orm: BaselineChangeORM) -> BaselineChange:
    return BaselineChange(
        baseline_change_id=orm.baseline_change_id,
        experiment_id=orm.experiment_id,
        tenant_id=orm.tenant_id,
        actor=orm.actor,
        action=orm.action,
        previous_baseline_run_id=orm.previous_baseline_run_id,
        new_baseline_run_id=orm.new_baseline_run_id,
        created_at=orm.created_at,
    )


def _decision_from_orm(orm: ExperimentDecisionORM) -> ExperimentDecision:
    return ExperimentDecision(
        decision_id=orm.decision_id,
        experiment_id=orm.experiment_id,
        run_id=orm.run_id,
        decision=DecisionType(orm.decision),
        reason=orm.reason,
        approved_by=orm.approved_by,
        expires_at=orm.expires_at,
        created_at=orm.created_at,
    )


def _row_from_orm(orm: DatasetRowORM) -> EvaluationRow:
    return EvaluationRow(
        row_id=orm.row_id,
        query=orm.query,
        response=orm.response,
        expected_response=orm.expected_response,
        context=orm.context or [],
        trace_id=orm.trace_id,
        expected_tools=orm.expected_tools or [],
        tool_calls=[ToolCall.model_validate(tc) for tc in (orm.tool_calls or [])],
        trace_unavailable=bool(orm.trace_unavailable),
        tool_evidence_completion_attested=bool(orm.tool_evidence_completion_attested),
        tool_evidence_provenance_status=ProvenanceStatus(orm.tool_evidence_provenance_status or "unavailable"),
        tool_evidence_source=orm.tool_evidence_source,
        from_agent=bool(orm.from_agent),
        tags=orm.tags or {},
        input_data=(orm.input_data if orm.input_data is not None else {"query": orm.query}),
        output_data=(orm.output_data if orm.output_data is not None else {"response": orm.response}),
        expected_data=(orm.expected_data if orm.expected_data is not None else ({"response": orm.expected_response} if orm.expected_response is not None else None)),
        retrieval_snippets=(list(orm.retrieval_snippets) if orm.retrieval_snippets is not None else list(orm.context or [])),
        span_id=orm.span_id,
        parent_span_id=orm.parent_span_id,
        trace_provider=orm.trace_provider,
        invocation_id=orm.invocation_id,
        kagent_session_id=orm.kagent_session_id,
        latency_ms=orm.latency_ms,
        target_usage=orm.target_usage,
        invocation_error=orm.invocation_error,
    )


def _metric_result_from_orm(orm: MetricResultORM) -> MetricResult:
    return MetricResult(
        metric_id=orm.metric_id,
        evaluator_instance_id=orm.evaluator_config_id,
        run_id=orm.run_id,
        row_id=orm.row_id,
        metric_requirement=MetricRequirement(getattr(orm, "metric_requirement", None) or "required"),
        metric_requirement_source=(MetricRequirementSource(orm.metric_requirement_source) if getattr(orm, "metric_requirement_source", None) else None),
        metric_applicability=MetricApplicability(getattr(orm, "metric_applicability", None) or "applicable"),
        metric_status=(MetricStatus(orm.metric_status) if getattr(orm, "metric_status", None) else None),
        unscored_reason=(UnscoredReason(orm.unscored_reason) if getattr(orm, "unscored_reason", None) else None),
        error_details=getattr(orm, "error_details", None),
        score=orm.score,
        normalised_score=orm.normalised_score,
        label=orm.label,
        passed=orm.passed,
        rationale=orm.rationale,
        error_message=orm.error_message,
        threshold=orm.threshold,
        threshold_result=(GateResult(orm.threshold_result) if orm.threshold_result else None),
        prompt_version=orm.prompt_version or PROMPT_VERSION,
        judge_prompt_tokens=orm.judge_prompt_tokens,
        judge_completion_tokens=orm.judge_completion_tokens,
        judge_total_tokens=orm.judge_total_tokens,
        judge_model=orm.judge_model,
        subject_kind=orm.subject_kind,
        trace_id=orm.trace_id,
        span_id=getattr(orm, "span_id", None),
        target_trace_id=getattr(orm, "target_trace_id", None),
        target_span_id=getattr(orm, "target_span_id", None),
        evaluator_trace_id=getattr(orm, "evaluator_trace_id", None),
        evaluator_span_id=getattr(orm, "evaluator_span_id", None),
        feedback_scope=getattr(orm, "feedback_scope", None) or "span",
        annotator_kind=getattr(orm, "annotator_kind", None),
        evaluation_identifier=getattr(orm, "evaluation_identifier", None),
        dataset_version=orm.dataset_version,
        timestamp=orm.evaluated_at,
        sample_input=orm.sample_input,
        sample_output=orm.sample_output,
        evaluator_id=getattr(orm, "evaluator_id", None),
        evaluator_version=getattr(orm, "evaluator_version", None),
        execution_status=getattr(orm, "execution_status", None) or "success",
        execution_metadata=getattr(orm, "execution_metadata", None) or {},
        requested_scorer=getattr(orm, "requested_scorer", None),
        executed_scorer=getattr(orm, "executed_scorer", None),
    )


def _run_item_summary(
    item: _RunItemListRecord,
    metric_summary: _RunItemMetricSummary | None,
    artifact_count: int = 0,
) -> RunItemSummary:
    error_type = _error_type_from_invocation(item.invocation_error)
    if error_type == "AGENT_OUTPUT_TOO_LARGE":
        evaluation_state = "output_too_large"
    elif metric_summary is None:
        evaluation_state = "not_evaluated"
    elif metric_summary.error_count > 0 or item.invocation_error:
        evaluation_state = "technical_error"
    else:
        evaluation_state = "evaluated"
    return RunItemSummary(
        run_id=item.run_id,
        example_id=item.example_id,
        query=item.query or (metric_summary.sample_query if metric_summary else None),
        sequence_position=item.sequence_position,
        dataset_version=item.dataset_version,
        worst_gate=(metric_summary.worst_gate if metric_summary else None),
        metric_count=metric_summary.metric_count if metric_summary else 0,
        failing_count=metric_summary.failing_count if metric_summary else 0,
        failing_optional_count=metric_summary.failing_optional_count if metric_summary else 0,
        error_count=metric_summary.error_count if metric_summary else 0,
        scored_count=metric_summary.scored_count if metric_summary else 0,
        unscored_count=metric_summary.unscored_count if metric_summary else 0,
        unscored_required_count=(metric_summary.unscored_required_count if metric_summary else 0),
        not_applicable_count=(metric_summary.not_applicable_count if metric_summary else 0),
        evaluation_state=evaluation_state,
        latency_ms=item.latency_ms,
        # Tool interactions are useful evidence but are not a full execution
        # trace. Only a genuine persisted runtime trace ID enables Projects.
        trace_available=bool(item.trace_id),
        evidence_ref=item.evidence_ref,
        capture_state=item.capture_state,
        error_type=error_type,
        artifact_count=artifact_count,
    )


def _error_type_from_invocation(invocation_error: str | None) -> str | None:
    if not invocation_error:
        return None
    if invocation_error.startswith("AGENT_OUTPUT_TOO_LARGE"):
        return "AGENT_OUTPUT_TOO_LARGE"
    return None


def _run_item_detail(
    item: EvaluationRunItemORM,
    metrics: list[MetricResult],
    artifacts: list[ToolResultArtifactReference],
) -> RunItemDetail:
    return RunItemDetail(
        run_id=item.run_id,
        example_id=item.example_id,
        sequence_position=item.sequence_position,
        dataset_version=item.dataset_version,
        input=item.input_data,
        output=item.output_data,
        expected=item.expected_data,
        metadata=item.row_metadata or {},
        retrieval_snippets=list(item.retrieval_snippets or []),
        expected_tools=list(item.expected_tools or []),
        tool_calls=[ToolCall.model_validate(tool_call) for tool_call in (item.tool_calls or [])],
        tool_result_artifacts=artifacts,
        execution=RunItemExecution(
            invocation_id=item.invocation_id,
            kagent_session_id=item.kagent_session_id,
            latency_ms=item.latency_ms,
            usage=item.target_usage,
            invocation_error=item.invocation_error,
            trace_id=item.trace_id,
            span_id=item.span_id,
            parent_span_id=item.parent_span_id,
            trace_provider=item.trace_provider,
            trace_completion_attested=bool(item.trace_completion_attested),
            model_usage_completion_attested=bool(item.model_usage_completion_attested),
            lifecycle_completion_attested=bool(item.lifecycle_completion_attested),
            tool_evidence_completion_attested=bool(item.tool_evidence_completion_attested),
            tool_evidence_provenance_status=ProvenanceStatus(item.tool_evidence_provenance_status or "unavailable"),
            tool_evidence_source=item.tool_evidence_source,
        ),
        scorer_results=metrics,
        evidence_ref=item.evidence_ref,
        evidence_policy=EvidencePolicy(
            redaction_enabled=item.redaction_enabled,
            max_persisted_string_size=item.max_persisted_string_size,
        ),
        capture_state=item.capture_state,
    )


def _artifact_reference(
    artifact: ToolResultArtifactORM,
) -> ToolResultArtifactReference:
    return ToolResultArtifactReference(
        artifact_id=artifact.artifact_id,
        artifact_ref=f"artifact://tool-results/{artifact.artifact_id}",
        tool_name=artifact.tool_name,
        tool_call_index=artifact.tool_call_index,
        content_type=artifact.content_type,
        size_bytes=artifact.size_bytes,
        preview=artifact.preview,
        preview_bytes=artifact.preview_bytes,
    )


def _legacy_run_item_detail(
    run_id: str,
    example_id: str,
    sequence_position: int,
    metrics: list[MetricResult],
) -> RunItemDetail:
    first = metrics[0]
    trace_id = next((metric.trace_id for metric in metrics if metric.trace_id), None)
    sample_input = first.sample_input
    retrieval_snippets = None
    if isinstance(sample_input, dict) and isinstance(sample_input.get("context"), list):
        retrieval_snippets = list(sample_input["context"])
    return RunItemDetail(
        run_id=run_id,
        example_id=example_id,
        sequence_position=sequence_position,
        dataset_version=first.dataset_version,
        input=sample_input,
        output=first.sample_output,
        expected=None,
        metadata=None,
        retrieval_snippets=retrieval_snippets,
        expected_tools=None,
        tool_calls=None,
        execution=RunItemExecution(trace_id=trace_id),
        scorer_results=metrics,
        evidence_ref=(f"evidence-pack://{run_id}/items/{quote(example_id, safe='')}"),
        evidence_policy=EvidencePolicy(
            redaction_enabled=None,
            max_persisted_string_size=None,
        ),
        capture_state="unknown",
    )


def _run_from_orm(orm: EvaluationRunORM) -> RunResult:
    exp = (
        _experiment_from_orm(orm.experiment)
        if orm.experiment
        else ExperimentDefinition(
            experiment_id=orm.experiment_id,
            name="Unknown",
            dataset_version="",
            target_endpoint="",
            scenario=Scenario.LLM_CORE,
        )
    )

    evaluator_configs = [
        EvaluatorConfig.model_validate(cfg.config_json)
        if cfg.config_json
        else EvaluatorConfig(
            metric_id=cfg.metric_id,
            instance_id=cfg.config_id,
            adapter=cfg.adapter,
            adapter_class=cfg.adapter_class,
            scoring_type=cfg.scoring_type,
        )
        for cfg in orm.evaluator_configs
    ]

    metric_results = [_metric_result_from_orm(mr) for mr in orm.metric_results if mr.subject_kind in (None, "case")]

    kpi_results = [
        KpiResult(
            kpi_id=kr.kpi_id,
            run_id=kr.run_id,
            composite_score=kr.composite_score,
            gate_result=GateResult(kr.gate_result) if kr.gate_result else None,
            observed_score=getattr(kr, "observed_score", None),
            constituent_scores=[ConstituentScore.model_validate(c) for c in kr.constituent_scores],
            threshold_pass=kr.threshold_pass,
            threshold_warn=kr.threshold_warn,
            threshold_fail=kr.threshold_fail,
            dataset_version=kr.dataset_version,
            experiment_id=orm.experiment_id,
            evaluated_target=kr.evaluated_target,
            timestamp=kr.computed_at,
            required_applicable_pair_count=(getattr(kr, "required_applicable_pair_count", None) or 0),
            required_scored_count=getattr(kr, "required_scored_count", None) or 0,
            required_unscored_count=getattr(kr, "required_unscored_count", None) or 0,
            required_technical_error_count=(getattr(kr, "required_technical_error_count", None) or 0),
            required_coverage_percentage=getattr(kr, "required_coverage_percentage", None),
            coverage_label=(CoverageLabel(kr.coverage_label) if getattr(kr, "coverage_label", None) else None),
            optional_applicable_pair_count=(getattr(kr, "optional_applicable_pair_count", None) or 0),
            optional_scored_count=getattr(kr, "optional_scored_count", None) or 0,
            optional_coverage_percentage=getattr(kr, "optional_coverage_percentage", None),
        )
        for kr in orm.kpi_results
    ]

    review_queue = [
        ReviewQueueItem(
            row_id=rq.row_id,
            query=rq.query,
            response=rq.response,
            trace_id=rq.trace_id,
            failing_metrics=rq.failing_metrics or [],
            gate_result=GateResult(rq.gate_result),
            rationale=rq.rationale,
        )
        for rq in orm.review_queue
    ]

    root_cause = None
    if orm.root_cause:
        rc = orm.root_cause
        root_cause = RootCauseDiagnosis(
            root_cause_metric_id=rc.root_cause_metric_id,
            root_cause_label=rc.root_cause_label,
            causal_chain=rc.causal_chain or [],
            failing_metrics=rc.failing_metrics or [],
            recommended_remediation=rc.recommended_remediation,
            has_ground_truth=rc.has_ground_truth,
        )

    stored_labels = list(getattr(orm, "labels", None) or [])
    # The run's own column only. The experiment row is shared by every compatible
    # rerun and its label tag is only ever written, never cleared, so falling back
    # to it handed a later unlabelled run whatever an earlier run was called —
    # asserting a label the operator never typed, which is the one thing the
    # multi-label design set out to avoid.
    legacy_label = getattr(orm, "label", None) or None
    if not stored_labels and legacy_label:
        stored_labels = [legacy_label]

    return RunResult(
        run_id=orm.run_id,
        experiment=exp,
        status=RunStatus(orm.status),
        trigger_reason=TriggerReason(orm.trigger_reason) if orm.trigger_reason else TriggerReason.MANUAL,
        correlation_id=orm.correlation_id,
        retry_count=orm.retry_count or 0,
        experiment_version_id=orm.experiment_version_id,
        prompt_version=orm.prompt_version or PROMPT_VERSION,
        lineage=RunLineage.model_validate(orm.lineage) if orm.lineage else None,
        metric_results=metric_results,
        kpi_results=kpi_results,
        verdict_status=(VerdictStatus(orm.verdict_status) if getattr(orm, "verdict_status", None) else None),
        overall_gate=GateResult(orm.overall_gate) if orm.overall_gate else None,
        diagnostic_only=getattr(orm, "diagnostic_only", False) or False,
        evidence_readiness=(EvidenceReadinessResult.model_validate(orm.evidence_readiness) if getattr(orm, "evidence_readiness", None) else None),
        evidence_capture_status=EvidenceCaptureStatus(getattr(orm, "evidence_capture_status", None) or "unknown"),
        evidence_categories=[EvidenceCategorySummary.model_validate(category) for category in (getattr(orm, "evidence_categories", None) or [])],
        root_cause=root_cause,
        review_queue=review_queue,
        started_at=orm.started_at,
        completed_at=orm.completed_at,
        active_metrics=orm.active_metrics or [],
        evaluator_configs=evaluator_configs,
        run_number=getattr(orm, "run_number", None),
        run_type=RunType(getattr(orm, "run_type", None) or "ad_hoc"),
        created_by=getattr(orm, "created_by", None) or "system",
        git_sha=getattr(orm, "git_sha", None),
        build_id=getattr(orm, "build_id", None),
        deployment_id=getattr(orm, "deployment_id", None),
        duration_ms=getattr(orm, "duration_ms", None),
        artifact_refs=list(getattr(orm, "artifact_refs", None) or []),
        run_manifest_id=getattr(orm, "run_manifest_id", None),
        quality_profile_id=getattr(orm, "quality_profile_id", None),
        quality_profile_version=getattr(orm, "quality_profile_version", None),
        gate_policy_id=getattr(orm, "gate_policy_id", None),
        gate_policy_version=getattr(orm, "gate_policy_version", None),
        label=legacy_label,
        labels=stored_labels,
    )
