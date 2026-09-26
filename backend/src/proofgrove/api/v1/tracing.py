"""Tenant-scoped Projects and captured-trace browsing."""

import logging
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from proofgrove.api.dependencies import get_evaluation_store
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.models import ArchivedTraceSpan
from proofgrove.evaluation.trace_archive import TraceArchiveReader, tenant_from_namespace
from proofgrove.platform.authz import PERMISSION_EVIDENCE_READ, enforce_tenant, require_permission
from proofgrove.platform.contracts import ProjectPurpose
from proofgrove.settings import settings
from proofgrove.tracing.cost import estimate_span_cost_usd
from proofgrove.tracing.scoring import SpanScoringPreviewRequest, SpanScoringRequest, preview_fingerprint, preview_span

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tracing", tags=["tracing"])

# Pseudo-project id listing collector-confirmed traces that could not be
# attributed to a Project (index rows with project NULL). Honest by design:
# these are real production traces, just without a TargetProjectBinding home.
UNASSIGNED_PROJECT_ID = "unassigned"


def _authorize(request: Request, tenant_id: str) -> None:
    enforce_tenant(request, tenant_id)


def _unassigned_pseudo_project(tenant_id: str, trace_count: int, last_activity_at: Any) -> dict[str, Any]:
    return {
        "project_id": UNASSIGNED_PROJECT_ID,
        "tenant_id": tenant_id,
        "name": "Unassigned",
        "description": ("Collector-confirmed production traces whose resource attributes did not resolve to a Project binding."),
        "system_type": "observability",
        "owner": "trace-collector",
        "status": "active",
        "purpose": "system",
        "tags": {},
        "created_by": "trace-index",
        "classification_state": "classified",
        "trace_count": trace_count,
        "last_activity_at": last_activity_at,
    }


async def _trace_project(store: EvaluationStore, project_id: str, tenant_id: str) -> None:
    project = await store.get_project(project_id, tenant_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.purpose == ProjectPurpose.CATALOG_REGISTRY:
        raise HTTPException(
            status_code=409,
            detail="Project is an internal catalog registry, not an evaluation trace workspace",
        )


@router.get("/projects")
async def list_trace_projects(
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    _authorize(request, tenant_id)
    projects = await store.list_trace_projects(tenant_id)
    unassigned_count, last_activity = await store.unassigned_trace_stats(tenant_id)
    if unassigned_count:
        projects.append(_unassigned_pseudo_project(tenant_id, unassigned_count, last_activity))
    return projects


@router.get("/projects/{project_id}/traces")
async def list_project_traces(
    project_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict[str, Any]]:
    _authorize(request, tenant_id)
    await _trace_project(store, project_id, tenant_id)
    return await store.list_project_traces(project_id, tenant_id, limit=limit, offset=offset)


@router.get("/projects/{project_id}/traces/page")
async def list_project_traces_page(
    project_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None),
    search: str | None = Query(default=None, max_length=256),
    run_id: str | None = Query(default=None, min_length=1, max_length=128),
    status: Literal["succeeded", "error", "unknown"] | None = Query(default=None),
    since: datetime | None = Query(default=None),
    until: datetime | None = Query(default=None),
    include_hidden: bool = Query(default=False),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Cursor-paginated traces for a Project workspace.

    Keyset paging (stable under insertion) returning
    ``{items, next_cursor, has_more, total}``. Prefer this over the offset-based
    ``/traces`` list for the Project workspace; the archive is never read here.

    Optional filters are applied in SQL so pagination and the distinct-trace
    ``total`` stay honest under them: ``search`` (case-insensitive substring
    over trace id / evaluation name / example id), ``run_id`` (exact
    evaluation-run identity), ``status`` (invocation outcome) and
    ``since``/``until`` (inclusive ISO datetime bounds on the captured-at sort
    key). Sorting stays captured-at descending.

    Served from the collector-confirmed trace index whenever the index holds
    rows for this Project (``source: "index"``; items gain lifecycle_state,
    span/error counts, root span and model, and the index path classifies the
    outcome/search filters over archived span data). Falls back to the
    eval-derived projection when the index is still empty
    (``source: "projection"``) so existing workspaces never go blank.
    ``project_id=unassigned`` lists index rows without a Project home.
    """
    _authorize(request, tenant_id)
    if project_id == UNASSIGNED_PROJECT_ID:
        return await store.list_trace_index_page(
            tenant_id,
            None,
            limit=limit,
            cursor=cursor,
            search=search,
            run_id=run_id,
            status=status,
            since=since,
            until=until,
            include_hidden=include_hidden,
        )
    await _trace_project(store, project_id, tenant_id)
    if await store.count_trace_index(tenant_id, project_id) > 0:
        return await store.list_trace_index_page(
            tenant_id,
            project_id,
            limit=limit,
            cursor=cursor,
            search=search,
            run_id=run_id,
            status=status,
            since=since,
            until=until,
            include_hidden=include_hidden,
        )
    return await store.list_project_traces_page(
        project_id,
        tenant_id,
        limit=limit,
        cursor=cursor,
        search=search,
        run_id=run_id,
        status=status,
        since=since,
        until=until,
    )


async def _set_trace_hidden(
    store: EvaluationStore,
    project_id: str,
    tenant_id: str,
    trace_id: str,
    *,
    hidden: bool,
) -> dict[str, Any]:
    if project_id != UNASSIGNED_PROJECT_ID:
        await _trace_project(store, project_id, tenant_id)
    updated = await store.set_trace_hidden(
        tenant_id,
        None if project_id == UNASSIGNED_PROJECT_ID else project_id,
        trace_id,
        hidden=hidden,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Trace not found")
    return {"trace_id": trace_id, "hidden": hidden}


@router.post("/projects/{project_id}/traces/{trace_id}/hide")
async def hide_trace(
    project_id: str,
    trace_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    return await _set_trace_hidden(store, project_id, tenant_id, trace_id, hidden=True)


@router.post("/projects/{project_id}/traces/{trace_id}/unhide")
async def unhide_trace(
    project_id: str,
    trace_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    return await _set_trace_hidden(store, project_id, tenant_id, trace_id, hidden=False)


@router.get("/projects/{project_id}/spans/page")
async def list_project_spans_page(
    project_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None),
    search: str | None = Query(default=None, max_length=256),
    status: Literal["ok", "error", "unset"] | None = Query(default=None),
    since: datetime | None = Query(default=None),
    until: datetime | None = Query(default=None),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Project-wide span summaries from the collector-confirmed span index.

    One row per archived span — bounded previews only, full payloads stay in
    the archive — populated when the index worker confirms a trace. Lists model,
    agent, tool and retrieval spans; transport and framework plumbing are
    indexed but never listed, so the total counts what is shown. Keyset-paged
    like ``/traces/page`` with the same envelope; ``status`` filters the
    archived OTLP status and ``search`` matches span name or trace id.
    ``project_id=unassigned`` lists spans of traces without a Project home.
    """
    _authorize(request, tenant_id)
    if project_id != UNASSIGNED_PROJECT_ID:
        await _trace_project(store, project_id, tenant_id)
    return await store.list_span_index_page(
        tenant_id,
        None if project_id == UNASSIGNED_PROJECT_ID else project_id,
        limit=limit,
        cursor=cursor,
        search=search,
        status=status,
        since=since,
        until=until,
    )


async def _load_trace(store: EvaluationStore, project_id: str, tenant_id: str, trace_id: str) -> dict[str, Any]:
    """Return the archive-free trace summary or raise 404. Never touches the archive."""
    trace = await store.get_project_trace(project_id, tenant_id, trace_id)
    if not trace:
        raise HTTPException(status_code=404, detail="Trace not found")
    return trace


async def _lookup_spans(project_id: str, trace_id: str, run: Any, tenant_id: str) -> dict[str, Any]:
    """Resolve archived spans for a trace.

    This is the only place the archive is read. It raises HTTP 503 when the
    archive is unreachable so an archive outage never leaks into the summary
    surface (header/summary/scores).

    ``tenant_id`` is the caller's own authorized tenant (already enforced by
    the route), not ``settings.pod_namespace``: the archive prefix used to be
    derived from the SERVICE's own deployment namespace regardless of which
    tenant the request was actually scoped to, which is only correct by
    accident in a strictly one-tenant-per-pod deployment and reads the wrong
    tenant's archive prefix in any other topology.
    """
    try:
        archived = await TraceArchiveReader(settings).find(
            trace_id=trace_id,
            tenant=tenant_from_namespace(tenant_id),
            started_at=run.started_at if run else None,
            completed_at=run.completed_at if run else None,
        )
    except Exception as exc:
        # Type only: an object-store error message can name the endpoint and bucket.
        logger.error("Trace archive lookup failed for project=%s trace=%s", project_id, trace_id, extra={"error_type": type(exc).__name__})
        raise HTTPException(
            status_code=503,
            detail={
                "code": "trace_archive_unavailable",
                "field": "archived_spans",
                "message": "Archived spans are temporarily unavailable; trace summary and scores remain available.",
                "recovery": "Retry the span archive. If this persists, verify collector and archive configuration.",
            },
        ) from exc
    if archived.state == "available":
        spans = []
        for span in archived.spans:
            payload = span.model_dump(mode="json")
            payload["estimated_cost_usd"] = estimate_span_cost_usd(span.attributes)
            spans.append(payload)
        return {
            "spans": spans,
            "tree_available": bool(spans) and all(span.get("span_id") for span in spans) and any(span.get("parent_span_id") for span in spans),
            "lifecycle_state": "available",
            "lifecycle_message": archived.message,
            "archive_truncated": archived.truncated,
        }
    return {
        "spans": [],
        "tree_available": False,
        "lifecycle_state": "archive_unavailable",
        "lifecycle_message": (
            "No archived spans matched this trace ID."
            if run is None and archived.state == "pending"
            else archived.message or "Archived OpenTelemetry spans are not available for this trace."
        ),
        "archive_truncated": False,
    }


@router.post("/projects/{project_id}/span-scoring/preview")
async def preview_span_scoring(
    project_id: str,
    payload: SpanScoringPreviewRequest,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Preview the selected spans' own evidence and compatible catalog checks."""
    _authorize(request, tenant_id)
    # This POST returns archived span bodies: the same evidence GET .../spans
    # gates on evidence.read, so launching evaluations alone is not enough.
    await require_permission(request, PERMISSION_EVIDENCE_READ)
    await _trace_project(store, project_id, tenant_id)
    archived_by_trace = {}
    items = []
    seen = set()
    for selection in payload.spans:
        identity = (selection.trace_id, selection.span_id)
        if identity in seen:
            raise HTTPException(status_code=422, detail="Select each span only once")
        seen.add(identity)
        if selection.trace_id not in archived_by_trace:
            trace = await _load_trace(store, project_id, tenant_id, selection.trace_id)
            run = await store.get_run(trace["run_id"]) if trace.get("run_id") else None
            archived = await _lookup_spans(project_id, selection.trace_id, run, tenant_id)
            archived_by_trace[selection.trace_id] = {span["span_id"]: span for span in archived["spans"]}
        span = archived_by_trace[selection.trace_id].get(selection.span_id)
        if span is None:
            raise HTTPException(status_code=404, detail="Selected span is not available in the captured trace")
        items.append(preview_span(ArchivedTraceSpan.model_validate(span), selection))
    return {"items": items, "preview_hash": preview_fingerprint(items)}


def _span_job_payload(job) -> dict[str, Any]:
    return {
        "job_id": job.run_id,
        "status": job.status,
        "results": job.params.get("results", []),
        "span_count": len(job.params.get("items", [])),
        "metric_ids": job.params.get("metric_ids", []),
        "error": job.error_message,
    }


@router.post("/projects/{project_id}/span-scoring", status_code=202)
async def start_span_scoring(
    project_id: str,
    payload: SpanScoringRequest,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    # Before the existing-job branch: a retry that returns the stored job
    # carries the previewed span evidence too.
    await require_permission(request, PERMISSION_EVIDENCE_READ)
    await _trace_project(store, project_id, tenant_id)
    job_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"span-score:{tenant_id}:{project_id}:{payload.request_id}"))
    request_hash = preview_fingerprint([payload.model_dump(mode="json")])
    job = await store.get_run_job(job_id, tenant_id=tenant_id)
    if job is not None:
        if job.kind != "span_score" or job.params.get("request_hash") != request_hash:
            raise HTTPException(status_code=409, detail="This request ID was already used with different scoring options")
    else:
        preview = await preview_span_scoring(project_id, payload, request, tenant_id, store)
        if preview["preview_hash"] != payload.preview_hash:
            raise HTTPException(status_code=409, detail="Span evidence or available checks changed. Review the preview again.")
        if len(set(payload.metric_ids)) != len(payload.metric_ids):
            raise HTTPException(status_code=422, detail="Select each check only once")
        from proofgrove.evaluation.judge_models import is_judge_model

        if any(not metric_id.startswith("ops.") for metric_id in payload.metric_ids) and not is_judge_model(payload.judge_model):
            raise HTTPException(status_code=422, detail="Choose a judge model for the selected quality checks")
        for item in preview["items"]:
            available = {check["metric_id"] for check in item["checks"] if check["available"]}
            if set(payload.metric_ids) - available:
                raise HTTPException(status_code=422, detail="Selected checks are not available for every selected span. Review the preview.")
        from proofgrove.evaluation.metrics import get_metric

        params = {
            "metric_definitions": [get_metric(metric_id).model_dump(mode="json") for metric_id in payload.metric_ids],
            "project_id": project_id,
            "tenant_id": tenant_id,
            "request_hash": request_hash,
            "preview_hash": payload.preview_hash,
            "items": preview["items"],
            "metric_ids": payload.metric_ids,
            "span_keys": {f"{item['trace_id']}:{item['span_id']}": True for item in preview["items"]},
            "results": [],
        }
        try:
            job = await store.create_span_scoring_job(job_id=job_id, tenant_id=tenant_id, params=params, judge_model=payload.judge_model)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    if settings.evaluation_runtime == "temporal" and job.status == "pending":
        from temporalio.exceptions import WorkflowAlreadyStartedError

        from proofgrove.orchestrator.temporal import submit_dataset_run

        try:
            await submit_dataset_run(job_id)
        except WorkflowAlreadyStartedError:
            pass  # A retry already submitted this deterministic job ID.
        except Exception as exc:
            logger.error("Span scoring workflow submission failed for %s", job_id, extra={"error_type": type(exc).__name__})
            raise HTTPException(status_code=503, detail="Scoring could not start. Retry this submission.") from exc
    return _span_job_payload(job)


@router.get("/projects/{project_id}/span-scoring/{job_id}")
async def get_span_scoring_job(
    project_id: str,
    job_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    await _trace_project(store, project_id, tenant_id)
    job = await store.get_run_job(job_id, tenant_id=tenant_id)
    if job is None or job.kind != "span_score" or job.params.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Span scoring job not found")
    return _span_job_payload(job)


@router.get("/projects/{project_id}/traces/{trace_id}/spans/{span_id}/scores")
async def get_span_scores(
    project_id: str,
    trace_id: str,
    span_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    _authorize(request, tenant_id)
    await _trace_project(store, project_id, tenant_id)
    await _load_trace(store, project_id, tenant_id, trace_id)
    jobs = await store.list_span_scoring_jobs(tenant_id=tenant_id, project_id=project_id, trace_id=trace_id, span_id=span_id)
    return {"jobs": [{**_span_job_payload(job), "results": [result for result in job.params.get("results", []) if result["trace_id"] == trace_id and result["span_id"] == span_id]} for job in jobs], "limit": 20}


@router.get("/projects/{project_id}/traces/{trace_id}/summary")
async def get_project_trace_summary(
    project_id: str,
    trace_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Trace header/summary only. Never reads the archive, so it cannot 503.

    Use this together with ``/spans`` so a span-archive outage still renders the
    header, summary and scores instead of failing the whole trace page.
    """
    _authorize(request, tenant_id)
    if project_id != UNASSIGNED_PROJECT_ID:
        await _trace_project(store, project_id, tenant_id)
    return await _load_trace(store, project_id, tenant_id, trace_id)


@router.get("/projects/{project_id}/traces/{trace_id}/spans")
async def get_project_trace_spans(
    project_id: str,
    trace_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Archived spans for a trace. This is the only surface that reads the archive.

    Returns 404 when the trace identity is unknown and 503 (alone) when the span
    archive is temporarily unavailable.
    """
    _authorize(request, tenant_id)
    if project_id != UNASSIGNED_PROJECT_ID:
        await _trace_project(store, project_id, tenant_id)
    trace = await _load_trace(store, project_id, tenant_id, trace_id)
    run = await store.get_run(trace["run_id"]) if trace.get("run_id") else None
    return await _lookup_spans(project_id, trace_id, run, tenant_id)


@router.get("/projects/{project_id}/traces/{trace_id}", deprecated=True)
async def get_project_trace(
    project_id: str,
    trace_id: str,
    request: Request,
    tenant_id: str = Query(min_length=1),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict[str, Any]:
    """Deprecated combined summary + spans lookup.

    Prefer ``/summary`` and ``/spans`` fetched independently: this endpoint does
    the archive lookup inline and returns 503 on archive failure, which takes
    down the whole trace page (summary and scores included). Kept for backward
    compatibility only.
    """
    _authorize(request, tenant_id)
    if project_id != UNASSIGNED_PROJECT_ID:
        await _trace_project(store, project_id, tenant_id)
    trace = await _load_trace(store, project_id, tenant_id, trace_id)
    run = await store.get_run(trace["run_id"]) if trace.get("run_id") else None
    trace.update(await _lookup_spans(project_id, trace_id, run, tenant_id))
    return trace
