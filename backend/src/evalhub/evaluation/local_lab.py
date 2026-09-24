"""Local classroom model declarations, separate from provider connectivity."""

import os

from evalhub.settings import Settings


def local_lab_mode(settings: Settings) -> str | None:
    """Apply classroom behavior only to the explicit local launcher profile."""
    mode = os.environ.get("PROOFGROVE_MODE")
    if (
        mode in {"offline", "local", "live"}
        and settings.app_env == "dev"
        and settings.evaluation_runtime == "local"
        and settings.pod_namespace == "tenant-local-classroom"
    ):
        return mode
    return None


def configured_lab_models(settings: Settings) -> list[str]:
    """Explicit model ids, deduplicated; no default judge model is a target."""
    if local_lab_mode(settings) not in {"local", "live"}:
        return []
    values = [
        os.environ.get(name, "").strip()
        for name in (
            "PROOFGROVE_MODEL",
            "PROOFGROVE_MODEL_A",
            "PROOFGROVE_MODEL_B",
            "PROOFGROVE_MODEL_C",
        )
    ]
    return list(dict.fromkeys(value for value in values if value))
