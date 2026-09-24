"""Calculated telemetry snapshots cannot erase or rewrite human review history."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from evalhub.db.models import (
    Base,
    EvaluationRunItemORM,
    FindingCommentORM,
    FindingORM,
    RegressionCaseORM,
    RemediationORM,
    ReviewDecisionORM,
    ReviewTaskORM,
    WaiverORM,
)
from evalhub.db.store import EvaluationStore
from evalhub.evaluation.enums import RunStatus
from evalhub.evaluation.models import EvaluationRow, ExperimentDefinition, ReviewQueueItem, RunResult


@pytest.mark.asyncio
@pytest.mark.parametrize("original_status", ["completed", "completed_with_partial_evidence"])
async def test_refresh_preserves_review_history_and_original_evidence(original_status):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    @event.listens_for(engine.sync_engine, "connect")
    def enforce_foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with sessions() as session:
            store = EvaluationStore(session)
            run = RunResult(
                run_id="reviewed", status=original_status,
                experiment=ExperimentDefinition(experiment_id="exp", name="review", dataset_version="v1", target_endpoint="test", scenario="", tenant_id="tenant-one"),
                review_queue=[ReviewQueueItem(row_id="row", query="question", response="original response", failing_metrics=["check"], gate_result="fail", rationale="original finding")],
            )
            rows = [EvaluationRow(row_id="row", query="question", response="original response")]
            await store.save_run(run, rows)
            finding = (await session.scalars(select(FindingORM))).one()
            task = (await session.scalars(select(ReviewTaskORM))).one()
            task.assigned_to = "reviewer"
            task.status = "resolved"
            finding.status = "resolved"
            session.add_all([
                ReviewDecisionORM(decision_id="decision", finding_id=finding.finding_id, task_id=task.task_id, reviewer="reviewer", outcome="confirmed", rationale="keep decision"),
                FindingCommentORM(comment_id="comment", finding_id=finding.finding_id, tenant_id="tenant-one", author="reviewer", body="keep comment", mentions=["owner"]),
                WaiverORM(waiver_id="waiver", finding_id=finding.finding_id, approved_by="reviewer", rationale="keep waiver", expires_at=datetime.now(UTC) + timedelta(days=1)),
                RemediationORM(remediation_id="remediation", finding_id=finding.finding_id, owner="owner", description="keep remediation", created_by="reviewer"),
                RegressionCaseORM(regression_case_id="regression", tenant_id="tenant-one", kind="golden", finding_id=finding.finding_id, source_run_id=run.run_id, record={"expected": "original"}, provenance={"decision_id": "decision"}),
            ])
            await session.commit()
            models = (FindingORM, ReviewTaskORM, ReviewDecisionORM, FindingCommentORM, WaiverORM, RemediationORM, RegressionCaseORM)

            async def snapshot():
                # Raw rows bypass the identity map: deleted/changed DB records must fail.
                return {model.__tablename__: (await session.execute(select(model.__table__))).mappings().all() for model in models}

            original = await snapshot()
            run.status = RunStatus.COMPLETED
            run.review_queue[0].response = "fresh response"
            run.review_queue[0].rationale = "new calculated finding"
            rows[0].response = "fresh response"
            for queue in (run.review_queue, run.review_queue, []):
                run.review_queue = queue
                await store.save_run(run, rows, replace_existing=True, allow_completed_telemetry_refresh=True)
                current_history = await snapshot()
                for table, records in original.items():
                    assert all(record in current_history[table] for record in records)
                assert len(current_history["findings"]) == 2
                assert len(current_history["review_tasks"]) == 2
                current = (await session.scalars(select(EvaluationRunItemORM))).one()
                await session.refresh(current)
                assert current.output_data["response"] == "fresh response"
                assert (await store.get_run(run.run_id)).review_queue == queue
            # A newly failing row still gets its own finding/task; old records stay intact.
            rows.append(EvaluationRow(row_id="new", query="new question", response="new response"))
            run.review_queue = [ReviewQueueItem(row_id="new", query="new question", response="new response", gate_result="fail")]
            await store.save_run(run, rows, replace_existing=True, allow_completed_telemetry_refresh=True)
            assert set((await session.scalars(select(FindingORM.row_id))).all()) == {"row", "new"}
            assert len((await session.scalars(select(ReviewTaskORM))).all()) == 3
    finally:
        await engine.dispose()
