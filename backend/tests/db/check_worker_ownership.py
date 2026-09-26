"""Run against an empty disposable PostgreSQL database, never an application DB.

WORKER_TEST_DATABASE_URL=postgresql+asyncpg://.../eval_test python tests/db/check_worker_ownership.py
"""

import asyncio
import os
from unittest.mock import patch

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from proofgrove import runs_worker
from proofgrove.db.models import RunJobORM
from proofgrove.db.store import EvaluationStore


async def main():
    engine = create_async_engine(os.environ["WORKER_TEST_DATABASE_URL"])
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        assert not await connection.scalar(text("SELECT to_regclass('run_jobs')")), "Requires an empty disposable database"
        await connection.run_sync(RunJobORM.__table__.create)
    async with factory() as session:
        run_id = await EvaluationStore(session).create_run_job(
            dataset_name="synthetic-worker-ownership",
            response_source="provided",
            agent=None,
            row_count=1,
            judge_model=None,
            tenant_id="synthetic",
        )

    # Force both callers to finish their SELECT before either can commit.
    barrier = asyncio.Barrier(2)

    class RacingSession(AsyncSession):
        async def execute(self, statement, *args, **kwargs):
            result = await super().execute(statement, *args, **kwargs)
            if getattr(statement, "is_select", False):
                await barrier.wait()
            return result

    race = async_sessionmaker(engine, class_=RacingSession, expire_on_commit=False)

    async def claim():
        async with race() as session:
            job = await EvaluationStore(session).claim_next_pending_job()
            return job.run_id if job else None

    claims = await asyncio.wait_for(asyncio.gather(claim(), claim()), 10)
    assert claims.count(run_id) == 1 and claims.count(None) == 1, claims

    async with factory() as session:
        job = await session.get(RunJobORM, run_id)
        job.status = "pending"
        await session.commit()

    # Exercise real worker ownership, recovery, standby and takeover. Only the
    # evaluation itself is held at a barrier; database operations are real.
    executions = []
    entered = asyncio.Event()
    active = 0

    async def held_job(**kwargs):
        nonlocal active
        async with factory() as session:
            job = await EvaluationStore(session).claim_next_pending_job()
        if job is None:
            return False
        active += 1
        assert active == 1, "Two executors ran simultaneously"
        executions.append(job.run_id)
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            active -= 1

    stop_a, stop_b = asyncio.Event(), asyncio.Event()
    tasks = []
    try:
        with patch.object(runs_worker, "async_engine", return_value=engine), patch.object(runs_worker, "async_session", factory), patch.object(runs_worker, "process_one_job", held_job):
            tasks.append(asyncio.create_task(runs_worker.run_worker_loop(stop_a, 0.05)))
            await asyncio.wait_for(entered.wait(), 5)
            entered.clear()
            tasks.append(asyncio.create_task(runs_worker.run_worker_loop(stop_b, 0.05)))
            await asyncio.sleep(0.2)
            async with factory() as session:
                assert (await session.get(RunJobORM, run_id)).status == "running"
            assert executions == [run_id], executions
            # Kill the owner's DB session. It must cancel its work before the
            # standby can recover, rather than silently reconnecting as owner.
            async with engine.begin() as connection:
                pid = await connection.scalar(text("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=1129271892 AND objid=1 AND granted"))
                assert pid
                await connection.execute(text("SELECT pg_terminate_backend(:pid)"), {"pid": pid})
            async with asyncio.timeout(5):
                while True:
                    async with factory() as session:
                        job = await session.get(RunJobORM, run_id)
                        if job.status == "failed" and active == 0:
                            break
                    await asyncio.sleep(0.05)
            assert executions == [run_id], executions
            async with factory() as session:
                await EvaluationStore(session).complete_run_job(run_id)
                assert (await session.get(RunJobORM, run_id)).status == "failed"
                next_id = await EvaluationStore(session).create_run_job(
                    dataset_name="synthetic-after-failover", response_source="provided",
                    agent=None, row_count=1, judge_model=None, tenant_id="synthetic",
                )
            await asyncio.wait_for(entered.wait(), 5)
            assert executions == [run_id, next_id]
            assert active == 1
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await engine.dispose()
    print("PASS: atomic claim, standby preserves active work, connection-loss cancellation and takeover")


if __name__ == "__main__":
    asyncio.run(main())
