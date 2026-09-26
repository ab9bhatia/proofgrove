"""External A2A targets use the same evaluation pipeline without kagent."""

import ipaddress
import json
import logging
from types import SimpleNamespace

import httpx
import pytest
import respx

from proofgrove.db.session import async_session
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.enums import EvaluationScope, EvidenceReadiness, Scenario
from proofgrove.evaluation.judge import MockJudge
from proofgrove.evaluation.models import ArchivedTraceSpan, RunItemTraceEvidence
from proofgrove.evaluation.readiness import assess_evidence_readiness
from proofgrove.evaluation.run_service import execute_dataset_run
from proofgrove.evaluation.target import catalog
from proofgrove.evaluation.target.agent_runner import run_agent_target
from proofgrove.evaluation.target.external import credential_headers, invocation_endpoint, resolve_external_target
from proofgrove.platform.contracts import EvaluationProject, TargetType, TargetVersion
from proofgrove.settings import Settings


def _target(tenant="tenant-external"):
    return TargetVersion(
        target_id="remote-math", project_id="external-project", tenant_id=tenant,
        name="Remote math", version="1", endpoint="https://agent.example",
        target_type=TargetType.AGENT,
        configuration={
            "catalog_source": "a2a_agent_card", "credential_ref": "math",
            "agent_card": {"url": "https://agent.example/a2a", "capabilities": {"streaming": True}},
        },
    )


def _settings(**kwargs):
    return Settings(
        pod_namespace="tenant-external", trace_archive_enabled=True,
        external_agent_credentials={"math": {"origin": "https://agent.example", "Authorization": "Bearer test-token"}},
        **kwargs,
    )


async def _save(target):
    async with async_session() as session:
        store = EvaluationStore(session)
        await store.save_project(EvaluationProject(
            project_id=target.project_id, tenant_id=target.tenant_id,
            name="Remote agents", system_type="agent", owner="test",
        ))
        await store.save_target_version(target)


@respx.mock
@pytest.mark.asyncio
async def test_external_agent_catalog_readiness_and_real_a2a_transport(monkeypatch):
    target = _target()
    await _save(target)
    reference = f"external:{target.target_version_id}"
    cfg = _settings()
    readiness = await assess_evidence_readiness(
        response_source="agent", agent=reference, target_model=None, target_endpoint=None,
        evaluation_scope=EvaluationScope.FULL_EXECUTION, scenario=Scenario.AGENTIC,
        records=[{"inputs": {"query": "12 times 7"}, "expectations": {"response": "84"}}],
        active_metric_ids=["llm.correctness"], settings=cfg,
    )
    assert readiness.status == EvidenceReadiness.READY
    assert readiness.resolved_provenance["revision"] == target.target_version_id
    assert "kagent" not in readiness.resolved_provenance["verification_source"]

    async def dns(host, port):
        assert (host, port) == ("agent.example", 443)
        return [ipaddress.ip_address("93.184.216.34")]

    monkeypatch.setattr(catalog, "resolve_endpoint_addresses", dns)
    frame = {"result": {"contextId": "remote-session", "status": {"state": "completed", "message": {
        "role": "assistant", "parts": [{"kind": "text", "text": "84"}],
    }}}}
    rpc = respx.post("https://93.184.216.34/a2a").respond(
        200, headers={"content-type": "text/event-stream"},
        content=f"data: {json.dumps(frame)}\n\ndata: [DONE]\n\n",
    )
    output = await run_agent_target(settings=cfg, target_endpoint=reference, query="12 times 7")
    assert output.response == "84"
    assert output.context_id == "remote-session"
    assert output.trace_id and output.span_id
    assert output.trace_unavailable is True  # No invented tool evidence/session fetch.
    assert len(respx.calls) == 1  # No kagent discovery or session requests.
    request = rpc.calls[0].request
    assert request.headers["authorization"] == "Bearer test-token"
    assert "X-User-ID" not in request.headers
    assert request.headers["host"] == "agent.example"
    assert request.extensions["sni_hostname"] == "agent.example"
    assert request.headers["traceparent"].split("-")[1] == output.trace_id
    assert "evalaieval=1" in request.headers["tracestate"]

    # Exercise the framework through persistence, with an archived tool result
    # arriving on the exact trace created by the real external A2A transport.
    from proofgrove.evaluation import run_service, trace_hydrator

    cfg.trace_archive_completion_settle_seconds = 0
    cfg.trace_archive_completion_min_identical_observations = 1
    monkeypatch.setattr(run_service, "settings", cfg)

    class Archive:
        async def find(self, **kwargs):
            trace_id = kwargs["trace_id"]
            return RunItemTraceEvidence(
                state="available", trace_id=trace_id, pagination_complete=True,
                lifecycle_complete=True, evidence_complete=True, spans=[
                    ArchivedTraceSpan(trace_id=trace_id, span_id="1111111111111111", name="agent", attributes={
                        "openinference.span.kind": "AGENT", "output.value": "84",
                    }),
                    ArchivedTraceSpan(trace_id=trace_id, span_id="2222222222222222", name="multiply", attributes={
                        "openinference.span.kind": "TOOL", "tool.name": "multiply",
                        "tool.parameters": '{"a":12,"b":7}', "output.value": "84",
                    }),
                ],
            )

    monkeypatch.setattr(trace_hydrator, "TraceArchiveReader", lambda _: Archive())
    registry = SimpleNamespace(
        get_dataset=lambda _, tenant_id=None: SimpleNamespace(version_number=1, product_id="proofgrove", tenant_id="tenant-external", status="PUBLISHED"),
        get_records=lambda _, tenant_id=None: [{"dataset_record_id": "math-row", "inputs": {"query": "12 times 7"}, "expectations": {"expected_output": "84"}}],
    )
    async with async_session() as session:
        store = EvaluationStore(session)
        run_id = await store.create_run_job(
            dataset_name="math", response_source="agent", agent=reference,
            row_count=1, judge_model="mock", tenant_id="tenant-external",
        )
        await execute_dataset_run(
            run_id=run_id, dataset_name="math", response_source="agent", agent=reference,
            row_count=1, judge_model="mock", resolved_active_metrics=["llm.correctness"],
            evaluation_scope=EvaluationScope.FULL_EXECUTION, enable_llm_judge=False,
            run_human_review=False, store=store, engine=EvaluationEngine(judge=MockJudge()), registry=registry,
        )
        run = await store.get_run(run_id)
        items = await store.list_run_items(run_id)
        item = await store.get_run_item(run_id, items[0].example_id)
    assert run.status.value == "completed"
    assert item.tool_calls[0].args == {"a": 12, "b": 7}
    assert item.tool_calls[0].output == "84"
    assert item.tool_calls[0].result_captured is True
    metric = run.metric_results[0]
    assert metric.target_trace_id and metric.evaluator_trace_id
    assert metric.target_trace_id != metric.evaluator_trace_id
    assert rpc.call_count == 2


@pytest.mark.asyncio
async def test_external_reference_cannot_resolve_another_tenants_target():
    target = _target(tenant="tenant-other")
    await _save(target)
    with pytest.raises(catalog.AgentCatalogError, match="not registered in this tenant"):
        await resolve_external_target(f"external:{target.target_version_id}", _settings())


@respx.mock
@pytest.mark.asyncio
async def test_dns_rebinding_is_rejected_at_invocation(monkeypatch):
    target = _target()
    await _save(target)

    async def dns(host, port):
        return [ipaddress.ip_address("169.254.169.254")]

    monkeypatch.setattr(catalog, "resolve_endpoint_addresses", dns)
    with pytest.raises(catalog.AgentCatalogError, match="private or local"):
        await run_agent_target(settings=_settings(), target_endpoint=f"external:{target.target_version_id}", query="q")
    assert not respx.calls


@pytest.mark.parametrize("url", ["https://other.example/a2a", "http://agent.example/a2a", "https://127.0.0.1/a2a"])
def test_card_cannot_redirect_invocation_or_credentials(url):
    target = _target()
    target.configuration["agent_card"]["url"] = url
    with pytest.raises(catalog.AgentCatalogError):
        invocation_endpoint(target, "tenant-external")


@pytest.mark.parametrize("endpoint,reference", [
    ("https://other.example", "math"), ("http://agent.example", "math"),
    ("https://agent.example", "unknown"),
])
def test_credentials_fail_closed_for_wrong_origin_http_or_unknown_reference(endpoint, reference):
    with pytest.raises(catalog.AgentCatalogError):
        credential_headers(_settings(), reference, endpoint)


def test_credentials_are_masked_in_settings_representation():
    assert "test-token" not in repr(_settings())


@pytest.mark.parametrize("field,value", [("protocolVersion", "1.0.0"), ("preferredTransport", "GRPC")])
def test_unsupported_protocol_is_rejected_before_invocation(field, value):
    target = _target()
    target.configuration["agent_card"][field] = value
    with pytest.raises(catalog.AgentCatalogError, match="JSON-RPC"):
        invocation_endpoint(target, "tenant-external")


@pytest.mark.parametrize("literal", ["168.63.129.16", "100.64.0.1", "100.127.255.254", "::ffff:168.63.129.16", "::ffff:100.64.0.1"])
@pytest.mark.asyncio
async def test_platform_special_addresses_are_never_valid_targets(monkeypatch, literal):
    address = ipaddress.ip_address(literal)
    host = f"[{literal}]" if address.version == 6 else literal
    with pytest.raises(catalog.AgentCatalogError):
        catalog.normalize_agent_endpoint(f"http://{host}", "tenant-a")
    for allow_private in (False, True):
        assert catalog.is_blocked_address(address, allow_private=allow_private)
    async def resolve(host, port):
        return [address]
    monkeypatch.setattr(catalog, "resolve_endpoint_addresses", resolve)
    for hostname in ("agent.example", "agent.tenant-a.svc.cluster.local"):
        with pytest.raises(catalog.AgentCatalogError):
            await catalog.resolve_agent_card_request(f"http://{hostname}")
    assert not catalog.is_blocked_address(ipaddress.ip_address("10.0.0.2"), allow_private=True)


@respx.mock
@pytest.mark.asyncio
async def test_agent_card_fetch_failure_log_omits_url_and_exception_text(monkeypatch, caplog):
    """A connect failure must log only the exception type + tenant, never the raw
    URL (query values included) or the exception's own text (which can echo
    back connection/credential detail)."""

    async def dns(host, port):
        return [ipaddress.ip_address("93.184.216.34")]

    monkeypatch.setattr(catalog, "resolve_endpoint_addresses", dns)
    secret_detail = "refused by upstream secret-token=ABC123 at 10.9.9.9:443"
    respx.get("https://93.184.216.34/a2a/.well-known/agent.json").mock(
        side_effect=httpx.ConnectError(secret_detail)
    )
    with caplog.at_level(logging.WARNING, logger="proofgrove.evaluation.target.catalog"):
        with pytest.raises(catalog.AgentCatalogError, match="Could not connect"):
            await catalog.test_agent_connectivity(
                "https://agent.example/a2a", tenant_namespace="tenant-catalog-test"
            )
    [record] = [r for r in caplog.records if "agent-card fetch failed" in r.message]
    assert "agent.example" not in record.message
    assert secret_detail not in record.message
    assert "ConnectError" in record.message
    assert "tenant-catalog-test" in record.message
