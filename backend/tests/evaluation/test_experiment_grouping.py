"""Named evaluations group compatible reruns under one experiment.

The setup copy promises the evaluation name groups related runs: rerunning the
same named evaluation with a compatible configuration (same tenant + dataset +
target) must attach to the existing experiment and increment the run number.
An incompatible configuration (different dataset/target) still creates a new
experiment — runs are never silently mixed.
"""

import uuid

import pytest

from proofgrove.db.models import EvaluationRunORM
from proofgrove.db.session import async_session
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.judge import MockJudge
from proofgrove.evaluation.run_service import execute_dataset_run


class _FakeInfo:
    version_number = 1
    product_id = "product-x"
    tenant_id = "tenant-x"
    status = "PUBLISHED"


class _FakeRegistry:
    def __init__(self, records):
        self._records = records

    def get_dataset(self, name, tenant_id=None):
        return _FakeInfo()

    def get_records(self, name, tenant_id=None):
        return self._records


def _records(n: int = 2) -> list[dict]:
    return [
        {
            "dataset_record_id": f"r{i}",
            "inputs": {"query": f"question {i}"},
            "expectations": {"response": f"answer {i}"},
        }
        for i in range(1, n + 1)
    ]


async def _run(
    run_id: str,
    *,
    dataset_name: str = "grouping_ds",
    evaluation_name: str | None,
    target_model: str | None = None,
) -> None:
    async with async_session() as session:
        await execute_dataset_run(
            run_id=run_id,
            dataset_name=dataset_name,
            response_source="provided",
            agent=None,
            row_count=None,
            judge_model=None,
            target_model=target_model,
            resolved_active_metrics=["llm.relevance"],
            enable_llm_judge=False,
            store=EvaluationStore(session),
            engine=EvaluationEngine(judge=MockJudge()),
            registry=_FakeRegistry(_records()),
            evaluation_name=evaluation_name,
        )


async def _run_row(run_id: str) -> EvaluationRunORM:
    async with async_session() as session:
        row = await session.get(EvaluationRunORM, run_id)
        assert row is not None
        return row


@pytest.mark.asyncio
async def test_named_rerun_attaches_to_the_same_experiment_and_increments_run_number():
    evaluation_name = f"Nightly QA {uuid.uuid4()}"
    run_1, run_2 = f"run-{uuid.uuid4()}", f"run-{uuid.uuid4()}"

    await _run(run_1, evaluation_name=evaluation_name)
    await _run(run_2, evaluation_name=evaluation_name)

    row_1 = await _run_row(run_1)
    row_2 = await _run_row(run_2)
    assert row_1.experiment_id == row_2.experiment_id
    assert (row_1.run_number, row_2.run_number) == (1, 2)


@pytest.mark.asyncio
async def test_named_rerun_with_a_different_dataset_creates_a_new_experiment():
    evaluation_name = f"Nightly QA {uuid.uuid4()}"
    run_1, run_2 = f"run-{uuid.uuid4()}", f"run-{uuid.uuid4()}"

    await _run(run_1, evaluation_name=evaluation_name, dataset_name="grouping_ds_a")
    await _run(run_2, evaluation_name=evaluation_name, dataset_name="grouping_ds_b")

    row_1 = await _run_row(run_1)
    row_2 = await _run_row(run_2)
    assert row_1.experiment_id != row_2.experiment_id
    assert (row_1.run_number, row_2.run_number) == (1, 1)


@pytest.mark.asyncio
async def test_unnamed_runs_keep_one_experiment_per_run():
    run_1, run_2 = f"run-{uuid.uuid4()}", f"run-{uuid.uuid4()}"

    await _run(run_1, evaluation_name=None)
    await _run(run_2, evaluation_name=None)

    row_1 = await _run_row(run_1)
    row_2 = await _run_row(run_2)
    assert row_1.experiment_id != row_2.experiment_id
