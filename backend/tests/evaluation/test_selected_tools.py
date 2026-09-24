"""Selected-tools evaluation level (level 2): scope a tool_interactions run to named tools.

``selected_tool_ids`` must persist through readiness → execution → lineage →
reports → reruns → comparison basis. Unselected tools' calls are excluded from
scoring but never fabricated as absent-in-capture.
"""

from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import update

from evalhub.api.dependencies import get_registry_service
from evalhub.db.models import EvaluationRunORM, RunJobORM
from evalhub.db.session import async_session
from evalhub.db.store import EvaluationStore
from evalhub.evaluation.adapters import build_judge
from evalhub.evaluation.engine import EvaluationEngine, scoped_row_for_tool_selection
from evalhub.evaluation.enums import (
    EvaluationScope,
    EvidenceReadiness,
    MetricStatus,
    Scenario,
    TriggerReason,
    UnscoredReason,
    VerdictStatus,
)
from evalhub.evaluation.lineage import (
    build_lineage,
    compute_comparison_basis_hash,
    compute_experiment_version_id,
)
from evalhub.evaluation.models import (
    EvaluationRow,
    ExperimentDefinition,
    ToolCall,
)
from evalhub.evaluation.readiness import assess_evidence_readiness
from evalhub.evaluation.run_service import tool_context_texts
from evalhub.evaluation.sample_data import SAMPLE_EXPERIMENTS, get_sample_rows
from evalhub.evaluation.scenario_router import build_evaluator_configs
from evalhub.evaluation.target.discovery import AgentSummary
from evalhub.main import app
from evalhub.settings import Settings, settings

TENANT = "tenant-selected-tools"


def _settings(**overrides) -> Settings:
    return Settings(
        database_url="sqlite+aiosqlite://",
        pod_namespace="tenant-test",
        kagent_url="http://kagent.test",
        openai_base_url="http://gateway.test/v1",
        **overrides,
    )


def _records() -> list[dict]:
    return [{"inputs": {"query": "q"}, "expectations": {"response": "a"}}]


def _agent(tools: list[str] | None = None, agent_type: str = "Declarative") -> AgentSummary:
    return AgentSummary(
        id="tenant-test/agent",
        name="agent",
        namespace="tenant-test",
        ready=True,
        accepted=True,
        revision="revision-1",
        agent_type=agent_type,
        tools=tools or [],
    )


def _patch_agents(monkeypatch, agent: AgentSummary) -> None:
    async def _agents(**kwargs):  # noqa: ARG001
        return [agent]

    monkeypatch.setattr("evalhub.evaluation.readiness.list_tenant_agents", _agents)


async def _assess(*, selected_tool_ids=None, tools=None, agent_type="Declarative", scope=EvaluationScope.TOOL_INTERACTIONS, settings_obj=None):
    return await assess_evidence_readiness(
        response_source="agent",
        evaluation_scope=scope,
        agent="tenant-test/agent",
        target_model=None,
        target_endpoint=None,
        records=_records(),
        active_metric_ids=["agent.tool_selection", "llm.relevance"],
        scenario=Scenario.AGENTIC,
        settings=settings_obj or _settings(tool_evidence_completion_manifest_available=True),
        selected_tool_ids=selected_tool_ids,
    )


# ---------------------------------------------------------------------------
# Readiness
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_readiness_reports_agent_tool_inventory(monkeypatch):
    _patch_agents(monkeypatch, _agent(tools=["search", "calculator"]))
    result = await _assess()
    assert result.status == EvidenceReadiness.READY
    assert result.agent_tools == ["search", "calculator"]
    assert result.selected_tool_ids is None


@pytest.mark.asyncio
async def test_readiness_accepts_a_valid_tool_selection(monkeypatch):
    _patch_agents(monkeypatch, _agent(tools=["search", "calculator"]))
    result = await _assess(selected_tool_ids=["search"])
    assert result.status == EvidenceReadiness.READY
    assert result.selected_tool_ids == ["search"]
    assert result.agent_tools == ["search", "calculator"]


@pytest.mark.asyncio
async def test_readiness_blocks_unknown_selected_tools_naming_them(monkeypatch):
    _patch_agents(monkeypatch, _agent(tools=["search"]))
    result = await _assess(selected_tool_ids=["search", "nuke_db"])
    assert result.status == EvidenceReadiness.BLOCKED
    assert result.details[0].code == "selected_tools_unknown"
    assert "nuke_db" in result.details[0].message
    # The inventory is still reported so the caller can correct the selection.
    assert result.agent_tools == ["search"]


@pytest.mark.asyncio
async def test_readiness_blocks_selection_when_tool_inventory_is_unknown(monkeypatch):
    # A BYO agent does not declare tools; a named selection cannot be verified.
    _patch_agents(monkeypatch, _agent(tools=[], agent_type="BYO"))
    result = await _assess(selected_tool_ids=["search"])
    assert result.status in {EvidenceReadiness.BLOCKED, EvidenceReadiness.UNSUPPORTED}
    codes = {detail.code for detail in result.details}
    # Either the honest "cannot verify" blocker or the pre-existing BYO
    # tool-capture unsupported blocker is acceptable; both stop the run.
    assert codes & {"selected_tools_unverifiable", "agent_tool_capture_unsupported"}


# ---------------------------------------------------------------------------
# API contract
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_selected_tools_require_tool_interactions_scope():
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": "tenant-test"}
    ) as ac:
        response = await ac.post(
            "/evaluation/runs/from-dataset/test_ds",
            json={
                "response_source": "agent",
                "agent": "ns/a",
                "evaluation_scope": "final_response",
                "selected_tool_ids": ["search"],
            },
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert detail["code"] == "selected_tools_scope_mismatch"
        assert detail["field"] == "selected_tool_ids"


@pytest.mark.asyncio
async def test_empty_selected_tools_are_rejected():
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": "tenant-test"}
    ) as ac:
        response = await ac.post(
            "/evaluation/runs/from-dataset/test_ds",
            json={
                "response_source": "agent",
                "agent": "ns/a",
                "evaluation_scope": "tool_interactions",
                "selected_tool_ids": [],
            },
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert detail["code"] == "selected_tools_empty"
        assert detail["field"] == "selected_tool_ids"


@pytest.mark.asyncio
async def test_readiness_endpoint_reports_tools_and_unknown_selection(monkeypatch):
    _patch_agents(monkeypatch, _agent(tools=["search", "calculator"]))
    monkeypatch.setattr(settings, "tool_evidence_completion_manifest_available", True)
    mock_svc = MagicMock()
    mock_svc.get_dataset.return_value = MagicMock(status="PUBLISHED", version_number=1, tenant_id="tenant-test")
    mock_svc.get_records.return_value = _records()
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": "tenant-test"}
    ) as ac:
            ready = await ac.post(
                "/evaluation/runs/from-dataset/test_ds/readiness",
                json={
                    "response_source": "agent",
                    "agent": "tenant-test/agent",
                    "evaluation_scope": "tool_interactions",
                    "selected_tool_ids": ["search"],
                },
            )
            assert ready.status_code == 200
            payload = ready.json()
            assert payload["status"] == "ready"
            assert payload["agent_tools"] == ["search", "calculator"]
            assert payload["selected_tool_ids"] == ["search"]

            unknown = await ac.post(
                "/evaluation/runs/from-dataset/test_ds",
                json={
                    "response_source": "agent",
                    "agent": "tenant-test/agent",
                    "evaluation_scope": "tool_interactions",
                    "selected_tool_ids": ["ghost_tool"],
                },
            )
            assert unknown.status_code == 422
            detail = unknown.json()["detail"]
            assert detail["code"] == "selected_tools_unknown"
            assert "ghost_tool" in detail["message"]
            assert detail["field"] == "selected_tool_ids"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_create_run_persists_selection_in_job_snapshot(monkeypatch):
    _patch_agents(monkeypatch, _agent(tools=["search", "calculator"]))
    monkeypatch.setattr(settings, "tool_evidence_completion_manifest_available", True)
    mock_svc = MagicMock()
    mock_svc.get_dataset.return_value = MagicMock(status="PUBLISHED", version_number=1, tenant_id="tenant-test")
    mock_svc.get_records.return_value = _records()
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": "tenant-test"}
    ) as ac:
            created = await ac.post(
                "/evaluation/runs/from-dataset/test_ds",
                json={
                    "response_source": "agent",
                    "agent": "tenant-test/agent",
                    "evaluation_scope": "tool_interactions",
                    "selected_tool_ids": ["search"],
                },
            )
            assert created.status_code == 202, created.text
            body = created.json()
            assert body["selected_tool_ids"] == ["search"]
        async with async_session() as session:
            job = await EvaluationStore(session).get_run_job(body["run_id"])
        snapshot = job.params["evidence_readiness"]
        assert snapshot["selected_tool_ids"] == ["search"]
        assert snapshot["agent_tools"] == ["search", "calculator"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_exact_rerun_replays_the_historical_tool_selection():
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": TENANT}
    ) as ac:
        created = await ac.post(
            "/evaluation/runs",
            json={
                "experiment_id": "exp-llm-core-v1",
                "name": "selected-tools rerun source",
                "dataset_version": "general_qa_v1",
                "target_endpoint": "https://example.com",
                "scenario": "llm_core",
                "row_count": 1,
                "tenant_id": TENANT,
            },
        )
        assert created.status_code == 201, created.text
        run_id = created.json()["run_id"]
        async with async_session() as session:
            orm = await session.get(EvaluationRunORM, run_id)
            orm.lineage = {
                **(orm.lineage or {}),
                "requested_evaluation_scope": "tool_interactions",
                "selected_tool_ids": ["search"],
            }
            await session.commit()

        # A client-supplied selection that differs from the recorded one is rejected.
        mismatch = await ac.post(
            "/evaluation/runs/from-dataset/test_ds",
            json={
                "response_source": "agent",
                "agent": "ns/a",
                "exact_rerun": True,
                "source_run_id": run_id,
                "evaluation_scope": "tool_interactions",
                "selected_tool_ids": ["calculator"],
            },
        )
        assert mismatch.status_code == 422
        assert mismatch.json()["detail"]["code"] == "exact_rerun_selected_tools_mismatch"

        # Echoing the recorded selection is accepted as a replay (it then flows
        # into normal readiness, which fails on the unresolvable agent here).
        echoed = await ac.post(
            "/evaluation/runs/from-dataset/test_ds",
            json={
                "response_source": "agent",
                "agent": "ns/a",
                "exact_rerun": True,
                "source_run_id": run_id,
                "evaluation_scope": "tool_interactions",
                "selected_tool_ids": ["search"],
            },
        )
        assert echoed.status_code != 422 or (
            echoed.json()["detail"].get("code") != "exact_rerun_selected_tools_mismatch"
        )


# ---------------------------------------------------------------------------
# Lineage + comparison basis
# ---------------------------------------------------------------------------


def _exp_rows_metrics():
    exp = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows("exp-llm-core-v1")
    metrics, _configs, _kpis = build_evaluator_configs(exp)
    return exp, rows, [m.metric_id for m in metrics]


def test_comparison_basis_distinguishes_tool_selections():
    exp, rows, ids = _exp_rows_metrics()
    base = compute_comparison_basis_hash(exp, rows, ids)

    scoped = exp.model_copy(update={"selected_tool_ids": ["search"]})
    other = exp.model_copy(update={"selected_tool_ids": ["calculator"]})
    empty = exp.model_copy(update={"selected_tool_ids": []})

    scoped_hash = compute_comparison_basis_hash(scoped, rows, ids)
    other_hash = compute_comparison_basis_hash(other, rows, ids)
    empty_hash = compute_comparison_basis_hash(empty, rows, ids)

    assert scoped_hash != base
    assert other_hash != base
    assert scoped_hash != other_hash
    # None (whole tool layer) and [] remain distinct bases.
    assert empty_hash != base

    # Selection order does not change the basis (sorted list).
    ab = exp.model_copy(update={"selected_tool_ids": ["a", "b"]})
    ba = exp.model_copy(update={"selected_tool_ids": ["b", "a"]})
    assert compute_comparison_basis_hash(ab, rows, ids) == compute_comparison_basis_hash(ba, rows, ids)


def test_unselected_runs_keep_their_pre_existing_v2_basis():
    # Adding the selected-tools axis must not re-fingerprint runs that do not
    # use it: with selected_tool_ids=None the payload carries no selection key,
    # so existing v2 hashes stay valid.
    exp, rows, ids = _exp_rows_metrics()
    assert exp.selected_tool_ids is None
    explicit_none = exp.model_copy(update={"selected_tool_ids": None})
    assert compute_comparison_basis_hash(exp, rows, ids) == compute_comparison_basis_hash(explicit_none, rows, ids)


def test_lineage_records_selected_tool_ids():
    exp, _rows, ids = _exp_rows_metrics()
    scoped = exp.model_copy(update={"selected_tool_ids": ["search", "calculator"]})
    version_id = compute_experiment_version_id(scoped, ids)
    lineage = build_lineage(scoped, settings, version_id)
    assert lineage.selected_tool_ids == ["search", "calculator"]
    # And the experiment fingerprint reflects the selection.
    assert version_id != compute_experiment_version_id(exp, ids)


# ---------------------------------------------------------------------------
# Execution scoping
# ---------------------------------------------------------------------------


def _agent_row(**kwargs) -> EvaluationRow:
    base = dict(
        row_id="r1",
        query="q",
        response="a",
        from_agent=True,
        trace_unavailable=False,
        tool_evidence_completion_attested=True,
    )
    base.update(kwargs)
    return EvaluationRow(**base)


def test_scoped_row_filters_tool_calls_and_expectations_without_mutating_capture():
    row = _agent_row(
        expected_tools=["search", "calculator"],
        tool_calls=[
            ToolCall(name="search", args={"q": "x"}, output={"hits": 1}),
            ToolCall(name="calculator", args={"a": 1}, output=2),
        ],
    )
    scoped = scoped_row_for_tool_selection(row, ["search"])
    assert [tc.name for tc in scoped.tool_calls] == ["search"]
    assert scoped.expected_tools == ["search"]
    # Capture on the original row is untouched — honesty over convenience.
    assert [tc.name for tc in row.tool_calls] == ["search", "calculator"]
    assert row.expected_tools == ["search", "calculator"]
    # No selection means no change.
    assert scoped_row_for_tool_selection(row, None) is row


def test_scoped_row_filters_structured_expected_tool_calls():
    row = _agent_row(
        expected_tools=["search", "calculator"],
        expected_data={
            "expected_tool_calls": [
                {"name": "search", "args": {"q": "x"}},
                {"name": "calculator", "args": {"a": 1}},
            ]
        },
        tool_calls=[ToolCall(name="search", args={"q": "x"})],
    )
    scoped = scoped_row_for_tool_selection(row, ["search"])
    assert scoped.expected_data["expected_tool_calls"] == [{"name": "search", "args": {"q": "x"}}]


def test_engine_scores_only_the_selected_tools():
    # The agent called an unselected tool (calculator) and the golden row also
    # expects an unselected tool: neither may affect scoring when the run is
    # scoped to ["search"].
    experiment = ExperimentDefinition(
        name="selected-tools",
        dataset_version="ds.v1",
        target_endpoint="tenant/agent",
        scenario=Scenario.AGENTIC,
        selected_tool_ids=["search"],
        evaluation_scope=EvaluationScope.TOOL_INTERACTIONS,
    )
    row = _agent_row(
        expected_tools=["search", "calculator"],
        tool_calls=[
            ToolCall(name="search", args={"q": "x"}, output={"hits": 1}, result_captured=True),
            ToolCall(name="wanderer", args={}, output=None, result_captured=True),
        ],
    )
    engine = EvaluationEngine(judge=build_judge())
    result = engine.execute(
        experiment,
        [row],
        "run-selected-tools",
        TriggerReason.MANUAL,
        None,
        0,
        None,
        ["agent.tool_call_accuracy", "agent.tool_selection"],
    )
    by_metric = {mr.metric_id: mr for mr in result.metric_results}
    # tool_call_accuracy: the unselected expected tool (calculator) is out of
    # scope, and the selected tool was called — pass.
    accuracy = by_metric["agent.tool_call_accuracy"]
    assert accuracy.score == 1.0, accuracy.rationale
    # tool_selection: the out-of-scope "wanderer" call is excluded from the
    # wandering check — pass.
    selection = by_metric["agent.tool_selection"]
    assert selection.score == 1.0, selection.rationale
    # Lineage carries the selection for reports and rerun replay.
    assert result.lineage.selected_tool_ids == ["search"]
    # Captured evidence still records every call honestly.
    assert [tc.name for tc in row.tool_calls] == ["search", "wanderer"]


def test_scoping_away_every_expected_tool_goes_unscored_not_conclusive():
    # #3029 disclosure case: the golden row DOES declare expected tools, but the
    # run is scoped to a disjoint selection, so the scoped row's expectation is
    # empty. That must read as missing evidence for the scoped claim — UNSCORED
    # and a non-conclusive run — never as the old vacuous 1.0 (tool_call_accuracy,
    # the false-green direction) or the vacuous 0.0 (tool_selection).
    experiment = ExperimentDefinition(
        name="scoped-to-empty",
        dataset_version="ds.v1",
        target_endpoint="tenant/agent",
        scenario=Scenario.AGENTIC,
        selected_tool_ids=["search"],
        evaluation_scope=EvaluationScope.TOOL_INTERACTIONS,
    )
    row = _agent_row(
        expected_tools=["calculator"],
        tool_calls=[
            ToolCall(name="search", args={"q": "x"}, output={"hits": 1}, result_captured=True),
        ],
    )
    result = EvaluationEngine(judge=build_judge()).execute(
        experiment,
        [row],
        "run-scoped-to-empty",
        TriggerReason.MANUAL,
        None,
        0,
        None,
        ["agent.tool_selection", "agent.tool_call_accuracy"],
    )
    for metric in result.metric_results:
        assert metric.metric_status == MetricStatus.UNSCORED, metric.metric_id
        assert metric.unscored_reason == UnscoredReason.EVIDENCE_UNAVAILABLE
        assert metric.score is None
    assert result.verdict_status == VerdictStatus.INCONCLUSIVE
    assert result.overall_gate is None


def test_engine_without_selection_still_fails_on_wandering_tools():
    experiment = ExperimentDefinition(
        name="whole-tool-layer",
        dataset_version="ds.v1",
        target_endpoint="tenant/agent",
        scenario=Scenario.AGENTIC,
        evaluation_scope=EvaluationScope.TOOL_INTERACTIONS,
    )
    row = _agent_row(
        expected_tools=["search"],
        tool_calls=[
            ToolCall(name="search", args={}, output=None, result_captured=True),
            ToolCall(name="wanderer", args={}, output=None, result_captured=True),
        ],
    )
    result = EvaluationEngine(judge=build_judge()).execute(
        experiment,
        [row],
        "run-whole-layer",
        TriggerReason.MANUAL,
        None,
        0,
        None,
        ["agent.tool_selection"],
    )
    selection = next(mr for mr in result.metric_results if mr.metric_id == "agent.tool_selection")
    assert selection.score == 0.0
    assert result.lineage.selected_tool_ids is None


def test_tool_context_texts_filters_to_selected_tools():
    calls = [
        ToolCall(name="search", args={}, output={"hits": 1}),
        ToolCall(name="calculator", args={}, output=42),
        ToolCall(name="empty", args={}, output=None),
    ]
    assert tool_context_texts(calls, None) == ['{"hits": 1}', "42"]
    assert tool_context_texts(calls, ["search"]) == ['{"hits": 1}']
    assert tool_context_texts(calls, ["SEARCH"]) == ['{"hits": 1}']


# ---------------------------------------------------------------------------
# Worker revalidation via the readiness snapshot
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_worker_revalidation_reads_selection_from_snapshot(monkeypatch):
    # The launch snapshot is the only carrier of the selection into the worker;
    # revalidation must re-check it against the re-resolved agent inventory.
    _patch_agents(monkeypatch, _agent(tools=["calculator"]))  # search vanished
    result = await _assess(selected_tool_ids=["search"])
    assert result.status == EvidenceReadiness.BLOCKED
    assert result.details[0].code == "selected_tools_unknown"


async def _clear_pending() -> None:
    async with async_session() as s:
        await s.execute(update(RunJobORM).values(status="completed"))
        await s.commit()
