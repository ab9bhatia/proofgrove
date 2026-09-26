"""Split trace endpoints stay resilient when the span archive is down.

A failing archive lookup must not take down the whole trace page: the summary
endpoint (header/summary/scores source) never touches the archive and cannot
503, while the spans endpoint is the only surface allowed to fail on its own.
"""

import logging

import pytest

import proofgrove.api.v1.evaluation as evaluation_module
import proofgrove.api.v1.tracing as tracing_module
from proofgrove.evaluation.models import RunItemTraceEvidence
from tests.conftest import act_as
from tests.tracing._helpers import create_project as _create_project_base
from tests.tracing._helpers import run_with_captured_row as _run_with_captured_row_base

#: The tenant this module's client acts as, the way the gateway sets it.
TENANT = "tenant-resilience"


def _create_project(client, project_id: str | None = None):
    return _create_project_base(client, TENANT, project_id)


def _run_with_captured_row(client, *, project_id: str, trace_id: str):
    return _run_with_captured_row_base(
        client, tenant=TENANT, project_id=project_id, trace_id=trace_id
    )


class _BoomArchiveReader:
    """Stand-in reader whose archive lookup always fails."""

    def __init__(self, _settings):
        pass

    async def find(self, **_kwargs):
        # Shaped like a real object-store error: names the endpoint and bucket.
        raise RuntimeError("trace archive is unreachable: https://archive.internal/bucket-sentinel")


def test_summary_endpoint_survives_archive_failure(client, monkeypatch):
    monkeypatch.setattr(tracing_module, "TraceArchiveReader", _BoomArchiveReader)
    project_id = _create_project(client)
    run = _run_with_captured_row(client, project_id=project_id, trace_id="trace-boom")

    summary = client.get(
        f"/tracing/projects/{project_id}/traces/trace-boom/summary"
        "?tenant_id=tenant-resilience"
    )
    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert body["trace_id"] == "trace-boom"
    assert body["run_id"] == run["run_id"]
    assert body["capture_state"] == "partial"
    # The summary surface never carries archived spans.
    assert body["spans"] == []


def test_spans_endpoint_503s_alone_on_archive_failure(client, monkeypatch, caplog):
    monkeypatch.setattr(tracing_module, "TraceArchiveReader", _BoomArchiveReader)
    caplog.set_level(logging.ERROR, logger="proofgrove")
    project_id = _create_project(client)
    _run_with_captured_row(client, project_id=project_id, trace_id="trace-boom")

    spans = client.get(
        f"/tracing/projects/{project_id}/traces/trace-boom/spans"
        "?tenant_id=tenant-resilience"
    )
    assert spans.status_code == 503, spans.text
    assert spans.json()["detail"] == {
        "code": "trace_archive_unavailable",
        "field": "archived_spans",
        "message": (
            "Archived spans are temporarily unavailable; trace summary and scores "
            "remain available."
        ),
        "recovery": (
            "Retry the span archive. If this persists, verify collector and archive "
            "configuration."
        ),
    }
    # The failure is logged by type only: a traceback would carry the
    # object-store error text (endpoint, bucket) into shared logs.
    failures = [record for record in caplog.records if record.name == "proofgrove.api.v1.tracing"]
    assert failures, "the archive failure must still be logged"
    for record in failures:
        assert record.exc_info is None
        assert record.error_type == "RuntimeError"
        assert "bucket-sentinel" not in str(vars(record))


def test_missing_trace_summary_and_spans_return_404(client):
    project_id = _create_project(client)
    _run_with_captured_row(client, project_id=project_id, trace_id="trace-real")

    missing_summary = client.get(
        f"/tracing/projects/{project_id}/traces/does-not-exist/summary"
        "?tenant_id=tenant-resilience"
    )
    assert missing_summary.status_code == 404
    missing_spans = client.get(
        f"/tracing/projects/{project_id}/traces/does-not-exist/spans"
        "?tenant_id=tenant-resilience"
    )
    assert missing_spans.status_code == 404


class _RecordingArchiveReader:
    """Stand-in reader that records which tenant it was asked to look up."""

    last_tenant: str | None = None

    def __init__(self, _settings):
        pass

    async def find(self, **kwargs):
        _RecordingArchiveReader.last_tenant = kwargs.get("tenant")
        return RunItemTraceEvidence(state="not_found", message="stubbed for the test")


def test_spans_endpoint_looks_up_the_caller_tenant_not_the_pod_namespace(client, monkeypatch):
    """``_lookup_spans`` must resolve the archive prefix from the request's OWN
    authorized tenant_id, not ``settings.pod_namespace`` -- otherwise every
    caller reads the SERVICE's own deployment namespace's archive prefix
    regardless of which tenant it was actually authorized for.
    """
    monkeypatch.setattr(tracing_module, "TraceArchiveReader", _RecordingArchiveReader)
    # With no deployment namespace, exact caller identities are supported.
    # A configured foreign namespace must reject this caller before routing.
    monkeypatch.setattr(tracing_module.settings, "pod_namespace", "")
    project_id = _create_project(client)
    _run_with_captured_row(client, project_id=project_id, trace_id="trace-tenant-check")

    spans = client.get(
        f"/tracing/projects/{project_id}/traces/trace-tenant-check/spans"
        "?tenant_id=tenant-resilience"
    )
    assert spans.status_code == 200, spans.text
    # tenant_from_namespace strips the "tenant-" prefix, so the recorded
    # archive-lookup tenant is "resilience" (from the caller's tenant_id) --
    # the bug this guards against would instead record "platform"
    # (from settings.pod_namespace).
    assert _RecordingArchiveReader.last_tenant == "resilience"


@pytest.mark.parametrize("slug", ["acme", "tenant-acme"])
def test_archive_prefix_matches_for_authorized_tenant_aliases(client, monkeypatch, slug):
    namespace = f"tenant-{slug}"
    monkeypatch.setattr(tracing_module.settings, "pod_namespace", namespace)
    monkeypatch.setattr(tracing_module, "TraceArchiveReader", _RecordingArchiveReader)
    monkeypatch.setattr(evaluation_module, "TraceArchiveReader", _RecordingArchiveReader)
    act_as(client, slug)
    project = _create_project_base(client, namespace)
    run = _run_with_captured_row_base(client, tenant=namespace, project_id=project, trace_id="alias-trace")
    items = client.get(f"/evaluation/runs/{run['run_id']}/items", params={"tenant_id": namespace}).json()
    paths = [
        f"/tracing/projects/{project}/traces/alias-trace/spans",
        f"/evaluation/runs/{run['run_id']}/items/{items[0]['example_id']}/trace",
    ]
    for path in paths:
        for alias in [slug, namespace]:
            _RecordingArchiveReader.last_tenant = None
            response = client.get(path, params={"tenant_id": alias})
            assert response.status_code == 200, response.text
            assert _RecordingArchiveReader.last_tenant == slug
        _RecordingArchiveReader.last_tenant = None
        assert client.get(path, params={"tenant_id": "tenant-foreign"}).status_code == 403
        assert _RecordingArchiveReader.last_tenant is None
