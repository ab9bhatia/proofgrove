"""Version constants used for reproducibility and run lineage.

Kept dependency-free (leaf module) so it can be imported anywhere without
creating import cycles.
"""

from importlib.metadata import PackageNotFoundError, version

# Bump when the LLM-as-judge rubrics/prompts change so historical runs remain
# interpretable against the prompt version they were scored with.
PROMPT_VERSION = "rubrics.v1"


def service_version() -> str:
    """Return the installed package version (falls back for editable/dev)."""
    try:
        return version("evalai-eval-hub")
    except PackageNotFoundError:  # pragma: no cover - only in odd envs
        return "0.0.0-dev"
