"""The local executor's evidence survives the evaluation/report boundary."""
from unittest.mock import AsyncMock

import pytest

from proofgrove.api.v1 import evaluation
from proofgrove.evaluation import run_service
from proofgrove.evaluation.adapters.trace_adapter import TraceJudge
from proofgrove.evaluation.enums import Adapter, EvaluationScope, ProvenanceStatus, ScoringType
from proofgrove.evaluation.models import EvaluationRow, EvaluatorConfig, ToolCall
from proofgrove.evaluation.target.agent_runner import AgentRunOutput
from proofgrove.evaluation.target.local_workflows import TOOL_EVIDENCE_SOURCE
from proofgrove.settings import Settings


@pytest.fixture
def local_runtime(monkeypatch):
    monkeypatch.setenv("PROOFGROVE_MODE", "local")
    cfg = Settings(app_env="dev", evaluation_runtime="local", pod_namespace="tenant-local-classroom",
                   trace_archive_enabled=False, tool_evidence_completion_manifest_available=False)
    monkeypatch.setattr(run_service, "settings", cfg)
    monkeypatch.setattr(evaluation, "settings", cfg)
    return cfg


def test_capture_scope_is_target_specific(local_runtime):
    def available(reference):
        return {row["scope"]: row["available"] for row in evaluation._scope_options(
            evaluation.DatasetRunRequest(response_source="agent", agent=reference))}
    assert available("local:nova-refunds") == {
        "final_response": True, "tool_interactions": True, "full_execution": False,
    }
    for ref in ("external:catalog-id", "local:unknown", "tenant-local-classroom/agent"):
        assert available(ref)["tool_interactions"] is False


def test_production_cannot_enable_builtin_capture(local_runtime):
    local_runtime.app_env = "prod"
    options = evaluation._scope_options(evaluation.DatasetRunRequest(response_source="agent", agent="local:nova-refunds"))
    assert next(o for o in options if o["scope"] == "tool_interactions")["available"] is False


@pytest.mark.parametrize("scope", [EvaluationScope.TOOL_INTERACTIONS, EvaluationScope.FINAL_RESPONSE])
async def test_fresh_local_evidence_and_model_are_preserved(monkeypatch, local_runtime, scope):
    model = {"provider": "ollama", "model_id": "test-model", "endpoint": "http://127.0.0.1:11434/v1"}
    resolve = AsyncMock(return_value=model)
    monkeypatch.setattr(run_service, "resolve_local_model", resolve)
    archive = AsyncMock(side_effect=AssertionError("Local tools must not wait for a production archive"))
    monkeypatch.setattr(run_service, "hydrate_row_from_archive", archive)
    calls = []

    async def invoke(**kwargs):
        calls.append(kwargs)
        return AgentRunOutput(response="Fresh answer for " + kwargs["query"], invocation_id=kwargs["invocation_id"],
            tool_calls=[ToolCall(name="lookup_order", args={"order_id": kwargs["query"]}, output={"found": True})],
            tool_evidence_completion_attested=True, tool_evidence_provenance_status=ProvenanceStatus.ATTESTED,
            tool_evidence_source=TOOL_EVIDENCE_SOURCE, target_usage={"prompt_tokens": 7, "completion_tokens": 5})

    monkeypatch.setattr(run_service, "run_agent_target", invoke)
    rows = [EvaluationRow(row_id=str(i), query=str(i), response="old", from_agent=True,
                         trace_id="old-source-trace", expected_tools=["lookup_order"],
                         expected_data={"expected_tool_calls": [{"name": "lookup_order", "args": {"order_id": "0"}}]})
            for i in range(2)]
    await run_service._run_agent_rows(rows, agent_ref="local:nova-refunds", parallel_requests=2, evaluation_scope=scope)
    resolve.assert_awaited_once()
    archive.assert_not_awaited()
    assert all(c["resolved_local_model"] is model for c in calls)
    assert rows[0].invocation_id != rows[1].invocation_id
    assert all(r.trace_id is None for r in rows)
    assert all(r.tool_evidence_completion_attested for r in rows)
    assert all(r.output_data["response_source"] == "local_workflow_runtime" for r in rows)
    assert rows[1].response == "Fresh answer for 1"
    assert rows[1].target_usage["completion_tokens"] == 5
    assert bool(rows[0].context) is (scope == EvaluationScope.TOOL_INTERACTIONS)
    config = EvaluatorConfig(metric_id="agent.tool_input_accuracy", instance_id="input-check", adapter=Adapter.TRACE,
                             adapter_class="trace.tool_input_accuracy", scoring_type=ScoringType.BINARY)
    # The metric uses saved observed arguments, never the expected answer as output.
    assert TraceJudge().evaluate(config, rows[0]).score == 1
    assert TraceJudge().evaluate(config, rows[1]).score == 0


async def test_incomplete_local_capture_cannot_claim_success(monkeypatch, local_runtime):
    monkeypatch.setattr(run_service, "resolve_local_model", AsyncMock(return_value={"model_id": "test"}))
    monkeypatch.setattr(run_service, "run_agent_target", AsyncMock(return_value=AgentRunOutput(response="A response")))
    with pytest.raises(Exception, match="did not complete its tool evidence capture"):
        await run_service._run_agent_rows([EvaluationRow(row_id="1", query="test", response="")], agent_ref="local:nova-refunds")


async def test_missing_fixture_response_is_gradeable_not_transport_failure(monkeypatch, local_runtime):
    monkeypatch.setattr(run_service, "resolve_local_model", AsyncMock(return_value={"model_id": "test"}))
    monkeypatch.setattr(run_service, "run_agent_target", AsyncMock(return_value=AgentRunOutput(
        response="I could not find the order. Please confirm its number.",
        tool_calls=[ToolCall(name="lookup_order", args={"order_id": "9999"}, output={"found": False})],
        tool_evidence_completion_attested=True, tool_evidence_provenance_status=ProvenanceStatus.ATTESTED,
        tool_evidence_source=TOOL_EVIDENCE_SOURCE)))
    row = EvaluationRow(row_id="missing", query="order 9999", response="", from_agent=True)
    await run_service._run_agent_rows([row], agent_ref="local:nova-refunds", evaluation_scope=EvaluationScope.TOOL_INTERACTIONS)
    assert row.invocation_error is None
    assert "Please confirm" in row.response
    assert row.tool_calls[0].output == {"found": False}
