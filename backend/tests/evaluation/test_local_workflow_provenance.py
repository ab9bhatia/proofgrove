"""Model selection and runtime identity are observed, not copied from launch."""
from unittest.mock import AsyncMock

import pytest

from proofgrove.evaluation import run_service
from proofgrove.evaluation.enums import ProvenanceStatus
from proofgrove.evaluation.models import EvaluationRow
from proofgrove.evaluation.readiness import observed_target_provenance
from proofgrove.evaluation.target.a2a_client import AgentInvocationError
from proofgrove.evaluation.target.local_workflows import TOOL_EVIDENCE_SOURCE, model_revision
from proofgrove.settings import Settings

MODEL = {"provider": "ollama", "model_id": "model-a", "endpoint": "http://127.0.0.1:11434/v1"}


def captured_row(model=MODEL):
    return EvaluationRow(
        row_id="one", query="Order 7734", response="Fresh response", from_agent=True,
        output_data={"response": "Fresh response", "response_source": "local_workflow_runtime"},
        tool_evidence_completion_attested=True, tool_evidence_provenance_status=ProvenanceStatus.ATTESTED,
        tool_evidence_source=TOOL_EVIDENCE_SOURCE,
        target_usage={"model": model["model_id"], "provider": model["provider"], "model_endpoint": model["endpoint"],
                      "local_agent_ref": "local:nova-refunds", "local_agent_revision": model_revision(model)},
    )


def observe(rows):
    return observed_target_provenance(response_source="agent", rows=rows,
        resolved_provenance={"identifier": "declared-identity", "revision": "declared-revision", "model": "declared-model"})


def test_observed_identity_comes_from_runtime_capture():
    observed = observe([captured_row(), captured_row()])
    assert observed["identifier"] == "local:nova-refunds"
    assert observed["revision"] == model_revision(MODEL)
    assert observed["model"] == "model-a"
    assert observed["provider"] == "ollama"
    assert observed["status"] == "attested"
    assert "A2A" not in observed["verification_source"]


@pytest.mark.parametrize("field,value", [
    ("local_agent_ref", "local:unknown"), ("local_agent_revision", "stale-revision"), ("model", None),
])
def test_missing_or_inconsistent_runtime_identity_is_not_attested(field, value):
    row = captured_row()
    row.target_usage[field] = value
    observed = observe([row])
    assert observed["status"] == "unavailable"
    assert observed["identifier"] is None
    assert observed["revision"] is None


def test_mixed_models_or_missing_capture_are_not_attested():
    rows = [captured_row(), captured_row({**MODEL, "model_id": "model-b"})]
    assert observe(rows)["status"] == "unavailable"
    rows[1] = captured_row()
    rows[1].tool_evidence_completion_attested = False
    assert observe(rows)["status"] == "unavailable"


async def test_default_model_drift_is_rejected_before_any_agent_invocation(monkeypatch):
    monkeypatch.setenv("PROOFGROVE_MODE", "local")
    settings = Settings(app_env="dev", evaluation_runtime="local", pod_namespace="tenant-local-classroom")
    monkeypatch.setattr(run_service, "settings", settings)
    monkeypatch.setattr(run_service, "resolve_local_model", AsyncMock(return_value={**MODEL, "model_id": "model-b"}))
    invoke = AsyncMock(side_effect=AssertionError("A drifted model must never run"))
    monkeypatch.setattr(run_service, "_run_agent_row", invoke)
    with pytest.raises(AgentInvocationError, match="model changed after readiness"):
        await run_service._run_agent_rows([captured_row()], agent_ref="local:nova-refunds",
                                          expected_local_revision=model_revision(MODEL))
    invoke.assert_not_awaited()


async def test_matching_model_revision_is_frozen_across_rows(monkeypatch):
    monkeypatch.setenv("PROOFGROVE_MODE", "local")
    settings = Settings(app_env="dev", evaluation_runtime="local", pod_namespace="tenant-local-classroom")
    monkeypatch.setattr(run_service, "settings", settings)
    resolve = AsyncMock(return_value=MODEL)
    monkeypatch.setattr(run_service, "resolve_local_model", resolve)
    invoke = AsyncMock()
    monkeypatch.setattr(run_service, "_run_agent_row", invoke)
    await run_service._run_agent_rows([captured_row(), captured_row()], agent_ref="local:nova-refunds",
                                      expected_local_revision=model_revision(MODEL))
    resolve.assert_awaited_once()
    assert invoke.await_count == 2
    assert all(call.kwargs["resolved_local_model"] is MODEL for call in invoke.await_args_list)
