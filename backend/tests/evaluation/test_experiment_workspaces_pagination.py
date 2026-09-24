"""Workspace listing: bounded statement count + additive paging (#2985).

``GET /evaluation/experiments/workspaces`` used to hydrate every run of every
group through ``get_run`` (an N+1 on an unpaginated endpoint the UI always calls
with ``include_drafts=true``). The listing now hydrates in aggregate, so the
statement count must stay flat as groups and runs grow.
"""

import uuid

from tests.conftest import act_as
from tests.evaluation._pagination_helpers import count_selects as _count_selects

#: The tenant this module's client acts as, the way the gateway sets it.
TENANT = "tenant-test"

SAMPLE_EXPERIMENT_ID = "exp-llm-core-v1"


def _seed_groups(client, tenant: str, groups: int, runs: int) -> list[str]:
    """Create ``groups`` lineage drafts of ``runs`` completed runs each."""
    # Create/rows now require the caller to be authorized for the body's
    # tenant, so switch identity to the tenant being seeded.
    act_as(client, tenant)
    rows = client.get(f"/evaluation/experiments/{SAMPLE_EXPERIMENT_ID}/rows").json()[:1]
    experiment_ids: list[str] = []
    for _ in range(groups):
        experiment_id = f"exp-{uuid.uuid4().hex[:12]}"
        created = client.post(
            "/evaluation/experiments",
            json={
                "experiment_id": experiment_id,
                "name": f"Workspace listing fixture {experiment_id}",
                "dataset_version": "general_qa_v1",
                "target_endpoint": "https://example.com",
                "scenario": "llm_core",
                "domain": "general",
                "tenant_id": tenant,
            },
        )
        assert created.status_code == 201, created.text
        added = client.post(
            f"/evaluation/experiments/{experiment_id}/rows",
            json=[{**row, "row_id": f"{experiment_id}-{row['row_id']}"} for row in rows],
        )
        assert added.status_code == 201, added.text
        for _run in range(runs):
            resp = client.post(
                "/evaluation/runs",
                json={
                    "experiment_id": experiment_id,
                    "name": f"Workspace listing fixture {experiment_id}",
                    "dataset_version": "general_qa_v1",
                    "target_endpoint": "https://example.com",
                    "scenario": "llm_core",
                    "row_count": 1,
                    "tenant_id": tenant,
                },
            )
            assert resp.status_code == 201, resp.text
        experiment_ids.append(experiment_id)
    return experiment_ids


def test_workspace_listing_statement_count_is_flat(client):
    """10 groups x 3 runs must cost the same SELECTs as 1 group x 1 run.

    Per-run hydration cost ~12 statements per group plus ~8 per run (1 vs 121
    for this exact shape); aggregate hydration is a fixed handful for the whole
    page. Also pins the additive paging envelope, since paging is what keeps the
    page — and therefore the hydration — bounded.
    """
    small_tenant = f"tenant-ws-small-{uuid.uuid4().hex[:8]}"
    big_tenant = f"tenant-ws-big-{uuid.uuid4().hex[:8]}"
    _seed_groups(client, small_tenant, groups=1, runs=1)
    big_ids = _seed_groups(client, big_tenant, groups=10, runs=3)

    with _count_selects() as small_selects:
        act_as(client, small_tenant)
        small = client.get(
            f"/evaluation/experiments/workspaces?tenant_id={small_tenant}"
            "&include_drafts=true&limit=50"
        )
    assert small.status_code == 200, small.text

    with _count_selects() as big_selects:
        act_as(client, big_tenant)
        big = client.get(
            f"/evaluation/experiments/workspaces?tenant_id={big_tenant}"
            "&include_drafts=true&limit=50"
        )
    assert big.status_code == 200, big.text

    # 30x the runs and 10x the groups, same number of statements.
    assert len(big_selects) == len(small_selects), (
        f"workspace listing scales with run count: {len(small_selects)} SELECTs "
        f"for 1 group x 1 run vs {len(big_selects)} for 10 groups x 3 runs"
    )
    assert len(big_selects) <= 12, (
        f"expected a bounded listing, got {len(big_selects)} SELECTs"
    )

    assert small.json()["total"] == 1
    body = big.json()
    assert body["total"] == 10
    assert len(body["items"]) == 10
    assert {item["experiment"]["experiment_id"] for item in body["items"]} == set(big_ids)
    assert all(item["run_count"] == 3 for item in body["items"])
    assert all(item["kind"] == "draft" for item in body["items"])
    assert body["next_cursor"] is None

    # Paging is additive: a window returns the envelope and a real cursor, and
    # no window at all still returns the legacy bare list.
    page = client.get(
        f"/evaluation/experiments/workspaces?tenant_id={big_tenant}&include_drafts=true&limit=4"
    ).json()
    assert page["total"] == 10
    assert len(page["items"]) == 4
    assert page["next_cursor"] == "4"
    rest = client.get(
        f"/evaluation/experiments/workspaces?tenant_id={big_tenant}"
        f"&include_drafts=true&limit=4&cursor={page['next_cursor']}"
    ).json()
    assert [item["experiment"]["experiment_id"] for item in rest["items"]] == [
        item["experiment"]["experiment_id"] for item in body["items"][4:8]
    ]
    legacy = client.get(
        f"/evaluation/experiments/workspaces?tenant_id={big_tenant}&include_drafts=true"
    ).json()
    assert isinstance(legacy, list)
    assert len(legacy) == 10
