"""Tests for evaluation API routes."""

import asyncio
from urllib.parse import quote

from evalhub.evaluation.sample_data import SAMPLE_TENANT_ID
from evalhub.runs_worker import process_one_job

# Run/run-item read endpoints are tenant-scoped. Sample experiments carry a
# stable tenant (``SAMPLE_TENANT_ID``); runs created from them are read back with
# that same ``tenant_id`` query param.
TENANT = SAMPLE_TENANT_ID


def test_healthz(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200


def test_ready_ok(client):
    # P1-01: readiness reports the DB is reachable.
    resp = client.get("/health/ready")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ready"


def test_ready_returns_503_when_db_unavailable(client, monkeypatch):
    # P1-01: readiness fails closed when Postgres cannot be reached.
    def boom():
        raise RuntimeError("database unavailable")

    monkeypatch.setattr("evalhub.api.health.async_session", boom)
    resp = client.get("/health/ready")
    assert resp.status_code == 503
    assert resp.json()["status"] == "not ready"


def test_experiment_rows_no_sample_fallback_for_real_experiment(client):
    # P1-15: an unknown/real experiment with no rows returns [] rather than
    # silently substituting sample data.
    resp = client.get("/evaluation/experiments/not-a-sample-exp/rows")
    assert resp.status_code == 200
    assert resp.json() == []


def test_experiment_rows_sample_fallback_can_be_disabled(client):
    # P1-15: sample fallback is opt-out even for known sample IDs.
    resp = client.get("/evaluation/experiments/exp-llm-core-v1/rows?include_samples=false")
    assert resp.status_code == 200
    assert resp.json() == []


def test_invalid_threshold_override_rejected(client):
    # P1-13: out-of-range threshold overrides are rejected with 422.
    resp = client.post(
        "/evaluation/runs",
        json={
            "experiment_id": "exp-llm-core-v1",
            "name": "LLM Core",
            "dataset_version": "general_qa_v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "kpi_threshold_overrides": {"kpi.response_quality": {"pass": 1.5}},
        },
    )
    assert resp.status_code == 422


def test_invalid_safety_tolerance_rejected(client):
    # P1-13: out-of-range safety tolerance is rejected with 422.
    resp = client.post(
        "/evaluation/runs",
        json={
            "experiment_id": "exp-llm-core-v1",
            "name": "LLM Core",
            "dataset_version": "general_qa_v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "safety_defect_tolerance": 5.0,
        },
    )
    assert resp.status_code == 422


def test_run_persists_trigger_reason_and_lineage(client):
    # traceability: trigger_reason (query param) + lineage persist and round-trip.
    create = client.post(
        "/evaluation/runs?trigger_reason=ci&correlation_id=corr-xyz",
        json={
            "experiment_id": "exp-llm-core-v1",
            "name": "LLM Core",
            "dataset_version": "general_qa_v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "row_count": 1,
            "tenant_id": TENANT,
        },
    )
    assert create.status_code == 201
    data = create.json()
    assert data["trigger_reason"] == "ci"
    assert data["correlation_id"] == "corr-xyz"
    assert data["experiment_version_id"].startswith("exp-")
    assert data["lineage"]["judge_mode"] == "mock"

    run_id = data["run_id"]
    report = client.get(f"/evaluation/runs/{run_id}/report?tenant_id={TENANT}").json()
    assert report["trigger_reason"] == "ci"
    assert report["experiment_version_id"] == data["experiment_version_id"]
    assert report["prompt_version"]

    ci = client.get(f"/evaluation/runs/{run_id}/ci-callback?tenant_id={TENANT}").json()
    assert ci["trigger_reason"] == "ci"
    assert ci["experiment_version_id"] == data["experiment_version_id"]


def test_judge_config(client):
    resp = client.get("/evaluation/judge-config")
    assert resp.status_code == 200
    assert resp.json()["effective_mode"] == "mock"


def test_list_scenarios(client):
    resp = client.get("/evaluation/scenarios")
    assert resp.status_code == 200
    assert len(resp.json()) == 3


def test_list_sample_experiments(client):
    resp = client.get("/evaluation/sample-experiments")
    assert resp.status_code == 200
    assert len(resp.json()) == 3


def test_create_run(client):
    resp = client.post(
        "/evaluation/runs",
        json={
            "experiment_id": "exp-llm-core-v1",
            "name": "LLM Core",
            "dataset_version": "general_qa_v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "domain": "general",
            "market": "global",
            "judge_model": "gpt-4o-mini",
            "judge_temperature": 0.0,
            "has_ground_truth": True,
            "row_count": 2,
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["run_id"]
    assert data["verdict_status"] == "inconclusive"
    assert data["overall_gate"] is None
    simulated = [result for result in data["metric_results"] if result["executed_scorer"] == "mock"]
    assert simulated
    assert all(result["unscored_reason"] == "simulated" for result in simulated)
    deterministic = [result for result in data["metric_results"] if result["executed_scorer"] == "deterministic"]
    assert deterministic
    assert all(result["unscored_reason"] != "simulated" for result in deterministic)


def test_run_persisted(client):
    create = client.post(
        "/evaluation/runs",
        json={
            "experiment_id": "exp-rag-v1",
            "name": "RAG",
            "dataset_version": "doc_qa_v1",
            "target_endpoint": "https://example.com",
            "scenario": "rag",
            "judge_model": "gpt-4o-mini",
            "judge_temperature": 0.0,
            "has_ground_truth": True,
            "row_count": 1,
            "tenant_id": TENANT,
        },
    )
    run_id = create.json()["run_id"]
    resp = client.get(f"/evaluation/runs/{run_id}?tenant_id={TENANT}")
    assert resp.status_code == 200
    assert resp.json()["run_id"] == run_id


def test_run_item_list_and_detail_endpoints(client):
    create = client.post(
        "/evaluation/runs",
        json={
            "experiment_id": "exp-llm-core-v1",
            "name": "LLM item evidence",
            "dataset_version": "general_qa_v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "row_count": 2,
            "tenant_id": TENANT,
        },
    )
    assert create.status_code == 201, create.text
    run_id = create.json()["run_id"]

    listing = client.get(f"/evaluation/runs/{run_id}/items?tenant_id={TENANT}")
    assert listing.status_code == 200
    items = listing.json()
    assert [item["example_id"] for item in items] == [
        "llm-001",
        "llm-002",
        "llm-003",
    ]
    assert [item["sequence_position"] for item in items] == [0, 1, 2]
    assert items[0]["query"] == "What is the capital of France?"
    assert all(item["capture_state"] == "complete" for item in items)

    detail = client.get(f"/evaluation/runs/{run_id}/items/llm-001?tenant_id={TENANT}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["input"] == {"query": "What is the capital of France?"}
    assert body["output"] == {"response": "The capital of France is Paris."}
    assert body["expected"] == {"response": "Paris"}
    assert len(body["scorer_results"]) == items[0]["metric_count"]
    assert body["scorer_results"][0]["evaluator_id"]
    assert body["scorer_results"][0]["evaluator_version"]
    assert body["evidence_ref"] == (f"evidence-pack://{run_id}/items/llm-001")
    assert body["evidence_policy"] == {
        "redaction_enabled": True,
        "max_persisted_string_size": 20000,
        "retention_policy": "stored_with_run_lifecycle",
    }

    missing = client.get(f"/evaluation/runs/{run_id}/items/missing?tenant_id={TENANT}")
    assert missing.status_code == 404


def test_stored_experiment_run_item_preserves_evidence_and_slash_id(client):
    experiment_id = "structured-evidence-route"
    experiment = {
        "experiment_id": experiment_id,
        "name": "Structured evidence route",
        "dataset_version": "evidence.v1",
        "target_endpoint": "tenant/evidence-agent",
        "scenario": "llm_core",
        "judge_model": "mock",
        "tenant_id": TENANT,
    }
    assert client.post("/evaluation/experiments", json=experiment).status_code == 201

    row_id = "folder/row 1"
    row = {
        "row_id": row_id,
        "query": "Should this be approved?",
        "response": "Approve after verification.",
        "expected_response": "Approve with checks.",
        "input_data": {"messages": [{"role": "user", "content": "Should this be approved?"}]},
        "output_data": {
            "response": "Approve after verification.",
            "citations": ["policy-7"],
        },
        "expected_data": {
            "answer": "Approve with checks.",
            "rubric": "mention verification",
        },
        "retrieval_snippets": ["Policy 7 requires verification."],
        "expected_tools": ["policy_search"],
        "tool_calls": [
            {
                "name": "policy_search",
                "args": {"policy": 7},
                "output": "Policy 7 requires verification.",
            }
        ],
        "invocation_id": "invocation-route",
        "kagent_session_id": "session-route",
        "latency_ms": 456,
        "target_usage": {"total_tokens": 20},
        "invocation_error": "target warning",
        "trace_id": "trace-route",
        "span_id": "span-route",
    }
    add_rows = client.post(
        f"/evaluation/experiments/{experiment_id}/rows",
        json=[row],
    )
    assert add_rows.status_code == 201, add_rows.text

    create_run = client.post(
        "/evaluation/runs",
        json=experiment,
    )
    assert create_run.status_code == 201, create_run.text
    run_id = create_run.json()["run_id"]

    listing = client.get(f"/evaluation/runs/{run_id}/items?tenant_id={TENANT}")
    assert listing.status_code == 200
    assert listing.json()[0]["query"] == "Should this be approved?"

    encoded_id = quote(row_id, safe="")
    detail = client.get(f"/evaluation/runs/{run_id}/items/{encoded_id}?tenant_id={TENANT}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["example_id"] == row_id
    assert body["input"] == row["input_data"]
    assert body["output"] == row["output_data"]
    assert body["expected"] == row["expected_data"]
    assert body["retrieval_snippets"] == row["retrieval_snippets"]
    assert body["tool_calls"] == [
        {
            **row["tool_calls"][0],
            "result_captured": True,
        }
    ]
    assert body["execution"] == {
        "invocation_id": "invocation-route",
        "kagent_session_id": "session-route",
        "latency_ms": 456,
        "usage": {"total_tokens": 20},
        "invocation_error": "target warning",
        "trace_id": "trace-route",
        "span_id": "span-route",
        "parent_span_id": None,
        "trace_provider": None,
        "trace_completion_attested": False,
        "model_usage_completion_attested": False,
        "lifecycle_completion_attested": False,
        "tool_evidence_completion_attested": False,
        "tool_evidence_provenance_status": "unavailable",
        "tool_evidence_source": None,
    }
    assert body["evidence_ref"].endswith("/items/folder%2Frow%201")


def test_rescore_requires_explicit_source_and_stays_diagnostic(client):
    source = client.post(
        "/evaluation/runs",
        json={
            "experiment_id": "exp-llm-core-v1",
            "name": "LLM Core",
            "dataset_version": "general_qa_v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "row_count": 1,
            "tenant_id": TENANT,
        },
    )
    assert source.status_code == 201, source.text
    source_run = source.json()
    experiment_id = source_run["experiment"]["experiment_id"]

    ambiguous = client.post(f"/evaluation/experiments/{experiment_id}/runs", json={})
    assert ambiguous.status_code == 422
    assert "never selected implicitly" in ambiguous.json()["detail"]

    queued = client.post(
        f"/evaluation/experiments/{experiment_id}/rescores",
        json={"source_run_id": source_run["run_id"], "created_by": "reviewer"},
    )
    assert queued.status_code == 202, queued.text
    assert queued.json()["target_invoked"] is False

    run_id = queued.json()["run_id"]
    assert asyncio.run(process_one_job()) is True
    response = client.get(f"/evaluation/runs/{run_id}?tenant_id={TENANT}")
    assert response.status_code == 200, response.text
    result = response.json()
    assert "metric_results" in result
    assert result["diagnostic_only"] is True
    assert result["verdict_status"] is None
    assert result["overall_gate"] is None
    assert result["lineage"]["source_run_id"] == source_run["run_id"]
    assert result["lineage"]["rescore_configuration"]["target_invoked"] is False


def test_experiment_row_rejects_blank_and_oversized_ids(client):
    base = {"query": "q", "response": "a"}
    blank = client.post(
        "/evaluation/experiments/row-id-validation/rows",
        json=[{"row_id": "   ", **base}],
    )
    oversized = client.post(
        "/evaluation/experiments/row-id-validation/rows",
        json=[{"row_id": "x" * 129, **base}],
    )
    assert blank.status_code == 422
    assert oversized.status_code == 422


def test_get_report(client):
    create = client.post(
        "/evaluation/runs",
        json={
            "experiment_id": "exp-llm-core-v1",
            "name": "LLM",
            "dataset_version": "v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "judge_model": "gpt-4o-mini",
            "has_ground_truth": True,
            "row_count": 1,
            "tenant_id": TENANT,
        },
    )
    run_id = create.json()["run_id"]
    resp = client.get(f"/evaluation/runs/{run_id}/report?tenant_id={TENANT}")
    assert resp.status_code == 200
    assert resp.json()["report_version"] == "1.0"
