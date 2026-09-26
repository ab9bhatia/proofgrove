"""A failed late-evidence score remains retryable without another trace change."""

from datetime import UTC, datetime

import pytest

from proofgrove.db.session import async_session
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation import run_service
from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.enums import EvaluationScope, EvidenceReadiness, Scenario, TriggerReason
from proofgrove.evaluation.llm_judge import JudgeResult
from proofgrove.evaluation.models import EvaluationRow, EvidenceReadinessResult, ExperimentDefinition
from proofgrove.evaluation.trace_hydrator import TELEMETRY_EVIDENCE_SOURCE


class _EvidenceJudge:
    def evaluate(self, config, row):
        score = 0.9 if row.response == "updated" else 0.2
        return JudgeResult(score, None, "synthetic score", 0, 0, executed_scorer="native")


async def test_same_evidence_retries_failed_score_and_then_skips_success(monkeypatch):
    engine = EvaluationEngine(judge=_EvidenceJudge())
    experiment = ExperimentDefinition(
        experiment_id="retry", name="retry", dataset_version="ds.v1", target_endpoint="synthetic",
        scenario=Scenario.AGENTIC, evaluation_scope=EvaluationScope.TOOL_INTERACTIONS, tenant_id="test", has_ground_truth=True,
    )
    row = EvaluationRow(row_id="r1", query="q", response="original", expected_response="updated", from_agent=True, output_data={"response_source": TELEMETRY_EVIDENCE_SOURCE, "trace_evidence_fingerprint": "before"})
    readiness = EvidenceReadinessResult(status=EvidenceReadiness.READY, evaluation_scope=experiment.evaluation_scope)
    snapshot = {
        "watch_completed_run": True, "deferred_since": datetime.now(UTC).isoformat(),
        "rows": [row.model_dump(mode="json")], "experiment": experiment.model_dump(mode="json"),
        "readiness": readiness.model_dump(mode="json"), "resolved_metrics": ["llm.correctness"],
        "enable_llm_judge": True, "run_human_review": False,
    }
    async with async_session() as session:
        store = EvaluationStore(session)
        run_id = await store.create_run_job(dataset_name="ds", response_source="agent", agent="synthetic", row_count=1, judge_model=None, tenant_id="test")
        await store.update_run_job_telemetry_watch(run_id, snapshot)
        await run_service._score_and_persist_run(
            run_id=run_id, rows=[row], experiment=experiment, response_source="agent", resolved_metrics=["llm.correctness"],
            scoring_configuration=None, pre_run_not_applicable={}, readiness=readiness, enable_llm_judge=True, run_human_review=False,
            trigger_reason=TriggerReason.MANUAL, correlation_id=run_id, label=None, store=store, engine=engine,
        )
        assert (await store.get_run(run_id)).metric_results[0].score == 0.2

    async def hydrate(row, **kwargs):
        row.response = "updated"
        row.output_data = {**row.output_data, "trace_evidence_fingerprint": "after"}

    execute = engine.execute
    attempts = 0

    def fail_once(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("transient scorer failure")
        return execute(*args, **kwargs)

    monkeypatch.setattr(run_service, "hydrate_row_from_archive", hydrate)
    monkeypatch.setattr(engine, "execute", fail_once)
    async with async_session() as session:
        store = EvaluationStore(session)
        with pytest.raises(RuntimeError, match="transient scorer failure"):
            await run_service.execute_deferred_telemetry_score(run_id=run_id, store=store, engine=engine)
        pending = (await store.get_run_job(run_id)).params[run_service.TELEMETRY_SCORE_SNAPSHOT_KEY]
        assert pending["score_stale"] is True
        assert pending["rows"][0]["output_data"]["trace_evidence_fingerprint"] == "after"
        assert (await store.get_run(run_id)).metric_results[0].score == 0.2

    # A new worker session reads the newer snapshot but must retry its stale score.
    async with async_session() as session:
        store = EvaluationStore(session)
        await run_service.execute_deferred_telemetry_score(run_id=run_id, store=store, engine=engine)
        assert attempts == 2
        assert (await store.get_run(run_id)).metric_results[0].score == 0.9
        assert (await store.get_run_job(run_id)).params[run_service.TELEMETRY_SCORE_SNAPSHOT_KEY]["score_stale"] is False
        await run_service.execute_deferred_telemetry_score(run_id=run_id, store=store, engine=engine)
        assert attempts == 2, "Successfully scored unchanged evidence must remain a no-op"
