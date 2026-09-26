"""Database package — SQLAlchemy models, sessions, and product-agnostic backend."""

from proofgrove.db.backend import (
    DatabaseBackend,
    UnsupportedDatabaseBackendError,
    resolve_backend,
)

__all__ = [
    "DatabaseBackend",
    "UnsupportedDatabaseBackendError",
    "resolve_backend",
]
