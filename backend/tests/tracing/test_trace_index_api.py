"""Index-served /tracing pages: honest states, filters, Unassigned, spans page.

Uses a file-backed SQLite database so the API (running on the TestClient's
portal event loop) and the direct worker-tick calls (running on the test's own
loop) safely share state through separate connections.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

import evalhub.api.dependencies as api_dependencies
import evalhub.main as main_module
from evalhub.db.session import async_session_factory
from evalhub.evaluation.models import ArchivedTraceSpan, RunItemTraceEvidence
from evalhub.settings import settings
from evalhub.tracing.index_worker import run_trace_index_tick
from tests.tracing import _helpers as tracing_helpers

TENANT = "tenant-index-api"
NOW = datetime(2026, 8, 23, 12, 0, 0, tzinfo=UTC)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{tmp_path}/eval-hub-index.db")
    # `main` and `api.dependencies` bind the session factory at import time (to
    # the shared in-memory URL); rebind them to the per-test file database so
    # the app (portal loop) and the worker tick (test loop) share state through
    # separate connections instead of one loop-bound in-memory connection.
    factory = async_session_factory()
    monkeypatch.setattr(main_module, "async_session", factory)
    monkeypatch.setattr(api_dependencies, "async_session", factory)
    with TestClient(main_module.app, headers={"x-evalai-tenant": TENANT}) as test_client:
        yield test_client


class FakeGateway:
    def __init__(self, evidence=None, archived_ids=None):
        self.evidence = evidence or {}
        self.archived_ids = archived_ids or []

    async def find(self, *, trace_id, tenant, started_at=None, completed_at=None):
        return self.evidence.get(trace_id, RunItemTraceEvidence(state="not_found", trace_id=trace_id))

    async def list_archived_trace_ids(self, tenant, *, limit):
        return self.archived_ids[:limit]


def _span(trace_id, span_id, *, parent=None, name="agent.run", kind=2, start_ns, end_ns, error=False, attributes=None):
    return ArchivedTraceSpan(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent,
        name=name,
        kind=kind,
        start_time_unix_nano=str(start_ns),
        end_time_unix_nano=str(end_ns),
        duration_ms=(end_ns - start_ns) / 1_000_000,
        status={"code": 2} if error else {"code": 1},
        attributes=attributes or {},
    )


def _evidence(trace_id, *, error=False, name="agent.run", start_ns=1_766_000_000_000_000_000):
    spans = [
        # Carries an agent operation like a real root span does — an
        # attribute-less span is transport, and the listing excludes those.
        _span(
            trace_id,
            "root",
            name=name,
            start_ns=start_ns,
            end_ns=start_ns + 2_000_000_000,
            attributes={"openinference.span.kind": "AGENT", "gen_ai.operation.name": "invoke_agent"},
        ),
        _span(
            trace_id,
            "child",
            parent="root",
            name="llm.call",
            kind=3,
            start_ns=start_ns + 100_000_000,
            end_ns=start_ns + 900_000_000,
            error=error,
            attributes={"openinference.span.kind": "LLM", "gen_ai.request.model": "gpt-4o-mini"},
        ),
    ]
    return RunItemTraceEvidence(state="available", trace_id=trace_id, spans=spans)


def _create_project(client, project_id=None):
    return tracing_helpers.create_project(client, TENANT, project_id)


def _run_with_captured_row(client, *, project_id, trace_id, invocation_error=None, run_name=None):
    return tracing_helpers.run_with_captured_row(
        client,
        tenant=TENANT,
        project_id=project_id,
        trace_id=trace_id,
        invocation_error=invocation_error,
        run_name=run_name,
    )


async def _tick(gateway):
    return await run_trace_index_tick(tenant=TENANT, gateway=gateway, now=NOW)


async def test_traces_page_serves_from_index_with_lifecycle_fields(client, monkeypatch):
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    project_id = _create_project(client)
    _run_with_captured_row(
        client,
        project_id=project_id,
        trace_id="trace-indexed",
        run_name="August baseline",
    )
    await _tick(FakeGateway(evidence={"trace-indexed": _evidence("trace-indexed", error=True)}))

    response = client.get(f"/tracing/projects/{project_id}/traces/page?tenant_id={TENANT}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["source"] == "index"
    assert body["total"] == 1
    item = body["items"][0]
    assert item["trace_id"] == "trace-indexed"
    assert item["lifecycle_state"] == "archive_confirmed"
    assert item["span_count"] == 2
    assert item["error_count"] == 1
    assert item["root_span_name"] == "agent.run"
    assert item["model"] == "gpt-4o-mini"
    # Evaluation linkage survives on the index path.
    assert item["is_evaluated"] is True
    assert item["evaluation_status"] == "evaluated"
    assert item["run_id"]
    assert item["run_name"] == "August baseline"
    assert item["run_number"] == 1
    assert item["evaluation_name"] == "Support quality"
    assert item["example_id"]


async def test_traces_page_reports_honest_unconfirmed_states(client, monkeypatch):
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    project_id = _create_project(client)
    _run_with_captured_row(client, project_id=project_id, trace_id="trace-waiting")
    await _tick(FakeGateway())  # archive checked, nothing there

    body = client.get(f"/tracing/projects/{project_id}/traces/page?tenant_id={TENANT}").json()
    item = body["items"][0]
    assert item["lifecycle_state"] == "pending_export"
    assert item["span_count"] is None  # never fabricated
    assert item["error_count"] is None
    assert item["root_span_name"] is None


async def test_hide_trace_preserves_row_and_default_list_excludes_it(client, monkeypatch):
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    project_id = _create_project(client)
    _run_with_captured_row(client, project_id=project_id, trace_id="trace-hidden")
    await _tick(FakeGateway(evidence={"trace-hidden": _evidence("trace-hidden")}))

    hidden = client.post(f"/tracing/projects/{project_id}/traces/trace-hidden/hide?tenant_id={TENANT}")
    assert hidden.status_code == 200, hidden.text
    assert hidden.json() == {"trace_id": "trace-hidden", "hidden": True}

    visible = client.get(f"/tracing/projects/{project_id}/traces/page?tenant_id={TENANT}").json()
    assert visible["total"] == 0
    assert visible["hidden_count"] == 1
    assert visible["items"] == []

    with_hidden = client.get(f"/tracing/projects/{project_id}/traces/page?tenant_id={TENANT}&include_hidden=true").json()
    assert with_hidden["total"] == 1
    assert with_hidden["hidden_count"] == 1
    assert with_hidden["items"][0]["hidden"] is True

    restored = client.post(f"/tracing/projects/{project_id}/traces/trace-hidden/unhide?tenant_id={TENANT}")
    assert restored.status_code == 200
    assert restored.json()["hidden"] is False
    assert client.get(f"/tracing/projects/{project_id}/traces/page?tenant_id={TENANT}").json()["total"] == 1


def test_archived_trace_project_remains_listed(client):
    project_id = _create_project(client)
    archived = client.post(f"/platform/projects/{project_id}/archive?tenant_id={TENANT}")
    assert archived.status_code == 200

    projects = client.get(f"/tracing/projects?tenant_id={TENANT}").json()
    project = next(item for item in projects if item["project_id"] == project_id)
    assert project["status"] == "archived"


def test_traces_page_falls_back_to_projection_when_index_is_empty(client):
    project_id = _create_project(client)
    run = _run_with_captured_row(client, project_id=project_id, trace_id="trace-legacy")

    body = client.get(f"/tracing/projects/{project_id}/traces/page?tenant_id={TENANT}").json()
    assert body["source"] == "projection"
    assert body["total"] == 1
    assert body["items"][0]["trace_id"] == "trace-legacy"
    assert body["items"][0]["run_id"] == run["run_id"]


async def test_unassigned_pseudo_project_lists_non_evaluation_traces(client, monkeypatch):
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    project_id = _create_project(client)  # a real project exists but the trace is not bound
    await _tick(
        FakeGateway(
            evidence={"prod-orphan": _evidence("prod-orphan", name="cron.job")},
            archived_ids=["prod-orphan"],
        )
    )

    projects = client.get(f"/tracing/projects?tenant_id={TENANT}").json()
    unassigned = next(p for p in projects if p["project_id"] == "unassigned")
    assert unassigned["trace_count"] == 1
    assert unassigned["name"] == "Unassigned"

    body = client.get(f"/tracing/projects/unassigned/traces/page?tenant_id={TENANT}").json()
    assert body["source"] == "index"
    assert body["total"] == 1
    item = body["items"][0]
    assert item["trace_id"] == "prod-orphan"
    assert item["is_evaluated"] is False
    assert item["evaluation_status"] == "not_evaluated"
    assert item["run_id"] is None
    assert item["root_span_name"] == "cron.job"

    from evalhub.api.v1 import tracing

    monkeypatch.setattr(tracing, "TraceArchiveReader", lambda _: FakeGateway({"prod-orphan": _evidence("prod-orphan")}))
    detail_path = "/tracing/projects/unassigned/traces/prod-orphan"
    summary = client.get(f"{detail_path}/summary?tenant_id={TENANT}")
    assert summary.status_code == 200, summary.text
    assert summary.json()["run_id"] is None
    assert client.get(f"/tracing/projects/{project_id}/traces/prod-orphan/summary?tenant_id={TENANT}").status_code == 404
    spans = client.get(f"{detail_path}/spans?tenant_id={TENANT}")
    assert spans.status_code == 200, spans.text
    assert len(spans.json()["spans"]) == 2
    monkeypatch.setattr(tracing, "TraceArchiveReader", lambda _: FakeGateway({
        "prod-orphan": RunItemTraceEvidence(state="pending", message="Trace export may still be in flight."),
    }))
    missing_spans = client.get(f"{detail_path}/spans?tenant_id={TENANT}")
    assert missing_spans.status_code == 200
    assert missing_spans.json()["spans"] == []
    assert missing_spans.json()["lifecycle_message"] == "No archived spans matched this trace ID."
    assert client.get(f"{detail_path}/summary?tenant_id=tenant-other").status_code == 403
    assert client.get(f"/tracing/projects/unassigned/traces/missing/summary?tenant_id={TENANT}").status_code == 404

    # Tenant scoping: another tenant sees no unassigned traces.
    # Asking for another tenant's traces is refused outright, rather than
    # answered with an empty page.
    other = client.get("/tracing/projects/unassigned/traces/page?tenant_id=tenant-other")
    assert other.status_code == 403

    # And acting AS that tenant, within its own scope, none of this tenant's
    # traces are visible — the store-level isolation, not just the guard.
    client.headers["x-evalai-tenant"] = "tenant-other"
    try:
        as_other = client.get("/tracing/projects/unassigned/traces/page?tenant_id=tenant-other")
        assert as_other.status_code == 200
        assert as_other.json()["total"] == 0
        assert client.get(f"{detail_path}/summary?tenant_id=tenant-other").status_code == 404
        assert client.get(f"{detail_path}/spans?tenant_id=tenant-other").status_code == 404
    finally:
        client.headers["x-evalai-tenant"] = TENANT


async def test_index_page_filters_and_cursor_pagination(client, monkeypatch):
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    project_id = _create_project(client)
    evidence = {}
    run_ids = {}
    base = 1_766_000_000_000_000_000
    for i in range(5):
        trace_id = f"trace-filter-{i}"
        run = _run_with_captured_row(client, project_id=project_id, trace_id=trace_id)
        run_ids[trace_id] = run["run_id"]
        evidence[trace_id] = _evidence(
            trace_id,
            error=(i == 0),
            name="agent.run" if i < 4 else "fallback.run",
            start_ns=base + i * 60_000_000_000,
        )
    monkeypatch.setattr(settings, "trace_index_confirm_batch_size", 10)
    await _tick(FakeGateway(evidence=evidence))

    # Cursor walk covers each trace exactly once.
    seen, cursor, pages = [], None, 0
    while True:
        pages += 1
        assert pages <= 10
        url = f"/tracing/projects/{project_id}/traces/page?tenant_id={TENANT}&limit=2"
        if cursor:
            url += f"&cursor={cursor}"
        body = client.get(url).json()
        assert body["source"] == "index"
        assert body["total"] == 5
        seen.extend(item["trace_id"] for item in body["items"])
        cursor = body["next_cursor"]
        if not body["has_more"]:
            break
    assert sorted(seen) == sorted(evidence)
    assert len(seen) == len(set(seen))

    # Status filter: archived span errors only.
    errored = client.get(f"/tracing/projects/{project_id}/traces/page?tenant_id={TENANT}&status=error").json()
    assert errored["total"] == 1
    assert errored["items"][0]["trace_id"] == "trace-filter-0"

    # Search filter over root span name.
    searched = client.get(f"/tracing/projects/{project_id}/traces/page?tenant_id={TENANT}&search=fallback").json()
    assert searched["total"] == 1
    assert searched["items"][0]["trace_id"] == "trace-filter-4"

    # Exact run filter resolves through the eval-item association while the
    # page itself remains served from the collector-confirmed trace index.
    selected_run = client.get(f"/tracing/projects/{project_id}/traces/page?tenant_id={TENANT}&run_id={run_ids['trace-filter-2']}").json()
    assert selected_run["source"] == "index"
    assert selected_run["total"] == 1
    assert selected_run["items"][0]["trace_id"] == "trace-filter-2"
    assert selected_run["items"][0]["run_id"] == run_ids["trace-filter-2"]


async def test_spans_page_serves_indexed_span_summaries(client, monkeypatch):
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    project_id = _create_project(client)
    _run_with_captured_row(
        client,
        project_id=project_id,
        trace_id="trace-spans",
        run_name="August baseline",
    )
    await _tick(FakeGateway(evidence={"trace-spans": _evidence("trace-spans", error=True)}))

    response = client.get(f"/tracing/projects/{project_id}/spans/page?tenant_id={TENANT}&limit=1")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 2
    assert body["has_more"] is True
    first = body["items"][0]
    assert set(first) >= {
        "trace_id",
        "run_id",
        "run_name",
        "run_number",
        "evaluation_name",
        "span_id",
        "name",
        "kind",
        "semantic_kind",
        "input_preview",
        "output_preview",
        "llm_token_count_prompt",
        "llm_token_count_completion",
        "estimated_cost_usd",
        "started_at",
        "duration_ms",
        "status",
    }
    assert first["run_id"]
    assert first["run_name"] == "August baseline"
    assert first["run_number"] == 1
    assert first["evaluation_name"] == "Support quality"

    second_page = client.get(f"/tracing/projects/{project_id}/spans/page?tenant_id={TENANT}&limit=1&cursor={body['next_cursor']}").json()
    assert second_page["has_more"] is False
    span_ids = {first["span_id"], second_page["items"][0]["span_id"]}
    assert span_ids == {"root", "child"}

    errored = client.get(f"/tracing/projects/{project_id}/spans/page?tenant_id={TENANT}&status=error").json()
    assert errored["total"] == 1
    assert errored["items"][0]["span_id"] == "child"
    assert errored["items"][0]["status"] == "error"


async def test_spans_page_lists_model_work_and_omits_transport_spans(client, monkeypatch):
    """Archived traces run heavily to plumbing; the listing must not.

    The count has to be filtered too — narrowing a page at a time would report
    a total the page can never reach.
    """
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    project_id = _create_project(client)
    _run_with_captured_row(client, project_id=project_id, trace_id="trace-noise")
    start_ns = 1_766_000_000_000_000_000
    noisy = RunItemTraceEvidence(
        state="available",
        trace_id="trace-noise",
        spans=[
            _span("trace-noise", "root", name="POST /", start_ns=start_ns, end_ns=start_ns + 2_000_000_000),
            _span(
                "trace-noise",
                "send",
                parent="root",
                name="POST / http send",
                start_ns=start_ns + 10_000_000,
                end_ns=start_ns + 20_000_000,
                attributes={"asgi.event.type": "http.response.body"},
            ),
            _span(
                "trace-noise",
                "queue",
                parent="root",
                name="a2a.server.events.event_queue.EventQueue.dequeue_event",
                start_ns=start_ns + 30_000_000,
                end_ns=start_ns + 40_000_000,
            ),
            _span(
                "trace-noise",
                "chat",
                parent="root",
                name="openai.chat",
                kind=3,
                start_ns=start_ns + 100_000_000,
                end_ns=start_ns + 900_000_000,
                attributes={
                    "openinference.span.kind": "LLM",
                    "gen_ai.request.model": "gpt-5.1",
                    "gen_ai.prompt.0.content": "what is the capital?",
                    "gen_ai.completion.0.content": "Abu Dhabi",
                    "gen_ai.usage.input_tokens": "1591",
                    "gen_ai.usage.output_tokens": "179",
                },
            ),
        ],
    )
    await _tick(FakeGateway(evidence={"trace-noise": noisy}))

    body = client.get(f"/tracing/projects/{project_id}/spans/page?tenant_id={TENANT}").json()

    assert body["total"] == 1
    assert [item["span_id"] for item in body["items"]] == ["chat"]
    item = body["items"][0]
    assert item["semantic_kind"] == "llm"
    assert item["input_preview"] == "what is the capital?"
    assert item["output_preview"] == "Abu Dhabi"
    assert item["llm_token_count_prompt"] == 1591
    assert item["llm_token_count_completion"] == 179
    assert item["estimated_cost_usd"] == 0.003779


def test_span_scoring_preview_submission_and_retry(client, monkeypatch):
    from unittest.mock import AsyncMock

    from evalhub.api.v1 import tracing

    project_id = _create_project(client)
    trace_id = "trace-span-scoring"
    _run_with_captured_row(client, project_id=project_id, trace_id=trace_id)
    span = ArchivedTraceSpan(
        trace_id=trace_id, span_id="selected", name="response", duration_ms=250,
        attributes={"openinference.span.kind": "LLM", "input.value": "Question", "output.value": "Answer"},
    )
    monkeypatch.setattr(tracing, "_lookup_spans", AsyncMock(return_value={"spans": [span.model_dump(mode="json")]}))
    base = f"/tracing/projects/{project_id}/span-scoring"
    query = f"?tenant_id={TENANT}"
    selection = {"spans": [{"trace_id": trace_id, "span_id": "selected"}]}
    preview = client.post(base + "/preview" + query, json=selection)
    assert preview.status_code == 200, preview.text
    body = {**selection, "request_id": str(uuid.uuid4()), "preview_hash": preview.json()["preview_hash"], "metric_ids": ["ops.latency"]}
    response = client.post(base + query, json=body)
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]
    retry = client.post(base + query, json=body)
    assert retry.status_code == 202 and retry.json()["job_id"] == job_id
    assert client.post(base + query, json={**body, "metric_ids": ["llm.relevance"]}).status_code == 409
    assert client.post(base + query, json={**body, "request_id": str(uuid.uuid4()), "preview_hash": "0" * 64}).status_code == 409
    assert client.post(base + query, json={**body, "request_id": str(uuid.uuid4()), "metric_ids": ["llm.correctness"], "judge_model": "gpt-4o"}).status_code == 422
    other_project = _create_project(client)
    assert client.get(f"/tracing/projects/{other_project}/span-scoring/{job_id}" + query).status_code == 404
    assert client.get(base + f"/{job_id}?tenant_id=another-tenant").status_code == 403


async def test_span_scoring_posts_need_evidence_read_and_hiding_needs_review(client, monkeypatch):
    """Every /tracing GET that serves evidence gates on ``evidence.read``; the
    span-scoring POSTs return the same archived span bodies and used to pass
    on ``evaluation.run`` alone (including a retry that returns the stored
    job). Hiding a trace is evidence curation and maps to ``governance.review``."""
    from unittest.mock import AsyncMock

    from evalhub.api.v1 import tracing
    from evalhub.platform import authz

    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    project_id = _create_project(client)
    trace_id = "trace-permissions"
    _run_with_captured_row(client, project_id=project_id, trace_id=trace_id)
    await _tick(FakeGateway(evidence={trace_id: _evidence(trace_id)}))  # hide/unhide act on the index row
    span = ArchivedTraceSpan(
        trace_id=trace_id, span_id="selected", name="response", duration_ms=250,
        attributes={"openinference.span.kind": "LLM", "input.value": "Question", "output.value": "Answer"},
    )
    monkeypatch.setattr(tracing, "_lookup_spans", AsyncMock(return_value={"spans": [span.model_dump(mode="json")]}))

    granted: set[str] = {"evaluation.run"}

    async def grant(request, permission):
        allowed = permission in granted
        if allowed:
            request.state.eval_hub_permissions = {*getattr(request.state, "eval_hub_permissions", set()), permission}
        return allowed

    monkeypatch.setattr(settings, "platform_auth_required", True)
    monkeypatch.setattr(authz, "check_permission", grant)
    client.headers["x-evalai-sub"] = "synthetic-operator"
    base = f"/tracing/projects/{project_id}/span-scoring"
    query = f"?tenant_id={TENANT}"
    selection = {"spans": [{"trace_id": trace_id, "span_id": "selected"}]}

    # evaluation.run alone: no archived span bodies, in either direction.
    assert client.post(base + "/preview" + query, json=selection).status_code == 403
    assert client.get(f"/tracing/projects/{project_id}/traces/{trace_id}/spans" + query).status_code == 403

    granted.add("evidence.read")
    preview = client.post(base + "/preview" + query, json=selection)
    assert preview.status_code == 200, preview.text
    body = {**selection, "request_id": str(uuid.uuid4()), "preview_hash": preview.json()["preview_hash"], "metric_ids": ["ops.latency"]}
    submitted = client.post(base + query, json=body)
    assert submitted.status_code == 202, submitted.text

    # A retry of the same request returns the stored job, span evidence included.
    granted.discard("evidence.read")
    assert client.post(base + query, json=body).status_code == 403
    granted.add("evidence.read")
    retry = client.post(base + query, json=body)
    assert retry.status_code == 202 and retry.json()["job_id"] == submitted.json()["job_id"]

    # Hiding is curation: neither run nor evidence permissions grant it.
    hide = f"/tracing/projects/{project_id}/traces/{trace_id}/hide" + query
    assert client.post(hide, json={}).status_code == 403
    granted.add("governance.review")
    assert client.post(hide, json={}).status_code == 200
    assert client.post(f"/tracing/projects/{project_id}/traces/{trace_id}/unhide" + query, json={}).status_code == 200
