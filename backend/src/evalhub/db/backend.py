"""Database-product abstraction for Eval Hub persistence.

Eval Hub talks to relational stores through SQLAlchemy. The concrete product
(PostgreSQL or SQLite) is selected by
configuration — primarily ``DATABASE_URL`` — not by application branching.

PostgreSQL is the production backend (ADR-26-05-13); SQLite supports tests.
Other database products require their own migration validation before support.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy.engine import make_url
from sqlalchemy.engine.url import URL


@dataclass(frozen=True, slots=True)
class DatabaseBackend:
    """Descriptor for one SQLAlchemy-supported relational backend."""

    name: str
    dialects: frozenset[str]
    default_async_driver: str
    default_sync_driver: str
    transactional_oltp: bool = True

    def matches(self, dialect: str) -> bool:
        return dialect.lower() in self.dialects


# Registry of known backends. Drivers beyond Postgres/SQLite are optional extras
# so the default image stays lean.
BACKENDS: tuple[DatabaseBackend, ...] = (
    DatabaseBackend(
        name="postgresql",
        dialects=frozenset({"postgresql", "postgres"}),
        default_async_driver="asyncpg",
        default_sync_driver="psycopg",
    ),
    DatabaseBackend(
        name="sqlite",
        dialects=frozenset({"sqlite"}),
        default_async_driver="aiosqlite",
        default_sync_driver="",
    ),

)


class UnsupportedDatabaseBackendError(ValueError):
    """Raised when DATABASE_URL / DATABASE_BACKEND cannot be resolved."""


def get_backend(name_or_dialect: str) -> DatabaseBackend:
    key = name_or_dialect.strip().lower()
    for backend in BACKENDS:
        if backend.name == key or backend.matches(key):
            return backend
    supported = ", ".join(b.name for b in BACKENDS)
    raise UnsupportedDatabaseBackendError(
        f"Unsupported database backend {name_or_dialect!r}. "
        f"Supported: {supported}. "
        "Analytical warehouses (e.g. Databricks SQL) are not OLTP backends for Eval Hub."
    )


def dialect_from_url(database_url: str) -> str:
    """Return the SQLAlchemy dialect name from a URL string."""

    return make_url(database_url).get_backend_name()


def resolve_backend(
    *,
    database_url: str,
    database_backend: str | None = None,
) -> DatabaseBackend:
    """Resolve the active backend from explicit override or URL dialect."""

    if database_backend and database_backend.strip():
        backend = get_backend(database_backend)
        url_dialect = dialect_from_url(database_url)
        if not backend.matches(url_dialect):
            raise UnsupportedDatabaseBackendError(
                f"DATABASE_BACKEND={backend.name!r} does not match "
                f"DATABASE_URL dialect {url_dialect!r}."
            )
        return backend
    return get_backend(dialect_from_url(database_url))


def ensure_async_url(database_url: str, backend: DatabaseBackend | None = None) -> str:
    """Normalise a URL to the backend's preferred async SQLAlchemy driver."""

    url = make_url(database_url)
    backend = backend or get_backend(url.get_backend_name())
    if not backend.transactional_oltp:
        raise UnsupportedDatabaseBackendError(
            f"Backend {backend.name!r} is not a supported transactional store for Eval Hub."
        )
    if "+" in url.drivername:
        return _render_url(url)
    if not backend.default_async_driver:
        return _render_url(url)
    return _render_url(
        url.set(drivername=f"{url.get_backend_name()}+{backend.default_async_driver}")
    )


def to_sync_url(database_url: str, backend: DatabaseBackend | None = None) -> str:
    """Derive a synchronous SQLAlchemy URL from an async (or bare) URL."""

    url = make_url(database_url)
    backend = backend or get_backend(url.get_backend_name())
    dialect = url.get_backend_name()

    # Explicit async → sync driver swaps for known pairs.
    async_to_sync = {
        "asyncpg": "psycopg",
        "aiosqlite": "",
    }
    if "+" in url.drivername:
        _dialect, driver = url.drivername.split("+", 1)
        sync_driver = async_to_sync.get(driver, backend.default_sync_driver)
        if sync_driver:
            return _render_url(url.set(drivername=f"{dialect}+{sync_driver}"))
        return _render_url(url.set(drivername=dialect))

    if backend.default_sync_driver:
        return _render_url(url.set(drivername=f"{dialect}+{backend.default_sync_driver}"))
    return _render_url(url.set(drivername=dialect))


def _render_url(url: URL) -> str:
    """Normalize PostgreSQL TLS option names and render without masking credentials.

    ``str(URL)`` hides passwords as ``***``, which breaks engine creation if we
    round-trip a URL object. Callers that need log-safe output must use
    ``redact_database_url``.
    """

    if url.get_backend_name() == "postgres":
        url = url.set(drivername=url.drivername.replace("postgres", "postgresql", 1))
    if url.get_backend_name() == "postgresql":
        driver = url.get_driver_name()
        source, target = ("sslmode", "ssl") if driver == "asyncpg" else ("ssl", "sslmode")
        query = dict(url.query)
        if source in query:
            if target in query and query[target] != query[source]:
                raise ValueError("Conflicting PostgreSQL TLS options")
            query[target] = query.pop(source)
            url = url.set(query=query)
    return url.render_as_string(hide_password=False)


def redact_database_url(database_url: str) -> str:
    """Return a log-safe URL with password removed."""

    parts = urlsplit(database_url)
    if "@" not in parts.netloc:
        return database_url
    userinfo, hostinfo = parts.netloc.rsplit("@", 1)
    user = userinfo.split(":", 1)[0]
    return urlunsplit((parts.scheme, f"{user}:***@{hostinfo}", parts.path, parts.query, parts.fragment))
