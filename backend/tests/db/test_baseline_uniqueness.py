"""A single BASELINE link per experiment is enforced by the database.

Two concurrent promotions could each pass the read-then-demote check and
commit two ``role='baseline'`` links. The partial unique index rejects the
second commit and ``promote_baseline`` retries once after re-demoting.
"""

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from proofgrove.db.models import Base, ExperimentRunLinkORM
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.enums import RunRole
from proofgrove.evaluation.judge import MockJudge
from proofgrove.evaluation.sample_data import SAMPLE_EXPERIMENTS, get_sample_rows


@pytest.fixture
async def store():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        s = EvaluationStore(session)
        await s.seed_definitions()
        yield s
    await engine.dispose()


async def _two_linked_runs(store: EvaluationStore) -> tuple[str, str, str]:
    """Persist two runs in the same experiment; return (experiment_id, run_a, run_b)."""
    engine = EvaluationEngine(judge=MockJudge())
    exp = SAMPLE_EXPERIMENTS[0]
    rows = get_sample_rows(exp.experiment_id)[:1]
    run_a = engine.execute(exp, rows)
    await store.save_run(run_a, rows)
    run_b = engine.execute(exp, rows)
    await store.save_run(run_b, rows)
    return exp.experiment_id, run_a.run_id, run_b.run_id


async def _baseline_run_ids(store: EvaluationStore, experiment_id: str) -> list[str]:
    links = await store._list_run_links(experiment_id)
    return [link.run_id for link in links if link.role == RunRole.BASELINE]


@pytest.mark.asyncio
async def test_sequential_promotions_leave_exactly_one_baseline(store: EvaluationStore):
    experiment_id, run_a, run_b = await _two_linked_runs(store)

    await store.promote_baseline(experiment_id, run_a, actor="alice")
    assert await _baseline_run_ids(store, experiment_id) == [run_a]

    await store.promote_baseline(experiment_id, run_b, actor="bob")
    assert await _baseline_run_ids(store, experiment_id) == [run_b]


@pytest.mark.asyncio
async def test_duplicate_baseline_insert_raises_integrity_error(store: EvaluationStore):
    """The partial unique index rejects a second BASELINE row for one experiment."""
    experiment_id, run_a, run_b = await _two_linked_runs(store)
    await store.promote_baseline(experiment_id, run_a)

    duplicate = await store.session.get(ExperimentRunLinkORM, (experiment_id, run_b))
    duplicate.role = RunRole.BASELINE.value
    with pytest.raises(IntegrityError):
        await store.session.commit()
    await store.session.rollback()

    # Non-baseline roles stay unconstrained: both runs may be exploratory.
    assert await _baseline_run_ids(store, experiment_id) == [run_a]


@pytest.mark.asyncio
async def test_promote_baseline_retries_after_losing_a_race(store: EvaluationStore, monkeypatch):
    """A promotion whose demotion read missed a concurrent baseline retries once.

    Simulated by making the first demotion pass a no-op — exactly what happens
    when another transaction commits its baseline between our read and commit.
    """
    experiment_id, run_a, run_b = await _two_linked_runs(store)
    await store.promote_baseline(experiment_id, run_a)

    original = store._demote_current_baselines
    calls = {"count": 0}

    async def racy_demote(exp_id: str, keep_run_id: str | None) -> None:
        calls["count"] += 1
        if calls["count"] == 1:
            return  # First attempt misses the concurrently-committed baseline.
        await original(exp_id, keep_run_id)

    monkeypatch.setattr(store, "_demote_current_baselines", racy_demote)

    change = await store.promote_baseline(experiment_id, run_b, actor="bob")

    assert calls["count"] == 2  # first attempt hit IntegrityError, retry ran
    assert change.new_baseline_run_id == run_b
    assert await _baseline_run_ids(store, experiment_id) == [run_b]
