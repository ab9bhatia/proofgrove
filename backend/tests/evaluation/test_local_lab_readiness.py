"""The local lab must distinguish model declarations from runnable targets."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import SecretStr
from starlette.requests import Request

from evalhub.api.v1 import llms
from evalhub.db.store import EvaluationStore
from evalhub.evaluation import model_providers
from evalhub.evaluation.enums import EvaluationScope, EvidenceReadiness, Scenario
from evalhub.evaluation.readiness import assess_evidence_readiness
from evalhub.platform.contracts import TargetVersion
from evalhub.settings import Settings, settings

TENANT = "local-classroom"


def local_settings(**overrides):
    return Settings(
        _env_file=None,
        **{
            "app_env": "dev",
            "evaluation_runtime": "local",
            "pod_namespace": "tenant-local-classroom",
            "openai_api_key": SecretStr(""),
            "openai_base_url": "https://api.openai.com/v1",
            "judge_mode": "mock",
            "judge_model": "unconfigured-default",
            **overrides,
        },
    )


@pytest.fixture
def local_mode(monkeypatch, tmp_path):
    monkeypatch.setenv("PROOFGROVE_ROOT", str(tmp_path))
    monkeypatch.setattr(model_providers, "_list_openai_models", MagicMock(return_value=["chosen-model", "gpt-4o-mini"]))
    monkeypatch.setattr(model_providers, "_list_ollama_models", AsyncMock(return_value=["llama3.2:latest"]))
    monkeypatch.setenv("PROOFGROVE_MODE", "offline")
    for name in ("PROOFGROVE_MODEL", "PROOFGROVE_MODEL_A", "PROOFGROVE_MODEL_B", "PROOFGROVE_MODEL_C"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.asyncio
async def test_offline_catalog_has_no_default_model_and_preserves_custom_targets(monkeypatch, local_mode):
    monkeypatch.setenv("PROOFGROVE_MODEL", "stale-live-model")
    monkeypatch.setattr(llms, "settings", local_settings())
    target = TargetVersion(
        target_id="custom", project_id="catalog", tenant_id="tenant-local-classroom",
        name="Private target", version="1", endpoint="https://custom.example/v1",
        model_version="private-model", configuration={"model_id": "private-model"},
    )
    store = AsyncMock()
    store.list_llm_targets.return_value = [target]
    request = Request({"type": "http", "headers": [(b"x-evalai-tenant", b"tenant-local-classroom")]})
    with patch.object(llms, "OpenAI", side_effect=AssertionError("Offline catalog must not call the provider")):
        assert await llms._list_compass_models() == ([], True)
        entries = await llms.list_llm_catalog(request, store)
    assert [item["model_id"] for item in entries] == ["private-model"]
    assert entries[0]["source"] == "custom"


@pytest.mark.asyncio
async def test_live_catalog_uses_discovered_models_without_declared_ghosts(monkeypatch, local_mode):
    monkeypatch.setenv("PROOFGROVE_MODE", "live")
    monkeypatch.setenv("PROOFGROVE_MODEL", "primary-chat")
    monkeypatch.setenv("PROOFGROVE_MODEL_A", "primary-chat")
    monkeypatch.setenv("PROOFGROVE_MODEL_B", "other-chat")
    monkeypatch.setenv("PROOFGROVE_MODEL_C", "  ")
    monkeypatch.setattr(llms, "settings", local_settings(openai_api_key=SecretStr("test-key")))
    listing = MagicMock(data=[MagicMock(id="gpt-4o-mini"), MagicMock(id="text-embedding-3-large")])
    store = AsyncMock()
    store.list_llm_targets.return_value = []
    request = Request({"type": "http", "headers": [(b"x-evalai-tenant", b"tenant-local-classroom")]})
    with patch.object(llms, "OpenAI") as provider:
        provider.return_value.models.list.return_value = listing
        entries = await llms.list_llm_catalog(request, store)
    assert {item["model_id"] for item in entries} == {"gpt-4o-mini", "llama3.2:latest"}
    assert {item["source"] for item in entries} == {"openai", "ollama"}
    assert all("Available through" not in item["description"] for item in entries)


@pytest.mark.asyncio
@pytest.mark.parametrize("has_key", [False, True])
async def test_live_fallback_is_explicit_models_not_judge_default(monkeypatch, local_mode, has_key):
    monkeypatch.setenv("PROOFGROVE_MODE", "live")
    monkeypatch.setenv("PROOFGROVE_MODEL_B", "explicit-b")
    monkeypatch.setattr(llms, "settings", local_settings(openai_api_key=SecretStr("test-key" if has_key else "")))
    with patch.object(llms, "OpenAI") as provider:
        provider.return_value.models.list.side_effect = RuntimeError("listing unavailable")
        assert await llms._list_compass_models() == (["explicit-b"], True)
        if not has_key:
            provider.assert_not_called()


@pytest.mark.asyncio
async def test_nonlocal_catalog_retains_legacy_fallback(monkeypatch, local_mode):
    monkeypatch.setattr(llms, "settings", local_settings(pod_namespace="tenant-production"))
    with patch.object(llms, "OpenAI", side_effect=AssertionError("No credentials")):
        assert await llms._list_compass_models() == (["unconfigured-default"], True)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("mode", "key", "endpoint", "overrides", "expected_code"),
    [
        ("offline", "", "https://api.openai.com/v1", {}, "local_live_profile_required"),
        ("offline", "test-key", "https://api.openai.com/v1", {}, "local_live_profile_required"),
        ("live", "", "https://api.openai.com/v1", {}, "target_credentials_missing"),
        ("live", "test-key", "https://api.openai.com/v1", {}, None),
        ("offline", "", "https://custom.example/v1", {}, "local_live_profile_required"),
        ("offline", "", "https://api.openai.com/v1", {"pod_namespace": "tenant-other"}, None),
        ("offline", "", "https://api.openai.com/v1", {"app_env": "staging"}, None),
        ("", "", "https://api.openai.com/v1", {}, None),
    ],
)
async def test_openai_target_profile_and_credentials_gate(monkeypatch, local_mode, mode, key, endpoint, overrides, expected_code):
    monkeypatch.setenv("PROOFGROVE_MODE", mode)
    result = await assess_evidence_readiness(
        response_source="llm", evaluation_scope=EvaluationScope.FINAL_RESPONSE,
        agent=None, target_model="chosen-model", target_endpoint=endpoint,
        records=[{"inputs": {"question": "What is 2 + 2?"}, "expectations": {"expected_output": "4"}}],
        active_metric_ids=["nlp.f1_score"], enable_llm_judge=False,
        scenario=Scenario.LLM_CORE, settings=local_settings(openai_api_key=SecretStr(key), **overrides),
    )
    assert result.status == (EvidenceReadiness.BLOCKED if expected_code else EvidenceReadiness.READY)
    assert [detail.code for detail in result.details] == ([expected_code] if expected_code else [])


def test_run_creation_cannot_bypass_local_credentials_readiness(client, monkeypatch, local_mode):
    monkeypatch.setenv("PROOFGROVE_MODE", "live")
    monkeypatch.setattr(settings, "pod_namespace", "tenant-local-classroom")
    monkeypatch.setattr(settings, "app_env", "dev")
    monkeypatch.setattr(settings, "evaluation_runtime", "local")
    monkeypatch.setattr(settings, "openai_api_key", SecretStr(""))
    dataset = "local_readiness_fixture"
    created = client.post("/datasets", json={"dataset_name": dataset, "tenant_id": "tenant-local-classroom", "product_id": "test", "created_by": "test"})
    assert created.status_code < 300, created.text
    added = client.post(f"/datasets/{dataset}/records", json={"records": [{"inputs": {"question": "What is 2 + 2?"}, "expectations": {"expected_output": "4"}}]})
    assert added.status_code < 300, added.text
    assert client.post(f"/datasets/{dataset}/validate").json()["passed"]
    assert client.post(f"/datasets/{dataset}/approve", json={"approved_by": "test"}).status_code < 300
    assert client.post(f"/datasets/{dataset}/publish").status_code < 300
    body = {"response_source": "llm", "target_model": "chosen-model", "target_endpoint": "https://api.openai.com/v1", "active_metrics": ["nlp.f1_score"], "enable_llm_judge": False}
    with patch.object(EvaluationStore, "create_run_job", new_callable=AsyncMock) as enqueue:
        readiness = client.post(f"/evaluation/runs/from-dataset/{dataset}/readiness", json=body)
        launch = client.post(f"/evaluation/runs/from-dataset/{dataset}", json=body)
        enqueue.assert_not_called()
    assert readiness.status_code == 200
    assert readiness.json()["status"] == "blocked"
    assert readiness.json()["details"][0]["code"] == "target_credentials_missing"
    assert launch.status_code == 422
    assert launch.json()["detail"]["code"] == "target_credentials_missing"


@pytest.mark.asyncio
async def test_local_ollama_catalog_uses_installed_models_without_cloud_credentials(monkeypatch, local_mode):
    monkeypatch.setenv("PROOFGROVE_MODE", "local")
    monkeypatch.setenv("PROOFGROVE_MODEL", "llama3.2:latest")
    monkeypatch.setattr(llms, "settings", local_settings(openai_base_url="http://127.0.0.1:11434/v1"))
    store = AsyncMock()
    store.list_llm_targets.return_value = []
    request = Request({"type": "http", "headers": [(b"x-evalai-tenant", b"tenant-local-classroom")]})
    with patch.object(llms, "OpenAI", side_effect=AssertionError("No cloud listing")):
        entries = await llms.list_llm_catalog(request, store)
    assert len(entries) == 1
    assert entries[0]["model_id"] == "llama3.2:latest"
    assert entries[0]["source"] == "ollama"
    assert entries[0]["endpoint"] == "http://127.0.0.1:11434/v1"
    result = await assess_evidence_readiness(
        response_source="llm", evaluation_scope=EvaluationScope.FINAL_RESPONSE,
        agent=None, target_model="llama3.2:latest", target_endpoint="http://127.0.0.1:11434/v1",
        records=[{"inputs": {"question": "2+2?"}, "expectations": {"expected_output": "4"}}],
        active_metric_ids=["nlp.f1_score"], enable_llm_judge=False,
        scenario=Scenario.LLM_CORE, settings=llms.settings,
    )
    assert result.status == EvidenceReadiness.READY
