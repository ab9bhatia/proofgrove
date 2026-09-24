"""User-recoverable run-creation errors must be structured, never plain strings.

The UI renders ``{code, field, message, recovery}`` field-anchored errors; a
plain-string ``detail`` collapses to a generic banner. These tests pin the
converted dataset-run / run-creation paths to the structured shape.
"""

import logging

import pytest

from evalhub.platform.resolver import ContractResolutionError

TENANT = "tenant-structured-errors"


def _experiment_body(experiment_id: str) -> dict:
    return {
        "experiment_id": experiment_id,
        "name": "no rows",
        "dataset_version": "ds.v1",
        "target_endpoint": "https://example.test/agent",
        "scenario": "llm_core",
    }


def test_create_run_without_rows_is_a_structured_422(client):
    response = client.post("/evaluation/runs", json=_experiment_body("exp-empty-structured"))
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "evaluation_rows_missing"
    assert detail["field"] == "experiment_id"
    assert "No evaluation rows" in detail["message"]
    assert detail["recovery"]


def test_contract_resolution_error_is_a_structured_422(client, monkeypatch):
    def _boom(**kwargs):
        raise ContractResolutionError(
            "tool_interactions evidence scope requires an agent target"
        )

    monkeypatch.setattr(
        "evalhub.api.v1.evaluation.resolve_scoring_configuration", _boom
    )
    # A non-agent source at a tool-requiring depth resolves scoring before any
    # dataset access, so the mapped error surfaces without a registry fixture.
    response = client.post(
        "/evaluation/runs/from-dataset/any-ds/readiness",
        json={"response_source": "llm", "evaluation_scope": "full_execution"},
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "scoring_contract_unresolvable"
    assert detail["field"] == "active_metrics"
    assert "agent target" in detail["message"]
    assert detail["recovery"]



@pytest.mark.parametrize("failure", ["enqueue", "submit", "read"])
def test_infrastructure_exception_details_stay_out_of_http_responses(monkeypatch, failure, caplog):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from evalhub.api.dependencies import get_evaluation_store, get_registry_service
    from evalhub.api.v1 import evaluation
    from evalhub.evaluation.enums import EvaluationScope, EvidenceReadiness, Scenario
    from evalhub.evaluation.models import EvidenceReadinessResult
    from evalhub.settings import settings

    monkeypatch.setattr(settings, "platform_auth_required", False)
    monkeypatch.setattr(settings, "evaluation_runtime", "temporal" if failure == "submit" else "local")
    private_error = RuntimeError("private-prompt-and-driver-credentials")
    store = SimpleNamespace(
        create_run_job=AsyncMock(side_effect=private_error if failure == "enqueue" else None, return_value="run"),
        get_run_job=AsyncMock(side_effect=private_error if failure == "read" else None, return_value=object()),
    )
    readiness = EvidenceReadinessResult(status=EvidenceReadiness.READY, evaluation_scope=EvaluationScope.FINAL_RESPONSE)
    scoring = evaluation._resolve_dataset_run_configuration(evaluation.DatasetRunRequest(), Scenario.LLM_CORE)
    monkeypatch.setattr(evaluation, "_dataset_readiness", AsyncMock(return_value=(
        SimpleNamespace(version_number=1), [], Scenario.LLM_CORE, readiness, scoring,
    )))
    if failure == "submit":
        from evalhub.orchestrator import temporal
        monkeypatch.setattr(temporal, "submit_dataset_run", AsyncMock(side_effect=private_error))
    test_app = FastAPI()
    test_app.include_router(evaluation.router)
    test_app.dependency_overrides[get_evaluation_store] = lambda: store
    test_app.dependency_overrides[get_registry_service] = object
    with TestClient(test_app, headers={"x-evalai-tenant": TENANT}) as client:
        response = (
            client.get("/evaluation/runs/run", params={"tenant_id": TENANT})
            if failure == "read"
            else client.post("/evaluation/runs/from-dataset/dataset", json={})
        )
    assert response.status_code == (202 if failure == "submit" else 500), response.text
    assert "private-prompt-and-driver-credentials" not in response.text
    # A traceback would carry the exception message -- a driver error's
    # statement and bound parameters, a run's prompt -- into shared logs.
    failures = [record for record in caplog.records if record.name == "evalhub.api.v1.evaluation" and record.levelno >= logging.ERROR]
    assert failures, "the failure must still be logged"
    for record in failures:
        assert record.exc_info is None
        assert "private-prompt-and-driver-credentials" not in str(vars(record))


async def test_rescore_submits_the_committed_job_to_temporal(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from starlette.requests import Request

    from evalhub.api.v1 import evaluation
    from evalhub.orchestrator import temporal
    from evalhub.settings import settings

    monkeypatch.setattr(settings, "evaluation_runtime", "temporal")
    submit = AsyncMock()
    monkeypatch.setattr(temporal, "submit_dataset_run", submit)
    source = SimpleNamespace(run_id="source", experiment=SimpleNamespace(experiment_id="exp", tenant_id=TENANT))
    store = AsyncMock()
    store.get_run.return_value = source
    store.create_rescore_job.return_value = "new-job"
    request = Request({"type": "http", "headers": [(b"x-evalai-tenant", TENANT.encode())]})
    result = await evaluation._enqueue_experiment_rescore("exp", evaluation.ExperimentRunRequest(source_run_id="source"), request, store)
    assert result["run_id"] == "new-job" and result["status"] == "pending"
    submit.assert_awaited_once_with("new-job")


def test_historical_error_text_is_not_treated_as_safe():
    from evalhub.api.v1.evaluation import _client_error_message
    assert "OPAQUE_PRIVATE_TEXT" not in _client_error_message("OPAQUE_PRIVATE_TEXT")
    assert _client_error_message(None) is None


def test_synchronous_run_checks_row_cap_before_engine_execution(client, monkeypatch):
    from evalhub.api.v1 import evaluation
    from evalhub.evaluation.engine import EvaluationEngine
    monkeypatch.setattr(evaluation, "MAX_ROWS_PER_DATASET", 1)
    def unexpected(*args, **kwargs):
        raise AssertionError("oversized synchronous run reached the engine")
    monkeypatch.setattr(EvaluationEngine, "execute", unexpected)
    response = client.post("/evaluation/runs", json=_experiment_body("exp-llm-core-v1"))
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "evaluation_rows_exceed_limit"
