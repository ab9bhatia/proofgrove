"""Server-side pagination + search + sort for the run-history endpoint (F9).

Exercises ``GET /evaluation/run-history`` which returns a paginated envelope
``{items, total, next_cursor, limit, offset}`` backed by SQL LIMIT/OFFSET/COUNT.
The legacy bare-list ``GET /evaluation/runs`` is left untouched (back-compat).

The test DB is shared across the session, so every assertion is scoped to a
per-test uniquely-named experiment via ``search`` to stay isolated from runs
seeded by other tests.
"""

import uuid

import pytest

from tests.evaluation._pagination_helpers import count_selects as _count_selects

SAMPLE_EXPERIMENT_ID = "exp-llm-core-v1"

# run-history / legacy runs are tenant-scoped; seed + read under this tenant.
TENANT = "tenant-history-page"


@pytest.fixture(autouse=True)
def pause_background_worker(monkeypatch):
    # These tests create runs synchronously; count only request queries.
    async def wait_for_shutdown(stop):
        await stop.wait()

    monkeypatch.setattr("evalhub.main.run_worker_loop", wait_for_shutdown)


def _unique_experiment(client) -> tuple[str, str]:
    """Create an isolated experiment (unique name + rows) and return (id, token).

    ``token`` is a substring of the experiment name, safe to use as a ``search``
    filter that matches only this test's runs.
    """
    token = f"histmark-{uuid.uuid4().hex[:12]}"
    experiment_id = f"exp-{token}"

    rows = client.get(f"/evaluation/experiments/{SAMPLE_EXPERIMENT_ID}/rows").json()
    rows = [{**row, "row_id": f"{experiment_id}-{row['row_id']}"} for row in rows]

    created = client.post(
        "/evaluation/experiments",
        json={
            "experiment_id": experiment_id,
            "name": f"Run history fixture {token}",
            "dataset_version": "general_qa_v1",
            "target_endpoint": "https://example.com",
            "scenario": "llm_core",
            "domain": "general",
            "tenant_id": TENANT,
        },
    )
    assert created.status_code == 201, created.text
    added = client.post(f"/evaluation/experiments/{experiment_id}/rows", json=rows)
    assert added.status_code == 201, added.text
    return experiment_id, token


def _seed_runs(client, count: int) -> tuple[str, list[str]]:
    """Create ``count`` completed runs against a fresh isolated experiment."""
    experiment_id, token = _unique_experiment(client)
    run_ids: list[str] = []
    for _ in range(count):
        resp = client.post(
            "/evaluation/runs",
            json={
                "experiment_id": experiment_id,
                "name": f"Run history fixture {token}",
                "dataset_version": "general_qa_v1",
                "target_endpoint": "https://example.com",
                "scenario": "llm_core",
                "row_count": 2,
                "objective": "Track quality over time",
                "owner": "tester",
                "tenant_id": TENANT,
            },
        )
        assert resp.status_code == 201, resp.text
        run_ids.append(resp.json()["run_id"])
    return token, run_ids


def test_run_history_paginates_with_total_and_cursor(client):
    token, run_ids = _seed_runs(client, 5)

    page1 = client.get(f"/evaluation/run-history?limit=3&search={token}&tenant_id={TENANT}")
    assert page1.status_code == 200, page1.text
    body1 = page1.json()
    assert len(body1["items"]) == 3
    assert body1["total"] == 5
    assert body1["limit"] == 3
    assert body1["offset"] == 0
    assert body1["next_cursor"] is not None

    page2 = client.get(
        f"/evaluation/run-history?limit=3&search={token}&cursor={body1['next_cursor']}&tenant_id={TENANT}"
    )
    assert page2.status_code == 200, page2.text
    body2 = page2.json()
    assert len(body2["items"]) == 2
    assert body2["total"] == 5
    assert body2["next_cursor"] is None

    ids_page1 = {item["run_id"] for item in body1["items"]}
    ids_page2 = {item["run_id"] for item in body2["items"]}
    assert ids_page1.isdisjoint(ids_page2)
    assert (ids_page1 | ids_page2) == set(run_ids)


def test_run_history_search_filters(client):
    token, run_ids = _seed_runs(client, 4)

    # Search over experiment name matches exactly this test's runs.
    by_name = client.get(f"/evaluation/run-history?limit=50&search={token}&tenant_id={TENANT}")
    assert by_name.status_code == 200
    assert by_name.json()["total"] == 4

    # Search over run id matches exactly one run.
    target = run_ids[0]
    by_id = client.get(f"/evaluation/run-history?limit=50&search={target}&tenant_id={TENANT}")
    assert by_id.status_code == 200
    body = by_id.json()
    assert body["total"] == 1
    assert body["items"][0]["run_id"] == target

    # Non-matching search returns an empty page.
    none = client.get(f"/evaluation/run-history?limit=50&search=zzz-no-such-run-xyz&tenant_id={TENANT}")
    assert none.status_code == 200
    assert none.json()["total"] == 0
    assert none.json()["items"] == []


def test_run_history_sort_orders_by_started_at(client):
    token, _ = _seed_runs(client, 4)

    desc = client.get(
        f"/evaluation/run-history?limit=50&search={token}&sort=started_at&order=desc&tenant_id={TENANT}"
    )
    assert desc.status_code == 200
    started_desc = [item["started_at"] for item in desc.json()["items"]]
    assert started_desc == sorted(started_desc, reverse=True)

    asc = client.get(
        f"/evaluation/run-history?limit=50&search={token}&sort=started_at&order=asc&tenant_id={TENANT}"
    )
    assert asc.status_code == 200
    started_asc = [item["started_at"] for item in asc.json()["items"]]
    assert started_asc == sorted(started_asc)
    # asc is the reverse of desc for the same result set.
    assert started_asc == started_desc[::-1]


def test_run_history_page_hydrates_in_bounded_queries(client):
    """One page = O(1) queries, not one full get_run per row (N+1).

    Seeds 30 runs and reads a 5-row and a 25-row page. Bulk hydration means the
    SELECT count is flat across page sizes (one page query plus one batched
    query per associated collection); per-row hydration would grow linearly.
    """
    token, run_ids = _seed_runs(client, 30)

    with _count_selects() as small_page_selects:
        small = client.get(f"/evaluation/run-history?limit=5&search={token}&tenant_id={TENANT}")
    assert small.status_code == 200, small.text

    with _count_selects() as large_page_selects:
        large = client.get(f"/evaluation/run-history?limit=25&search={token}&tenant_id={TENANT}")
    assert large.status_code == 200, large.text

    # Page correctness: totals, sizes, ordering and the run-id partition are
    # exactly what the per-row implementation produced (wire contract intact).
    body = large.json()
    assert body["total"] == 30
    assert len(body["items"]) == 25
    started = [item["started_at"] for item in body["items"]]
    assert started == sorted(started, reverse=True)

    rest = client.get(
        f"/evaluation/run-history?limit=25&search={token}&cursor={body['next_cursor']}&tenant_id={TENANT}"
    )
    assert rest.status_code == 200, rest.text
    assert len(rest.json()["items"]) == 5
    page_ids = {item["run_id"] for item in body["items"]}
    rest_ids = {item["run_id"] for item in rest.json()["items"]}
    assert page_ids.isdisjoint(rest_ids)
    assert (page_ids | rest_ids) == set(run_ids)

    # Items are still the full RunResult payload, not a slimmed projection.
    first = body["items"][0]
    for field in ("experiment", "metric_results", "kpi_results", "review_queue", "status"):
        assert field in first, f"missing {field} in run-history item"
    assert first["experiment"]["name"].startswith("Run history fixture")

    # O(1)-ish hydration: a 5x larger page must not cost a single extra SELECT,
    # and the absolute count stays within count + page + batched collections.
    assert len(large_page_selects) == len(small_page_selects), (
        f"run-history page hydration scales with page size: "
        f"{len(small_page_selects)} SELECTs for 5 rows vs "
        f"{len(large_page_selects)} SELECTs for 25 rows"
    )
    assert len(large_page_selects) <= 10, (
        f"expected bounded per-page SELECTs, got {len(large_page_selects)}"
    )


def test_legacy_runs_endpoint_still_returns_bare_list(client):
    _seed_runs(client, 2)

    legacy = client.get(f"/evaluation/runs?tenant_id={TENANT}")
    assert legacy.status_code == 200
    payload = legacy.json()
    assert isinstance(payload, list)
    assert len(payload) >= 2


def test_legacy_and_experiment_reads_use_bounded_queries(client):
    """All UI run listings batch hydration; summary must not hydrate every run."""
    def counts(token):
        result = {}
        for endpoint in (
            f"/evaluation/runs?tenant_id={TENANT}",
            f"/evaluation/experiments/exp-{token}/runs",
            f"/evaluation/experiments/exp-{token}/summary",
        ):
            with _count_selects() as statements:
                response = client.get(endpoint)
            assert response.status_code == 200, response.text
            result["legacy" if "?tenant_id=" in endpoint else endpoint.rsplit("/", 1)[-1]] = len(statements)
        return result

    small_token, _ = _seed_runs(client, 1)
    small = counts(small_token)
    large_token, run_ids = _seed_runs(client, 10)
    large = counts(large_token)
    assert small == large
    assert max(large.values()) <= 12
    listed = client.get(f"/evaluation/experiments/exp-{large_token}/runs").json()
    assert {run["run_id"] for run in listed} == set(run_ids)
    # Batching must retain the complete detail payload and owning-run role.
    for run in listed:
        detail = client.get(f"/evaluation/runs/{run['run_id']}?tenant_id={TENANT}").json()
        for field in ("metric_results", "kpi_results", "evaluator_configs", "role", "lineage"):
            assert run.get(field) == detail.get(field)
