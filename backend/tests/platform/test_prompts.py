"""Prompt library: versions, labels, and the tenant boundary."""

from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from evalhub.db.models import Base
from evalhub.db.store import EvaluationStore
from evalhub.platform import authz
from evalhub.platform.prompts import parse_prompt_ref
from tests.conftest import act_as

TENANT = "tenant-a"


@pytest.fixture
async def store():
    """Same shape as tests/db/test_store.py; the label branches need the store."""

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield EvaluationStore(session)
    await engine.dispose()


def _save(client, *, prompt_id="support", content="Be concise.", name="Support"):
    response = client.post(
        "/platform/prompts",
        json={"tenant_id": TENANT, "prompt_id": prompt_id, "name": name, "content": content},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_versions_are_allocated_not_supplied(client):
    first = _save(client, content="Be concise.")
    second = _save(client, content="Be extremely concise.")

    assert first["version"] == 1
    assert second["version"] == 2
    # The author never names a version; saving again is the whole interaction.
    assert first["content_hash"] != second["content_hash"]


def test_two_tenants_can_own_the_same_prompt_id_and_version(client):
    _save(client)

    act_as(client, "tenant-b")
    other = client.post(
        "/platform/prompts",
        json={"tenant_id": "tenant-b", "prompt_id": "support", "name": "Support", "content": "Be warm."},
    )

    # The key is tenant-qualified: a shared `support@1` must not collide.
    assert other.status_code == 201, other.text
    assert other.json()["version"] == 1


def test_a_tenant_cannot_list_another_tenants_prompts(client):
    _save(client)

    act_as(client, "tenant-b")
    listed = client.get("/platform/prompts")
    assert listed.status_code == 200
    assert listed.json() == []


def test_a_label_moves_and_rollback_is_just_moving_it_back(client):
    _save(client, content="Be concise.")
    _save(client, content="Be extremely concise.")

    promoted = client.put(
        "/platform/prompts/support/labels/production",
        json={"tenant_id": TENANT, "version": 2},
    )
    assert promoted.status_code == 200, promoted.text
    assert "production" in promoted.json()["labels"]

    rolled_back = client.put(
        "/platform/prompts/support/labels/production",
        json={"tenant_id": TENANT, "version": 1},
    )
    assert rolled_back.status_code == 200
    assert rolled_back.json()["version"] == 1
    assert "production" in rolled_back.json()["labels"]


def test_latest_cannot_be_assigned_because_it_is_derived(client):
    _save(client)
    refused = client.put(
        "/platform/prompts/support/labels/latest",
        json={"tenant_id": TENANT, "version": 1},
    )
    assert refused.status_code == 422


def test_a_digit_only_label_is_refused(client):
    _save(client)
    refused = client.put(
        "/platform/prompts/support/labels/2",
        json={"tenant_id": TENANT, "version": 1},
    )
    # A reference reads digits as a version, so such a label is unreachable.
    assert refused.status_code == 422


@pytest.mark.asyncio
async def test_latest_resolves_to_the_newest_version(store):
    """The branch the previous test only named."""

    await store.save_prompt_version(
        tenant_id=TENANT, prompt_id="support", name="Support", content="Be concise."
    )
    newest = await store.save_prompt_version(
        tenant_id=TENANT, prompt_id="support", name="Support", content="Be extremely concise."
    )

    resolved = await store.resolve_prompt_ref("support@latest", tenant_id=TENANT)
    assert resolved is not None
    assert resolved.version == newest.version == 2

    pinned = await store.resolve_prompt_ref("support@1", tenant_id=TENANT)
    assert pinned is not None and pinned.content == "Be concise."


def test_an_id_that_would_break_the_key_is_refused(client):
    response = client.post(
        "/platform/prompts",
        json={"tenant_id": TENANT, "prompt_id": "sup@port", "name": "x", "content": "y"},
    )
    # `@` and `:` separate the parts of the version key.
    assert response.status_code == 422


def test_empty_and_oversized_content_are_refused(client):
    empty = client.post(
        "/platform/prompts",
        json={"tenant_id": TENANT, "prompt_id": "support", "name": "x", "content": "   "},
    )
    assert empty.status_code == 422

    huge = client.post(
        "/platform/prompts",
        json={"tenant_id": TENANT, "prompt_id": "support", "name": "x", "content": "a" * 40_000},
    )
    assert huge.status_code == 422


@pytest.mark.parametrize("reference", ["support", "support@", "@1", ""])
def test_a_reference_without_a_version_or_label_is_invalid(reference):
    with pytest.raises(ValueError):
        parse_prompt_ref(reference)


@pytest.fixture
def auth_required(monkeypatch):
    from evalhub.settings import settings

    prior = settings.platform_auth_required
    settings.platform_auth_required = True
    check = AsyncMock(
        side_effect=lambda request, _permission: request.headers.get("x-evalai-sub")
        == "approver@example.com"
    )
    monkeypatch.setattr(authz, "check_permission", check)
    monkeypatch.setattr("evalhub.api.v1.platform.check_permission", check)
    yield
    settings.platform_auth_required = prior


def test_saving_needs_the_approver_role(client, auth_required):
    refused = client.post(
        "/platform/prompts",
        headers={
            "x-evalai-tenant": "a",
            "x-evalai-sub": "viewer@example.com",
            "x-evalai-roles": "eval-hub-viewer",
        },
        json={"tenant_id": TENANT, "prompt_id": "support", "name": "x", "content": "Be terse."},
    )
    assert refused.status_code == 403, refused.text


def test_moving_a_label_needs_the_approver_role(client, auth_required):
    refused = client.put(
        "/platform/prompts/support/labels/production",
        headers={
            "x-evalai-tenant": "a",
            "x-evalai-sub": "viewer@example.com",
            "x-evalai-roles": "eval-hub-viewer",
        },
        json={"tenant_id": TENANT, "version": 1},
    )
    # Repointing production is the action an incident review asks about.
    assert refused.status_code == 403, refused.text


def test_the_catalog_is_told_whether_it_may_manage_prompts(client, auth_required):
    granted = client.get(
        "/platform/capabilities",
        headers={
            "x-evalai-tenant": "evalai",
            "x-evalai-sub": "approver@example.com",
            "x-evalai-roles": "eval-hub-approver",
        },
    )
    denied = client.get(
        "/platform/capabilities",
        headers={
            "x-evalai-tenant": "evalai",
            "x-evalai-sub": "viewer@example.com",
            "x-evalai-roles": "eval-hub-viewer",
        },
    )
    assert granted.json()["actions"]["manage_prompts"] is True
    assert denied.json()["actions"]["manage_prompts"] is False


def test_a_prompt_carrying_a_credential_is_refused_not_scrubbed(client):
    secret = "You are support. Call the API with Bearer sk-live-abcdef123456 when asked."
    refused = client.post(
        "/platform/prompts",
        json={"tenant_id": TENANT, "prompt_id": "support", "name": "x", "content": secret},
    )
    assert refused.status_code == 422

    # And nothing was stored in a rewritten form: a prompt is executed verbatim,
    # so scrubbing it would send the model text its author never wrote.
    listed = client.get("/platform/prompts").json()
    assert listed == []


def test_listing_stays_a_bare_list_until_paging_is_asked_for(client):
    _save(client, content="one")
    _save(client, content="two")

    # The committed client and the comparison picker both assume every version
    # is visible; paging must be opt-in, never a silent truncation.
    bare = client.get("/platform/prompts").json()
    assert isinstance(bare, list)
    assert len(bare) == 2

    paged = client.get("/platform/prompts?limit=1").json()
    assert paged["total"] == 2
    assert len(paged["items"]) == 1
    assert paged["next_cursor"] == "1"

    second = client.get(f"/platform/prompts?limit=1&cursor={paged['next_cursor']}").json()
    assert len(second["items"]) == 1
    assert second["next_cursor"] is None
    assert second["items"][0]["version"] != paged["items"][0]["version"]


def _archive(client, prompt_id, version, *, tenant=TENANT):
    return client.delete(f"/platform/prompts/{prompt_id}/versions/{version}?tenant_id={tenant}")


def test_archiving_needs_the_approver_role(client, auth_required):
    refused = client.delete(
        "/platform/prompts/support/versions/1",
        headers={
            "x-evalai-tenant": "a",
            "x-evalai-sub": "viewer@example.com",
            "x-evalai-roles": "eval-hub-viewer",
        },
    )
    assert refused.status_code == 403, refused.text


def test_an_archived_version_leaves_the_catalog(client):
    _save(client)
    _save(client, content="Be very concise.")
    assert _archive(client, "support", 1).status_code == 200

    listed = client.get(f"/platform/prompts?tenant_id={TENANT}").json()
    assert [entry["version"] for entry in listed] == [2]


def test_an_archived_version_still_resolves_so_reruns_keep_working(client):
    """The whole reason this is an archive and not a delete."""

    _save(client)
    _archive(client, "support", 1)

    # A completed run cites `support@1`; replaying it must still find the text
    # it actually ran, not fail on a row that was tidied away.
    run = client.post(
        "/evaluation/from-dataset",
        json={
            "dataset_name": "missing-dataset",
            "prompt_version_ref": "support@1",
            "tenant_id": TENANT,
        },
    )
    assert run.status_code != 422 or "prompt" not in run.text.lower(), run.text


def test_archiving_drops_the_label_it_carried(client):
    _save(client)
    client.put(
        "/platform/prompts/support/labels/production",
        json={"tenant_id": TENANT, "version": 1},
    )
    archived = _archive(client, "support", 1)
    assert archived.status_code == 200
    # A retired version must not still be somebody's production.
    assert archived.json()["labels"] == []


def test_a_label_cannot_be_pointed_at_an_archived_version(client):
    _save(client)
    _archive(client, "support", 1)
    refused = client.put(
        "/platform/prompts/support/labels/production",
        json={"tenant_id": TENANT, "version": 1},
    )
    assert refused.status_code == 422, refused.text


def test_archiving_twice_keeps_the_first_timestamp(client):
    _save(client)
    first = _archive(client, "support", 1).json()
    second = _archive(client, "support", 1).json()
    # Idempotent: a double-click must not rewrite when the version was retired.
    assert first["archived_at"] == second["archived_at"]


def test_archiving_an_unknown_version_is_a_404(client):
    assert _archive(client, "support", 99).status_code == 404


async def test_latest_skips_an_archived_version(store):
    await store.save_prompt_version(
        tenant_id=TENANT, prompt_id="support", name="Support", content="v1"
    )
    await store.save_prompt_version(
        tenant_id=TENANT, prompt_id="support", name="Support", content="v2"
    )
    await store.archive_prompt_version(tenant_id=TENANT, prompt_id="support", version=2)

    latest = await store.resolve_prompt_ref("support@latest", tenant_id=TENANT)
    assert latest is not None and latest.version == 1
    # ...while the archived one is still reachable by number.
    pinned = await store.resolve_prompt_ref("support@2", tenant_id=TENANT)
    assert pinned is not None and pinned.content == "v2"


def test_an_invalid_id_explains_itself_in_a_shape_the_browser_can_show(client):
    """A bare-string detail is dropped by the BFF, so the user would see nothing.

    The proxy forwards a coded problem dict but deliberately refuses arbitrary
    string details, which may carry exception text. Raising the string form
    means "some information is invalid" and no clue which field or why.
    """

    refused = client.post(
        "/platform/prompts",
        json={"tenant_id": TENANT, "prompt_id": "support tone", "name": "x", "content": "Be terse."},
    )
    assert refused.status_code == 422, refused.text
    problem = refused.json()["detail"]
    assert isinstance(problem, dict), problem
    assert problem["field"] == "prompt_id"
    assert "alphanumeric" in problem["message"]
    assert "no spaces" in problem["recovery"]


def test_a_credential_refusal_also_names_its_field(client):
    refused = client.post(
        "/platform/prompts",
        json={
            "tenant_id": TENANT,
            "prompt_id": "support",
            "name": "x",
            "content": "Authorization: Bearer sk-live-abcdef1234567890abcdef",
        },
    )
    assert refused.status_code == 422, refused.text
    assert refused.json()["detail"]["field"] == "content"


def test_a_version_records_why_it_was_saved_and_when(client):
    """History needs more than a number.

    The row has always carried `description`, `created_by` and `created_at`, but
    `created_at` never reached the wire, so a version list could say "v3" and
    nothing else — not when it landed, nor what changed.
    """
    first = client.post(
        "/platform/prompts",
        json={
            "tenant_id": TENANT,
            "prompt_id": "support",
            "name": "Support",
            "content": "Be concise.",
            "description": "First cut.",
        },
    )
    assert first.status_code == 201, first.text
    second = client.post(
        "/platform/prompts",
        json={
            "tenant_id": TENANT,
            "prompt_id": "support",
            "name": "Support",
            "content": "Be concise. Cite sources.",
            "description": "Ask for citations.",
        },
    )
    assert second.status_code == 201, second.text

    listed = client.get(f"/platform/prompts?tenant_id={TENANT}&prompt_id=support").json()
    by_version = {entry["version"]: entry for entry in listed}
    assert by_version[1]["description"] == "First cut."
    assert by_version[2]["description"] == "Ask for citations."
    # Every version can say when it landed, so the history reads as a sequence.
    assert by_version[1]["created_at"]
    assert by_version[2]["created_at"]
    assert by_version[2]["created_by"]


def test_a_version_saved_without_a_note_simply_has_none(client):
    # The note is optional: requiring it would block the common case of a quick
    # fix, and an empty string reads as a note that says nothing.
    _save(client)
    listed = client.get(f"/platform/prompts?tenant_id={TENANT}&prompt_id=support").json()
    assert listed[0]["description"] is None


def test_paging_by_prompt_keeps_a_prompt_whole(client):
    """A page holds prompts, not versions.

    Slicing the flat version list splits a prompt across two pages: each page
    then reports a partial version count for it, and the page without the
    labelled version says it has no production version at all.
    """
    for index in range(3):
        _save(client, prompt_id=f"p{index}", name=f"Prompt {index}")
    # Give the first prompt more versions than a page holds.
    for text in ("Second.", "Third.", "Fourth."):
        _save(client, prompt_id="p0", content=text, name="Prompt 0")

    first = client.get(
        f"/platform/prompts?tenant_id={TENANT}&limit=2&paginate_by=prompt"
    ).json()
    assert first["total"] == 3, "total counts prompts, not versions"
    assert {entry["prompt_id"] for entry in first["items"]} == {"p0", "p1"}
    # Every version of p0 is on the page that holds p0.
    assert len([e for e in first["items"] if e["prompt_id"] == "p0"]) == 4

    second = client.get(
        f"/platform/prompts?tenant_id={TENANT}&limit=2&paginate_by=prompt"
        f"&cursor={first['next_cursor']}"
    ).json()
    assert {entry["prompt_id"] for entry in second["items"]} == {"p2"}
    assert second["next_cursor"] is None


def test_the_unpaged_list_is_unchanged(client):
    # The comparison picker assumes it can see every version; adding paging must
    # not quietly turn the default response into an envelope.
    _save(client)
    _save(client, content="Second.")
    listed = client.get(f"/platform/prompts?tenant_id={TENANT}").json()
    assert isinstance(listed, list)
    assert len(listed) == 2


def test_an_archived_prompt_does_not_hold_a_page_slot(client):
    """The id list and the version list must agree on what archiving hides.

    If `list_prompt_ids` counted archived-only prompts while the version query
    excluded them, a page would report a slot filled by a prompt with no rows —
    a visibly short page and a `total` nobody can reconcile.
    """
    _save(client, prompt_id="live", name="Live")
    _save(client, prompt_id="retired", name="Retired")
    archived = client.delete(f"/platform/prompts/retired/versions/1?tenant_id={TENANT}")
    assert archived.status_code == 200, archived.text

    page = client.get(
        f"/platform/prompts?tenant_id={TENANT}&limit=10&paginate_by=prompt"
    ).json()
    assert page["total"] == 1
    assert {entry["prompt_id"] for entry in page["items"]} == {"live"}


def test_the_page_size_is_bounded(client):
    # Every other list endpoint here caps `limit`; an uncapped one lets a single
    # request pull the whole catalog and every version of it.
    _save(client)
    assert client.get(f"/platform/prompts?tenant_id={TENANT}&limit=1000").status_code == 422
    assert client.get(f"/platform/prompts?tenant_id={TENANT}&limit=0").status_code == 422
    assert client.get(f"/platform/prompts?tenant_id={TENANT}&limit=50").status_code == 200


def test_an_unknown_paging_mode_is_refused(client):
    # A typo used to fall through to version paging and silently return the
    # wrong shape for an index that groups by prompt.
    _save(client)
    assert client.get(
        f"/platform/prompts?tenant_id={TENANT}&limit=5&paginate_by=promt"
    ).status_code == 422


def test_prompt_paging_still_honours_the_prompt_id_filter(client):
    # Without this the branch listed every prompt id, so asking for one prompt
    # could return whichever prompt happened to sort first.
    _save(client, prompt_id="alpha", name="Alpha")
    _save(client, prompt_id="support", name="Support")

    page = client.get(
        f"/platform/prompts?tenant_id={TENANT}&prompt_id=support&limit=1&paginate_by=prompt"
    ).json()
    assert page["total"] == 1
    assert {entry["prompt_id"] for entry in page["items"]} == {"support"}
    assert page["next_cursor"] is None


@pytest.mark.parametrize("paging", ["", "&limit=10", "&limit=10&paginate_by=prompt"])
def test_prompt_list_can_include_archived_versions_for_comparison(client, paging):
    _save(client, prompt_id="live", name="Live")
    _save(client, prompt_id="retired", name="Retired")
    assert _archive(client, "retired", 1).status_code == 200
    url = f"/platform/prompts?tenant_id={TENANT}{paging}"

    default = client.get(url)
    assert default.status_code == 200
    default_rows = default.json()["items"] if paging else default.json()
    assert [row["prompt_id"] for row in default_rows] == ["live"]

    included = client.get(f"{url}&include_archived=true")
    assert included.status_code == 200
    rows = included.json()["items"] if paging else included.json()
    assert {row["prompt_id"] for row in rows} == {"live", "retired"}
    assert next(row for row in rows if row["prompt_id"] == "retired")["archived_at"] is not None
    if paging:
        assert default.json()["total"] == 1
        assert included.json()["total"] == 2
