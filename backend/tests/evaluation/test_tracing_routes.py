"""Projects -> captured tracing contract tests."""

import evalhub.api.v1.evaluation as evaluation_module
from evalhub.evaluation.models import RunItemTraceEvidence
from tests.tracing._helpers import create_project as _create_project_base
from tests.tracing._helpers import run_with_captured_row as _run_with_captured_row_base

#: The tenant this module's client acts as, the way the gateway sets it.
TENANT = "tenant-tracing"


def _create_project(client, project_id: str | None = None):
    return _create_project_base(client, TENANT, project_id)


def _run_with_captured_row(client, **kwargs):
    return _run_with_captured_row_base(client, tenant=TENANT, **kwargs)


def test_projects_only_browse_genuine_trace_ids(client):
    project_id = _create_project(client)
    run = _run_with_captured_row(client, project_id=project_id, trace_id="trace-genuine")

    projects = client.get("/tracing/projects?tenant_id=tenant-tracing")
    assert projects.status_code == 200, projects.text
    project = next(item for item in projects.json() if item["project_id"] == project_id)
    assert project["trace_count"] == 1

    traces = client.get(f"/tracing/projects/{project_id}/traces?tenant_id=tenant-tracing")
    assert traces.status_code == 200, traces.text
    summary = traces.json()[0]
    assert summary["trace_id"] == "trace-genuine"
    assert summary["run_id"] == run["run_id"]
    assert summary["run_name"] is None
    assert summary["run_number"] == 1
    assert summary["capture_state"] == "partial"
    assert summary["attestation_state"] == "unknown"
    assert summary["invocation_outcome"] == "succeeded"

    detail = client.get(f"/tracing/projects/{project_id}/traces/trace-genuine?tenant_id=tenant-tracing")
    assert detail.status_code == 200, detail.text
    assert detail.json()["tree_available"] is False
    assert detail.json()["spans"] == []
    assert detail.json()["lifecycle_state"] == "archive_unavailable"

    _run_with_captured_row(client, project_id=project_id, trace_id="trace-genuine")
    deduplicated = client.get(f"/tracing/projects/{project_id}/traces?tenant_id=tenant-tracing")
    assert deduplicated.status_code == 200
    assert [item["trace_id"] for item in deduplicated.json()] == ["trace-genuine"]
    repeated_detail = client.get(f"/tracing/projects/{project_id}/traces/trace-genuine?tenant_id=tenant-tracing")
    assert repeated_detail.status_code == 200
    assert repeated_detail.json()["spans"] == []


def test_records_without_trace_id_stay_out_of_projects(client):
    project_id = _create_project(client)
    run = _run_with_captured_row(client, project_id=project_id, trace_id=None)

    traces = client.get(f"/tracing/projects/{project_id}/traces?tenant_id=tenant-tracing")
    assert traces.status_code == 200
    assert traces.json() == []
    items = client.get(f"/evaluation/runs/{run['run_id']}/items?tenant_id=tenant-tracing")
    assert items.status_code == 200
    assert items.json()[0]["trace_available"] is False


def test_traces_page_cursor_walks_every_trace_once(client):
    project_id = _create_project(client)
    trace_ids = [f"trace-page-{i}" for i in range(5)]
    for trace_id in trace_ids:
        _run_with_captured_row(client, project_id=project_id, trace_id=trace_id)

    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        pages += 1
        assert pages <= 10, "cursor paging did not terminate"
        url = f"/tracing/projects/{project_id}/traces/page?tenant_id=tenant-tracing&limit=2"
        if cursor:
            url += f"&cursor={cursor}"
        response = client.get(url)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["total"] == len(trace_ids)  # honest "N of M"
        assert len(body["items"]) <= 2
        seen.extend(item["trace_id"] for item in body["items"])
        if not body["has_more"]:
            assert body["next_cursor"] is None
            break
        assert body["next_cursor"]
        cursor = body["next_cursor"]

    # Every trace surfaced exactly once, no duplicates across page boundaries.
    assert sorted(seen) == sorted(trace_ids)
    assert len(seen) == len(set(seen))


def _page(client, project_id: str, **params) -> dict:
    query = {"tenant_id": "tenant-tracing", **params}
    response = client.get(f"/tracing/projects/{project_id}/traces/page", params=query)
    assert response.status_code == 200, response.text
    return response.json()


def test_traces_page_search_narrows_items_and_total(client):
    project_id = _create_project(client)
    _run_with_captured_row(
        client,
        project_id=project_id,
        trace_id="trace-alpha-1",
        experiment_name="Checkout quality",
        row_id="case-checkout",
    )
    _run_with_captured_row(
        client,
        project_id=project_id,
        trace_id="trace-alpha-2",
        experiment_name="Support quality",
        row_id="case-support",
    )
    _run_with_captured_row(
        client,
        project_id=project_id,
        trace_id="trace-beta",
        experiment_name="Support quality",
        row_id="case-billing",
    )

    # Case-insensitive substring over the trace id; total stays honest.
    body = _page(client, project_id, search="ALPHA")
    assert sorted(item["trace_id"] for item in body["items"]) == [
        "trace-alpha-1",
        "trace-alpha-2",
    ]
    assert body["total"] == 2

    # Substring over the evaluation (experiment) name.
    body = _page(client, project_id, search="checkout")
    assert [item["trace_id"] for item in body["items"]] == ["trace-alpha-1"]
    assert body["total"] == 1

    # Substring over the example id.
    body = _page(client, project_id, search="case-billing")
    assert [item["trace_id"] for item in body["items"]] == ["trace-beta"]
    assert body["total"] == 1

    # No match keeps the envelope honest instead of falling back to everything.
    body = _page(client, project_id, search="zebra")
    assert body["items"] == []
    assert body["total"] == 0
    assert body["has_more"] is False


def test_traces_page_status_filters_on_invocation_outcome(client):
    project_id = _create_project(client)
    _run_with_captured_row(client, project_id=project_id, trace_id="trace-ok")
    _run_with_captured_row(
        client,
        project_id=project_id,
        trace_id="trace-bad",
        invocation_error="target invocation failed",
    )

    ok = _page(client, project_id, status="succeeded")
    assert [item["trace_id"] for item in ok["items"]] == ["trace-ok"]
    assert ok["total"] == 1
    assert ok["items"][0]["invocation_outcome"] == "succeeded"

    bad = _page(client, project_id, status="error")
    assert [item["trace_id"] for item in bad["items"]] == ["trace-bad"]
    assert bad["total"] == 1
    assert bad["items"][0]["invocation_outcome"] == "error"

    # Neither captured row is outcome-unknown, so the filter honestly returns
    # nothing rather than leaking succeeded/error rows.
    unknown = _page(client, project_id, status="unknown")
    assert unknown["items"] == []
    assert unknown["total"] == 0

    invalid = client.get(
        f"/tracing/projects/{project_id}/traces/page",
        params={"tenant_id": "tenant-tracing", "status": "exploded"},
    )
    assert invalid.status_code == 422


def test_traces_page_since_until_bound_the_capture_window(client):
    project_id = _create_project(client)
    for index in range(3):
        _run_with_captured_row(client, project_id=project_id, trace_id=f"trace-window-{index}")

    everything = _page(client, project_id)["items"]
    assert len(everything) == 3
    times = [item["captured_at"] for item in everything]
    assert all(times)
    middle = times[1]

    recent = _page(client, project_id, since=middle)
    assert [item["trace_id"] for item in recent["items"]] == [item["trace_id"] for item in everything if item["captured_at"] >= middle]
    assert recent["total"] == len(recent["items"])

    older = _page(client, project_id, until=middle)
    assert [item["trace_id"] for item in older["items"]] == [item["trace_id"] for item in everything if item["captured_at"] <= middle]
    assert older["total"] == len(older["items"])

    banded = _page(client, project_id, since=middle, until=middle)
    assert [item["trace_id"] for item in banded["items"]] == [item["trace_id"] for item in everything if item["captured_at"] == middle]

    empty = _page(client, project_id, until="2000-01-01T00:00:00Z")
    assert empty["items"] == []
    assert empty["total"] == 0

    for field in ("since", "until"):
        malformed = client.get(
            f"/tracing/projects/{project_id}/traces/page",
            params={"tenant_id": "tenant-tracing", field: "not-a-datetime"},
        )
        assert malformed.status_code == 422, malformed.text


def test_traces_page_filters_compose_with_cursor_paging(client):
    project_id = _create_project(client)
    matching = [f"trace-fil-{index}" for index in range(5)]
    for trace_id in matching:
        _run_with_captured_row(client, project_id=project_id, trace_id=trace_id)
    for index in range(3):
        _run_with_captured_row(client, project_id=project_id, trace_id=f"trace-other-{index}")

    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        pages += 1
        assert pages <= 10, "filtered cursor paging did not terminate"
        params: dict = {"limit": 2, "search": "trace-fil"}
        if cursor:
            params["cursor"] = cursor
        body = _page(client, project_id, **params)
        assert body["total"] == len(matching)  # honest N of M under the filter
        assert len(body["items"]) <= 2
        seen.extend(item["trace_id"] for item in body["items"])
        if not body["has_more"]:
            assert body["next_cursor"] is None
            break
        assert body["next_cursor"]
        cursor = body["next_cursor"]

    # The filtered walk surfaces every matching trace exactly once.
    assert sorted(seen) == sorted(matching)
    assert len(seen) == len(set(seen))


def test_traces_page_filters_by_exact_run_id(client):
    project_id = _create_project(client)
    selected = _run_with_captured_row(client, project_id=project_id, trace_id="trace-selected")
    _run_with_captured_row(client, project_id=project_id, trace_id="trace-other")

    body = _page(client, project_id, run_id=selected["run_id"])

    assert body["total"] == 1
    assert [item["trace_id"] for item in body["items"]] == ["trace-selected"]
    assert body["items"][0]["run_id"] == selected["run_id"]


def test_traces_page_tolerates_a_malformed_cursor(client):
    project_id = _create_project(client)
    _run_with_captured_row(client, project_id=project_id, trace_id="trace-solo")
    response = client.get(f"/tracing/projects/{project_id}/traces/page?tenant_id=tenant-tracing&cursor=not-a-cursor")
    assert response.status_code == 200, response.text
    body = response.json()
    assert [item["trace_id"] for item in body["items"]] == ["trace-solo"]
    assert body["has_more"] is False


def test_catalog_registry_is_not_a_tracing_workspace(client):
    response = client.post(
        "/platform/projects",
        json={
            "project_id": "catalog-project",
            "tenant_id": "tenant-tracing",
            "name": "Agent catalog",
            "system_type": "agent",
            "owner": "platform",
            "purpose": "catalog_registry",
        },
    )
    assert response.status_code == 201
    listed = client.get("/tracing/projects?tenant_id=tenant-tracing")
    assert listed.status_code == 200
    assert all(item["project_id"] != "catalog-project" for item in listed.json())
    traces = client.get("/tracing/projects/catalog-project/traces?tenant_id=tenant-tracing")
    assert traces.status_code == 409


class _RecordingArchiveReader:
    """Stand-in reader that records which tenant it was asked to look up."""

    last_tenant: str | None = None

    def __init__(self, _settings):
        pass

    async def find(self, **kwargs):
        _RecordingArchiveReader.last_tenant = kwargs.get("tenant")
        return RunItemTraceEvidence(state="not_found", message="stubbed for the test")


def test_run_item_trace_looks_up_the_caller_tenant_not_the_pod_namespace(client, monkeypatch):
    """The archive prefix must come from the request's OWN authorized tenant.

    It used to be derived from ``settings.pod_namespace`` (the service's own
    deployment namespace) regardless of which tenant the request was actually
    scoped to -- correct only by accident in a strictly one-tenant-per-pod
    deployment, and wrong in any other topology.
    """
    monkeypatch.setattr(evaluation_module, "TraceArchiveReader", _RecordingArchiveReader)
    # With no deployment namespace, exact caller identities are supported.
    # A configured foreign namespace must reject this caller before routing.
    monkeypatch.setattr(evaluation_module.settings, "pod_namespace", "")

    project_id = _create_project(client)
    run = _run_with_captured_row(client, project_id=project_id, trace_id="trace-tenant-check")
    items = client.get(f"/evaluation/runs/{run['run_id']}/items?tenant_id=tenant-tracing").json()
    assert items
    row_id = items[0]["example_id"]

    response = client.get(
        f"/evaluation/runs/{run['run_id']}/items/{row_id}/trace?tenant_id=tenant-tracing"
    )
    assert response.status_code == 200, response.text
    # tenant_from_namespace strips the "tenant-" prefix, so the recorded
    # archive-lookup tenant is "tracing" (from the caller's tenant_id) -- the
    # bug this guards against would instead record "platform"
    # (from settings.pod_namespace).
    assert _RecordingArchiveReader.last_tenant == "tracing"
