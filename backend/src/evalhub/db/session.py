"""SQLAlchemy sessions and engines (async for the app, sync for the registry).

Engines are created from the configured ``DATABASE_URL`` through the database
backend abstraction so the concrete product is a configuration concern.
"""

from functools import lru_cache

from sqlalchemy import Engine, create_engine, inspect, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from evalhub.db.backend import ensure_async_url, resolve_backend, to_sync_url
from evalhub.settings import settings


class Base(DeclarativeBase):
    pass


def get_async_database_url() -> str:
    """Resolve the active async SQLAlchemy URL from settings (not cached).

    Tests may mutate ``settings.database_url``; URL resolution must always read
    the current value. Engine objects are cached separately by URL string.
    """

    backend = resolve_backend(
        database_url=settings.database_url,
        database_backend=settings.database_backend,
    )
    return ensure_async_url(settings.database_url, backend)


def get_sync_database_url() -> str:
    backend = resolve_backend(
        database_url=settings.database_url,
        database_backend=settings.database_backend,
    )
    return to_sync_url(settings.database_url, backend)


@lru_cache
def _async_engine_for(url: str) -> AsyncEngine:
    return create_async_engine(url, echo=False, pool_pre_ping=True)


@lru_cache
def _async_session_factory_for(url: str) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(_async_engine_for(url), class_=AsyncSession, expire_on_commit=False)


@lru_cache
def _sync_engine_for(url: str) -> Engine:
    return create_engine(url, echo=False, future=True, pool_pre_ping=True)


@lru_cache
def _sync_sessionmaker_for(url: str) -> sessionmaker[Session]:
    return sessionmaker(bind=_sync_engine_for(url), expire_on_commit=False, future=True)


def async_engine() -> AsyncEngine:
    """Return the async engine for the currently configured database URL."""
    return _async_engine_for(get_async_database_url())


def async_session_factory() -> async_sessionmaker[AsyncSession]:
    return _async_session_factory_for(get_async_database_url())


def sync_engine() -> Engine:
    """Return a synchronous engine for registry/dataset operations."""
    return _sync_engine_for(get_sync_database_url())


def sync_sessionmaker() -> sessionmaker[Session]:
    """Return a synchronous sessionmaker for the configured database."""
    return _sync_sessionmaker_for(get_sync_database_url())


def async_session() -> AsyncSession:
    """Open a session on the *currently* configured database.

    A plain module alias for the sessionmaker would be captured by
    ``from ... import async_session`` at import time and keep pointing at the
    engine that existed then, so a later ``settings.database_url`` change (tests
    isolating their database) would be ignored by every importer. Resolving the
    factory per call keeps the URL authoritative.
    """
    return async_session_factory()()


# Module-level alias keeps existing imports working while engines stay lazy.
def __getattr__(name: str):
    if name == "engine":
        return async_engine()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


async def _ensure_column(conn, *, table: str, column: str, ddl_type: str) -> None:
    """Add a missing column in a dialect-portable way (dev/test bootstrap only)."""

    def _missing(sync_conn) -> bool:
        insp = inspect(sync_conn)
        if not insp.has_table(table):
            return False
        return column not in {c["name"] for c in insp.get_columns(table)}

    if not await conn.run_sync(_missing):
        return
    # Portable ADD COLUMN — avoid PostgreSQL-only ``IF NOT EXISTS``.
    await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type}"))


async def init_db() -> None:
    """Bootstrap schema only for local development and isolated tests.

    Production schema changes are owned by Alembic, so a production API pod
    cannot race another replica by issuing implicit DDL at startup.
    """
    if settings.app_env not in {"dev", "test"} and not settings.database_auto_create:
        return
    # Register every table before bootstrap, even in a fresh health-only process.
    from evalhub.db import models  # noqa: F401

    engine = async_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # create_all does not ADD columns to existing tables; keep a few
        # commonly missing local/dev columns present without vendor DDL.
        try:
            await _ensure_column(
                conn, table="evaluation_runs", column="label", ddl_type="VARCHAR(256)"
            )
            await _ensure_column(
                conn,
                table="evaluation_run_items",
                column="tool_call_count",
                ddl_type="INTEGER DEFAULT 0",
            )
        except Exception:  # noqa: BLE001 — table may not exist yet on first boot
            pass
