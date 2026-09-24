"""Shared setup helpers for tracing-page tests: a project + a captured run row.

Covers the part every tracing test file builds identically (create a project,
create an experiment + one captured row, run it). Per-file specifics — trace
absence, parent span, invocation error, run naming — stay as keyword args so
each caller only supplies what its own tests actually vary.
"""

from uuid import uuid4


def create_project(client, tenant: str, project_id: str | None = None) -> str:
    project_id = project_id or f"project-{uuid4().hex[:8]}"
    response = client.post(
        "/platform/projects",
        json={
            "project_id": project_id,
            "tenant_id": tenant,
            "name": "Support agent",
            "system_type": "agent",
            "owner": "quality",
        },
    )
    assert response.status_code == 201, response.text
    return project_id


def run_with_captured_row(
    client,
    *,
    tenant: str,
    project_id: str,
    trace_id: str | None,
    parent_span_id: str | None = None,
    experiment_name: str = "Support quality",
    row_id: str | None = None,
    invocation_error: str | None = None,
    run_name: str | None = None,
):
    experiment_id = f"evaluation-{uuid4().hex[:8]}"
    row_id = row_id or f"case-{uuid4().hex[:8]}"
    experiment = {
        "experiment_id": experiment_id,
        "name": experiment_name,
        "dataset_version": "support.v1",
        "target_endpoint": "tenant/support-agent",
        "scenario": "llm_core",
        "tenant_id": tenant,
        "project_id": project_id,
        "tags": {"label": run_name} if run_name else {},
    }
    assert client.post("/evaluation/experiments", json=experiment).status_code == 201
    row = {
        "row_id": row_id,
        "query": "Where is my request?",
        "response": "It is in review.",
        "expected_response": "It is in review.",
        "trace_id": trace_id,
        "span_id": "span-1" if trace_id else None,
        "parent_span_id": parent_span_id,
        "trace_provider": "otel" if trace_id else None,
        "input_data": {"query": "Where is my request?"},
        "output_data": {"response": "It is in review."},
        "invocation_error": invocation_error,
    }
    assert client.post(f"/evaluation/experiments/{experiment_id}/rows", json=[row]).status_code == 201
    response = client.post("/evaluation/runs", json=experiment)
    assert response.status_code == 201, response.text
    return response.json()
