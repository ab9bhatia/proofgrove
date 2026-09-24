"""A case answers for what was required of it, not for its diagnostics."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from evalhub.db.models import (
    Base,
    EvaluationRunORM,
    ExperimentORM,
    MetricResultORM,
)
from evalhub.db.store import EvaluationStore

TENANT = "acme"


@pytest.fixture
async def store():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield EvaluationStore(session)
    await engine.dispose()


async def _run(store: EvaluationStore, metrics: list[tuple[str, str, str]]) -> None:
    """One run, one row, each metric given as (id, requirement, threshold_result).

    A threshold_result of ``"unscored"`` records a metric that could not be
    measured at all rather than one that scored badly.
    """
    session = store.session
    session.add(
        ExperimentORM(
            experiment_id="exp1",
            name="e",
            dataset_version="v1",
            target_endpoint="http://t",
            scenario="llm",
            tenant_id=TENANT,
        )
    )
    session.add(EvaluationRunORM(run_id="run1", experiment_id="exp1", status="completed"))
    for metric_id, requirement, result in metrics:
        session.add(
            MetricResultORM(
                run_id="run1",
                metric_id=metric_id,
                evaluator_config_id="cfg",
                row_id="row1",
                dataset_version="v1",
                metric_status="unscored" if result == "unscored" else "scored",
                metric_requirement=requirement,
                threshold_result=None if result == "unscored" else result,
                score=None if result == "unscored" else 1.0,
                normalised_score=(
                    None if result == "unscored" else (1.0 if result == "pass" else 0.1)
                ),
                threshold=0.8,
            )
        )
    await session.flush()


@pytest.mark.asyncio
async def test_a_failing_diagnostic_does_not_fail_the_case(store):
    """The contradiction this rule exists to remove.

    The run verdict counts required metrics only (KPI compositions and hard
    blockers). The case verdict used to rank every metric equally, so a run
    could read Pass while every one of its cases read Fail — the failures being
    nlp.bleu and friends, which carry a 0.8 threshold they cannot reach on free
    text. Both numbers were right by their own rule and the pair was nonsense.
    """
    await _run(
        store,
        [
            ("llm.coherence", "required", "pass"),
            ("llm.fluency", "required", "pass"),
            ("nlp.bleu", "optional", "fail"),
            ("ops.latency", "optional", "fail"),
        ],
    )

    summary = (await store._metric_summaries_for_run("run1"))[0]

    assert summary.worst_gate.value == "pass"
    assert summary.failing_count == 0
    # Reported, not hidden — the reader still learns the diagnostics scored badly.
    assert summary.failing_optional_count == 2


@pytest.mark.asyncio
async def test_a_failing_required_metric_still_fails_the_case(store):
    """The rule narrows what counts; it does not stop anything counting."""
    await _run(
        store,
        [
            ("llm.correctness", "required", "fail"),
            ("nlp.bleu", "optional", "fail"),
        ],
    )

    summary = (await store._metric_summaries_for_run("run1"))[0]

    assert summary.worst_gate.value == "fail"
    assert summary.failing_count == 1
    assert summary.failing_optional_count == 1


@pytest.mark.asyncio
async def test_optional_metrics_that_could_not_be_measured_do_not_mask_the_verdict(store):
    """A provided-response run cannot measure latency or tokens.

    Five optional metrics then go unscored on every case. Counted as coverage
    gaps for the case, they made all four cases of such a run read "Partially
    scored" — a state the UI checks BEFORE the verdict, so the cases where a
    required metric actually failed never said so.
    """
    await _run(
        store,
        [
            ("llm.correctness", "required", "fail"),
            ("ops.latency", "optional", "unscored"),
            ("ops.total_token_count", "optional", "unscored"),
        ],
    )

    summary = (await store._metric_summaries_for_run("run1"))[0]

    assert summary.unscored_count == 2, "the coverage gap is still reported"
    assert summary.unscored_required_count == 0, "nothing required went unmeasured"
    assert summary.failing_count == 1
    # The verdict is reported, not withheld. Withholding it is what made every
    # row read "Not recorded" while the case itself showed Fail.
    assert summary.worst_gate is not None
    assert summary.worst_gate.value == "fail"
