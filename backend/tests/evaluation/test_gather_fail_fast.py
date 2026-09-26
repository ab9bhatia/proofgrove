"""Tests for ``_gather_fail_fast``'s outer-cancellation propagation.

A worker cancelling an in-flight run (runs_worker.py's durable-cancellation
watch) cancels the *task governing the run*, not the individual per-row
invocations directly. Those row tasks live inside ``_gather_fail_fast``'s own
``tasks`` list, so cancellation has to be explicitly relayed to them -- an
``asyncio.wait`` that is itself cancelled does not automatically cancel the
tasks it was waiting on.
"""

import asyncio
import gc

import pytest

from proofgrove.evaluation.run_service import _gather_fail_fast


async def test_outer_cancellation_cancels_row_tasks():
    """Cancelling the caller of ``_gather_fail_fast`` must cancel every row task.

    Without the fix, ``asyncio.wait`` raising ``CancelledError`` when its
    caller is cancelled propagates straight out of ``_gather_fail_fast``,
    leaving the long-running row coroutine still executing in the
    background -- still invoking the target agent/LLM, unobserved by
    anyone who thinks the run stopped.
    """
    started = asyncio.Event()
    row_was_cancelled = False

    async def long_row_invocation() -> None:
        nonlocal row_was_cancelled
        started.set()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            row_was_cancelled = True
            raise

    outer = asyncio.ensure_future(_gather_fail_fast([long_row_invocation()]))
    await started.wait()
    outer.cancel()

    with pytest.raises(asyncio.CancelledError):
        await outer

    assert row_was_cancelled, "row task kept running after its caller was cancelled"


async def test_outer_cancellation_cancels_every_row_task_not_just_one():
    """All in-flight row tasks are cancelled, not only the one being awaited."""
    started_count = 0
    cancelled_count = 0
    all_started = asyncio.Event()

    async def long_row_invocation() -> None:
        nonlocal started_count, cancelled_count
        started_count += 1
        if started_count == 3:
            all_started.set()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled_count += 1
            raise

    outer = asyncio.ensure_future(_gather_fail_fast([long_row_invocation() for _ in range(3)]))
    await all_started.wait()
    outer.cancel()

    with pytest.raises(asyncio.CancelledError):
        await outer

    assert cancelled_count == 3


async def test_fail_fast_still_cancels_remaining_rows_on_row_failure():
    """Existing behaviour is preserved: one row's failure still cancels the rest."""

    async def failing_row() -> None:
        raise ValueError("boom")

    cancelled = asyncio.Event()

    async def slow_row() -> None:
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    with pytest.raises(ValueError, match="boom"):
        await _gather_fail_fast([failing_row(), slow_row()])

    assert cancelled.is_set()


async def test_multiple_concurrent_failures_leave_no_exception_unretrieved():
    """Every failed task's exception is retrieved, not just the one that's raised.

    Regression for R6: the old success-path tail loop raised on the FIRST
    failed task it found, so any OTHER failed task in the list never had
    ``.exception()`` called on it. asyncio logs those as "Task exception was
    never retrieved" once garbage-collected -- for a row task, that log line
    can carry raw content (e.g. an embedded agent response), bypassing the
    type-only logging invariant. The fix must retrieve every non-cancelled
    task's exception before raising the first one, in original row order.
    """

    async def failing_row(tag: str) -> None:
        # Let both tasks actually start and fail before asyncio.wait
        # resolves, so both raise concurrently rather than sequentially.
        await asyncio.sleep(0)
        raise ValueError(tag)

    unretrieved: list[asyncio.Task] = []
    loop = asyncio.get_event_loop()
    previous_handler = loop.get_exception_handler()

    def handler(_loop, context):
        if "Task exception was never retrieved" in context.get("message", ""):
            unretrieved.append(context.get("task"))

    loop.set_exception_handler(handler)
    try:
        with pytest.raises(ValueError, match="first"):
            await _gather_fail_fast([failing_row("first"), failing_row("second")])

        # Force GC of the finished/cancelled tasks -- CPython emits the
        # "never retrieved" warning from a task's __del__.
        gc.collect()
        await asyncio.sleep(0)
        gc.collect()
    finally:
        loop.set_exception_handler(previous_handler)

    assert not unretrieved, "asyncio reported an exception as never retrieved"
