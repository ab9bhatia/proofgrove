"""Requirement resolution for readiness: user selections are never contract-locked.

Only quality-contract / manifest-pinned requirements are immutable-required.
A metric that appears in the resolved set merely because the user explicitly
selected it is a clearable choice: the readiness/requirements payload must not
claim it is required (the FE locks required metrics, which would make the
draft unrecoverable when the selection is not applicable).
"""

from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from proofgrove.api.dependencies import get_registry_service
from proofgrove.evaluation.enums import (
    EvaluationScope,
    MetricRequirement,
    MetricRequirementSource,
    Scenario,
)
from proofgrove.main import app
from proofgrove.platform.contracts import (
    EvaluationProject,
    QualityProfileVersion,
    TargetType,
    TargetVersion,
    VersionLifecycle,
)
from proofgrove.platform.resolver import resolve_run_manifest, resolve_scoring_configuration


def test_explicitly_selected_non_default_metric_resolves_optional_not_required():
    # rag.groundedness is not part of the llm_core defaults; selecting it is a
    # user choice, so it must not be frozen as required (contract-locked).
    configuration = resolve_scoring_configuration(
        metric_ids=["llm.relevance", "rag.groundedness"],
        explicit_metric_ids={"llm.relevance", "rag.groundedness"},
        scenario=Scenario.LLM_CORE,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
    )

    rows = {item.metric_id: item for item in configuration.metric_requirements}
    assert rows["rag.groundedness"].requirement == MetricRequirement.OPTIONAL
    assert rows["rag.groundedness"].source == MetricRequirementSource.EXPLICIT_SELECTION
    # A scenario-default metric keeps its (legacy-default) required gate even
    # when explicitly selected — its source still records the user choice.
    assert rows["llm.relevance"].requirement == MetricRequirement.REQUIRED
    assert rows["llm.relevance"].source == MetricRequirementSource.EXPLICIT_SELECTION


def test_manifest_pinned_selection_stays_required():
    # Metrics pinned by an approved quality profile are contract requirements:
    # they remain immutable-required even though they are "explicitly selected".
    project = EvaluationProject(
        project_id="proj-1",
        tenant_id="tenant-a",
        name="Claims",
        system_type="agent",
        owner="qa",
    )
    target = TargetVersion(
        target_version_id="tv-1",
        target_id="tgt-1",
        tenant_id="tenant-a",
        project_id="proj-1",
        name="claims-agent",
        version="1.0.0",
        target_type=TargetType.AGENT,
        endpoint="https://example.com/agent",
    )
    profile = QualityProfileVersion(
        profile_id="qp-1",
        tenant_id="tenant-a",
        project_id="proj-1",
        name="claims-profile",
        version="1.0.0",
        status=VersionLifecycle.APPROVED,
        scenario=Scenario.AGENTIC,
        metric_ids=["agent.task_adherence"],
    )
    manifest = resolve_run_manifest(
        project=project,
        target=target,
        profile=profile,
        gate_policy=None,
        benchmark_package_id=None,
        benchmark_package_version=None,
        benchmark_family=None,
        judge_config={},
        resolved_by="test",
        evaluation_scope=EvaluationScope.TOOL_INTERACTIONS,
    )

    row = next(
        item
        for item in manifest.metric_requirements
        if item.metric_id == "agent.task_adherence"
    )
    assert row.requirement == MetricRequirement.REQUIRED
    assert row.source == MetricRequirementSource.EXPLICIT_SELECTION


@pytest.mark.asyncio
async def test_readiness_reports_explicitly_selected_not_applicable_metric_as_clearable():
    # Baseline source + chat dataset: rag.groundedness is known-not-applicable.
    # Readiness must succeed and must NOT mark the user selection as required —
    # otherwise the UI locks a metric the user can never satisfy or clear.
    mock_svc = MagicMock()
    mock_svc.get_dataset.return_value = MagicMock(
        tenant_id="tenant-a",
        status="PUBLISHED", version_number=1
    )
    mock_svc.get_records.return_value = [
        {"inputs": {"query": "q"}, "expectations": {"response": "a"}}
    ]
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(
        transport=transport, base_url="http://test", headers={"x-evalai-tenant": "tenant-a"}
    ) as ac:
            resp = await ac.post(
                "/evaluation/runs/from-dataset/test_ds/readiness",
                json={
                    "response_source": "baseline",
                    "active_metrics": ["llm.relevance", "rag.groundedness"],
                },
            )
            assert resp.status_code == 200, resp.text
            payload = resp.json()
            assert payload["status"] == "ready"

            requirements = {
                row["metric_id"]: row for row in payload["metric_requirements"]
            }
            groundedness = requirements["rag.groundedness"]
            assert groundedness["source"] == "explicit_selection"
            assert groundedness["requirement"] == "optional"

            applicability = {
                row["metric_id"]: row for row in payload["metric_applicability"]
            }
            assert (
                applicability["rag.groundedness"]["applicability"]
                == "known_not_applicable"
            )
            assert all(
                detail["code"] != "contract_metric_not_applicable"
                for detail in payload["details"]
            )
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_readiness_only_considers_rows_the_row_count_limit_will_run():
    """Readiness must mirror run_service.execute_dataset_run's own slice.

    The worker applies ``records[:row_count]`` before scoring (same order, same
    limit) -- a row beyond that limit must neither block nor qualify a run that
    will never touch it.
    """
    mock_svc = MagicMock()
    mock_svc.get_dataset.return_value = MagicMock(
        status="PUBLISHED", version_number=1, tenant_id="tenant-readiness-limit"
    )
    mock_svc.get_records.return_value = [
        {"inputs": {"query": "q1"}, "expectations": {"answer": "a1"}},
        {"inputs": {"query": "q2"}, "expectations": {"answer": "a2"}},
        # Beyond a row_count=2 limit: no usable input. Must not be examined.
        {"inputs": {}, "expectations": {}},
    ]
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport,
            base_url="http://test",
            headers={"x-evalai-tenant": "tenant-readiness-limit"},
        ) as ac:
            limited = await ac.post(
                "/evaluation/runs/from-dataset/test_ds/readiness",
                json={"response_source": "baseline", "row_count": 2},
            )
            assert limited.status_code == 200, limited.text
            assert limited.json()["status"] == "ready"

            unlimited = await ac.post(
                "/evaluation/runs/from-dataset/test_ds/readiness",
                json={"response_source": "baseline"},
            )
            assert unlimited.status_code == 200, unlimited.text
            assert unlimited.json()["status"] == "blocked"
            codes = {detail["code"] for detail in unlimited.json()["details"]}
            assert "dataset_input_missing" in codes
    finally:
        app.dependency_overrides.clear()
