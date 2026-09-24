"""Evaluator registry and metric-pack contracts.

The registry owns metadata and compatibility. It does not allow arbitrary code
to execute in the API process; trusted first-party adapters are the only packs
that execute in this first platform slice.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field

from evalhub.evaluation.enums import Adapter
from evalhub.evaluation.metrics import METRIC_CATALOG
from evalhub.evaluation.models import MetricDefinition


class EvaluatorStatus(StrEnum):
    DRAFT = "draft"
    APPROVED = "approved"
    RETIRED = "retired"


class ExecutionMode(StrEnum):
    DETERMINISTIC = "deterministic"
    JUDGE = "judge"
    TRACE = "trace"
    ISOLATED = "isolated"


class CalibrationStatus(StrEnum):
    NOT_REQUIRED = "not_required"
    CALIBRATED = "calibrated"
    PENDING = "pending"


class EvaluatorDefinition(BaseModel):
    """Versioned implementation contract for one evaluator."""

    evaluator_id: str
    version: str
    tenant_id: str | None = None
    name: str
    description: str | None = None
    status: EvaluatorStatus = EvaluatorStatus.DRAFT
    execution_mode: ExecutionMode
    adapter: Adapter
    implementation: str
    metric_definitions: list[MetricDefinition] = Field(default_factory=list)
    input_schema: dict[str, Any] = Field(default_factory=dict)
    output_schema: dict[str, Any] = Field(default_factory=dict)
    execution_policy: dict[str, Any] = Field(default_factory=dict)
    resource_policy: dict[str, Any] = Field(default_factory=dict)
    model_dependency: dict[str, Any] = Field(default_factory=dict)
    calibration_status: CalibrationStatus = CalibrationStatus.NOT_REQUIRED
    cost_metadata: dict[str, Any] = Field(default_factory=dict)
    latency_metadata: dict[str, Any] = Field(default_factory=dict)
    release_blocking_eligible: bool = True
    trusted: bool = False
    created_by: str = "system"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class MetricPackVersion(BaseModel):
    """Installable, versioned collection of evaluator references and metrics."""

    metric_pack_id: str
    version: str
    tenant_id: str | None = None
    name: str
    description: str | None = None
    status: EvaluatorStatus = EvaluatorStatus.DRAFT
    evaluator_refs: list[str] = Field(default_factory=list)
    metric_ids: list[str] = Field(default_factory=list)
    compatibility: dict[str, Any] = Field(default_factory=dict)
    signed_by: str | None = None
    created_by: str = "system"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


def evaluator_version_key(evaluator_id: str, version: str, tenant_id: str | None = None) -> str:
    scope = tenant_id or "platform"
    return f"{scope}:{evaluator_id}@{version}"


def metric_pack_version_key(metric_pack_id: str, version: str, tenant_id: str | None = None) -> str:
    scope = tenant_id or "platform"
    return f"{scope}:{metric_pack_id}@{version}"


def parse_evaluator_ref(reference: str) -> tuple[str, str]:
    """Parse `evaluator-id@version`; a missing version is deliberately invalid."""

    evaluator_id, separator, version = reference.partition("@")
    if not evaluator_id or not separator or not version:
        raise ValueError("evaluator references must use evaluator-id@version")
    return evaluator_id, version


def execution_mode_for_adapter(adapter: Adapter) -> ExecutionMode:
    """Execution mode an adapter runs under. Shared by the registry and the router."""
    if adapter in (Adapter.NATIVE, Adapter.MOCK, Adapter.DETERMINISTIC):
        return ExecutionMode.DETERMINISTIC
    if adapter == Adapter.TRACE:
        return ExecutionMode.TRACE
    if adapter == Adapter.CUSTOM:
        return ExecutionMode.ISOLATED
    return ExecutionMode.JUDGE


def execution_policy_for_mode(mode: ExecutionMode) -> dict[str, Any]:
    """Execution policy for a mode. Only a judge reaches the network."""
    return {"network": mode == ExecutionMode.JUDGE}


def builtin_evaluator_definitions() -> list[EvaluatorDefinition]:
    """Expose existing adapters as first-party evaluator definitions."""

    by_adapter: dict[Adapter, list[MetricDefinition]] = {}
    for metric in METRIC_CATALOG.values():
        by_adapter.setdefault(metric.default_adapter, []).append(metric)
    definitions: list[EvaluatorDefinition] = []
    for adapter, metrics in by_adapter.items():
        execution_mode = execution_mode_for_adapter(adapter)
        calibration = (
            CalibrationStatus.NOT_REQUIRED
            if execution_mode in (ExecutionMode.DETERMINISTIC, ExecutionMode.TRACE)
            else CalibrationStatus.PENDING
        )
        definitions.append(
            EvaluatorDefinition(
                evaluator_id=f"builtin.{adapter.value}",
                version="1.0.0",
                name=f"Built-in {adapter.value} evaluator",
                status=EvaluatorStatus.APPROVED,
                execution_mode=execution_mode,
                adapter=adapter,
                implementation=f"evalhub.evaluation.adapters.{adapter.value}",
                metric_definitions=metrics,
                input_schema={"required": ["query", "response"]},
                output_schema={"score": "number", "rationale": "string"},
                execution_policy=execution_policy_for_mode(execution_mode),
                resource_policy={"trusted_first_party": True},
                calibration_status=calibration,
                trusted=True,
            )
        )
    return definitions


def metric_definition_for_id(definition: EvaluatorDefinition, metric_id: str) -> MetricDefinition | None:
    return next((metric for metric in definition.metric_definitions if metric.metric_id == metric_id), None)
