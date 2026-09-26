"""Tests for the LLM Catalog (Compass + custom onboarding)."""

from __future__ import annotations

import ipaddress
from unittest.mock import MagicMock, patch

import pytest
from pydantic import SecretStr

from proofgrove.api.v1 import llms as llm_routes
from proofgrove.evaluation.llm_catalog import (
    CustomLlmOnboardRequest,
    LlmCatalogEntry,
    compass_catalog_entries,
    custom_entry_from_target,
    merge_catalog,
    validate_custom_llm_endpoint,
)
from proofgrove.platform.contracts import TargetType, TargetVersion
from proofgrove.platform.url_guard import AgentCatalogError
from proofgrove.settings import settings


def test_merge_catalog_prefers_custom_over_compass():
    compass = compass_catalog_entries(["gpt-4.1-mini", "claude-sonnet-4.6"], endpoint="http://gw/v1")
    custom = [
        LlmCatalogEntry(
            model_id="gpt-4.1-mini",
            name="Tenant GPT",
            source="custom",
            endpoint="https://llm.example.com/v1",
        )
    ]
    merged = merge_catalog(compass, custom)
    by_id = {entry.model_id: entry for entry in merged}
    assert by_id["gpt-4.1-mini"].source == "custom"
    assert by_id["gpt-4.1-mini"].name == "Tenant GPT"
    assert by_id["claude-sonnet-4.6"].source == "compass"


def test_custom_entry_from_target_sets_source_label():
    target = TargetVersion(
        target_id="llm-1",
        project_id="proj",
        tenant_id="tenant-evalai",
        name="Private Judge",
        version="1",
        endpoint="https://llm.example.com/v1",
        target_type=TargetType.ENDPOINT,
        model_version="private-judge",
        configuration={
            "catalog_source": "custom_llm",
            "model_id": "private-judge",
            "description": "Internal judge model",
        },
    )
    entry = custom_entry_from_target(target)
    assert entry.source == "custom"
    assert entry.model_id == "private-judge"
    assert entry.description == "Internal judge model"


def test_list_llm_catalog_includes_source_labels(client, monkeypatch):
    monkeypatch.setattr(settings, "pod_namespace", "")
    monkeypatch.setattr(settings, "openai_api_key", SecretStr("test-key"))
    monkeypatch.setattr(settings, "openai_base_url", "http://ai-gateway.example/v1")
    monkeypatch.setattr(settings, "judge_provider", "openai")
    monkeypatch.setattr(settings, "judge_model", "gpt-4.1-mini")

    listing = MagicMock()
    listing.data = [
        MagicMock(id="gpt-4.1-mini"),
        MagicMock(id="text-embedding-3-large"),
        MagicMock(id="claude-opus-4.6"),
    ]

    async def immediate(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    with (
        patch.object(llm_routes, "OpenAI") as openai_cls,
        patch.object(llm_routes, "run_in_threadpool", side_effect=immediate),
    ):
        openai_cls.return_value.models.list.return_value = listing
        response = client.get(
            "/evaluation/llm-catalog",
            headers={"x-evalai-tenant": "llm-catalog-a"},
        )

    assert response.status_code == 200
    body = response.json()
    assert {row["model_id"] for row in body} == {"gpt-4.1-mini", "claude-opus-4.6"}
    assert all(row["source"] == "compass" for row in body)
    assert all("source" in row for row in body)


def test_onboard_custom_llm_persists_with_custom_source(client, monkeypatch):
    monkeypatch.setattr(settings, "pod_namespace", "")

    async def _resolve(host, port):
        return [ipaddress.ip_address("93.184.216.34")]

    from proofgrove.evaluation.target import catalog as target_catalog

    monkeypatch.setattr(target_catalog, "resolve_endpoint_addresses", _resolve)
    monkeypatch.setattr(settings, "openai_api_key", SecretStr("test-key"))
    monkeypatch.setattr(settings, "openai_base_url", "http://ai-gateway.example/v1")
    monkeypatch.setattr(settings, "judge_provider", "openai")
    monkeypatch.setattr(settings, "judge_model", "gpt-4.1-mini")

    headers = {"x-evalai-tenant": "llm-catalog-b"}
    created = client.post(
        "/evaluation/llm-catalog",
        headers=headers,
        json={
            "model_id": "acme-judge-v1",
            "name": "Acme Judge",
            "endpoint": "https://llm.acme.example/v1",
            "description": "Tenant BYO judge",
        },
    )
    assert created.status_code == 201, created.text
    entry = created.json()
    assert entry["source"] == "custom"
    assert entry["model_id"] == "acme-judge-v1"
    assert entry["name"] == "Acme Judge"

    listing = MagicMock()
    listing.data = [MagicMock(id="gpt-4.1-mini")]

    async def immediate(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    with (
        patch.object(llm_routes, "OpenAI") as openai_cls,
        patch.object(llm_routes, "run_in_threadpool", side_effect=immediate),
    ):
        openai_cls.return_value.models.list.return_value = listing
        response = client.get("/evaluation/llm-catalog", headers=headers)

    assert response.status_code == 200
    by_id = {row["model_id"]: row for row in response.json()}
    assert by_id["acme-judge-v1"]["source"] == "custom"
    assert by_id["gpt-4.1-mini"]["source"] == "compass"


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://169.254.169.254/latest/meta-data/",
        "http://svc.other-tenant.svc.cluster.local",
        "http://localhost:8080/v1",
    ],
)
def test_onboard_custom_llm_rejects_ssrf_targeted_endpoints(client, monkeypatch, endpoint):
    """A custom LLM endpoint is the same class of outbound URL an onboarded
    agent endpoint is -- cloud metadata, a cross-tenant in-cluster service, and
    localhost must all be refused before the endpoint is ever persisted or
    called, exactly as ``normalize_agent_endpoint`` already refuses them for
    agents.
    """
    monkeypatch.setattr(settings, "pod_namespace", "")

    response = client.post(
        "/evaluation/llm-catalog",
        headers={"x-evalai-tenant": "llm-catalog-ssrf"},
        json={
            "model_id": "unsafe-model",
            "name": "Unsafe",
            "endpoint": endpoint,
        },
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_validate_custom_llm_endpoint_accepts_a_public_endpoint():
    async def dns(host, port):
        return [ipaddress.ip_address("93.184.216.34")]

    request = CustomLlmOnboardRequest(model_id="my-model", endpoint="https://api.example.com/v1")
    with patch("proofgrove.evaluation.target.catalog.resolve_endpoint_addresses", dns):
        validated = await validate_custom_llm_endpoint(request, "proofgrove")
    assert validated.endpoint == "https://api.example.com/v1"


@pytest.mark.asyncio
async def test_validate_custom_llm_endpoint_rejects_a_hostname_resolving_to_metadata():
    async def dns(host, port):
        return [ipaddress.ip_address("169.254.169.254")]

    request = CustomLlmOnboardRequest(model_id="my-model", endpoint="https://sneaky.example.com/v1")
    with patch("proofgrove.evaluation.target.catalog.resolve_endpoint_addresses", dns):
        with pytest.raises(AgentCatalogError, match="private or local"):
            await validate_custom_llm_endpoint(request, "proofgrove")


@pytest.mark.asyncio
async def test_validate_custom_llm_endpoint_rejects_a_loopback_literal():
    request = CustomLlmOnboardRequest(model_id="my-model", endpoint="http://127.0.0.1:8000/v1")
    with patch("proofgrove.evaluation.target.catalog.resolve_endpoint_addresses") as dns:
        with pytest.raises(AgentCatalogError):
            await validate_custom_llm_endpoint(request, "proofgrove")
    dns.assert_not_called()


def test_gateway_listing_failure_is_logged_by_type_only(client, monkeypatch, caplog):
    """An SDK error can echo the gateway URL and a key fragment; the log keeps the type."""
    import logging

    monkeypatch.setattr(settings, "pod_namespace", "")
    monkeypatch.setattr(settings, "openai_api_key", SecretStr("test-key"))
    monkeypatch.setattr(settings, "openai_base_url", "http://ai-gateway.example/v1")
    monkeypatch.setattr(settings, "judge_provider", "openai")
    monkeypatch.setattr(settings, "judge_model", "gpt-4.1-mini")

    async def immediate(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    with (
        patch.object(llm_routes, "OpenAI") as openai_cls,
        patch.object(llm_routes, "run_in_threadpool", side_effect=immediate),
        caplog.at_level(logging.WARNING, logger="proofgrove"),
    ):
        openai_cls.return_value.models.list.side_effect = RuntimeError("401 at http://ai-gateway.example/v1/models key=sk-sentinel-fragment")
        response = client.get("/evaluation/llm-catalog", headers={"x-evalai-tenant": "llm-catalog-a"})

    assert response.status_code == 200
    warnings = [record for record in caplog.records if record.name == "proofgrove.api.v1.llms"]
    assert warnings and warnings[0].error_type == "RuntimeError"
    for record in warnings:
        assert "sk-sentinel-fragment" not in str(vars(record))
        assert "ai-gateway.example" not in str(vars(record))


def test_catalog_returns_newest_endpoint_for_same_model(client, monkeypatch):
    monkeypatch.setattr(settings, "pod_namespace", "")

    async def resolve(host, port):
        return [ipaddress.ip_address("93.184.216.34")]

    async def compass():
        return ["shared-model"], False

    monkeypatch.setattr("proofgrove.evaluation.target.catalog.resolve_endpoint_addresses", resolve)
    monkeypatch.setattr(llm_routes, "_list_compass_models", compass)
    headers = {"x-evalai-tenant": "llm-catalog-newest"}
    registrations = []
    for host in ("first", "second"):
        response = client.post("/evaluation/llm-catalog", headers=headers, json={
            "model_id": "shared-model", "endpoint": f"https://{host}.example.com/v1",
        })
        assert response.status_code == 201, response.text
        registrations.append(response.json())
    assert registrations[0]["target_version_id"] != registrations[1]["target_version_id"]
    # Repeating the old registration is idempotent, not a new registration.
    repeated = client.post("/evaluation/llm-catalog", headers=headers, json={
        "model_id": "shared-model", "endpoint": registrations[0]["endpoint"],
    })
    assert repeated.status_code == 201
    assert repeated.json()["target_version_id"] == registrations[0]["target_version_id"]
    listing = client.get("/evaluation/llm-catalog", headers=headers)
    assert listing.status_code == 200
    assert len(listing.json()) == 1
    for key in ("model_id", "source", "endpoint", "target_version_id"):
        assert listing.json()[0][key] == registrations[1][key]
