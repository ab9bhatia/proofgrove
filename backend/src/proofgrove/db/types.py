"""Portable SQLAlchemy column types for Proofgrove.

JSON columns use the generic ``JSON`` type with dialect variants where a
backend provides a native JSON type. Application code must not import
vendor-specific types (for example ``JSONB``) directly.
"""

from __future__ import annotations

from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import JSONB

# Prefer native JSONB on PostgreSQL; fall back to SQLAlchemy JSON elsewhere
# (SQLite, MySQL, MSSQL, Oracle via dialect JSON implementations).
JsonType = JSON().with_variant(JSONB(), "postgresql")
