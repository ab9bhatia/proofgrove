"""A Quality Profile reaches "tested" on evidence, not on its author's word."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from proofgrove.api.v1.platform import _dry_run_evidence
from proofgrove.evaluation.enums import MetricStatus, RunStatus

TENANT = "tenant-a"


def _store(run=None, profile_metric_ids=("llm.correctness",)):
    """Minimal stand-in: the helper only reads a run and a profile."""

    class _Store:
        async def get_run(self, run_id, tenant_id=None):
            return run

        async def get_quality_profile(self, profile_id, version, tenant_id=None):
            return SimpleNamespace(metric_ids=list(profile_metric_ids))

    return _Store()


def _run(metric_ids, status=RunStatus.COMPLETED, run_id="run-1"):
    return SimpleNamespace(
        run_id=run_id,
        status=status,
        metric_results=[
            SimpleNamespace(metric_id=m, metric_status=MetricStatus.SCORED) for m in metric_ids
        ],
    )


async def _call(store, source_run_id="run-1"):
    return await _dry_run_evidence("profile-1", "1.0.0", TENANT, source_run_id, store)


@pytest.mark.asyncio
async def test_a_run_that_scored_the_checks_evidences_the_dry_run():
    assert await _call(_store(_run(["llm.correctness"]))) == "run-1"


@pytest.mark.asyncio
async def test_tested_without_a_run_is_refused():
    with pytest.raises(HTTPException) as raised:
        await _call(_store(), source_run_id=None)
    assert raised.value.detail["code"] == "dry_run_required"


@pytest.mark.asyncio
async def test_a_run_from_another_workspace_reads_as_missing():
    # get_run is tenant-scoped, so another tenant's run returns None rather than
    # leaking that it exists.
    with pytest.raises(HTTPException) as raised:
        await _call(_store(None))
    assert raised.value.detail["code"] == "dry_run_not_found"


@pytest.mark.asyncio
async def test_an_unfinished_run_cannot_evidence_anything_yet():
    with pytest.raises(HTTPException) as raised:
        await _call(_store(_run(["llm.correctness"], status=RunStatus.RUNNING)))
    assert raised.value.detail["code"] == "dry_run_incomplete"


@pytest.mark.asyncio
async def test_a_run_missing_the_evidence_names_the_checks_it_did_not_score():
    with pytest.raises(HTTPException) as raised:
        await _call(_store(_run([]), profile_metric_ids=("llm.correctness",)))
    detail = raised.value.detail
    assert detail["code"] == "dry_run_missing_evidence"
    assert "llm.correctness" in detail["message"]


@pytest.mark.asyncio
async def test_a_check_no_run_can_score_routes_to_the_override_instead():
    """Otherwise a Profile carrying one would be permanently unapprovable.

    The content-safety metrics are `available_in_run=False` until the red-team
    lane exists, so refusing them the same way as missing evidence would leave
    no route to approval at all.
    """
    with pytest.raises(HTTPException) as raised:
        await _call(_store(_run([]), profile_metric_ids=("safety.violence",)))
    detail = raised.value.detail
    assert detail["code"] == "dry_run_unscoreable_checks"
    assert "override" in detail["recovery"]
