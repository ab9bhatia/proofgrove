"""Tests for async run execution: job queue, worker, and the 202 endpoint."""

import asyncio
from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import update

from evalhub import runs_worker
from evalhub.api.dependencies import get_registry_service
from evalhub.db.models import EvaluationRunORM, RunJobORM
from evalhub.db.session import async_session
from evalhub.db.store import EvaluationStore
from evalhub.evaluation.enums import EvaluationScope, EvidenceReadiness
from evalhub.evaluation.models import EvidenceReadinessResult, ReadinessDetail
from evalhub.evaluation.readiness import ReadinessBlockedError, scope_options
from evalhub.main import app

# Run read endpoints require a tenant. In-flight async jobs are not yet
# tenant-attributed, so any non-empty tenant satisfies the query param here.
TENANT = "tenant-async"


def test_tool_depth_explains_zero_tool_metric_applicability():
    """Capture can be available while tool checks are honestly N/A for zero tools."""
    readiness = EvidenceReadinessResult(
        status=EvidenceReadiness.READY,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
        agent_tools=[],
    )

    option = next(
        item
        for item in scope_options(
            response_source="agent",
            tool_completion_available=True,
            agent_tools=readiness.agent_tools,
        )
        if item["scope"] == "tool_interactions"
    )

    assert option["available"] is True
    assert option["caveat"] == ("Capture is available, but this agent declares no tools; tool-specific checks are not applicable.")


def test_tool_depth_names_missing_capture_attestation():
    option = next(
        item
        for item in scope_options(
            response_source="agent",
            tool_completion_available=False,
        )
        if item["scope"] == "tool_interactions"
    )

    assert option["available"] is False
    assert option["reason"] == ("Tool-call capture attestation is not configured for this environment.")


async def _clear_pending() -> None:
    """Mark all existing jobs completed so a freshly created job is the only pending one."""
    async with async_session() as s:
        await s.execute(update(RunJobORM).values(status="completed"))
        await s.commit()


@pytest.mark.asyncio
async def test_run_job_state_machine():
    async with async_session() as s:
        store = EvaluationStore(s)
        rid = await store.create_run_job(
            dataset_name="d",
            response_source="baseline",
            agent=None,
            row_count=None,
            judge_model=None,
        )
        assert (await store.get_run_job(rid)).status == "pending"
        await store.complete_run_job(rid)
        assert (await store.get_run_job(rid)).status == "completed"

        rid2 = await store.create_run_job(
            dataset_name="d",
            response_source="agent",
            agent="ns/a",
            row_count=5,
            judge_model="gpt-4.1-mini",
        )
        await store.fail_run_job(rid2, "boom")
        job2 = await store.get_run_job(rid2)
        assert job2.status == "failed"
        assert job2.error_message == "boom"


@pytest.mark.asyncio
async def test_run_configuration_returns_exact_tenant_scoped_launch_inputs():
    async with async_session() as session:
        run_id = await EvaluationStore(session).create_run_job(
            dataset_name="support-cases",
            response_source="agent",
            agent="tenant-agent/support",
            target_endpoint="https://agent.example.test",
            target_model="support-v2",
            system_prompt="Answer using the support policy.",
            prompt_version_ref="support@3",
            row_count=12,
            judge_model="judge-v1",
            active_metrics=["agent.response_correctness", "quality.clarity"],
            requested_active_metrics=["agent.response_correctness"],
            enable_llm_judge=False,
            parallel_requests=7,
            run_human_review=False,
            quality_contract_ids=["support-quality"],
            evaluation_name="Support release",
            label="Candidate",
            evaluation_scope="full_execution",
            requested_evaluation_scope="tool_interactions",
            evidence_readiness={"selected_tool_ids": ["search", "ticket"]},
            project_id="project-support",
            tenant_id=TENANT,
        )

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as client:
        response = await client.get(
            f"/evaluation/runs/{run_id}/configuration?tenant_id={TENANT}"
        )
        hidden = await client.get(
            f"/evaluation/runs/{run_id}/configuration?tenant_id=another-tenant",
            headers={"x-evalai-tenant": "another-tenant"},
        )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "run_id": run_id,
        "dataset_name": "support-cases",
        "response_source": "agent",
        "agent": "tenant-agent/support",
        "evaluation_name": "Support release",
        "label": "Candidate",
        "labels": ["Candidate"],
        "judge_model": "judge-v1",
        "target_endpoint": "https://agent.example.test",
        "target_model": "support-v2",
        "system_prompt": "Answer using the support policy.",
        "prompt_version_ref": "support@3",
        "active_metrics": ["agent.response_correctness"],
        "enable_llm_judge": False,
        "parallel_requests": 7,
        "run_human_review": False,
        "quality_contract_ids": ["support-quality"],
        "evaluation_scope": "tool_interactions",
        "selected_tool_ids": ["search", "ticket"],
        "project_id": "project-support",
        # Additive replay-eligibility fact (#3317): the recorded https endpoint
        # resolves, so a case replay could reproduce this target.
        "llm_endpoint_resolvable": True,
    }
    assert hidden.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("stored_tenant", [TENANT, TENANT.removeprefix("tenant-")])
async def test_cancel_run_is_tenant_scoped_idempotent_and_terminal(stored_tenant, monkeypatch):
    from evalhub.settings import settings

    monkeypatch.setattr(settings, "pod_namespace", TENANT)
    await _clear_pending()
    async with async_session() as session:
        run_id = await EvaluationStore(session).create_run_job(
            dataset_name="stop-me",
            response_source="agent",
            agent="ns/agent",
            row_count=3,
            judge_model=None,
            tenant_id=stored_tenant,
        )

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT.removeprefix("tenant-")},
    ) as client:
        response = await client.post(f"/evaluation/runs/{run_id}/cancel?tenant_id={TENANT}")
        assert response.status_code == 200
        assert response.json() == {"run_id": run_id, "status": "cancelled"}

        repeated = await client.post(f"/evaluation/runs/{run_id}/cancel?tenant_id={TENANT}")
        assert repeated.status_code == 200

        detail = await client.get(f"/evaluation/runs/{run_id}?tenant_id={TENANT}")
        assert detail.status_code == 200
        assert detail.json()["status"] == "cancelled"
        assert detail.json()["completed_at"] is not None

        listing = await client.get(f"/evaluation/runs?tenant_id={TENANT}")
        by_id = {item["run_id"]: item for item in listing.json()}
        assert by_id[run_id]["status"] == "cancelled"
        assert by_id[run_id]["completed_at"] is not None

    async with async_session() as session:
        store = EvaluationStore(session)
        await store.complete_run_job(run_id)
        assert (await store.get_run_job(run_id)).status == "cancelled"


@pytest.mark.asyncio
async def test_cancel_run_hides_cross_tenant_job_and_rejects_finished_job():
    await _clear_pending()
    async with async_session() as session:
        store = EvaluationStore(session)
        active_id = await store.create_run_job(
            dataset_name="private",
            response_source="baseline",
            agent=None,
            row_count=None,
            judge_model=None,
            tenant_id="another-tenant",
        )
        finished_id = await store.create_run_job(
            dataset_name="finished",
            response_source="baseline",
            agent=None,
            row_count=None,
            judge_model=None,
            tenant_id=TENANT,
        )
        await store.complete_run_job(finished_id)

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": TENANT},
    ) as client:
        hidden = await client.post(f"/evaluation/runs/{active_id}/cancel?tenant_id={TENANT}")
        assert hidden.status_code == 404
        conflict = await client.post(f"/evaluation/runs/{finished_id}/cancel?tenant_id={TENANT}")
        assert conflict.status_code == 409


@pytest.mark.asyncio
async def test_cancel_active_run_interrupts_local_worker_task():
    run_id = "active-local-run"
    task = asyncio.create_task(asyncio.sleep(60))
    runs_worker._active_run_tasks[run_id] = task
    try:
        assert runs_worker.cancel_active_run(run_id) is True
        with pytest.raises(asyncio.CancelledError):
            await task
        assert runs_worker.cancel_active_run("not-active") is False
    finally:
        runs_worker._active_run_tasks.pop(run_id, None)


@pytest.mark.asyncio
async def test_durable_cancel_interrupts_worker_without_local_task_registry(monkeypatch):
    """A DB stop request must reach an executor in another process/replica."""

    await _clear_pending()
    async with async_session() as session:
        run_id = await EvaluationStore(session).create_run_job(
            dataset_name="durable-stop",
            response_source="agent",
            agent="ns/agent",
            row_count=1,
            judge_model=None,
            tenant_id=TENANT,
        )

    started = asyncio.Event()
    interrupted = asyncio.Event()

    async def _block_until_cancelled(**kwargs):  # noqa: ARG001
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            interrupted.set()

    monkeypatch.setattr(runs_worker, "execute_dataset_run", _block_until_cancelled)
    monkeypatch.setattr(runs_worker.settings, "evaluation_cancel_poll_seconds", 0.01)

    worker = asyncio.create_task(runs_worker.process_one_job(register_active=False))
    await asyncio.wait_for(started.wait(), timeout=1)
    async with async_session() as session:
        cancelled = await EvaluationStore(session).cancel_run_job(
            run_id,
            tenant_id=TENANT,
        )
        assert cancelled is not None
        assert cancelled.status == "cancelled"

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(worker, timeout=1)
    assert interrupted.is_set()
    assert run_id not in runs_worker._active_run_tasks


@pytest.mark.asyncio
async def test_reclaim_running_jobs():
    async with async_session() as s:
        store = EvaluationStore(s)
        rid = await store.create_run_job(
            dataset_name="d",
            response_source="baseline",
            agent=None,
            row_count=None,
            judge_model=None,
        )
        await s.execute(update(RunJobORM).where(RunJobORM.run_id == rid).values(status="running"))
        await s.commit()
        # A just-updated RUNNING row is presumed owned by a still-live worker
        # (see reclaim_running_jobs' staleness bound) — force immediate
        # staleness so this CAS-behavior test doesn't need to wait out the
        # real production threshold.
        assert await store.reclaim_running_jobs(stale_after_seconds=0) >= 1
        assert (await store.get_run_job(rid)).status == "failed"
        assert "Worker interrupted" in (await store.get_run_job(rid)).error_message
        await store.complete_run_job(rid)
        assert (await store.get_run_job(rid)).status == "failed"


@pytest.mark.asyncio
async def test_process_one_job_completes(monkeypatch):
    await _clear_pending()
    async with async_session() as s:
        rid = await EvaluationStore(s).create_run_job(
            dataset_name="d",
            response_source="baseline",
            agent=None,
            row_count=None,
            judge_model=None,
        )

    async def _noop(**kwargs):  # noqa: ARG001
        return None

    monkeypatch.setattr(runs_worker, "execute_dataset_run", _noop)

    assert await runs_worker.process_one_job() is True
    async with async_session() as s:
        assert (await EvaluationStore(s).get_run_job(rid)).status == "completed"


@pytest.mark.asyncio
async def test_process_one_job_uses_frozen_resolved_metrics(monkeypatch):
    await _clear_pending()
    async with async_session() as session:
        run_id = await EvaluationStore(session).create_run_job(
            dataset_name="d",
            response_source="baseline",
            agent=None,
            row_count=None,
            judge_model=None,
            active_metrics=["llm.correctness", "quality.response_clarity"],
            requested_active_metrics=["llm.correctness"],
        )

    received: dict = {}

    async def _capture(**kwargs):
        received.update(kwargs)

    monkeypatch.setattr(runs_worker, "execute_dataset_run", _capture)

    assert await runs_worker.process_one_job() is True
    assert received["resolved_active_metrics"] == [
        "llm.correctness",
        "quality.response_clarity",
    ]
    async with async_session() as session:
        job = await EvaluationStore(session).get_run_job(run_id)
    assert job.params["requested_active_metrics"] == ["llm.correctness"]


@pytest.mark.asyncio
async def test_process_one_job_marks_failed(monkeypatch):
    await _clear_pending()
    async with async_session() as s:
        rid = await EvaluationStore(s).create_run_job(
            dataset_name="d",
            response_source="baseline",
            agent=None,
            row_count=None,
            judge_model=None,
        )

    async def _boom(**kwargs):  # noqa: ARG001
        raise RuntimeError("kaboom")

    monkeypatch.setattr(runs_worker, "execute_dataset_run", _boom)

    await runs_worker.process_one_job()
    async with async_session() as s:
        job = await EvaluationStore(s).get_run_job(rid)
    assert job.status == "failed"
    # A platform exception's text is not tenant evidence: only its type is kept.
    assert "kaboom" not in job.error_message
    assert job.error_message == "RuntimeError: the failure detail is withheld from stored evidence"


@pytest.mark.asyncio
async def test_process_one_job_marks_readiness_loss_blocked(monkeypatch):
    await _clear_pending()
    async with async_session() as session:
        run_id = await EvaluationStore(session).create_run_job(
            dataset_name="d",
            response_source="baseline",
            agent=None,
            row_count=None,
            judge_model=None,
        )

    readiness = EvidenceReadinessResult(
        status=EvidenceReadiness.BLOCKED,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
        details=[ReadinessDetail(code="target_drift", message="target drifted")],
    )

    async def _blocked(**kwargs):  # noqa: ARG001
        raise ReadinessBlockedError(readiness)

    monkeypatch.setattr(runs_worker, "execute_dataset_run", _blocked)
    await runs_worker.process_one_job()

    async with async_session() as session:
        job = await EvaluationStore(session).get_run_job(run_id)
    assert job.status == "blocked"
    assert "target drifted" in job.error_message
    assert job.params["evidence_readiness"]["status"] == "blocked"


@pytest.mark.asyncio
async def test_from_dataset_enqueues_and_polls():
    mock_svc = MagicMock()
    mock_svc.get_dataset.return_value = MagicMock(status="PUBLISHED", tenant_id="tenant-async")
    mock_svc.get_records.return_value = [{"inputs": {"query": "q"}, "expectations": {"answer": "a"}}]
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport,
            base_url="http://test",
            headers={"x-evalai-tenant": "tenant-async"},
        ) as ac:
            # ASGITransport does not run lifespan, so the worker never starts —
            # the enqueued job stays pending, giving a deterministic poll result.
            resp = await ac.post(
                "/evaluation/runs/from-dataset/test_ds",
                json={"response_source": "baseline"},
            )
            assert resp.status_code == 202
            run_id = resp.json()["run_id"]
            assert resp.json()["status"] == "pending"
            async with async_session() as session:
                job = await EvaluationStore(session).get_run_job(run_id)
                assert job is not None
                assert job.tenant_id == TENANT

            poll = await ac.get(f"/evaluation/runs/{run_id}?tenant_id={TENANT}")
            assert poll.status_code == 200
            assert poll.json()["status"] == "pending"
            assert poll.json()["evaluation_scope"] == "final_response"

            listing = await ac.get(f"/evaluation/runs?tenant_id={TENANT}")
            assert listing.status_code == 200
            listed = listing.json()
            match = next((item for item in listed if item["run_id"] == run_id), None)
            assert match is not None
            assert match["status"] == "pending"
            assert match["experiment"]["name"].startswith("test_ds")

            mock_svc.get_dataset.return_value = MagicMock(status="DRAFT", tenant_id="tenant-async")
            denied = await ac.post(
                "/evaluation/runs/from-dataset/draft_ds",
                json={"response_source": "baseline"},
            )
            assert denied.status_code == 422
            assert denied.json()["detail"] == {
                "code": "dataset_not_published",
                "field": "dataset_name",
                "message": ("Dataset 'draft_ds' is DRAFT; only PUBLISHED datasets can be evaluated."),
                "recovery": ("Publish the dataset under Datasets or choose another published dataset."),
            }
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_from_dataset_freezes_template_metrics_before_enqueue():
    mock_svc = MagicMock()
    mock_svc.get_dataset.return_value = MagicMock(
        tenant_id="tenant-async",
        status="PUBLISHED",
        version_number=3,
    )
    mock_svc.get_records.return_value = [{"inputs": {"query": "q"}, "expectations": {"answer": "a"}}]
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport,
            base_url="http://test",
            headers={"x-evalai-tenant": "tenant-async"},
        ) as client:
            response = await client.post(
                "/evaluation/runs/from-dataset/test_ds",
                json={
                    "response_source": "baseline",
                    "active_metrics": ["llm.correctness"],
                    "quality_contract_ids": ["qc_tpl_response_clarity"],
                },
            )
            assert response.status_code == 202
            payload = response.json()
            assert payload["resolved_active_metrics"] == [
                "llm.correctness",
                "quality.response_clarity",
            ]
            # Real pre-run applicability (Task 2): a baseline source whose dataset
            # carries an expected answer leaves both metrics potentially applicable
            # — applicability is finalized from runtime evidence, not asserted here.
            applicability = payload["evidence_readiness"]["metric_applicability"]
            assert [row["metric_id"] for row in applicability] == [
                "llm.correctness",
                "quality.response_clarity",
            ]
            assert all(row["applicability"] == "potentially_applicable" for row in applicability)
            assert all(row["reason"] for row in applicability)

        async with async_session() as session:
            job = await EvaluationStore(session).get_run_job(payload["run_id"])
        assert job.params["active_metrics"] == payload["resolved_active_metrics"]
        assert job.params["resolved_active_metrics"] == payload["resolved_active_metrics"]
        assert job.params["requested_active_metrics"] == ["llm.correctness"]
        configuration = job.params["resolved_scoring_configuration"]
        assert payload["run_configuration_hash"] == configuration["configuration_hash"]
        assert [item["source"] for item in configuration["metric_requirements"]] == [
            "explicit_selection",
            "catalog_diagnostic_default",
        ]
        assert configuration["quality_contract_template_ids"] == ["qc_tpl_response_clarity"]
        assert configuration["quality_contract_template_snapshots"][0]["metric_id"] == "quality.response_clarity"
        assert all(abs(sum(item["fixed_gate_weights"].values()) - 1.0) < 1e-9 for item in configuration["kpi_compositions"] if item["required_gate_constituents"])
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_from_dataset_accepts_requested_scope_and_blocks_unavailable_depth():
    # User-selected depth: a valid requested evaluation_scope is honoured as the
    # requested depth. An unavailable depth is never silently replaced — it
    # yields the structured readiness blocker with the exact backend reason,
    # and the requested scope is preserved in the response.
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": "tenant-async"},
    ) as ac:
        # Full execution shares the tool-interaction capture path, so a source
        # that can never supply tool evidence is refused at that depth too —
        # structurally, without reading the dataset. The requested depth is
        # echoed back rather than quietly downgraded to something runnable.
        full = await ac.post(
            "/evaluation/runs/from-dataset/test_ds",
            json={"response_source": "provided", "evaluation_scope": "full_execution"},
        )
        assert full.status_code == 409
        detail = full.json()["detail"]
        assert detail["status"] == "unsupported"
        assert detail["requested_evaluation_scope"] == "full_execution"
        assert detail["details"][0]["code"] == "tool_evidence_unsupported"
        by_scope = {option["scope"]: option for option in detail["scope_options"]}
        assert by_scope["full_execution"]["available"] is False
        assert by_scope["full_execution"]["reason"]

        tools = await ac.post(
            "/evaluation/runs/from-dataset/test_ds",
            json={
                "response_source": "provided",
                "evaluation_scope": "tool_interactions",
            },
        )
        assert tools.status_code == 409
        detail = tools.json()["detail"]
        assert detail["status"] == "unsupported"
        assert detail["requested_evaluation_scope"] == "tool_interactions"
        assert detail["resolved_evaluation_scope"] == "tool_interactions"
        assert detail["details"][0]["code"] == "tool_evidence_unsupported"
        by_scope = {option["scope"]: option for option in detail["scope_options"]}
        assert by_scope["tool_interactions"]["available"] is False
        assert "tool-interaction" in by_scope["tool_interactions"]["reason"]
        assert by_scope["final_response"]["available"] is True

        # An invalid scope value is still rejected by request validation.
        invalid = await ac.post(
            "/evaluation/runs/from-dataset/test_ds",
            json={"response_source": "provided", "evaluation_scope": "everything"},
        )
        assert invalid.status_code == 422

        # exact_rerun is not a caller-controlled bypass: without a source_run_id
        # proving a historical run, the request is rejected outright.
        rerun = await ac.post(
            "/evaluation/runs/from-dataset/test_ds",
            json={
                "response_source": "agent",
                "agent": "ns/a",
                "evaluation_scope": "full_execution",
                "exact_rerun": True,
            },
        )
        assert rerun.status_code == 422
        assert rerun.json()["detail"]["code"] == "exact_rerun_source_required"


@pytest.mark.asyncio
async def test_from_dataset_run_and_readiness_report_requested_scope_and_options():
    # The 202 response and the readiness endpoint both carry the requested
    # scope, the resolved scope, and per-depth scope_options for the UI.
    mock_svc = MagicMock()
    mock_svc.get_dataset.return_value = MagicMock(status="PUBLISHED", version_number=1, tenant_id="tenant-async")
    mock_svc.get_records.return_value = [{"inputs": {"query": "q"}, "expectations": {"answer": "a"}}]
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport,
            base_url="http://test",
            headers={"x-evalai-tenant": "tenant-async"},
        ) as ac:
            readiness = await ac.post(
                "/evaluation/runs/from-dataset/test_ds/readiness",
                json={
                    "response_source": "baseline",
                    "evaluation_scope": "final_response",
                },
            )
            assert readiness.status_code == 200
            payload = readiness.json()
            assert payload["status"] == "ready"
            assert payload["requested_evaluation_scope"] == "final_response"
            assert payload["resolved_evaluation_scope"] == "final_response"
            by_scope = {option["scope"]: option for option in payload["scope_options"]}
            assert set(by_scope) == {
                "final_response",
                "tool_interactions",
                "full_execution",
            }
            assert by_scope["final_response"]["available"] is True
            assert by_scope["tool_interactions"]["available"] is False
            assert by_scope["tool_interactions"]["reason"]
            assert by_scope["full_execution"]["available"] is False

            created = await ac.post(
                "/evaluation/runs/from-dataset/test_ds",
                json={
                    "response_source": "baseline",
                    "evaluation_scope": "final_response",
                },
            )
            assert created.status_code == 202, created.text
            body = created.json()
            assert body["requested_evaluation_scope"] == "final_response"
            assert body["resolved_evaluation_scope"] == "final_response"
            assert {option["scope"] for option in body["scope_options"]} == {
                "final_response",
                "tool_interactions",
                "full_execution",
            }

        async with async_session() as session:
            job = await EvaluationStore(session).get_run_job(body["run_id"])
        assert job.params["evaluation_scope"] == "final_response"
        assert job.params["requested_evaluation_scope"] == "final_response"
    finally:
        app.dependency_overrides.clear()


async def _seed_source_run(ac, requested_scope: str) -> str:
    """Create a completed run and pin its recorded requested scope."""
    created = await ac.post(
        "/evaluation/runs",
        json={
            "experiment_id": "exp-llm-core-v1",
            "name": "exact-rerun source",
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
            "requested_evaluation_scope": requested_scope,
        }
        await session.commit()
    return run_id


@pytest.mark.asyncio
async def test_exact_rerun_requires_a_provable_source_run():
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": "tenant-async"},
    ) as ac:
        source_run_id = await _seed_source_run(ac, "full_execution")

        # Nonexistent source run: nothing historical to replay.
        missing = await ac.post(
            "/evaluation/runs/from-dataset/test_ds",
            json={
                "response_source": "agent",
                "agent": "ns/a",
                "exact_rerun": True,
                "source_run_id": "does-not-exist",
            },
        )
        assert missing.status_code == 404
        assert missing.json()["detail"]["code"] == "exact_rerun_source_not_found"

        # A source run owned by another tenant is treated as not found.
        cross_tenant = await ac.post(
            "/evaluation/runs/from-dataset/test_ds",
            json={
                "response_source": "agent",
                "agent": "ns/a",
                "exact_rerun": True,
                "source_run_id": source_run_id,
            },
            headers={"x-evalai-tenant": "tenant-other"},
        )
        assert cross_tenant.status_code == 404
        assert cross_tenant.json()["detail"]["code"] == "exact_rerun_source_not_found"

        # A client-supplied scope that differs from the source run's recorded
        # requested scope is still rejected.
        mismatch = await ac.post(
            "/evaluation/runs/from-dataset/test_ds",
            json={
                "response_source": "agent",
                "agent": "ns/a",
                "exact_rerun": True,
                "source_run_id": source_run_id,
                "evaluation_scope": "tool_interactions",
            },
        )
        assert mismatch.status_code == 422
        assert mismatch.json()["detail"]["code"] == "exact_rerun_scope_mismatch"

        # A valid source replays THAT run's recorded scope (full_execution here).
        # The depth is no longer refused on sight: the replay carries it into the
        # same validation every other scope faces, and fails here only because
        # this test never registers the dataset.
        replay = await ac.post(
            "/evaluation/runs/from-dataset/test_ds",
            json={
                "response_source": "agent",
                "agent": "ns/a",
                "exact_rerun": True,
                "source_run_id": source_run_id,
            },
        )
        assert replay.status_code == 404
        assert replay.json()["detail"]["code"] == "dataset_not_found"

        # Echoing the recorded scope explicitly is also accepted as a replay.
        echoed = await ac.post(
            "/evaluation/runs/from-dataset/test_ds",
            json={
                "response_source": "agent",
                "agent": "ns/a",
                "exact_rerun": True,
                "source_run_id": source_run_id,
                "evaluation_scope": "full_execution",
            },
        )
        assert echoed.status_code == 404
        assert echoed.json()["detail"]["code"] == "dataset_not_found"


@pytest.mark.asyncio
async def test_user_selected_not_applicable_metric_does_not_block_dataset_run():
    # A user-selected metric that is known-not-applicable (llm.correctness needs a
    # reference the dataset does not provide) must not deadlock setup: the run
    # proceeds and the reason is surfaced via metric_applicability.
    mock_svc = MagicMock()
    mock_svc.get_dataset.return_value = MagicMock(
        tenant_id="tenant-async",
        status="PUBLISHED",
        version_number=1,
    )
    mock_svc.get_records.return_value = [{"inputs": {"query": "q", "response": "a"}}]
    app.dependency_overrides[get_registry_service] = lambda: mock_svc
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport,
            base_url="http://test",
            headers={"x-evalai-tenant": "tenant-async"},
        ) as ac:
            response = await ac.post(
                "/evaluation/runs/from-dataset/no_reference_ds",
                json={
                    "response_source": "provided",
                    "active_metrics": ["llm.correctness"],
                },
            )
            assert response.status_code == 202, response.text
            applicability = response.json()["evidence_readiness"]["metric_applicability"]
            row = next(item for item in applicability if item["metric_id"] == "llm.correctness")
            assert row["applicability"] == "known_not_applicable"
            assert row["reason"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_list_runs_includes_running_and_failed_jobs():
    await _clear_pending()
    async with async_session() as s:
        store = EvaluationStore(s)
        pending_id = await store.create_run_job(
            tenant_id="tenant-async",
            dataset_name="pending-ds",
            response_source="baseline",
            agent=None,
            row_count=None,
            judge_model="gpt-4o",
            scenario="llm_core",
        )
        running_id = await store.create_run_job(
            tenant_id="tenant-async",
            dataset_name="running-ds",
            response_source="agent",
            agent="ns/agent",
            row_count=3,
            judge_model=None,
            scenario="agentic",
        )
        await s.execute(update(RunJobORM).where(RunJobORM.run_id == running_id).values(status="running"))
        failed_id = await store.create_run_job(
            tenant_id="tenant-async",
            dataset_name="failed-ds",
            response_source="provided",
            agent=None,
            row_count=None,
            judge_model=None,
            scenario="rag",
        )
        await store.fail_run_job(failed_id, "agent timeout")
        await s.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-evalai-tenant": "tenant-async"},
    ) as ac:
        listing = await ac.get(f"/evaluation/runs?tenant_id={TENANT}")
        assert listing.status_code == 200
        by_id = {item["run_id"]: item for item in listing.json()}
        assert by_id[pending_id]["status"] == "pending"
        assert by_id[running_id]["status"] == "running"
        assert by_id[failed_id]["status"] == "failed"
        assert by_id[failed_id]["error_message"] == "Run failed. Check the run configuration and try again."
        assert by_id[pending_id]["response_source"] == "baseline"
        assert by_id[running_id]["response_source"] == "agent"
        assert by_id[failed_id]["response_source"] == "provided"
        assert by_id[running_id]["experiment"]["scenario"] == "agentic"
        assert by_id[running_id]["experiment"]["target_endpoint"] == "ns/agent"

    # Do not leave a synthetic running job for a later TestClient lifespan to
    # reclaim and execute against that test's newly isolated database.
    await _clear_pending()


@pytest.mark.asyncio
async def test_temporal_startup_preserves_running_jobs(monkeypatch):
    from contextlib import asynccontextmanager

    from evalhub.main import app, lifespan
    from evalhub.orchestrator import temporal
    from evalhub.settings import settings

    @asynccontextmanager
    async def worker_context():
        yield

    monkeypatch.setattr(settings, "evaluation_runtime", "temporal")
    monkeypatch.setattr(settings, "trace_index_enabled", False)
    monkeypatch.setattr(temporal, "temporal_worker", worker_context)
    async with async_session() as session:
        store = EvaluationStore(session)
        run_id = await store.create_run_job(
            dataset_name="synthetic-temporal-startup", response_source="provided",
            agent=None, row_count=1, judge_model=None,
        )
        await store.claim_run_job(run_id)
    async with lifespan(app):
        async with async_session() as session:
            assert (await EvaluationStore(session).get_run_job(run_id)).status == "running"
