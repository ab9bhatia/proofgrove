"""Pre-run experiment workspace creation (#2671 T1)."""

TENANT = "tenant-prerun"


def test_create_pre_run_workspace_appears_active_with_zero_runs(client):
    created = client.post(
        "/evaluation/experiments/workspaces",
        json={
            "tenant_id": TENANT,
            "name": "Prompt grounding v2",
            "description": "Pre-run governance workspace",
            "objective": "Improve groundedness",
            "hypothesis": "Richer context helps",
            "owner": "eval-squad",
            "created_by": "tester",
            "tags": {"squad": "risk"},
        },
        headers={"x-evalai-tenant": TENANT},
    )
    assert created.status_code == 201, created.text
    summary = created.json()
    experiment = summary["experiment"]
    assert summary["run_count"] == 0
    assert summary["latest_run_id"] is None
    assert experiment["name"] == "Prompt grounding v2"
    assert experiment["status"] == "active"
    assert experiment["tags"]["workspace_kind"] == "experiment"
    assert experiment["tags"]["pending_first_run"] == "true"
    assert experiment["dataset_version"] == ""
    assert experiment["target_endpoint"] == ""
    assert experiment["scenario"] == ""
    assert experiment["objective"] == "Improve groundedness"
    assert experiment["hypothesis"] == "Richer context helps"
    assert experiment["owner"] == "eval-squad"
    assert experiment["tags"]["squad"] == "risk"

    listed = client.get(
        f"/evaluation/experiments/workspaces?tenant_id={TENANT}",
        headers={"x-evalai-tenant": TENANT},
    )
    assert listed.status_code == 200, listed.text
    ids = [item["experiment"]["experiment_id"] for item in listed.json()]
    assert experiment["experiment_id"] in ids
    match = next(
        item
        for item in listed.json()
        if item["experiment"]["experiment_id"] == experiment["experiment_id"]
    )
    assert match["run_count"] == 0
    assert match["experiment"]["status"] == "active"


def test_create_pre_run_workspace_rejects_blank_name(client):
    response = client.post(
        "/evaluation/experiments/workspaces",
        json={
            "tenant_id": TENANT,
            "name": "   ",
            "created_by": "tester",
        },
        headers={"x-evalai-tenant": TENANT},
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "experiment_workspace_name_required"
    assert detail["field"] == "name"
    assert "required" in detail["message"].lower()


def test_create_pre_run_workspace_rejects_cross_tenant(client):
    response = client.post(
        "/evaluation/experiments/workspaces",
        json={
            "tenant_id": TENANT,
            "name": "Cross tenant",
            "created_by": "tester",
        },
        headers={"x-evalai-tenant": "tenant-other"},
    )
    assert response.status_code == 403


def test_archiving_a_workspace_moves_it_between_the_two_lists(client):
    """Archive is how an experiment leaves the working set.

    It has to leave the active list *and* the active ``total``, or the list
    keeps offering a row the reader has already removed — and it has to stay
    readable under ``archived=true``, because the runs, findings and decisions
    taken against it are evidence.
    """
    tenant = "tenant-archive"
    created = client.post(
        "/evaluation/experiments/workspaces",
        json={"tenant_id": tenant, "name": "Retired bakeoff", "created_by": "tester"},
        headers={"x-evalai-tenant": tenant},
    )
    assert created.status_code == 201, created.text
    experiment_id = created.json()["experiment"]["experiment_id"]

    def listed(archived: bool) -> dict:
        response = client.get(
            f"/evaluation/experiments/workspaces?tenant_id={tenant}&limit=50&archived={str(archived).lower()}",
            headers={"x-evalai-tenant": tenant},
        )
        assert response.status_code == 200, response.text
        return response.json()

    before = listed(archived=False)
    assert experiment_id in [item["experiment"]["experiment_id"] for item in before["items"]]
    assert before["total"] == 1
    assert listed(archived=True)["total"] == 0

    archived = client.post(
        f"/evaluation/experiments/{experiment_id}/archive",
        headers={"x-evalai-tenant": tenant},
    )
    assert archived.status_code == 200, archived.text

    after = listed(archived=False)
    assert experiment_id not in [item["experiment"]["experiment_id"] for item in after["items"]]
    assert after["total"] == 0

    kept = listed(archived=True)
    assert [item["experiment"]["experiment_id"] for item in kept["items"]] == [experiment_id]
    assert kept["total"] == 1

    restored = client.patch(
        f"/evaluation/experiments/{experiment_id}",
        json={"status": "active"},
        headers={"x-evalai-tenant": tenant},
    )
    assert restored.status_code == 200, restored.text
    assert listed(archived=False)["total"] == 1


def test_workspace_search_filters_the_page_and_the_total(client):
    """``q`` has to narrow ``total`` too.

    The list is one server page, so a browser-side filter would search the rows
    it happens to hold while the footer still reported the count of all of them.
    """
    tenant = "tenant-search"
    for name in ("Groundedness bakeoff", "Latency bakeoff", "Prompt rewrite"):
        created = client.post(
            "/evaluation/experiments/workspaces",
            json={"tenant_id": tenant, "name": name, "created_by": "tester"},
            headers={"x-evalai-tenant": tenant},
        )
        assert created.status_code == 201, created.text

    def listed(query: str) -> dict:
        response = client.get(
            f"/evaluation/experiments/workspaces?tenant_id={tenant}&limit=50&q={query}",
            headers={"x-evalai-tenant": tenant},
        )
        assert response.status_code == 200, response.text
        return response.json()

    assert listed("")["total"] == 3
    # Case-insensitive substring, and the total counts the matches, not the page.
    hits = listed("BAKEOFF")
    assert hits["total"] == 2
    assert sorted(item["experiment"]["name"] for item in hits["items"]) == [
        "Groundedness bakeoff",
        "Latency bakeoff",
    ]
    assert listed("nothing-matches-this")["total"] == 0
