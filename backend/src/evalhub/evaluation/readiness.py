"""Backend-owned evidence readiness and post-run capture classification."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

import httpx

from evalhub.errors import TenantVisibleError
from evalhub.evaluation.dataset_bridge import (
    _EXPECTED_KEYS,
    _QUERY_KEYS,
    _first,
    missing_provided_response,
)
from evalhub.evaluation.enums import (
    Adapter,
    EvaluationScope,
    EvidenceCaptureStatus,
    EvidenceCategoryStatus,
    EvidenceReadiness,
    MetricRequirement,
    MetricRequirementSource,
    PreRunApplicability,
    ProvenanceStatus,
    Scenario,
    ScoringType,
)
from evalhub.evaluation.evidence_requirements import (
    canonical_evidence_categories,
    recognized_capture_categories,
    resolve_effective_evidence_requirements,
    resolve_metric_evidence_requirements,
)
from evalhub.evaluation.model_providers import target_provider_problem
from evalhub.evaluation.models import (
    EvaluationRow,
    EvidenceCategorySummary,
    EvidenceReadinessResult,
    MetricDefinition,
    MetricPreRunApplicability,
    ReadinessDetail,
)
from evalhub.evaluation.scenario_router import select_metrics
from evalhub.evaluation.target.catalog import AgentCatalogError
from evalhub.evaluation.target.discovery import list_tenant_agents
from evalhub.evaluation.target.external import EXTERNAL_PREFIX, external_summary, resolve_external_target
from evalhub.evaluation.target.llm_runner import resolve_llm_base_url

# The usage reader is strict by design: a total counts only when the target
# stated one or stated both halves, and non-positive totals count as nothing
# reported. Identical executable policy to the hydrator's reader (AST-verified),
# so it is imported under the local name, not duplicated.
from evalhub.evaluation.trace_hydrator import _reported_usage_total as _reported_token_count
from evalhub.settings import Settings

_TOOL_CAPTURE_ATTESTATION_UNAVAILABLE = (
    "Tool-call capture attestation is not configured for this environment."
)


def tool_evidence_attestation_available(settings: Settings) -> bool:
    """True when a trusted completion source exists for tool-scope scoring.

    Either a session completion manifest, or the OTEL trace archive (telemetry
    as the scoring source of truth, matching Phoenix / Confident AI).
    """

    return (
        settings.tool_evidence_completion_manifest_available
        or settings.trace_archive_enabled
    )


class ReadinessBlockedError(RuntimeError, TenantVisibleError):
    """Raised when worker-side revalidation no longer permits invocation."""

    def __init__(self, readiness: EvidenceReadinessResult) -> None:
        self.readiness = readiness
        message = "; ".join(detail.message for detail in readiness.details)
        super().__init__(message or f"evidence readiness is {readiness.status.value}")


def scope_options(
    *,
    response_source: str,
    tool_completion_available: bool,
    agent_tools: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Report capture-path availability without overstating metric applicability."""

    tools_reason: str | None = None
    if response_source != "agent":
        tools_reason = (
            f"{response_source} sources cannot provide tool-interaction evidence in V1."
        )
    elif not tool_completion_available:
        tools_reason = _TOOL_CAPTURE_ATTESTATION_UNAVAILABLE
    tool_option: dict[str, Any] = {
        "scope": EvaluationScope.TOOL_INTERACTIONS.value,
        "available": tools_reason is None,
        **({"reason": tools_reason} if tools_reason else {}),
    }
    if tools_reason is None and agent_tools == []:
        tool_option["caveat"] = (
            "Capture is available, but this agent declares no tools; "
            "tool-specific checks are not applicable."
        )
    # Full execution reaches the same capture path as tool interactions. Its
    # additional categories become release-grade only when the archive closes
    # the trace and the invocation supplies its aggregate usage report.
    full_option: dict[str, Any] = {
        "scope": EvaluationScope.FULL_EXECUTION.value,
        "available": tools_reason is None,
        **({"reason": tools_reason} if tools_reason else {}),
    }
    # No caveat about what the depth cannot vouch for. The run report states it
    # per category, which is both more precise and the point at which it can be
    # acted on; on a depth option it was a paragraph read by nobody. The one
    # caveat kept is the zero-tool case, which narrows what the depth will
    # actually inspect rather than describing the confidence in what it finds.
    if tools_reason is None and agent_tools == []:
        full_option["caveat"] = (
            "This agent declares no tools, so tool-specific checks are not applicable."
        )
    return [
        {"scope": EvaluationScope.FINAL_RESPONSE.value, "available": True},
        tool_option,
        full_option,
    ]


def _metric_family(metric_id: str) -> str:
    return metric_id.split(".", 1)[0] if "." in metric_id else metric_id


def _is_tool_metric(metric: MetricDefinition) -> bool:
    # Only metrics whose *purpose* is tool evaluation are structurally N/A for a
    # zero-tool agent. A lifecycle metric (e.g. agent.task_adherence) that merely
    # references tool evidence stays applicable and is reported as *blocked* when
    # that evidence is missing — applicability and capture are separate dimensions.
    return metric.metric_id.startswith("agent.tool_")


def _dataset_has_reference(records: list[dict[str, Any]]) -> bool:
    # Single source of truth: the same expected-answer keys the dataset->row
    # bridge consumes. Truthy check (like the bridge's ``if v``) so empty
    # strings/containers/False are not counted as a reference.
    def _present(source: dict[str, Any]) -> bool:
        return any(bool(source.get(key)) for key in _EXPECTED_KEYS)

    for record in records:
        expectations = record.get("expectations") or {}
        if _present(expectations) or _present(record):
            return True
    return False


def classify_pre_run_applicability(
    metrics: list[MetricDefinition],
    *,
    response_source: str,
    scenario: Scenario,
    has_reference: bool,
    agent_tools: list[str] | None,
    agent_type: str | None,
) -> list[MetricPreRunApplicability]:
    """Decide per-metric applicability before the target runs.

    Applicability is derived from target *capability* and dataset shape only —
    never from runtime evidence. A metric whose capability exists but whose
    evidence merely might be missing stays ``potentially_applicable`` (readiness
    reports the capture gap separately); it is never downgraded to N/A here.
    """

    is_agent = response_source == "agent"
    has_retrieval = is_agent or scenario == Scenario.RAG
    results: list[MetricPreRunApplicability] = []
    for metric in metrics:
        family = _metric_family(metric.metric_id)
        applicability = PreRunApplicability.POTENTIALLY_APPLICABLE
        reason = "Applicability is finalized once runtime evidence is captured."
        if family == "agent":
            if not is_agent:
                applicability = PreRunApplicability.KNOWN_NOT_APPLICABLE
                reason = "The selected target is not an agent."
            elif _is_tool_metric(metric):
                # Only a Declarative agent that explicitly declares zero tools is
                # known N/A. BYO / unknown capability (agent_tools is None) stays
                # potentially applicable.
                if agent_type == "Declarative" and agent_tools is not None and not agent_tools:
                    applicability = PreRunApplicability.KNOWN_NOT_APPLICABLE
                    reason = "This agent declares no tools."
                else:
                    reason = "Confirmed once tool-interaction spans are captured."
            else:
                reason = "Agent lifecycle evidence is expected for an agent target."
        elif family == "rag":
            if not has_retrieval:
                applicability = PreRunApplicability.KNOWN_NOT_APPLICABLE
                reason = "No retrieval stage is present for this target."
            else:
                reason = "Retrieval evidence is expected for this target."
        # Ground-truth requirement applies to ANY metric still applicable after
        # family classification (e.g. rag.document_recall / llm.correctness need a
        # reference too) — not only the non-agent/non-rag families.
        if (
            applicability == PreRunApplicability.POTENTIALLY_APPLICABLE
            and metric.requires_ground_truth
            and not has_reference
        ):
            applicability = PreRunApplicability.KNOWN_NOT_APPLICABLE
            reason = "The dataset does not provide the required reference output."
        results.append(
            MetricPreRunApplicability(
                metric_id=metric.metric_id,
                applicability=applicability,
                reason=reason,
            )
        )
    return results


def _contract_pinned_block(
    applicability: list[MetricPreRunApplicability],
    resolved_metric_requirements: list[dict[str, Any]] | None,
) -> ReadinessDetail | None:
    """Block setup when a contract-REQUIRED metric is known-not-applicable.

    Only a metric the resolved contract pins as required (a quality-contract /
    manifest requirement) blocks: dropping it would silently violate the
    contract, so it is a setup error the user has to resolve. A metric that is
    required merely because the user explicitly selected it (or a legacy
    scenario default) must NOT block — it is reported not-applicable via
    ``metric_applicability`` and the run proceeds without it. A requirement row
    with no recorded source predates source tracking and is treated as
    contract-pinned for safety.
    """

    contract_sources = {None, "", MetricRequirementSource.QUALITY_CONTRACT.value}
    required_ids = {
        str(item.get("metric_id"))
        for item in (resolved_metric_requirements or [])
        if str(item.get("requirement")) == MetricRequirement.REQUIRED.value
        and item.get("source") in contract_sources
    }
    blocked = sorted(
        row.metric_id
        for row in applicability
        if row.applicability == PreRunApplicability.KNOWN_NOT_APPLICABLE
        and row.metric_id in required_ids
    )
    if not blocked:
        return None
    return ReadinessDetail(
        code="contract_metric_not_applicable",
        message=(
            "Contract-required metric(s) are not applicable to this target/dataset: "
            f"{', '.join(blocked)}. Remove them from the contract, or choose a "
            "compatible target and dataset."
        ),
    )


async def _model_route_blocker(
    *, settings: Settings, response_source: str, target_model: str | None,
    target_endpoint: str | None, judge_model: str | None,
    enable_llm_judge: bool, metrics: list[MetricDefinition],
) -> ReadinessDetail | None:
    """Check each tenant model catalogue once, before target or scorer work."""
    required: list[tuple[str, str, str]] = []
    if response_source == "llm" and target_model:
        base_url = resolve_llm_base_url(target_endpoint, settings)
        problem = await target_provider_problem(settings, base_url, target_model)
        if problem:
            return ReadinessDetail(code=problem[0], message=problem[1])
        required.append(("target", target_model, base_url))
    real_judge = enable_llm_judge and settings.judge_mode != "mock" and (
        settings.judge_mode == "llm" or bool(settings.openai_api_key)
    )
    if real_judge and settings.judge_provider != "azure":
        # Match the dispatcher: deterministic metrics never call a model;
        # trace adapters are deterministic only for live agent rows.
        for metric in metrics:
            if metric.scoring_type == ScoringType.OPERATIONAL or metric.default_adapter in (Adapter.DETERMINISTIC, Adapter.CUSTOM):
                continue
            if metric.default_adapter == Adapter.TRACE and response_source == "agent":
                continue
            if settings.judge_use_frameworks and metric.default_adapter == Adapter.RAGAS and metric.metric_id == "llm.similarity":
                required.append(("embedding", settings.judge_embedding_model, settings.openai_base_url))
            else:
                required.append(("judge", judge_model or settings.judge_model, settings.openai_base_url))
    catalogues: dict[str, set[str]] = {}
    for role, model, base_url in required:
        base_url = base_url.rstrip("/")
        if urlsplit(base_url).hostname not in {"tenant-ai-gateway", f"tenant-ai-gateway.{settings.pod_namespace}.svc.cluster.local"}:
            continue
        if not model:
            return ReadinessDetail(code=f"{role}_model_missing", message=f"Configure a {role} model for the selected checks.")
        if base_url not in catalogues:
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    response = await client.get(f"{base_url}/models")
                    response.raise_for_status()
                    catalogues[base_url] = {item["id"] for item in response.json()["data"]}
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                return ReadinessDetail(code="llm_catalog_unavailable", message="Cannot verify models on the tenant gateway. Retry when its model catalogue is available.")
        if model not in catalogues[base_url]:
            return ReadinessDetail(code=f"{role}_model_unavailable", message=f"The {role} model {model} is not configured on this tenant's gateway. Select an available model or register its tenant route.")
    return None


async def assess_evidence_readiness(
    *,
    response_source: str,
    evaluation_scope: EvaluationScope,
    requested_evaluation_scope: EvaluationScope | None = None,
    scope_promotion_reasons: list[dict[str, str]] | None = None,
    agent: str | None,
    target_model: str | None,
    target_endpoint: str | None,
    records: list[dict[str, Any]],
    active_metric_ids: list[str] | None,
    scenario: Scenario,
    settings: Settings,
    judge_model: str | None = None,
    enable_llm_judge: bool = True,
    resolved_metric_definitions: list[dict[str, Any]] | None = None,
    expected_provenance: dict[str, Any] | None = None,
    resolved_metric_evidence_requirements: dict[str, list[str]] | None = None,
    resolved_evidence_requirements: list[str] | None = None,
    resolved_metric_requirements: list[dict[str, Any]] | None = None,
    selected_tool_ids: list[str] | None = None,
) -> EvidenceReadinessResult:
    """Resolve capabilities and prerequisites without claiming future capture.

    ``selected_tool_ids`` names the tools a ``tool_interactions`` run is scoped
    to (the selected-tools evaluation level). It is validated against the
    resolved agent's declared tool inventory: unknown names block the run with
    a structured detail, never a silent drop. ``None`` means the whole tool
    layer.
    """

    metrics = select_metrics(
        scenario,
        has_ground_truth=True,
        metric_ids=active_metric_ids,
        metric_definitions=[MetricDefinition.model_validate(item) for item in resolved_metric_definitions] if resolved_metric_definitions else None,
    )
    # Real pre-run applicability. Non-agent branches resolve here with no agent
    # capability; the agent branch refines tool applicability once the agent is
    # resolved (see below), because tool declarations are only known then.
    applicability = classify_pre_run_applicability(
        metrics,
        response_source=response_source,
        scenario=scenario,
        has_reference=_dataset_has_reference(records),
        agent_tools=None,
        agent_type=None,
    )
    metric_evidence = resolved_metric_evidence_requirements if resolved_metric_evidence_requirements is not None else resolve_metric_evidence_requirements(metrics)
    requirements = canonical_evidence_categories(resolved_evidence_requirements) if resolved_evidence_requirements is not None else resolve_effective_evidence_requirements(evaluation_scope, metric_evidence)
    requires_tools = bool(set(requirements).intersection({"tool_calls", "tool_results"}))

    requested = _requested_provenance(
        response_source=response_source,
        agent=agent,
        target_model=target_model,
        target_endpoint=target_endpoint,
    )
    common = {
        "evaluation_scope": evaluation_scope,
        "requested_evaluation_scope": requested_evaluation_scope or evaluation_scope,
        "resolved_evaluation_scope": evaluation_scope,
        "scope_promotion_reasons": scope_promotion_reasons or [],
        "effective_evidence_requirements": requirements,
        "metric_evidence_requirements": metric_evidence,
        "metric_requirements": resolved_metric_requirements or [],
        "metric_applicability": applicability,
        "requested_provenance": requested,
        # Tool inventory is unknown until an agent target is resolved below.
        "agent_tools": None,
        "selected_tool_ids": selected_tool_ids,
    }

    unavailable_metrics = [metric for metric in metrics if not metric.available_in_run]
    if unavailable_metrics:
        return EvidenceReadinessResult(
            status=EvidenceReadiness.UNSUPPORTED,
            details=[
                ReadinessDetail(
                    code="metric_execution_unavailable",
                    message=(
                        f"{metric.metric_id} is a {metric.execution_mode}-lane metric and "
                        "cannot run in the inline evaluation workflow."
                    ),
                )
                for metric in unavailable_metrics
            ],
            **common,
        )

    if requires_tools and response_source != "agent":
        return EvidenceReadinessResult(
            status=EvidenceReadiness.UNSUPPORTED,
            details=[
                ReadinessDetail(
                    code="tool_evidence_unsupported",
                    evidence_category="tool_calls",
                    message=f"{response_source} sources cannot provide tool-interaction evidence in V1.",
                )
            ],
            **common,
        )
    if not records:
        return EvidenceReadinessResult(
            status=EvidenceReadiness.BLOCKED,
            details=[ReadinessDetail(code="dataset_empty", message="The dataset has no records.")],
            **common,
        )
    if any(not _record_query(record) for record in records):
        return EvidenceReadinessResult(
            status=EvidenceReadiness.BLOCKED,
            details=[
                ReadinessDetail(
                    code="dataset_input_missing",
                    evidence_category="input",
                    message="At least one dataset case has no query/input.",
                )
            ],
            **common,
        )

    # Contract-required metric that is structurally N/A blocks setup — placed
    # after the fundamental scope/source/dataset unsupported+blocked checks so
    # those primary reasons win. The agent branch re-checks after resolving tools.
    pinned = _contract_pinned_block(applicability, resolved_metric_requirements)
    if pinned is not None:
        return EvidenceReadinessResult(status=EvidenceReadiness.BLOCKED, details=[pinned], **common)

    inactive_metric_ids = {item.metric_id for item in applicability if item.applicability == PreRunApplicability.KNOWN_NOT_APPLICABLE}
    model_blocker = await _model_route_blocker(
        settings=settings, response_source=response_source, target_model=target_model,
        target_endpoint=target_endpoint, judge_model=judge_model,
        enable_llm_judge=enable_llm_judge, metrics=[metric for metric in metrics if metric.metric_id not in inactive_metric_ids],
    )
    if model_blocker:
        return EvidenceReadinessResult(status=EvidenceReadiness.BLOCKED, details=[model_blocker], **common)

    if response_source == "provided":
        if missing_provided_response(records):
            return EvidenceReadinessResult(
                status=EvidenceReadiness.BLOCKED,
                details=[
                    ReadinessDetail(
                        code="provided_output_missing",
                        evidence_category="final_output",
                        message=(
                            "At least one provided-output case has no usable declared "
                            "response. A response must be text; a structured value is "
                            "refused rather than scored as its printed form."
                        ),
                    )
                ],
                **common,
            )
        return EvidenceReadinessResult(
            status=EvidenceReadiness.READY,
            resolved_provenance={
                **requested,
                "status": ProvenanceStatus.SELF_REPORTED.value,
                "verification_source": "dataset declaration",
            },
            **common,
        )

    if response_source == "baseline":
        return EvidenceReadinessResult(
            status=EvidenceReadiness.READY,
            resolved_provenance={
                "target_type": "baseline",
                "identifier": None,
                "revision": None,
                "status": ProvenanceStatus.NOT_APPLICABLE.value,
                "supplied_by": "eval-hub",
                "verification_source": "dataset version",
            },
            **common,
        )

    if response_source == "llm":
        if not (target_model or "").strip():
            return EvidenceReadinessResult(
                status=EvidenceReadiness.BLOCKED,
                details=[ReadinessDetail(code="target_model_missing", message="An LLM model is required.")],
                **common,
            )
        endpoint = (target_endpoint or settings.openai_base_url or "").strip()
        if not endpoint:
            return EvidenceReadinessResult(
                status=EvidenceReadiness.BLOCKED,
                details=[
                    ReadinessDetail(
                        code="llm_endpoint_missing",
                        message="No configured endpoint can invoke the selected LLM.",
                    )
                ],
                **common,
            )
        base_url = resolve_llm_base_url(target_endpoint, settings)
        tenant_gateway = urlsplit(base_url).hostname in {
            "tenant-ai-gateway",
            f"tenant-ai-gateway.{settings.pod_namespace}.svc.cluster.local",
        }
        return EvidenceReadinessResult(
            status=EvidenceReadiness.READY,
            resolved_provenance={
                **requested,
                "status": ProvenanceStatus.SELF_REPORTED.value,
                "verification_source": "Tenant gateway model catalogue" if tenant_gateway else "Configured endpoint",
            },
            **common,
        )

    if response_source != "agent":
        return EvidenceReadinessResult(
            status=EvidenceReadiness.UNSUPPORTED,
            details=[
                ReadinessDetail(
                    code="source_unsupported",
                    message=f"Unknown evaluation source: {response_source}.",
                )
            ],
            **common,
        )
    if not agent:
        return EvidenceReadinessResult(
            status=EvidenceReadiness.BLOCKED,
            details=[ReadinessDetail(code="agent_missing", message="A target agent is required.")],
            **common,
        )

    external = agent.startswith(EXTERNAL_PREFIX)
    if external:
        try:
            resolved_agent = external_summary(await resolve_external_target(agent, settings))
        except AgentCatalogError as exc:
            return EvidenceReadinessResult(
                status=EvidenceReadiness.BLOCKED,
                details=[ReadinessDetail(code="external_agent_invalid", message=str(exc))],
                **common,
            )
    else:
        try:
            agents = await list_tenant_agents(
                kagent_url=settings.kagent_url,
                namespace=settings.pod_namespace,
                ready_only=False,
                excluded_tools=settings.excluded_tool_names,
            )
        except httpx.HTTPError as exc:
            return EvidenceReadinessResult(
                status=EvidenceReadiness.UNKNOWN,
                details=[
                    ReadinessDetail(
                        code="agent_discovery_unavailable",
                        message=f"Agent readiness could not be determined: {exc}",
                    )
                ],
                **common,
            )

        resolved_agent = next((candidate for candidate in agents if candidate.id == agent), None)
        if resolved_agent is None:
            return EvidenceReadinessResult(
                status=EvidenceReadiness.BLOCKED,
                details=[
                    ReadinessDetail(
                        code="agent_not_found",
                        message=f"Agent {agent} is not available in this tenant.",
                    )
                ],
                **common,
            )
    # Report the resolved agent's declared tool inventory. Only a Declarative
    # agent declares its tools in the CR; a BYO agent's inventory is unknown
    # (``None``), never fabricated as empty.
    declared_tools = (
        list(resolved_agent.tools)
        if resolved_agent.agent_type == "Declarative"
        else None
    )
    common["agent_tools"] = declared_tools
    if selected_tool_ids is not None:
        if declared_tools is None:
            return EvidenceReadinessResult(
                status=EvidenceReadiness.BLOCKED,
                details=[
                    ReadinessDetail(
                        code="selected_tools_unverifiable",
                        evidence_category="tool_calls",
                        message=(
                            f"Agent {agent} does not declare a verifiable tool "
                            "inventory, so a named-tool selection cannot be "
                            "validated."
                        ),
                    )
                ],
                **common,
            )
        unknown_tools = sorted(set(selected_tool_ids) - set(declared_tools))
        if unknown_tools:
            return EvidenceReadinessResult(
                status=EvidenceReadiness.BLOCKED,
                details=[
                    ReadinessDetail(
                        code="selected_tools_unknown",
                        evidence_category="tool_calls",
                        message=(
                            "Selected tool(s) are not declared by agent "
                            f"{agent}: {', '.join(unknown_tools)}."
                        ),
                    )
                ],
                **common,
            )
    # The agent (and its declared tools) is resolved: refine tool-metric
    # applicability now — a Declarative agent with zero tools makes agent.tool_*
    # N/A. Done before the ready/accepted check so every downstream return
    # (including not-ready and BYO-unsupported) carries the refined result.
    # A named-tool selection narrows the evaluated tool layer, so tool-evidence
    # checks resolve against ONLY the selected tools.
    common["metric_applicability"] = classify_pre_run_applicability(
        metrics,
        response_source=response_source,
        scenario=scenario,
        has_reference=_dataset_has_reference(records),
        agent_tools=(
            list(selected_tool_ids)
            if selected_tool_ids is not None
            else resolved_agent.tools
        ),
        agent_type=resolved_agent.agent_type,
    )
    # Re-check now that tool applicability is final: a contract-required tool
    # metric on a zero-tool agent blocks setup.
    pinned = _contract_pinned_block(common["metric_applicability"], resolved_metric_requirements)
    if pinned is not None:
        return EvidenceReadinessResult(status=EvidenceReadiness.BLOCKED, details=[pinned], **common)
    if not resolved_agent.ready or not resolved_agent.accepted:
        return EvidenceReadinessResult(
            status=EvidenceReadiness.BLOCKED,
            details=[
                ReadinessDetail(
                    code="agent_not_ready",
                    message=f"Agent {agent} is not ready and accepted for invocation.",
                )
            ],
            **common,
        )
    if requires_tools and resolved_agent.agent_type == "BYO" and not settings.trace_archive_enabled:
        return EvidenceReadinessResult(
            status=EvidenceReadiness.UNSUPPORTED,
            details=[
                ReadinessDetail(
                    code="agent_tool_capture_unsupported",
                    evidence_category="tool_calls",
                    message="This BYO agent does not declare a V1 tool-evidence capture capability.",
                )
            ],
            **common,
        )
    expected_revision = (expected_provenance or {}).get("revision")
    if expected_revision and expected_revision != resolved_agent.revision:
        return EvidenceReadinessResult(
            status=EvidenceReadiness.BLOCKED,
            details=[
                ReadinessDetail(
                    code="target_drift",
                    message=(f"Agent revision drifted from {expected_revision} to {resolved_agent.revision} before invocation."),
                )
            ],
            **common,
        )
    if requires_tools and not tool_evidence_attestation_available(settings):
        return EvidenceReadinessResult(
            status=EvidenceReadiness.UNSUPPORTED,
            details=[
                ReadinessDetail(
                    code="tool_capture_completion_unavailable",
                    evidence_category="tool_calls",
                    message=_TOOL_CAPTURE_ATTESTATION_UNAVAILABLE,
                )
            ],
            **common,
        )

    return EvidenceReadinessResult(
        status=EvidenceReadiness.READY,
        resolved_provenance={
            "target_type": "agent",
            "identifier": resolved_agent.id,
            "revision": resolved_agent.revision,
            "model": resolved_agent.model,
            "status": ProvenanceStatus.ATTESTED.value,
            "supplied_by": "registered A2A agent card" if external else "kagent-controller",
            "verification_source": "tenant-scoped immutable agent catalog" if external else "tenant-scoped kagent discovery",
        },
        **common,
    )


def _final_output_status(rows: list[EvaluationRow]) -> EvidenceCategoryStatus:
    """Capture status for the target's answer, independent of its content.

    An invocation that failed produced no answer to capture. An invocation that
    succeeded produced one, even when it is empty — that is a quality signal for
    the metrics to grade, not an evidence gap.
    """

    if not rows:
        return EvidenceCategoryStatus.CAPTURED
    captured = sum(not row.invocation_error for row in rows)
    if captured == len(rows):
        return EvidenceCategoryStatus.CAPTURED
    return EvidenceCategoryStatus.PARTIAL if captured else EvidenceCategoryStatus.NOT_CAPTURED



def classify_evidence_capture(
    rows: list[EvaluationRow],
    *,
    response_source: str = "agent",
    evaluation_scope: EvaluationScope,
    effective_requirements: list[str],
) -> tuple[EvidenceCaptureStatus, list[EvidenceCategorySummary]]:
    """Classify observed evidence without treating an attested zero event as missing.

    Every required capture category appears in the result. Categories this
    function cannot genuinely assess are reported UNKNOWN with UNAVAILABLE
    provenance rather than left out, so neither the overall status nor the
    release gate can mistake an unexamined requirement for a satisfied one.
    """

    required = set(effective_requirements)
    final_output_provenance = {
        "provided": (ProvenanceStatus.SELF_REPORTED, "dataset declaration"),
        "baseline": (ProvenanceStatus.NOT_APPLICABLE, "dataset version"),
    }.get(
        response_source,
        (ProvenanceStatus.ATTESTED, "evaluation target invocation"),
    )
    categories = [
        EvidenceCategorySummary(
            category="input",
            required="input" in required,
            status=EvidenceCategoryStatus.CAPTURED,
            record_count=sum(bool(row.query) for row in rows),
            completeness_attested=True,
            provenance_status=ProvenanceStatus.ATTESTED,
            provenance_source="versioned dataset",
        ),
        EvidenceCategorySummary(
            category="final_output",
            required="final_output" in required,
            # Whether the answer reached us, not whether the answer is any good.
            # Keying this on a non-empty response conflated the two: a target
            # that answered with nothing had been captured perfectly, but was
            # reported as missing evidence — which inverts the attribution and
            # suppresses a real quality failure behind an inconclusive verdict.
            status=_final_output_status(rows),
            record_count=sum(not row.invocation_error for row in rows),
            completeness_attested=True,
            provenance_status=final_output_provenance[0],
            provenance_source=final_output_provenance[1],
        ),
    ]

    tools_required = "tool_calls" in required or "tool_results" in required
    if evaluation_scope == EvaluationScope.TOOL_INTERACTIONS or tools_required:
        unavailable = sum(row.trace_unavailable for row in rows)
        attested = sum(row.tool_evidence_completion_attested for row in rows)
        tool_count = sum(len(row.tool_calls) for row in rows)
        if unavailable == len(rows):
            tool_call_status = EvidenceCategoryStatus.NOT_CAPTURED
        elif unavailable:
            tool_call_status = EvidenceCategoryStatus.PARTIAL
        elif attested == len(rows):
            tool_call_status = EvidenceCategoryStatus.CAPTURED
        elif tool_count:
            tool_call_status = EvidenceCategoryStatus.PARTIAL
        else:
            # An empty sessions response without a completion manifest cannot
            # distinguish a genuine zero-event execution from unsettled capture.
            tool_call_status = EvidenceCategoryStatus.UNKNOWN
        captured_result_count = sum(_tool_result_captured(tool) for row in rows if not row.trace_unavailable for tool in row.tool_calls)
        if unavailable == len(rows):
            tool_result_status = EvidenceCategoryStatus.NOT_CAPTURED
        elif unavailable:
            tool_result_status = EvidenceCategoryStatus.PARTIAL
        elif attested == len(rows) and (tool_count == 0 or captured_result_count == tool_count):
            tool_result_status = EvidenceCategoryStatus.CAPTURED
        elif tool_count == 0:
            tool_result_status = EvidenceCategoryStatus.UNKNOWN
        elif captured_result_count == 0:
            tool_result_status = EvidenceCategoryStatus.NOT_CAPTURED
        else:
            tool_result_status = EvidenceCategoryStatus.PARTIAL
        provenance_statuses = {row.tool_evidence_provenance_status for row in rows}
        tool_provenance = (
            ProvenanceStatus.ATTESTED
            if provenance_statuses == {ProvenanceStatus.ATTESTED}
            else ProvenanceStatus.SELF_REPORTED
            if provenance_statuses == {ProvenanceStatus.SELF_REPORTED}
            else ProvenanceStatus.UNAVAILABLE
        )
        provenance_sources = sorted(
            {row.tool_evidence_source for row in rows if row.tool_evidence_source}
        )
        provenance_source = ", ".join(provenance_sources) or None
        categories.extend(
            [
                EvidenceCategorySummary(
                    category="tool_calls",
                    required="tool_calls" in required,
                    status=tool_call_status,
                    record_count=tool_count,
                    completeness_attested=attested == len(rows),
                    provenance_status=tool_provenance,
                    provenance_source=provenance_source,
                ),
                EvidenceCategorySummary(
                    category="tool_results",
                    required="tool_results" in required,
                    status=tool_result_status,
                    record_count=captured_result_count,
                    completeness_attested=(attested == len(rows) and tool_result_status == EvidenceCategoryStatus.CAPTURED),
                    provenance_status=tool_provenance,
                    provenance_source=provenance_source,
                ),
            ]
        )

    if "trace" in required:
        # Presence and completeness are separate. Span count says what landed;
        # the archive's closed-root, complete-pagination and settled-snapshot
        # decision says whether that set is whole.
        with_spans = sum(bool(row.trace_span_count) for row in rows)
        trace_attested = bool(rows) and all(
            row.trace_completion_attested for row in rows
        )
        categories.append(
            EvidenceCategorySummary(
                category="trace",
                required=True,
                status=(
                    EvidenceCategoryStatus.CAPTURED
                    if rows and with_spans == len(rows)
                    else EvidenceCategoryStatus.PARTIAL
                    if with_spans
                    else EvidenceCategoryStatus.NOT_CAPTURED
                ),
                record_count=sum(row.trace_span_count or 0 for row in rows),
                completeness_attested=trace_attested,
                provenance_status=(
                    ProvenanceStatus.ATTESTED if with_spans else ProvenanceStatus.UNAVAILABLE
                ),
                provenance_source="otel-archive" if with_spans else None,
            )
        )

    if "retrieval" in required:
        # Absent retrieval is not the same as unexamined retrieval. An agent that
        # calls no retrieval tool has none to show, and reporting that as unknown
        # invites a hunt for a capture fault that does not exist. The trace tells
        # us which case we are in: read it and find nothing, and there was
        # nothing; fail to read it, and we genuinely cannot say.
        retrieved = sum(bool(row.retrieval_snippets) for row in rows)
        traced = sum(bool(row.trace_span_count) for row in rows)
        observed = sum(bool(row.retrieval_snippets) or (bool(row.trace_span_count) and row.trace_completion_attested) for row in rows)
        trace_attested = bool(rows) and all(
            row.trace_completion_attested for row in rows
        )
        if retrieved:
            retrieval_status = (
                EvidenceCategoryStatus.CAPTURED
                if observed == len(rows)
                else EvidenceCategoryStatus.PARTIAL
            )
        elif rows and traced == len(rows):
            retrieval_status = EvidenceCategoryStatus.NOT_REQUIRED
        else:
            retrieval_status = EvidenceCategoryStatus.UNKNOWN
        categories.append(
            EvidenceCategorySummary(
                category="retrieval",
                # The scope asks for it, but a target with no retrieval stage
                # cannot owe it. Left required, an expected absence would hold
                # the run off complete and block a release for evidence that was
                # never going to exist.
                required=retrieval_status != EvidenceCategoryStatus.NOT_REQUIRED,
                status=retrieval_status,
                record_count=retrieved,
                # Retrieval is complete only when the trajectory it was
                # extracted from is complete. An explicit no-retrieval result
                # is represented as not required above.
                completeness_attested=bool(retrieved) and trace_attested,
                provenance_status=(
                    ProvenanceStatus.ATTESTED
                    if retrieved
                    else ProvenanceStatus.NOT_APPLICABLE
                    if retrieval_status == EvidenceCategoryStatus.NOT_REQUIRED
                    else ProvenanceStatus.UNAVAILABLE
                ),
                provenance_source="otel-archive" if retrieved else None,
            )
        )

    if "model_usage" in required:
        # The target's own report of the invocation, not a sum over archive
        # spans. Summing spans is where this went wrong three times: nested
        # generation spans re-report the same call, so the obvious rules
        # over-count a wrapper or under-count two independent nested calls, and
        # no convention says which span owns a call. The invocation reports its
        # own figure and needs no such convention -- and that same figure already
        # scores ops.total_token_count, so calling the category unknown
        # contradicted a number the run was already publishing.
        #
        # The invocation, rather than nested LLM spans, owns aggregate usage.
        # Completion attestation means that report was finalized by a closed
        # invocation; provenance remains self-reported because Eval Hub does not
        # independently recalculate the target's counters.
        with_usage = sum(_reported_token_count(row.target_usage) is not None for row in rows)
        usage_attested = bool(rows) and all(
            row.model_usage_completion_attested for row in rows
        )
        if rows and with_usage == len(rows):
            usage_status = EvidenceCategoryStatus.CAPTURED
        elif with_usage:
            usage_status = EvidenceCategoryStatus.PARTIAL
        else:
            # Nothing reported usage. Whether the target does not report it or
            # we failed to capture it is exactly what we cannot tell.
            usage_status = EvidenceCategoryStatus.UNKNOWN
        categories.append(
            EvidenceCategorySummary(
                category="model_usage",
                required=True,
                status=usage_status,
                record_count=with_usage,
                completeness_attested=usage_attested,
                provenance_status=(
                    ProvenanceStatus.SELF_REPORTED if with_usage else ProvenanceStatus.UNAVAILABLE
                ),
                provenance_source="evaluation target invocation" if with_usage else None,
            )
        )

    if "lifecycle_events" in required:
        # The explicit completion marker on Eval Hub's recorded root span is the
        # lifecycle event. Streaming chunks and arbitrary ended child spans do
        # not count as completion evidence.
        traced = sum(bool(row.trace_span_count) for row in rows)
        lifecycle_count = sum(row.lifecycle_completion_attested for row in rows)
        lifecycle_attested = bool(rows) and lifecycle_count == len(rows)
        categories.append(
            EvidenceCategorySummary(
                category="lifecycle_events",
                required=True,
                status=(
                    EvidenceCategoryStatus.CAPTURED
                    if lifecycle_attested
                    else EvidenceCategoryStatus.PARTIAL
                    if lifecycle_count
                    else EvidenceCategoryStatus.NOT_CAPTURED
                    if rows and traced == len(rows)
                    else EvidenceCategoryStatus.UNKNOWN
                ),
                record_count=lifecycle_count,
                completeness_attested=lifecycle_attested,
                provenance_status=(
                    ProvenanceStatus.ATTESTED
                    if lifecycle_count
                    else ProvenanceStatus.UNAVAILABLE
                ),
                provenance_source="otel-archive" if lifecycle_count else None,
            )
        )

    # A required category the classifier cannot assess is reported UNKNOWN, never
    # omitted. The filter below reads the categories that were *built*, so a
    # requirement with no builder used to contribute nothing: a full-execution run
    # whose four buildable categories were captured reported COMPLETE, and the
    # release gate — which iterates the same list — found nothing missing to block
    # on. Absence must never read as sufficiency.
    # Capture-recognised only. A contract may also require evidence outside this
    # vocabulary — a signed gate report, say — and those are deliberately not
    # reported here: they are review artifacts, not runtime capture, and giving
    # them a required UNKNOWN row would make capture permanently partial and
    # withhold the verdict of every run under such a contract. They are filtered
    # upstream in the resolver and need their own reporting channel, not this one.
    assessed = {category.category for category in categories}
    for category in recognized_capture_categories(effective_requirements):
        if category in assessed:
            continue
        categories.append(
            EvidenceCategorySummary(
                category=category,
                required=True,
                status=EvidenceCategoryStatus.UNKNOWN,
                record_count=0,
                completeness_attested=False,
                provenance_status=ProvenanceStatus.UNAVAILABLE,
                provenance_source=None,
            )
        )

    required_categories = [category for category in categories if category.required]
    # Captured-but-unvouched is not complete. ``completeness_attested`` was
    # recorded on every category and read nowhere: the overall status and the
    # release gate both keyed on ``status`` alone, so evidence that arrived
    # without anything vouching for its completeness counted exactly like
    # evidence that had been. That is the whole distinction the flag exists to
    # draw, and it is what makes deriving a category from what merely landed
    # safe to do.
    statuses = {
        category.status
        if category.completeness_attested
        or category.status != EvidenceCategoryStatus.CAPTURED
        else EvidenceCategoryStatus.PARTIAL
        for category in required_categories
    }
    if not required_categories:
        overall = EvidenceCaptureStatus.UNKNOWN
    elif statuses == {EvidenceCategoryStatus.CAPTURED}:
        overall = EvidenceCaptureStatus.COMPLETE
    elif statuses == {EvidenceCategoryStatus.NOT_CAPTURED}:
        overall = EvidenceCaptureStatus.NOT_CAPTURED
    elif statuses == {EvidenceCategoryStatus.UNKNOWN}:
        overall = EvidenceCaptureStatus.UNKNOWN
    else:
        overall = EvidenceCaptureStatus.PARTIAL
    return overall, categories


def _tool_result_captured(tool: Any) -> bool:
    """Preserve explicit null results while supporting historical tool-call rows."""

    if tool.result_captured is not None:
        return tool.result_captured
    return tool.output is not None


def observed_target_provenance(
    *,
    response_source: str,
    rows: list[EvaluationRow],
    resolved_provenance: dict[str, Any],
) -> dict[str, Any]:
    """Build the post-invocation identity assertion and its trust level."""

    if response_source == "llm":
        observed_models = sorted({str((row.target_usage or {}).get("model")) for row in rows if (row.target_usage or {}).get("model")})
        return {
            "target_type": "llm",
            "identifier": observed_models[0] if len(observed_models) == 1 else None,
            "model": observed_models[0] if len(observed_models) == 1 else None,
            "status": (ProvenanceStatus.SELF_REPORTED.value if observed_models else ProvenanceStatus.UNAVAILABLE.value),
            "supplied_by": "model provider response",
            "verification_source": "chat completion model field",
        }
    if response_source == "agent":
        return {
            "target_type": "agent",
            "identifier": resolved_provenance.get("identifier"),
            "revision": None,
            "status": ProvenanceStatus.UNAVAILABLE.value,
            "supplied_by": "evaluation invocation",
            "verification_source": "A2A response has no runtime revision attestation",
        }
    return dict(resolved_provenance)


def _requested_provenance(
    *,
    response_source: str,
    agent: str | None,
    target_model: str | None,
    target_endpoint: str | None,
) -> dict[str, Any]:
    identifier = agent if response_source == "agent" else target_model
    return {
        "target_type": response_source,
        "identifier": identifier,
        "revision": None,
        "model": target_model,
        "endpoint": target_endpoint,
        "status": ProvenanceStatus.SELF_REPORTED.value,
        "supplied_by": "run request",
        "verification_source": None,
    }


def _record_query(record: dict[str, Any]) -> str:
    """Read the question the same way dataset coverage does.

    Coverage accepts ``question`` (``_QUERY_KEYS``); this read did not, so a
    question-keyed dataset — the shape the generation and records APIs produce —
    listed as Ready and then failed at launch with ``dataset_input_missing``.
    """

    return str(_first(record.get("inputs") or {}, _QUERY_KEYS) or "").strip()
