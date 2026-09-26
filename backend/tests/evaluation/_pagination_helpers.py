"""Shared helper for pagination tests that assert on SELECT statement counts."""

import contextlib

from sqlalchemy import event

from proofgrove.db.session import async_engine


@contextlib.contextmanager
def count_selects():
    """Count SELECT statements issued against the app's engine.

    Attached to the sync facade of the shared async engine, so every statement
    the API emits while the block is active is observed.
    """
    statements: list[str] = []
    engine = async_engine().sync_engine

    def _before_cursor_execute(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        if statement.lstrip().lower().startswith("select"):
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", _before_cursor_execute)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", _before_cursor_execute)
