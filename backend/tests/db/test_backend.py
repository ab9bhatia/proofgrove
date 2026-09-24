"""Unit tests for the product-agnostic database backend registry."""

import pytest

from evalhub.db.backend import (
    UnsupportedDatabaseBackendError,
    ensure_async_url,
    get_backend,
    redact_database_url,
    resolve_backend,
    to_sync_url,
)


def test_resolve_backend_from_postgres_url():
    backend = resolve_backend(
        database_url="postgresql+asyncpg://u:p@localhost:5432/eval-hub",
    )
    assert backend.name == "postgresql"


def test_resolve_backend_explicit_override_must_match_url():
    with pytest.raises(UnsupportedDatabaseBackendError):
        resolve_backend(
            database_url="postgresql+asyncpg://u:p@localhost/db",
            database_backend="sqlite",
        )


def test_to_sync_url_swaps_known_async_drivers():
    assert (
        to_sync_url("postgresql+asyncpg://u:p@localhost/db")
        == "postgresql+psycopg://u:p@localhost/db"
    )
    assert to_sync_url("sqlite+aiosqlite:///:memory:") == "sqlite:///:memory:"


def test_ensure_async_url_adds_default_driver():
    assert (
        ensure_async_url("postgresql://u:p@localhost/db")
        == "postgresql+asyncpg://u:p@localhost/db"
    )


def test_unsupported_backend_mentions_databricks_exclusion():
    with pytest.raises(UnsupportedDatabaseBackendError, match="Databricks"):
        get_backend("databricks")


def test_redact_database_url_hides_password():
    assert (
        redact_database_url("postgresql+asyncpg://eval:secret@localhost:5432/eval-hub")
        == "postgresql+asyncpg://eval:***@localhost:5432/eval-hub"
    )


@pytest.mark.parametrize("backend", ["mysql", "mssql", "oracle"])
def test_unvalidated_database_backends_are_rejected(backend):
    with pytest.raises(UnsupportedDatabaseBackendError):
        get_backend(backend)


@pytest.mark.parametrize("app_env", ["dev", "test"])
def test_init_db_bootstraps_fresh_database_without_prior_model_import(tmp_path, app_env):
    import os
    import subprocess
    import sys
    from pathlib import Path

    # A new interpreter avoids conftest's model imports masking startup ordering.
    source = Path(__file__).resolve().parents[2] / "src"
    result = subprocess.run(
        [sys.executable, "-c", """
import asyncio
from sqlalchemy import inspect, select
from evalhub.db.session import async_engine, init_db

async def check():
    await init_db()
    await init_db()  # Restarting against the same database is safe.
    from evalhub.db.models import Base
    engine = async_engine()
    async with engine.connect() as conn:
        tables = await conn.run_sync(lambda sync: inspect(sync).get_table_names())
        assert set(tables) == set(Base.metadata.tables), tables
        for table in Base.metadata.sorted_tables:
            await conn.execute(select(table).limit(1))
    await engine.dispose()

asyncio.run(check())
"""],
        env={
            **os.environ,
            "PYTHONPATH": str(source),
            "APP_ENV": app_env,
            "DATABASE_URL": f"sqlite+aiosqlite:///{tmp_path / 'fresh.db'}",
            "DATABASE_AUTO_CREATE": "false",
        },
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("mode", ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"])
@pytest.mark.parametrize("driver", ["postgresql", "postgresql+asyncpg"])
def test_postgres_tls_options_follow_driver(mode, driver):
    import inspect

    import asyncpg
    from psycopg import connect as psycopg_connect
    from psycopg.conninfo import make_conninfo
    from sqlalchemy import create_engine
    from sqlalchemy.ext.asyncio import create_async_engine

    original = f"{driver}://user:p%40ss@localhost/db?sslmode={mode}&port=5433"
    async_url = ensure_async_url(original)
    engine = create_async_engine(async_url)
    _, arguments = engine.dialect.create_connect_args(engine.url)
    inspect.signature(asyncpg.connect).bind_partial(**arguments)
    assert arguments["ssl"] == mode
    assert engine.url.password == "p@ss"
    assert engine.url.query["port"] == "5433"
    sync = create_engine(to_sync_url(async_url))
    _, arguments = sync.dialect.create_connect_args(sync.url)
    # psycopg consumes adapter context before passing connection options to libpq.
    options = inspect.signature(psycopg_connect).bind_partial(**arguments).arguments["kwargs"]
    make_conninfo(**options)
    assert arguments["sslmode"] == mode
    assert "ssl" not in arguments
    assert sync.url.password == "p@ss"


@pytest.mark.parametrize("convert", [ensure_async_url, to_sync_url])
def test_conflicting_tls_options_are_rejected(convert):
    with pytest.raises(ValueError, match="Conflicting PostgreSQL TLS options"):
        convert("postgresql+asyncpg://user:private@localhost/db?ssl=disable&sslmode=verify-full")


def test_matching_tls_aliases_keep_the_requested_mode():
    url = "postgresql+asyncpg://u:p@localhost/db?ssl=require&sslmode=require"
    assert ensure_async_url(url).endswith("?ssl=require")
    assert to_sync_url(url).endswith("?sslmode=require")


@pytest.mark.parametrize("driver", ["postgres", "postgres+asyncpg", "postgres+psycopg"])
@pytest.mark.parametrize("convert", [ensure_async_url, to_sync_url])
def test_postgres_alias_resolves_to_an_installed_sqlalchemy_dialect(driver, convert):
    from sqlalchemy import create_engine
    from sqlalchemy.ext.asyncio import create_async_engine

    url = convert(f"{driver}://user:p%40ss@localhost/db?sslmode=require")
    engine = (create_async_engine if convert is ensure_async_url else create_engine)(url)
    assert engine.url.get_backend_name() == "postgresql"
    assert engine.url.password == "p@ss"
    _, arguments = engine.dialect.create_connect_args(engine.url)
    assert arguments["ssl" if engine.url.get_driver_name() == "asyncpg" else "sslmode"] == "require"
