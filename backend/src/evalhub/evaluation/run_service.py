"""Execute a dataset evaluation run (shared by the async worker).

A run against a live agent does network I/O per row, so it is executed by the
background worker (evalhub.runs_worker) rather than in the request. This module
holds the actual work — fetch the golden dataset, build rows, invoke the agent
per row (when response_source=agent), hydrate scoring evidence from the OTEL
trace archive when it is enabled, score via the engine, and persist the
RunResult under the job's run_id — so the endpoint only enqueues a job.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
import uuid
from datetime import UTC, datetime

from fastapi.concurrency import run_in_threadpool

from evalhub.datasets.naming import dataset_version_label
from evalhub.datasets.registry import DatasetRegistryService
from evalhub.db.store import EvaluationStore
from evalhub.errors import EvaluationInputError
from evalhub.evaluation.adapters.dispatcher import build_judge
from evalhub.evaluation.dataset_bridge import records_to_rows
from evalhub.evaluation.engine import EvaluationEngine, validate_unique_example_ids
from evalhub.evaluation.enums import (
    EvaluationScope,
    EvidenceCaptureStatus,
    EvidenceReadiness,
    MetricRequirement,
    PreRunApplicability,
    RunStatus,
    RunType,
    Scenario,
    TriggerReason,
)
from evalhub.evaluation.labels import normalize_run_labels
from evalhub.evaluation.lineage import hash_system_prompt
from evalhub.evaluation.models import (
    EvaluationRow,
    EvidenceReadinessResult,
    ExperimentDefinition,
    ReadinessDetail,
    ToolCall,
)
from evalhub.evaluation.readiness import (
    ReadinessBlockedError,
    assess_evidence_readiness,
    classify_evidence_capture,
    observed_target_provenance,
)
from evalhub.evaluation.scenario_policy import resolve_scenario
from evalhub.evaluation.scenario_router import select_metrics
from evalhub.evaluation.target import AgentInvocationError, run_agent_target
from evalhub.evaluation.target.a2a_client import AgentOutputTooLargeError
from evalhub.evaluation.target.external import EXTERNAL_PREFIX, resolve_external_target
from evalhub.evaluation.target.llm_runner import LlmInvocationError, run_llm_target
from evalhub.evaluation.trace_archive import tenant_from_namespace
from evalhub.evaluation.trace_hydrator import (
    apply_a2a_capture_scoring,
    hydrate_row_from_archive,
    incomplete_archive_mode,
    row_awaiting_completed_trace,
    uses_a2a_capture_for_scoring,
)
from evalhub.platform.contracts import ResolvedRunManifest, ResolvedScoringConfiguration
from evalhub.platform.quality_contract_templates import QUALITY_CONTRACT_TEMPLATE_BY_ID
from evalhub.settings import settings

logger = logging.getLogger(__name__)

# Returned by execute_dataset_run / execute_deferred_telemetry_score when the
# target has been invoked but scoring waits for a completed archived trajectory.
DATASET_RUN_DEFERRED = "deferred"
TELEMETRY_SCORE_SNAPSHOT_KEY = "telemetry_score_snapshot"
TRACE_EVIDENCE_FINGERPRINT_KEY = "trace_evidence_fingerprint"

# Agent apologies / recovery prompts that mean the target failed to produce a
# usable answer (tool/MCP/retrieval outage), not a gradeable evaluation output.
_TECHNICAL_FAILURE_RESPONSE = re.compile(
    r"(?is)"
    r"("
    r"i\s+encountered\s+an\s+error"
    r"|i\s+(?:am|'m)\s+(?:unable|sorry).{0,80}(?:retrieve|fetch|access|get)"
    r"|(?:unable|failed)\s+to\s+(?:retrieve|fetch|access|obtain|get)\b"
    r"|error\s+while\s+(?:trying|attempting)\s+to\s+(?:retrieve|fetch|access|get)"
    r"|could(?:\s*not|n'?t)\s+(?:retrieve|fetch|access|get)\b"
    r"|something\s+went\s+wrong\s+while\s+(?:retriev|fetch|access|try|attempt)"
    r"|would\s+you\s+like\s+me\s+to\s+(?:attempt|try).{0,40}again"
    r")"
)


async def execute_dataset_run(
    *,
    run_id: str,
    dataset_name: str,
    tenant_id: str | None = None,
    response_source: str,
    agent: str | None,
    row_count: int | None,
    judge_model: str | None,
    target_endpoint: str | None = None,
    target_model: str | None = None,
    system_prompt: str | None = None,
    prompt_version_ref: str | None = None,
    active_metrics: list[str] | None = None,
    resolved_active_metrics: list[str] | None = None,
    resolved_scoring_configuration: dict | ResolvedScoringConfiguration | None = None,
    quality_contract_ids: list[str] | None = None,
    enable_llm_judge: bool = True,
    parallel_requests: int = 5,
    run_human_review: bool = True,
    store: EvaluationStore,
    engine: EvaluationEngine,
    registry: DatasetRegistryService,
    trigger_reason: TriggerReason = TriggerReason.MANUAL,
    correlation_id: str | None = None,
    label: str | None = None,
    labels: list[str] | None = None,
    evaluation_name: str | None = None,
    evaluation_scope: EvaluationScope = EvaluationScope.FINAL_RESPONSE,
    evidence_readiness_snapshot: dict | None = None,
    requested_provenance: dict | None = None,
    project_id: str | None = None,
    run_manifest_id: str | None = None,
    assignment_id: str | None = None,
    assignment_version: str | None = None,
) -> str | None:
    """Run an evaluation of ``dataset_name`` and persist the result under ``run_id``.

    Returns ``DATASET_RUN_DEFERRED`` when the target has been invoked but the
    archived trajectory is not complete yet; the worker must not mark the job
    completed. Returns ``None`` when the run is fully scored and persisted.

    Raises on failure (no dataset/records, agent invocation errors, etc.) so the
    worker can mark the job FAILED with the error.
    """

    # tenant_id is the run job's own tenant (see RunJobORM.tenant_id / the
    # worker's job.tenant_id); None on a legacy job predating tenant
    # attribution, in which case the store falls back to its own dataset_name
    # lookup -- see _get_dataset_row in postgres_store.py.
    info = await run_in_threadpool(registry.get_dataset, dataset_name, tenant_id)
    records = await run_in_threadpool(registry.get_records, dataset_name, tenant_id)
    if not records:
        raise EvaluationInputError(f"Dataset '{dataset_name}' has no records.")
    if row_count:
        # Apply the row limit before readiness so readiness analyzes exactly the
        # rows that will execute — a record outside the limit must neither block
        # nor qualify the run.
        records = records[:row_count]
    snapshot = evidence_readiness_snapshot or {}
    # Selected-tools level: the launch readiness snapshot is the carrier of the
    # named-tool selection into the worker (``None`` = whole tool layer).
    raw_selection = snapshot.get("selected_tool_ids")
    selected_tool_ids: list[str] | None = [str(tool) for tool in raw_selection] if isinstance(raw_selection, list) else None

    scoring_configuration = (
        ResolvedScoringConfiguration.model_validate(resolved_scoring_configuration)
        if resolved_scoring_configuration
        else None
    )
    manifest = None
    if run_manifest_id:
        manifest = await store.get_run_manifest(run_manifest_id, getattr(info, "tenant_id", None))
        if manifest is None:
            raise EvaluationInputError(f"Run manifest '{run_manifest_id}' was not found.")
        scoring_configuration = None
    # Precedence lives in one place (evaluation.scenario_policy): resolved
    # configuration > run wiring > target declaration.
    scenario = resolve_scenario(
        configured=(
            manifest.scenario
            if manifest is not None
            else scoring_configuration.scenario
            if scoring_configuration
            else None
        ),
        response_source=response_source,
        # Without this an agent run falls through to the default scenario and is
        # recorded as an LLM evaluation: the wrong label on every listing, and
        # the wrong default metric set, since the agent battery is selected by
        # scenario. ``resolve_scenario`` has always mapped the target type; no
        # caller passed it.
        target_type=response_source,
    )
    if scoring_configuration is not None:
        evaluation_scope = scoring_configuration.evaluation_scope
    elif manifest is not None and manifest.evaluation_scope is not None:
        evaluation_scope = manifest.evaluation_scope
    resolved_metrics = (
        list(manifest.metric_ids)
        if manifest is not None
        else list(scoring_configuration.metric_ids)
        if scoring_configuration is not None
        else list(resolved_active_metrics)
        if resolved_active_metrics is not None
        else resolve_active_metrics(
            active_metrics,
            quality_contract_ids,
            scenario=scenario,
            has_ground_truth=True,
        )
    )
    readiness = await assess_evidence_readiness(
        response_source=response_source,
        evaluation_scope=evaluation_scope,
        requested_evaluation_scope=(
            manifest.requested_evaluation_scope
            if manifest is not None
            else scoring_configuration.requested_evaluation_scope
            if scoring_configuration is not None
            else EvaluationScope((evidence_readiness_snapshot or {}).get("requested_evaluation_scope", evaluation_scope.value))
        ),
        scope_promotion_reasons=(
            manifest.scope_promotion_reasons
            if manifest is not None
            else scoring_configuration.scope_promotion_reasons
            if scoring_configuration is not None
            else (evidence_readiness_snapshot or {}).get("scope_promotion_reasons", [])
        ),
        agent=agent,
        target_model=target_model,
        target_endpoint=target_endpoint,
        judge_model=judge_model,
        enable_llm_judge=enable_llm_judge,
        resolved_metric_definitions=manifest.metric_definitions if manifest else scoring_configuration.metric_definitions if scoring_configuration else None,
        records=records,
        active_metric_ids=resolved_metrics,
        scenario=scenario,
        settings=settings,
        # Drift is anchored on the provenance resolved at launch (which carries
        # the agent revision) — the requested provenance never has one.
        expected_provenance=(snapshot.get("resolved_provenance") or requested_provenance),
        resolved_metric_evidence_requirements=(
            manifest.metric_evidence_requirements
            if manifest is not None
            else scoring_configuration.metric_evidence_requirements
            if scoring_configuration is not None
            else (evidence_readiness_snapshot or {}).get("metric_evidence_requirements")
            if evidence_readiness_snapshot is not None
            else None
        ),
        resolved_evidence_requirements=(
            manifest.effective_evidence_requirements
            if manifest is not None
            else scoring_configuration.effective_evidence_requirements
            if scoring_configuration is not None
            else (evidence_readiness_snapshot or {}).get("effective_evidence_requirements")
            if evidence_readiness_snapshot is not None
            else None
        ),
        resolved_metric_requirements=(
            [item.model_dump(mode="json") for item in manifest.metric_requirements]
            if manifest is not None
            else [item.model_dump(mode="json") for item in scoring_configuration.metric_requirements]
            if scoring_configuration is not None
            else snapshot.get("metric_requirements") or None
        ),
        selected_tool_ids=selected_tool_ids,
    )
    if readiness.status != EvidenceReadiness.READY:
        raise ReadinessBlockedError(readiness)

    pre_run_not_applicable = _frozen_not_applicable_metrics(
        readiness=readiness,
        snapshot=snapshot,
        scoring_configuration=scoring_configuration,
    )

    rows = records_to_rows(records, response_source=response_source)
    validate_unique_example_ids(rows)

    # Product tenant ids are `tenant-<slug>`; MinIO partitions are `<slug>`.
    product_tenant_id = getattr(info, "tenant_id", None)
    archive_tenant_id = tenant_from_namespace(product_tenant_id) if product_tenant_id else None

    if response_source == "agent":
        if not agent:
            raise EvaluationInputError("response_source='agent' requires an agent reference.")
        await _run_agent_rows(
            rows,
            agent_ref=agent,
            parallel_requests=parallel_requests,
            selected_tool_ids=selected_tool_ids,
            tenant_id=archive_tenant_id,
            evaluation_scope=evaluation_scope,
            trace_attributes=_target_trace_attributes(
                run_id=run_id,
                tenant_id=archive_tenant_id,
                app_id=info.product_id,
                manifest=manifest,
            ),
        )
    elif response_source == "llm":
        if not target_model:
            raise EvaluationInputError("response_source='llm' requires target_model (LLM Catalog model id).")
        await _run_llm_rows(
            rows,
            target_endpoint=target_endpoint,
            target_model=target_model,
            system_prompt=system_prompt,
            parallel_requests=parallel_requests,
            tenant_id=archive_tenant_id,
            evaluation_scope=evaluation_scope,
            trace_attributes=_target_trace_attributes(
                run_id=run_id,
                tenant_id=archive_tenant_id,
                app_id=info.product_id,
                manifest=manifest,
            ),
        )

    observed_provenance = observed_target_provenance(
        response_source=response_source,
        rows=rows,
        resolved_provenance=readiness.resolved_provenance,
    )

    trimmed_label, normalized_labels = normalize_run_labels(label=label, labels=labels)
    trimmed_evaluation_name = (evaluation_name or "").strip() or None
    experiment_name = trimmed_evaluation_name or f"{dataset_name} ({response_source})"
    tags: dict[str, str] = {}
    if trimmed_label:
        tags["label"] = trimmed_label
    if trimmed_evaluation_name:
        tags["evaluation_name"] = trimmed_evaluation_name
    resolved_target_endpoint = agent if response_source == "agent" else target_endpoint or f"golden-dataset:{dataset_name}"
    # A named evaluation groups its compatible reruns under one stable
    # experiment so run numbering increments (Run 1, Run 2, …) instead of
    # minting a fresh single-run experiment per launch. The identity is derived
    # deterministically from the compatibility key; any incompatible
    # configuration (different dataset/target/scenario) yields a different id
    # and therefore its own experiment — runs are never silently mixed.
    experiment_id = (
        stable_experiment_id(
            tenant_id=getattr(info, "tenant_id", None),
            evaluation_name=trimmed_evaluation_name,
            dataset_name=dataset_name,
            response_source=response_source,
            target_endpoint=resolved_target_endpoint,
            target_model=target_model,
            scenario=scenario,
        )
        if trimmed_evaluation_name
        else None
    )
    experiment = ExperimentDefinition(
        experiment_id=experiment_id,
        name=experiment_name,
        dataset_version=dataset_version_label(dataset_name, info.version_number),
        target_endpoint=resolved_target_endpoint,
        scenario=scenario,
        domain=info.product_id,
        target_version=target_model,
        judge_model=judge_model or settings.judge_model,
        has_ground_truth=True,
        row_count=len(rows),
        tenant_id=getattr(info, "tenant_id", None),
        evaluation_scope=evaluation_scope,
        selected_tool_ids=selected_tool_ids,
        requested_evaluation_scope=(
            manifest.requested_evaluation_scope
            if manifest is not None
            else scoring_configuration.requested_evaluation_scope
            if scoring_configuration is not None
            else readiness.requested_evaluation_scope
        ),
        requested_target_provenance=((evidence_readiness_snapshot or {}).get("requested_provenance") or readiness.requested_provenance),
        resolved_target_provenance=readiness.resolved_provenance,
        observed_target_provenance=observed_provenance,
        tags=tags,
        project_id=project_id,
        run_manifest_id=manifest.manifest_id if manifest is not None else None,
    )
    if any(row_awaiting_completed_trace(row) for row in rows):
        telemetry_snapshot = _telemetry_score_snapshot(
            rows=rows,
            experiment=experiment,
            response_source=response_source,
            resolved_metrics=resolved_metrics,
            scoring_configuration=scoring_configuration,
            pre_run_not_applicable=pre_run_not_applicable,
            readiness=readiness,
            enable_llm_judge=enable_llm_judge,
            run_human_review=run_human_review,
            trigger_reason=trigger_reason,
            correlation_id=correlation_id or run_id,
            label=trimmed_label,
            labels=normalized_labels,
            selected_tool_ids=selected_tool_ids,
            archive_tenant_id=archive_tenant_id,
            system_prompt_hash=hash_system_prompt(system_prompt),
            prompt_version_ref=prompt_version_ref,
            manifest=manifest,
            assignment_id=assignment_id,
            assignment_version=assignment_version,
        )
        await store.park_run_job_waiting_for_telemetry(
            run_id,
            telemetry_snapshot,
        )
        # Publish the evidence-independent portion now. The parked snapshot
        # above retains the original correlation and A2A capture for later
        # same-ID telemetry enrichment; the public result never pretends
        # partial tools are the complete trajectory.
        partial_rows = [row.model_copy(deep=True) for row in rows]
        for row in partial_rows:
            if row_awaiting_completed_trace(row):
                reason = str((row.output_data or {}).get("archive_pending_reason") or "incomplete_trajectory")
                apply_a2a_capture_scoring(row, reason=reason)
        await _score_and_persist_run(
            run_id=run_id,
            rows=partial_rows,
            experiment=experiment,
            response_source=response_source,
            resolved_metrics=resolved_metrics,
            scoring_configuration=scoring_configuration,
            pre_run_not_applicable=pre_run_not_applicable,
            readiness=readiness,
            enable_llm_judge=enable_llm_judge,
            run_human_review=run_human_review,
            trigger_reason=trigger_reason,
            correlation_id=correlation_id,
            label=trimmed_label,
            labels=normalized_labels,
            store=store,
            engine=engine,
            run_status=RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE,
            finalize_job=False,
            system_prompt_hash=hash_system_prompt(system_prompt),
            prompt_version_ref=prompt_version_ref,
            manifest=manifest,
            assignment_id=assignment_id,
            assignment_version=assignment_version,
        )
        logger.info(
            "eval-hub: run %s published response-safe scores with partial evidence; trace-dependent scoring continues in the background",
            run_id,
        )
        return DATASET_RUN_DEFERRED
    if (
        settings.trace_archive_enabled
        and not uses_a2a_capture_for_scoring(experiment.evaluation_scope)
        and _row_trace_fingerprints(rows)
    ):
        telemetry_snapshot = _telemetry_score_snapshot(
            rows=rows,
            experiment=experiment,
            response_source=response_source,
            resolved_metrics=resolved_metrics,
            scoring_configuration=scoring_configuration,
            pre_run_not_applicable=pre_run_not_applicable,
            readiness=readiness,
            enable_llm_judge=enable_llm_judge,
            run_human_review=run_human_review,
            trigger_reason=trigger_reason,
            correlation_id=correlation_id or run_id,
            label=trimmed_label,
            labels=normalized_labels,
            selected_tool_ids=selected_tool_ids,
            archive_tenant_id=archive_tenant_id,
            system_prompt_hash=hash_system_prompt(system_prompt),
            prompt_version_ref=prompt_version_ref,
            manifest=manifest,
            assignment_id=assignment_id,
            assignment_version=assignment_version,
        )
        telemetry_snapshot["watch_completed_run"] = True
        await store.update_run_job_telemetry_watch(run_id, telemetry_snapshot)
    await _score_and_persist_run(
        run_id=run_id,
        rows=rows,
        experiment=experiment,
        response_source=response_source,
        resolved_metrics=resolved_metrics,
        scoring_configuration=scoring_configuration,
        pre_run_not_applicable=pre_run_not_applicable,
        readiness=readiness,
        enable_llm_judge=enable_llm_judge,
        run_human_review=run_human_review,
        trigger_reason=trigger_reason,
        correlation_id=correlation_id,
        label=trimmed_label,
        labels=normalized_labels,
        store=store,
        engine=engine,
        system_prompt_hash=hash_system_prompt(system_prompt),
        prompt_version_ref=prompt_version_ref,
        manifest=manifest,
        assignment_id=assignment_id,
        assignment_version=assignment_version,
    )
    return None


def stable_experiment_id(
    *,
    tenant_id: str | None,
    evaluation_name: str,
    dataset_name: str,
    response_source: str,
    target_endpoint: str,
    target_model: str | None,
    scenario: Scenario,
) -> str:
    """Deterministic experiment identity for compatible reruns of a named evaluation.

    Rerunning the same evaluation name against the same tenant + dataset +
    target (compatible configuration) resolves to the same id, so the new run
    attaches to the existing experiment and its run number increments. Any
    component of the key changing (dataset, target, scenario, …) changes the
    id, preserving experiment immutability: incompatible configurations always
    get a new experiment.
    """

    key = "\n".join(
        [
            tenant_id or "",
            evaluation_name,
            dataset_name,
            response_source,
            target_endpoint,
            target_model or "",
            scenario.value,
        ]
    )
    return "exp-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:20]


def _frozen_not_applicable_metrics(
    *,
    readiness: EvidenceReadinessResult,
    snapshot: dict,
    scoring_configuration: ResolvedScoringConfiguration | None,
) -> dict[str, str]:
    """Freeze pre-run applicability into the metric set the engine scores.

    The launch-time readiness snapshot (persisted in the job params) is the
    authoritative decision for this run: metrics it classified
    ``known_not_applicable`` stay excluded from scoring even if inputs drifted
    since. When worker revalidation *newly* classifies a metric as N/A, the run
    is blocked if that metric is required (raises ``ReadinessBlockedError``);
    otherwise the metric is excluded too — it must not be scored against
    evidence that cannot apply. Reasons are carried onto the per-row results.
    """

    revalidated_not_applicable = {item.metric_id: item.reason or "Classified as not applicable before the run." for item in readiness.metric_applicability if item.applicability == PreRunApplicability.KNOWN_NOT_APPLICABLE}
    launch_applicability = {str(item.get("metric_id")): item for item in snapshot.get("metric_applicability") or [] if isinstance(item, dict) and item.get("metric_id")}
    launch_not_applicable = {metric_id: str(item.get("reason") or "Classified as not applicable at launch.") for metric_id, item in launch_applicability.items() if item.get("applicability") == PreRunApplicability.KNOWN_NOT_APPLICABLE.value}

    if launch_applicability:
        required_ids = _required_metric_ids(
            scoring_configuration=scoring_configuration,
            snapshot_metric_requirements=snapshot.get("metric_requirements"),
            assessed_metric_ids=[item.metric_id for item in readiness.metric_applicability],
        )
        newly_not_applicable = sorted(metric_id for metric_id in revalidated_not_applicable if metric_id in required_ids and metric_id not in launch_not_applicable)
        if newly_not_applicable:
            blocked = readiness.model_copy(
                update={
                    "status": EvidenceReadiness.BLOCKED,
                    "details": [
                        ReadinessDetail(
                            code="required_metric_became_not_applicable",
                            message=("Required metric(s) became not applicable between launch and execution: " + ", ".join(newly_not_applicable) + ". The run is blocked instead of being scored against a different metric set."),
                        )
                    ],
                }
            )
            raise ReadinessBlockedError(blocked)

    # Launch decision wins for metrics classified at both points.
    return {**revalidated_not_applicable, **launch_not_applicable}


def _required_metric_ids(
    *,
    scoring_configuration: ResolvedScoringConfiguration | None,
    snapshot_metric_requirements: list[dict] | None,
    assessed_metric_ids: list[str],
) -> set[str]:
    """Return the metric ids whose requirement was resolved REQUIRED at launch."""

    if scoring_configuration is not None and scoring_configuration.metric_requirements:
        return {item.metric_id for item in scoring_configuration.metric_requirements if item.requirement == MetricRequirement.REQUIRED}
    if snapshot_metric_requirements:
        return {str(item.get("metric_id")) for item in snapshot_metric_requirements if str(item.get("requirement")) == MetricRequirement.REQUIRED.value}
    # Legacy jobs without frozen requirements: mirror the engine's default rule
    # (operational ops.* metrics never gate; everything else does).
    return {metric_id for metric_id in assessed_metric_ids if not metric_id.startswith("ops.")}


async def execute_rescore(
    *,
    run_id: str,
    source_run_id: str,
    active_metrics: list[str],
    judge_model: str | None,
    created_by: str,
    source_evidence_snapshot: str,
    store: EvaluationStore,
    engine: EvaluationEngine,
) -> None:
    """Re-evaluate persisted evidence without invoking the original target."""

    # No tenant_id here: this is worker-side rescoring keyed by a durable
    # source_run_id, not an HTTP route call -- see runs_worker.py's module
    # docstring for the general worker-vs-route tenant-scoping rule.
    source = await store.get_run(source_run_id)
    if not source:
        raise EvaluationInputError(f"Source run {source_run_id} was not found")
    rows = await store.load_run_evidence_rows(source_run_id)
    if not rows:
        raise EvaluationInputError("Source run has no immutable evidence snapshot to rescore")

    experiment = source.experiment.model_copy(deep=True)
    if judge_model:
        experiment.judge_model = judge_model
    # The experiment row does not persist the named-tool selection; the source
    # run's lineage does. Restore it so a rescore keeps the historical scoping.
    if experiment.selected_tool_ids is None and source.lineage is not None:
        experiment.selected_tool_ids = source.lineage.selected_tool_ids
    experiment.tags = {
        **(experiment.tags or {}),
        "rescore_source_run_id": source_run_id,
        "run_classification": "diagnostic_only",
    }
    result = await run_in_threadpool(
        engine.execute,
        experiment,
        rows,
        run_id,
        TriggerReason.MANUAL,
        run_id,
        0,
        None,
        active_metrics,
    )
    # Rescoring can show observed metric values but can never create new release
    # evidence because the target was not invoked and the evidence snapshot is
    # inherited from another run.
    result.diagnostic_only = True
    result.verdict_status = None
    result.overall_gate = None
    result.run_type = RunType.AD_HOC
    result.created_by = created_by
    for kpi in result.kpi_results:
        if kpi.observed_score is None:
            kpi.observed_score = kpi.composite_score
        kpi.composite_score = None
        kpi.gate_result = None
    if result.lineage:
        result.lineage.source_run_id = source_run_id
        result.lineage.source_evidence_snapshot = source_evidence_snapshot
        result.lineage.rescore_configuration = {
            "metric_ids": active_metrics,
            "judge_model": experiment.judge_model,
            "target_invoked": False,
        }
    await store.save_run(result, rows)


def _telemetry_score_snapshot(
    *,
    rows: list[EvaluationRow],
    experiment: ExperimentDefinition,
    response_source: str,
    resolved_metrics: list[str] | None,
    scoring_configuration: ResolvedScoringConfiguration | None,
    pre_run_not_applicable: dict[str, str],
    readiness: EvidenceReadinessResult,
    enable_llm_judge: bool,
    run_human_review: bool,
    trigger_reason: TriggerReason,
    correlation_id: str,
    label: str | None,
    labels: list[str],
    selected_tool_ids: list[str] | None,
    archive_tenant_id: str | None,
    system_prompt_hash: str | None,
    prompt_version_ref: str | None,
    manifest: ResolvedRunManifest | None = None,
    assignment_id: str | None = None,
    assignment_version: str | None = None,
) -> dict:
    return {
        "rows": [row.model_dump(mode="json") for row in rows],
        "experiment": experiment.model_dump(mode="json"),
        "response_source": response_source,
        "resolved_metrics": list(resolved_metrics) if resolved_metrics is not None else None,
        "scoring_configuration": (
            None
            if manifest is not None
            else (scoring_configuration.model_dump(mode="json") if scoring_configuration else None)
        ),
        "manifest": manifest.model_dump(mode="json") if manifest is not None else None,
        "assignment_id": assignment_id,
        "assignment_version": assignment_version,
        "pre_run_not_applicable": dict(pre_run_not_applicable),
        "readiness": readiness.model_dump(mode="json"),
        "enable_llm_judge": enable_llm_judge,
        "run_human_review": run_human_review,
        "trigger_reason": trigger_reason.value,
        "correlation_id": correlation_id,
        "label": label,
        "labels": labels,
        "selected_tool_ids": selected_tool_ids,
        "archive_tenant_id": archive_tenant_id,
        "system_prompt_hash": system_prompt_hash,
        "prompt_version_ref": prompt_version_ref,
        "deferred_since": datetime.now(UTC).isoformat(),
    }


def _telemetry_grace_expired(snapshot: dict) -> bool:
    raw = snapshot.get("deferred_since")
    if not raw:
        return True
    try:
        started = datetime.fromisoformat(str(raw))
    except ValueError:
        return True
    if started.tzinfo is None:
        started = started.replace(tzinfo=UTC)
    elapsed = (datetime.now(UTC) - started).total_seconds()
    return elapsed >= settings.trace_archive_score_grace_seconds


def _telemetry_enrichment_expired(snapshot: dict) -> bool:
    raw = snapshot.get("deferred_since")
    if not raw:
        return True
    try:
        started = datetime.fromisoformat(str(raw))
    except ValueError:
        return True
    if started.tzinfo is None:
        started = started.replace(tzinfo=UTC)
    elapsed = (datetime.now(UTC) - started).total_seconds()
    return elapsed >= settings.trace_archive_late_enrichment_seconds


async def _score_and_persist_run(
    *,
    run_id: str,
    rows: list[EvaluationRow],
    experiment: ExperimentDefinition,
    response_source: str,
    resolved_metrics: list[str] | None,
    scoring_configuration: ResolvedScoringConfiguration | None,
    pre_run_not_applicable: dict[str, str],
    readiness: EvidenceReadinessResult,
    enable_llm_judge: bool,
    run_human_review: bool,
    trigger_reason: TriggerReason,
    correlation_id: str | None,
    label: str | None,
    labels: list[str] | None = None,
    store: EvaluationStore,
    engine: EvaluationEngine,
    system_prompt_hash: str | None = None,
    prompt_version_ref: str | None = None,
    run_status: RunStatus = RunStatus.COMPLETED,
    finalize_job: bool = True,
    replace_existing: bool = False,
    allow_completed_telemetry_refresh: bool = False,
    replacement_reason: str = "late_telemetry_completion",
    manifest: ResolvedRunManifest | None = None,
    assignment_id: str | None = None,
    assignment_version: str | None = None,
) -> None:
    # Classified before scoring, not after: the engine emits RUN_COMPLETED and
    # builds the review queue from the verdict it decides, so capture
    # completeness must be an input to that decision.
    capture_status, categories = classify_evidence_capture(
        rows,
        response_source=response_source,
        evaluation_scope=experiment.evaluation_scope or EvaluationScope.FINAL_RESPONSE,
        effective_requirements=readiness.effective_evidence_requirements,
    )
    if enable_llm_judge:
        run_engine = engine
    else:
        disabled_settings = engine.settings.model_copy(update={"judge_mode": "mock"})
        run_engine = EvaluationEngine(
            judge=build_judge(disabled_settings), settings=disabled_settings
        )
    result = await run_in_threadpool(
        run_engine.execute,
        experiment,
        rows,
        run_id,
        trigger_reason,
        correlation_id,
        0,
        manifest,
        resolved_metrics,
        None if manifest is not None else scoring_configuration,
        pre_run_not_applicable,
        system_prompt_hash,
        evidence_capture_complete=capture_status == EvidenceCaptureStatus.COMPLETE,
    )
    if not run_human_review:
        result.review_queue = []
    result.label = label
    result.labels = list(labels or ([] if label is None else [label]))
    result.evidence_readiness = readiness
    result.evidence_capture_status = capture_status
    result.evidence_categories = categories
    if run_status == RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE:
        # A partial snapshot is provisional and can be replaced automatically
        # when complete telemetry lands. Do not open human-review work against
        # findings that may disappear during that enrichment.
        result.review_queue = []
        diagnostics = {
            str((row.output_data or {}).get("archive_fallback_reason"))
            for row in rows
            if (row.output_data or {}).get("archive_fallback_reason")
            in {"root_span_missing", "completion_marker_missing", "archive_not_settled", "incomplete_trajectory"}
        }
        diagnostic = sorted(diagnostics)[0] if diagnostics else "incomplete_trajectory"
        for category in result.evidence_categories:
            if category.required and not category.completeness_attested:
                category.diagnostic = diagnostic
        result.status = run_status
        logger.warning(
            "eval-hub: run %s completed with partial evidence (%s)",
            run_id,
            diagnostic,
            extra={
                "run_id": run_id,
                "evidence_diagnostic": diagnostic,
                "run_status": run_status.value,
            },
        )
    if replace_existing and result.lineage is not None:
        result.lineage.rescore_configuration = {
            "reason": replacement_reason,
            "automatic": True,
            "identity_preserved": True,
        }
    if result.lineage is not None:
        result.lineage.target_prompt_hash = system_prompt_hash
        result.lineage.target_prompt_ref = prompt_version_ref
        result.lineage.metric_evidence_requirements = dict(readiness.metric_evidence_requirements)
        result.lineage.effective_evidence_requirements = list(readiness.effective_evidence_requirements)
        result.lineage.agent_tools_snapshot = list(readiness.agent_tools) if readiness.agent_tools is not None else None
        result.lineage.assignment_id = assignment_id
        result.lineage.assignment_version = assignment_version
    if label:
        result.experiment.tags = {**(result.experiment.tags or {}), "label": label}
    if replace_existing:
        await store.save_run(
            result,
            rows,
            finalize_job=finalize_job,
            replace_existing=True,
            allow_completed_telemetry_refresh=allow_completed_telemetry_refresh,
        )
    elif finalize_job:
        await store.save_run(result, rows)
    else:
        await store.save_run(result, rows, finalize_job=False)


async def execute_deferred_telemetry_score(
    *,
    run_id: str,
    store: EvaluationStore,
    engine: EvaluationEngine,
) -> str | None:
    """Hydrate completed archived trajectories and score a parked run.

    Returns ``DATASET_RUN_DEFERRED`` when the trajectory is still incomplete and
    the grace window has not expired. Returns ``None`` after the run is persisted.
    """

    # No tenant_id: worker-side deferred-score sweep keyed by run_id, same
    # cross-tenant carve-out as runs_worker.py (see its module docstring).
    job = await store.get_run_job(run_id)
    if job is None:
        raise EvaluationInputError(f"Run job {run_id} was not found")
    snapshot = dict((job.params or {}).get(TELEMETRY_SCORE_SNAPSHOT_KEY) or {})
    if not snapshot:
        raise EvaluationInputError(f"Run job {run_id} has no deferred telemetry snapshot")

    published = await store.get_run(run_id)
    completed_watch = bool(snapshot.get("watch_completed_run"))
    if (
        published is not None
        and published.status != RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE
        and not (completed_watch and published.status == RunStatus.COMPLETED)
    ):
        return None
    if published is not None and completed_watch and _telemetry_enrichment_expired(snapshot):
        await store.disable_run_job_telemetry_watch(run_id)
        return None

    rows = [EvaluationRow.model_validate(item) for item in snapshot.get("rows") or []]
    scored_fingerprints = _row_trace_fingerprints(rows)
    experiment = ExperimentDefinition.model_validate(snapshot["experiment"])
    scoring_raw = snapshot.get("scoring_configuration")
    scoring_configuration = ResolvedScoringConfiguration.model_validate(scoring_raw) if scoring_raw else None
    manifest_raw = snapshot.get("manifest")
    manifest = ResolvedRunManifest.model_validate(manifest_raw) if manifest_raw else None
    if manifest is not None:
        scoring_configuration = None
    readiness = EvidenceReadinessResult.model_validate(snapshot["readiness"])
    selected_tool_ids = snapshot.get("selected_tool_ids")
    if selected_tool_ids is not None:
        selected_tool_ids = [str(item) for item in selected_tool_ids]
    archive_tenant_id = snapshot.get("archive_tenant_id")
    if uses_a2a_capture_for_scoring(experiment.evaluation_scope):
        for row in rows:
            apply_a2a_capture_scoring(row)
    else:
        grace_expired = _telemetry_grace_expired(snapshot)
        mode = "defer" if published is not None else incomplete_archive_mode(settings, evaluation_scope=experiment.evaluation_scope) if not grace_expired else ("fallback" if settings.trace_archive_score_fallback_to_capture else "discard")
        for row in rows:
            # Use the configured archive deadline, as for initial scoring.
            # A settle+poll window excludes read time and can never fit the
            # required observations, leaving complete traces pending forever.
            await hydrate_row_from_archive(
                row,
                tenant_id=archive_tenant_id,
                selected_tool_ids=selected_tool_ids,
                settings=settings,
                incomplete_mode=mode,
            )
        awaiting_trace = any(row_awaiting_completed_trace(row) for row in rows)
        if awaiting_trace and published is not None and completed_watch:
            # A transient archive read must not replace a previously complete
            # score with partial evidence. Retain the last scored snapshot and
            # simply try again on the next bounded check.
            await store.update_run_job_telemetry_watch(run_id, snapshot)
            return None
        if awaiting_trace and not grace_expired:
            snapshot["rows"] = [row.model_dump(mode="json") for row in rows]
            await store.park_run_job_waiting_for_telemetry(run_id, snapshot)
            return DATASET_RUN_DEFERRED
        if awaiting_trace and published is not None:
            # The customer-facing run has already completed honestly with
            # partial evidence. Keep a bounded background enrichment watch;
            # never overwrite it or make it look active again.
            #
            # `completed_watch` is always False on this path -- the branch
            # above (`awaiting_trace and published is not None and
            # completed_watch`) already returned for the True case, so a
            # `if completed_watch:` guard here was dead code (bot-confirmed;
            # verified unreachable in both this branch's history and
            # feat/evalai-evaluation-hub, which carries the same hunk).
            # The enrichment window expiring is itself the signal to give up
            # and stamp that decision — regardless of whether a watch had
            # already been activated — so the call is unconditional now;
            # `disable_run_job_telemetry_watch` is idempotent (it just
            # (re)asserts watch_completed_run=False and records
            # watch_stopped_at) and this is the one place that "gave up
            # before ever starting to watch" gets recorded at all.
            if _telemetry_enrichment_expired(snapshot):
                await store.disable_run_job_telemetry_watch(run_id)
                return None
            snapshot["rows"] = [row.model_dump(mode="json") for row in rows]
            await store.park_run_job_waiting_for_telemetry(run_id, snapshot)
            return DATASET_RUN_DEFERRED

    hydrated_fingerprints = _row_trace_fingerprints(rows)
    # Snapshot rows can be newer than the published score after a failed attempt.
    if published is not None and completed_watch and not snapshot.get("score_stale") and hydrated_fingerprints == scored_fingerprints:
        await store.update_run_job_telemetry_watch(run_id, snapshot)
        return None
    activate_completed_watch = bool(
        published is not None
        and published.status == RunStatus.COMPLETED_WITH_PARTIAL_EVIDENCE
        and hydrated_fingerprints
    )
    if completed_watch:
        snapshot["score_stale"] = True
        snapshot["last_fingerprint_change_at"] = datetime.now(UTC).isoformat()
        snapshot["rows"] = [row.model_dump(mode="json") for row in rows]
        await store.update_run_job_telemetry_watch(run_id, snapshot)
    elif activate_completed_watch:
        snapshot["watch_completed_run"] = True
        snapshot["rows"] = [row.model_dump(mode="json") for row in rows]
        await store.update_run_job_telemetry_watch(run_id, snapshot)

    raw_metrics = snapshot.get("resolved_metrics")
    resolved_metrics = list(raw_metrics) if isinstance(raw_metrics, list) else None
    await _score_and_persist_run(
        run_id=run_id,
        rows=rows,
        experiment=experiment,
        # A job parked by a build that predates this snapshot field carries no
        # response source. Defaulting straight to "agent" gave such a run
        # ATTESTED final-output provenance — "evaluation target invocation" —
        # for a target that was never invoked. The resolved provenance records
        # the same value and does survive the upgrade, so read it first.
        response_source=str(
            snapshot.get("response_source")
            or experiment.resolved_target_provenance.get("target_type")
            or "agent"
        ),
        resolved_metrics=resolved_metrics,
        scoring_configuration=scoring_configuration,
        pre_run_not_applicable=dict(snapshot.get("pre_run_not_applicable") or {}),
        readiness=readiness,
        enable_llm_judge=bool(snapshot.get("enable_llm_judge", True)),
        run_human_review=bool(snapshot.get("run_human_review", True)),
        trigger_reason=TriggerReason(snapshot.get("trigger_reason") or TriggerReason.MANUAL.value),
        correlation_id=snapshot.get("correlation_id") or run_id,
        label=snapshot.get("label"),
        labels=list(snapshot.get("labels") or []),
        store=store,
        engine=engine,
        system_prompt_hash=snapshot.get("system_prompt_hash"),
        prompt_version_ref=snapshot.get("prompt_version_ref"),
        replace_existing=published is not None,
        finalize_job=not (published is not None and completed_watch),
        allow_completed_telemetry_refresh=published is not None and completed_watch,
        replacement_reason=(
            "late_telemetry_change" if published is not None and completed_watch else "late_telemetry_completion"
        ),
        manifest=manifest,
        assignment_id=snapshot.get("assignment_id"),
        assignment_version=snapshot.get("assignment_version"),
    )
    if published is not None:
        await store.record_telemetry_enrichment(
            run_id,
            enrichment_run_id=run_id,
        )
    if completed_watch:
        snapshot["score_stale"] = False
        snapshot["last_rescored_at"] = datetime.now(UTC).isoformat()
        await store.update_run_job_telemetry_watch(run_id, snapshot)
    return None


def _row_trace_fingerprints(rows: list[EvaluationRow]) -> dict[str, str]:
    """Fingerprint map persisted with a score for later archive comparisons."""

    return {
        row.row_id: str((row.output_data or {}).get(TRACE_EVIDENCE_FINGERPRINT_KEY))
        for row in rows
        if (row.output_data or {}).get(TRACE_EVIDENCE_FINGERPRINT_KEY)
    }


def _target_trace_attributes(
    *,
    run_id: str,
    tenant_id: str | None,
    app_id: str | None,
    manifest: ResolvedRunManifest | None,
) -> dict[str, str]:
    """Build the root-scoped correlation envelope known before invocation."""

    values = {
        "ctx.eval.run_id": run_id,
        "ctx.tenant": tenant_id,
        "ctx.app": app_id,
        "ctx.target_id": manifest.target_id if manifest is not None else None,
        "ctx.target_revision": manifest.target_version if manifest is not None else None,
        "deployment.environment": manifest.environment if manifest is not None else None,
        "service.version": manifest.target_version if manifest is not None else None,
    }
    return {key: str(value) for key, value in values.items() if value is not None and str(value).strip()}


async def _gather_fail_fast(coros) -> None:
    """Run every coroutine concurrently; on the first failure, cancel the rest.

    Plain ``asyncio.gather(*coros)`` (the default, ``return_exceptions=False``)
    propagates the first exception to raise but leaves every OTHER task
    running in the background — they keep hitting the target agent/LLM,
    unobserved, after the caller has already moved on to failure handling.
    ``asyncio.wait(..., return_when=FIRST_EXCEPTION)`` stops as soon as one
    task fails, so the rest can be cancelled immediately instead. The
    surfaced exception is the first row's failure in the ORIGINAL row order —
    not whichever task happened to raise first, which is non-deterministic
    under concurrency.
    """
    tasks = [asyncio.ensure_future(coro) for coro in coros]
    if not tasks:
        return
    try:
        _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
    except asyncio.CancelledError:
        # The caller itself was cancelled -- e.g. a worker cancelling a run
        # mid-flight (runs_worker.py's durable-cancellation watch). Without
        # this, asyncio.wait raising CancelledError here would propagate
        # straight out, leaving every row task still running in the
        # background -- still invoking the target agent/LLM, unobserved by
        # anyone -- instead of being cancelled along with their caller.
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    if pending:
        for task in pending:
            task.cancel()
        # Let cancellation settle so a cancelled task's CancelledError never
        # surfaces in place of the real failure below.
        await asyncio.gather(*pending, return_exceptions=True)
    # Retrieve EVERY non-cancelled task's exception before raising any of
    # them. Raising on the first hit in this loop would leave every sibling
    # failed task's exception un-retrieved -- asyncio logs those as "Task
    # exception was never retrieved" once the task is garbage-collected,
    # which for a row task means the raw agent/LLM response text embedded in
    # its failure_reason (see technical_failure_reason) leaks into asyncio's
    # own logger, bypassing the type-only logging invariant. ``tasks`` is in
    # the original row order, so the first entry here is still the first
    # row's failure -- the ordering guarantee this function documents.
    exceptions = [
        exc
        for task in tasks
        if not task.cancelled() and (exc := task.exception()) is not None
    ]
    if exceptions:
        raise exceptions[0]


async def _run_agent_rows(
    rows: list[EvaluationRow],
    *,
    agent_ref: str,
    parallel_requests: int = 5,
    selected_tool_ids: list[str] | None = None,
    tenant_id: str | None = None,
    archive_reader=None,
    evaluation_scope: EvaluationScope | None = None,
    trace_attributes: dict[str, str] | None = None,
) -> None:
    """Invoke the agent for each row, filling response + tool_calls + context.

    ``AGENT_OUTPUT_TOO_LARGE`` is a row-level, non-retryable bounded-resource
    failure: the row is marked and the experiment continues. Other technical
    invocation failures still abort the whole evaluation run.
    """

    semaphore = asyncio.Semaphore(max(1, min(parallel_requests, 20)))

    # An external catalog target is the SAME target_version_id for every row
    # in this run. Resolving it inside run_agent_target (per row, per
    # concurrent invocation) opens up to `parallel_requests` redundant DB
    # sessions just to re-read a row every other in-flight row already read.
    # Resolve once, up front, and hand the result to every row.
    resolved_external_target = None
    if agent_ref.startswith(EXTERNAL_PREFIX):
        resolved_external_target = await resolve_external_target(agent_ref, settings)

    async def invoke(row: EvaluationRow) -> None:
        async with semaphore:
            await _run_agent_row(
                row,
                agent_ref=agent_ref,
                selected_tool_ids=selected_tool_ids,
                tenant_id=tenant_id,
                archive_reader=archive_reader,
                evaluation_scope=evaluation_scope,
                trace_attributes=trace_attributes,
                resolved_external_target=resolved_external_target,
            )

    await _gather_fail_fast(invoke(row) for row in rows)


async def _run_agent_row(
    row: EvaluationRow,
    *,
    agent_ref: str,
    selected_tool_ids: list[str] | None = None,
    tenant_id: str | None = None,
    archive_reader=None,
    evaluation_scope: EvaluationScope | None = None,
    trace_attributes: dict[str, str] | None = None,
    resolved_external_target=None,
) -> None:
    """Invoke one agent row.

    ``AgentOutputTooLargeError`` marks the row and returns without raising so
    the experiment continues. Other technical failures raise and fail the run.
    """

    # A fresh invocation may populate trace identity only from its own runtime
    # response; source dataset trace/span IDs belong to another execution.
    row.trace_id = None
    row.span_id = None
    row.parent_span_id = None
    row.trace_provider = None
    row.invocation_id = str(uuid.uuid4())
    started = time.monotonic()
    try:
        out = await run_agent_target(
            settings=settings,
            target_endpoint=agent_ref,
            query=row.query,
            invocation_id=row.invocation_id,
            trace_attributes=trace_attributes,
            resolved_external_target=resolved_external_target,
        )
    except AgentOutputTooLargeError as exc:
        _mark_output_too_large(row, exc=exc, started=started, agent_ref=agent_ref)
        return
    except AgentInvocationError as exc:
        row.latency_ms = round((time.monotonic() - started) * 1000)
        row.trace_unavailable = True
        row.invocation_error = str(exc)
        logger.error(
            "eval-hub: agent %s failed for row %s — aborting evaluation run: %s",
            agent_ref,
            row.row_id,
            type(exc).__name__,
        )
        raise AgentInvocationError(f"Failed to retrieve agent output for row '{row.row_id}': {exc}") from exc

    if not (out.response or "").strip():
        row.latency_ms = round((time.monotonic() - started) * 1000)
        row.trace_unavailable = True
        row.invocation_error = "empty agent response"
        raise AgentInvocationError(f"Failed to retrieve agent output for row '{row.row_id}': empty response")

    # A selected-tools run must not be aborted by an out-of-scope tool's error:
    # technical failures are judged against the scoped calls only, while every
    # call remains fully captured on the row as evidence.
    failure_reason = technical_failure_reason(out.response, scoped_tool_calls(out.tool_calls, selected_tool_ids))
    if failure_reason:
        row.latency_ms = round((time.monotonic() - started) * 1000)
        row.trace_unavailable = True
        row.invocation_error = failure_reason
        row.response = out.response
        row.output_data = {"response": out.response}
        row.tool_calls = out.tool_calls
        logger.error(
            "eval-hub: agent %s row %s integration failure — aborting evaluation run",
            agent_ref,
            row.row_id,
        )
        raise AgentInvocationError(f"Failed to retrieve agent output for row '{row.row_id}': {failure_reason}")

    row.response = out.response
    row.output_data = {"response": out.response}
    row.tool_calls = out.tool_calls
    row.tool_result_artifacts = out.tool_result_artifacts
    row.trace_unavailable = out.trace_unavailable
    row.tool_evidence_completion_attested = out.tool_evidence_completion_attested
    row.tool_evidence_provenance_status = out.tool_evidence_provenance_status
    row.tool_evidence_source = out.tool_evidence_source
    row.invocation_id = out.invocation_id or row.invocation_id
    row.trace_id = out.trace_id
    row.span_id = out.span_id
    row.kagent_session_id = out.context_id
    row.latency_ms = round(out.latency_seconds * 1000)
    row.target_usage = out.target_usage
    # Final-response depth grades only query + answer from the live A2A
    # capture. Tool outputs stay on the row as evidence but are not mixed
    # into scoring context, and the run does not wait on the trace archive.
    if uses_a2a_capture_for_scoring(evaluation_scope):
        apply_a2a_capture_scoring(row)
        return
    # Feed captured tool outputs into context so faithfulness metrics grade
    # against what the agent actually retrieved. A selected-tools run grades
    # only the named tools' evidence, so out-of-scope outputs stay out of the
    # scoring context (they remain fully captured on ``row.tool_calls``).
    tool_ctx = tool_context_texts(out.tool_calls, selected_tool_ids)
    if tool_ctx:
        row.context = [*row.context, *tool_ctx]
    # Tool / full-execution depth scores a completed OTEL trajectory (root
    # closed, children finalized). Incomplete traces are parked for
    # asynchronous scoring unless the operator disables deferral.
    await hydrate_row_from_archive(
        row,
        tenant_id=tenant_id,
        selected_tool_ids=selected_tool_ids,
        settings=settings,
        reader=archive_reader,
    )


def _mark_output_too_large(
    row: EvaluationRow,
    *,
    exc: AgentOutputTooLargeError,
    started: float,
    agent_ref: str,
) -> None:
    """Persist a row-level ``AGENT_OUTPUT_TOO_LARGE`` failure and keep going."""

    partial = (exc.partial_text or "").strip()
    diagnostics = exc.to_diagnostics()
    row.latency_ms = round((time.monotonic() - started) * 1000)
    row.trace_unavailable = True
    row.invocation_error = str(exc)
    row.tags = {**(row.tags or {}), "error_type": AgentOutputTooLargeError.error_type}
    row.response = partial
    row.output_data = {
        "response": partial,
        **diagnostics,
    }
    if exc.context_id:
        row.kagent_session_id = exc.context_id
    logger.warning(
        "eval-hub: agent %s row %s %s (limit=%s received=%s last_event=%s); continuing experiment without scoring this row",
        agent_ref,
        row.row_id,
        AgentOutputTooLargeError.error_type,
        exc.limit_bytes,
        exc.received_bytes,
        exc.last_event_type,
    )


def is_output_too_large_row(row: EvaluationRow) -> bool:
    """True when the row failed the agent stream byte budget."""

    if (row.tags or {}).get("error_type") == AgentOutputTooLargeError.error_type:
        return True
    err = row.invocation_error or ""
    return err.startswith("AGENT_OUTPUT_TOO_LARGE") or (isinstance(row.output_data, dict) and row.output_data.get("error_type") == AgentOutputTooLargeError.error_type)


async def _run_llm_rows(
    rows: list[EvaluationRow],
    *,
    target_endpoint: str | None,
    target_model: str,
    system_prompt: str | None = None,
    parallel_requests: int = 5,
    tenant_id: str | None = None,
    evaluation_scope: EvaluationScope | None = None,
    trace_attributes: dict[str, str] | None = None,
) -> None:
    """Invoke the selected LLM for each row, filling ``response`` / latency."""

    semaphore = asyncio.Semaphore(max(1, min(parallel_requests, 20)))

    async def invoke(row: EvaluationRow) -> None:
        async with semaphore:
            await _run_llm_row(
                row,
                target_endpoint=target_endpoint,
                target_model=target_model,
                system_prompt=system_prompt,
                tenant_id=tenant_id,
                evaluation_scope=evaluation_scope,
                trace_attributes=trace_attributes,
            )

    await _gather_fail_fast(invoke(row) for row in rows)


async def _run_llm_row(
    row: EvaluationRow,
    *,
    target_endpoint: str | None,
    target_model: str,
    system_prompt: str | None = None,
    tenant_id: str | None = None,
    evaluation_scope: EvaluationScope | None = None,
    trace_attributes: dict[str, str] | None = None,
) -> None:
    """Invoke one LLM row. Empty or failed completions abort the evaluation run."""

    # The dataset may itself have been sourced from a traced execution. A new
    # target invocation must never claim that older execution's trace identity.
    row.trace_id = None
    row.span_id = None
    row.parent_span_id = None
    row.trace_provider = None
    row.invocation_id = str(uuid.uuid4())
    started = time.monotonic()
    try:
        out = await run_llm_target(
            settings=settings,
            target_endpoint=target_endpoint,
            target_model=target_model,
            query=row.query,
            system_prompt=system_prompt,
            invocation_id=row.invocation_id,
            trace_attributes=trace_attributes,
        )
    except LlmInvocationError as exc:
        row.latency_ms = round((time.monotonic() - started) * 1000)
        row.trace_unavailable = True
        row.invocation_error = str(exc)
        logger.error(
            "eval-hub: LLM %s failed for row %s — aborting evaluation run: %s",
            target_model,
            row.row_id,
            type(exc).__name__,
        )
        raise LlmInvocationError(f"Failed to retrieve LLM output for row '{row.row_id}': {exc}") from exc

    row.response = out.response
    row.output_data = {"response": out.response}
    row.invocation_id = out.invocation_id or row.invocation_id
    row.trace_id = out.trace_id
    row.span_id = out.span_id
    row.latency_ms = round(out.latency_seconds * 1000)
    # Omit the token counters entirely when the provider reported no usage
    # object (out.prompt_tokens/completion_tokens is None) -- a present key
    # with value 0 is indistinguishable downstream from a genuine reported
    # zero, and every reader (usage_total_tokens, _reported_usage_total)
    # already treats a missing key as "not reported". Setting the key to
    # None instead of omitting it would also collide with redact_for_persistence:
    # "prompt_tokens"/"completion_tokens" match the sensitive-key pattern
    # ("token"), and the int-only usage-count exemption doesn't cover None,
    # so a None value would be rewritten to the string "[REDACTED]".
    row.target_usage = {"model": out.model_id}
    if out.prompt_tokens is not None:
        row.target_usage["prompt_tokens"] = out.prompt_tokens
    if out.completion_tokens is not None:
        row.target_usage["completion_tokens"] = out.completion_tokens
    if uses_a2a_capture_for_scoring(evaluation_scope):
        apply_a2a_capture_scoring(row)
        return
    await hydrate_row_from_archive(
        row,
        tenant_id=tenant_id,
        settings=settings,
    )


def technical_failure_reason(response: str, tool_calls: list[ToolCall] | None = None) -> str | None:
    """Return the exact integration error when the agent output is unusable.

    Prefers the underlying tool/MCP error payload when present; otherwise uses
    the agent's exact failure response text.
    """

    integration_error = extract_integration_error(tool_calls)
    text = (response or "").strip()
    response_is_failure = bool(text and _TECHNICAL_FAILURE_RESPONSE.search(text))

    if integration_error and (response_is_failure or _looks_like_tool_error(integration_error)):
        return integration_error

    if response_is_failure:
        return text

    if integration_error and _looks_like_tool_error(integration_error):
        return integration_error

    return None


def extract_integration_error(tool_calls: list[ToolCall] | None = None) -> str | None:
    """Extract the exact error string from tool/integration outputs, if any."""

    for tool_call in tool_calls or []:
        extracted = _extract_tool_error(tool_call)
        if extracted:
            return extracted
    return None


def _extract_tool_error(tool_call: ToolCall) -> str | None:
    output = tool_call.output
    if output is None:
        return None

    if isinstance(output, dict):
        nested = output.get("error")
        if isinstance(nested, dict):
            for key in ("message", "detail", "error", "error_message", "description"):
                value = nested.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
            nested_text = _tool_output_text(nested).strip()
            if nested_text:
                return nested_text
        if isinstance(nested, str) and nested.strip():
            return nested.strip()

        for key in ("error_message", "errorMessage", "detail", "message"):
            value = output.get(key)
            if isinstance(value, str) and value.strip():
                status = str(output.get("status") or output.get("state") or "").lower()
                if status in {"error", "failed", "failure"} or key.lower().startswith("error"):
                    return value.strip()

        status = str(output.get("status") or output.get("state") or "").lower()
        if status in {"error", "failed", "failure"}:
            text = _tool_output_text(output).strip()
            return text or f"tool '{tool_call.name}' failed with status={status}"

    text = _tool_output_text(output).strip()
    if not text:
        return None
    if _looks_like_tool_error(text):
        return text
    return None


def _looks_like_tool_error(text: str) -> bool:
    lowered = text.lower()
    if any(
        marker in lowered
        for marker in (
            '"status":"error"',
            '"status": "error"',
            "'status': 'error'",
            "traceback (most recent call last)",
            "exception:",
            "error:",
            "failed:",
            "http 4",
            "http 5",
            "status code",
            "unauthorized",
            "forbidden",
            "timeout",
            "timed out",
            "connection refused",
            "econnrefused",
            "mcp",
        )
    ):
        return True
    return bool(re.search(r"(?i)^\s*(error|failed)\b", text))


def resolve_active_metrics(
    active_metrics: list[str] | None,
    quality_contract_ids: list[str] | None = None,
    *,
    scenario=None,
    has_ground_truth: bool = True,
) -> list[str] | None:
    """Merge selected metrics with explicitly attached quality contracts only.

    ``quality.*`` metrics are never part of the scenario default battery. They
    are included only when the caller attaches matching ``quality_contract_ids``.
    Any ``quality.*`` ids that appear in ``active_metrics`` without a matching
    contract attachment are dropped.
    """

    selected_contract_metrics: list[str] = []
    for template_id in quality_contract_ids or []:
        template = QUALITY_CONTRACT_TEMPLATE_BY_ID.get(template_id)
        if template is not None:
            selected_contract_metrics.append(template.metric_id)

    allowed_quality = set(selected_contract_metrics)

    if active_metrics is None:
        if not selected_contract_metrics:
            return None
        if scenario is None:
            return selected_contract_metrics
        base = [metric.metric_id for metric in select_metrics(scenario, has_ground_truth, None)]
        return list(dict.fromkeys([*base, *selected_contract_metrics]))

    resolved = [metric_id for metric_id in active_metrics if not metric_id.startswith("quality.") or metric_id in allowed_quality]
    for metric_id in selected_contract_metrics:
        if metric_id not in resolved:
            resolved.append(metric_id)
    return resolved


def scoped_tool_calls(
    tool_calls: list[ToolCall] | None,
    selected_tool_ids: list[str] | None,
) -> list[ToolCall] | None:
    """Filter captured calls to the selected tools (``None`` = whole layer).

    Case-insensitive name matching, mirroring ``tool_context_texts``.
    """

    if tool_calls is None or selected_tool_ids is None:
        return tool_calls
    selected = {name.strip().casefold() for name in selected_tool_ids if name.strip()}
    return [call for call in tool_calls if (call.name or "").strip().casefold() in selected]


def tool_context_texts(
    tool_calls: list[ToolCall],
    selected_tool_ids: list[str] | None,
) -> list[str]:
    """Captured tool outputs to grade against, scoped to the selected tools.

    ``None`` means the whole tool layer. Matching is case-insensitive, mirroring
    the trace scorer's tool-name normalisation.
    """

    selected = {name.strip().casefold() for name in selected_tool_ids if name.strip()} if selected_tool_ids is not None else None
    return [_tool_output_text(call.output) for call in tool_calls if call.output is not None and call.output != "" and (selected is None or call.name.strip().casefold() in selected)]


def _tool_output_text(value: object) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)
