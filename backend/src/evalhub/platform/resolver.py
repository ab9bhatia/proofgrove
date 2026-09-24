"""Deterministic quality-contract resolution for evaluation runs."""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Collection
from typing import Any

from evalhub.errors import TenantVisibleError
from evalhub.evaluation.enums import (
    EvaluationScope,
    MetricRequirement,
    MetricRequirementSource,
    Scenario,
)
from evalhub.evaluation.evidence_requirements import (
    recognized_capture_categories,
    resolve_effective_evidence_requirements,
    resolve_evaluation_scope,
    resolve_metric_evidence_requirements,
    scope_promotion_reasons,
)
from evalhub.evaluation.kpis import get_kpis_for_scenario
from evalhub.evaluation.models import MetricDefinition
from evalhub.evaluation.scenario_policy import resolve_scenario
from evalhub.evaluation.scenario_router import (
    CROSS_CUTTING_METRICS,
    SCENARIO_METRICS,
    select_metrics,
)
from evalhub.platform.authz import tenants_match
from evalhub.platform.contracts import (
    EvaluationProject,
    QualityProfileVersion,
    ReleaseGatePolicyVersion,
    ResolvedKpiComposition,
    ResolvedMetricRequirement,
    ResolvedRunManifest,
    ResolvedScoringConfiguration,
    TargetVersion,
    VersionLifecycle,
)


class ContractResolutionError(ValueError, TenantVisibleError):
    """Raised when a control-plane reference cannot form a valid run contract."""


def builtin_metric_ids(scenario: Scenario) -> list[str]:
    """Return the existing scenario battery as an explicit built-in template."""

    return [metric.metric_id for metric in select_metrics(scenario)]


def resolve_scoring_configuration(
    *,
    metric_ids: list[str],
    explicit_metric_ids: set[str],
    scenario: Scenario,
    evaluation_scope: EvaluationScope,
    quality_contract_template_snapshots: list[dict[str, Any]] | None = None,
) -> ResolvedScoringConfiguration:
    """Freeze the executable scoring inputs for a non-governed dataset run."""

    selected_metrics = select_metrics(
        scenario,
        has_ground_truth=True,
        metric_ids=metric_ids,
    )
    selected_ids = [metric.metric_id for metric in selected_metrics]
    missing = sorted(set(metric_ids) - set(selected_ids))
    if missing:
        raise ContractResolutionError(
            "scoring configuration references unknown metric(s): " + ", ".join(missing)
        )

    metric_definitions = [
        metric.model_dump(mode="json") for metric in selected_metrics
    ]
    metric_evidence_requirements = resolve_metric_evidence_requirements(
        selected_metrics
    )
    effective_evidence_requirements = resolve_effective_evidence_requirements(
        evaluation_scope,
        metric_evidence_requirements,
    )
    resolved_scope = resolve_evaluation_scope(
        evaluation_scope, effective_evidence_requirements
    )
    promotion_reasons = scope_promotion_reasons(
        evaluation_scope, resolved_scope, metric_evidence_requirements
    )
    effective_evidence_requirements = resolve_effective_evidence_requirements(
        resolved_scope,
        metric_evidence_requirements,
    )
    resolved_requirements = _resolve_metric_requirements(
        metric_ids=selected_ids,
        scenario=scenario,
        contract_requirements={},
        explicit_metric_ids=explicit_metric_ids,
        # Dataset-run selections are user choices, not contract pins: they must
        # never freeze a required/locked state the user cannot clear.
        explicit_selection_pins_required=False,
    )
    requirement_by_metric = {
        item.metric_id: item.requirement for item in resolved_requirements
    }
    kpi_compositions = _resolve_kpi_compositions(
        metric_ids=selected_ids,
        requirement_by_metric=requirement_by_metric,
        scenario=scenario,
        configured_weights={},
        threshold_overrides={},
        hard_blocker_metric_ids=[],
    )
    diagnostic_only = not any(
        requirement == MetricRequirement.REQUIRED
        for requirement in requirement_by_metric.values()
    )
    template_snapshots = quality_contract_template_snapshots or []
    template_ids = sorted(
        str(snapshot.get("template_id"))
        for snapshot in template_snapshots
        if snapshot.get("template_id")
    )
    payload = {
        "scenario": scenario.value,
        "requested_evaluation_scope": evaluation_scope.value,
        "resolved_evaluation_scope": resolved_scope.value,
        "metric_ids": selected_ids,
        "metric_requirements": [
            item.model_dump(mode="json") for item in resolved_requirements
        ],
        "kpi_compositions": [
            item.model_dump(mode="json") for item in kpi_compositions
        ],
        "metric_definitions": metric_definitions,
        "metric_evidence_requirements": metric_evidence_requirements,
        "effective_evidence_requirements": effective_evidence_requirements,
        "scope_promotion_reasons": promotion_reasons,
        "quality_contract_template_ids": template_ids,
        "quality_contract_template_snapshots": template_snapshots,
        "diagnostic_only": diagnostic_only,
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode()
    ).hexdigest()
    return ResolvedScoringConfiguration(
        configuration_id=f"scoring-{digest[:20]}",
        configuration_hash=digest,
        scenario=scenario,
        evaluation_scope=resolved_scope,
        requested_evaluation_scope=evaluation_scope,
        resolved_evaluation_scope=resolved_scope,
        scope_promotion_reasons=promotion_reasons,
        metric_ids=selected_ids,
        metric_requirements=resolved_requirements,
        kpi_compositions=kpi_compositions,
        metric_definitions=metric_definitions,
        metric_evidence_requirements=metric_evidence_requirements,
        effective_evidence_requirements=effective_evidence_requirements,
        quality_contract_template_ids=template_ids,
        quality_contract_template_snapshots=template_snapshots,
        diagnostic_only=diagnostic_only,
    )


def resolve_run_manifest(
    *,
    project: EvaluationProject,
    target: TargetVersion,
    profile: QualityProfileVersion,
    gate_policy: ReleaseGatePolicyVersion | None,
    benchmark_package_id: str | None,
    benchmark_package_version: str | None,
    benchmark_family: str | None,
    judge_config: dict[str, Any],
    resolved_by: str,
    metric_definitions: list[dict[str, Any]] | None = None,
    evaluation_scope: EvaluationScope = EvaluationScope.FINAL_RESPONSE,
) -> ResolvedRunManifest:
    """Validate references and return a content-addressed immutable manifest."""

    if not tenants_match(target.tenant_id, project.tenant_id) or target.project_id != project.project_id:
        raise ContractResolutionError("target version does not belong to the requested project and tenant")
    if not tenants_match(profile.tenant_id, project.tenant_id):
        raise ContractResolutionError("quality profile does not belong to the requested tenant")
    if profile.project_id and profile.project_id != project.project_id:
        raise ContractResolutionError("quality profile is scoped to a different project")
    if profile.status != VersionLifecycle.APPROVED:
        raise ContractResolutionError("quality profile version must be approved before it can be used")
    if gate_policy:
        if not tenants_match(gate_policy.tenant_id, project.tenant_id):
            raise ContractResolutionError("gate policy does not belong to the requested tenant")
        if gate_policy.status != VersionLifecycle.APPROVED:
            raise ContractResolutionError("gate policy version must be approved before it can be used")
    # Precedence lives in one place (evaluation.scenario_policy): resolved
    # configuration > target declaration.
    scenario = resolve_scenario(
        configured=profile.scenario,
        target_scenario=target.configuration.get("scenario"),
        target_type=target.target_type.value,
    )
    metric_ids = profile.metric_ids or builtin_metric_ids(scenario)
    from evalhub.evaluation.metrics import METRIC_CATALOG

    extension_metric_ids = {item.get("metric_id") for item in metric_definitions or []}
    unknown_metrics = sorted(set(metric_ids) - set(METRIC_CATALOG) - extension_metric_ids)
    if unknown_metrics:
        raise ContractResolutionError(f"quality profile references unknown metric(s): {', '.join(unknown_metrics)}")

    extension_metrics = [
        MetricDefinition.model_validate(item) for item in metric_definitions or []
    ]
    selected_metrics = select_metrics(
        scenario,
        has_ground_truth=True,
        metric_ids=metric_ids,
        metric_definitions=extension_metrics,
    )
    metric_evidence_requirements = resolve_metric_evidence_requirements(selected_metrics)

    thresholds = dict(profile.kpi_threshold_overrides)
    if gate_policy:
        thresholds = {**thresholds, **gate_policy.kpi_threshold_overrides}
    blockers = list(profile.hard_blocker_metric_ids)
    evidence = list(profile.evidence_requirements)
    approvers = list(profile.approver_roles)
    review_gates = list(profile.review_trigger_gates)
    if gate_policy:
        blockers = sorted(set([*blockers, *gate_policy.hard_blocker_metric_ids]))
        evidence = sorted(set([*evidence, *gate_policy.required_evidence]))
        approvers = sorted(set([*approvers, *gate_policy.required_approver_roles]))
        review_gates = sorted(set([*review_gates, *gate_policy.review_required_for]))

    evidence_inputs = dict(metric_evidence_requirements)
    contract_capture_categories = recognized_capture_categories(evidence)
    if contract_capture_categories:
        evidence_inputs["quality_contract"] = contract_capture_categories
    effective_evidence_requirements = resolve_effective_evidence_requirements(
        evaluation_scope,
        evidence_inputs,
    )
    resolved_scope = resolve_evaluation_scope(
        evaluation_scope, effective_evidence_requirements
    )
    promotion_reasons = scope_promotion_reasons(
        evaluation_scope, resolved_scope, evidence_inputs
    )
    for reason in promotion_reasons:
        if reason["source_id"] == "quality_contract":
            reason["source_type"] = "quality_contract"
            reason["source_id"] = f"{profile.profile_id}@{profile.version}"
    effective_evidence_requirements = resolve_effective_evidence_requirements(
        resolved_scope,
        evidence_inputs,
    )
    # Full execution resolves here as it does on the ungoverned path. Refusing it
    # only in a manifest left the two disagreeing about whether the depth exists
    # — readiness advertising it while the governed path, the only one that can
    # produce a release decision, could not resolve it at all. A contract naming
    # trace, retrieval, model usage or lifecycle evidence promotes to this scope,
    # so refusing here also made such a contract unresolvable. Its failure mode
    # is already safe: those categories report unknown, capture is partial, and
    # the verdict and gate are withheld.
    if resolved_scope in (EvaluationScope.TOOL_INTERACTIONS, EvaluationScope.FULL_EXECUTION) and target.target_type.value != "agent":
        raise ContractResolutionError(
            f"{resolved_scope.value} evidence scope requires an agent target"
        )

    resolved_requirements = _resolve_metric_requirements(
        metric_ids=metric_ids,
        scenario=scenario,
        contract_requirements=profile.metric_requirements,
        explicit_metric_ids=set(profile.metric_ids),
        hard_blocker_metric_ids=blockers,
    )
    requirement_by_metric = {
        item.metric_id: item.requirement for item in resolved_requirements
    }
    invalid_blockers = sorted(
        metric_id
        for metric_id in blockers
        if requirement_by_metric.get(metric_id) != MetricRequirement.REQUIRED
    )
    if invalid_blockers:
        raise ContractResolutionError(
            "hard-blocker metrics must be selected and required: "
            + ", ".join(invalid_blockers)
        )
    kpi_compositions = _resolve_kpi_compositions(
        metric_ids=metric_ids,
        requirement_by_metric=requirement_by_metric,
        scenario=scenario,
        configured_weights=profile.kpi_gate_weights,
        threshold_overrides=thresholds,
        hard_blocker_metric_ids=blockers,
    )
    diagnostic_only = not any(
        requirement == MetricRequirement.REQUIRED
        for requirement in requirement_by_metric.values()
    )

    payload = {
        "tenant_id": project.tenant_id,
        "project_id": project.project_id,
        "target_version_id": target.target_version_id,
        "profile": [profile.profile_id, profile.version],
        "gate_policy": [gate_policy.gate_policy_id, gate_policy.version] if gate_policy else None,
        "benchmark": [benchmark_package_id, benchmark_package_version, benchmark_family],
        "scenario": scenario.value,
        "metric_ids": sorted(metric_ids),
        "metric_requirements": [item.model_dump(mode="json") for item in resolved_requirements],
        "kpi_compositions": [item.model_dump(mode="json") for item in kpi_compositions],
        "diagnostic_only": diagnostic_only,
        "evaluator_refs": profile.evaluator_refs,
        "metric_pack_refs": profile.metric_pack_refs,
        "metric_definitions": metric_definitions or [],
        "metric_evidence_requirements": metric_evidence_requirements,
        "effective_evidence_requirements": effective_evidence_requirements,
        "exact_runtime_identity_required": profile.exact_runtime_identity_required,
        "thresholds": thresholds,
        "blockers": blockers,
        "evidence": evidence,
        "review_gates": [gate.value for gate in review_gates],
        "approvers": approvers,
        "judge_config": judge_config,
        "source_template_id": profile.source_template_id,
        "source_template_snapshot": profile.source_template_snapshot,
        "model_version": target.model_version,
        "prompt_version": target.prompt_version,
        "tool_versions": target.tool_versions,
        "requested_evaluation_scope": evaluation_scope.value,
        "resolved_evaluation_scope": resolved_scope.value,
        "scope_promotion_reasons": promotion_reasons,
    }
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    return ResolvedRunManifest(
        manifest_id=f"manifest-{digest[:20]}",
        manifest_hash=digest,
        tenant_id=project.tenant_id,
        project_id=project.project_id,
        target_version_id=target.target_version_id,
        target_id=target.target_id,
        target_name=target.name,
        target_version=target.version,
        target_endpoint=target.endpoint,
        target_type=target.target_type,
        environment=target.environment,
        quality_profile_id=profile.profile_id,
        quality_profile_version=profile.version,
        gate_policy_id=gate_policy.gate_policy_id if gate_policy else None,
        gate_policy_version=gate_policy.version if gate_policy else None,
        benchmark_package_id=benchmark_package_id,
        benchmark_package_version=benchmark_package_version,
        benchmark_family=benchmark_family,
        scenario=scenario,
        metric_ids=sorted(metric_ids),
        metric_requirements=resolved_requirements,
        kpi_compositions=kpi_compositions,
        diagnostic_only=diagnostic_only,
        evaluator_refs=profile.evaluator_refs,
        metric_pack_refs=profile.metric_pack_refs,
        metric_definitions=metric_definitions or [],
        metric_evidence_requirements=metric_evidence_requirements,
        effective_evidence_requirements=effective_evidence_requirements,
        exact_runtime_identity_required=profile.exact_runtime_identity_required,
        kpi_threshold_overrides=thresholds,
        hard_blocker_metric_ids=blockers,
        evidence_requirements=evidence,
        review_trigger_gates=review_gates,
        approver_roles=approvers,
        judge_config=judge_config,
        source_template_id=profile.source_template_id,
        source_template_snapshot=profile.source_template_snapshot,
        model_version=target.model_version,
        prompt_version=target.prompt_version,
        tool_versions=target.tool_versions,
        evaluation_scope=resolved_scope,
        requested_evaluation_scope=evaluation_scope,
        resolved_evaluation_scope=resolved_scope,
        scope_promotion_reasons=promotion_reasons,
        resolved_by=resolved_by,
    )


def _resolve_metric_requirements(
    *,
    metric_ids: list[str],
    scenario: Scenario,
    contract_requirements: dict[str, MetricRequirement],
    explicit_metric_ids: set[str],
    hard_blocker_metric_ids: Collection[str] = (),
    explicit_selection_pins_required: bool = True,
) -> list[ResolvedMetricRequirement]:
    """Resolve requirement once using contract, selection, and legacy precedence.

    ``explicit_selection_pins_required`` distinguishes the two meanings of an
    explicit selection. In a governed manifest the selection comes from an
    approved quality profile, so it is contract-pinned and immutable-required
    (``True``). In an ad-hoc dataset run the selection is a user choice the
    user can clear at any time, so it must never freeze a required/locked
    state on its own (``False``): the metric is required only when the legacy
    scenario defaults would require it anyway, and is otherwise OPTIONAL. The
    source stays ``EXPLICIT_SELECTION`` either way so consumers can tell a
    user choice from a contract requirement.

    ``hard_blocker_metric_ids`` is the contract's second way of saying a metric
    gates. Naming a metric a hard blocker is as explicit an elevation as writing
    it into ``metric_requirements``, so it outranks the catalog's
    diagnostic-by-default flag the same way. Without this, a contract could name
    a diagnostic metric as a blocker, be approved, and then fail to resolve at
    the last step — the catalog default quietly winning over the contract that
    was written to override it.
    """

    selected = set(metric_ids)
    blockers = set(hard_blocker_metric_ids)
    unknown = sorted(set(contract_requirements) - selected)
    if unknown:
        raise ContractResolutionError(
            "metric requirements reference unselected metric(s): " + ", ".join(unknown)
        )

    scenario_primary = set(SCENARIO_METRICS.get(scenario, []))
    cross_cutting = set(CROSS_CUTTING_METRICS)
    resolved: list[ResolvedMetricRequirement] = []
    for metric_id in sorted(selected):
        if metric_id in contract_requirements:
            requirement = contract_requirements[metric_id]
            source = MetricRequirementSource.QUALITY_CONTRACT
        elif metric_id.startswith("ops."):
            # Operations metrics are automatic diagnostics: optional / non-gating
            # unless a Quality Contract explicitly elevates them (handled above).
            requirement = MetricRequirement.OPTIONAL
            source = MetricRequirementSource.LEGACY_CROSS_CUTTING
        elif _catalog_diagnostic_default(metric_id) and metric_id not in blockers:
            requirement = MetricRequirement.OPTIONAL
            source = MetricRequirementSource.CATALOG_DIAGNOSTIC_DEFAULT
        elif metric_id in explicit_metric_ids:
            if explicit_selection_pins_required or metric_id in scenario_primary or metric_id in cross_cutting:
                requirement = MetricRequirement.REQUIRED
            else:
                requirement = MetricRequirement.OPTIONAL
            source = MetricRequirementSource.EXPLICIT_SELECTION
        elif metric_id in scenario_primary:
            requirement = MetricRequirement.REQUIRED
            source = MetricRequirementSource.LEGACY_SCENARIO_PRIMARY
        elif metric_id in cross_cutting:
            requirement = MetricRequirement.REQUIRED
            source = MetricRequirementSource.LEGACY_CROSS_CUTTING
        else:
            # Extension metrics cannot be legacy defaults. Their presence in the
            # resolved set therefore represents an explicit selection.
            requirement = (
                MetricRequirement.REQUIRED
                if explicit_selection_pins_required
                else MetricRequirement.OPTIONAL
            )
            source = MetricRequirementSource.EXPLICIT_SELECTION
        resolved.append(
            ResolvedMetricRequirement(
                metric_id=metric_id,
                requirement=requirement,
                source=source,
            )
        )
    return resolved


def _resolve_kpi_compositions(
    *,
    metric_ids: list[str],
    requirement_by_metric: dict[str, MetricRequirement],
    scenario: Scenario,
    configured_weights: dict[str, dict[str, float]],
    threshold_overrides: dict[str, dict[str, float]],
    hard_blocker_metric_ids: list[str],
) -> list[ResolvedKpiComposition]:
    """Pin gate constituents and weights so runtime never reweights them."""

    selected = set(metric_ids)
    applicable_kpis = [
        kpi
        for kpi in get_kpis_for_scenario(scenario)
        if selected.intersection(kpi.constituent_metrics)
    ]
    applicable_ids = {kpi.kpi_id for kpi in applicable_kpis}
    unexpected_kpis = sorted(set(configured_weights) - applicable_ids)
    if unexpected_kpis:
        raise ContractResolutionError(
            "gate composition references KPI(s) without selected constituents: "
            + ", ".join(unexpected_kpis)
        )

    blockers = set(hard_blocker_metric_ids)
    compositions: list[ResolvedKpiComposition] = []
    for kpi in applicable_kpis:
        selected_constituents = selected.intersection(kpi.constituent_metrics)
        required = sorted(
            metric_id
            for metric_id in selected_constituents
            if requirement_by_metric[metric_id] == MetricRequirement.REQUIRED
        )
        optional = sorted(selected_constituents - set(required))
        supplied = configured_weights.get(kpi.kpi_id)

        if supplied is not None:
            supplied_keys = set(supplied)
            if supplied_keys != set(required):
                raise ContractResolutionError(
                    f"{kpi.kpi_id} gate weights must contain exactly the required constituents: "
                    + ", ".join(required)
                )
            if not math.isclose(sum(supplied.values()), 1.0, rel_tol=0, abs_tol=1e-9):
                raise ContractResolutionError(
                    f"{kpi.kpi_id} required gate weights must sum to 1.0"
                )
            fixed_weights = dict(sorted(supplied.items()))
        elif required:
            legacy_total = sum(kpi.constituent_metrics[metric_id] for metric_id in required)
            fixed_weights = {
                metric_id: kpi.constituent_metrics[metric_id] / legacy_total
                for metric_id in required
            }
        else:
            fixed_weights = {}

        overrides = threshold_overrides.get(kpi.kpi_id, {})
        threshold_pass = overrides.get("pass", kpi.threshold_pass)
        threshold_warn = overrides.get("warn", kpi.threshold_warn)
        compositions.append(
            ResolvedKpiComposition(
                kpi_id=kpi.kpi_id,
                required_gate_constituents=required,
                optional_diagnostic_constituents=optional,
                fixed_gate_weights=fixed_weights,
                thresholds={
                    "pass": threshold_pass,
                    "warn": threshold_warn,
                    "fail": overrides.get("fail", threshold_warn),
                },
                hard_blocker_metric_ids=sorted(blockers.intersection(required)),
            )
        )

    covered_required = {
        metric_id
        for composition in compositions
        for metric_id in composition.required_gate_constituents
    }
    uncomposed_required = sorted(
        metric_id
        for metric_id, requirement in requirement_by_metric.items()
        if requirement == MetricRequirement.REQUIRED
        and metric_id not in covered_required
        # A hard blocker gates through the run-level veto instead of a KPI
        # composition, which is the only way the 17 catalogue metrics that
        # belong to no KPI (all content-safety, ops and nlp) can ever block.
        and metric_id not in blockers
    )
    if uncomposed_required:
        raise ContractResolutionError(
            "required metric(s) have no release-gate composition: "
            + ", ".join(uncomposed_required)
            + "; mark them optional/diagnostic or provide a valid KPI composition"
        )
    return compositions


def _catalog_diagnostic_default(metric_id: str) -> bool:
    """Return the immutable catalog default without classifying extensions."""

    from evalhub.evaluation.metrics import METRIC_CATALOG

    definition = METRIC_CATALOG.get(metric_id)
    return bool(definition and definition.catalog_diagnostic_default)
