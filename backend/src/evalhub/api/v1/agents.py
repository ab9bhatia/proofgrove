"""FastAPI routes for Proofgrove agent discovery (evaluation targets).

Lists the kagent agents in this service's tenant namespace so a user can pick one
to evaluate. Mirrors evalai-agent-ui's catalog view (kagent REST + POD_NAMESPACE
filter). The returned ``id`` ("<namespace>/<name>") is used as an experiment's
``target_endpoint`` for ``response_source="agent"`` runs.
"""

import hashlib
import logging
from datetime import UTC, datetime
from urllib.parse import quote
from uuid import NAMESPACE_URL, uuid5

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from evalhub.api.dependencies import get_evaluation_store
from evalhub.db.store import EvaluationStore
from evalhub.evaluation.local_lab import local_lab_mode
from evalhub.evaluation.target.catalog import AgentCatalogError, test_agent_connectivity
from evalhub.evaluation.target.discovery import (
    AgentSummary,
    ToolServerSummary,
    list_tenant_agents,
    list_tenant_tool_servers,
)
from evalhub.evaluation.target.external import credential_headers, external_summary, invocation_endpoint
from evalhub.platform.audit import AuditEvent
from evalhub.platform.authz import (
    PERMISSION_TARGET_MANAGE,
    actor_from_request,
    check_permission,
    enforce_tenant,
    namespace_for_tenant,
    tenants_match,
)
from evalhub.platform.contracts import EvaluationProject, ProjectPurpose, TargetType, TargetVersion
from evalhub.settings import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents", tags=["agents"])


class AgentOnboardRequest(BaseModel):
    """Agent-system endpoint to test and persist after successful validation."""

    endpoint: str = Field(min_length=1, max_length=1024)
    credential_ref: str | None = Field(default=None, max_length=128)


def _request_tenant(request: Request) -> str:
    supplied = request.headers.get("x-evalai-tenant")
    # A tenant-local Eval Hub may only read or write catalog data for the
    # namespace it is deployed into. The edge header cannot broaden discovery.
    # Gateway injects the bare slug (``evalai``); POD_NAMESPACE is
    # ``tenant-evalai`` — treat both forms as the same tenant.
    if settings.pod_namespace and supplied and not tenants_match(supplied, settings.pod_namespace):
        raise HTTPException(status_code=403, detail="tenant header does not match Eval Hub namespace")
    tenant_id = settings.pod_namespace or (namespace_for_tenant(supplied) if supplied else "")
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant context is required")
    enforce_tenant(request, tenant_id)
    return tenant_id


def _catalog_project_id(tenant_id: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"evalai:eval-hub:agent-catalog:{tenant_id}"))


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
        name="Agent Catalog",
        description="A2A agents onboarded as Eval Hub evaluation targets.",
        system_type="agent",
        owner="eval-hub",
        purpose=ProjectPurpose.CATALOG_REGISTRY,
        tags={"catalog": "agents", "registry": "evaluation-targets"},
        created_by="eval-hub",
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


# Discovered kagent agents run in-cluster; the catalog sync registers their
# immutable TargetVersion with this environment, so a TargetProjectBinding for a
# discovered agent is keyed on the same environment.
_PLATFORM_TARGET_ENVIRONMENT = "cluster"


def _platform_target_id(agent: AgentSummary) -> str:
    return f"kagent-{hashlib.sha256(agent.id.encode()).hexdigest()[:24]}"


def _platform_target_version_id(tenant_id: str, agent: AgentSummary) -> str:
    return str(
        uuid5(
            NAMESPACE_URL,
            f"evalai:eval-hub:kagent-target:{tenant_id}:{agent.id}:{agent.revision}",
        )
    )


def _platform_agent_endpoint(agent: AgentSummary) -> str:
    base = settings.kagent_url.rstrip("/")
    namespace = quote(agent.namespace, safe="")
    name = quote(agent.name, safe="")
    return f"{base}/api/a2a/{namespace}/{name}/"


async def _sync_platform_agent_catalog(store: EvaluationStore, tenant_id: str) -> list[TargetVersion]:
    """Upsert current ready tenant agents and return the active catalog view.

    Target versions remain immutable for lineage. Older or no-longer-ready
    platform snapshots stay in storage for existing run references, but are
    omitted from the refreshed catalog. Manually onboarded A2A targets remain.
    """

    namespace = settings.pod_namespace or tenant_id
    existing = await store.list_agent_targets(tenant_id)
    if local_lab_mode(settings) is not None:
        # The classroom launcher runs without Kubernetes. Keep manually
        # onboarded agents usable; a missing Kagent controller is expected.
        return [target for target in existing if target.configuration.get("catalog_source") == "a2a_agent_card"]
    try:
        discovered = await list_tenant_agents(
            kagent_url=settings.kagent_url, namespace=namespace, ready_only=True,
            excluded_tools=settings.excluded_tool_names,
        )
    except httpx.HTTPError:
        if not any(target.configuration.get("catalog_source") == "a2a_agent_card" for target in existing):
            raise
        discovered = []
    existing_ids = {target.target_version_id for target in existing}

    if discovered:
        project = await _ensure_catalog_project(store, tenant_id)
        for agent in discovered:
            version_id = _platform_target_version_id(tenant_id, agent)
            if version_id in existing_ids:
                continue
            endpoint = _platform_agent_endpoint(agent)
            target = TargetVersion(
                target_version_id=version_id,
                target_id=_platform_target_id(agent),
                project_id=project.project_id,
                tenant_id=tenant_id,
                name=agent.display_name or agent.name,
                version=f"kagent-{agent.revision}",
                endpoint=endpoint,
                target_type=TargetType.AGENT,
                environment=_PLATFORM_TARGET_ENVIRONMENT,
                model_version=agent.model or None,
                tool_versions={tool: "discovered" for tool in agent.tools},
                configuration={
                    "catalog_source": "kagent_discovery",
                    "connectivity": "platform_ready",
                    "agent_ref": agent.id,
                    "namespace": agent.namespace,
                    "agent_type": agent.agent_type,
                    "accepted": agent.accepted,
                    "ready": agent.ready,
                    "revision": agent.revision,
                    "grounding_url": agent.grounding_url,
                    "agent_card": {
                        "name": agent.display_name or agent.name,
                        "description": agent.description,
                        "url": endpoint,
                        "version": f"kagent-{agent.revision}",
                        "protocolVersion": "kagent-a2a",
                        "capabilities": {"streaming": True},
                        "skills": [{"id": tool, "name": tool} for tool in agent.tools],
                    },
                },
                created_by="eval-hub-agent-sync",
            )
            try:
                saved = await store.save_target_version(target)
            except ValueError:
                # A concurrent refresh may have inserted the deterministic row.
                saved = await store.get_target_version(version_id, tenant_id)
                if saved is None:
                    raise
            existing.append(saved)
            existing_ids.add(version_id)
            await store.record_audit(
                AuditEvent(
                    tenant_id=tenant_id,
                    actor="eval-hub-agent-sync",
                    action="agent_catalog.synced",
                    resource_type="target_version",
                    resource_id=saved.target_version_id,
                    details={"agent_ref": agent.id, "revision": agent.revision},
                )
            )

    active_platform_ids = {_platform_target_version_id(tenant_id, agent) for agent in discovered}
    return [target for target in existing if target.configuration.get("catalog_source") != "kagent_discovery" or target.target_version_id in active_platform_ids]


@router.get("")
async def list_agents(
    request: Request,
    ready_only: bool = Query(False),
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[AgentSummary]:
    """List Proofgrove agents in this tenant available as evaluation targets.

    Each agent carries its bound tenant *system* Project (``system_project_id``)
    when a ``TargetProjectBinding`` exists for its logical target, so the evaluate
    flow can infer a system Project from the selection. It stays ``None`` when the
    target is unbound — the caller must choose a Project explicitly.
    """
    tenant_id = _request_tenant(request)
    external_targets = [target for target in await store.list_agent_targets(tenant_id)
                        if target.configuration.get("catalog_source") == "a2a_agent_card"]
    if local_lab_mode(settings) is not None:
        agents = []
    else:
        try:
            agents = await list_tenant_agents(
                kagent_url=settings.kagent_url,
                namespace=settings.pod_namespace,
                ready_only=ready_only,
                excluded_tools=settings.excluded_tool_names,
            )
        except httpx.HTTPError as exc:
            logger.warning("eval-hub: agent discovery failed", extra={"error_type": type(exc).__name__})
            if not external_targets:
                raise HTTPException(status_code=502, detail="kagent agent listing failed") from exc
            agents = []

    target_keys = [(_platform_target_id(agent), _PLATFORM_TARGET_ENVIRONMENT) for agent in agents]
    target_keys.extend((target.target_id, target.environment) for target in external_targets)
    projects = await store.target_system_projects(tenant_id, target_keys)
    agents.extend(external_summary(target) for target in external_targets)
    for agent, key in zip(agents, target_keys, strict=True):
        if key in projects:
            agent.system_project_id = projects[key]
    return agents


@router.get("/mcp-servers")
async def list_mcp_servers(request: Request) -> list[ToolServerSummary]:
    """List the tenant's MCP tool servers (grounding sources for generation)."""
    _request_tenant(request)
    if local_lab_mode(settings) is not None:
        return []
    try:
        return await list_tenant_tool_servers(
            kagent_url=settings.kagent_url,
            namespace=settings.pod_namespace,
            excluded_tools=settings.excluded_tool_names,
        )
    except httpx.HTTPError as exc:
        logger.warning("eval-hub: tool-server discovery failed", extra={"error_type": type(exc).__name__})
        raise HTTPException(status_code=502, detail="kagent tool listing failed") from exc


@router.get("/catalog")
async def list_agent_catalog(
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> list[dict]:
    """List saved targets; only target managers refresh platform discovery."""

    tenant_id = _request_tenant(request)
    if local_lab_mode(settings) is not None:
        targets = await store.list_agent_targets(tenant_id)
        return [target.model_dump(mode="json") for target in targets if target.configuration.get("catalog_source") == "a2a_agent_card"]
    if not await check_permission(request, PERMISSION_TARGET_MANAGE):
        targets = await store.list_agent_targets(tenant_id)
        return [target.model_dump(mode="json") for target in targets]
    try:
        targets = await _sync_platform_agent_catalog(store, tenant_id)
    except httpx.HTTPError as exc:
        logger.warning("eval-hub: agent catalog sync failed", extra={"error_type": type(exc).__name__})
        raise HTTPException(status_code=502, detail="kagent agent catalog sync failed") from exc
    return [target.model_dump(mode="json") for target in targets]


@router.post("/catalog", status_code=201)
async def test_and_onboard_agent(
    body: AgentOnboardRequest,
    request: Request,
    store: EvaluationStore = Depends(get_evaluation_store),
) -> dict:
    """Validate an A2A agent card and persist the target only on success."""

    tenant_id = _request_tenant(request)
    try:
        endpoint, card_url, card = await test_agent_connectivity(
            body.endpoint,
            tenant_namespace=settings.pod_namespace or tenant_id,
            **({"credential_headers": credential_headers(settings, body.credential_ref, body.endpoint)} if body.credential_ref else {}),
        )
    except AgentCatalogError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    version = card.get("version")
    if not isinstance(version, str) or not version.strip():
        version = "unversioned"
    else:
        version = version.strip()[:128]

    # Test is intentionally idempotent: a successful repeat returns the
    # already-onboarded immutable target rather than creating duplicates.
    existing = await store.list_agent_targets(tenant_id)
    for target in existing:
        if target.endpoint == endpoint and target.version == version and target.configuration.get("credential_ref") == body.credential_ref:
            return target.model_dump(mode="json")

    project = await _ensure_catalog_project(store, tenant_id)
    actor = actor_from_request(request)
    target = TargetVersion(
        target_id=f"a2a-{hashlib.sha256(endpoint.encode()).hexdigest()[:24]}",
        project_id=project.project_id,
        tenant_id=tenant_id,
        name=str(card["name"])[:256],
        version=version,
        endpoint=endpoint,
        target_type=TargetType.AGENT,
        environment="cluster" if ".svc.cluster.local" in endpoint else "external",
        configuration={
            "catalog_source": "a2a_agent_card",
            "connectivity": "verified",
            "tested_at": datetime.now(UTC).isoformat(),
            "agent_card_url": card_url,
            "agent_card": card,
            "credential_ref": body.credential_ref,
        },
        created_by=actor,
    )
    try:
        invocation_endpoint(target, settings.pod_namespace or tenant_id)
    except AgentCatalogError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    saved = await store.save_target_version(target)
    await store.record_audit(
        AuditEvent(
            tenant_id=tenant_id,
            actor=actor,
            action="agent_catalog.onboarded",
            resource_type="target_version",
            resource_id=saved.target_version_id,
            details={"target_id": saved.target_id, "endpoint": saved.endpoint},
        )
    )
    return saved.model_dump(mode="json")
