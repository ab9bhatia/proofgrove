"""Pytest configuration — offline sqlite + mock judge."""

import os
import shutil

# Must be set before any src imports
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["JUDGE_MODE"] = "mock"
os.environ["OPENAI_API_KEY"] = ""
# Keep the test identity and adapter setup isolated from the classroom .env.
os.environ["POD_NAMESPACE"] = ""
os.environ["PLATFORM_AUTH_REQUIRED"] = "false"
os.environ["EVALUATION_RUNTIME"] = "local"
os.environ["JUDGE_USE_FRAMEWORKS"] = "true"
os.environ["TRACE_ARCHIVE_ENABLED"] = "false"
os.environ["TRACE_INDEX_ENABLED"] = "false"

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine

from proofgrove.api import dependencies
from proofgrove.db import session as db_session
from proofgrove.main import app, lifespan
from proofgrove.settings import settings

# Caches that hold an engine / sessionmaker / client bound to one database URL.
# All of them have to be dropped when the URL changes, or a test would keep
# writing to the previous test's database.
_URL_BOUND_CACHES = (
    db_session._async_engine_for,
    db_session._async_session_factory_for,
    db_session._sync_engine_for,
    db_session._sync_sessionmaker_for,
    dependencies.get_storage_client,
    dependencies.get_registry_service,
)


@event.listens_for(Engine, "connect")
def _speed_up_throwaway_sqlite(dbapi_connection, _record) -> None:
    """Drop durability guarantees for the throwaway per-test databases.

    Each test database is deleted with its tmp dir, so fsync-per-commit buys
    nothing and dominates the suite runtime.
    """
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA journal_mode=MEMORY")
        cursor.execute("PRAGMA synchronous=OFF")
    finally:
        cursor.close()


def _clear_url_bound_caches() -> None:
    for cache in _URL_BOUND_CACHES:
        cache.cache_clear()


@pytest.fixture(scope="session")
def _schema_template(tmp_path_factory):
    """Build the schema once; every test starts from a copy of this file."""
    path = tmp_path_factory.mktemp("schema") / "template.db"
    engine = create_engine(f"sqlite:///{path}")
    db_session.Base.metadata.create_all(engine)
    engine.dispose()
    return path


@pytest.fixture(autouse=True)
async def isolated_database(tmp_path, _schema_template):
    """Give every test its own database.

    A single session-wide ``sqlite+aiosqlite:///:memory:`` is served by one
    ``StaticPool`` connection that every session shares, so the background run
    worker the app lifespan starts and the request under test interleave
    transactions on the *same* connection — a rollback in one can discard a
    commit the other just made, which is why an experiment written moments
    earlier could read back as ``None``. Committed rows also leaked from test to
    test.

    A per-test file database fixes both: the URL is unique per test, and a file
    SQLite engine hands every session its own connection instead of sharing one.
    The schema arrives as a file copy so a test that never calls ``init_db``
    (and never starts the app) still finds its tables, exactly as it did when an
    earlier test had already populated the shared database.
    """
    database = tmp_path / "proofgrove.db"
    shutil.copyfile(_schema_template, database)
    previous = settings.database_url
    settings.database_url = f"sqlite+aiosqlite:///{database}"
    _clear_url_bound_caches()
    try:
        yield
    finally:
        db_session.sync_engine().dispose()
        await db_session.async_engine().dispose()
        _clear_url_bound_caches()
        settings.database_url = previous


def act_as(client, tenant: str) -> None:
    """Present the tenant identity the gateway would inject for this caller.

    A request carries exactly one identity, so a test that exercises more than
    one tenant switches between them rather than presenting none.
    """
    client.headers["x-evalai-tenant"] = tenant


@pytest.fixture
def client(request):
    """A client that acts as a tenant, the way every real caller does.

    In production the gateway injects ``x-evalai-tenant`` (and Proofgrove is
    deployed per tenant, so ``POD_NAMESPACE`` stands in for it in-cluster) —
    an identity-less request never reaches a route. A test module declares
    which tenant it runs as with a module-level ``TENANT``; the fixture sends
    that as the header so the suite models a real caller rather than one the
    guard would refuse.
    """
    tenant = getattr(request.module, "TENANT", None)
    headers = {"x-evalai-tenant": tenant} if tenant else {}
    with TestClient(app, headers=headers) as c:
        yield c


@pytest.fixture
async def async_client(request):
    """The async counterpart to ``client``, for tests that ``await`` requests.

    Same tenant header (from the module's ``TENANT``), same app lifespan
    startup/shutdown, same app wiring — just over ``httpx.AsyncClient`` +
    ``ASGITransport`` instead of ``TestClient``, for call sites that need an
    awaitable client rather than a sync one.
    """
    tenant = getattr(request.module, "TENANT", None)
    headers = {"x-evalai-tenant": tenant} if tenant else {}
    async with lifespan(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test", headers=headers) as ac:
            yield ac
