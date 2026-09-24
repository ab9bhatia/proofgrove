"""LLM Catalog API — Compass inventory + custom LLM onboarding."""

from __future__ import annotations

import hashlib
import logging
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, uuid5

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from openai import OpenAI

from evalhub.api.dependencies import get_evaluation_store
from evalhub.db.store import EvaluationStore
from evalhub.evaluation.judge_models import filter_judge_model_ids, order_judge_models
from evalhub.evaluation.llm_catalog import (
    CustomLlmOnboardRequest,
    LlmCatalogEntry,
    compass_catalog_entries,
    custom_entry_from_target,
    merge_catalog,
)
from evalhub.evaluation.local_lab import configured_lab_models, local_lab_mode
from evalhub.evaluation.model_providers import provider_snapshot
from evalhub.platform.audit import AuditEvent
from evalhub.platform.authz import (
    actor_from_request,
    enforce_tenant,
    namespace_for_tenant,
    tenants_match,
)
from evalhub.platform.contracts import EvaluationProject, ProjectPurpose, TargetType, TargetVersion
from evalhub.platform.url_guard import AgentCatalogError, validate_outbound_url
from evalhub.settings import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/evaluation/llm-catalog", tags=["llm-catalog"])


def _request_tenant(request: Request) -> str:
    supplied = request.headers.get("x-evalai-tenant")
    if settings.pod_namespace and supplied and not tenants_match(supplied, settings.pod_namespace):
        raise HTTPException(status_code=403, detail="tenant header does not match Eval Hub namespace")
    tenant_id = settings.pod_namespace or (namespace_for_tenant(supplied) if supplied else "")
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant context is required")
    enforce_tenant(request, tenant_id)
    return tenant_id


def _catalog_project_id(tenant_id: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"evalai:eval-hub:llm-catalog:{tenant_id}"))


async def _ensure_catalog_project(store: EvaluationStore, tenant_id: str) -> EvaluationProject:
    project_id = _catalog_project_id(tenant_id)
    existing = await store.get_project(project_id, tenant_id)
    if existing:
        if existing.purpose != ProjectPurpose.CATALOG_REGISTRY:
            classified = await store.set_project_purpose(
                project_id, tenant_id, ProjectPurpose.CATALOG_REGISTRY
            )
            return classified or existing
        return existing
    project = EvaluationProject(
        project_id=project_id,
        tenant_id=tenant_id,
        name="LLM Catalog",
        description="Compass and custom LLMs available for evaluation.",
        system_type="llm",
        owner="eval-hub",
        purpose=ProjectPurpose.CATALOG_REGISTRY,
        tags={"catalog": "llms", "registry": "evaluation-targets"},
        created_by="system",
    )
    try:
        return await store.save_project(project)
    except ValueError:
        # A concurrent onboarding request may have created the deterministic
        # project after our initial read.
        concurrent = await store.get_project(project_id, tenant_id)
        if concurrent:
            return concurrent
        raise


async def _list_compass_models() -> tuple[list[str], bool]:
    """Return chat model ids from the AI Gateway, plus whether this is a fallback."""
    lab_mode = local_lab_mode(settings)
    if lab_mode == "offline":
        # Offline fixtures have no connected provider. A judge default is not
        # evidence that a target model exists or can accept requests.
        return [], True
    declared = configured_lab_models(settings)
    if lab_mode == "local":
        # Launcher checks installed model IDs; invocation is verified by a run.
        return declared, True
    configured = settings.azure_openai_deployment if settings.judge_provider == "azure" else settings.judge_model
    fallback = declared if lab_mode == "live" else ([configured] if configured else [])
    if settings.judge_provider == "azure" or not settings.openai_api_key:
        return fallback, True

    client = OpenAI(
        api_key=settings.openai_api_key.get_secret_value(),
        base_url=settings.openai_base_url,
    )
    try:
        listing = await run_in_threadpool(client.models.list)
        models = order_judge_models(
            filter_judge_model_ids(model.id for model in listing.data if model.id),
            configured,
        )
        return list(dict.fromkeys([*models, *declared])), False
    except Exception as exc:  # noqa: BLE001
        # Type only: an SDK error can echo the gateway URL and a key fragment.
        logger.warning("Unable to list Compass/AI Gateway models", extra={"error_type": type(exc).__name__})
        return fallback, True


@router.get("")
async def list_llm_catalog(
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict]:
    """List Compass inventory and tenant-onboarded custom LLMs with source labels."""

    tenant_id = _request_tenant(request)
    custom_targets = await store.list_llm_targets(tenant_id)
    custom = [custom_entry_from_target(target) for target in custom_targets]
    if local_lab_mode(settings) is not None:
        snapshot = await provider_snapshot(settings)
        entries = [LlmCatalogEntry(**model, description=provider.get("message"))
                   for provider in snapshot["providers"] for model in provider["models"]]
        # A model name is not a global identity: OpenAI, Ollama and custom
        # endpoints may all serve the same name. Keep each endpoint selectable.
        # Keep provider presentation order, including the curated OpenAI list.
        by_route = {(entry.model_id, (entry.endpoint or "").rstrip("/")): entry for entry in entries}
        for entry in custom:
            by_route.setdefault((entry.model_id, (entry.endpoint or "").rstrip("/")), entry)
        return [entry.model_dump(mode="json") for entry in by_route.values()]
    compass_ids, _fallback = await _list_compass_models()
    compass = compass_catalog_entries(
        compass_ids,
        endpoint=None if settings.judge_provider == "azure" else settings.openai_base_url,
    )
    return [entry.model_dump(mode="json") for entry in merge_catalog(compass, custom)]


@router.post("", status_code=201)
async def onboard_custom_llm(
    body: CustomLlmOnboardRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict:
    """Persist a custom OpenAI-compatible LLM in the tenant LLM Catalog."""

    tenant_id = _request_tenant(request)
    # Validate endpoint shape via TargetVersion rules before persisting.
    try:
        TargetVersion(
            target_id="validate",
            project_id="validate",
            tenant_id=tenant_id,
            name=body.name or body.model_id,
            version="1",
            endpoint=body.endpoint.strip(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        endpoint = await validate_outbound_url(
            body.endpoint.strip(), tenant_namespace=settings.pod_namespace or tenant_id
        )
    except AgentCatalogError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    existing = await store.list_llm_targets(tenant_id)
    for target in existing:
        config = target.configuration or {}
        if config.get("model_id") == body.model_id and target.endpoint == endpoint:
            return custom_entry_from_target(target).model_dump(mode="json")

    project = await _ensure_catalog_project(store, tenant_id)
    actor = actor_from_request(request)
    digest = hashlib.sha256(f"{body.model_id}|{endpoint}".encode()).hexdigest()[:24]
    target = TargetVersion(
        target_id=f"llm-{digest}",
        project_id=project.project_id,
        tenant_id=tenant_id,
        name=(body.name or body.model_id)[:256],
        version="1",
        endpoint=endpoint,
        target_type=TargetType.ENDPOINT,
        environment="cluster" if ".svc.cluster.local" in endpoint else "external",
        model_version=body.model_id,
        configuration={
            "catalog_source": "custom_llm",
            "model_id": body.model_id,
            "description": body.description,
            "onboarded_at": datetime.now(UTC).isoformat(),
        },
        created_by=actor,
    )
    saved = await store.save_target_version(target)
    await store.record_audit(
        AuditEvent(
            tenant_id=tenant_id,
            actor=actor,
            action="llm_catalog.onboarded",
            resource_type="target_version",
            resource_id=saved.target_version_id,
            details={"model_id": body.model_id, "endpoint": endpoint},
        )
    )
    return custom_entry_from_target(saved).model_dump(mode="json")
