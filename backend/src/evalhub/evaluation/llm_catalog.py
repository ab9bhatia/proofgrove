"""LLM Catalog — Compass inventory plus tenant-onboarded custom models."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from evalhub.platform.url_guard import validate_outbound_url

LlmSource = Literal["compass", "custom", "openai", "ollama"]


class LlmCatalogEntry(BaseModel):
    """One model shown in the Eval Hub LLM Catalog."""

    model_id: str
    name: str
    source: LlmSource
    description: str | None = None
    endpoint: str | None = None
    target_version_id: str | None = None
    created_at: str | None = None


class CustomLlmOnboardRequest(BaseModel):
    """Tenant-supplied OpenAI-compatible LLM for the catalog."""

    model_id: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=256)
    endpoint: str = Field(min_length=1, max_length=1024)
    description: str | None = Field(default=None, max_length=2048)

    @field_validator("model_id")
    @classmethod
    def normalize_model_id(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("model_id is required")
        return cleaned

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


async def validate_custom_llm_endpoint(request: CustomLlmOnboardRequest, tenant_namespace: str) -> CustomLlmOnboardRequest:
    """Screen ``request.endpoint`` through the shared outbound-URL SSRF guard.

    A tenant-supplied endpoint is exactly the kind of caller-controlled URL that
    guard exists for; a ``field_validator`` cannot await the DNS lookup it needs
    or see the caller's tenant namespace, so onboarding must call this before the
    endpoint is persisted (and before it is ever contacted with an API key).
    """
    normalized = await validate_outbound_url(request.endpoint, tenant_namespace)
    return request.model_copy(update={"endpoint": normalized})


def compass_catalog_entries(
    model_ids: list[str],
    *,
    endpoint: str | None,
) -> list[LlmCatalogEntry]:
    """Build Compass-sourced catalog rows from AI Gateway model ids."""
    return [
        LlmCatalogEntry(
            model_id=model_id,
            name=model_id,
            source="compass",
            description="Available through the Proofgrove AI Gateway (Compass).",
            endpoint=endpoint,
        )
        for model_id in model_ids
    ]


def custom_entry_from_target(target: Any) -> LlmCatalogEntry:
    """Map a persisted TargetVersion into an LLM Catalog row."""
    configuration = getattr(target, "configuration", {}) or {}
    model_id = str(configuration.get("model_id") or target.model_version or target.name)
    description = configuration.get("description")
    created = getattr(target, "created_at", None)
    return LlmCatalogEntry(
        model_id=model_id,
        name=str(target.name),
        source="custom",
        description=str(description) if description else "Onboarded custom OpenAI-compatible LLM.",
        endpoint=str(target.endpoint),
        target_version_id=str(target.target_version_id),
        created_at=created.isoformat() if created is not None else None,
    )


def merge_catalog(
    compass: list[LlmCatalogEntry],
    custom: list[LlmCatalogEntry],
) -> list[LlmCatalogEntry]:
    """Merge newest-first custom targets over Compass, keeping the newest per model."""
    by_id = {entry.model_id: entry for entry in compass}
    for entry in reversed(custom):
        by_id[entry.model_id] = entry
    return sorted(
        by_id.values(),
        key=lambda entry: (0 if entry.source == "custom" else 1, entry.name.lower(), entry.model_id),
    )
