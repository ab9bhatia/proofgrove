"""An Assignment's manifest owns its checks, and says so instead of winning quietly."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from proofgrove.api.v1.evaluation import DatasetRunRequest, _refuse_manifest_owned_overrides


def _manifest(metric_ids):
    return SimpleNamespace(metric_ids=metric_ids)


def test_supplying_different_checks_alongside_an_assignment_is_refused():
    """Previously the manifest replaced the request and only recorded the difference.

    The caller got a run scored against checks it never chose, with its own
    selection filed away as `requested_active_metrics`. The UI hid this by
    disabling the field, so only non-UI callers were misled.
    """
    with pytest.raises(HTTPException) as raised:
        _refuse_manifest_owned_overrides(
            DatasetRunRequest(active_metrics=["llm.correctness"]),
            _manifest(["quality.groundedness"]),
        )
    assert raised.value.status_code == 422
    assert raised.value.detail["code"] == "assignment_owns_active_metrics"


def test_echoing_the_manifest_is_allowed():
    """Sending the same list is not a conflict, so a client may round-trip it."""
    _refuse_manifest_owned_overrides(
        DatasetRunRequest(active_metrics=["quality.groundedness"]),
        _manifest(["quality.groundedness"]),
    )


def test_omitting_checks_under_an_assignment_is_the_normal_path():
    _refuse_manifest_owned_overrides(DatasetRunRequest(), _manifest(["quality.groundedness"]))


def test_ungoverned_runs_still_choose_their_own_checks():
    _refuse_manifest_owned_overrides(DatasetRunRequest(active_metrics=["llm.correctness"]), None)



@pytest.mark.asyncio
async def test_direct_run_uses_the_tenant_pinned_manifest():
    from unittest.mock import AsyncMock

    from fastapi import Request

    from proofgrove.api.v1.evaluation import create_run
    from proofgrove.evaluation.engine import EvaluationEngine
    from proofgrove.evaluation.judge import MockJudge
    from proofgrove.evaluation.models import EvaluationRow, ExperimentDefinition
    from proofgrove.platform.contracts import ResolvedRunManifest

    manifest = ResolvedRunManifest(
        manifest_id="pinned", manifest_hash="hash", tenant_id="tenant-own", project_id="project",
        target_version_id="target-version", target_id="target", target_version="1",
        target_endpoint="https://pinned.example.test", target_type="endpoint", environment="test",
        quality_profile_id="profile", quality_profile_version="1", scenario="llm_core",
        metric_ids=["ops.latency"], evaluation_scope="final_response",
    )
    experiment = ExperimentDefinition(
        experiment_id="experiment", name="candidate", dataset_version="1", tenant_id="tenant-own",
        target_endpoint="https://override.example.test", scenario="rag", run_manifest_id="pinned",
    )
    store = SimpleNamespace(
        get_rows=AsyncMock(return_value=[EvaluationRow(row_id="row", query="q", response="a")]),
        get_run_manifest=AsyncMock(return_value=manifest), get_run=AsyncMock(),
    )
    async def save(result, rows):
        store.get_run.return_value = result
    store.save_run = AsyncMock(side_effect=save)
    request = Request({"type": "http", "headers": [(b"x-evalai-tenant", b"tenant-own")]})
    engine = EvaluationEngine(judge=MockJudge())
    result = await create_run(experiment, request, store=store, engine=engine)
    store.get_run_manifest.assert_awaited_once_with("pinned", "tenant-own")
    assert result["active_metrics"] == ["ops.latency"]
    assert result["experiment"]["target_endpoint"] == manifest.target_endpoint
    assert result["experiment"]["scenario"] == "llm_core"
    assert result["run_manifest_id"] == "pinned"
    store.get_run_manifest.return_value = None
    store.save_run.reset_mock()
    with pytest.raises(HTTPException) as refused:
        await create_run(experiment, request, store=store, engine=engine)
    assert refused.value.status_code == 409
    store.save_run.assert_not_awaited()
