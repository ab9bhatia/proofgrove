"""Versioned, tenant-local contracts that define an evaluation run.

The control plane deliberately contains no domain policy. A team supplies that
policy through a quality profile, gate policy and benchmark reference; Proofgrove
only resolves and pins the resulting contract for a run.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from urllib.parse import parse_qsl, urlparse
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator

from proofgrove.evaluation.enums import (
    EvaluationScope,
    GateResult,
    MetricRequirement,
    MetricRequirementSource,
    Scenario,
)


class ProfileTestStatus(StrEnum):
    """Whether a Quality Profile draft has been exercised against real data."""

    NOT_TESTED = "not_tested"
    TESTED = "tested"
    OVERRIDDEN = "overridden"


class VersionLifecycle(StrEnum):
    """Lifecycle shared by immutable versioned control-plane objects."""

    DRAFT = "draft"
    VALIDATED = "validated"
    APPROVED = "approved"
    RETIRED = "retired"


class ProjectStatus(StrEnum):
    """Lifecycle for an evaluation project."""

    ACTIVE = "active"
    ARCHIVED = "archived"


class ProjectPurpose(StrEnum):
    """Whether a Project is a trace workspace or an internal registry."""

    SYSTEM = "system"
    CATALOG_REGISTRY = "catalog_registry"


class TargetType(StrEnum):
    """Generic target categories; product-specific types stay in metadata."""

    AGENT = "agent"
    APPLICATION = "application"
    RAG_SYSTEM = "rag_system"
    ENDPOINT = "endpoint"


class QualityContractTemplate(BaseModel):
    """Built-in rubric that can be instantiated as a governed quality profile."""

    template_id: str
    name: str
    description: str
    domain: str
    criteria: str
    evaluation_steps: list[str]
    threshold: float = Field(ge=0, le=1)
    evaluation_params: list[str]
    tags: list[str] = Field(default_factory=list)
    scenario: Scenario
    metric_id: str


class InstantiateQualityContractRequest(BaseModel):
    """Create an immutable draft profile version from a built-in rubric."""

    tenant_id: str = Field(min_length=1)
    project_id: str | None = None
    profile_id: str | None = None
    version: str = "1.0.0"
    name: str | None = None
    description: str | None = None
    created_by: str = "system"


class EvaluationProject(BaseModel):
    """Tenant-local home for the quality configuration of one AI system."""

    project_id: str = Field(default_factory=lambda: str(uuid4()))
    tenant_id: str
    name: str
    description: str | None = None
    system_type: str
    owner: str
    status: ProjectStatus = ProjectStatus.ACTIVE
    purpose: ProjectPurpose | None = ProjectPurpose.SYSTEM
    tags: dict[str, str] = Field(default_factory=dict)
    created_by: str = "system"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class TargetVersion(BaseModel):
    """An immutable deployable target configuration within a project."""

    target_version_id: str = Field(default_factory=lambda: str(uuid4()))
    target_id: str
    project_id: str
    tenant_id: str
    name: str
    version: str
    endpoint: str
    target_type: TargetType = TargetType.ENDPOINT
    environment: str = "dev"
    model_version: str | None = None
    prompt_version: str | None = None
    tool_versions: dict[str, str] = Field(default_factory=dict)
    configuration: dict[str, Any] = Field(default_factory=dict)
    created_by: str = "system"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("endpoint")
    @classmethod
    def reject_embedded_credentials(cls, endpoint: str) -> str:
        parsed = urlparse(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("endpoint must be an absolute http(s) URL")
        if parsed.username or parsed.password:
            raise ValueError("endpoint must not contain embedded credentials")
        if any("token" in key.lower() or "key" in key.lower() or "secret" in key.lower() for key, _ in parse_qsl(parsed.query)):
            raise ValueError("endpoint must not contain a credential query parameter")
        return endpoint


class QualityProfileVersion(BaseModel):
    """An immutable definition of quality rules for a project or tenant."""

    profile_id: str
    version: str
    tenant_id: str
    name: str
    description: str | None = None
    project_id: str | None = None
    status: VersionLifecycle = VersionLifecycle.DRAFT
    scenario: Scenario | None = None
    metric_ids: list[str] = Field(default_factory=list)
    metric_requirements: dict[str, MetricRequirement] = Field(default_factory=dict)
    kpi_gate_weights: dict[str, dict[str, float]] = Field(default_factory=dict)
    evaluator_refs: dict[str, str] = Field(default_factory=dict)
    metric_pack_refs: list[str] = Field(default_factory=list)
    kpi_threshold_overrides: dict[str, dict[str, float]] = Field(default_factory=dict)
    benchmark_families: list[str] = Field(default_factory=list)
    evidence_requirements: list[str] = Field(default_factory=list)
    exact_runtime_identity_required: bool = False
    hard_blocker_metric_ids: list[str] = Field(default_factory=list)
    review_trigger_gates: list[GateResult] = Field(
        default_factory=lambda: [GateResult.WARN, GateResult.FAIL]
    )
    approver_roles: list[str] = Field(default_factory=list)
    judge_policy: dict[str, Any] = Field(default_factory=dict)
    gate_policy_id: str | None = None
    gate_policy_version: str | None = None
    source_template_id: str | None = None
    source_template_snapshot: dict[str, Any] | None = None
    # Authoring readiness: stay Not tested until a dry-run succeeds or an
    # authorised override is recorded. Stored in contract_json.
    test_status: ProfileTestStatus = ProfileTestStatus.NOT_TESTED
    tested_at: datetime | None = None
    test_note: str | None = None
    tested_by: str | None = None
    #: The run whose stored evidence was scored against these checks. Present
    #: only for TESTED, so a reader can open the dry run rather than trust it.
    test_run_id: str | None = None
    created_by: str = "system"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("kpi_threshold_overrides")
    @classmethod
    def validate_thresholds(cls, overrides: dict[str, dict[str, float]]) -> dict[str, dict[str, float]]:
        for kpi_id, thresholds in overrides.items():
            for key, value in thresholds.items():
                if not 0 <= value <= 1:
                    raise ValueError(f"{kpi_id}.{key} must be between 0 and 1")
            if "pass" in thresholds and "warn" in thresholds and thresholds["warn"] > thresholds["pass"]:
                raise ValueError(f"{kpi_id}.warn must be less than or equal to pass")
        return overrides

    @field_validator("kpi_gate_weights")
    @classmethod
    def validate_gate_weights(
        cls, compositions: dict[str, dict[str, float]]
    ) -> dict[str, dict[str, float]]:
        for kpi_id, weights in compositions.items():
            if not weights:
                raise ValueError(f"{kpi_id} gate composition must not be empty")
            for metric_id, weight in weights.items():
                if not 0 < weight <= 1:
                    raise ValueError(f"{kpi_id}.{metric_id} weight must be greater than 0 and at most 1")
        return compositions


class MarkProfileTestedRequest(BaseModel):
    """Record that a Quality Profile was exercised, or override Not tested."""

    mode: ProfileTestStatus
    note: str | None = None
    #: The completed run whose stored evidence was rescored against this
    #: Profile's checks. Required for TESTED: the status previously rested on a
    #: free-text dataset name nothing resolved, so it asserted a dry run rather
    #: than evidencing one.
    source_run_id: str | None = None
    #: Retained so an older client's call still parses. It is recorded for
    #: display and never accepted as evidence that a dry run happened.
    dataset_name: str | None = None

    @field_validator("mode")
    @classmethod
    def only_tested_or_overridden(cls, value: ProfileTestStatus) -> ProfileTestStatus:
        if value not in {ProfileTestStatus.TESTED, ProfileTestStatus.OVERRIDDEN}:
            raise ValueError("mode must be tested or overridden")
        return value

    @field_validator("note", "dataset_name", mode="before")
    @classmethod
    def empty_as_none(cls, value: Any) -> Any:
        if isinstance(value, str) and not value.strip():
            return None
        return value.strip() if isinstance(value, str) else value


class ReleaseGatePolicyVersion(BaseModel):
    """Immutable release-decision policy referenced by a quality profile."""

    gate_policy_id: str
    version: str
    tenant_id: str
    name: str
    description: str | None = None
    status: VersionLifecycle = VersionLifecycle.DRAFT
    kpi_threshold_overrides: dict[str, dict[str, float]] = Field(default_factory=dict)
    hard_blocker_metric_ids: list[str] = Field(default_factory=list)
    required_evidence: list[str] = Field(default_factory=list)
    required_approver_roles: list[str] = Field(default_factory=list)
    review_required_for: list[GateResult] = Field(default_factory=lambda: [GateResult.WARN, GateResult.FAIL])
    created_by: str = "system"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ResolvedMetricRequirement(BaseModel):
    """Immutable requirement classification for one selected metric."""

    metric_id: str
    requirement: MetricRequirement
    source: MetricRequirementSource


class ResolvedKpiComposition(BaseModel):
    """Immutable gate and diagnostic composition for one selected KPI."""

    kpi_id: str
    required_gate_constituents: list[str] = Field(default_factory=list)
    optional_diagnostic_constituents: list[str] = Field(default_factory=list)
    fixed_gate_weights: dict[str, float] = Field(default_factory=dict)
    thresholds: dict[str, float] = Field(default_factory=dict)
    hard_blocker_metric_ids: list[str] = Field(default_factory=list)


class ResolvedScoringConfiguration(BaseModel):
    """Content-addressed scoring contract for an ordinary dataset run.

    Unlike an approved ``ResolvedRunManifest``, this snapshot carries no
    governance claim. It freezes the selected metric definitions, requirement
    sources, evidence dependencies, and KPI gate composition before enqueue.
    """

    configuration_id: str
    configuration_hash: str
    scenario: Scenario
    # ``evaluation_scope`` remains the V1 compatibility alias for the resolved
    # effective scope.
    evaluation_scope: EvaluationScope
    requested_evaluation_scope: EvaluationScope | None = None
    resolved_evaluation_scope: EvaluationScope | None = None
    scope_promotion_reasons: list[dict[str, str]] = Field(default_factory=list)
    metric_ids: list[str]
    metric_requirements: list[ResolvedMetricRequirement] = Field(default_factory=list)
    kpi_compositions: list[ResolvedKpiComposition] = Field(default_factory=list)
    metric_definitions: list[dict[str, Any]] = Field(default_factory=list)
    metric_evidence_requirements: dict[str, list[str]] = Field(default_factory=dict)
    effective_evidence_requirements: list[str] = Field(default_factory=list)
    quality_contract_template_ids: list[str] = Field(default_factory=list)
    quality_contract_template_snapshots: list[dict[str, Any]] = Field(default_factory=list)
    diagnostic_only: bool = False
    resolved_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ResolvedRunManifest(BaseModel):
    """Immutable, fully resolved input contract consumed by one evaluation run."""

    manifest_id: str
    manifest_hash: str
    tenant_id: str
    project_id: str
    target_version_id: str
    target_id: str
    #: The target's display name at resolve time. Snapshotted rather than looked
    #: up later: a contract outlives its target, so resolving the name live left
    #: an archived target showing its raw id in the catalog.
    target_name: str | None = None
    target_version: str
    target_endpoint: str
    target_type: TargetType
    environment: str
    quality_profile_id: str
    quality_profile_version: str
    gate_policy_id: str | None = None
    gate_policy_version: str | None = None
    benchmark_package_id: str | None = None
    benchmark_package_version: str | None = None
    benchmark_family: str | None = None
    scenario: Scenario
    metric_ids: list[str]
    metric_requirements: list[ResolvedMetricRequirement] = Field(default_factory=list)
    kpi_compositions: list[ResolvedKpiComposition] = Field(default_factory=list)
    diagnostic_only: bool = False
    evaluator_refs: dict[str, str] = Field(default_factory=dict)
    metric_pack_refs: list[str] = Field(default_factory=list)
    metric_definitions: list[dict[str, Any]] = Field(default_factory=list)
    metric_evidence_requirements: dict[str, list[str]] = Field(default_factory=dict)
    effective_evidence_requirements: list[str] = Field(default_factory=list)
    exact_runtime_identity_required: bool = False
    kpi_threshold_overrides: dict[str, dict[str, float]] = Field(default_factory=dict)
    hard_blocker_metric_ids: list[str] = Field(default_factory=list)
    evidence_requirements: list[str] = Field(default_factory=list)
    review_trigger_gates: list[GateResult] = Field(default_factory=list)
    approver_roles: list[str] = Field(default_factory=list)
    judge_config: dict[str, Any] = Field(default_factory=dict)
    source_template_id: str | None = None
    source_template_snapshot: dict[str, Any] | None = None
    model_version: str | None = None
    prompt_version: str | None = None
    tool_versions: dict[str, str] = Field(default_factory=dict)
    requested_evaluation_scope: EvaluationScope | None = None
    resolved_evaluation_scope: EvaluationScope | None = None
    scope_promotion_reasons: list[dict[str, str]] = Field(default_factory=list)
    # Historical manifests predate scope metadata and therefore deserialize as null.
    evaluation_scope: EvaluationScope | None = None
    resolved_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    resolved_by: str = "system"


class ResolveManifestRequest(BaseModel):
    """References required to compile a run manifest."""

    tenant_id: str
    project_id: str
    target_version_id: str
    profile_id: str
    profile_version: str
    gate_policy_id: str | None = None
    gate_policy_version: str | None = None
    benchmark_package_id: str | None = None
    benchmark_package_version: str | None = None
    benchmark_family: str | None = None
    judge_config: dict[str, Any] = Field(default_factory=dict)
    evaluation_scope: EvaluationScope = EvaluationScope.FINAL_RESPONSE
    resolved_by: str = "system"


class AssignmentGovernanceState(StrEnum):
    """Derived launch/review state of a saved Assignment version.

    Diagnostic runs have no Assignment. An Assignment without a Gate Policy is a
    standardized evaluation. An Assignment with an approved Gate Policy is
    release-governed; eligibility is decided only after execution.
    """

    STANDARDIZED_EVALUATION = "standardized_evaluation"
    RELEASE_GOVERNED = "release_governed"


class CreateAssignmentRequest(BaseModel):
    """Create a named, versioned binding of a target to approved controls.

    Dataset/benchmark identity is intentionally omitted until product decides
    whether an Assignment pins a dataset version or leaves it to launch time.
    """

    tenant_id: str = Field(min_length=1)
    assignment_id: str | None = None
    version: str = "1.0.0"
    name: str | None = None
    purpose: str | None = None
    owner: str | None = None
    change_note: str | None = None
    project_id: str = Field(min_length=1)
    target_version_id: str = Field(min_length=1)
    profile_id: str = Field(min_length=1)
    profile_version: str = Field(min_length=1)
    gate_policy_id: str | None = None
    gate_policy_version: str | None = None
    parent_version: str | None = None
    judge_config: dict[str, Any] = Field(default_factory=dict)
    evaluation_scope: EvaluationScope = EvaluationScope.FINAL_RESPONSE
    created_by: str = "system"

    @field_validator(
        "assignment_id",
        "name",
        "purpose",
        "owner",
        "change_note",
        "gate_policy_id",
        "gate_policy_version",
        "parent_version",
        mode="before",
    )
    @classmethod
    def empty_string_as_missing(cls, value: Any) -> Any:
        if isinstance(value, str) and not value.strip():
            return None
        return value.strip() if isinstance(value, str) else value


class EvaluationAssignmentVersion(BaseModel):
    """Immutable Assignment version. Later edits create a new version."""

    assignment_id: str
    version: str
    tenant_id: str
    name: str
    purpose: str | None = None
    owner: str | None = None
    change_note: str | None = None
    project_id: str
    target_version_id: str
    profile_id: str
    profile_version: str
    gate_policy_id: str | None = None
    gate_policy_version: str | None = None
    run_manifest_id: str
    parent_assignment_version_id: str | None = None
    archived_at: datetime | None = None
    created_by: str = "system"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @property
    def governance_state(self) -> AssignmentGovernanceState:
        if self.gate_policy_id and self.gate_policy_version:
            return AssignmentGovernanceState.RELEASE_GOVERNED
        return AssignmentGovernanceState.STANDARDIZED_EVALUATION


def generated_assignment_name(project_name: str, target_name: str, target_version: str) -> str:
    return f"{project_name} · {target_name} {target_version}"


def assignment_version_key(assignment_id: str, version: str, tenant_id: str | None = None) -> str:
    """Tenant-qualified key, mirroring Profile and Gate Policy identity."""

    scope = tenant_id or "platform"
    return f"{scope}:{assignment_id}@{version}"


def profile_version_key(profile_id: str, version: str, tenant_id: str | None = None) -> str:
    """Tenant-qualified key, mirroring ``evaluator_version_key``.

    Tenant is part of the key rather than a column beside it: two tenants must
    both be able to own ``support-quality@1.0.0``.
    """

    scope = tenant_id or "platform"
    return f"{scope}:{profile_id}@{version}"


def legacy_profile_version_key(profile_id: str, version: str) -> str:
    """Pre-tenant-scoped storage key. Kept only to read unmigrated rows."""

    return f"{profile_id}@{version}"


def gate_policy_version_key(
    gate_policy_id: str, version: str, tenant_id: str | None = None
) -> str:
    scope = tenant_id or "platform"
    return f"{scope}:{gate_policy_id}@{version}"


def legacy_gate_policy_version_key(gate_policy_id: str, version: str) -> str:
    return f"{gate_policy_id}@{version}"
