"""Agreement is the product: how often reviewers agreed with the judge."""

from uuid import uuid4

from tests.platform.test_review_decision_history import _finding_with_task


def test_agreement_counts_the_reviewer_verdict_that_already_exists(client):
    """No score is typed by hand. The workflow's agree/disagree IS the signal.

    A reviewer is asked the only question they are qualified to answer — was
    this finding right? Asking them to produce the correct number instead puts
    them in the judge's seat, which is not what review is for.
    """

    suffix = uuid4().hex[:8]
    finding_id, task_id = _finding_with_task(client, suffix)

    assert client.post(
        "/platform/review-decisions",
        json={
            "finding_id": finding_id,
            "task_id": task_id,
            "reviewer": "reviewer@example.com",
            "outcome": "disagree",
            "rationale": "The judge failed this but the answer is fine.",
        },
    ).status_code == 201

    rows = client.get(f"/platform/judge-agreement?tenant_id=tenant-{suffix}")
    assert rows.status_code == 200, rows.text
    body = rows.json()
    assert body, "a reviewed finding must appear"
    entry = body[0]
    assert entry["reviewed"] == 1
    assert entry["agreed"] == 0, "disagree means the judge was wrong"


def test_a_later_verdict_supersedes_an_earlier_one(client):
    """Review history is append-only; only the latest decision counts.

    Counting every decision would let one reviewer changing their mind move the
    number twice, in opposite directions.
    """

    suffix = uuid4().hex[:8]
    finding_id, task_id = _finding_with_task(client, suffix)

    for outcome in ("disagree", "agree"):
        assert client.post(
            "/platform/review-decisions",
            json={
                "finding_id": finding_id,
                "task_id": task_id,
                "reviewer": "reviewer@example.com",
                "outcome": outcome,
                "rationale": f"recorded {outcome}",
            },
        ).status_code == 201

    entry = client.get(f"/platform/judge-agreement?tenant_id=tenant-{suffix}").json()[0]
    assert entry["reviewed"] == 1, "two decisions on one finding are still one verdict"
    assert entry["agreed"] == 1, "the later agree wins"


def test_a_passing_case_can_be_sent_to_review(client):
    """Findings exist only for failures, so review alone catches false alarms only.

    A judge that passes everything would score a perfect agreement. Opening a
    passing case is how the other half gets reviewed — it records no verdict,
    it just puts the case in the queue.
    """

    suffix = uuid4().hex[:8]
    _finding_with_task(client, suffix)
    finding = client.get(f"/platform/findings?tenant_id=tenant-{suffix}").json()[0]

    body = {
        "run_id": finding["run_id"],
        "row_id": finding["row_id"],
        "metric_id": finding["metric_ids"][0],
    }
    first = client.post(f"/platform/review-cases?tenant_id=tenant-{suffix}", json=body)
    assert first.status_code == 201, first.text

    # Idempotent: two reviewers opening the same case must not create rival
    # histories for it.
    second = client.post(f"/platform/review-cases?tenant_id=tenant-{suffix}", json=body)
    assert second.status_code == 201
    assert second.json()["created"] is False
    assert second.json()["finding"]["finding_id"] == first.json()["finding"]["finding_id"]


def test_the_tenant_comes_from_the_run_not_from_the_caller(client):
    """Authorizing a caller-supplied tenant proves nothing about a supplied run.

    The route used to take ``tenant_id`` as a query parameter and authorize
    that. A reviewer in one tenant who knew another tenant's run/row/metric
    could pass their own tenant, clear the check, read that case's query,
    response and rationale back in the finding, and write a review task into
    the other tenant's queue.

    Asserted at the seam rather than end to end: a permission dependency runs
    ahead of the route and needs an AuthZ service the suite has no access to,
    so a request-level test would stop before reaching the tenant check.
    """

    import asyncio
    import inspect

    from proofgrove.api.v1.platform import _run_tenant, open_case_for_review
    from proofgrove.db.session import async_session_factory
    from proofgrove.db.store import EvaluationStore

    suffix = uuid4().hex[:8]
    _finding_with_task(client, suffix)
    finding = client.get(f"/platform/findings?tenant_id=tenant-{suffix}").json()[0]

    # There is no tenant to supply: the parameter is gone, so it cannot be the
    # thing that gets authorized.
    assert "tenant_id" not in inspect.signature(open_case_for_review).parameters

    async def owner() -> str | None:
        async with async_session_factory()() as session:
            return await _run_tenant(EvaluationStore(session), finding["run_id"])

    assert asyncio.run(owner()) == f"tenant-{suffix}"
