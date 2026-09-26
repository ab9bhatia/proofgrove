"""Run traceability — experiment fingerprint + reproducibility lineage.

The experiment version id is a deterministic hash of the reproducibility-
relevant experiment inputs (dataset version, target, scenario, metric set,
judge config, prompt version). Two runs with the same fingerprint were scored
against the same contract and are directly comparable; a change to any input
yields a new fingerprint.
"""

import hashlib
import json
from importlib.metadata import PackageNotFoundError, version

from proofgrove.evaluation.enums import ProvenanceStatus, TargetIdentityStatus
from proofgrove.evaluation.models import EvaluationRow, ExperimentDefinition, RunLineage
from proofgrove.platform.contracts import (
    ResolvedRunManifest,
    ResolvedScoringConfiguration,
)
from proofgrove.settings import Settings
from proofgrove.version import PROMPT_VERSION, service_version

_SCORING_FRAMEWORKS = ("ragas", "deepeval")

# v3 compares evaluation controls without the target-dependent manifest identity.
# Recorded v1/v2 hashes remain untouched and incompatible with v3; consumers
# compare both the recorded hash and its version, never recomputing old rows.
COMPARISON_BASIS_VERSION = "v3"


def hash_system_prompt(system_prompt: str | None) -> str | None:
    """Digest a system prompt, or None when the run supplied none.

    Whitespace-stripped so a trailing newline does not read as a different
    prompt. Deliberately NOT part of the comparison basis: the prompt is the
    variable under test when comparing prompts, exactly as the target model is
    when comparing models.
    """

    text = (system_prompt or "").strip()
    if not text:
        return None
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def assess_target_identity(experiment: ExperimentDefinition) -> TargetIdentityStatus:
    """Compare trusted resolved and observed runtime identity assertions."""

    resolved = experiment.resolved_target_provenance or {}
    observed = experiment.observed_target_provenance or {}
    if resolved.get("status") == ProvenanceStatus.NOT_APPLICABLE.value:
        return TargetIdentityStatus.NOT_APPLICABLE

    observed_status = observed.get("status")
    if observed_status != ProvenanceStatus.ATTESTED.value:
        return TargetIdentityStatus.UNVERIFIED

    compared = False
    for key in ("identifier", "revision", "model"):
        expected_value = resolved.get(key)
        observed_value = observed.get(key)
        if expected_value is None or observed_value is None:
            continue
        compared = True
        if str(expected_value) != str(observed_value):
            return TargetIdentityStatus.MISMATCHED
    return TargetIdentityStatus.MATCHED if compared else TargetIdentityStatus.UNVERIFIED


def compute_experiment_version_id(
    experiment: ExperimentDefinition,
    active_metrics: list[str],
    prompt_version: str = PROMPT_VERSION,
    run_manifest_hash: str | None = None,
    run_configuration_hash: str | None = None,
    target_prompt_hash: str | None = None,
) -> str:
    """Return a stable ``exp-<hash>`` fingerprint for reproducibility.

    The target's system prompt belongs here and NOT in the comparison basis:
    the basis excludes it so two prompt variants can be compared, and this
    fingerprint includes it so they are not mistaken for the same run.
    """
    payload = {
        "dataset_version": experiment.dataset_version,
        "target_endpoint": experiment.target_endpoint,
        "scenario": experiment.scenario.value,
        "has_ground_truth": experiment.has_ground_truth,
        "judge_model": experiment.judge_model,
        "judge_temperature": experiment.judge_temperature,
        "safety_defect_tolerance": experiment.safety_defect_tolerance,
        "kpi_threshold_overrides": experiment.kpi_threshold_overrides,
        "metrics": sorted(active_metrics),
        # The evaluator's rubric version, which is a different axis from the
        # prompt the target was given.
        "prompt_version": prompt_version,
        "target_prompt_hash": target_prompt_hash,
        "project_id": experiment.project_id,
        "target_version_id": experiment.target_version_id,
        "target_version": experiment.target_version,
        "quality_profile_id": experiment.quality_profile_id,
        "quality_profile_version": experiment.quality_profile_version,
        "gate_policy_id": experiment.gate_policy_id,
        "gate_policy_version": experiment.gate_policy_version,
        "benchmark_package_id": experiment.benchmark_package_id,
        "benchmark_package_version": experiment.benchmark_package_version,
        "run_manifest_id": experiment.run_manifest_id,
        "run_manifest_hash": run_manifest_hash,
        "run_configuration_hash": run_configuration_hash,
        "evaluation_scope": experiment.evaluation_scope,
        "requested_target_provenance": experiment.requested_target_provenance,
        "resolved_target_provenance": experiment.resolved_target_provenance,
    }
    # Added only when a named-tool selection exists so historical fingerprints
    # (computed before the selected-tools level existed) remain stable.
    if experiment.selected_tool_ids is not None:
        payload["selected_tool_ids"] = sorted(experiment.selected_tool_ids)
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    return f"exp-{digest[:16]}"


def _comparison_basis_cases(rows: list[EvaluationRow]) -> list[dict]:
    return [
        {
            "row_id": row.row_id,
            "expected_response": row.expected_response,
            "expected_data": row.expected_data,
            "expected_tools": row.expected_tools,
        }
        for row in rows
    ]


def compute_comparison_basis_hash_v1(
    experiment: ExperimentDefinition,
    rows: list[EvaluationRow],
    active_metrics: list[str],
    *,
    manifest: ResolvedRunManifest | None = None,
    scoring_configuration: ResolvedScoringConfiguration | None = None,
) -> str:
    """Preserved v1 basis algorithm — kept byte-stable for historical runs.

    Historical runs recorded their basis with this algorithm, which omits the
    evaluator references and the judge/model configuration. It must never
    change: old hashes are read back as-is and never recomputed. New runs use
    :func:`compute_comparison_basis_hash` (v3) instead.
    """

    contract = manifest or scoring_configuration
    payload = {
        "dataset_version": experiment.dataset_version,
        "cases": _comparison_basis_cases(rows),
        "metrics": sorted(active_metrics),
        "metric_definitions": getattr(contract, "metric_definitions", []) if contract else [],
        "metric_requirements": [
            item.model_dump(mode="json")
            for item in getattr(contract, "metric_requirements", [])
        ],
        "kpi_compositions": [
            item.model_dump(mode="json")
            for item in getattr(contract, "kpi_compositions", [])
        ],
        "quality_profile": (
            [manifest.quality_profile_id, manifest.quality_profile_version]
            if manifest
            else None
        ),
        "evaluation_scope": (
            getattr(contract, "resolved_evaluation_scope", None)
            or getattr(contract, "evaluation_scope", experiment.evaluation_scope)
        ),
        "evaluator_prompt_version": PROMPT_VERSION,
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode()
    ).hexdigest()


def compute_comparison_basis_hash(
    experiment: ExperimentDefinition,
    rows: list[EvaluationRow],
    active_metrics: list[str],
    *,
    manifest: ResolvedRunManifest | None = None,
    scoring_configuration: ResolvedScoringConfiguration | None = None,
    settings: Settings | None = None,
) -> str:
    """Hash evaluation controls for fair comparison (basis ``v3``).

    Target model, prompt, revision, endpoint and tool versions are variables
    under test. The full manifest hash includes them, so compare its resolved
    controls instead. Full identities remain in the reproducibility fingerprint
    and lineage. Historical basis hashes are never recalculated.
    """

    contract = manifest or scoring_configuration
    judge_model = experiment.judge_model or (
        getattr(settings, "judge_model", None) if settings else None
    )
    payload = {
        "basis_version": COMPARISON_BASIS_VERSION,
        "dataset_version": experiment.dataset_version,
        "cases": _comparison_basis_cases(rows),
        "metrics": sorted(active_metrics),
        "metric_definitions": getattr(contract, "metric_definitions", []) if contract else [],
        "metric_requirements": [
            item.model_dump(mode="json")
            for item in getattr(contract, "metric_requirements", [])
        ]
        if contract
        else [],
        "kpi_compositions": [
            item.model_dump(mode="json")
            for item in getattr(contract, "kpi_compositions", [])
        ]
        if contract
        else [],
        "quality_profile": (
            [
                getattr(manifest, "quality_profile_id", None),
                getattr(manifest, "quality_profile_version", None),
            ]
            if manifest
            else None
        ),
        "resolved_scope": (
            getattr(contract, "resolved_evaluation_scope", None)
            or getattr(contract, "evaluation_scope", experiment.evaluation_scope)
        ),
        "evaluator_prompt_version": PROMPT_VERSION,
        # Evaluator and judge controls are independent of the target under test.
        "evaluators": getattr(contract, "evaluator_refs", {}) if contract else {},
        "judge": {
            "model": judge_model,
            "temperature": experiment.judge_temperature,
            "provider": getattr(settings, "judge_provider", None) if settings else None,
            "mode": getattr(settings, "judge_mode", None) if settings else None,
            "max_tokens": getattr(settings, "judge_max_tokens", None) if settings else None,
            "use_frameworks": (
                getattr(settings, "judge_use_frameworks", None) if settings else None
            ),
            "contract_config": getattr(contract, "judge_config", {}) if contract else {},
        },
        "contract_identity": {
            "manifest_controls": manifest.model_dump(
                mode="json",
                exclude={
                    "manifest_id", "manifest_hash", "resolved_at", "resolved_by",
                    "target_version_id", "target_id", "target_name", "target_version",
                    "target_endpoint", "target_type", "environment",
                    "model_version", "prompt_version", "tool_versions",
                },
            ) if manifest else None,
            "configuration_id": (
                getattr(scoring_configuration, "configuration_id", None)
                if scoring_configuration
                else None
            ),
            "configuration_hash": (
                getattr(scoring_configuration, "configuration_hash", None)
                if scoring_configuration
                else None
            ),
        },
    }
    # Named-tool selection is a control: None (whole layer) differs from [],
    # while selection ordering does not change comparability.
    if experiment.selected_tool_ids is not None:
        payload["selected_tool_ids"] = sorted(experiment.selected_tool_ids)
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode()
    ).hexdigest()


def framework_versions() -> dict[str, str | None]:
    """Installed versions of the optional scoring frameworks (or ``None``)."""
    versions: dict[str, str | None] = {}
    for pkg in _SCORING_FRAMEWORKS:
        try:
            versions[pkg] = version(pkg)
        except PackageNotFoundError:
            versions[pkg] = None
    return versions


def build_lineage(
    experiment: ExperimentDefinition,
    settings: Settings,
    experiment_version_id: str,
    prompt_version: str = PROMPT_VERSION,
    manifest: ResolvedRunManifest | None = None,
    scoring_configuration: ResolvedScoringConfiguration | None = None,
    comparison_basis_hash: str | None = None,
    assignment_id: str | None = None,
    assignment_version: str | None = None,
) -> RunLineage:
    """Capture the reproducibility snapshot for a run."""
    return RunLineage(
        service_version=service_version(),
        prompt_version=prompt_version,
        experiment_version_id=experiment_version_id,
        comparison_basis_hash=comparison_basis_hash,
        comparison_basis_version=(
            COMPARISON_BASIS_VERSION if comparison_basis_hash else None
        ),
        judge_mode=settings.judge_mode,
        judge_provider=settings.judge_provider,
        judge_model=experiment.judge_model or settings.judge_model,
        judge_temperature=experiment.judge_temperature,
        judge_max_tokens=settings.judge_max_tokens,
        use_frameworks=settings.judge_use_frameworks,
        framework_versions=framework_versions(),
        evaluation_scope=experiment.evaluation_scope,
        requested_evaluation_scope=(
            manifest.requested_evaluation_scope
            if manifest
            else scoring_configuration.requested_evaluation_scope
            if scoring_configuration
            else experiment.requested_evaluation_scope
        ) or experiment.evaluation_scope,
        resolved_evaluation_scope=(
            manifest.resolved_evaluation_scope
            if manifest
            else scoring_configuration.resolved_evaluation_scope
            if scoring_configuration
            else experiment.evaluation_scope
        ) or experiment.evaluation_scope,
        scope_promotion_reasons=(
            manifest.scope_promotion_reasons
            if manifest
            else scoring_configuration.scope_promotion_reasons
            if scoring_configuration
            else []
        ),
        selected_tool_ids=experiment.selected_tool_ids,
        run_manifest_id=manifest.manifest_id if manifest else experiment.run_manifest_id,
        run_manifest_hash=manifest.manifest_hash if manifest else None,
        assignment_id=assignment_id,
        assignment_version=assignment_version,
        run_configuration_id=(
            scoring_configuration.configuration_id
            if scoring_configuration
            else None
        ),
        run_configuration_hash=(
            scoring_configuration.configuration_hash
            if scoring_configuration
            else None
        ),
        metric_requirements=[
            item.model_dump(mode="json")
            for item in (
                manifest.metric_requirements
                if manifest
                else scoring_configuration.metric_requirements
                if scoring_configuration
                else []
            )
        ],
        kpi_compositions=[
            item.model_dump(mode="json")
            for item in (
                manifest.kpi_compositions
                if manifest
                else scoring_configuration.kpi_compositions
                if scoring_configuration
                else []
            )
        ],
        metric_evidence_requirements=(
            manifest.metric_evidence_requirements
            if manifest
            else scoring_configuration.metric_evidence_requirements
            if scoring_configuration
            else {}
        ),
        effective_evidence_requirements=(
            manifest.effective_evidence_requirements
            if manifest
            else scoring_configuration.effective_evidence_requirements
            if scoring_configuration
            else []
        ),
        review_trigger_gates=list(manifest.review_trigger_gates) if manifest else [],
        project_id=manifest.project_id if manifest else experiment.project_id,
        target_version_id=manifest.target_version_id if manifest else experiment.target_version_id,
        quality_profile_id=manifest.quality_profile_id if manifest else experiment.quality_profile_id,
        quality_profile_version=manifest.quality_profile_version if manifest else experiment.quality_profile_version,
        gate_policy_id=manifest.gate_policy_id if manifest else experiment.gate_policy_id,
        gate_policy_version=manifest.gate_policy_version if manifest else experiment.gate_policy_version,
        benchmark_package_id=manifest.benchmark_package_id if manifest else experiment.benchmark_package_id,
        benchmark_package_version=manifest.benchmark_package_version if manifest else experiment.benchmark_package_version,
        model_version=manifest.model_version if manifest else None,
        target_prompt_version=manifest.prompt_version if manifest else None,
        tool_versions=manifest.tool_versions if manifest else {},
        requested_target_provenance=experiment.requested_target_provenance,
        resolved_target_provenance=experiment.resolved_target_provenance,
        observed_target_provenance=experiment.observed_target_provenance,
        exact_runtime_identity_required=(
            manifest.exact_runtime_identity_required if manifest else False
        ),
        target_identity_status=assess_target_identity(experiment),
    )
