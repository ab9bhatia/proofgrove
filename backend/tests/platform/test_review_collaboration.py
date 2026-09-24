"""F6 review collaboration: finding comments and the derived activity timeline.

Comments are append-only rows attributed to a resolved human identity; the
placeholder actor is rejected. Mentions are parsed server-side and recorded
(no notification delivery). The activity endpoint is a read-only merge of
already-persisted review data — no new event table — so edits/deletes are not
tracked and remediation status transitions only appear when they went through
the API (they are derived from the audit log).
"""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from evalhub.platform.review import parse_mentions
from tests.conftest import act_as
from tests.platform.test_review_decision_history import _finding_with_task

#: The tenant this module's client acts as, the way the gateway sets it.
TENANT = "tenant-test"


def test_remediation_list_uses_caller_tenant_and_filters_foreign_findings(client, monkeypatch):
    from unittest.mock import AsyncMock

    from evalhub.platform import authz
    from evalhub.settings import settings

    records = []
    for _ in range(2):
        suffix = uuid4().hex[:8]
        finding_id, _task_id = _finding_with_task(client, suffix)
        response = client.post(
            f"/platform/findings/{finding_id}/remediations",
            json={"finding_id": finding_id, "owner": "quality", "description": "Synthetic fix", "created_by": "reviewer"},
        )
        assert response.status_code == 201, response.text
        records.append((f"tenant-{suffix}", finding_id, response.json()["remediation_id"]))

    tenant, finding, remediation = records[0]
    foreign_tenant, foreign_finding, _ = records[1]
    act_as(client, tenant)
    client.headers["x-evalai-sub"] = "reviewer"
    monkeypatch.setattr(settings, "platform_auth_required", True)
    monkeypatch.setattr(authz, "check_permission", AsyncMock(return_value=True))
    for params in ({}, {"finding_id": finding}, {"tenant_id": tenant}):
        response = client.get("/platform/remediations", params=params)
        assert response.status_code == 200, response.text
        assert [row["remediation_id"] for row in response.json()] == [remediation]
    foreign = client.get("/platform/remediations", params={"finding_id": foreign_finding})
    assert foreign.status_code == 200, foreign.text
    assert foreign.json() == []
    assert client.get("/platform/remediations", params={"tenant_id": foreign_tenant}).status_code == 403


def test_parse_mentions_extracts_ordered_unique_tokens():
    body = "cc @alice and @bob@example.com — @alice please confirm; mail me at ops@example.com"
    assert parse_mentions(body) == ["alice", "bob@example.com"]
    assert parse_mentions("no mentions here") == []
    # A bare "@" is not a mention.
    assert parse_mentions("just an @ sign") == []


def test_comment_round_trip_records_author_body_and_mentions(client):
    finding_id, _task_id = _finding_with_task(client, uuid4().hex[:8])

    created = client.post(
        f"/platform/findings/{finding_id}/comments",
        json={"author": "reviewer-a", "body": "Confirmed on replay — @alice can you own the fix?"},
    )
    assert created.status_code == 201, created.text
    comment = created.json()
    assert comment["finding_id"] == finding_id
    assert comment["author"] == "reviewer-a"
    assert comment["body"] == "Confirmed on replay — @alice can you own the fix?"
    assert comment["mentions"] == ["alice"]
    assert comment["created_at"]

    second = client.post(
        f"/platform/findings/{finding_id}/comments",
        json={"author": "alice", "body": "On it."},
    )
    assert second.status_code == 201, second.text

    listed = client.get(f"/platform/findings/{finding_id}/comments")
    assert listed.status_code == 200, listed.text
    comments = listed.json()
    assert [entry["author"] for entry in comments] == ["reviewer-a", "alice"]
    assert comments[0]["comment_id"] == comment["comment_id"]


def test_comment_rejects_placeholder_or_empty_author(client):
    finding_id, _task_id = _finding_with_task(client, uuid4().hex[:8])
    for author in ("", "   ", "system"):
        response = client.post(
            f"/platform/findings/{finding_id}/comments",
            json={"author": author, "body": "should be rejected"},
        )
        assert response.status_code == 422, response.text


def test_comment_rejects_blank_and_overlong_body(client):
    finding_id, _task_id = _finding_with_task(client, uuid4().hex[:8])
    blank = client.post(
        f"/platform/findings/{finding_id}/comments",
        json={"author": "reviewer-a", "body": "   "},
    )
    assert blank.status_code == 422
    overlong = client.post(
        f"/platform/findings/{finding_id}/comments",
        json={"author": "reviewer-a", "body": "x" * 4001},
    )
    assert overlong.status_code == 422


def test_comment_endpoints_unknown_finding_404(client):
    missing = f"missing-{uuid4().hex}"
    assert client.post(
        f"/platform/findings/{missing}/comments",
        json={"author": "reviewer-a", "body": "hello"},
    ).status_code == 404
    assert client.get(f"/platform/findings/{missing}/comments").status_code == 404
    assert client.get(f"/platform/findings/{missing}/activity").status_code == 404


def test_activity_timeline_merges_persisted_review_events(client):
    finding_id, task_id = _finding_with_task(client, uuid4().hex[:8])

    assert client.post(
        f"/platform/findings/{finding_id}/comments",
        json={"author": "reviewer-a", "body": "Reproduced locally, @bob take a look"},
    ).status_code == 201

    assert client.post(
        "/platform/review-decisions",
        json={
            "finding_id": finding_id,
            "task_id": task_id,
            "reviewer": "reviewer-b",
            "outcome": "agree",
            "rationale": "Confirmed regression",
        },
    ).status_code == 201

    remediation = client.post(
        f"/platform/findings/{finding_id}/remediations",
        json={
            "finding_id": finding_id,
            "owner": "team-quality",
            "description": "Fix the prompt",
            "created_by": "reviewer-b",
        },
    )
    assert remediation.status_code == 201, remediation.text
    remediation_id = remediation.json()["remediation_id"]

    assert client.patch(
        f"/platform/remediations/{remediation_id}",
        json={"status": "in_progress"},
        headers={"x-evalai-subject": "fixer"},
    ).status_code == 200

    expires = (datetime.now(UTC) + timedelta(days=7)).isoformat()
    assert client.post(
        f"/platform/findings/{finding_id}/waivers",
        json={
            "finding_id": finding_id,
            "approved_by": "approver-a",
            "rationale": "Ship with known issue",
            "expires_at": expires,
        },
    ).status_code == 201

    response = client.get(f"/platform/findings/{finding_id}/activity")
    assert response.status_code == 200, response.text
    events = response.json()

    kinds = [event["kind"] for event in events]
    assert kinds[0] == "finding_created"
    for expected in (
        "comment",
        "review_decision",
        "remediation_created",
        "remediation_status_changed",
        "waiver_granted",
    ):
        assert expected in kinds, f"missing {expected} in {kinds}"

    # Chronological, oldest first.
    timestamps = [event["timestamp"] for event in events]
    assert timestamps == sorted(timestamps)

    by_kind = {event["kind"]: event for event in events}
    comment_event = by_kind["comment"]
    assert comment_event["actor"] == "reviewer-a"
    assert comment_event["summary"] == "Reproduced locally, @bob take a look"
    assert comment_event["details"]["mentions"] == ["bob"]

    assert by_kind["review_decision"]["actor"] == "reviewer-b"
    assert by_kind["remediation_created"]["actor"] == "reviewer-b"
    # Status transitions are derived from the audit trail, which carries the actor.
    status_event = by_kind["remediation_status_changed"]
    assert status_event["actor"] == "fixer"
    assert status_event["details"]["status"] == "in_progress"
    assert by_kind["waiver_granted"]["actor"] == "approver-a"

    # Every event carries a reference to the persisted row it was derived from.
    assert all(event["reference_id"] for event in events)
