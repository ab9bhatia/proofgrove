"""FastAPI routes for the Evaluation Engine."""

import asyncio
import json
import logging
from typing import Annotated, Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator, model_validator

from proofgrove.api.dependencies import (
    get_evaluation_engine,
    get_evaluation_store,
    get_registry_service,
)

# Shared additive-paging helpers, already the convention for the dataset
# endpoints; reused here rather than minting a second paging shape.
from proofgrove.api.v1.datasets import _page_window, _paged_envelope
from proofgrove.datasets.exceptions import DatasetNotFoundError
from proofgrove.datasets.models import MAX_ROWS_PER_DATASET
from proofgrove.datasets.naming import dataset_version_label
from proofgrove.datasets.registry import DatasetRegistryService
from proofgrove.db.models import RunJobORM
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.dataset_bridge import _QUERY_KEYS
from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.enums import (
    DecisionType,
    EvaluationScope,
    EvidenceReadiness,
    ExperimentStatus,
    RunRole,
    RunStatus,
    RunType,
    Scenario,
    TriggerReason,
)
from proofgrove.evaluation.labels import normalize_run_labels
from proofgrove.evaluation.lineage import hash_system_prompt
from proofgrove.evaluation.metrics import list_metrics
from proofgrove.evaluation.target.local_workflows import is_local_agent
from proofgrove.evaluation.models import (
    CaseReplay,
    EvaluationRow,
    EvidenceReadinessResult,
    ExperimentDecision,
    ExperimentDefinition,
    PaginatedRuns,
    RunItemTraceEvidence,
    recorded_comparison_basis,
    scenario_value,
)
from proofgrove.evaluation.readiness import (
    assess_evidence_readiness,
    scope_options,
    tool_evidence_attestation_available,
)
from proofgrove.evaluation.release_eligibility import (
    release_eligibility,
    release_gate_violation,
)
from proofgrove.evaluation.report import build_ci_callback, build_report
from proofgrove.evaluation.run_service import resolve_active_metrics
from proofgrove.evaluation.sample_data import (
    SAMPLE_EXPERIMENTS,
    SAMPLE_TENANT_ID,
    get_sample_experiment,
    get_sample_rows,
)
from proofgrove.evaluation.scenario_policy import resolve_scenario
from proofgrove.evaluation.scenario_router import (
    build_evaluator_configs,
    get_scenario_info,
    select_metrics,
)
from proofgrove.evaluation.target.llm_runner import (
    LlmInvocationError,
    resolve_llm_base_url,
    run_llm_target,
)
from proofgrove.evaluation.trace_archive import TraceArchiveReader, tenant_from_namespace
from proofgrove.events import EvalEvent, emit
from proofgrove.platform.audit import AuditEvent
from proofgrove.platform.authz import (
    actor_from_request,
    authorize_dataset_access,
    caller_tenant,
    enforce_tenant,
    require_configured_approver_roles,
    resolve_requested_tenant,
    tenants_match,
)
from proofgrove.platform.contracts import (
    EvaluationAssignmentVersion,
    ProjectPurpose,
    ProjectStatus,
    ResolvedRunManifest,
    ResolvedScoringConfiguration,
)
from proofgrove.platform.payloads import TRUNCATION_MARKER
from proofgrove.platform.prompts import MAX_PROMPT_CHARS, parse_prompt_ref, reject_embedded_credentials
from proofgrove.platform.quality_contract_templates import QUALITY_CONTRACT_TEMPLATE_BY_ID
from proofgrove.platform.resolver import (
    ContractResolutionError,
    resolve_scoring_configuration,
)
from proofgrove.settings import settings
from proofgrove.tracing.cost import estimate_tokens_cost_usd
from proofgrove.tracing.scoring import full_execution_span_checks

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/evaluation", tags=["evaluation"])


def _client_error_message(message: str | None) -> str | None:
    # Old rows have no trustworthy provenance for their error text. Regex
    # redaction cannot prove arbitrary provider/SQL messages safe to disclose.
    return "Run failed. Check the run configuration and try again." if message else message


async def _submit_durable_run(run_id: str) -> None:
    """Hand a committed job to the durable runtime.

    The job row is already committed, so the response stays a 202 whatever
    the start request does: a start whose outcome this process cannot
    determine (Temporal unreachable, reply lost) is not evidence that the
    job will never run. The row is left pending and unstamped, and the
    worker's reconciliation loop submits it by its stable workflow id once
    it is old enough that this request is no longer in flight.
    """
    if settings.evaluation_runtime != "temporal":
        return
    from temporalio.exceptions import WorkflowAlreadyStartedError

    from proofgrove.orchestrator.temporal import submit_dataset_run

    try:
        await submit_dataset_run(run_id)
    except WorkflowAlreadyStartedError:
        return
    except Exception as exc:  # noqa: BLE001 - outcome unknown: the reconciliation loop settles it
        logger.error("proofgrove: Temporal workflow submission for run %s did not complete; left for reconciliation", run_id, extra={"error_type": type(exc).__name__})


def _run_job_list_item(job: RunJobORM) -> dict[str, Any]:
    """Shape an in-flight/failed eval job like a RunResult for the runs list UI."""
    params = job.params or {}
    target_endpoint = job.agent if job.response_source == "agent" else (params.get("target_endpoint") or f"golden-dataset:{job.dataset_name}")
    scenario = params.get("scenario") or "llm_core"
    started = job.created_at.isoformat() if job.created_at else None
    completed = job.updated_at.isoformat() if job.status in (RunStatus.BLOCKED.value, RunStatus.FAILED.value, RunStatus.CANCELLED.value) and job.updated_at else None
    evaluation_name = (params.get("evaluation_name") or "").strip() or None
    display_name = evaluation_name or f"{job.dataset_name} ({job.response_source})"
    label, labels = normalize_run_labels(label=params.get("label"), labels=params.get("labels"), name=params.get("name"))
    tags: dict[str, str] = {}
    if label:
        tags["label"] = str(label)
    if evaluation_name:
        tags["evaluation_name"] = evaluation_name
    evaluation_scope = params.get("evaluation_scope")
    if evaluation_scope:
        tags["evaluation_scope"] = str(evaluation_scope)
    return {
        "run_id": job.run_id,
        "status": job.status,
        "error_message": _client_error_message(job.error_message),
        "label": label,
        "labels": labels,
        "metric_results": [],
        "kpi_results": [],
        "overall_gate": None,
        "root_cause": None,
        "review_queue": [],
        "active_metrics": params.get("active_metrics") or [],
        "started_at": started,
        "completed_at": completed,
        "run_type": "evaluation",
        "response_source": job.response_source,
        "experiment": {
            "name": display_name,
            "dataset_version": params.get("dataset_version") or dataset_version_label(job.dataset_name, 1),
            "target_endpoint": target_endpoint,
            "scenario": scenario,
            "market": "global",
            "judge_model": job.judge_model or "",
            "judge_temperature": 0.0,
            "has_ground_truth": True,
            "row_count": job.row_count,
            "target_version": params.get("target_model"),
            "evaluation_scope": evaluation_scope,
            "tags": tags,
        },
    }


@router.get("/scenarios")
async def list_scenarios() -> list[dict[str, Any]]:
    return get_scenario_info()


@router.get("/judge-config")
async def judge_config() -> dict[str, Any]:
    """Return current judge connectivity settings (no secrets)."""
    mode = settings.judge_mode
    is_azure = settings.judge_provider == "azure"
    has_key = bool(settings.azure_openai_api_key) if is_azure else bool(settings.openai_api_key)
    if mode == "auto":
        effective = "llm" if has_key else "mock"
    else:
        effective = mode
    base_url = f"{settings.azure_openai_endpoint.rstrip('/')}/openai/deployments/{settings.azure_openai_deployment}" if is_azure else settings.openai_base_url
    model = settings.azure_openai_deployment if is_azure else settings.judge_model
    return {
        "judge_mode": mode,
        "effective_mode": effective,
        "judge_provider": settings.judge_provider,
        "judge_model": model,
        "base_url": base_url,
        "has_api_key": has_key,
    }


@router.get("/judge-models")
async def judge_models() -> dict[str, Any]:
    """List judge models without exposing the Compass/OpenAI credential.

    Models come from the AI Gateway catalogue (``GET /v1/models``). Non-chat
    modalities are filtered out so the LLM-as-a-Judge dropdown only shows
    text-generation ids.
    """
    from proofgrove.api.v1.llms import _list_compass_models

    models, fallback = await _list_compass_models()
    return {"provider": settings.judge_provider, "models": models, "fallback": fallback}


@router.get("/metrics")
async def get_metrics() -> list[dict[str, Any]]:
    return [m.model_dump() for m in list_metrics()]


@router.post("/metric-set")
async def preview_metric_set(experiment: ExperimentDefinition) -> dict[str, Any]:
    metrics, configs, kpis = build_evaluator_configs(experiment)
    return {
        "active_metrics": [m.model_dump() for m in metrics],
        "evaluator_configs": [c.model_dump(mode="json") for c in configs],
        "kpis": [k.model_dump() for k in kpis],
    }


@router.get("/sample-experiments")
async def list_sample_experiments() -> list[dict[str, Any]]:
    return [e.model_dump(mode="json") for e in SAMPLE_EXPERIMENTS]


@router.post("/experiments", status_code=201)
async def create_experiment(
    experiment: ExperimentDefinition,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    # The empty-string scenario is the pre-run workspace sentinel, written only
    # by POST /experiments/workspaces. Accepting it here would persist an
    # experiment with no basis and then fail while reporting it.
    if not scenario_value(experiment):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "scenario_required",
                "field": "scenario",
                "message": ("Scenario is required. Use POST /evaluation/experiments/workspaces to create an experiment before its first run."),
            },
        )
    # tenant_id is nominally optional on ExperimentDefinition (many internal
    # callers share the model), but a caller-facing create must not be able to
    # persist a body tenant the caller isn't authorized for -- and an absent
    # tenant_id is refused by enforce_tenant the same way (an unowned resource
    # matches no caller), so this also makes tenant_id required in practice.
    enforce_tenant(request, experiment.tenant_id)
    _reject_forged_approval_status(experiment.status)
    if settings.platform_auth_required:
        experiment.created_by = actor_from_request(request)
    saved = await store.save_experiment(experiment)
    emit(
        EvalEvent.EXPERIMENT_DEFINED,
        correlation_id=saved.experiment_id,
        experiment_id=saved.experiment_id,
        name=saved.name,
        dataset_version=saved.dataset_version,
        scenario=scenario_value(saved),
    )
    return saved.model_dump(mode="json")


@router.get("/experiments")
async def list_experiments(
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    # Used to have no tenant scoping at all: any caller could list every
    # experiment for every tenant. Mirrors GET /experiments/workspaces, which
    # requires tenant_id and filters the unscoped store list in Python.
    enforce_tenant(request, tenant_id)
    exps = await store.list_experiments(tenant_id)
    return [e.model_dump(mode="json") for e in exps if tenants_match(e.tenant_id or "", tenant_id)]


class ExperimentWorkspaceCreateRequest(BaseModel):
    tenant_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=512)
    run_ids: list[str] = Field(min_length=1, max_length=20)
    baseline_run_id: str
    description: str | None = None
    objective: str | None = None
    hypothesis: str | None = None
    owner: str | None = None
    created_by: str = "user"


class PreRunExperimentWorkspaceCreateRequest(BaseModel):
    """Create a governance workspace before any run exists (#2671)."""

    tenant_id: str = Field(min_length=1)
    name: str = Field(max_length=512)
    description: str | None = None
    objective: str | None = None
    hypothesis: str | None = None
    owner: str | None = None
    created_by: str = "user"
    tags: dict[str, str] = Field(default_factory=dict)


class ExperimentWorkspaceAttachRequest(BaseModel):
    tenant_id: str = Field(min_length=1)
    run_ids: list[str] = Field(min_length=1, max_length=20)


async def _validated_workspace_runs(
    store: EvaluationStore,
    run_ids: list[str],
    tenant_id: str,
) -> list[Any]:
    runs = []
    for run_id in dict.fromkeys(run_ids):
        run = await store.get_run(run_id)
        if not run or not tenants_match(run.experiment.tenant_id or "", tenant_id):
            raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
        if run.status != RunStatus.COMPLETED:
            raise HTTPException(
                status_code=409,
                detail=f"Run {run_id} must be completed before it can join an experiment",
            )
        runs.append(run)
    expected_basis = recorded_comparison_basis(runs[0])
    if not expected_basis:
        raise HTTPException(
            status_code=409,
            detail="The selected run has no recorded comparison basis",
        )
    for run in runs[1:]:
        if recorded_comparison_basis(run) != expected_basis:
            raise HTTPException(
                status_code=409,
                detail=(f"Run {run.run_id} does not share the selected dataset, cases, evaluators, Quality Contract, gate composition, and evidence scope"),
            )
    return runs


_BASIS_MISMATCH_MESSAGE = "does not share the selected dataset, cases, evaluators, Quality Contract, gate composition, and evidence scope"


async def _collect_attach_run_failures(
    store: EvaluationStore,
    *,
    existing_runs: list[Any],
    run_ids: list[str],
    tenant_id: str,
) -> list[dict[str, str]]:
    """Return per-run ``{code, field, message}`` reasons why attach candidates fail.

    Missing runs raise 404 (not collected). Incomplete / basis-mismatch failures
    are collected so the Add-runs UI can show which runs failed and why.
    """
    failures: list[dict[str, str]] = []
    candidates: list[Any] = []
    for run_id in dict.fromkeys(run_ids):
        run = await store.get_run(run_id)
        if not run or not tenants_match(run.experiment.tenant_id or "", tenant_id):
            raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
        if run.status != RunStatus.COMPLETED:
            failures.append(
                {
                    "code": "run_not_completed",
                    "field": run_id,
                    "message": (f"Run {run_id} must be completed before it can join an experiment"),
                }
            )
            continue
        candidates.append(run)

    if existing_runs:
        expected_basis = recorded_comparison_basis(existing_runs[0])
        if not expected_basis:
            failures.append(
                {
                    "code": "comparison_basis_missing",
                    "field": existing_runs[0].run_id,
                    "message": "The experiment has no recorded comparison basis",
                }
            )
            return failures
        for run in candidates:
            if recorded_comparison_basis(run) != expected_basis:
                failures.append(
                    {
                        "code": "comparison_basis_mismatch",
                        "field": run.run_id,
                        "message": f"Run {run.run_id} {_BASIS_MISMATCH_MESSAGE}",
                    }
                )
        return failures

    if not candidates:
        return failures

    expected_basis = recorded_comparison_basis(candidates[0])
    if not expected_basis:
        failures.append(
            {
                "code": "comparison_basis_missing",
                "field": candidates[0].run_id,
                "message": "The selected run has no recorded comparison basis",
            }
        )
        return failures
    for run in candidates[1:]:
        if recorded_comparison_basis(run) != expected_basis:
            failures.append(
                {
                    "code": "comparison_basis_mismatch",
                    "field": run.run_id,
                    "message": f"Run {run.run_id} {_BASIS_MISMATCH_MESSAGE}",
                }
            )
    return failures


@router.get("/experiments/workspaces")
async def list_experiment_workspaces(
    request: Request,
    tenant_id: str = Query(min_length=1),
    include_drafts: bool = Query(False),
    archived: bool = Query(False),
    q: str | None = Query(None),
    limit: int | None = Query(None, ge=1, le=200),
    offset: int = Query(0, ge=0),
    cursor: str | None = Query(None),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]] | dict[str, Any]:
    """List governance workspaces and (optionally) lineage drafts.

    Additive server paging, same convention as the dataset endpoints: without
    ``limit``/``cursor`` the response stays the legacy bare list; with them it is
    the ``{items, total, limit, offset, next_cursor}`` envelope.

    Summaries are hydrated in aggregate (``list_experiment_summaries``), so the
    statement count is flat in the number of workspaces and runs.
    """
    enforce_tenant(request, tenant_id)
    window = _page_window(limit, offset, cursor)
    experiments = [experiment for experiment in await store.list_experiments(tenant_id) if tenants_match(experiment.tenant_id or "", tenant_id) and experiment.experiment_id]
    run_ids = await store.run_ids_for_experiments([experiment.experiment_id for experiment in experiments if experiment.experiment_id])
    # Every run that already lives in a governance workspace. A lineage draft
    # reports only the runs that do NOT — so a promoted run is never offered
    # twice, and a later run of the same evaluation makes the draft reappear
    # carrying just that remainder instead of vanishing behind a sticky tag.
    workspace_run_ids: set[str] = set()
    for experiment in experiments:
        if experiment.tags.get("workspace_kind") == "experiment":
            workspace_run_ids |= run_ids.get(experiment.experiment_id or "", set())

    # Filtering here, not in the browser: the response is one server page, so a
    # client-side filter would search 20 of 40 rows and still report the total of
    # all of them.
    needle = (q or "").strip().lower()

    listed: list[tuple[ExperimentDefinition, bool]] = []
    for experiment in experiments:
        if needle and needle not in (experiment.name or "").lower():
            continue
        # One list or the other, never both: archiving is how an experiment
        # leaves the working set, so an archived one has to stop appearing in it
        # — and ``total`` has to count the same set the page shows.
        if (experiment.status == ExperimentStatus.ARCHIVED) is not archived:
            continue
        is_workspace = experiment.tags.get("workspace_kind") == "experiment"
        is_diagnostic = experiment.tags.get("one_off_diagnostic") == "true"
        if not is_workspace and (not include_drafts or is_diagnostic):
            continue
        # A draft with nothing left outside a workspace is fully represented
        # there; anything still outside one must stay listed.
        if not is_workspace and not (run_ids.get(experiment.experiment_id or "", set()) - workspace_run_ids):
            continue
        listed.append((experiment, is_workspace))

    total = len(listed)
    if window:
        page_limit, page_offset = window
        listed = listed[page_offset : page_offset + page_limit]

    summaries = await store.list_experiment_summaries(
        [experiment for experiment, _ in listed],
        exclude_run_ids={experiment.experiment_id: workspace_run_ids for experiment, is_workspace in listed if not is_workspace and experiment.experiment_id},
    )
    items: list[dict[str, Any]] = []
    for experiment, is_workspace in listed:
        summary = summaries.get(experiment.experiment_id or "")
        if not summary:
            continue
        payload = summary.model_dump(mode="json")
        payload["kind"] = "experiment" if is_workspace else "draft"
        items.append(payload)
    if window:
        return _paged_envelope(items, total, window[0], window[1])
    return items


@router.post("/experiments/workspaces", status_code=201)
async def create_pre_run_experiment_workspace(
    body: PreRunExperimentWorkspaceCreateRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Create an Active experiment workspace with no linked runs yet."""
    enforce_tenant(request, body.tenant_id)
    if settings.platform_auth_required:
        body.created_by = actor_from_request(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "experiment_workspace_name_required",
                "field": "name",
                "message": "Experiment name is required.",
            },
        )
    tags = {
        **(body.tags or {}),
        "workspace_kind": "experiment",
        "pending_first_run": "true",
    }
    workspace = ExperimentDefinition(
        name=name,
        description=body.description,
        objective=body.objective,
        hypothesis=body.hypothesis,
        owner=body.owner,
        created_by=body.created_by,
        tenant_id=body.tenant_id,
        status=ExperimentStatus.ACTIVE,
        # Sentinels until the first attached run stamps the comparison basis.
        dataset_version="",
        target_endpoint="",
        scenario="",
        tags=tags,
    )
    saved = await store.save_experiment(workspace)
    assert saved.experiment_id is not None
    summary = await store.get_experiment_summary(saved.experiment_id)
    assert summary is not None
    payload = summary.model_dump(mode="json")
    payload["kind"] = "experiment"
    return payload


async def _mark_promoted_lineages(
    store: EvaluationStore,
    runs: list[Any],
    *,
    workspace_id: str,
    tenant_id: str,
) -> None:
    """Tag every lineage fully represented by ``workspace_id`` as promoted.

    A lineage keeps its draft listing when only SOME of its runs were promoted —
    the remainder still needs somewhere to live. Only a lineage whose runs are all
    in the new workspace is retired from the draft list.
    """
    selected = {run.run_id for run in runs}
    lineage_ids = {run.experiment.experiment_id for run in runs if run.experiment and run.experiment.experiment_id}
    for lineage_id in lineage_ids:
        if lineage_id == workspace_id:
            continue
        lineage = await store.get_experiment(lineage_id, tenant_id)
        if not lineage or lineage.tags.get("workspace_kind") == "experiment":
            continue
        if lineage.tags.get("promoted_to"):
            continue
        lineage_runs = await store.list_runs_for_experiment(lineage_id, tenant_id=lineage.tenant_id)
        if not lineage_runs:
            continue
        if not {run.run_id for run in lineage_runs} <= selected:
            continue
        await store.update_experiment(
            lineage_id,
            tenant_id,
            {"tags": {**lineage.tags, "promoted_to": workspace_id}},
        )


@router.post("/experiments/from-runs", status_code=201)
async def create_experiment_workspace(
    body: ExperimentWorkspaceCreateRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    enforce_tenant(request, body.tenant_id)
    if settings.platform_auth_required:
        body.created_by = actor_from_request(request)
    if body.baseline_run_id not in body.run_ids:
        raise HTTPException(
            status_code=422,
            detail="baseline_run_id must be included in run_ids",
        )
    runs = await _validated_workspace_runs(store, body.run_ids, body.tenant_id)
    baseline = next(run for run in runs if run.run_id == body.baseline_run_id)
    source = baseline.experiment
    workspace = source.model_copy(
        deep=True,
        update={
            "experiment_id": str(uuid4()),
            "name": body.name.strip(),
            "description": body.description,
            "objective": body.objective,
            "hypothesis": body.hypothesis,
            "owner": body.owner or source.owner,
            "created_by": body.created_by,
            "status": ExperimentStatus.ACTIVE,
            "tags": {
                **{k: v for k, v in source.tags.items() if k != "promoted_to"},
                "workspace_kind": "experiment",
                "source_baseline_run_id": body.baseline_run_id,
            },
            "created_at": None,
        },
    )
    saved = await store.save_experiment(workspace)
    assert saved.experiment_id is not None
    await store.link_runs_to_experiment(
        saved.experiment_id,
        [run.run_id for run in runs],
        baseline_run_id=body.baseline_run_id,
    )
    await _mark_promoted_lineages(store, runs, workspace_id=saved.experiment_id, tenant_id=body.tenant_id)
    summary = await store.get_experiment_summary(saved.experiment_id)
    assert summary is not None
    return summary.model_dump(mode="json")


@router.post("/experiments/{experiment_id}/runs/attach")
async def attach_experiment_workspace_runs(
    experiment_id: str,
    body: ExperimentWorkspaceAttachRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    enforce_tenant(request, body.tenant_id)
    experiment = await store.get_experiment(experiment_id, caller_tenant(request))
    if not experiment or not tenants_match(experiment.tenant_id or "", body.tenant_id) or experiment.tags.get("workspace_kind") != "experiment":
        raise HTTPException(status_code=404, detail="Experiment workspace not found")
    existing = await store.list_runs_for_experiment(experiment_id, tenant_id=body.tenant_id)
    failures = await _collect_attach_run_failures(
        store,
        existing_runs=existing,
        run_ids=body.run_ids,
        tenant_id=body.tenant_id,
    )
    if failures:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "experiment_runs_incompatible",
                "message": ("One or more runs cannot join this experiment because they are incomplete or do not share its comparison basis."),
                "details": failures,
            },
        )
    combined_ids = list(dict.fromkeys([run.run_id for run in existing] + list(body.run_ids)))
    # A zero-run workspace still carries its sentinel contract, so the FIRST manual
    # attachment must stamp it exactly like a run-time attachment does. Linking
    # directly would leave ``pending_first_run`` set, and the next run-time attach
    # would then overwrite the workspace basis with a possibly incompatible one.
    if experiment.tags.get("pending_first_run") == "true" and body.run_ids:
        first_run = await store.get_run(body.run_ids[0], tenant_id=body.tenant_id)
        if first_run is not None:
            await store.attach_run_to_experiment_workspace(experiment_id, first_run, tenant_id=body.tenant_id)
    await store.link_runs_to_experiment(experiment_id, combined_ids)
    summary = await store.get_experiment_summary(experiment_id)
    assert summary is not None
    return summary.model_dump(mode="json")


@router.get("/experiments/{experiment_id}")
async def get_experiment(
    experiment_id: str,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    exp = await store.get_experiment(experiment_id, caller_tenant(request))
    if not exp:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, exp.tenant_id)
    return exp.model_dump(mode="json")


class ExperimentPatch(BaseModel):
    """Partial update for experiment governance / contract fields."""

    name: str | None = None
    description: str | None = None
    objective: str | None = None
    hypothesis: str | None = None
    tenant_id: str | None = None
    product_id: str | None = None
    owner: str | None = None
    status: ExperimentStatus | None = None
    tags: dict[str, str] | None = None
    quality_profile_id: str | None = None
    quality_profile_version: str | None = None
    benchmark_package_id: str | None = None
    benchmark_package_version: str | None = None
    target_id: str | None = None
    target_version: str | None = None
    target_version_id: str | None = None
    project_id: str | None = None
    gate_policy_id: str | None = None
    gate_policy_version: str | None = None
    run_manifest_id: str | None = None
    environment: str | None = None
    dataset_version: str | None = None
    target_endpoint: str | None = None
    domain: str | None = None
    market: str | None = None
    judge_model: str | None = None
    judge_temperature: float | None = None
    has_ground_truth: bool | None = None
    safety_defect_tolerance: float | None = None


# Tags the platform assigns and later reads back as invariants. A client able to
# write them could re-open a stamped workspace to any comparison basis, hide a
# lineage from the listing, or forge a promotion, so a patch may neither set nor
# drop them.
RESERVED_EXPERIMENT_TAGS = frozenset({"workspace_kind", "pending_first_run", "promoted_to", "one_off_diagnostic"})


def _reject_forged_approval_status(status: ExperimentStatus | None, *, field: str = "status") -> None:
    """Refuse a caller-supplied ``approved`` status on any create/edit path.

    Approval is a decision-flow outcome, reached only through the
    approver-role + release-eligibility checks in ``create_experiment_decision``
    (and the identical checks ``promote_run`` applies for ``RELEASE_EVIDENCE``).
    Every public path that can persist an experiment's ``status`` -- PATCH,
    create, or anything added later -- must refuse this value the same way,
    so the rule lives in one place instead of being re-derived per endpoint.
    """
    if status != ExperimentStatus.APPROVED:
        return
    raise HTTPException(
        status_code=422,
        detail={
            "code": "reserved_experiment_status",
            "field": field,
            "message": ("Approval is set only by the release decision flow (POST .../decisions), not by create or PATCH."),
        },
    )


@router.patch("/experiments/{experiment_id}")
async def patch_experiment(
    experiment_id: str,
    body: ExperimentPatch,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    existing = await store.get_experiment(experiment_id, caller_tenant(request))
    if not existing:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, existing.tenant_id)
    patch = body.model_dump(exclude_unset=True)
    # Re-tenanting is a hand-over, not an edit; the header must own the new owner too.
    if patch.get("tenant_id"):
        enforce_tenant(request, patch["tenant_id"])
    if "tags" in patch:
        incoming = dict(patch["tags"] or {})
        reserved = sorted(RESERVED_EXPERIMENT_TAGS.intersection(incoming))
        if reserved:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "reserved_experiment_tags",
                    "field": "tags",
                    "message": ("These tags are managed by the platform and cannot be set: " + ", ".join(reserved)),
                },
            )
        patch["tags"] = {
            **incoming,
            **{key: value for key, value in (existing.tags or {}).items() if key in RESERVED_EXPERIMENT_TAGS},
        }
    _reject_forged_approval_status(patch.get("status"))
    updated = await store.update_experiment(experiment_id, existing.tenant_id, patch)
    if not updated:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    return updated.model_dump(mode="json")


@router.get("/experiments/{experiment_id}/summary")
async def get_experiment_summary(
    experiment_id: str,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    summary = await store.get_experiment_summary(experiment_id)
    if not summary:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, summary.experiment.tenant_id)
    return summary.model_dump(mode="json")


@router.get("/experiments/{experiment_id}/runs")
async def list_experiment_runs(
    experiment_id: str,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    experiment = await store.get_experiment(experiment_id, caller_tenant(request))
    if not experiment:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, experiment.tenant_id)
    runs = await store.list_runs_for_experiment(experiment_id, tenant_id=experiment.tenant_id)
    return [r.model_dump(mode="json") for r in runs]


class ExperimentRunRequest(BaseModel):
    """Deprecated saved-evidence rescore request."""

    source_run_id: str | None = None
    row_count: int | None = None
    trigger_reason: TriggerReason = TriggerReason.MANUAL
    correlation_id: str | None = None
    run_type: RunType = RunType.AD_HOC
    created_by: str = "system"
    git_sha: str | None = None
    build_id: str | None = None
    deployment_id: str | None = None
    judge_model: str | None = None
    active_metrics: list[str] | None = None


async def _enqueue_experiment_rescore(
    experiment_id: str,
    opts: ExperimentRunRequest,
    request: Request,
    store: EvaluationStore,
) -> dict[str, Any]:
    if settings.platform_auth_required:
        opts.created_by = actor_from_request(request)
    if not opts.source_run_id:
        raise HTTPException(
            status_code=422,
            detail="source_run_id is required; saved evidence is never selected implicitly",
        )
    source = await store.get_run(opts.source_run_id)
    # Same membership fix as the decision endpoint: a run linked into this
    # experiment via from-runs/attach keeps its original experiment_id, so the
    # link table (not the run's own field) is what "belongs to this
    # experiment" actually means.
    if not source or not await store.experiment_has_run(experiment_id, opts.source_run_id):
        raise HTTPException(
            status_code=404,
            detail="Source run was not found for this saved evaluation",
        )
    enforce_tenant(request, source.experiment.tenant_id)
    run_id = await store.create_rescore_job(
        source_run=source,
        active_metrics=opts.active_metrics,
        judge_model=opts.judge_model,
        created_by=opts.created_by,
    )
    # Same handoff as a dataset launch: in the Temporal runtime nothing polls
    # the PENDING row, so a rescore that was only enqueued never executed.
    await _submit_durable_run(run_id)
    return {
        "run_id": run_id,
        "status": "pending",
        "classification": "diagnostic_only",
        "source_run_id": source.run_id,
        "target_invoked": False,
    }


@router.post("/experiments/{experiment_id}/rescores", status_code=202)
async def create_experiment_rescore(
    experiment_id: str,
    request: Request,
    options: ExperimentRunRequest,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Queue diagnostic scoring over an explicitly named evidence snapshot."""

    return await _enqueue_experiment_rescore(experiment_id, options, request, store)


@router.post("/experiments/{experiment_id}/runs", status_code=202, deprecated=True)
async def create_experiment_run(
    experiment_id: str,
    request: Request,
    options: ExperimentRunRequest | None = None,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Compatibility alias for Rescore saved evidence; never invokes a target."""
    exp = await store.get_experiment(experiment_id, caller_tenant(request))
    if not exp:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")

    return await _enqueue_experiment_rescore(experiment_id, options or ExperimentRunRequest(), request, store)


class VersionCreateRequest(BaseModel):
    """Explicitly snapshot the current experiment contract as a version."""

    created_by: str = "system"
    active_metrics: list[str] | None = None


@router.post("/experiments/{experiment_id}/versions", status_code=201)
async def create_experiment_version(
    experiment_id: str,
    request: Request,
    body: VersionCreateRequest | None = None,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    from proofgrove.evaluation.lineage import compute_experiment_version_id
    from proofgrove.evaluation.scenario_router import build_evaluator_configs

    exp = await store.get_experiment(experiment_id, caller_tenant(request))
    if not exp:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, exp.tenant_id)
    # A workspace waiting for its first run carries sentinel contract fields;
    # there is no basis to snapshot yet.
    if not scenario_value(exp) or exp.tags.get("pending_first_run") == "true":
        raise HTTPException(
            status_code=422,
            detail={
                "code": "workspace_has_no_basis_yet",
                "message": ("This experiment has no comparison basis yet. Attach or run its first run before snapshotting a version."),
            },
        )
    opts = body or VersionCreateRequest()
    if settings.platform_auth_required:
        opts.created_by = actor_from_request(request)
    manifest = None
    if exp.run_manifest_id:
        manifest = await store.get_run_manifest(exp.run_manifest_id, exp.tenant_id)
        if not manifest:
            raise HTTPException(
                status_code=409,
                detail="Experiment references a run manifest that is unavailable for its tenant",
            )
    metrics = opts.active_metrics
    if metrics is None:
        if manifest:
            metrics = list(manifest.metric_ids)
        else:
            active, _, _ = build_evaluator_configs(exp)
            metrics = [m.metric_id for m in active]
    version_id = compute_experiment_version_id(
        exp,
        metrics,
        run_manifest_hash=manifest.manifest_hash if manifest else None,
    )
    contract = {
        "dataset_version": exp.dataset_version,
        "target_endpoint": exp.target_endpoint,
        "scenario": scenario_value(exp),
        "metrics": sorted(metrics),
        "judge_model": exp.judge_model,
        "judge_temperature": exp.judge_temperature,
        "target_id": exp.target_id,
        "target_version": exp.target_version,
        "quality_profile_id": exp.quality_profile_id,
        "quality_profile_version": exp.quality_profile_version,
        "run_manifest_id": manifest.manifest_id if manifest else exp.run_manifest_id,
        "run_manifest_hash": manifest.manifest_hash if manifest else None,
        "metric_evidence_requirements": (manifest.metric_evidence_requirements if manifest else {}),
        "effective_evidence_requirements": (manifest.effective_evidence_requirements if manifest else []),
    }
    saved = await store.save_experiment_version(
        experiment_id=experiment_id,
        experiment_version_id=version_id,
        tenant_id=exp.tenant_id,
        contract_json=contract,
        created_by=opts.created_by,
    )
    return saved.model_dump(mode="json")


@router.get("/experiments/{experiment_id}/versions")
async def list_experiment_versions(
    experiment_id: str,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    exp = await store.get_experiment(experiment_id, caller_tenant(request))
    if not exp:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, exp.tenant_id)
    versions = await store.list_experiment_versions(experiment_id, exp.tenant_id)
    return [v.model_dump(mode="json") for v in versions]


class PromoteRequest(BaseModel):
    role: RunRole


@router.post("/experiments/{experiment_id}/runs/{run_id}/promote")
async def promote_run(
    experiment_id: str,
    run_id: str,
    body: PromoteRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    exp = await store.get_experiment(experiment_id, caller_tenant(request))
    if not exp:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, exp.tenant_id)
    # RELEASE_EVIDENCE is a governance outcome -- the same one the decision
    # endpoint grants only to an approver on an eligible run. Promoting a run
    # to this role through this generic endpoint must clear the identical
    # bar, or it is a side door around /decisions for exactly the runs that
    # endpoint refuses (run_not_governed and friends).
    if body.role == RunRole.RELEASE_EVIDENCE:
        run = await store.get_run(run_id)
        if not run or not await store.experiment_has_run(experiment_id, run_id):
            raise HTTPException(status_code=404, detail=f"Run {run_id} not found for experiment")
        await require_configured_approver_roles(
            request,
            await _approver_roles_for_run(store, run, exp.tenant_id),
        )
        violation = release_gate_violation(run)
        if violation is not None:
            raise HTTPException(status_code=409, detail=violation)
    try:
        # Release evidence and its audit event must commit together.
        link = await store.promote_run(experiment_id, exp.tenant_id, run_id, body.role, commit=body.role != RunRole.RELEASE_EVIDENCE)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    if body.role == RunRole.RELEASE_EVIDENCE:
        await store.record_audit(
            AuditEvent(
                tenant_id=exp.tenant_id,
                actor=actor_from_request(request) if settings.platform_auth_required else "system",
                action="experiment.release_evidence_promoted",
                resource_type="experiment",
                resource_id=experiment_id,
                details={"run_id": run_id},
            )
        )
    return link.model_dump(mode="json")


class BaselinePromoteRequest(BaseModel):
    run_id: str


@router.post("/experiments/{experiment_id}/baseline")
async def promote_baseline(
    experiment_id: str,
    body: BaselinePromoteRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Promote a run to the experiment's baseline and record an audit row."""
    experiment = await store.get_experiment(experiment_id, caller_tenant(request))
    if not experiment:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, experiment.tenant_id)
    try:
        change = await store.promote_baseline(experiment_id, body.run_id, actor=actor_from_request(request))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return change.model_dump(mode="json")


@router.get("/experiments/{experiment_id}/baseline/history")
async def list_baseline_history(
    experiment_id: str,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    """Return the baseline-change audit trail (newest first)."""
    experiment = await store.get_experiment(experiment_id, caller_tenant(request))
    if not experiment:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, experiment.tenant_id)
    changes = await store.list_baseline_changes(experiment_id)
    return [change.model_dump(mode="json") for change in changes]


@router.post("/experiments/{experiment_id}/baseline/undo")
async def undo_baseline(
    experiment_id: str,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Revert the baseline to the previous run; the undo is itself audited."""
    experiment = await store.get_experiment(experiment_id, caller_tenant(request))
    if not experiment:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, experiment.tenant_id)
    try:
        change = await store.undo_baseline(experiment_id, actor=actor_from_request(request))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return change.model_dump(mode="json")


@router.get("/experiments/{experiment_id}/compare")
async def compare_experiment_runs(
    experiment_id: str,
    base_run_id: str,
    candidate_run_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    metric_id: str | None = None,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Compare two runs within an experiment, scoped to the caller's tenant.

    Cross-tenant run ids are treated as not found (404), matching ``get_run``.

    Ownership is decided in the namespace value-space (``tenants_match``), so a
    non-UI caller sending the gateway slug ``evalai`` is accepted exactly like
    the UI's ``tenant-evalai``. The store is then scoped by the owning
    experiment's own tenant value — the spelling its runs are actually persisted
    under — so accepting both forms cannot widen or narrow what is readable.
    """
    enforce_tenant(request, tenant_id)
    experiment = await store.get_experiment(experiment_id, caller_tenant(request))
    if not experiment or not experiment.tenant_id or not tenants_match(experiment.tenant_id, tenant_id):
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    try:
        comparison = await store.compare_runs(
            experiment_id,
            base_run_id,
            candidate_run_id,
            metric_id=metric_id,
            tenant_id=experiment.tenant_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return comparison.model_dump(mode="json")


class DecisionRequest(BaseModel):
    run_id: str
    decision: DecisionType
    approved_by: str
    reason: str | None = None
    expires_at: str | None = None  # ISO datetime



async def _approver_roles_for_run(store: EvaluationStore, run: Any, tenant_id: str) -> list[str]:
    """Roles pinned on the exact Profile and Gate Policy versions of this run."""

    roles: list[str] = []
    if run.quality_profile_id and run.quality_profile_version:
        profile = await store.get_quality_profile(
            run.quality_profile_id, run.quality_profile_version, tenant_id
        )
        if profile:
            roles.extend(profile.approver_roles)
    if run.gate_policy_id and run.gate_policy_version:
        policy = await store.get_gate_policy(
            run.gate_policy_id, run.gate_policy_version, tenant_id
        )
        if policy:
            roles.extend(policy.required_approver_roles)
    return roles


@router.post("/experiments/{experiment_id}/decisions", status_code=201)
async def create_experiment_decision(
    experiment_id: str,
    body: DecisionRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    experiment = await store.get_experiment(experiment_id, caller_tenant(request))
    if not experiment:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, experiment.tenant_id)
    run = await store.get_run(body.run_id)
    # A run linked into this experiment through ``/experiments/from-runs`` or
    # ``/runs/attach`` keeps its ORIGINAL ``experiment_id`` -- linkage lives in
    # the experiment-run link table, not on the run. Gating on the run's own
    # experiment_id 404s every decision on a linked run; the link table is the
    # actual membership record.
    if not run or not await store.experiment_has_run(experiment_id, body.run_id):
        raise HTTPException(status_code=404, detail=f"Run {body.run_id} not found for experiment")
    await require_configured_approver_roles(
        request,
        await _approver_roles_for_run(store, run, experiment.tenant_id),
    )
    violation = release_gate_violation(run)
    if violation is not None:
        raise HTTPException(status_code=409, detail=violation)

    expires = None
    if body.expires_at:
        from datetime import datetime

        expires = datetime.fromisoformat(body.expires_at.replace("Z", "+00:00"))

    decision = ExperimentDecision(
        experiment_id=experiment_id,
        run_id=body.run_id,
        decision=body.decision,
        reason=body.reason,
        approved_by=actor_from_request(request) if settings.platform_auth_required else body.approved_by,
        expires_at=expires,
    )
    # record_audit commits both writes; a failed audit rolls back the request.
    saved = await store.create_decision(decision, experiment.tenant_id, commit=False)
    await store.record_audit(
        AuditEvent(
            tenant_id=experiment.tenant_id,
            actor=saved.approved_by,
            action="experiment.release_decided",
            resource_type="experiment",
            resource_id=experiment_id,
            details={"run_id": body.run_id, "decision": body.decision.value},
        )
    )
    return saved.model_dump(mode="json")


@router.get("/experiments/{experiment_id}/decisions")
async def list_experiment_decisions(
    experiment_id: str,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    exp = await store.get_experiment(experiment_id, caller_tenant(request))
    if not exp:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, exp.tenant_id)
    return [d.model_dump(mode="json") for d in await store.list_decisions(experiment_id, exp.tenant_id)]


@router.post("/experiments/{experiment_id}/archive")
async def archive_experiment(
    experiment_id: str,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    exp = await store.get_experiment(experiment_id, caller_tenant(request))
    if not exp:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, exp.tenant_id)
    updated = await store.archive_experiment(experiment_id, exp.tenant_id)
    if not updated:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    return updated.model_dump(mode="json")


#: Attestations the engine derives from what it observed during execution.
#: They are not caller-supplied data, and the engine trusts them: a row
#: asserting `tool_evidence_completion_attested` is how it decides that no tool
#: call occurred rather than that tool evidence went missing. Direct ingestion
#: cannot witness an execution, so it cannot attest to one.
_EXECUTION_ATTESTED_FIELDS = (
    "trace_completion_attested",
    "model_usage_completion_attested",
    "lifecycle_completion_attested",
    "tool_evidence_completion_attested",
    "tool_evidence_provenance_status",
    "tool_evidence_source",
    "from_agent",
)


def _without_claimed_attestation(row: EvaluationRow) -> EvaluationRow:
    """Return the row with every execution-derived attestation back at its default."""
    defaults = {
        field: EvaluationRow.model_fields[field].get_default(call_default_factory=True)
        for field in _EXECUTION_ATTESTED_FIELDS
    }
    return row.model_copy(update=defaults)


@router.post("/experiments/{experiment_id}/rows", status_code=201)
async def add_rows(
    experiment_id: str,
    rows: list[EvaluationRow],
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    exp = await store.get_experiment(experiment_id, caller_tenant(request))
    if not exp:
        raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
    enforce_tenant(request, exp.tenant_id)
    count = await store.add_rows(experiment_id, exp.tenant_id, [_without_claimed_attestation(row) for row in rows])
    return {"experiment_id": experiment_id, "added": count}


@router.get("/experiments/{experiment_id}/rows")
async def get_experiment_rows(
    experiment_id: str,
    request: Request,
    include_samples: bool = True,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    """Return an experiment's rows.

    Falls back to built-in sample rows only for known sample experiment IDs and
    only when ``include_samples`` is true (default). For a real experiment with
    no rows this returns ``[]`` rather than silently substituting sample data.
    """
    # Preserve the existing "unknown/real experiment with no rows -> []"
    # contract (P1-15) for an experiment_id the store has never heard of;
    # only enforce tenant ownership once an experiment actually exists.
    exp = await store.get_experiment(experiment_id, caller_tenant(request))
    if exp:
        enforce_tenant(request, exp.tenant_id)
    rows = await store.get_rows(experiment_id, caller_tenant(request))
    if not rows and include_samples and get_sample_experiment(experiment_id):
        rows = get_sample_rows(experiment_id)
    return [r.model_dump() for r in rows]


@router.post("/runs", status_code=201)
async def create_run(
    experiment: ExperimentDefinition,
    request: Request,
    trigger_reason: TriggerReason = TriggerReason.MANUAL,
    correlation_id: str | None = None,
    store: EvaluationStore = Depends(get_evaluation_store),
    engine: EvaluationEngine = Depends(get_evaluation_engine),
) -> dict[str, Any]:
    """Execute an evaluation run; rows from DB or generic samples."""
    exp_id = experiment.experiment_id or ""
    requested_tenant_id = experiment.tenant_id or caller_tenant(request)
    experiment = experiment.model_copy(update={"tenant_id": requested_tenant_id})
    enforce_tenant(request, requested_tenant_id)
    # Same forgery this model is exposed to on POST /experiments: a run body
    # for a not-yet-persisted experiment_id is what save_run uses to create
    # the experiment row (see EvaluationStore.save_run's "not exp_orm" branch),
    # so this is a second, equally direct path to the same caller-supplied
    # ``status`` field.
    _reject_forged_approval_status(experiment.status)
    rows = await store.get_rows(exp_id, requested_tenant_id) if exp_id else []

    if not rows and exp_id:
        sample = get_sample_experiment(exp_id)
        if sample:
            # Preserve the caller's tenant on the sample so the resulting run is
            # tenant-scoped. Sample experiment ids are shared fixtures, and a
            # run's tenant is derived from its experiment row — so a foreign
            # tenant must get its OWN experiment row (namespaced id), never
            # claim or share the fixture row. Otherwise the first caller's
            # tenant would own every other tenant's sample runs.
            if requested_tenant_id and not tenants_match(requested_tenant_id, SAMPLE_TENANT_ID):
                experiment = sample.model_copy(
                    update={
                        "tenant_id": requested_tenant_id,
                        "experiment_id": f"{exp_id}--{requested_tenant_id}",
                    }
                )
            else:
                experiment = sample
            rows = get_sample_rows(exp_id)

    if not rows:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "evaluation_rows_missing",
                "field": "experiment_id",
                "message": "No evaluation rows found for this experiment.",
                "recovery": ("Add rows via POST /experiments/{id}/rows or use a sample experiment_id (exp-llm-core-v1, exp-rag-v1, exp-agentic-v1)."),
            },
        )

    # Same forgery this model is exposed to on POST /experiments: save_run's
    # "not exp_orm" branch persists this experiment (including created_by)
    # verbatim on first-time creation.
    if settings.platform_auth_required:
        experiment = experiment.model_copy(update={"created_by": actor_from_request(request)})

    if experiment.row_count:
        rows = rows[: experiment.row_count]
    if len(rows) > MAX_ROWS_PER_DATASET:
        # This route executes inline on the request's threadpool worker. A
        # golden dataset is already capped at this many rows; an experiment's
        # rows were not, so one request could hold a worker for hours.
        raise HTTPException(
            status_code=422,
            detail={
                "code": "evaluation_rows_exceed_limit",
                "field": "row_count",
                "message": f"This experiment has {len(rows)} rows; a synchronous run evaluates at most {MAX_ROWS_PER_DATASET}.",
                "recovery": f"Set row_count to at most {MAX_ROWS_PER_DATASET}, or launch the evaluation from a golden dataset so it runs asynchronously.",
            },
        )

    emit(
        EvalEvent.EVALUATION_TRIGGERED,
        correlation_id=correlation_id,
        experiment_id=experiment.experiment_id,
        dataset_version=experiment.dataset_version,
        trigger_reason=trigger_reason.value,
        row_count=len(rows),
    )
    manifest = None
    if experiment.run_manifest_id:
        manifest = await store.get_run_manifest(experiment.run_manifest_id, requested_tenant_id)
        if manifest is None:
            raise HTTPException(status_code=409, detail="Experiment's pinned manifest is unavailable")
    result = await run_in_threadpool(
        engine.execute, experiment, rows, None, trigger_reason, correlation_id, manifest=manifest
    )
    await store.save_run(result, rows)
    saved = await store.get_run(result.run_id)
    assert saved is not None
    return saved.model_dump(mode="json")


class DatasetRunRequest(BaseModel):
    """Options for evaluating a golden dataset."""

    # User-facing name used to group runs on Monitor / Experiments.
    evaluation_name: str | None = None
    # Optional user annotation shown on Monitor / Experiments.
    # ``name`` is kept as a back-compat alias for ``label``.
    label: str | None = None
    # Declared here, with the client that starts sending it. Pydantic's default
    # extra='ignore' meant an undeclared field was dropped in silence: the setup
    # screen accepted several labels, the draft kept them, and only the first
    # one — carried by the legacy `label` — ever reached the server.
    labels: list[str] | None = None
    name: str | None = None
    response_source: str = "baseline"  # baseline | provided | agent | llm
    # Required when response_source="agent": the target agent reference
    # "<namespace>/<name>" (from GET /agents). The runner invokes it per row.
    agent: str | None = None
    # Used when response_source="llm": OpenAI-compatible base URL (AI Gateway or
    # custom). When omitted / llm-catalog:*, settings.openai_base_url is used.
    target_endpoint: str | None = None
    # Required when response_source="llm": catalogue model id (sent as model +
    # x-model-id for Compass / AI Gateway routing).
    target_model: str | None = None
    # Optional system prompt for `response_source="llm"`. Sent verbatim ahead of
    # the row's question, and recorded on lineage as a hash so two runs can be
    # told apart by prompt without Proofgrove storing prompts.
    system_prompt: str | None = None
    #: `prompt-id@version` or `prompt-id@label` from the prompt library. A label
    #: is resolved to its concrete version at enqueue, and that version is what
    #: the run records — a run that only remembered `@production` would become
    #: unreadable the moment the label moved.
    prompt_version_ref: str | None = None
    judge_model: str | None = None
    row_count: int | None = None
    active_metrics: list[str] | None = None
    enable_llm_judge: bool = True
    parallel_requests: int = 5
    run_human_review: bool = True
    quality_contract_ids: list[str] = Field(default_factory=list)
    # The REQUESTED evaluation depth chosen by the user (final answer, tool
    # interactions, or full execution lifecycle). Requested depth and captured
    # evidence availability are separate: metrics/contract requirements may
    # promote the resolved scope beyond it (reported via
    # scope_promotion_reasons), and an unavailable depth yields a structured
    # readiness blocker — never a silent replacement.
    evaluation_scope: EvaluationScope = EvaluationScope.FINAL_RESPONSE
    # Selected-tools evaluation level: names the tools this run evaluates. Only
    # meaningful with evaluation_scope=tool_interactions (any other depth is a
    # structured 422). ``None`` means the whole tool layer; the ids must be a
    # subset of the resolved agent's declared tools (unknown names are a
    # structured 422 naming them) and persist through readiness, execution,
    # lineage, reports, reruns, and the comparison basis.
    selected_tool_ids: list[str] | None = None
    # Set only when replaying an immutable historical run: preserves that run's
    # requested scope instead of deriving a fresh one. Requires ``source_run_id``
    # naming the historical run; the endpoint replays THAT run's recorded
    # requested scope — a client-supplied scope that differs is still rejected.
    exact_rerun: bool = False
    # The historical run whose recorded requested scope an exact rerun replays.
    source_run_id: str | None = None
    # Optional tenant system Project used by Projects -> Tracing. Catalog
    # registry projects are never valid run containers.
    project_id: str | None = None
    # Explicit Assignment identity. Diagnostic runs omit both. Standardized and
    # release-governed runs must name the exact version — never inferred from
    # project or target.
    assignment_id: str | None = None
    assignment_version: str | None = None
    trigger_reason: TriggerReason = TriggerReason.MANUAL
    correlation_id: str | None = None

    @field_validator("assignment_id", "assignment_version", mode="before")
    @classmethod
    def _blank_assignment_identity(cls, value: str | None) -> str | None:
        if isinstance(value, str) and not value.strip():
            return None
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def _normalize_labels(self) -> "DatasetRunRequest":
        # ``labels`` is canonical when supplied, even if empty; otherwise the
        # legacy ``label`` / ``name`` input becomes a one-label list. ``label``
        # is then derived from the first canonical label for older clients.
        self.label, self.labels = normalize_run_labels(label=self.label, labels=self.labels, name=self.name)
        self.name = self.label
        return self


def _refuse_manifest_owned_overrides(opts: DatasetRunRequest, manifest: Any | None) -> None:
    """Refuse a launch that supplies inputs the Assignment's manifest owns.

    The manifest won silently: a caller could send `active_metrics`, watch the
    manifest's list replace it, and get a run scored against checks it never
    asked for while its own request was recorded only as
    `requested_active_metrics`. The UI hides this by disabling the fields; the
    API did not, so anything that is not the UI was misled rather than stopped.

    `evaluation_scope` is deliberately not checked here. It carries a non-null
    default, so a caller that never mentions scope still sends
    FINAL_RESPONSE, and refusing on mismatch would reject every governed run
    whose manifest asks for a deeper one. Closing that half means making the
    field optional first, which changes the request model.
    """
    if manifest is None or opts.active_metrics is None:
        return
    if list(opts.active_metrics) == list(manifest.metric_ids):
        return
    raise HTTPException(
        status_code=422,
        detail={
            "code": "assignment_owns_active_metrics",
            "field": "active_metrics",
            "message": (
                "The selected Assignment's manifest decides which checks run, so "
                "active_metrics cannot be supplied alongside it."
            ),
            "recovery": (
                "Omit active_metrics to use the Assignment's checks, or launch "
                "without an Assignment to choose them yourself."
            ),
        },
    )


async def _bind_explicit_assignment(
    opts: DatasetRunRequest,
    request: Request,
    store: EvaluationStore,
) -> tuple[EvaluationAssignmentVersion | None, ResolvedRunManifest | None]:
    """Load an explicit Assignment. Never infer one from Project or target."""

    if not opts.assignment_id and not opts.assignment_version:
        return None, None
    if not opts.assignment_id or not opts.assignment_version:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "assignment_version_required",
                "field": "assignment_version" if opts.assignment_id else "assignment_id",
                "message": "An Assignment must be selected by id and exact version.",
                "recovery": "Choose an Assignment version from Evaluation governance, or leave both fields empty for a diagnostic run.",
            },
        )
    if opts.quality_contract_ids:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "assignment_and_templates_conflict",
                "field": "quality_contract_ids",
                "message": "A run cannot use both an Assignment and rubric templates.",
                "recovery": "Clear rubric templates when launching with an Assignment, or launch a diagnostic run without an Assignment.",
            },
        )
    tenant_id = caller_tenant(request)
    assignment = await store.get_assignment(
        opts.assignment_id,
        opts.assignment_version,
        tenant_id,
    )
    if assignment is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "assignment_not_found",
                "field": "assignment_id",
                "message": "Selected Assignment version was not found.",
                "recovery": "Choose an Assignment that still exists in this tenant.",
            },
        )
    if assignment.archived_at is not None:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "assignment_archived",
                "field": "assignment_id",
                "message": "Selected Assignment is archived and cannot launch new runs.",
                "recovery": "Restore the Assignment or choose another version.",
            },
        )
    if opts.project_id and opts.project_id != assignment.project_id:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "assignment_project_mismatch",
                "field": "project_id",
                "message": "The selected Project does not match this Assignment.",
                "recovery": "Leave Project empty or choose the Assignment's Project.",
            },
        )
    opts.project_id = assignment.project_id
    manifest = await store.get_run_manifest(assignment.run_manifest_id, tenant_id)
    if manifest is None:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "assignment_manifest_missing",
                "field": "assignment_id",
                "message": "The Assignment's resolved run manifest is missing.",
                "recovery": "Create a new Assignment revision so a manifest can be resolved again.",
            },
        )
    return assignment, manifest


async def _apply_exact_rerun_contract(
    opts: DatasetRunRequest,
    request: Request,
    store: EvaluationStore,
) -> DatasetRunRequest:
    """Prove and replay a historical run before exact_rerun may bypass anything.

    ``exact_rerun`` is only honoured with a ``source_run_id`` naming an existing
    run in the caller's tenant; the returned options carry THAT run's recorded
    requested scope. A client-supplied scope that differs from the source run's
    recorded scope is rejected — exact_rerun never lets a caller choose a fresh
    evidence depth.
    """

    if not opts.exact_rerun:
        return opts
    if not opts.source_run_id:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "exact_rerun_source_required",
                "message": ("exact_rerun requires source_run_id naming the historical run whose recorded requested scope is being replayed."),
            },
        )
    source = await store.get_run(opts.source_run_id)
    # Resolve identity the way every other guard does — reading the raw header
    # here let a header-less in-cluster caller replay any tenant's run.
    caller = caller_tenant(request)
    if source is None or not tenants_match(caller, source.experiment.tenant_id or ""):
        # A run owned by another tenant is indistinguishable from a missing one.
        raise HTTPException(
            status_code=404,
            detail={
                "code": "exact_rerun_source_not_found",
                "message": f"Source run {opts.source_run_id} was not found.",
            },
        )
    lineage = source.lineage
    recorded_scope = (lineage.requested_evaluation_scope or lineage.evaluation_scope) if lineage else None
    if recorded_scope is None:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "exact_rerun_scope_unrecorded",
                "message": ("The source run has no recorded requested evaluation scope, so it cannot be replayed exactly."),
            },
        )
    if "evaluation_scope" in opts.model_fields_set and opts.evaluation_scope != recorded_scope:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "exact_rerun_scope_mismatch",
                "message": (
                    "exact_rerun replays the source run's recorded requested "
                    f"scope '{recorded_scope.value}', not "
                    f"'{opts.evaluation_scope.value}'. Omit evaluation_scope (or "
                    "echo the recorded scope) to replay it, or start a normal "
                    "run to choose a different depth."
                ),
            },
        )
    recorded_selection = lineage.selected_tool_ids if lineage else None
    recorded_assignment_id = lineage.assignment_id if lineage else None
    recorded_assignment_version = lineage.assignment_version if lineage else None
    recorded_prompt_ref = lineage.target_prompt_ref if lineage else None
    recorded_prompt_hash = lineage.target_prompt_hash if lineage else None

    # An exact rerun that quietly used a different prompt would break the only
    # promise the name makes.
    if opts.prompt_version_ref and opts.prompt_version_ref != recorded_prompt_ref:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "exact_rerun_prompt_mismatch",
                "field": "prompt_version_ref",
                "message": (
                    "exact_rerun replays the source run's prompt "
                    f"{recorded_prompt_ref or '(none)'}, not a fresh one. Omit "
                    "prompt_version_ref to replay it, or start a normal run to "
                    "use a different prompt."
                ),
            },
        )
    if opts.system_prompt and hash_system_prompt(opts.system_prompt) != recorded_prompt_hash:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "exact_rerun_prompt_mismatch",
                "field": "system_prompt",
                "message": (
                    "The supplied prompt is not the one this run used. Omit it "
                    "to replay the recorded prompt, or start a normal run."
                ),
            },
        )
    if recorded_prompt_hash and not recorded_prompt_ref and not opts.system_prompt:
        # The run used ad-hoc text. Only its digest survives, so the text
        # cannot be reconstructed — say so rather than replaying without it.
        raise HTTPException(
            status_code=422,
            detail={
                "code": "exact_rerun_prompt_unavailable",
                "field": "system_prompt",
                "message": (
                    "This run used a prompt that was typed rather than saved, so "
                    "only its fingerprint was kept. Supply the same text to replay "
                    "it exactly, or save it to the prompt library first."
                ),
            },
        )
    if "selected_tool_ids" in opts.model_fields_set and _tool_selections_differ(
        opts.selected_tool_ids, recorded_selection
    ):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "exact_rerun_selected_tools_mismatch",
                "field": "selected_tool_ids",
                "message": (
                    "exact_rerun replays the source run's recorded tool "
                    f"selection {recorded_selection if recorded_selection is not None else '(whole tool layer)'}, "
                    "not a fresh one. Omit selected_tool_ids (or echo the "
                    "recorded selection) to replay it, or start a normal run "
                    "to choose different tools."
                ),
            },
        )
    # The governance the source ran under is part of "exactly again". Replaying
    # scope, tools and prompt while dropping the Assignment produced an
    # ungoverned twin of a governed run: the pair looked comparable and only one
    # of them could support a release decision.
    if (opts.assignment_id or opts.assignment_version) and (
        opts.assignment_id != recorded_assignment_id
        or opts.assignment_version != recorded_assignment_version
    ):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "exact_rerun_assignment_conflict",
                "message": (
                    "exact_rerun replays the source run's Assignment "
                    f"{recorded_assignment_id or '(none)'}"
                    f"{'@' + recorded_assignment_version if recorded_assignment_version else ''}"
                    ", not a different one. Omit the assignment (or echo the "
                    "recorded one) to replay it, or start a normal run to "
                    "evaluate under different governance."
                ),
            },
        )
    return opts.model_copy(
        update={
            "evaluation_scope": recorded_scope,
            "selected_tool_ids": recorded_selection,
            "prompt_version_ref": recorded_prompt_ref,
            "assignment_id": recorded_assignment_id,
            "assignment_version": recorded_assignment_version,
        }
    )


def _tool_selections_differ(
    supplied: list[str] | None,
    recorded: list[str] | None,
) -> bool:
    """Order-insensitive inequality; ``None`` (whole layer) never equals a list."""

    if (supplied is None) != (recorded is None):
        return True
    if supplied is None:
        return False
    return sorted(supplied) != sorted(recorded or [])


def _validate_selected_tools(opts: DatasetRunRequest) -> DatasetRunRequest:
    """Enforce the selected-tools contract before any readiness resolution.

    A named-tool selection is only meaningful for the tool-interactions depth,
    and an empty selection is a contradiction (it would silently mean "evaluate
    no tool layer") — both are structured 422s. Names are trimmed and
    de-duplicated; membership in the agent's declared inventory is validated by
    readiness once the agent is resolved.
    """

    if opts.selected_tool_ids is None:
        return opts
    cleaned = [tool.strip() for tool in opts.selected_tool_ids]
    if not cleaned or any(not tool for tool in cleaned):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "selected_tools_empty" if not cleaned else "selected_tools_invalid",
                "field": "selected_tool_ids",
                "message": ("selected_tool_ids must name at least one tool" if not cleaned else "selected_tool_ids must not contain blank tool names"),
                "recovery": "Pick one or more of the agent's declared tools, or omit selected_tool_ids to evaluate the whole tool layer.",
            },
        )
    # Both tool-requiring depths accept a named-tool scope: full execution grades
    # the same tool evidence, so rejecting it there had no structural basis and
    # meant a selection made at the shallower depth was silently widened to the
    # whole tool layer when the depth changed, with nothing recording the drop.
    if opts.evaluation_scope not in (
        EvaluationScope.TOOL_INTERACTIONS,
        EvaluationScope.FULL_EXECUTION,
    ):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "selected_tools_scope_mismatch",
                "field": "selected_tool_ids",
                "message": (
                    "selected_tool_ids requires a depth that inspects tool "
                    "evidence; the requested scope is "
                    f"'{opts.evaluation_scope.value}'."
                ),
                "recovery": "Choose the Tool interactions or Full execution depth, or omit selected_tool_ids.",
            },
        )
    return opts.model_copy(update={"selected_tool_ids": list(dict.fromkeys(cleaned))})


def _scope_options(
    opts: DatasetRunRequest,
    readiness: EvidenceReadinessResult | None = None,
) -> list[dict[str, Any]]:
    """Per-depth availability for the UI, with the exact backend reason.

    Availability here mirrors the structural readiness rules that depend only on
    the selected target source and platform capabilities — the same checks that
    would surface as ``unsupported`` readiness details if that depth were
    requested. Deeper, target-specific checks (e.g. a BYO agent without tool
    capture) still surface through the readiness result for the requested depth.
    """

    local_target = opts.response_source == "agent" and is_local_agent(opts.agent, settings)
    options = scope_options(
        response_source=opts.response_source,
        tool_completion_available=local_target or tool_evidence_attestation_available(settings),
        agent_tools=readiness.agent_tools if readiness else None,
    )
    if local_target:
        # These bounded workflows capture every tool they execute directly.
        # That proves tool evidence completeness, not a production OTEL archive.
        for option in options:
            if option["scope"] == EvaluationScope.FULL_EXECUTION.value:
                option.update(available=False, reason="Local workflow agents capture tool calls and responses. Full execution requires an integrated lifecycle trace archive.")
    return options


def _readiness_http_error(readiness, scope_options: list[dict[str, Any]] | None = None) -> HTTPException:
    status_code = {
        EvidenceReadiness.UNSUPPORTED: 409,
        EvidenceReadiness.BLOCKED: 422,
        EvidenceReadiness.UNKNOWN: 503,
    }[readiness.status]
    detail = readiness.model_dump(mode="json")
    first = readiness.details[0] if readiness.details else None
    field_by_code = {
        "contract_metric_not_applicable": "active_metrics",
        "metric_execution_unavailable": "active_metrics",
        "tool_evidence_unsupported": "evaluation_scope",
        "dataset_empty": "dataset_name",
        "dataset_input_missing": "dataset_name",
        "provided_output_missing": "dataset_name",
        "target_model_missing": "target_model",
        "llm_endpoint_missing": "target_endpoint",
        "source_unsupported": "response_source",
        "agent_missing": "agent",
        "agent_discovery_unavailable": "agent",
        "agent_not_found": "agent",
        "agent_not_ready": "agent",
        "agent_tool_capture_unsupported": "evaluation_scope",
        "target_drift": "agent",
        "tool_capture_completion_unavailable": "evaluation_scope",
        "selected_tools_unknown": "selected_tool_ids",
        "selected_tools_unverifiable": "selected_tool_ids",
    }
    recovery_by_field = {
        "active_metrics": "Remove the unavailable check or choose a compatible target, dataset, and rubric.",
        "evaluation_scope": "Choose an available evaluation depth or connect the required evidence capture path.",
        "dataset_name": "Choose a compatible published dataset and fix the named case data.",
        "target_model": "Select an available LLM model.",
        "target_endpoint": "Select a target with a configured invocation endpoint.",
        "response_source": "Choose a supported evaluation target.",
        "agent": "Select an available, ready agent whose evidence capabilities match this setup.",
        "selected_tool_ids": "Pick tools from the agent's declared inventory, or omit the selection to evaluate the whole tool layer.",
    }
    field = field_by_code.get(first.code) if first else None
    detail.update(
        {
            "code": first.code if first else f"evidence_readiness_{readiness.status.value}",
            "message": first.message if first else "This evaluation setup is not ready to run.",
            **({"field": field} if field else {}),
            **({"recovery": recovery_by_field[field]} if field else {}),
        }
    )
    if scope_options is not None:
        detail["scope_options"] = scope_options
    return HTTPException(status_code=status_code, detail=detail)


def compatible_project_types(response_source: str) -> set[str]:
    """Project ``system_type`` values accepted for a run ``response_source``.

    ``application`` is the safe general default compatible with agent and llm
    sources. ``rag`` is an explicit map key so RAG sources are not exact-match
    only.
    """
    source = (response_source or "").lower()
    return {
        "agent": {"agent", "application"},
        "llm": {"llm", "application", "endpoint"},
        "rag": {"rag", "application"},
        "provided": {"application", "rag", "rag_system", "agent", "llm"},
        "baseline": {"application", "rag", "rag_system", "agent", "llm"},
    }.get(source, {source})


async def _validate_explicit_project_binding(
    opts: DatasetRunRequest,
    request: Request,
    store: EvaluationStore,
) -> str | None:
    """Apply explicit Project compatibility without inventing an assignment."""

    if not opts.project_id:
        return None
    project = await store.get_project(opts.project_id)
    if not project:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "project_not_found",
                "field": "project_id",
                "message": "Selected Project was not found.",
                "recovery": "Choose an active Project shown in the Projects workspace.",
            },
        )
    enforce_tenant(request, project.tenant_id)
    if project.status != ProjectStatus.ACTIVE:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "project_not_active",
                "field": "project_id",
                "message": "Selected Project is archived and cannot receive new evaluation runs.",
                "recovery": "Choose an active Project shown in the Projects workspace.",
            },
        )
    if project.purpose != ProjectPurpose.SYSTEM:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "project_not_system",
                "field": "project_id",
                "message": "Selected Project is an internal catalog registry, not a system tracing workspace.",
                "recovery": "Choose an active system Project shown in the Projects workspace.",
            },
        )
    compatible_types = compatible_project_types(opts.response_source)
    if project.system_type.lower() not in compatible_types:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "project_type_incompatible",
                "field": "project_id",
                "message": (f"Selected Project type '{project.system_type}' is incompatible with response source '{opts.response_source}'."),
                "recovery": "Choose a Project for the selected target type or leave the run unassigned.",
            },
        )
    return project.project_id


def _resolve_dataset_run_configuration(
    opts: DatasetRunRequest,
    scenario: Scenario,
) -> ResolvedScoringConfiguration:
    """Resolve and validate the exact scoring contract before enqueue."""

    known_metrics = {metric.metric_id for metric in list_metrics()}
    unknown_metrics = sorted(set(opts.active_metrics or []) - known_metrics)
    if unknown_metrics:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "unknown_metrics",
                "field": "active_metrics",
                "message": f"Unknown metric(s): {', '.join(unknown_metrics)}.",
                "recovery": "Refresh the check catalog and remove checks that are no longer available.",
            },
        )

    unknown_templates = sorted(set(opts.quality_contract_ids) - set(QUALITY_CONTRACT_TEMPLATE_BY_ID))
    if unknown_templates:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "unknown_rubric_templates",
                "field": "quality_contract_ids",
                "message": f"Unknown rubric template(s): {', '.join(unknown_templates)}.",
                "recovery": "Refresh rubric templates and remove templates that are no longer available.",
            },
        )

    resolved_metrics = resolve_active_metrics(
        opts.active_metrics,
        opts.quality_contract_ids,
        scenario=scenario,
        has_ground_truth=True,
    )
    if resolved_metrics is None:
        resolved_metrics = [
            metric.metric_id
            for metric in select_metrics(
                scenario,
                has_ground_truth=True,
                metric_ids=None,
            )
        ]
    template_snapshots = [QUALITY_CONTRACT_TEMPLATE_BY_ID[template_id].model_dump(mode="json") for template_id in sorted(opts.quality_contract_ids)]
    explicit_metric_ids = set(opts.active_metrics or [])
    explicit_metric_ids.update(snapshot["metric_id"] for snapshot in template_snapshots)
    try:
        return resolve_scoring_configuration(
            metric_ids=resolved_metrics,
            explicit_metric_ids=explicit_metric_ids,
            scenario=scenario,
            evaluation_scope=opts.evaluation_scope,
            quality_contract_template_snapshots=template_snapshots,
        )
    except ContractResolutionError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "scoring_contract_unresolvable",
                "field": "active_metrics",
                "message": str(exc),
                "recovery": ("Remove the incompatible checks or choose a target and evaluation depth that support them."),
            },
        ) from exc


async def _dataset_readiness(
    dataset_name: str,
    opts: DatasetRunRequest,
    registry: DatasetRegistryService,
    request: Request,
    manifest: ResolvedRunManifest | None = None,
):
    # The caller-chosen depth is honoured as the REQUESTED scope. A depth this
    # source can never satisfy — any tool-requiring depth for a non-agent source
    # — resolves to a fast, dataset-independent readiness result carrying the
    # exact structured blocker: never a blanket rejection and never a silent
    # replacement with another depth.
    # Authorization comes before the structural early-return below. Those
    # branches are UNSUPPORTED today, so nothing leaks — but leaving tenant
    # isolation resting on that capability invariant means one new READY branch
    # would silently open cross-tenant reads. Authorize the name first whenever
    # it resolves; a dataset that does not exist keeps each path's own,
    # more specific error.
    try:
        early_info = await run_in_threadpool(registry.get_dataset, dataset_name, caller_tenant(request))
    except DatasetNotFoundError:
        early_info = None
    if early_info is not None:
        authorize_dataset_access(request, early_info.tenant_id)

    # A dataset-independent answer is only honest when the setup cannot work
    # whatever the dataset holds — a non-agent source can never supply
    # tool-interaction evidence. An agent at full-execution depth is a real
    # request: it must load the dataset and face the same emptiness, input,
    # discovery and drift checks as every other scope, not a synthetic record.
    if opts.evaluation_scope in (EvaluationScope.TOOL_INTERACTIONS, EvaluationScope.FULL_EXECUTION) and opts.response_source != "agent":
        scoring_configuration = None if manifest else _resolve_dataset_run_configuration(
            opts,
            Scenario.LLM_CORE,
        )
        metric_ids = manifest.metric_ids if manifest else scoring_configuration.metric_ids
        evaluation_scope = (manifest.evaluation_scope or scoring_configuration.evaluation_scope) if manifest else scoring_configuration.evaluation_scope
        promotion = manifest.scope_promotion_reasons if manifest else scoring_configuration.scope_promotion_reasons
        evidence = manifest.metric_evidence_requirements if manifest else scoring_configuration.metric_evidence_requirements
        requirements = manifest.effective_evidence_requirements if manifest else scoring_configuration.effective_evidence_requirements
        metric_requirements = (
            [item.model_dump(mode="json") for item in manifest.metric_requirements]
            if manifest
            else [item.model_dump(mode="json") for item in scoring_configuration.metric_requirements]
        )
        readiness = await assess_evidence_readiness(
            response_source=opts.response_source,
            evaluation_scope=evaluation_scope,
            requested_evaluation_scope=opts.evaluation_scope,
            scope_promotion_reasons=promotion,
            agent=opts.agent,
            target_model=opts.target_model,
            target_endpoint=opts.target_endpoint,
            judge_model=opts.judge_model,
            enable_llm_judge=opts.enable_llm_judge,
            resolved_metric_definitions=manifest.metric_definitions if manifest else scoring_configuration.metric_definitions,
            records=[{"inputs": {"query": "capability-check"}}],
            active_metric_ids=metric_ids,
            scenario=manifest.scenario if manifest else Scenario.LLM_CORE,
            settings=settings,
            resolved_metric_evidence_requirements=evidence,
            resolved_evidence_requirements=requirements,
            resolved_metric_requirements=metric_requirements,
            selected_tool_ids=opts.selected_tool_ids,
        )
        return None, [], (manifest.scenario if manifest else Scenario.LLM_CORE), readiness, scoring_configuration

    try:
        info = await run_in_threadpool(registry.get_dataset, dataset_name, caller_tenant(request))
        # Both run-from-dataset routes take a caller-supplied dataset name.
        # Without this a caller could launch a run over another tenant's dataset
        # and read its questions and expected outputs back out through the run.
        # Checked against the fetch above, before the records are returned to
        # this handler. (``info.tenant_id`` on purpose, not a defaulted getattr:
        # a model change should fail loudly, never resolve to "allow".)
        authorize_dataset_access(request, info.tenant_id)
        records = await run_in_threadpool(registry.get_records, dataset_name, info.tenant_id)
        if opts.row_count:
            # Match run_service.execute_dataset_run's slice exactly: readiness
            # must analyze only the rows the worker will actually run, in the
            # same order, or a row excluded by the limit can block a subset
            # run it will never touch.
            records = records[: opts.row_count]
    except HTTPException:
        # The guard's own status (404 refusal, or 401 for a missing header
        # under platform auth) must pass through unrewritten, exactly as the
        # datasets router behaves.
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=404,
            detail={
                "code": "dataset_not_found",
                "field": "dataset_name",
                "message": f"Dataset '{dataset_name}' was not found.",
                "recovery": "Choose a published dataset that still exists in this tenant.",
            },
        ) from exc

    status = getattr(info, "status", None)
    status_value = status.value if hasattr(status, "value") else status
    if status_value != "PUBLISHED":
        raise HTTPException(
            status_code=422,
            detail={
                "code": "dataset_not_published",
                "field": "dataset_name",
                "message": (f"Dataset '{dataset_name}' is {status_value or 'unknown'}; only PUBLISHED datasets can be evaluated."),
                "recovery": "Publish the dataset under Datasets or choose another published dataset.",
            },
        )
    scenario = (
        manifest.scenario
        if manifest is not None
        else resolve_scenario(
            response_source=opts.response_source,
            target_type=opts.response_source,
        )
    )
    scoring_configuration = None if manifest else _resolve_dataset_run_configuration(opts, scenario)
    metric_ids = manifest.metric_ids if manifest else scoring_configuration.metric_ids
    evaluation_scope = (
        (manifest.evaluation_scope or opts.evaluation_scope)
        if manifest
        else scoring_configuration.evaluation_scope
    )
    promotion = manifest.scope_promotion_reasons if manifest else scoring_configuration.scope_promotion_reasons
    evidence = manifest.metric_evidence_requirements if manifest else scoring_configuration.metric_evidence_requirements
    requirements = manifest.effective_evidence_requirements if manifest else scoring_configuration.effective_evidence_requirements
    metric_requirements = (
        [item.model_dump(mode="json") for item in manifest.metric_requirements]
        if manifest
        else [item.model_dump(mode="json") for item in scoring_configuration.metric_requirements]
    )
    readiness = await assess_evidence_readiness(
        response_source=opts.response_source,
        evaluation_scope=evaluation_scope,
        requested_evaluation_scope=opts.evaluation_scope,
        scope_promotion_reasons=promotion,
        agent=opts.agent,
        target_model=opts.target_model,
        target_endpoint=opts.target_endpoint,
        judge_model=opts.judge_model,
        enable_llm_judge=opts.enable_llm_judge,
        resolved_metric_definitions=manifest.metric_definitions if manifest else scoring_configuration.metric_definitions,
        records=records,
        active_metric_ids=metric_ids,
        scenario=scenario,
        settings=settings,
        resolved_metric_evidence_requirements=evidence,
        resolved_evidence_requirements=requirements,
        resolved_metric_requirements=metric_requirements,
        selected_tool_ids=opts.selected_tool_ids,
    )
    return info, records, scenario, readiness, scoring_configuration


@router.post("/runs/from-dataset/{dataset_name}/readiness")
async def get_dataset_run_readiness(
    dataset_name: str,
    request: Request,
    options: DatasetRunRequest | None = None,
    store: EvaluationStore = Depends(get_evaluation_store),
    registry: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Return the backend-owned capability decision without creating a job.

    The response carries the requested scope, the resolved scope, and
    ``scope_options`` — per-depth availability (with the exact backend reason
    when a depth is unavailable) so the UI can offer every depth and disable
    the ones this setup cannot support.
    """

    opts = options or DatasetRunRequest()
    opts = await _apply_exact_rerun_contract(opts, request, store)
    opts = _validate_selected_tools(opts)
    assignment, manifest = await _bind_explicit_assignment(opts, request, store)
    await _validate_explicit_project_binding(opts, request, store)
    (
        _info,
        _records,
        _scenario,
        readiness,
        _scoring_configuration,
    ) = await _dataset_readiness(
        dataset_name,
        opts,
        registry,
        request,
        manifest,
    )
    return {
        **readiness.model_dump(mode="json"),
        "scope_options": _scope_options(opts, readiness),
    }


@router.post("/runs/from-dataset/{dataset_name}", status_code=202)
async def create_run_from_dataset(
    dataset_name: str,
    request: Request,
    options: DatasetRunRequest | None = None,
    store: EvaluationStore = Depends(get_evaluation_store),
    registry: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Enqueue an async evaluation of a golden dataset; returns 202 + run_id.

    ``response_source`` decides what gets graded: ``baseline`` grades each
    expected answer against itself, ``provided`` grades an attached response,
    ``agent`` invokes a live Proofgrove agent (``options.agent`` = "<ns>/<name>") per
    row, and ``llm`` invokes a Compass / custom LLM (``options.target_model``)
    per row via the AI Gateway. The run is executed by the background worker
    (network I/O); poll ``GET /evaluation/runs/{run_id}`` for status and, once
    complete, the result.
    """
    opts = options or DatasetRunRequest()
    opts = await _apply_exact_rerun_contract(opts, request, store)
    opts = _validate_selected_tools(opts)
    assignment, manifest = await _bind_explicit_assignment(opts, request, store)
    _refuse_manifest_owned_overrides(opts, manifest)
    project_id = await _validate_explicit_project_binding(opts, request, store)

    structural = await _dataset_readiness(dataset_name, opts, registry, request, manifest)
    scope_options = _scope_options(opts, structural[3])
    if structural[3].status == EvidenceReadiness.UNSUPPORTED:
        raise _readiness_http_error(structural[3], scope_options)

    if not 1 <= opts.parallel_requests <= 20:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "parallel_requests_out_of_range",
                "field": "parallel_requests",
                "message": "Parallel requests must be between 1 and 20.",
                "recovery": "Choose a value from 1 through 20.",
            },
        )
    info, records, scenario, readiness, scoring_configuration = structural
    if readiness.status != EvidenceReadiness.READY:
        raise _readiness_http_error(readiness, scope_options)
    dataset_version = dataset_version_label(dataset_name, getattr(info, "version_number", 1))
    resolved_scope = (
        (manifest.evaluation_scope or opts.evaluation_scope)
        if manifest is not None
        else scoring_configuration.evaluation_scope
    )
    resolved_metrics = manifest.metric_ids if manifest is not None else scoring_configuration.metric_ids
    configuration_hash = (
        manifest.manifest_hash if manifest is not None else scoring_configuration.configuration_hash
    )
    promotion_reasons = (
        manifest.scope_promotion_reasons
        if manifest is not None
        else scoring_configuration.scope_promotion_reasons
    )

    # Resolved before the persistence try below: a 422 raised inside it is
    # swallowed by the broad except and surfaces as a 500.
    resolved_prompt = opts.system_prompt
    resolved_prompt_ref = None
    if opts.prompt_version_ref:
        if opts.system_prompt:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "prompt_source_ambiguous",
                    "field": "prompt_version_ref",
                    "message": "Supply either a saved prompt version or prompt text, not both.",
                    "recovery": "Clear one of them and retry.",
                },
            )
        try:
            parse_prompt_ref(opts.prompt_version_ref)
        except ValueError as exc:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "prompt_ref_invalid",
                    "field": "prompt_version_ref",
                    "message": str(exc),
                    "recovery": "Use prompt-id@version or prompt-id@label.",
                },
            ) from exc
        prompt = await store.resolve_prompt_ref(
            opts.prompt_version_ref, tenant_id=resolve_requested_tenant(request, None)
        )
        if prompt is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "prompt_version_not_found",
                    "field": "prompt_version_ref",
                    "message": f"Prompt {opts.prompt_version_ref} was not found.",
                    "recovery": "Check the prompt id and version or label.",
                },
            )
        resolved_prompt = prompt.content
        # The concrete version, never the label that selected it.
        resolved_prompt_ref = f"{prompt.prompt_id}@{prompt.version}"

    # Use the same selected checks and resolved depth as the case evaluation.
    # Span targeting is evaluator metadata, not a second user configuration.
    span_checks = full_execution_span_checks(
        resolved_scope,
        manifest.metric_definitions if manifest is not None else scoring_configuration.metric_definitions,
        resolved_metrics,
    )

    try:
        run_id = await store.create_run_job(
            dataset_name=dataset_name,
            tenant_id=caller_tenant(request),
            response_source=opts.response_source,
            agent=opts.agent,
            target_endpoint=opts.target_endpoint,
            target_model=opts.target_model,
            system_prompt=resolved_prompt,
            prompt_version_ref=resolved_prompt_ref,
            row_count=opts.row_count,
            judge_model=opts.judge_model,
            active_metrics=resolved_metrics,
            requested_active_metrics=opts.active_metrics,
            span_checks=span_checks,
            enable_llm_judge=opts.enable_llm_judge,
            parallel_requests=opts.parallel_requests,
            run_human_review=opts.run_human_review,
            quality_contract_ids=[] if assignment else opts.quality_contract_ids,
            trigger_reason=opts.trigger_reason,
            correlation_id=opts.correlation_id,
            scenario=scenario.value,
            dataset_version=dataset_version,
            label=opts.label,
            labels=opts.labels,
            evaluation_name=(opts.evaluation_name or "").strip() or None,
            evaluation_scope=resolved_scope.value,
            requested_evaluation_scope=opts.evaluation_scope.value,
            evidence_readiness=readiness.model_dump(mode="json"),
            requested_provenance=readiness.requested_provenance,
            resolved_scoring_configuration=(
                None if manifest is not None else scoring_configuration.model_dump(mode="json")
            ),
            project_id=project_id,
            assignment_id=assignment.assignment_id if assignment else None,
            assignment_version=assignment.version if assignment else None,
            run_manifest_id=manifest.manifest_id if manifest is not None else None,
        )
        # Confirm the job is readable in this same request before telling the UI
        # to poll — avoids "202 + ghost run_id" when the session fails to commit.
        persisted = await store.get_run_job(run_id)
        if persisted is None:
            raise RuntimeError(f"run job {run_id} missing after commit")
    except Exception as exc:  # noqa: BLE001 — surface DB errors instead of opaque 500
        logger.error("Failed to create evaluation job for dataset %s", dataset_name, extra={"error_type": type(exc).__name__})
        raise HTTPException(status_code=500, detail="Failed to enqueue evaluation") from exc

    logger.info(
        "proofgrove: enqueued run %s dataset=%s agent=%s",
        run_id,
        dataset_name,
        opts.agent,
    )
    emit(
        EvalEvent.EVALUATION_TRIGGERED,
        correlation_id=opts.correlation_id or run_id,
        run_id=run_id,
        dataset_name=dataset_name,
        response_source=opts.response_source,
        trigger_reason=opts.trigger_reason.value,
    )
    await _submit_durable_run(run_id)
    payload = {
        "run_id": run_id,
        "status": "pending",
        "dataset_name": dataset_name,
        "evaluation_scope": resolved_scope.value,
        "requested_evaluation_scope": opts.evaluation_scope.value,
        "resolved_evaluation_scope": resolved_scope.value,
        "scope_promotion_reasons": promotion_reasons,
        "selected_tool_ids": opts.selected_tool_ids,
        "scope_options": scope_options,
        "evidence_readiness": readiness.model_dump(mode="json"),
        "resolved_active_metrics": resolved_metrics,
        "run_configuration_hash": configuration_hash,
        "project_id": project_id,
    }
    if assignment is not None and manifest is not None:
        payload.update(
            {
                "assignment_id": assignment.assignment_id,
                "assignment_version": assignment.version,
                "run_manifest_id": manifest.manifest_id,
                "governance_state": assignment.governance_state.value,
                "gate_policy_id": assignment.gate_policy_id,
            }
        )
    return payload


@router.get("/runs")
async def list_runs(
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
    # The newest ``limit`` completed runs plus the newest ``limit`` open jobs.
    # Same ceiling as /run-history; the default matches what the store used
    # to apply silently. Older history is paged through /run-history.
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[dict[str, Any]]:
    """List the most recent completed runs plus in-flight / failed async jobs.

    Pending and running jobs are included so the Monitor UI can show a
    live instance as soon as an evaluation is enqueued, with real job status.
    The list is a window, not the full history: at most ``limit`` completed
    runs and ``limit`` open jobs, newest first. ``/run-history`` pages the rest.

    Completed runs are scoped to ``tenant_id`` (their owning experiment's
    tenant) so a caller can never read another tenant's runs.
    """
    enforce_tenant(request, tenant_id)
    runs = await store.list_runs(limit=limit, tenant_id=tenant_id)
    payloads = [r.model_dump(mode="json") for r in runs]
    known_ids = {payload["run_id"] for payload in payloads}

    jobs_by_id = await store.get_run_jobs([payload["run_id"] for payload in payloads if not payload.get("label")], tenant_id)

    # Prefer the annotation captured on the async job when the completed run
    # row is missing ``label`` (e.g. pre-migration schema / older rows).
    for payload in payloads:
        if payload.get("label"):
            if not payload.get("labels"):
                payload["labels"] = [payload["label"]]
            continue
        job = jobs_by_id.get(payload["run_id"])
        job_label, job_labels = normalize_run_labels(
            label=((job.params or {}).get("label") if job else None),
            labels=((job.params or {}).get("labels") if job else None),
            name=((job.params or {}).get("name") if job else None),
        )
        if not job_label:
            tags = (payload.get("experiment") or {}).get("tags") or {}
            tagged = tags.get("label") if isinstance(tags, dict) else None
            job_label = tagged.strip() if isinstance(tagged, str) else None
            job_labels = [job_label] if job_label else []
        if not job_label:
            continue
        payload["label"] = job_label
        payload["labels"] = job_labels
        experiment = dict(payload.get("experiment") or {})
        tags = dict(experiment.get("tags") or {})
        tags["label"] = job_label
        experiment["tags"] = tags
        payload["experiment"] = experiment

    open_jobs = await store.list_eval_jobs(
        tenant_id=tenant_id,
        limit=limit,
        statuses=[
            RunStatus.PENDING.value,
            RunStatus.RUNNING.value,
            RunStatus.AWAITING_TRACE.value,
            RunStatus.BLOCKED.value,
            RunStatus.FAILED.value,
            RunStatus.CANCELLED.value,
        ]
    )
    for job in open_jobs:
        if job.run_id in known_ids:
            continue
        payloads.append(_run_job_list_item(job))

    payloads.sort(key=lambda item: item.get("started_at") or "", reverse=True)
    return payloads


@router.get("/run-history")
async def list_run_history(
    request: Request,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    cursor: str | None = Query(None),
    search: str | None = Query(None),
    sort: str = Query("started_at"),
    order: str = Query("desc"),
    tenant_id: str = Query(min_length=1),
    run_manifest_id: str | None = Query(None),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> PaginatedRuns:
    """Server-paginated run history with search + sort.

    Returns a ``{items, total, next_cursor, limit, offset}`` envelope backed by
    SQL LIMIT/OFFSET/COUNT so the UI can page large histories instead of loading
    every row. ``search`` matches over experiment name, run label and run id;
    ``sort`` is one of ``started_at`` (default), ``completed_at``, ``duration_ms``
    or ``run_number`` with ``order`` ``asc``/``desc``.

    Back-compat: the legacy ``GET /runs`` endpoint is unchanged — it still returns
    a bare list merged with in-flight jobs. This is a new, additive endpoint.
    """
    enforce_tenant(request, tenant_id)
    if cursor:
        try:
            offset = max(0, int(cursor))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid cursor") from None
    normalized_order = order.lower()
    if normalized_order not in {"asc", "desc"}:
        normalized_order = "desc"

    runs, total = await store.list_runs_page(
        limit=limit,
        offset=offset,
        search=search,
        sort=sort,
        order=normalized_order,
        run_manifest_id=run_manifest_id,
        tenant_id=tenant_id,
    )
    items = [run.model_dump(mode="json") for run in runs]
    next_offset = offset + limit
    next_cursor = str(next_offset) if next_offset < total else None
    return PaginatedRuns(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
        next_cursor=next_cursor,
    )


@router.post("/runs/{run_id}/cancel")
async def cancel_run(
    run_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Stop an active evaluation run.

    Cancellation is tenant-scoped and idempotent. Completed, failed, or blocked
    runs remain immutable and return 409 rather than being relabelled.
    """

    enforce_tenant(request, tenant_id)
    job = await store.get_run_job(run_id, tenant_id=tenant_id)
    if job is None or job.kind != "eval":
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    if await store.get_run(run_id, tenant_id=tenant_id):
        raise HTTPException(status_code=409, detail=f"Run {run_id} already completed — nothing to stop")
    if job.status == RunStatus.CANCELLED.value:
        return {"run_id": run_id, "status": RunStatus.CANCELLED.value}
    if job.status not in {
        RunStatus.PENDING.value,
        RunStatus.RUNNING.value,
        RunStatus.AWAITING_TRACE.value,
    }:
        raise HTTPException(
            status_code=409,
            detail=f"Run {run_id} already {job.status} — nothing to stop",
        )

    cancelled = await store.cancel_run_job(run_id, tenant_id=tenant_id)
    if cancelled is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    if cancelled.status != RunStatus.CANCELLED.value:
        raise HTTPException(
            status_code=409,
            detail=f"Run {run_id} already {cancelled.status} — nothing to stop",
        )
    from proofgrove.runs_worker import cancel_active_run

    cancel_active_run(run_id)
    if settings.evaluation_runtime == "temporal":
        from proofgrove.orchestrator.temporal import cancel_dataset_run

        try:
            await cancel_dataset_run(run_id)
        except Exception as exc:  # noqa: BLE001 - DB cancellation remains authoritative
            logger.error("Failed to cancel Temporal workflow for stopped run %s", run_id, extra={"error_type": type(exc).__name__})
    return {"run_id": run_id, "status": RunStatus.CANCELLED.value}


@router.get("/runs/{run_id}")
async def get_run(
    run_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Return the full result once complete, else the async job's status.

    Async runs (POST /runs/from-dataset) return 202 + run_id and are executed by
    the background worker. While pending/running/failed there is no RunResult yet,
    so surface the job status so the UI can poll.

    The read is tenant-scoped: a completed run is only returned to the tenant that
    owns its experiment. A run persisted under another tenant is treated as not
    found so its async-job metadata cannot leak across tenants.
    """
    enforce_tenant(request, tenant_id)
    job_status: dict[str, Any] | None = None
    try:
        job = await store.get_run_job(run_id, tenant_id=tenant_id)
        if job:
            params = job.params or {}
            job_label, job_labels = normalize_run_labels(label=params.get("label"), labels=params.get("labels"), name=params.get("name"))
            # Keep this payload free of ``metric_results`` so UI pollers do not
            # treat an in-flight job as a completed RunResult.
            job_status = {
                "run_id": run_id,
                "status": job.status,
                "error_message": _client_error_message(job.error_message),
                "completed_at": (
                    job.updated_at.isoformat()
                    if job.status
                    in {
                        RunStatus.COMPLETED.value,
                        RunStatus.BLOCKED.value,
                        RunStatus.FAILED.value,
                        RunStatus.CANCELLED.value,
                    }
                    and job.updated_at
                    else None
                ),
                "dataset_name": job.dataset_name,
                "agent": job.agent,
                "label": job_label,
                "labels": job_labels,
                "evaluation_name": params.get("evaluation_name"),
                "judge_model": job.judge_model,
                "response_source": job.response_source,
                "target_endpoint": params.get("target_endpoint"),
                "target_model": params.get("target_model"),
                "evaluation_scope": params.get("evaluation_scope"),
                "selected_tool_ids": (params.get("evidence_readiness") or {}).get("selected_tool_ids"),
                "evidence_readiness": params.get("evidence_readiness"),
                "requested_provenance": params.get("requested_provenance") or {},
                "active_metrics": params.get("active_metrics") or [],
                "run_configuration_hash": (params.get("resolved_scoring_configuration") or {}).get("configuration_hash"),
                "scenario": params.get("scenario"),
                "dataset_version": params.get("dataset_version") or dataset_version_label(job.dataset_name, 1),
            }
    except Exception as exc:  # noqa: BLE001
        logger.error("Failed to load run job %s", run_id, extra={"error_type": type(exc).__name__})
        raise HTTPException(status_code=500, detail="Failed to load run job") from exc

    run = await store.get_run(run_id, tenant_id=tenant_id)
    # A completed run persisted under another tenant must never surface — not even
    # via its async-job metadata. If no in-tenant run exists but a run row exists
    # under a different tenant, refuse instead of leaking the job status.
    if run is None and await store.run_exists(run_id):
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    try:
        if run:
            # Serialize explicitly so ResponseValidationError / NaN cannot escape
            # as a bare text 500 after the handler returns.
            payload = run.model_dump(mode="json")
            if payload.get("label") and not payload.get("labels"):
                payload["labels"] = [payload["label"]]
            if not payload.get("label"):
                job_label = (job_status or {}).get("label") if job_status else None
                job_labels = list((job_status or {}).get("labels") or [])
                if isinstance(job_label, str):
                    job_label = job_label.strip() or None
                if not job_label:
                    tags = (payload.get("experiment") or {}).get("tags") or {}
                    tagged = tags.get("label") if isinstance(tags, dict) else None
                    job_label = tagged.strip() if isinstance(tagged, str) else None
                    job_labels = [job_label] if job_label else []
                if job_label:
                    payload["label"] = job_label
                    payload["labels"] = job_labels
                    experiment = dict(payload.get("experiment") or {})
                    tags = dict(experiment.get("tags") or {})
                    tags["label"] = job_label
                    experiment["tags"] = tags
                    payload["experiment"] = experiment
            payload["release_eligibility"] = release_eligibility(run)
            json.dumps(payload, allow_nan=False)
            return payload
    except Exception as exc:  # noqa: BLE001 — prefer job status over a hard 500
        logger.error("Failed to serialize run %s; falling back to job status", run_id, extra={"error_type": type(exc).__name__})
        if job_status is not None:
            return {
                **job_status,
                "error_message": job_status.get("error_message") or "run result unavailable",
            }
        raise HTTPException(status_code=500, detail="Failed to load run result") from exc

    if job_status is not None:
        return job_status
    raise HTTPException(status_code=404, detail=f"Run {run_id} not found")


@router.get("/usage")
async def usage_overview(
    request: Request,
    tenant_id: str = Query(min_length=1),
    days: int = Query(30, ge=1, le=90),
    window: str | None = Query(None, pattern="^(24h|7d|30d|90d)$"),
    target_model: str | None = Query(None),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Aggregate evaluation activity for the usage dashboard (#3334).

    Reports only what Proofgrove itself recorded — evaluation runs, their cases'
    latency and token measurements, and failed launches. Costs are list-rate
    estimates; a case whose model the rate book cannot price is counted as
    unpriced rather than contributing zero. ``window`` picks span AND bucket
    granularity (24h buckets hourly); it wins over ``days`` when both are sent.
    """
    enforce_tenant(request, tenant_id)
    return await store.usage_overview(tenant_id, days=days, window=window, target_model=target_model)


@router.get("/runs/{run_id}/configuration")
async def get_run_configuration(
    run_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Return the immutable launch inputs needed to configure a rerun.

    Run results intentionally expose resolved outcomes, not every requested
    input. The async job is the durable source of the original form choices,
    including options that cannot be reconstructed from a completed report.
    """

    enforce_tenant(request, tenant_id)
    job = await store.get_run_job(run_id, tenant_id=tenant_id)
    if job is None or job.kind != "eval":
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    params = job.params or {}
    evidence_readiness = params.get("evidence_readiness") or {}
    label, labels = normalize_run_labels(label=params.get("label"), labels=params.get("labels"), name=params.get("name"))
    payload = {
        "run_id": job.run_id,
        "dataset_name": job.dataset_name,
        "response_source": job.response_source,
        "agent": job.agent,
        "evaluation_name": params.get("evaluation_name"),
        "label": label,
        "labels": labels,
        "judge_model": job.judge_model,
        "target_endpoint": params.get("target_endpoint"),
        "target_model": params.get("target_model"),
        "system_prompt": params.get("system_prompt"),
        "prompt_version_ref": params.get("prompt_version_ref"),
        "active_metrics": (
            params.get("requested_active_metrics")
            if params.get("requested_active_metrics") is not None
            else (params.get("active_metrics") or [])
        ),
        "enable_llm_judge": params.get("enable_llm_judge", True),
        "parallel_requests": params.get("parallel_requests", 5),
        "run_human_review": params.get("run_human_review", True),
        "quality_contract_ids": params.get("quality_contract_ids") or [],
        "evaluation_scope": (
            params.get("requested_evaluation_scope")
            or params.get("evaluation_scope")
            or EvaluationScope.FINAL_RESPONSE.value
        ),
        "selected_tool_ids": evidence_readiness.get("selected_tool_ids"),
        "project_id": params.get("project_id"),
        # The one replay-eligibility fact a client cannot compute: whether the
        # server can resolve a chat-completions base URL for this run's target
        # (recorded endpoint or the configured gateway fallback).
        "llm_endpoint_resolvable": _llm_endpoint_resolvable(params.get("target_endpoint")),
    }
    if params.get("span_checks"):
        payload["span_scoring_enabled"] = True
        payload["span_scoring_counts"] = await store.automatic_span_scoring_counts(tenant_id=tenant_id, run_id=run_id)
    if params.get("assignment_id"):
        payload["assignment_id"] = params.get("assignment_id")
        payload["assignment_version"] = params.get("assignment_version")
        payload["run_manifest_id"] = params.get("run_manifest_id")
    return payload

@router.get("/runs/{run_id}/review-queue")
async def get_review_queue(
    run_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    enforce_tenant(request, tenant_id)
    run = await store.get_run(run_id, tenant_id=tenant_id)
    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    return [r.model_dump() for r in run.review_queue]


@router.get("/runs/{run_id}/items")
async def list_run_items(
    run_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    """Return one ordered summary per evaluated example in a completed run."""
    enforce_tenant(request, tenant_id)
    if not await store.run_exists(run_id, tenant_id):
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    items = await store.list_run_items(run_id, tenant_id=tenant_id)
    return [item.model_dump(mode="json") for item in items]


@router.get("/runs/{run_id}/items/{example_id}/artifacts/{artifact_id}")
async def get_tool_result_artifact(
    run_id: str,
    example_id: str,
    artifact_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    offset: int = 0,
    limit: int = 131_072,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Return one bounded page of an externalized tool result."""
    enforce_tenant(request, tenant_id)
    if offset < 0 or limit < 1:
        raise HTTPException(status_code=422, detail="offset must be >= 0 and limit must be >= 1")
    page = await store.get_tool_result_artifact(
        run_id,
        example_id,
        artifact_id,
        offset=offset,
        limit=limit,
        tenant_id=tenant_id,
    )
    if page is None:
        raise HTTPException(status_code=404, detail="Tool-result artifact not found")
    return page.model_dump(mode="json")


@router.get(
    "/runs/{run_id}/items/{example_id}/trace",
    response_model=RunItemTraceEvidence,
)
async def get_run_item_trace(
    run_id: str,
    example_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> RunItemTraceEvidence:
    """Resolve one item's post-redaction spans from its tenant archive prefix."""

    enforce_tenant(request, tenant_id)
    run = await store.get_run(run_id, tenant_id=tenant_id)
    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    item = await store.get_run_item(run_id, example_id, tenant_id=tenant_id)
    if not item:
        raise HTTPException(status_code=404, detail=f"Example {example_id} not found in run {run_id}")
    try:
        # tenant_id is the caller's OWN authorized tenant (already enforced
        # above), not settings.pod_namespace -- the archive prefix used to be
        # derived from the SERVICE's own deployment namespace regardless of
        # which tenant the request was scoped to, which is only correct by
        # accident in a strictly one-tenant-per-pod deployment.
        return await TraceArchiveReader(settings).find(
            trace_id=item.execution.trace_id,
            tenant=tenant_from_namespace(tenant_id),
            started_at=run.started_at,
            completed_at=run.completed_at,
        )
    except Exception as exc:  # object storage must not break saved evaluation evidence
        logger.error("Trace archive lookup failed for run=%s example=%s", run_id, example_id, extra={"error_type": type(exc).__name__})
        raise HTTPException(status_code=503, detail="Trace archive is temporarily unavailable") from exc


def _llm_endpoint_resolvable(target_endpoint: str | None) -> bool:
    try:
        resolve_llm_base_url(target_endpoint, settings)
    except LlmInvocationError:
        return False
    return True


def _replay_query_text(item_input: dict[str, Any] | None) -> str | None:
    """The question a replay would send, read through the bridge's own keys."""
    for key in _QUERY_KEYS:
        value = (item_input or {}).get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _replay_refusal(code: str, field: str, message: str, recovery: str) -> HTTPException:
    return HTTPException(status_code=422, detail={"code": code, "field": field, "message": message, "recovery": recovery})


class ReplayCaseRequest(BaseModel):
    """One-case re-invocation with a different prompt (#3317)."""

    prompt_version_ref: str | None = None
    system_prompt: str | None = None


_REPLAY_TIMEOUT_SECONDS = 120.0


@router.post("/runs/{run_id}/items/{example_id:path}/replays")
async def replay_run_item(
    run_id: str,
    example_id: str,
    body: ReplayCaseRequest,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Re-invoke the run's LLM target for one case with a different prompt.

    Every refusal happens before the model is called; once the invocation
    starts, success and failure alike are persisted as isolated replay
    evidence. The original run, its items and its results are never written.
    """
    enforce_tenant(request, tenant_id)
    job = await store.get_run_job(run_id, tenant_id=tenant_id)
    if job is None or job.kind != "eval":
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    item = await store.get_run_item(run_id, example_id, tenant_id=tenant_id)
    if item is None:
        raise HTTPException(status_code=404, detail=f"Example {example_id} not found in run {run_id}")

    params = job.params or {}
    if (job.response_source or "agent") != "llm":
        raise _replay_refusal(
            "replay_target_not_llm",
            "response_source",
            "Only LLM-target runs can be replayed with a different prompt; this run's target accepts no system prompt.",
            "Open a case from an LLM evaluation to try another prompt.",
        )
    target_model = (params.get("target_model") or "").strip()
    if not target_model:
        raise _replay_refusal(
            "replay_model_unavailable",
            "target_model",
            "The original run did not record its target model, so the replay cannot invoke the same model.",
            "Re-run the evaluation through the current form to record a model, then replay from that run.",
        )
    target_endpoint = params.get("target_endpoint")
    if not _llm_endpoint_resolvable(target_endpoint):
        raise _replay_refusal(
            "replay_endpoint_unresolvable",
            "target_endpoint",
            "No LLM endpoint is resolvable for this run's target.",
            "Select a catalog model with an endpoint or configure the gateway base URL.",
        )
    query = _replay_query_text(item.input)
    if query is None:
        raise _replay_refusal(
            "replay_input_unavailable",
            "input",
            "The case's input text was not captured, so there is nothing to send to the model.",
            "Replay a case whose question was recorded.",
        )
    if query.endswith(TRUNCATION_MARKER):
        raise _replay_refusal(
            "replay_input_truncated",
            "input",
            "The case's input was truncated at persistence; replaying it would not reproduce the original question.",
            "Replay a case whose full question was recorded.",
        )
    if not body.prompt_version_ref and not (body.system_prompt or "").strip():
        raise _replay_refusal(
            "replay_prompt_missing",
            "system_prompt",
            "Supply a saved prompt version or prompt text to replay with.",
            "Pick a saved prompt version or write prompt text.",
        )

    resolved_prompt = body.system_prompt
    resolved_prompt_ref: str | None = None
    if body.prompt_version_ref:
        if body.system_prompt:
            raise _replay_refusal(
                "prompt_source_ambiguous",
                "prompt_version_ref",
                "Supply either a saved prompt version or prompt text, not both.",
                "Clear one of them and retry.",
            )
        try:
            parse_prompt_ref(body.prompt_version_ref)
        except ValueError as exc:
            raise _replay_refusal(
                "prompt_ref_invalid",
                "prompt_version_ref",
                str(exc),
                "Use prompt-id@version or prompt-id@label.",
            ) from exc
        prompt = await store.resolve_prompt_ref(body.prompt_version_ref, tenant_id=resolve_requested_tenant(request, None))
        if prompt is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "prompt_version_not_found",
                    "field": "prompt_version_ref",
                    "message": f"Prompt {body.prompt_version_ref} was not found.",
                    "recovery": "Check the prompt id and version or label.",
                },
            )
        resolved_prompt = prompt.content
        # The concrete version, never the label that selected it.
        resolved_prompt_ref = f"{prompt.prompt_id}@{prompt.version}"
    else:
        try:
            reject_embedded_credentials(resolved_prompt or "")
        except ValueError as exc:
            raise _replay_refusal("prompt_content_invalid", "system_prompt", str(exc), "Remove the credential and retry.") from exc
        if len(resolved_prompt or "") > MAX_PROMPT_CHARS:
            raise _replay_refusal(
                "prompt_content_invalid",
                "system_prompt",
                f"Prompt text exceeds the {MAX_PROMPT_CHARS}-character limit.",
                "Shorten the prompt and retry.",
            )

    # A replay is a fresh invocation: it must never claim the original case's
    # trace identity (same rule as _run_llm_row).
    invocation_id = str(uuid4())
    response: str | None = None
    latency_ms: int | None = None
    target_usage: dict[str, Any] | None = None
    invocation_error: str | None = None
    trace_id: str | None = None
    span_id: str | None = None
    try:
        out = await asyncio.wait_for(
            run_llm_target(
                settings=settings,
                target_endpoint=target_endpoint,
                target_model=target_model,
                query=query,
                system_prompt=resolved_prompt,
                invocation_id=invocation_id,
                # Bounds the HTTP call itself; the wait_for below is only the
                # caller-facing backstop.
                request_timeout_seconds=_REPLAY_TIMEOUT_SECONDS,
            ),
            timeout=_REPLAY_TIMEOUT_SECONDS,
        )
    except LlmInvocationError as exc:
        invocation_error = str(exc)
    except TimeoutError:
        invocation_error = f"LLM invocation exceeded {int(_REPLAY_TIMEOUT_SECONDS)} seconds"
    else:
        response = out.response
        latency_ms = round(out.latency_seconds * 1000)
        target_usage = {
            "prompt_tokens": out.prompt_tokens,
            "completion_tokens": out.completion_tokens,
            "model": out.model_id,
        }
        invocation_id = out.invocation_id or invocation_id
        trace_id = out.trace_id
        span_id = out.span_id

    replay = await store.create_case_replay(
        replay_id=str(uuid4()),
        tenant_id=tenant_id,
        run_id=run_id,
        example_id=example_id,
        prompt_version_ref=resolved_prompt_ref,
        prompt_hash=hash_system_prompt(resolved_prompt),
        system_prompt=resolved_prompt,
        target_model=target_model,
        target_endpoint=target_endpoint,
        response=response,
        latency_ms=latency_ms,
        target_usage=target_usage,
        invocation_error=invocation_error,
        invocation_id=invocation_id,
        trace_id=trace_id,
        span_id=span_id,
        created_by=actor_from_request(request),
    )
    return _replay_payload(replay)


@router.get("/runs/{run_id}/items/{example_id:path}/replays")
async def list_run_item_replays(
    run_id: str,
    example_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    """List this case's replays, newest first — isolated replay evidence only."""
    enforce_tenant(request, tenant_id)
    if not await store.run_exists(run_id, tenant_id):
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    replays = await store.list_case_replays(run_id, example_id, tenant_id=tenant_id)
    return [_replay_payload(replay) for replay in replays]


def _replay_payload(replay: CaseReplay) -> dict[str, Any]:
    usage = replay.target_usage or {}
    replay.estimated_cost_usd = estimate_tokens_cost_usd(
        usage.get("model") or replay.target_model,
        usage.get("prompt_tokens"),
        usage.get("completion_tokens"),
    )
    return replay.model_dump(mode="json")


@router.get("/runs/{run_id}/items/{example_id:path}")
async def get_run_item(
    run_id: str,
    example_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Return governed execution evidence and all scorer results for one example."""
    enforce_tenant(request, tenant_id)
    if not await store.run_exists(run_id, tenant_id):
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    item = await store.get_run_item(run_id, example_id, tenant_id=tenant_id)
    if not item:
        raise HTTPException(
            status_code=404,
            detail=f"Example {example_id} not found in run {run_id}",
        )
    return item.model_dump(mode="json")


@router.get("/runs/{run_id}/report")
async def get_report(
    run_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    experiment_id: str | None = Query(
        default=None,
        description=(
            "The workspace this run is being viewed through, when it differs "
            "from the run's original experiment (e.g. a run linked into a "
            "from-runs/attach workspace). Only that workspace's decision is "
            "read; omit to keep the run's own-experiment decision."
        ),
    ),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    enforce_tenant(request, tenant_id)
    run = await store.get_run(run_id, tenant_id=tenant_id)
    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    report = build_report(run)
    evidence_pack = await store.get_evidence_pack(run_id, tenant_id)
    report["evidence_pack"] = evidence_pack.model_dump(mode="json") if evidence_pack else None
    # A run keeps its ORIGINAL experiment_id after being linked into a
    # from-runs/attach workspace (same fact the decision-endpoint membership
    # fix above is built on), so a decision approved through that workspace is
    # filed under the WORKSPACE's experiment_id, not the run's own -- reading
    # only ``run.experiment.experiment_id`` silently misses it. The caller
    # must name the workspace explicitly; never guess across workspaces.
    if experiment_id:
        if not await store.experiment_has_run(experiment_id, run_id):
            raise HTTPException(
                status_code=404,
                detail=f"Run {run_id} not found for experiment {experiment_id}",
            )
        target_exp_id = experiment_id
    else:
        target_exp_id = run.experiment.experiment_id
    if target_exp_id:
        decisions = await store.list_decisions(target_exp_id, tenant_id)
        for d in decisions:
            if d.run_id == run_id:
                report["decision"] = d.model_dump(mode="json")
                break
        else:
            report["decision"] = None
    return report


@router.get("/runs/{run_id}/ci-callback")
async def get_ci_callback(
    run_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    enforce_tenant(request, tenant_id)
    run = await store.get_run(run_id, tenant_id=tenant_id)
    if not run:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    return build_ci_callback(run)
