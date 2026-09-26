"""Dataset synthesis follows the selected connected provider, without real model calls."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from proofgrove.datasets import generation_service
from proofgrove.errors import EvaluationInputError
from proofgrove.evaluation import model_providers as providers
from proofgrove.generation import pipeline
from proofgrove.main import app
from proofgrove.settings import settings

OPENAI = providers.OPENAI_ENDPOINT
OLLAMA = providers.OLLAMA_ENDPOINT
KEY = "private-test-generation-key"


@pytest.fixture
def local(monkeypatch, tmp_path):
    monkeypatch.setenv("PROOFGROVE_MODE", "local")
    monkeypatch.setenv("PROOFGROVE_ROOT", str(tmp_path))
    monkeypatch.setenv("PROOFGROVE_MODEL", "llama3.2:latest")
    for field, value in {"app_env": "dev", "evaluation_runtime": "local", "pod_namespace": "tenant-local-classroom", "openai_api_key": SecretStr(""), "openai_base_url": OLLAMA, "judge_mode": "mock"}.items():
        monkeypatch.setattr(settings, field, value)
    monkeypatch.setattr(providers, "_list_openai_models", MagicMock(return_value=["gpt-4o-mini"]))
    monkeypatch.setattr(providers, "_list_ollama_models", AsyncMock(return_value=["llama3.2:latest"]))
    return tmp_path


@pytest.fixture
def sdk(monkeypatch):
    factories, calls = [], []
    def create(**kwargs):
        factories.append(kwargs)
        client = MagicMock()
        def completion(**body):
            calls.append(body)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({"records": [{"question": "What is 2+2?", "expected_output": "4", "risk": "Low"}]})))])
        client.chat.completions.create.side_effect = completion
        client.__enter__.return_value = client
        client.__exit__.side_effect = lambda *_: kwargs["http_client"].close()
        return client
    monkeypatch.setattr("openai.OpenAI", create)
    return factories, calls


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,model,endpoint,key", [("ollama", "llama3.2:latest", OLLAMA, "not-needed"), ("openai", "gpt-4o-mini", OPENAI, KEY)])
async def test_synthesis_routes_endpoint_and_isolates_credentials(local, sdk, provider, model, endpoint, key):
    # Saving a connected OpenAI key must not cause it to reach Ollama.
    await providers.connect_openai(settings, KEY)
    records = await pipeline._generate_from_prompt({"seeds": ["One basic maths example"], "num_rows": 1, "model": model, "model_endpoint": endpoint})
    factories, calls = sdk
    assert records[0].inputs["question"] == "What is 2+2?"
    assert records[0].expectations["expected_output"] == "4"
    assert factories[0]["base_url"] == endpoint
    assert factories[0]["api_key"] == key
    assert factories[0]["max_retries"] == 0
    assert calls[0]["model"] == model
    if provider == "ollama":
        assert calls[0]["response_format"]["type"] == "json_schema"
        schema = calls[0]["response_format"]["json_schema"]["schema"]
        assert schema["properties"]["records"]["minItems"] == 1
    else:
        assert calls[0]["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_worker_rechecks_disconnect_before_any_generation(local, sdk):
    await providers.connect_openai(settings, KEY)
    complete = pipeline._build_gateway_complete("gpt-4o-mini", OPENAI)
    await providers.disconnect_openai(settings)
    with pytest.raises(EvaluationInputError, match="not connected"):
        await complete([{"role": "user", "content": "Create a row"}])
    assert sdk[0] == []


@pytest.mark.asyncio
async def test_offline_and_unknown_endpoints_never_invoke(local, sdk, monkeypatch):
    with pytest.raises(EvaluationInputError, match="connected OpenAI and local Ollama"):
        await pipeline._build_gateway_complete("gpt-4o-mini", "https://untrusted.example/v1")([])
    monkeypatch.setenv("PROOFGROVE_MODE", "offline")
    monkeypatch.setattr(providers, "_state_path", MagicMock(side_effect=AssertionError("offline must not read a key")))
    with pytest.raises(EvaluationInputError, match="Offline rehearsal"):
        await pipeline._build_gateway_complete("llama3.2:latest", OLLAMA)([])
    assert sdk[0] == []


@pytest.mark.asyncio
async def test_legacy_local_selection_resolves_real_provider_and_rejects_collision(local):
    await providers.connect_openai(settings, KEY)
    assert await pipeline.resolve_generation_target("gpt-4o-mini") == ("gpt-4o-mini", OPENAI)
    assert await pipeline.resolve_generation_target(None) == ("llama3.2:latest", OLLAMA)
    providers._list_ollama_models.return_value = ["llama3.2:latest", "gpt-4o-mini"]
    with pytest.raises(EvaluationInputError, match="model and its provider"):
        await pipeline.resolve_generation_target("gpt-4o-mini")


@pytest.mark.asyncio
async def test_nonlocal_keeps_configured_gateway_and_rejects_other_endpoints(local, monkeypatch, sdk):
    monkeypatch.setattr(settings, "pod_namespace", "tenant-production")
    monkeypatch.setattr(settings, "openai_base_url", "https://gateway.example/v1")
    monkeypatch.setattr(settings, "openai_api_key", SecretStr(KEY))
    await pipeline._build_gateway_complete("gpt-4o-mini")([{"role": "user", "content": "Produce JSON"}])
    assert sdk[0][0]["base_url"] == "https://gateway.example/v1"
    assert sdk[0][0]["api_key"] == KEY
    with pytest.raises(EvaluationInputError, match="configured model gateway"):
        await pipeline.resolve_generation_target("gpt-4o-mini", OPENAI)


@pytest.mark.asyncio
@pytest.mark.parametrize("model,endpoint,expected", [("gpt-4o-mini", OPENAI, "not connected"), ("not-installed", OLLAMA, "not available"), ("x", "https://custom.example/v1", "connected OpenAI and local Ollama")])
async def test_api_blocks_unavailable_generation_before_enqueue(local, monkeypatch, model, endpoint, expected):
    start = AsyncMock()
    monkeypatch.setattr(generation_service, "start_generation", start)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", headers={"x-evalai-tenant": "local-classroom"}) as client:
        response = await client.post("/datasets/generate", json={"dataset_name": "provider_check", "generation_method": "llms", "seeds": ["Make a maths case"], "num_rows": 1, "model": model, "model_endpoint": endpoint})
    assert response.status_code == 422
    assert expected in response.json()["detail"]
    start.assert_not_called()


@pytest.mark.asyncio
async def test_api_job_generates_real_mocked_provider_records_as_draft(local, sdk):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", headers={"x-evalai-tenant": "local-classroom"}) as client:
        response = await client.post("/datasets/generate", json={"dataset_name": "provider_roundtrip", "generation_method": "llms", "seeds": ["One maths case"], "num_rows": 1, "model": "llama3.2:latest", "model_endpoint": OLLAMA})
        assert response.status_code == 202, response.text
        job_id = response.json()["job_id"]
        for _ in range(100):
            job = (await client.get(f"/datasets/generation-jobs/{job_id}")).json()
            if job["phase"] in {"completed", "failed"}:
                break
            await asyncio.sleep(0.02)
        assert job["phase"] == "completed", job
        assert job["progress"] == {"done": 1, "total": 1}
        dataset = (await client.get("/datasets/provider_roundtrip")).json()
        assert dataset["status"] == "DRAFT"
        assert dataset["record_count"] == 1
        records = (await client.get("/datasets/provider_roundtrip/records")).json()
        assert records[0]["expectations"]["expected_output"] == "4"
    assert len(sdk[1]) == 1
