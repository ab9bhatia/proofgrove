"""Concurrent persistence uses one transaction for experiment creation and numbering.

For PostgreSQL, set EVALHUB_TEST_POSTGRES_URL to a disposable test database
(asyncpg URL), then run ``uv run pytest --confcutdir=tests/db tests/db/test_run_concurrency.py``.
The confcutdir excludes the parent SQLite-only fixtures. Each test creates
and removes its own PostgreSQL schema; no deployed database should be used.
"""

import asyncio
import os
import uuid

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from evalhub.db.models import Base, EvaluationRunORM, ExperimentORM
from evalhub.db.store import EvaluationStore
from evalhub.evaluation.models import ExperimentDefinition, RunResult


@pytest.fixture
async def sessions(tmp_path):
    url = os.environ.get("EVALHUB_TEST_POSTGRES_URL", f"sqlite+aiosqlite:///{tmp_path / 'concurrent.db'}")
    engine = create_async_engine(url)
    schema = None
    if engine.dialect.name == "postgresql":
        schema = f"test_run_{uuid.uuid4().hex}"
        async with engine.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
        engine = engine.execution_options(schema_translate_map={None: schema})
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        if schema:
            async with engine.begin() as conn:
                await conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await engine.dispose()


def experiment():
    return ExperimentDefinition(experiment_id="parallel", name="parallel", dataset_version="v1", target_endpoint="test", scenario="", tenant_id="tenant-one")


@pytest.mark.asyncio
@pytest.mark.parametrize("preexisting", [False, True])
async def test_parallel_runs_have_one_experiment_and_distinct_numbers(sessions, preexisting):
    if preexisting:
        async with sessions() as session:
            await EvaluationStore(session).save_experiment(experiment())
    ready = asyncio.Event()

    async def save(index):
        async with sessions() as session:
            await ready.wait()
            run = RunResult(run_id=f"run-{index}", experiment=experiment(), status="completed")
            await EvaluationStore(session).save_run(run, [])
            return run.run_number

    tasks = [asyncio.create_task(save(i)) for i in range(6)]
    ready.set()
    assert sorted(await asyncio.gather(*tasks)) == list(range(1, 7))
    async with sessions() as session:
        assert await session.scalar(select(func.count()).select_from(ExperimentORM)) == 1
        assert sorted((await session.scalars(select(EvaluationRunORM.run_number))).all()) == list(range(1, 7))


@pytest.mark.asyncio
async def test_failed_run_does_not_commit_new_experiment(sessions, monkeypatch):
    async with sessions() as session:
        store = EvaluationStore(session)

        async def fail_number(*args):
            raise RuntimeError("injected persistence failure")

        monkeypatch.setattr(store, "_next_run_number", fail_number)
        with pytest.raises(RuntimeError, match="injected"):
            await store.save_run(RunResult(run_id="failed", experiment=experiment(), status="completed"), [])
        await session.rollback()
    async with sessions() as session:
        assert await session.scalar(select(func.count()).select_from(ExperimentORM)) == 0
        assert await session.scalar(select(func.count()).select_from(EvaluationRunORM)) == 0
