"""Telemetry consumption profiles (RAG-style APP_CONFIG_PROFILE overlays)."""

from proofgrove.configs.app_config import (
    TELEMETRY_PROFILES,
    apply_telemetry_profile,
    resolve_telemetry_profile,
)

__all__ = [
    "TELEMETRY_PROFILES",
    "apply_telemetry_profile",
    "resolve_telemetry_profile",
]
