"""Local workflows execute tools; their golden expectations remain separate."""
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from proofgrove.evaluation.enums import EvaluationScope, EvidenceReadiness, ProvenanceStatus, Scenario
from proofgrove.evaluation.readiness import assess_evidence_readiness
from proofgrove.evaluation.target import local_workflows as local
from proofgrove.evaluation.target.a2a_client import AgentInvocationError
from proofgrove.evaluation.target.agent_runner import run_agent_target
from proofgrove.evaluation.target.llm_runner import LlmInvocationError, LlmTargetOutput
from proofgrove.settings import Settings

MODEL = {"provider": "ollama", "model_id": "test-local-model", "endpoint": "http://127.0.0.1:11434/v1"}


@pytest.fixture
def lab(monkeypatch):
    monkeypatch.setenv("PROOFGROVE_MODE", "local")
    return Settings(app_env="dev", evaluation_runtime="local", pod_namespace="tenant-local-classroom")


@pytest.fixture
def connected(monkeypatch, lab):
    monkeypatch.setattr(local, "provider_snapshot", AsyncMock(return_value={"default": MODEL}))
    return lab


@pytest.mark.parametrize("slug,key,known,unknown", [
    ("nova-refunds", "order_id", "7734", "9999"),
    ("order-tracking", "order_id", "8841", "9999"),
    ("course-advisor", "learner_id", "maya", "unknown"),
    ("study-planner", "learner_id", "arjun", "unknown"),
    ("it-helpdesk", "ticket_id", "HD103", "HD999"),
    ("expense-reviewer", "expense_id", "EXP102", "EXP999"),
])
def test_all_workflows_execute_known_and_missing_records(lab, slug, key, known, unknown):
    workflow = local.get_workflow("local:" + slug, lab)
    prefix = "learner " if key == "learner_id" else ""
    calls = local.execute_workflow(workflow, prefix + known)
    assert [call.name for call in calls] == list(workflow.tools)
    assert all(call.args == {key: known} and call.result_captured is True for call in calls)
    assert calls[0].output["status"] == "found"
    assert calls[0].output["record"][key] == known
    unknown_calls = local.execute_workflow(workflow, prefix + unknown)
    assert len(unknown_calls) == 1
    assert unknown_calls[0].output == {"status": "not_found", key: unknown}
    missing_calls = local.execute_workflow(workflow, "Please help")
    assert len(missing_calls) == 1
    assert missing_calls[0].output == {"status": "missing_identifier", "required_field": key}


def test_policy_and_computation_tools_use_fixture_values():
    assert local.check_refund_eligibility("7734")["proposed_amount"] == 250
    assert local.check_refund_eligibility("7733")["eligible"] is False
    assert local.check_refund_eligibility("7735")["reason"] == "already_refunded"
    assert local.get_delivery_update("8843")["estimated_delivery"] is None
    assert local.search_courses("maya")["matching_courses"][0]["title"] == "SQL Foundations"
    for learner, budget in (("maya", 240), ("arjun", 480), ("sara", 600)):
        plan = local.build_study_plan(learner)
        assert sum(session["minutes"] for session in plan["sessions"]) == budget == plan["total_minutes"]
    assert local.search_runbook("HD103")["requires_approval"] is True
    assert local.search_runbook("HD102")["never_request"] == ["password", "one-time code"]
    assert local.check_expense_policy("EXP101")["eligible_for_review"] is True
    assert local.check_expense_policy("EXP102")["issues"] == ["above_meal_limit"]
    assert local.check_expense_policy("EXP103")["issues"] == ["receipt_required"]


@pytest.mark.parametrize("workflow", local.WORKFLOWS, ids=lambda workflow: workflow.slug)
async def test_fresh_model_answers_and_tool_capture_for_every_agent(connected, monkeypatch, workflow):
    synthesize = AsyncMock(side_effect=[
        LlmTargetOutput(response="Fresh model answer one", model_id=MODEL["model_id"], latency_seconds=0.02),
        LlmTargetOutput(response="Fresh model answer two", model_id=MODEL["model_id"], latency_seconds=0.02),
    ])
    monkeypatch.setattr(local, "run_llm_target", synthesize)
    first = await run_agent_target(settings=connected, target_endpoint=workflow.reference, query=workflow.example_query)
    second = await run_agent_target(settings=connected, target_endpoint=workflow.reference, query=workflow.example_query)
    assert first.response != second.response
    assert first.invocation_id != second.invocation_id
    assert first.tool_calls is not second.tool_calls
    assert first.tool_calls[0].output is not second.tool_calls[0].output
    assert first.tool_evidence_completion_attested is True
    assert first.tool_evidence_provenance_status == ProvenanceStatus.ATTESTED
    assert first.tool_evidence_source == local.TOOL_EVIDENCE_SOURCE
    assert first.trace_unavailable is False
    assert len(first.tool_calls) == 2
    request = synthesize.await_args.kwargs
    assert request["target_model"] == MODEL["model_id"]
    assert "Fresh tool results:" in request["query"]
    assert all(call.name in request["query"] for call in first.tool_calls)
    assert "synthetic local fixtures" in request["system_prompt"]


@pytest.mark.parametrize("mode,env,runtime,namespace", [
    ("local", "prod", "local", "tenant-local-classroom"),
    ("local", "dev", "temporal", "tenant-local-classroom"),
    ("local", "dev", "local", "tenant-other"),
    ("offline", "dev", "local", "tenant-local-classroom"),
    ("unknown", "dev", "local", "tenant-local-classroom"),
])
async def test_local_mode_guard_prevents_invocation(monkeypatch, mode, env, runtime, namespace):
    monkeypatch.setenv("PROOFGROVE_MODE", mode)
    settings = Settings(app_env="dev", evaluation_runtime=runtime, pod_namespace=namespace)
    settings.app_env = env
    provider = AsyncMock(side_effect=AssertionError("Must not access providers"))
    monkeypatch.setattr(local, "provider_snapshot", provider)
    assert not local.is_local_agent("local:nova-refunds", settings)
    with pytest.raises(AgentInvocationError):
        await run_agent_target(settings=settings, target_endpoint="local:nova-refunds", query="Order 7734")
    provider.assert_not_awaited()


async def test_unknown_local_id_never_dispatches_to_network(lab, monkeypatch):
    provider = AsyncMock(side_effect=AssertionError("Must not access providers"))
    monkeypatch.setattr(local, "provider_snapshot", provider)
    for ref in ("local:unknown", "local:http://127.0.0.1/admin", "local:nova-refunds/extra"):
        with pytest.raises(AgentInvocationError, match="Unknown local workflow"):
            await run_agent_target(settings=lab, target_endpoint=ref, query="Order 7734")
    provider.assert_not_awaited()


async def test_frozen_model_is_used_for_run_without_reselecting(connected, monkeypatch):
    provider = AsyncMock(side_effect=AssertionError("Do not reselect mid-run"))
    monkeypatch.setattr(local, "provider_snapshot", provider)
    synthesize = AsyncMock(return_value=LlmTargetOutput(response="Fresh answer", model_id="frozen-model", latency_seconds=0.02))
    monkeypatch.setattr(local, "run_llm_target", synthesize)
    frozen = {**MODEL, "model_id": "frozen-model"}
    await run_agent_target(settings=connected, target_endpoint="local:nova-refunds", query="Order 7734", resolved_local_model=frozen)
    assert synthesize.await_args.kwargs["target_model"] == "frozen-model"
    provider.assert_not_awaited()


async def test_model_unavailable_and_generation_failure_do_not_return_canned_answers(lab, monkeypatch):
    monkeypatch.setattr(local, "provider_snapshot", AsyncMock(return_value={"default": None}))
    with pytest.raises(AgentInvocationError, match="No connected default model"):
        await run_agent_target(settings=lab, target_endpoint="local:nova-refunds", query="Order 7734")
    monkeypatch.setattr(local, "provider_snapshot", AsyncMock(return_value={"default": MODEL}))
    monkeypatch.setattr(local, "run_llm_target", AsyncMock(side_effect=LlmInvocationError("LLM timed out.")))
    with pytest.raises(AgentInvocationError, match="LLM timed out"):
        await run_agent_target(settings=lab, target_endpoint="local:nova-refunds", query="Order 7734")


async def test_tool_failure_stops_before_model_call(connected, monkeypatch):
    def broken(**kwargs):
        raise ValueError("private internals")
    monkeypatch.setitem(local.TOOLS, "lookup_order", broken)
    model = AsyncMock()
    monkeypatch.setattr(local, "run_llm_target", model)
    with pytest.raises(AgentInvocationError, match="A local workflow tool failed") as error:
        await run_agent_target(settings=connected, target_endpoint="local:nova-refunds", query="Order 7734")
    assert "private internals" not in str(error.value)
    model.assert_not_awaited()


async def test_catalog_availability_tracks_model_and_versions(connected, monkeypatch):
    summaries = await local.local_agent_summaries(connected)
    assert len(summaries) == 6 and all(item.ready for item in summaries)
    targets = local.local_catalog_targets(summaries, connected.pod_namespace, "catalog")
    assert len({target.target_version_id for target in targets}) == 6
    assert all(target.configuration["external_side_effects"] is False for target in targets)
    assert all(target.configuration["recommended_dataset_id"].startswith("agent_") for target in targets)
    monkeypatch.setattr(local, "provider_snapshot", AsyncMock(return_value={"default": None}))
    disconnected = await local.local_agent_summaries(connected)
    assert all(not item.ready for item in disconnected)
    assert disconnected[0].revision != summaries[0].revision


async def _readiness(settings, *, scope=EvaluationScope.TOOL_INTERACTIONS, agent="local:nova-refunds", expected=None, selected=None):
    return await assess_evidence_readiness(
        response_source="agent", evaluation_scope=scope, agent=agent, target_model=None,
        target_endpoint=agent, records=[{"inputs": {"question": "Order 7734"}, "expectations": {"expected_output": "Propose AED250"}}],
        active_metric_ids=list(local.RECOMMENDED_METRICS), scenario=Scenario.AGENTIC,
        settings=settings, enable_llm_judge=False, expected_provenance=expected, selected_tool_ids=selected,
    )


async def test_readiness_captures_local_tools_without_claiming_full_archive(connected):
    ready = await _readiness(connected)
    assert ready.status == EvidenceReadiness.READY
    assert ready.agent_tools == ["lookup_order", "check_refund_eligibility"]
    assert ready.resolved_provenance["verification_source"] == "code-owned local tools and configured model"
    full = await _readiness(connected, scope=EvaluationScope.FULL_EXECUTION)
    assert full.status == EvidenceReadiness.UNSUPPORTED
    assert full.details[0].code == "local_full_execution_unsupported"
    drift = await _readiness(connected, expected={"revision": "changed"})
    assert drift.status == EvidenceReadiness.BLOCKED and drift.details[0].code == "target_drift"
    wrong_tool = await _readiness(connected, selected=["send_money"])
    assert wrong_tool.status == EvidenceReadiness.BLOCKED and wrong_tool.details[0].code == "selected_tools_unknown"


def test_all_24_authored_golden_contracts_match_executed_tool_evidence(lab):
    from proofgrove.evaluation.adapters.trace_adapter import TraceJudge
    from proofgrove.evaluation.dataset_bridge import record_to_row
    from proofgrove.evaluation.enums import Adapter, ScoringType
    from proofgrove.evaluation.models import EvaluatorConfig

    path = Path(__file__).resolve().parents[3] / "samples/working-agents/golden-datasets.json"
    datasets = json.loads(path.read_text())["datasets"]
    cases = 0
    for dataset in datasets:
        workflow = local.get_workflow(dataset["agent_ref"], lab)
        for record in dataset["records"]:
            row = record_to_row(record, response_source="agent")
            row.tool_calls = local.execute_workflow(workflow, row.query)
            for metric in local.RECOMMENDED_METRICS:
                config = EvaluatorConfig(metric_id=metric, instance_id=metric, adapter=Adapter.TRACE,
                                         adapter_class="TraceJudge", scoring_type=ScoringType.BINARY)
                result = TraceJudge().evaluate(config, row)
                assert result.score == 1.0, (dataset["agent_ref"], row.query, metric, result.rationale)
            cases += 1
    assert cases == 24


def test_try_agent_api_uses_same_runtime_and_bounds_query(client, monkeypatch):
    from proofgrove.api.v1 import agents
    from proofgrove.evaluation.target.agent_runner import AgentRunOutput
    from proofgrove.settings import settings

    monkeypatch.setenv("PROOFGROVE_MODE", "local")
    monkeypatch.setattr(settings, "app_env", "dev")
    monkeypatch.setattr(settings, "evaluation_runtime", "local")
    monkeypatch.setattr(settings, "pod_namespace", "tenant-local-classroom")
    invoke = AsyncMock(return_value=AgentRunOutput(response="Generated model answer", invocation_id="fresh",
                                                 target_usage={"model": "current-default"}))
    monkeypatch.setattr(agents, "run_local_workflow", invoke)
    response = client.post("/agents/local/nova-refunds/invoke", json={"query": "Order 7734"})
    assert response.status_code == 200
    assert response.json()["response"] == "Generated model answer"
    assert response.json()["external_side_effects"] is False
    assert response.json()["model"] == "current-default"
    assert invoke.await_args.kwargs["target_endpoint"] == "local:nova-refunds"
    assert client.post("/agents/local/nova-refunds/invoke", json={"query": "x" * 16001}).status_code == 422
    assert invoke.await_count == 1
    monkeypatch.setattr(settings, "pod_namespace", "tenant-other")
    client.headers["x-evalai-tenant"] = "other"
    assert client.post("/agents/local/nova-refunds/invoke", json={"query": "Order 7734"}).status_code == 404
    assert invoke.await_count == 1
