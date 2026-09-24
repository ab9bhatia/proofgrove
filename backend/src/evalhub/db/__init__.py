"""Database package — SQLAlchemy models, sessions, and product-agnostic backend."""

from evalhub.db.backend import (
    DatabaseBackend,
    UnsupportedDatabaseBackendError,
    resolve_backend,
)

__all__ = [
    "DatabaseBackend",
    "UnsupportedDatabaseBackendError",
    "resolve_backend",
]
