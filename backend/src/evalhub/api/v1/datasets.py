"""FastAPI routes for Golden Dataset Registry.

Postgres-backed golden dataset registry: records + governance in one store.

Endpoints:
    POST   /datasets                          → create dataset
    POST   /datasets/generate                  → start durable generation job (202)
    GET    /datasets/generation-jobs/{id}      → generation job phase/progress
    POST   /datasets/generation-jobs/{id}/cancel → cancel generation job (idempotent)
    GET    /datasets                           → list datasets (filtered)
    GET    /datasets/{name}                    → get dataset info
    POST   /datasets/{name}/records            → merge records
    GET    /datasets/{name}/records            → get current records
    DELETE /datasets/{name}/records            → delete records by ID
    POST   /datasets/{name}/versions           → create new version
    POST   /datasets/{name}/restore            → copy retired version into a draft
    POST   /datasets/{name}/validate           → run quality gate
    POST   /datasets/{name}/approve            → approve (human sign-off)
    POST   /datasets/{name}/publish            → publish (immutable)
    POST   /datasets/{name}/deprecate          → deprecate
    POST   /datasets/{name}/retire             → retire
    GET    /datasets/{name}/history            -> version history
    DELETE /datasets/{name}                    → delete dataset
"""

import functools
import logging
from typing import Any, NoReturn

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.encoders import jsonable_encoder

from evalhub.api.dependencies import get_evaluation_store, get_registry_service
from evalhub.datasets import generation_service
from evalhub.datasets.csv_parser import (
    _METADATA_TAG_KEYS,
    _PRESENTED_TAG_KEYS,
    parse_csv,
)
from evalhub.datasets.enums import DatasetStatus
from evalhub.datasets.exceptions import (
    DatasetError,
    DatasetImmutableError,
    DatasetNotFoundError,
    DatasetValidationError,
    InvalidTransitionError,
)
from evalhub.datasets.models import (
    ApproveRequest,
    CreateDatasetRequest,
    CreateVersionRequest,
    DatasetFilterParams,
    DatasetRecord,
    DatasetReviewRequest,
    DeleteRecordsRequest,
    GenerateDatasetRequest,
    MergeRecordsRequest,
    PaginatedItems,
    PromoteRunItemRequest,
    PromoteRunItemResult,
    RestoreDatasetRequest,
    WriteExpectedToolsRequest,
    WriteExpectedToolsResult,
)
from evalhub.datasets.postgres_store import expectations_with_expected_tools
from evalhub.datasets.registry import DatasetRegistryService
from evalhub.db.store import EvaluationStore
from evalhub.evaluation.dataset_bridge import _EXPECTED_KEYS, _QUERY_KEYS
from evalhub.evaluation.models import RunItemDetail
from evalhub.evaluation.target.discovery import resolve_catalogued_grounding
from evalhub.platform.authz import (
    actor_from_request,
    authorize_dataset_access,
    caller_tenant,
    enforce_tenant,
    mark_tenant_scope_checked,
    require_caller_tenant,
    resolve_requested_tenant,
)
from evalhub.platform.payloads import TRUNCATION_MARKER
from evalhub.platform.url_guard import AgentCatalogError, validate_outbound_url
from evalhub.settings import settings

logger = logging.getLogger(__name__)

def authorize_dataset_tenant(
    request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> None:
    """Authorize every dataset-scoped route against that dataset's own tenant.

    Datasets are addressed by a globally unique name rather than under a tenant
    path, so a caller holding one tenant's identity could otherwise read or
    mutate another tenant's dataset simply by knowing its name. List and search
    are already tenant-scoped; only direct name access was not.

    Registered on the router rather than per endpoint so a route added later is
    covered by construction instead of by memory. Routes with no
    ``dataset_name`` (list, stats, csv-template, generate) are unaffected.
    """
    dataset_name = request.path_params.get("dataset_name")
    if not dataset_name:
        return
    try:
        tenant_id = svc.get_dataset_tenant(dataset_name, caller_tenant(request))
    except DatasetNotFoundError:
        raise HTTPException(status_code=404, detail="Dataset not found") from None
    authorize_dataset_access(request, tenant_id)


def _authorize_named_dataset(
    http_request: Request,
    svc: DatasetRegistryService,
    dataset_name: str,
) -> None:
    """Authorize a dataset named in a request *body* rather than the path.

    The router dependency keys off ``path_params``, so it cannot see a name
    carried in the body. Those routes are not harmless: ``create_dataset``
    reuses an existing DRAFT and versions an existing non-DRAFT, and generation
    replaces the records of a reused DRAFT — both reachable with only a name.

    A name that does not resolve is left alone: creating a genuinely new dataset
    is the normal case, and there is no owner to check against yet.
    """
    try:
        owner = svc.get_dataset_tenant(dataset_name, caller_tenant(http_request))
    except DatasetNotFoundError:
        return
    authorize_dataset_access(http_request, owner)



router = APIRouter(
    prefix="/datasets",
    tags=["datasets"],
    dependencies=[Depends(authorize_dataset_tenant)],
)

# The golden CSV template, served so the UI can offer a "download template" for
# the upload path. A dataset row is a question, an expected output and a
# metadata blob; the column order is frozen so saved files keep parsing.
_TEMPLATE_CSV = (
    "Serial No,Question,Expected Output,Metadata\n"
    '1,"What was Apple\'s FY2023 revenue?","Apple\'s FY2023 revenue was $383.285 billion.",'
    '"{""risk"": ""Low"", ""expected_actions"": ""search(query=\'Apple FY2023 revenue\')""}"\n'
    '2,"What is the capital of France?","Paris",'
    '"{""risk"": ""Low"", ""context"": ""Paris is the capital and most populous city of France.""}"\n'
)


def _page_window(limit: int | None, offset: int, cursor: str | None) -> tuple[int, int] | None:
    """Resolve additive paging params into a ``(limit, offset)`` window.

    Returns ``None`` when the caller did not opt into paging (legacy bare-list
    behaviour). A ``cursor`` (opaque stringified offset, as issued in
    ``next_cursor``) overrides ``offset``; an unparseable cursor is a 400.
    """
    if limit is None and cursor is None:
        return None
    if cursor is not None:
        try:
            offset = max(0, int(cursor))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid cursor") from None
    return (limit if limit is not None else 50, offset)


def _paged_envelope(items: list[dict[str, Any]], total: int, limit: int, offset: int) -> dict[str, Any]:
    """Build the shared ``{items, total, limit, offset, next_cursor}`` envelope."""
    next_offset = offset + limit
    return PaginatedItems(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
        next_cursor=str(next_offset) if next_offset < total else None,
    ).model_dump()


def _event_actor(http_request: Request) -> str | None:
    """The actor recorded on a dataset history event for a body-less transition.

    Same binding the body-carrying transitions use (``approved_by`` /
    ``decided_by`` are overwritten from the authenticated identity when auth is
    on). Validate, publish, deprecate and retire carry no actor in their body,
    so with auth off there is nothing trustworthy to record and the event stays
    unknown rather than claiming ``system`` did it.
    """
    if settings.platform_auth_required:
        return actor_from_request(http_request)
    return None


def _handle_error(e: Exception) -> NoReturn:
    """Map domain exceptions to HTTP status codes."""
    from pydantic import ValidationError

    if isinstance(e, HTTPException):
        # An authorization or handler-raised HTTP error already carries its
        # status; swallowing it into the terminal 500 would misreport a denial
        # as a server fault (and echo the original detail inside it).
        raise e
    if isinstance(e, DatasetNotFoundError):
        raise HTTPException(status_code=404, detail=str(e))
    if isinstance(e, DatasetImmutableError):
        raise HTTPException(status_code=409, detail=str(e))
    if isinstance(e, InvalidTransitionError):
        raise HTTPException(status_code=409, detail=str(e))
    if isinstance(e, DatasetValidationError):
        raise HTTPException(status_code=422, detail=str(e))
    if isinstance(e, UnicodeDecodeError):
        # An Excel export in a Windows code page is a routine user error; it
        # used to fall through to the 500 branch with a stack trace per upload.
        raise HTTPException(status_code=422, detail="CSV must be UTF-8 encoded")
    if isinstance(e, ValidationError):
        raise HTTPException(status_code=422, detail=jsonable_encoder(e.errors(), custom_encoder={ValueError: str}))
    if isinstance(e, DatasetError):
        raise HTTPException(status_code=400, detail=str(e))
    # Unknown failure: str(e) on a driver error can embed the statement and its
    # bound parameters — for record writes that is the promoted/merged text
    # itself, and a traceback carries that message into shared operational
    # logs. Record the type only, as the workers do; return none of it.
    logger.error("Unhandled dataset route error", extra={"error_type": type(e).__name__})
    raise HTTPException(status_code=500, detail="Internal error")


# ------------------------------------------------------------------
# Create
# ------------------------------------------------------------------


@router.post("", status_code=201)
def create_dataset(
    request: CreateDatasetRequest,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Create a new dataset with governance metadata (DRAFT status)."""
    # The body claims a tenant; a caller must not attribute a dataset to one
    # that is not theirs. And the name may already belong to somebody: create
    # reuses an existing DRAFT and versions an existing non-DRAFT, so an
    # unchecked name reaches another tenant's dataset without ever touching a
    # path route. Both run outside the try: `_handle_error` maps anything it
    # does not recognise to 500, which would swallow the refusal.
    enforce_tenant(http_request, request.tenant_id)
    _authorize_named_dataset(http_request, svc, request.dataset_name)
    if settings.platform_auth_required:
        request.created_by = actor_from_request(http_request)
    try:
        info = svc.create_dataset(request)
        return info.model_dump()
    except Exception as e:
        _handle_error(e)


# ------------------------------------------------------------------
# List / Get
# ------------------------------------------------------------------


@router.get("")
def list_datasets(
    http_request: Request,
    tenant_id: str | None = Query(None),
    product_id: str | None = Query(None),
    status: DatasetStatus | None = Query(None),
    exclude_status: list[DatasetStatus] | None = Query(None),
    limit: int | None = Query(None, ge=1, le=500),
    offset: int = Query(0, ge=0),
    cursor: str | None = Query(None),
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> list[dict[str, Any]] | dict[str, Any]:
    """List datasets with optional filters.

    Tenant-scoped exactly like ``GET /datasets/stats``: the tenant comes from the
    explicit query param, then the gateway ``x-evalai-tenant`` header, then
    ``POD_NAMESPACE``. An unscoped read would both leak other tenants' datasets
    and make the library's scoped status chips disagree with this endpoint's
    ``total``.

    Additive server paging: without ``limit``/``cursor`` the response stays the
    legacy bare list; with them it is the ``{items, total, limit, offset,
    next_cursor}`` envelope so the UI can page large tenants honestly.
    """
    resolved_tenant = resolve_requested_tenant(http_request, tenant_id)
    window = _page_window(limit, offset, cursor)
    try:
        filters = DatasetFilterParams(
            tenant_id=resolved_tenant,
            product_id=product_id,
            status=status,
            exclude_statuses=exclude_status or [],
        )
        if window is None:
            result = svc.list_datasets(filters)
            mark_tenant_scope_checked(http_request)
            return result
        page_limit, page_offset = window
        items, total = svc.list_datasets_page(filters=filters, limit=page_limit, offset=page_offset)
        mark_tenant_scope_checked(http_request)
        return _paged_envelope(items, total, page_limit, page_offset)
    except Exception as e:
        _handle_error(e)


@router.get("/stats")
def dataset_stats(
    http_request: Request,
    tenant_id: str | None = Query(None),
    product_id: str | None = Query(None),
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Return aggregate dataset counts by lifecycle status.

    Single source of truth for Overview "Published datasets" and library
    status chips. Definition of **published** = enum status ``PUBLISHED``.
    """
    resolved_tenant = resolve_requested_tenant(http_request, tenant_id)
    try:
        filters = DatasetFilterParams(
            tenant_id=resolved_tenant,
            product_id=product_id,
            status=None,
        )
        result = svc.dataset_stats(filters)
        mark_tenant_scope_checked(http_request)
        return result
    except Exception as e:
        _handle_error(e)


@router.get("/csv-template")
def csv_template() -> dict[str, Any]:
    """Return the upload CSV template + column docs.

    Declared before ``/{dataset_name}`` so it is not captured as a dataset name.
    """
    columns = {
        "Serial No": "row number in the dataset",
        "Question": "the question to ask the agent or model — the only required column",
        "Expected Output": "ground-truth answer / expected response",
        "Metadata": (
            "optional: a JSON object with anything else the row carries. "
            "Recognised keys include \"risk\" (e.g. Low, Medium, High), "
            "\"context\" (the retrieval passage the answer is grounded in) and "
            "\"expected_actions\" (the tool calls the agent should make, as "
            "\"tool(args)\" entries separated by \";\"). Metadata decides which "
            "metrics can be graded, never which evaluation can run"
        ),
    }
    return {"csv": _TEMPLATE_CSV, "columns": columns}


@router.post("/generate", status_code=202)
async def generate_dataset(
    request: GenerateDatasetRequest,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Start async synthetic dataset generation; returns 202 + a durable job.

    ``generation_method=llms`` expands one prompt into ``num_rows`` records.
    Otherwise each seed is grounded via MCP and synthesised into a golden row.

    The job is persisted in the datasets store and executed by an in-process
    background task, so it survives page navigation. Poll
    ``GET /datasets/generation-jobs/{job_id}`` for phase/progress and
    ``POST /datasets/generation-jobs/{job_id}/cancel`` to cancel.
    The legacy ``status: "pending"`` field is kept for existing callers.
    """
    # Generation registers through create_dataset and then replaces records, so
    # an unchecked target name lets a caller overwrite another tenant's DRAFT.
    # Checked before input validation: an unauthorized caller should not learn
    # whether their request body was well-formed.
    await run_in_threadpool(_authorize_named_dataset, http_request, svc, request.dataset_name)
    method = (request.generation_method or "").strip().lower() or None
    if not request.seeds:
        detail = (
            "a generation prompt / instruction is required"
            if method == "llms"
            else "at least one seed topic is required"
        )
        raise HTTPException(status_code=422, detail=detail)
    if method == "llms":
        if not request.num_rows or request.num_rows < 1:
            raise HTTPException(status_code=422, detail="Size (num_rows) must be >= 1 for LLM generation")
        if not request.model:
            raise HTTPException(status_code=422, detail="a Compass generation model is required")
    elif not request.grounding_url:
        raise HTTPException(status_code=422, detail="grounding_url is required for tools/agents generation")
    if request.grounding_tool in settings.excluded_tool_names:
        # The platform memory tools are excluded from evaluation everywhere
        # (discovery, captured traces); grounding would call one as the Eval
        # Hub workload with no user identity. The worker refuses them too.
        raise HTTPException(status_code=422, detail=f"grounding_tool {request.grounding_tool!r} is a platform memory tool and cannot ground generation")

    # The caller's own tenant, not the pod's -- a shared-namespace deployment
    # (or the "local" fallback) previously accepted the request as whichever
    # tenant the pod happened to run as, regardless of who actually called it.
    tenant_id = require_caller_tenant(http_request)
    enforce_tenant(http_request, tenant_id)
    grounding_url = request.grounding_url
    if grounding_url:
        try:
            grounding_url = await validate_outbound_url(
                grounding_url, tenant_namespace=settings.pod_namespace or tenant_id
            )
            # Tenant catalog only: the server must be one of this tenant's tool
            # servers and the tool one it advertises. The worker re-checks the
            # pair before it connects, so a queued job cannot outlive the catalog.
            await resolve_catalogued_grounding(
                kagent_url=settings.kagent_url,
                namespace=settings.pod_namespace or tenant_id,
                excluded_tools=settings.excluded_tool_names,
                url=grounding_url,
                tool=request.grounding_tool,
            )
        except AgentCatalogError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except httpx.HTTPError as exc:
            # Cannot verify the pair: refuse, and say it is the catalog, not the input.
            logger.warning("eval-hub: tool-server discovery failed", extra={"error_type": type(exc).__name__})
            raise HTTPException(status_code=502, detail="kagent tool listing failed") from exc
    params = {
        "generation_method": method,
        "grounding_url": grounding_url,
        "grounding_tool": request.grounding_tool,
        "seeds": request.seeds,
        "num_rows": request.num_rows,
        "domain": request.domain,
        "agent": request.agent,
        "product_id": request.product_id,
        "model": request.model,
        "tenant_id": tenant_id,
    }
    try:
        job = await generation_service.start_generation(
            dataset_name=request.dataset_name, params=params, registry=svc
        )
    except Exception as e:
        _handle_error(e)
    # Additive: legacy fields first, then the durable job shape.
    return {"status": "pending", **_job_response(job)}


def _job_response(job: dict[str, Any]) -> dict[str, Any]:
    """Public generation-job payload (internal params stay server-side)."""
    payload = {key: value for key, value in job.items() if key != "params"}
    if payload.get("error"):
        # Older rows can contain arbitrary provider text, not just credential shapes.
        payload["error"] = "Dataset generation failed. Check the generation inputs and try again."
    return payload


@router.get("/generation-jobs/{job_id}")
def get_generation_job(job_id: str, http_request: Request) -> dict[str, Any]:
    """Return the durable generation job (phase, progress, error, result)."""
    tenant_id = resolve_requested_tenant(http_request, None)
    job = generation_service.get_generation_job(job_id, tenant_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Generation job '{job_id}' not found")
    mark_tenant_scope_checked(http_request)
    return _job_response(job)


@router.post("/generation-jobs/{job_id}/cancel")
async def cancel_generation_job(job_id: str, http_request: Request) -> dict[str, Any]:
    """Cancel a not-yet-finished generation job (idempotent).

    Cancelling an already-cancelled job returns it unchanged (200); a job that
    has entered registration or completed/failed cannot honestly be cancelled (409).
    """
    tenant_id = resolve_requested_tenant(http_request, None)
    cancelled = await generation_service.cancel_generation(job_id, tenant_id)
    if cancelled is None:
        raise HTTPException(status_code=404, detail=f"Generation job '{job_id}' not found")
    if cancelled["phase"] != "cancelled":
        raise HTTPException(
            status_code=409,
            detail=f"Generation job '{job_id}' already {cancelled['phase']} — nothing to cancel",
        )
    mark_tenant_scope_checked(http_request)
    return _job_response(cancelled)


@router.get("/{dataset_name}")
def get_dataset(
    dataset_name: str,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Get dataset info (records + governance metadata)."""
    try:
        info = svc.get_dataset(dataset_name, require_caller_tenant(http_request))
        return info.model_dump()
    except Exception as e:
        _handle_error(e)


# ------------------------------------------------------------------
# Records
# ------------------------------------------------------------------


@router.post("/{dataset_name}/records", status_code=201)
def merge_records(
    dataset_name: str,
    request: MergeRecordsRequest,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Merge records into a DRAFT dataset (creates a new version)."""
    try:
        count = svc.merge_records(dataset_name, require_caller_tenant(http_request), request.records)
        return {"merged": count, "dataset_name": dataset_name}
    except Exception as e:
        _handle_error(e)


@router.post("/{dataset_name}/upload-csv", status_code=201)
def upload_csv(
    dataset_name: str,
    file: UploadFile,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Upload a CSV file and merge parsed records into a DRAFT dataset.

    Preferred columns: ``Serial No``, ``Question``, ``Expected Output``, ``Risk``.

    Legacy conventions remain supported:
        - ``input_*``  → inputs  (prefix stripped)
        - ``expect_*`` → expectations  (prefix stripped)
        - ``tag_*``    → tags  (prefix stripped)
        - shorthand RAG columns when no canonical/prefixed headers are present
    """
    if file.content_type not in {
        "text/csv",
        "application/csv",
        "application/octet-stream",
    }:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type: {file.content_type}. Expected text/csv.",
        )
    try:
        limit = settings.max_request_body_bytes
        content = file.file.read(limit + 1)
        if len(content) > limit:
            raise HTTPException(status_code=413, detail="uploaded file exceeds the configured size limit")
        records = parse_csv(content)
        from evalhub.datasets.models import DatasetRecord

        typed_records = [DatasetRecord(**r) for r in records]
        count = svc.merge_records(
            dataset_name,
            require_caller_tenant(http_request),
            typed_records,
            actor=_event_actor(http_request),
        )
        return {
            "merged": count,
            "dataset_name": dataset_name,
            "source": file.filename,
        }
    except Exception as e:
        _handle_error(e)


@router.get("/{dataset_name}/records")
def get_records(
    dataset_name: str,
    http_request: Request,
    limit: int | None = Query(None, ge=1, le=500),
    offset: int = Query(0, ge=0),
    cursor: str | None = Query(None),
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> list[dict[str, Any]] | dict[str, Any]:
    """Get current records from a dataset.

    Additive server paging: without ``limit``/``cursor`` the response stays the
    legacy bare list of every record; with them it is the ``{items, total,
    limit, offset, next_cursor}`` envelope. Paged reads of an unknown dataset
    are an honest 404, never an empty page.
    """
    window = _page_window(limit, offset, cursor)
    tenant_id = require_caller_tenant(http_request)
    try:
        if window is None:
            return svc.get_records(dataset_name, tenant_id)
        page_limit, page_offset = window
        items, total = svc.get_records_page(dataset_name, tenant_id, limit=page_limit, offset=page_offset)
        return _paged_envelope(items, total, page_limit, page_offset)
    except Exception as e:
        _handle_error(e)


@router.delete("/{dataset_name}/records")
def delete_records(
    dataset_name: str,
    request: DeleteRecordsRequest,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Delete specific records from a DRAFT dataset."""
    try:
        deleted = svc.delete_records(dataset_name, require_caller_tenant(http_request), request.record_ids)
        return {"deleted": deleted, "dataset_name": dataset_name}
    except Exception as e:
        _handle_error(e)


@router.post("/{dataset_name}/expected-tools")
def write_expected_tools(
    dataset_name: str,
    request: WriteExpectedToolsRequest,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> WriteExpectedToolsResult:
    """Write expected tools onto the dataset rows the operator chose.

    Distinct from run scoping on purpose. Selecting tools to scope a run says
    "score only these"; this says "these rows should call these", and it only
    ever touches the record ids named in the request.
    """
    # Tenant authorization happens in the router dependency, which refuses a
    # cross-tenant request before this handler is reached.
    if settings.platform_auth_required:
        request.created_by = actor_from_request(http_request)
    try:
        return svc.annotate_expected_tools(dataset_name, request, require_caller_tenant(http_request))
    except Exception as e:
        _handle_error(e)


# ------------------------------------------------------------------
# Promote captured evidence
# ------------------------------------------------------------------

#: Key lists the promotion builder probes on a run item's payload dicts. The
#: question and expected keys are IMPORTED from the dataset bridge rather than
#: re-typed, so the builder can never drift from what a run would read; the
#: expected list adds the engine's ``response`` persistence fallback, and the
#: answer keys cover the shapes the engine persists for actual output.
PROMOTE_QUESTION_KEYS = _QUERY_KEYS
PROMOTE_ANSWER_KEYS = ("response", "answer", "output", "actual_output", "text")
PROMOTE_EXPECTED_KEYS = (*_EXPECTED_KEYS, "response")

#: Tag keys copied from the run item's metadata onto the promoted record — the
#: dataset tag vocabulary, not a type filter: run metadata originates with the
#: evaluated workload and may carry customer identifiers.
PROMOTE_TAG_ALLOWLIST = _METADATA_TAG_KEYS | _PRESENTED_TAG_KEYS


def _first_text(payload: dict[str, Any] | None, keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = (payload or {}).get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def promoted_record(
    item: RunItemDetail, expected_source: str, expected_text: str | None = None
) -> DatasetRecord:
    """Build the dataset record a run item promotes into.

    Provenance keys live in ``inputs`` on purpose: they round-trip losslessly
    through the metadata presentation mapping, they make the stable record id
    distinct per source item (so re-promoting the same item upserts instead of
    colliding with an identical question from a different item), and the
    dataset bridge never reads them, so they cannot reach a prompt.
    """
    question = _first_text(item.input, PROMOTE_QUESTION_KEYS)
    if question is None:
        raise DatasetValidationError("Run item has no question text to promote")
    if expected_source == "reviewer":
        # A human who judged this case wrong wrote what the answer should have
        # been. It is installed as ground truth for later runs to be graded
        # against — the same role the captured text plays — and never as a note
        # handed to a judge. The truncation check below does not apply: this
        # text was typed here, not read back out of persisted evidence.
        expected = (expected_text or "").strip()
        if not expected:
            raise DatasetValidationError("A reviewer's expected answer cannot be empty")
    elif expected_source == "output":
        expected = _first_text(item.output, PROMOTE_ANSWER_KEYS)
        if expected is None:
            raise DatasetValidationError("Run item has no captured output text to promote")
    else:
        expected = _first_text(item.expected, PROMOTE_EXPECTED_KEYS)
        if expected is None:
            raise DatasetValidationError("Run item has no original expectation to promote")

    # Truncation is refused, not warned: unlike a redaction *policy* flag or a
    # per-item capture state, a truncated string is a proven mutilation of the
    # exact text being installed as ground truth — no future run can match it.
    limit = 0 if expected_source == "reviewer" else item.evidence_policy.max_persisted_string_size
    # ``>`` not ``>=``: the persistence layer keeps a string whose length equals
    # the limit unchanged, and a string it did cut carries the marker.
    if expected.endswith(TRUNCATION_MARKER) or (limit and len(expected) > limit):
        raise DatasetValidationError(
            "Captured text was truncated at persistence; it cannot serve as an expectation"
        )

    inputs: dict[str, Any] = {
        "question": question,
        "source_run_id": item.run_id,
        "source_example_id": item.example_id,
    }
    if item.execution.trace_id:
        inputs["source_trace_id"] = item.execution.trace_id
    if item.retrieval_snippets:
        # The answer was produced WITH this context; a promoted record that
        # drops it would grade future runs on a different task.
        inputs["context"] = list(item.retrieval_snippets)

    expectations: dict[str, Any] = {"expected_output": expected}
    if item.expected_tools:
        expectations = expectations_with_expected_tools(expectations, item.expected_tools)

    tags = {
        k: v
        for k, v in (item.metadata or {}).items()
        if k in PROMOTE_TAG_ALLOWLIST and isinstance(v, str)
    }
    # The captured text may have been redacted or only partially captured;
    # once promoted it reads as ground truth, so the caveat has to travel
    # with the record. Redaction is three-state on purpose: None means the
    # policy is UNKNOWN, which must never read as "not redacted".
    tags["source_capture_state"] = item.capture_state
    tags["source_redacted"] = {True: "true", False: "false", None: "unknown"}[
        item.evidence_policy.redaction_enabled
    ]
    tags["source_retention_policy"] = item.evidence_policy.retention_policy
    # Who wrote the expectation. A reviewer-authored answer is a different kind
    # of evidence from a captured one, and a record that cannot say which is a
    # record nobody can audit.
    tags["expected_authored_by"] = "reviewer" if expected_source == "reviewer" else "capture"
    return DatasetRecord(inputs=inputs, expectations=expectations, tags=tags)


@router.post("/{dataset_name}/promotions")
async def promote_run_item(
    dataset_name: str,
    request: PromoteRunItemRequest,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> PromoteRunItemResult:
    """Promote one captured run item into a dataset record.

    The dataset's tenant is authorized by the router dependency, and that SAME
    tenant scopes the run lookup: a dataset is tenant-local, so a foreign run
    is never promotable into it. One value, so the two sides of the copy
    cannot be authorized against different tenants.
    """
    if settings.platform_auth_required:
        request.created_by = actor_from_request(http_request)
    # Re-authorize the value this handler acts on. The router dependency
    # authorized its own read; between the two a dataset could have been
    # deleted and recreated under another tenant, and it is THIS tenant that
    # scopes the run lookup below.
    tenant_id = await run_in_threadpool(svc.get_dataset_tenant, dataset_name, caller_tenant(http_request))
    authorize_dataset_access(http_request, tenant_id)
    item = await store.get_run_item(
        request.run_id, request.example_id, tenant_id=tenant_id
    )
    if item is None:
        raise HTTPException(
            status_code=404,
            detail=f"Example {request.example_id} not found in run {request.run_id}",
        )
    try:
        record = promoted_record(item, request.expected_source, request.expected_text)
        return await run_in_threadpool(
            functools.partial(
                svc.promote_record,
                dataset_name,
                record,
                tenant_id,
                create_version_if_immutable=request.create_version_if_immutable,
                created_by=request.created_by,
            )
        )
    except Exception as e:
        _handle_error(e)


# ------------------------------------------------------------------
# Versioning
# ------------------------------------------------------------------


@router.post("/{dataset_name}/versions", status_code=201)
def create_version(
    dataset_name: str,
    request: CreateVersionRequest,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Create a new dataset version from an existing one."""
    # The router authorized the path name, but this endpoint never reads it:
    # ``create_new_version`` branches from ``request.source_dataset_name``.
    # Authorizing only the path would let a caller name their own dataset there
    # and a victim's in the body — a confused deputy.
    _authorize_named_dataset(http_request, svc, request.source_dataset_name)
    # The destination name is caller-supplied too. Left unauthorized it is a
    # name oracle: an existing foreign name comes back 400 with the name
    # echoed, a free one 201 — and the caller can squat the next version name
    # in another tenant's lineage.
    if request.new_dataset_name:
        _authorize_named_dataset(http_request, svc, request.new_dataset_name)
    if settings.platform_auth_required:
        request.created_by = actor_from_request(http_request)
    try:
        info = svc.create_new_version(request, require_caller_tenant(http_request))
        return info.model_dump()
    except Exception as e:
        _handle_error(e)


@router.post("/{dataset_name}/restore", status_code=201)
def restore_dataset(
    dataset_name: str,
    request: RestoreDatasetRequest,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Copy a RETIRED dataset and all records into the next DRAFT version."""
    if settings.platform_auth_required:
        request.created_by = actor_from_request(http_request)
    try:
        info = svc.restore_as_draft(dataset_name, request.created_by, require_caller_tenant(http_request))
        return info.model_dump()
    except Exception as e:
        _handle_error(e)


@router.get("/{dataset_name}/history")
def get_history(
    dataset_name: str,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> list[dict[str, Any]]:
    """Get version history for a dataset."""
    try:
        return svc.get_version_history(dataset_name, require_caller_tenant(http_request))
    except Exception as e:
        # Table may not exist yet (no records merged) — return empty
        if "TABLE_OR_VIEW_NOT_FOUND" in str(e):
            return []
        _handle_error(e)


# ------------------------------------------------------------------
# Lifecycle transitions
# ------------------------------------------------------------------


@router.post("/{dataset_name}/validate")
def validate_dataset(
    dataset_name: str,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Run quality gate checks on a DRAFT dataset."""
    try:
        result = svc.validate_dataset(
            dataset_name, require_caller_tenant(http_request), actor=_event_actor(http_request)
        )
        return {
            "dqs": result.dqs,
            "passed": result.passed,
            "target_status": result.target_status.value,
            "blocker_failures": result.blocker_failures,
            "checks": [
                {
                    "name": c.name,
                    "passed": c.passed,
                    "score": c.score,
                    "message": c.message,
                    "is_blocker": c.is_blocker,
                }
                for c in result.checks
            ],
        }
    except Exception as e:
        _handle_error(e)


@router.post("/{dataset_name}/approve")
def approve_dataset(
    dataset_name: str,
    request: ApproveRequest,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Approve a VALIDATED dataset (human sign-off)."""
    if settings.platform_auth_required:
        request.approved_by = actor_from_request(http_request)
    try:
        info = svc.approve_dataset(dataset_name, request.approved_by, require_caller_tenant(http_request))
        return info.model_dump()
    except Exception as e:
        _handle_error(e)


@router.post("/{dataset_name}/reject")
def reject_dataset(
    dataset_name: str,
    request: DatasetReviewRequest,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Persist a human rejection instead of keeping browser-only state."""
    if settings.platform_auth_required:
        request.decided_by = actor_from_request(http_request)
    try:
        info = svc.reject_dataset(dataset_name, request.decided_by, require_caller_tenant(http_request), request.note)
        return info.model_dump()
    except Exception as e:
        _handle_error(e)


@router.post("/{dataset_name}/reopen")
def reopen_dataset(
    dataset_name: str,
    request: DatasetReviewRequest,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Return a rejected dataset to an editable draft."""
    if settings.platform_auth_required:
        request.decided_by = actor_from_request(http_request)
    try:
        info = svc.reopen_dataset(dataset_name, request.decided_by, require_caller_tenant(http_request), request.note)
        return info.model_dump()
    except Exception as e:
        _handle_error(e)


@router.post("/{dataset_name}/publish")
def publish_dataset(
    dataset_name: str,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Publish an APPROVED dataset (makes it immutable)."""
    try:
        info = svc.publish_dataset(
            dataset_name, require_caller_tenant(http_request), actor=_event_actor(http_request)
        )
        return info.model_dump()
    except Exception as e:
        _handle_error(e)


@router.post("/{dataset_name}/deprecate")
def deprecate_dataset(
    dataset_name: str,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Deprecate a PUBLISHED dataset."""
    try:
        info = svc.deprecate_dataset(
            dataset_name, require_caller_tenant(http_request), actor=_event_actor(http_request)
        )
        return info.model_dump()
    except Exception as e:
        _handle_error(e)


@router.post("/{dataset_name}/retire")
def retire_dataset(
    dataset_name: str,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> dict[str, Any]:
    """Retire a DEPRECATED dataset."""
    try:
        info = svc.retire_dataset(
            dataset_name, require_caller_tenant(http_request), actor=_event_actor(http_request)
        )
        return info.model_dump()
    except Exception as e:
        _handle_error(e)


# ------------------------------------------------------------------
# Delete
# ------------------------------------------------------------------


@router.delete("/{dataset_name}", status_code=204)
def delete_dataset(
    dataset_name: str,
    http_request: Request,
    svc: DatasetRegistryService = Depends(get_registry_service),
) -> None:
    """Delete a dataset (records + registry entry)."""
    try:
        svc.delete_dataset(dataset_name, require_caller_tenant(http_request))
    except Exception as e:
        _handle_error(e)
