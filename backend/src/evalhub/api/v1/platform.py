"""Versioned quality-contract control-plane API."""

from __future__ import annotations

from typing import Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from evalhub.api.dependencies import get_evaluation_engine, get_evaluation_store
from evalhub.db.store import EvaluationStore
from evalhub.evaluation.engine import EvaluationEngine
from evalhub.evaluation.enums import MetricRequirement, MetricStatus, RunStatus, RunType, TriggerReason
from evalhub.evaluation.evidence_requirements import metric_evidence_categories
from evalhub.evaluation.metrics import METRIC_CATALOG, get_metric
from evalhub.evaluation.models import EvaluationRow
from evalhub.platform.audit import AuditEvent
from evalhub.platform.authz import (
    PERMISSION_GOVERNANCE_APPROVE,
    actor_from_request,
    check_permission,
    enforce_tenant,
    mark_tenant_scope_checked,
    require_caller_tenant,
    require_role,
    resolve_requested_tenant,
)
from evalhub.platform.contracts import (
    CreateAssignmentRequest,
    EvaluationAssignmentVersion,
    EvaluationProject,
    InstantiateQualityContractRequest,
    MarkProfileTestedRequest,
    ProfileTestStatus,
    ProjectStatus,
    QualityContractTemplate,
    QualityProfileVersion,
    ReleaseGatePolicyVersion,
    ResolveManifestRequest,
    TargetVersion,
    VersionLifecycle,
)
from evalhub.platform.evaluators import EvaluatorDefinition, EvaluatorStatus, MetricPackVersion
from evalhub.platform.prompts import (
    reject_embedded_credentials,
    validated_prompt_content,
    validated_prompt_id,
)
from evalhub.platform.quality_contract_templates import (
    QUALITY_CONTRACT_TEMPLATE_BY_ID,
    QUALITY_CONTRACT_TEMPLATES,
)
from evalhub.platform.resolver import ContractResolutionError
from evalhub.platform.review import (
    FINDING_COMMENT_MAX_LENGTH,
    FindingComment,
    RegressionKind,
    Remediation,
    RemediationStatus,
    ReviewDecision,
    Waiver,
    parse_mentions,
)
from evalhub.settings import settings

router = APIRouter(prefix="/platform", tags=["profiles"])


def _not_found(kind: str, identifier: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"{kind} {identifier} not found")


def _invalid(exc: ValueError, *, field: str | None = None, recovery: str | None = None) -> HTTPException:
    """A 422 the browser can actually show.

    The BFF forwards a coded problem dict but deliberately drops a bare string
    `detail`, since an arbitrary string could carry exception text. Raising the
    string form means the user sees only the generic "some information is
    invalid" copy and never learns which field or why.
    """

    problem: dict[str, str] = {"code": "INVALID_REQUEST", "message": str(exc)}
    if field:
        problem["field"] = field
    if recovery:
        problem["recovery"] = recovery
    return HTTPException(status_code=422, detail=problem)


def _conflict(exc: ValueError) -> HTTPException:
    return HTTPException(status_code=409, detail=str(exc))


def _governance_write_error(exc: ValueError) -> HTTPException:
    """Duplicate versions conflict; invalid evidence/roles/lifecycle are 422."""

    message = str(exc)
    if "already exists" in message:
        return _conflict(exc)
    field = None
    recovery = "Correct the field and save a draft. Validation and approval stay separate actions."
    if "evidence" in message:
        field = "evidence_requirements"
    elif "approver role" in message:
        field = "approver_roles"
    elif "draft" in message:
        field = "status"
    elif "gate policy id and version" in message:
        field = "gate_policy_id"
        recovery = "Supply both Gate Policy id and version, or omit both for a standardized evaluation."
    elif "parent Assignment" in message:
        field = "parent_version"
        recovery = "Name the existing Assignment version this revision continues."
    elif "system Project" in message or "active Project" in message:
        field = "project_id"
        recovery = "Choose an active system Project. Catalog and archived projects cannot be assigned."
    elif "target version" in message:
        field = "target_version_id"
        recovery = "Choose a target version that belongs to the selected Project."
    return _invalid(
        exc,
        field=field,
        recovery=recovery,
    )


def _authorize(request: Request, tenant_id: str | None, required_role: str | None = None) -> None:
    enforce_tenant(request, tenant_id)
    if required_role:
        require_role(request, required_role)


def _role_granted(request: Request, role: str) -> bool:
    """True when ``require_role`` would let this request perform ``role``-gated writes.

    Mirrors the write-path guard exactly (including the local no-auth mode)
    so the capability answer can never drift from what the write endpoint
    would actually accept.
    """

    try:
        require_role(request, role)
    except HTTPException:
        return False
    return True


@router.get("/capabilities")
async def get_capabilities(
    request: Request,
    tenant_id: str | None = Query(default=None),
) -> dict[str, Any]:
    """Actions the calling identity may perform, derived from central AuthZ.

    Honest capability discovery for the UI: an action is ``true`` only when the
    corresponding write endpoint would accept this caller's roles, so the UI
    can hide affordances instead of rendering them and then receiving a 403.
    When platform auth is not required (local/dev), every action is granted.
    """

    # Identity-only: capability discovery names no resource, so it asks who
    # the caller is rather than comparing against an owner.
    if tenant_id:
        enforce_tenant(request, tenant_id)
    else:
        require_caller_tenant(request)
    can_approve = await check_permission(request, PERMISSION_GOVERNANCE_APPROVE)
    return {
        "actions": {
            "record_release_decision": can_approve,
            # The catalog reads this to decide whether to offer saving a prompt
            # or moving a label, rather than offering an action that 403s.
            "manage_prompts": can_approve,
            "author_governance": can_approve,
            "approve_governance": _role_granted(request, "eval-hub-approver"),
        }
    }


async def _audit(
    store: EvaluationStore,
    request: Request,
    tenant_id: str | None,
    action: str,
    resource_type: str,
    resource_id: str,
    details: dict[str, Any] | None = None,
) -> None:
    await store.record_audit(
        AuditEvent(
            tenant_id=tenant_id,
            actor=actor_from_request(request),
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            details=details or {},
        )
    )


async def _run_tenant(store: EvaluationStore, run_id: str) -> str | None:
    """Tenant that owns a run, derived from the run itself.

    A caller-supplied tenant proves nothing about a caller-supplied run id, so
    any route scoped to a run must authorize against this rather than against a
    query parameter.
    """
    run = await store.get_run(run_id)
    if not run:
        raise _not_found("Run", run_id)
    return run.experiment.tenant_id


async def _finding_tenant(store: EvaluationStore, finding_id: str) -> str | None:
    finding = await store.get_finding(finding_id)
    if not finding:
        raise _not_found("Finding", finding_id)
    run = await store.get_run(finding.run_id)
    if not run:
        raise HTTPException(status_code=409, detail="Finding source run is unavailable")
    return run.experiment.tenant_id


@router.post("/projects", status_code=201)
async def create_project(
    body: EvaluationProject,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, body.tenant_id)
    if settings.platform_auth_required:
        body.created_by = actor_from_request(request)
    try:
        saved = await store.save_project(body)
    except ValueError as exc:
        raise _conflict(exc) from exc
    return saved.model_dump(mode="json")


@router.get("/projects")
async def list_projects(
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    _authorize(request, tenant_id)
    return [project.model_dump(mode="json") for project in await store.list_projects(tenant_id)]


@router.get("/projects/{project_id}")
async def get_project(
    project_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    project = await store.get_project(project_id, tenant_id)
    if not project:
        raise _not_found("Evaluation project", project_id)
    return project.model_dump(mode="json")


@router.post("/projects/{project_id}/archive")
async def archive_project(
    project_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    # Scoping the write by the caller-supplied tenant_id is not authorization:
    # without this, any caller naming another tenant could archive its Project.
    _authorize(request, tenant_id)
    project = await store.set_project_status(project_id, tenant_id, ProjectStatus.ARCHIVED)
    if not project:
        raise _not_found("Evaluation project", project_id)
    return project.model_dump(mode="json")


@router.post("/projects/{project_id}/restore")
async def restore_project(
    project_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Return an archived Project to active. Archiving is not a one-way door."""

    _authorize(request, tenant_id)
    project = await store.set_project_status(project_id, tenant_id, ProjectStatus.ACTIVE)
    if not project:
        raise _not_found("Evaluation project", project_id)
    return project.model_dump(mode="json")


@router.delete("/projects/{project_id}")
async def delete_project(
    project_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Permanently delete an archived Project and its captured trace index.

    ``deleted_traces`` counts index rows removed. Archived span payloads are
    not deleted — see ``EvaluationStore.delete_project`` for why the archive
    cannot be pruned per Project — so the response says what was removed
    rather than implying the payloads went with it.
    """

    _authorize(request, tenant_id)
    try:
        deleted_traces = await store.delete_project(project_id, tenant_id)
    except ValueError as exc:
        raise _conflict(exc) from exc
    if deleted_traces is None:
        raise _not_found("Evaluation project", project_id)
    return {"project_id": project_id, "deleted_traces": deleted_traces}


@router.post("/projects/{project_id}/target-versions", status_code=201)
async def register_target_version(
    project_id: str,
    body: TargetVersion,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, body.tenant_id)
    if body.project_id != project_id:
        raise HTTPException(status_code=422, detail="target project_id must match the URL")
    if settings.platform_auth_required:
        body.created_by = actor_from_request(request)
    try:
        target = await store.save_target_version(body)
    except ValueError as exc:
        raise _conflict(exc) from exc
    return target.model_dump(mode="json")


@router.get("/projects/{project_id}/target-versions")
async def list_target_versions(
    request: Request,
    project_id: str,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    _authorize(request, tenant_id)
    return [target.model_dump(mode="json") for target in await store.list_target_versions(project_id, tenant_id)]


@router.get("/target-versions/{target_version_id}")
async def get_target_version(
    request: Request,
    target_version_id: str,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    target = await store.get_target_version(target_version_id, tenant_id)
    if not target:
        raise _not_found("Target version", target_version_id)
    return target.model_dump(mode="json")


@router.get("/quality-contract-templates")
async def list_quality_contract_templates() -> list[dict[str, Any]]:
    """List the immutable first-party rubric templates available to every tenant."""

    return [template.model_dump(mode="json") for template in QUALITY_CONTRACT_TEMPLATES]


@router.post("/quality-contract-templates/{template_id}/instantiate", status_code=201)
async def instantiate_quality_contract_template(
    template_id: str,
    body: InstantiateQualityContractRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Create a governed draft profile from a built-in InEval rubric."""

    _authorize(request, body.tenant_id)
    template: QualityContractTemplate | None = QUALITY_CONTRACT_TEMPLATE_BY_ID.get(template_id)
    if template is None:
        raise _not_found("Quality contract template", template_id)

    if settings.platform_auth_required:
        body.created_by = actor_from_request(request)
    profile = QualityProfileVersion(
        profile_id=body.profile_id or f"{template.metric_id.replace('.', '-')}-{uuid4().hex[:8]}",
        version=body.version,
        tenant_id=body.tenant_id,
        project_id=body.project_id,
        name=body.name or template.name,
        description=body.description or template.description,
        scenario=template.scenario,
        metric_ids=[template.metric_id],
        metric_requirements={template.metric_id: MetricRequirement.REQUIRED},
        kpi_gate_weights={"kpi.quality_contract": {template.metric_id: 1.0}},
        hard_blocker_metric_ids=[template.metric_id],
        evidence_requirements=metric_evidence_categories(METRIC_CATALOG[template.metric_id]),
        source_template_id=template.template_id,
        source_template_snapshot=template.model_dump(mode="json"),
        created_by=body.created_by,
    )
    try:
        saved = await store.save_quality_profile(profile)
    except ValueError as exc:
        raise _governance_write_error(exc) from exc
    return saved.model_dump(mode="json")


class SavePromptRequest(BaseModel):
    """A prompt to keep. The version number is allocated, never supplied."""

    tenant_id: str
    prompt_id: str
    name: str
    content: str
    description: str | None = None


class MovePromptLabelRequest(BaseModel):
    tenant_id: str
    version: int


@router.post("/prompts", status_code=201)
async def save_prompt(
    body: SavePromptRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Save the next version of a prompt."""

    tenant_id = resolve_requested_tenant(request, body.tenant_id)
    _authorize(request, tenant_id, "eval-hub-approver")
    try:
        prompt_id = validated_prompt_id(body.prompt_id)
    except ValueError as exc:
        raise _invalid(
            exc,
            field="prompt_id",
            recovery="Use letters, numbers, dots, dashes or underscores — no spaces.",
        ) from exc
    try:
        content = validated_prompt_content(body.content)
        reject_embedded_credentials(content)
    except ValueError as exc:
        raise _invalid(exc, field="content") from exc
    saved = await store.save_prompt_version(
        tenant_id=tenant_id,
        prompt_id=prompt_id,
        name=body.name,
        content=content,
        description=body.description,
        created_by=actor_from_request(request),
    )
    # The prompt text is deliberately not in the audit detail: the event says
    # who saved which version, not what it contained.
    await _audit(
        store,
        request,
        tenant_id,
        "prompt.save",
        "prompt_version",
        f"{saved.prompt_id}@{saved.version}",
    )
    return saved.model_dump(mode="json")


@router.get("/prompts")
async def list_prompts(
    request: Request,
    tenant_id: str | None = None,
    prompt_id: str | None = None,
    include_archived: bool = False,
    # Bounded like every other list endpoint here: an uncapped page size lets one
    # request pull the whole catalog and every version of it.
    limit: int | None = Query(None, ge=1, le=200),
    offset: int = Query(0, ge=0),
    cursor: str | None = None,
    paginate_by: Literal["version", "prompt"] = "version",
    store: EvaluationStore = Depends(get_evaluation_store),
) -> Any:
    """List saved prompt versions, newest first per prompt.

    Tenant is resolved and enforced rather than taken as a filter: a slug and a
    namespace form name the same tenant, and a query parameter alone would let
    one tenant read another's catalog.

    Additive paging, as datasets do: without ``limit``/``cursor`` the response
    stays a bare list, so the committed client and the comparison picker — which
    assumes it can see every version — keep working. With them it is the
    ``{items, total, limit, offset, next_cursor}`` envelope.
    """

    resolved = resolve_requested_tenant(request, tenant_id)
    paged = limit is not None or cursor is not None

    # `paginate_by=prompt` pages whole prompts and returns every version of the
    # prompts on the page. A catalog index groups versions under their prompt, so
    # slicing the flat version list would split one prompt across two pages and
    # report a partial history for it on each.
    if paged and paginate_by == "prompt":
        if cursor is not None:
            try:
                offset = max(0, int(cursor))
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid cursor") from None
        size = limit if limit is not None else 50
        # `prompt_id` narrows this branch too. Ignoring it listed every prompt
        # and could return an unrelated one that happened to sort first.
        ids = await store.list_prompt_ids(resolved, prompt_id=prompt_id, include_archived=include_archived)
        window_ids = ids[offset : offset + size]
        versions = (
            await store.list_prompt_versions(resolved, prompt_ids=window_ids, include_archived=include_archived)
            if window_ids
            else []
        )
        next_offset = offset + size
        mark_tenant_scope_checked(request)
        return {
            "items": [version.model_dump(mode="json") for version in versions],
            "total": len(ids),
            "limit": size,
            "offset": offset,
            "next_cursor": str(next_offset) if next_offset < len(ids) else None,
        }

    versions = await store.list_prompt_versions(resolved, prompt_id=prompt_id, include_archived=include_archived)
    items = [version.model_dump(mode="json") for version in versions]
    mark_tenant_scope_checked(request)
    if not paged:
        return items
    if cursor is not None:
        try:
            offset = max(0, int(cursor))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid cursor") from None
    size = limit if limit is not None else 50
    window = items[offset : offset + size]
    next_offset = offset + size
    return {
        "items": window,
        "total": len(items),
        "limit": size,
        "offset": offset,
        "next_cursor": str(next_offset) if next_offset < len(items) else None,
    }


@router.put("/prompts/{prompt_id}/labels/{label}")
async def move_prompt_label(
    prompt_id: str,
    label: str,
    body: MovePromptLabelRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Point a label at a version. Moving it back is how a rollback happens."""

    tenant_id = resolve_requested_tenant(request, body.tenant_id)
    # Repointing a label is the consequential prompt write — the one an incident
    # review asks about — so it carries the same role every other mutation here
    # requires.
    _authorize(request, tenant_id, "eval-hub-approver")
    try:
        moved = await store.move_prompt_label(
            tenant_id=tenant_id, prompt_id=prompt_id, label=label, version=body.version
        )
    except ValueError as exc:
        raise _invalid(exc, field="label") from exc
    if moved is None:
        raise _not_found("Prompt version", f"{prompt_id}@{body.version}")
    await _audit(
        store,
        request,
        tenant_id,
        "prompt.label_move",
        "prompt_label",
        f"{prompt_id}@{body.version}",
        {"label": label},
    )
    return moved.model_dump(mode="json")


@router.delete("/prompts/{prompt_id}/versions/{version}")
async def archive_prompt_version(
    prompt_id: str,
    version: int,
    request: Request,
    tenant_id: str | None = None,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Retire a version from the pickers. It stays resolvable by number.

    Deliberately an archive rather than a delete: runs cite `prompt-id@version`
    and an exact rerun replays that reference, so removing the row would turn a
    completed run's own provenance into a dangling pointer. Any label pointing
    at the version is dropped with it — a retired prompt must not still be
    somebody's `production`.
    """

    resolved_tenant = resolve_requested_tenant(request, tenant_id)
    _authorize(request, resolved_tenant, "eval-hub-approver")
    archived = await store.archive_prompt_version(
        tenant_id=resolved_tenant, prompt_id=prompt_id, version=version
    )
    if archived is None:
        raise _not_found("Prompt version", f"{prompt_id}@{version}")
    await _audit(
        store,
        request,
        resolved_tenant,
        "prompt.archive",
        "prompt_version",
        f"{prompt_id}@{version}",
        {},
    )
    return archived.model_dump(mode="json")


@router.post("/quality-profiles", status_code=201)
async def create_quality_profile(
    body: QualityProfileVersion,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, body.tenant_id)
    if settings.platform_auth_required:
        body.created_by = actor_from_request(request)
    try:
        profile = await store.save_quality_profile(body)
    except ValueError as exc:
        raise _governance_write_error(exc) from exc
    return profile.model_dump(mode="json")


@router.get("/quality-profiles")
async def list_quality_profiles(
    request: Request,
    tenant_id: str = Query(min_length=1),
    project_id: str | None = None,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    _authorize(request, tenant_id)
    profiles = await store.list_quality_profiles(tenant_id, project_id)
    return [profile.model_dump(mode="json") for profile in profiles]


@router.get("/quality-profiles/{profile_id}/versions/{version}")
async def get_quality_profile(
    request: Request,
    profile_id: str,
    version: str,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    profile = await store.get_quality_profile(profile_id, version, tenant_id)
    if not profile:
        raise _not_found("Quality profile version", f"{profile_id}@{version}")
    return profile.model_dump(mode="json")


async def _transition_profile(
    profile_id: str,
    version: str,
    tenant_id: str,
    target: VersionLifecycle,
    store: EvaluationStore,
) -> dict[str, Any]:
    try:
        profile = await store.transition_quality_profile(profile_id, version, tenant_id, target, commit=False)
    except ValueError as exc:
        raise _conflict(exc) from exc
    if not profile:
        raise _not_found("Quality profile version", f"{profile_id}@{version}")
    return profile.model_dump(mode="json")



async def _dry_run_evidence(
    profile_id: str,
    version: str,
    tenant_id: str,
    source_run_id: str | None,
    store: EvaluationStore,
) -> str:
    """Check that a real rescore exercised this Profile's checks, and name it.

    TESTED used to be a self-assertion beside a free-text dataset name nothing
    resolved, so it claimed a dry run rather than evidencing one. The evidence
    is an ordinary completed run whose stored results cover the Profile's
    checks — `execute_rescore` already produces exactly that, without invoking
    any target.
    """
    if not (source_run_id or "").strip():
        raise HTTPException(
            status_code=422,
            detail={
                "code": "dry_run_required",
                "field": "source_run_id",
                "message": "Marking a Quality Profile tested needs the run whose evidence was scored against it.",
                "recovery": "Rescore a completed run with this Profile's checks and pass its run id, or record an override with a note.",
            },
        )
    run = await store.get_run(source_run_id, tenant_id)
    if run is None:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "dry_run_not_found",
                "field": "source_run_id",
                "message": f"Run {source_run_id} was not found in this workspace.",
            },
        )
    if run.status != RunStatus.COMPLETED:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "dry_run_incomplete",
                "field": "source_run_id",
                "message": "A run still in flight cannot evidence a dry run; wait for it to complete.",
            },
        )

    profile = await store.get_quality_profile(profile_id, version, tenant_id)
    if profile is None:
        raise _not_found("Quality profile version", f"{profile_id}@{version}")
    required = set(profile.metric_ids)
    scored = {
        result.metric_id
        for result in run.metric_results
        if result.metric_status == MetricStatus.SCORED
    }
    missing = sorted(required - scored)
    if missing:
        # Two different failures wear the same shape. A check the run simply had
        # no evidence for is recoverable — score a run that has it. A check no
        # run can score yet (the content-safety set is `available_in_run=False`
        # until the red-team lane lands) would make the Profile permanently
        # unapprovable, so it belongs on the override path, which already
        # demands a note and is audited.
        unscoreable = [
            metric_id
            for metric_id in missing
            if (definition := get_metric(metric_id)) is not None and not definition.available_in_run
        ]
        evidence_missing = [metric_id for metric_id in missing if metric_id not in unscoreable]
        if evidence_missing:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "dry_run_missing_evidence",
                    "field": "source_run_id",
                    "message": (
                        "That run scored none of "
                        + ", ".join(evidence_missing)
                        + ", so it does not exercise this Profile."
                    ),
                    "recovery": "Choose a run whose evidence covers these checks, or remove them from the Profile.",
                },
            )
        raise HTTPException(
            status_code=422,
            detail={
                "code": "dry_run_unscoreable_checks",
                "field": "source_run_id",
                "message": (
                    ", ".join(unscoreable)
                    + " cannot be scored by any run yet, so no dry run can exercise this Profile."
                ),
                "recovery": "Record an override with a note explaining the gap, or remove these checks.",
            },
        )
    return run.run_id


@router.post("/quality-profiles/{profile_id}/versions/{version}/mark-tested")
async def mark_quality_profile_tested(
    profile_id: str,
    version: str,
    body: MarkProfileTestedRequest,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Record that a Quality Profile was dry-run tested, or override Not tested."""
    # No role split here, deliberately, and it is worth saying why rather than
    # implying a control that does not exist.
    #
    # An earlier version gated OVERRIDDEN on "eval-hub-approver". That denied
    # nobody: permission_for_request maps every non-GET under /platform to
    # governance.approve, and require_role then checks for that same permission,
    # which the middleware has already granted. A caller who could record a
    # dry-run could always record an override too.
    #
    # A real split needs its own permission, and permission_for_request sees only
    # method and path — not the mode in the body — so it also needs a separate
    # route. The stronger fix is for TESTED to carry evidence at all: today it
    # stamps a self-asserted status with a free-text dataset name that is never
    # resolved, so OVERRIDDEN is the honest one and TESTED the loophole.
    _authorize(request, tenant_id)
    actor = actor_from_request(request)
    # Only TESTED has to be earned. OVERRIDDEN is the honest admission that no
    # dry run happened, and it keeps its note.
    test_run_id = (
        await _dry_run_evidence(profile_id, version, tenant_id, body.source_run_id, store)
        if body.mode == ProfileTestStatus.TESTED
        else None
    )
    try:
        updated = await store.mark_quality_profile_tested(
            profile_id,
            version,
            tenant_id,
            mode=body.mode,
            actor=actor,
            note=body.note,
            dataset_name=body.dataset_name,
            test_run_id=test_run_id,
            commit=False,
        )
    except ValueError as exc:
        raise _conflict(exc) from exc
    if not updated:
        raise _not_found("Quality profile version", f"{profile_id}@{version}")
    await _audit(
        store,
        request,
        tenant_id,
        "quality_profile.mark_tested",
        "quality_profile",
        f"{profile_id}@{version}",
        {
            "mode": body.mode.value,
            "note": body.note,
            "dataset_name": body.dataset_name,
            "test_run_id": test_run_id,
        },
    )
    return updated.model_dump(mode="json")


@router.post("/quality-profiles/{profile_id}/versions/{version}/validate")
async def validate_quality_profile(
    profile_id: str,
    version: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    profile = await _transition_profile(profile_id, version, tenant_id, VersionLifecycle.VALIDATED, store)
    await _audit(store, request, tenant_id, "quality_profile.validated", "quality_profile", f"{profile_id}@{version}")
    return profile


@router.post("/quality-profiles/{profile_id}/versions/{version}/approve")
async def approve_quality_profile(
    profile_id: str,
    version: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id, "eval-hub-approver")
    profile = await _transition_profile(profile_id, version, tenant_id, VersionLifecycle.APPROVED, store)
    await _audit(store, request, tenant_id, "quality_profile.approved", "quality_profile", f"{profile_id}@{version}")
    return profile


@router.post("/quality-profiles/{profile_id}/versions/{version}/retire")
async def retire_quality_profile(
    profile_id: str,
    version: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    profile = await _transition_profile(profile_id, version, tenant_id, VersionLifecycle.RETIRED, store)
    await _audit(store, request, tenant_id, "quality_profile.retired", "quality_profile", f"{profile_id}@{version}")
    return profile


@router.post("/quality-profiles/{profile_id}/versions/{version}/reinstate")
async def reinstate_quality_profile(
    profile_id: str,
    version: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Return a retired Quality Profile to draft.

    Retirement used to be terminal, which left a retired version with nothing to
    do and no way to recover work. Reinstating lands in DRAFT and clears the
    tested flag, so the version has to be re-tested and re-approved before it can
    gate a release again. Gated on the approver capability and audited, like
    approval, because it restores a version's route back to approved.
    """
    _authorize(request, tenant_id, "eval-hub-approver")
    profile = await _transition_profile(profile_id, version, tenant_id, VersionLifecycle.DRAFT, store)
    await _audit(store, request, tenant_id, "quality_profile.reinstated", "quality_profile", f"{profile_id}@{version}")
    return profile


@router.post("/gate-policies", status_code=201)
async def create_gate_policy(
    body: ReleaseGatePolicyVersion,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, body.tenant_id)
    if settings.platform_auth_required:
        body.created_by = actor_from_request(request)
    try:
        policy = await store.save_gate_policy(body)
    except ValueError as exc:
        raise _governance_write_error(exc) from exc
    return policy.model_dump(mode="json")


@router.get("/gate-policies")
async def list_gate_policies(
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    _authorize(request, tenant_id)
    return [policy.model_dump(mode="json") for policy in await store.list_gate_policies(tenant_id)]


@router.get("/gate-policies/{gate_policy_id}/versions/{version}")
async def get_gate_policy(
    request: Request,
    gate_policy_id: str,
    version: str,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    policy = await store.get_gate_policy(gate_policy_id, version, tenant_id)
    if not policy:
        raise _not_found("Release gate policy version", f"{gate_policy_id}@{version}")
    return policy.model_dump(mode="json")


async def _transition_gate_policy(
    gate_policy_id: str,
    version: str,
    tenant_id: str,
    target: VersionLifecycle,
    store: EvaluationStore,
) -> dict[str, Any]:
    try:
        policy = await store.transition_gate_policy(gate_policy_id, version, tenant_id, target, commit=False)
    except ValueError as exc:
        raise _conflict(exc) from exc
    if not policy:
        raise _not_found("Release gate policy version", f"{gate_policy_id}@{version}")
    return policy.model_dump(mode="json")


@router.post("/gate-policies/{gate_policy_id}/versions/{version}/validate")
async def validate_gate_policy(
    gate_policy_id: str,
    version: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    policy = await _transition_gate_policy(gate_policy_id, version, tenant_id, VersionLifecycle.VALIDATED, store)
    await _audit(store, request, tenant_id, "gate_policy.validated", "gate_policy", f"{gate_policy_id}@{version}")
    return policy


@router.post("/gate-policies/{gate_policy_id}/versions/{version}/approve")
async def approve_gate_policy(
    gate_policy_id: str,
    version: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id, "eval-hub-approver")
    policy = await _transition_gate_policy(gate_policy_id, version, tenant_id, VersionLifecycle.APPROVED, store)
    await _audit(store, request, tenant_id, "gate_policy.approved", "release_gate_policy", f"{gate_policy_id}@{version}")
    return policy


@router.post("/gate-policies/{gate_policy_id}/versions/{version}/retire")
async def retire_gate_policy(
    gate_policy_id: str,
    version: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    policy = await _transition_gate_policy(gate_policy_id, version, tenant_id, VersionLifecycle.RETIRED, store)
    await _audit(store, request, tenant_id, "gate_policy.retired", "gate_policy", f"{gate_policy_id}@{version}")
    return policy


@router.post("/run-manifests", status_code=201)
async def resolve_manifest(
    body: ResolveManifestRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, body.tenant_id)
    if settings.platform_auth_required:
        body.resolved_by = actor_from_request(request)
    try:
        manifest = await store.resolve_and_save_manifest(**body.model_dump())
    except ContractResolutionError as exc:
        # A coded dict, not ``str(exc)``: the browser-facing proxy refuses to
        # forward bare-string details (they can carry exception text), so a
        # string here reaches the user as generic "some information is invalid"
        # copy that names no field and offers no recovery. Every reason this
        # raises is a mismatch between saved contract parts, not bad input on
        # the form that was just submitted.
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CONTRACT_UNRESOLVABLE",
                "message": str(exc),
                "recovery": (
                    "Check the project, target version, quality profile and "
                    "release policy still agree with each other."
                ),
            },
        ) from exc
    return manifest.model_dump(mode="json")


@router.get("/run-manifests")
async def list_manifests(
    request: Request,
    tenant_id: str = Query(min_length=1),
    project_id: str | None = None,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    _authorize(request, tenant_id)
    manifests = await store.list_run_manifests(tenant_id, project_id)
    return [manifest.model_dump(mode="json") for manifest in manifests]


@router.get("/run-manifests/{manifest_id}")
async def get_manifest(
    request: Request,
    manifest_id: str,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    manifest = await store.get_run_manifest(manifest_id, tenant_id)
    if not manifest:
        raise _not_found("Run manifest", manifest_id)
    return manifest.model_dump(mode="json")


@router.post("/run-manifests/{manifest_id}/archive")
async def archive_manifest(
    manifest_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Remove a contract from the active catalog while retaining its immutable evidence."""

    _authorize(request, tenant_id)
    archived = await store.archive_run_manifest(manifest_id, tenant_id)
    if not archived:
        raise _not_found("Run manifest", manifest_id)
    return {"manifest_id": manifest_id, "archived": True}


def _assignment_payload(assignment: EvaluationAssignmentVersion) -> dict[str, Any]:
    payload = assignment.model_dump(mode="json")
    payload["governance_state"] = assignment.governance_state.value
    return payload


@router.post("/gate-policies/{gate_policy_id}/versions/{version}/reinstate")
async def reinstate_gate_policy(
    gate_policy_id: str,
    version: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Return a retired Gate Policy to draft. Mirrors the Quality Profile path."""
    _authorize(request, tenant_id, "eval-hub-approver")
    policy = await _transition_gate_policy(gate_policy_id, version, tenant_id, VersionLifecycle.DRAFT, store)
    await _audit(store, request, tenant_id, "gate_policy.reinstated", "gate_policy", f"{gate_policy_id}@{version}")
    return policy


@router.post("/assignments", status_code=201)
async def create_assignment(
    body: CreateAssignmentRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, body.tenant_id)
    if body.parent_version and not body.assignment_id:
        raise _invalid(
            ValueError("A revision must name the Assignment it continues"),
            field="assignment_id",
            recovery="Pass the existing assignment_id together with parent_version.",
        )
    # The authenticated caller is the author, always. This previously only
    # substituted the literal "system", so a client sending anything else — the UI
    # sends "eval-hub-ui" — stamped that string into created_by and the column
    # never named a person. Who bound an approved Profile and Gate Policy to a
    # target is the question this field exists to answer.
    body.created_by = actor_from_request(request)
    try:
        assignment = await store.create_assignment(body)
    except ContractResolutionError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CONTRACT_UNRESOLVABLE",
                "message": str(exc),
                "recovery": (
                    "Approve the Quality Profile and optional Gate Policy, then "
                    "choose an active system Project and target version."
                ),
            },
        ) from exc
    except ValueError as exc:
        raise _governance_write_error(exc) from exc
    await _audit(
        store,
        request,
        body.tenant_id,
        "assignment.create",
        "assignment",
        f"{assignment.assignment_id}@{assignment.version}",
        {"run_manifest_id": assignment.run_manifest_id},
    )
    return _assignment_payload(assignment)


@router.get("/assignments")
async def list_assignments(
    request: Request,
    tenant_id: str = Query(min_length=1),
    project_id: str | None = None,
    target_version_id: str | None = None,
    assignment_id: str | None = None,
    q: str | None = None,
    include_archived: bool = False,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    _authorize(request, tenant_id)
    assignments = await store.list_assignments(
        tenant_id,
        project_id=project_id,
        target_version_id=target_version_id,
        assignment_id=assignment_id,
        q=q,
        include_archived=include_archived,
    )
    return [_assignment_payload(item) for item in assignments]


@router.get("/assignments/{assignment_id}/versions/{version}")
async def get_assignment(
    assignment_id: str,
    version: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    include_manifest: bool = False,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    # Every sibling route on this resource authorizes; this one did not, so the
    # tenant_id query parameter was taken on trust and a caller could read another
    # tenant's Assignment by asking for it.
    _authorize(request, tenant_id)
    assignment = await store.get_assignment(assignment_id, version, tenant_id)
    if not assignment:
        raise _not_found("Assignment version", f"{assignment_id}@{version}")
    payload = _assignment_payload(assignment)
    if include_manifest:
        manifest = await store.get_run_manifest(assignment.run_manifest_id, tenant_id)
        payload["resolved_run_manifest"] = manifest.model_dump(mode="json") if manifest else None
    return payload


@router.post("/assignments/{assignment_id}/versions/{version}/archive")
async def archive_assignment(
    assignment_id: str,
    version: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    assignment = await store.archive_assignment(assignment_id, version, tenant_id)
    if not assignment:
        raise _not_found("Assignment version", f"{assignment_id}@{version}")
    await _audit(
        store,
        request,
        tenant_id,
        "assignment.archive",
        "assignment",
        f"{assignment_id}@{version}",
    )
    return _assignment_payload(assignment)


@router.post("/assignments/{assignment_id}/versions/{version}/restore")
async def restore_assignment(
    assignment_id: str,
    version: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    assignment = await store.restore_assignment(assignment_id, version, tenant_id)
    if not assignment:
        raise _not_found("Assignment version", f"{assignment_id}@{version}")
    await _audit(
        store,
        request,
        tenant_id,
        "assignment.restore",
        "assignment",
        f"{assignment_id}@{version}",
    )
    return _assignment_payload(assignment)


@router.post("/assignments/{assignment_id}/revisions", status_code=201)
async def create_assignment_revision(
    assignment_id: str,
    body: CreateAssignmentRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    body.assignment_id = assignment_id
    if not body.parent_version:
        raise _invalid(
            ValueError("A revision must name the parent Assignment version"),
            field="parent_version",
            recovery="Pass parent_version as the Assignment version this revision continues.",
        )
    return await create_assignment(body, request, store)


class BindManifestRequest(BaseModel):
    manifest_id: str


@router.post("/experiments/{experiment_id}/run-manifest")
async def bind_manifest(
    experiment_id: str,
    body: BindManifestRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    # Resolve the experiment's OWN tenant and enforce it before rebinding —
    # the store guard alone cannot see the caller, so a route that skipped
    # this let any caller rebind an experiment whose tenant it had never been
    # authorized for. See EvaluationStore.bind_manifest_to_experiment.
    experiment = await store.get_experiment(experiment_id, require_caller_tenant(request))
    if not experiment:
        raise _not_found("Experiment or run manifest", experiment_id)
    enforce_tenant(request, experiment.tenant_id)
    try:
        experiment = await store.bind_manifest_to_experiment(experiment_id, body.manifest_id, experiment.tenant_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not experiment:
        raise _not_found("Experiment or run manifest", experiment_id)
    return experiment.model_dump(mode="json")


@router.get("/evaluators")
async def list_evaluators(
    request: Request,
    # Required: omitted, the store drops its WHERE and returns every tenant's rows.
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    _authorize(request, tenant_id)
    return [definition.model_dump(mode="json") for definition in await store.list_evaluator_definitions(tenant_id)]


@router.post("/evaluators", status_code=201)
async def register_evaluator(
    body: EvaluatorDefinition,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, body.tenant_id)
    if settings.platform_auth_required:
        body.created_by = actor_from_request(request)
    try:
        if body.status != EvaluatorStatus.DRAFT:
            raise ValueError("new versions must be created as draft")
        definition = await store.save_evaluator_definition(body)
    except ValueError as exc:
        raise _conflict(exc) from exc
    return definition.model_dump(mode="json")


@router.post("/evaluators/{evaluator_id}/versions/{version}/approve")
async def approve_evaluator(
    evaluator_id: str,
    version: str,
    request: Request,
    tenant_id: str | None = None,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id, "eval-hub-approver")
    try:
        definition = await store.transition_evaluator_definition(evaluator_id, version, tenant_id, EvaluatorStatus.APPROVED, commit=False)
    except ValueError as exc:
        raise _conflict(exc) from exc
    if not definition:
        raise _not_found("Evaluator definition", f"{evaluator_id}@{version}")
    await _audit(store, request, tenant_id, "evaluator.approved", "evaluator", f"{evaluator_id}@{version}")
    return definition.model_dump(mode="json")


@router.get("/metric-packs")
async def list_metric_packs(
    request: Request,
    # Required: omitted, the store drops its WHERE and returns every tenant's rows.
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    _authorize(request, tenant_id)
    return [pack.model_dump(mode="json") for pack in await store.list_metric_packs(tenant_id)]


@router.post("/metric-packs", status_code=201)
async def install_metric_pack(
    body: MetricPackVersion,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, body.tenant_id)
    if settings.platform_auth_required:
        body.created_by = actor_from_request(request)
    try:
        if body.status != EvaluatorStatus.DRAFT:
            raise ValueError("new versions must be created as draft")
        pack = await store.save_metric_pack(body)
    except ValueError as exc:
        raise _conflict(exc) from exc
    return pack.model_dump(mode="json")


@router.post("/metric-packs/{metric_pack_id}/versions/{version}/approve")
async def approve_metric_pack(
    metric_pack_id: str,
    version: str,
    request: Request,
    tenant_id: str | None = None,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id, "eval-hub-approver")
    try:
        pack = await store.transition_metric_pack(metric_pack_id, version, tenant_id, EvaluatorStatus.APPROVED, commit=False)
    except ValueError as exc:
        raise _conflict(exc) from exc
    if not pack:
        raise _not_found("Metric pack", f"{metric_pack_id}@{version}")
    await _audit(store, request, tenant_id, "metric_pack.approved", "metric_pack", f"{metric_pack_id}@{version}")
    return pack.model_dump(mode="json")


@router.get("/findings")
async def list_findings(
    request: Request,
    tenant_id: str | None = Query(default=None),
    run_id: str | None = None,
    experiment_id: str | None = None,
    # Bounded by default. A passing run can still queue a finding per failing
    # row, so this list has no natural ceiling and the reader takes the newest.
    limit: int = Query(default=200, ge=1, le=500),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    """Findings scoped to the tenant — mirrors the run read endpoints, so every
    listed finding's run evidence deep-link is actually readable.

    ``tenant_id`` may be omitted when the BFF already sent ``x-evalai-tenant``.
    """
    resolved_tenant = resolve_requested_tenant(request, tenant_id)
    findings = await store.list_findings(run_id, experiment_id, tenant_id=resolved_tenant, limit=limit)
    mark_tenant_scope_checked(request)
    return [finding.model_dump(mode="json") for finding in findings]


class OpenCaseForReviewRequest(BaseModel):
    run_id: str
    row_id: str
    metric_id: str


@router.post("/review-cases", status_code=201)
async def open_case_for_review(
    body: OpenCaseForReviewRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Put one scored case in front of a reviewer, pass or fail.

    Findings are raised only for failures, so review on its own can only catch
    false alarms — a judge that passes everything looks perfect. This is how the
    other half gets reviewed. It records no verdict: the reviewer still decides
    through the normal agree/disagree flow.
    """
    _authorize(request, await _run_tenant(store, body.run_id), "eval-hub-reviewer")
    try:
        finding, created = await store.open_case_for_review(body.run_id, body.row_id, body.metric_id)
    except ValueError as exc:
        raise _invalid(exc, field="run_id") from exc
    return {"finding": finding.model_dump(mode="json"), "created": created}


@router.get("/judge-agreement")
async def judge_agreement(
    request: Request,
    tenant_id: str = Query(min_length=1),
    project_id: str | None = None,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    """How often reviewers agreed with the judge, per metric.

    The number a judge is worth trusting on. Derived entirely from review
    decisions already recorded — nothing new is asked of a reviewer, and no
    score is typed by hand: the workflow's existing agree/disagree verdict on a
    finding IS the signal.
    """
    # Tenant-authorized, no reviewer role: this is how far to trust the scores
    # you are already allowed to read, so it belongs with reading results rather
    # than behind the review queue. It exposes aggregate counts only — never a
    # reviewer, a rationale or a case.
    _authorize(request, tenant_id)
    return await store.judge_agreement_by_metric(tenant_id, project_id=project_id)


@router.get("/findings/{finding_id}/review-tasks")
async def list_review_tasks(
    finding_id: str,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    # Tenant-authorized against the finding's source run, matching the sibling
    # decision-history route. Without it one tenant could read another's review
    # queue by finding id, and a review task carries the case being judged.
    if not await store.get_finding(finding_id):
        raise _not_found("Finding", finding_id)
    _authorize(request, await _finding_tenant(store, finding_id), "eval-hub-reviewer")
    return [task.model_dump(mode="json") for task in await store.list_review_tasks(finding_id)]


@router.get("/findings/{finding_id}/review-decisions")
async def list_review_decision_history(
    finding_id: str,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    """Return the ordered, append-only decision history for a finding.

    Tenant-authorized against the finding's source run. Entries are oldest
    first; the most recent decision is ``is_current`` and every earlier one is
    ``superseded``.
    """

    tenant_id = await _finding_tenant(store, finding_id)
    _authorize(request, tenant_id, "eval-hub-reviewer")
    history = await store.list_review_decision_history(finding_id)
    return [entry.model_dump(mode="json") for entry in history]


class CreateFindingCommentRequest(BaseModel):
    body: str = Field(min_length=1, max_length=FINDING_COMMENT_MAX_LENGTH)
    author: str = ""


def _resolved_comment_author(request: Request, fallback: str) -> str:
    """The identity a comment is attributed to, or ``""`` when unresolved.

    With platform auth enabled the author always comes from the gateway
    subject header (``actor_from_request``); otherwise the client-supplied
    author is trusted (local/dev). Either way the placeholder ``system``
    identity is treated as unresolved — a collaboration comment must never be
    attributed to a placeholder.
    """

    author = actor_from_request(request) if settings.platform_auth_required else fallback
    author = author.strip()
    return "" if author == "system" else author


@router.post("/findings/{finding_id}/comments", status_code=201)
async def create_finding_comment(
    finding_id: str,
    body: CreateFindingCommentRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Append a comment to a finding. Mentions (``@token``) are parsed
    server-side and recorded with the comment; no notification is delivered."""

    tenant_id = await _finding_tenant(store, finding_id)
    _authorize(request, tenant_id, "eval-hub-reviewer")
    author = _resolved_comment_author(request, body.author)
    if not author:
        raise HTTPException(status_code=422, detail="A resolved author identity is required to comment")
    if not body.body.strip():
        raise HTTPException(status_code=422, detail="Comment body must not be blank")
    comment = FindingComment(
        finding_id=finding_id,
        tenant_id=tenant_id,
        author=author,
        body=body.body,
        mentions=parse_mentions(body.body),
    )
    try:
        saved = await store.create_finding_comment(comment)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await _audit(
        store,
        request,
        tenant_id,
        "finding.comment_created",
        "finding",
        finding_id,
        {"comment_id": saved.comment_id, "mentions": saved.mentions},
    )
    return saved.model_dump(mode="json")


@router.get("/findings/{finding_id}/comments")
async def list_finding_comments(
    finding_id: str,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    """Comments on a finding, oldest first. Tenant-authorized against the
    finding's source run, mirroring the decision-history read."""

    tenant_id = await _finding_tenant(store, finding_id)
    _authorize(request, tenant_id, "eval-hub-reviewer")
    return [comment.model_dump(mode="json") for comment in await store.list_finding_comments(finding_id)]


@router.get("/findings/{finding_id}/activity")
async def list_finding_activity(
    finding_id: str,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    """The finding's merged activity timeline, oldest first.

    Read-only view derived from already-persisted data (finding creation,
    review decisions, remediations and their audit-logged status changes,
    waivers, comments) — there is no separate event table, so edits/deletes
    are not tracked.
    """

    tenant_id = await _finding_tenant(store, finding_id)
    _authorize(request, tenant_id, "eval-hub-reviewer")
    try:
        events = await store.list_finding_activity(finding_id)
    except ValueError as exc:
        raise _not_found("Finding", finding_id) from exc
    return [event.model_dump(mode="json") for event in events]


@router.post("/review-decisions", status_code=201)
async def record_review_decision(
    body: ReviewDecision,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    tenant_id = await _finding_tenant(store, body.finding_id)
    _authorize(request, tenant_id, "eval-hub-reviewer")
    if settings.platform_auth_required:
        body.reviewer = actor_from_request(request)
    try:
        body = ReviewDecision.model_validate(body.model_dump(exclude={"decision_id", "created_at"}))
        decision = await store.create_review_decision(body)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await _audit(store, request, tenant_id, "finding.reviewed", "finding", body.finding_id, {"outcome": body.outcome.value})
    return decision.model_dump(mode="json")


@router.post("/findings/{finding_id}/waivers", status_code=201)
async def create_waiver(
    finding_id: str,
    body: Waiver,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    if body.finding_id != finding_id:
        raise HTTPException(status_code=422, detail="waiver finding_id must match the URL")
    tenant_id = await _finding_tenant(store, finding_id)
    _authorize(request, tenant_id, "eval-hub-approver")
    if settings.platform_auth_required:
        body.approved_by = actor_from_request(request)
    try:
        body = Waiver.model_validate(body.model_dump(exclude={"waiver_id", "created_at"}))
        waiver = await store.create_waiver(body)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await _audit(store, request, tenant_id, "finding.waived", "finding", finding_id, {"waiver_id": waiver.waiver_id})
    return waiver.model_dump(mode="json")


@router.post("/findings/{finding_id}/remediations", status_code=201)
async def create_remediation(
    finding_id: str,
    body: Remediation,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    if body.finding_id != finding_id:
        raise HTTPException(status_code=422, detail="remediation finding_id must match the URL")
    tenant_id = await _finding_tenant(store, finding_id)
    _authorize(request, tenant_id, "eval-hub-reviewer")
    if settings.platform_auth_required:
        body.created_by = actor_from_request(request)
    try:
        body = Remediation.model_validate(body.model_dump(exclude={"remediation_id", "created_at", "updated_at", "status"}))
        remediation = await store.create_remediation(body)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await _audit(store, request, tenant_id, "finding.remediation_created", "finding", finding_id, {"remediation_id": remediation.remediation_id})
    return remediation.model_dump(mode="json")


@router.get("/remediations")
async def list_remediations(
    request: Request,
    finding_id: str | None = None,
    tenant_id: str | None = Query(default=None, min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    resolved_tenant = resolve_requested_tenant(request, tenant_id)
    remediations = await store.list_remediations(finding_id, resolved_tenant)
    mark_tenant_scope_checked(request)
    return [remediation.model_dump(mode="json") for remediation in remediations]


class UpdateRemediationRequest(BaseModel):
    status: RemediationStatus


@router.patch("/remediations/{remediation_id}")
async def update_remediation(
    remediation_id: str,
    body: UpdateRemediationRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    remediation = await store.get_remediation(remediation_id)
    if not remediation:
        raise _not_found("Remediation", remediation_id)
    tenant_id = await _finding_tenant(store, remediation.finding_id)
    _authorize(request, tenant_id, "eval-hub-reviewer")
    updated = await store.update_remediation_status(remediation_id, body.status)
    await _audit(
        store,
        request,
        tenant_id,
        "finding.remediation_updated",
        "remediation",
        remediation_id,
        {"status": body.status.value},
    )
    return updated.model_dump(mode="json")


class PromoteRegressionRequest(BaseModel):
    kind: RegressionKind = RegressionKind.REGRESSION
    created_by: str = "system"


@router.post("/findings/{finding_id}/promote-regression", status_code=201)
async def promote_regression(
    finding_id: str,
    body: PromoteRegressionRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    tenant_id = await _finding_tenant(store, finding_id)
    _authorize(request, tenant_id, "eval-hub-approver")
    if settings.platform_auth_required:
        body.created_by = actor_from_request(request)
    try:
        case = await store.promote_finding_to_regression(finding_id, body.kind, body.created_by)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await _audit(store, request, tenant_id, "finding.promoted_to_regression", "finding", finding_id, {"regression_case_id": case.regression_case_id})
    return case.model_dump(mode="json")


@router.get("/regressions")
async def list_regressions(
    request: Request,
    # Required: omitted, the store drops its WHERE and returns every tenant's rows.
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    _authorize(request, tenant_id)
    return [case.model_dump(mode="json") for case in await store.list_regression_cases(tenant_id)]


class ReplayRequest(BaseModel):
    experiment_id: str
    created_by: str = "system"
    dry_run: bool = True
    seed: int | None = None
    frozen_mcp_responses: dict[str, Any] = Field(default_factory=dict)


@router.post("/regressions/{regression_case_id}/replay", status_code=201)
async def replay_regression(
    regression_case_id: str,
    body: ReplayRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
    engine: EvaluationEngine = Depends(get_evaluation_engine),
) -> dict[str, Any]:
    """Replay a promoted case using frozen evidence; target writes are never invoked."""
    case = await store.get_regression_case(regression_case_id)
    experiment = await store.get_experiment(body.experiment_id, require_caller_tenant(request))
    if not case or not experiment:
        raise _not_found("Regression case or experiment", regression_case_id)
    _authorize(request, experiment.tenant_id, "eval-hub-reviewer")
    _authorize(request, case.tenant_id)
    if not body.dry_run:
        raise HTTPException(status_code=422, detail="Regression replay only supports dry_run=true")
    if settings.platform_auth_required:
        body.created_by = actor_from_request(request)
    manifest = await store.get_run_manifest(experiment.run_manifest_id, experiment.tenant_id) if experiment.run_manifest_id else None
    if experiment.run_manifest_id and not manifest:
        raise HTTPException(status_code=409, detail="Experiment's pinned manifest is unavailable")
    row = EvaluationRow.model_validate(case.record)
    result = await run_in_threadpool(
        engine.execute,
        experiment,
        [row],
        None,
        TriggerReason.REPLAY,
        f"replay:{regression_case_id}",
        0,
        manifest,
    )
    result.run_type = RunType.REPLAY
    result.created_by = body.created_by
    result.artifact_refs.append(
        f"replay://{regression_case_id}?dry_run={str(body.dry_run).lower()}&seed={body.seed if body.seed is not None else ''}"
    )
    await store.save_run(result, [row])
    await store.annotate_evidence_pack(
        result.run_id,
        experiment.tenant_id,
        {
            "replay": {
                "regression_case_id": regression_case_id,
                "dry_run": True,
                "seed": body.seed,
                "frozen_mcp_responses": body.frozen_mcp_responses,
            }
        },
    )
    await _audit(store, request, experiment.tenant_id, "regression.replayed", "regression_case", regression_case_id, {"run_id": result.run_id})
    saved = await store.get_run(result.run_id)
    assert saved is not None
    return saved.model_dump(mode="json")


@router.get("/evidence-packs/{run_id}")
async def get_evidence_pack(
    run_id: str,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    tenant_id = resolve_requested_tenant(request, None)
    pack = await store.get_evidence_pack(run_id, tenant_id)
    if not pack:
        raise _not_found("Evidence pack", run_id)
    mark_tenant_scope_checked(request)
    return pack.model_dump(mode="json")


@router.get("/audit-events")
async def list_audit_events(
    request: Request,
    tenant_id: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    # An omitted tenant used to read every tenant's audit trail: the store
    # applies no filter for None. Resolve the caller's own scope instead.
    scope = resolve_requested_tenant(request, tenant_id)
    events = await store.list_audit_events(scope, limit)
    mark_tenant_scope_checked(request)
    return [event.model_dump(mode="json") for event in events]
