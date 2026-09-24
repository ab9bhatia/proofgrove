"""Telemetry profiles for Eval Hub.

Operators select `default` (RabbitMQ + MinIO) or `azure` (Service Bus + Blob)
via `APP_CONFIG_PROFILE` / `TRACE_ARCHIVE_PROFILE`. Eval Hub only reads the
object store; the queue side is owned by eval-hub-collector and trace-archive-sink
and must use the same profile name.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any, Final

TELEMETRY_PROFILES: Final[dict[str, dict[str, Any]]] = {
    "default": {
        "queue": "rabbitmq",
        "storage": "minio",
        "auth_mode": "accessKey",
        "force_path_style": True,
    },
    "azure": {
        "queue": "service_bus",
        "storage": "azure",
        "auth_mode": "workloadIdentity",
        "force_path_style": False,
    },
}

PROFILES: Final[frozenset[str]] = frozenset(TELEMETRY_PROFILES)


def resolve_telemetry_profile(
    profile: str | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> str:
    env = environ if environ is not None else os.environ
    raw = (
        profile
        or env.get("TRACE_ARCHIVE_PROFILE")
        or env.get("APP_CONFIG_PROFILE")
        or "default"
    )
    name = raw.strip().lower()
    if name not in PROFILES:
        raise ValueError(f"telemetry profile must be one of {sorted(PROFILES)}, got {raw!r}")
    return name




def apply_telemetry_profile(settings: Any, profile: str | None = None) -> str:
    """Stamp object-store defaults for the selected profile onto Settings."""
    name = resolve_telemetry_profile(profile)
    spec = TELEMETRY_PROFILES[name]
    settings.trace_archive_profile = name
    settings.trace_archive_auth_mode = spec["auth_mode"]
    settings.trace_archive_force_path_style = spec["force_path_style"]
    return name
