"""Fixed local providers: metadata-only setup, private storage and route isolation."""

import json
import stat
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from pydantic import SecretStr
from starlette.requests import Request

from evalhub.api.v1 import llms
from evalhub.evaluation import model_providers as providers
from evalhub.evaluation.enums import EvaluationScope, EvidenceReadiness, Scenario
from evalhub.evaluation.readiness import assess_evidence_readiness
from evalhub.evaluation.target import llm_runner
from evalhub.platform.contracts import TargetVersion
from evalhub.settings import settings

PREFIX = "/evaluation/model-providers"
KEY = "test-private-provider-key-never-return"


@pytest.fixture
def local(monkeypatch, tmp_path):
    monkeypatch.setenv("PROOFGROVE_MODE", "local")
    monkeypatch.setenv("PROOFGROVE_ROOT", str(tmp_path))
    monkeypatch.setenv("PROOFGROVE_MODEL", "llama3.2:latest")
    for field, value in {"app_env": "dev", "evaluation_runtime": "local", "pod_namespace": "tenant-local-classroom", "openai_api_key": SecretStr(""), "openai_base_url": providers.OLLAMA_ENDPOINT, "judge_mode": "mock"}.items():
        monkeypatch.setattr(settings, field, value)
    monkeypatch.setattr(providers, "_list_openai_models", MagicMock(return_value=["gpt-4o-mini", "gpt-5-mini"]))
    monkeypatch.setattr(providers, "_list_ollama_models", AsyncMock(return_value=["llama3.2:latest", "gpt-4o-mini"]))
    return tmp_path / ".local" / "model-providers.json"


def connect(client):
    response = client.post(PREFIX + "/openai", json={"api_key": KEY, "allow_paid_calls": True})
    assert response.status_code == 200, response.text
    return response


def test_connect_and_default_are_private_metadata_only(client, local, caplog):
    response = connect(client)
    providers._list_openai_models.assert_called_once_with(KEY)
    assert KEY not in response.text and KEY not in caplog.text
    assert stat.S_IMODE(local.stat().st_mode) == 0o600
    assert json.loads(local.read_text())["openai"]["api_key"] == KEY
    body = response.json()
    assert {p["id"] for p in body["providers"] if p["connected"]} == {"openai", "ollama"}
    assert body["default"] == {"provider": "ollama", "model_id": "llama3.2:latest", "endpoint": providers.OLLAMA_ENDPOINT}
    assert response.headers["cache-control"] == "no-store"
    changed = client.put(PREFIX + "/default", json={"provider": "openai", "model_id": "gpt-4o-mini"})
    assert changed.status_code == 200
    assert changed.json()["default"]["endpoint"] == providers.OPENAI_ENDPOINT
    assert client.get(PREFIX).json()["default"]["provider"] == "openai"
    assert json.loads(local.read_text())["default"] == {"provider": "openai", "model_id": "gpt-4o-mini"}
    invalid = client.put(PREFIX + "/default", json={"provider": "ollama", "model_id": "not-installed"})
    assert invalid.status_code == 422
    assert json.loads(local.read_text())["default"]["provider"] == "openai"


@pytest.mark.parametrize("payload", [
    {"api_key": KEY}, {"api_key": KEY, "allow_paid_calls": False},
    {"api_key": KEY, "allow_paid_calls": 1}, {"api_key": KEY, "allow_paid_calls": "true"},
    {"api_key": 123, "allow_paid_calls": True}, {"api_key": {"nested": KEY}, "allow_paid_calls": True},
    {"api_key": KEY, "allow_paid_calls": True, "extra": {"api_key": KEY}},
    [KEY], KEY,
])
def test_sensitive_invalid_input_is_never_echoed(client, local, payload):
    response = client.post(PREFIX + "/openai", json=payload)
    assert response.status_code == 422
    assert KEY not in response.text
    assert "input" not in response.json()["detail"]
    assert not local.exists()
    providers._list_openai_models.assert_not_called()


def test_failed_reconnect_preserves_key_without_echoing_exception(client, local, caplog):
    connect(client)
    before = local.read_bytes()
    providers._list_openai_models.side_effect = RuntimeError("upstream error contains " + KEY)
    response = client.post(PREFIX + "/openai", json={"api_key": "replacement", "allow_paid_calls": True})
    assert response.status_code == 502
    assert KEY not in response.text and KEY not in caplog.text
    assert local.read_bytes() == before
    status = client.get(PREFIX)
    assert status.status_code == 200 and KEY not in status.text
    assert not status.json()["providers"][0]["connected"]


def test_disconnect_removes_secret_and_overrides_live_environment(client, local, monkeypatch):
    monkeypatch.setenv("PROOFGROVE_MODE", "live")
    monkeypatch.setattr(settings, "openai_api_key", SecretStr("environment-key"))
    connect(client)
    client.put(PREFIX + "/default", json={"provider": "openai", "model_id": "gpt-4o-mini"})
    providers._list_openai_models.reset_mock()
    response = client.delete(PREFIX + "/openai")
    assert response.status_code == 200
    assert KEY not in local.read_text()
    assert providers.openai_credential(settings) == ""
    providers._list_openai_models.assert_not_called()
    assert response.json()["default"]["provider"] == "ollama"
    assert not client.get(PREFIX).json()["providers"][0]["connected"]


def test_live_environment_key_is_supported_before_disconnect(client, local, monkeypatch):
    monkeypatch.setenv("PROOFGROVE_MODE", "live")
    monkeypatch.setattr(settings, "openai_api_key", SecretStr(KEY))
    assert client.get(PREFIX).json()["providers"][0]["connected"]
    assert not local.exists()
    providers._list_openai_models.assert_called_once_with(KEY)


@pytest.mark.parametrize("bad_state", [
    {"default": {"provider": [], "model_id": "x"}},
    {"default": {"provider": "openai", "model_id": {}}},
    {"openai": {"enabled": True, "api_key": [KEY], "allow_paid_calls": True}},
    {"openai": "bad"},
])
def test_malformed_private_state_is_sanitized(client, local, bad_state):
    local.parent.mkdir()
    local.write_text(json.dumps({"version": 1, **bad_state}))
    local.chmod(0o600)
    with pytest.raises(providers.ProviderConfigurationError, match="could not be read"):
        providers._read_state(settings)
    response = client.get(PREFIX)
    assert response.status_code == 200 and KEY not in response.text
    response = client.post(PREFIX + "/openai", json={"api_key": KEY, "allow_paid_calls": True})
    assert response.status_code == 503 and KEY not in response.text


def test_private_store_rejects_loose_permissions_and_symlink(client, local, tmp_path):
    connect(client)
    local.chmod(0o644)
    assert not client.get(PREFIX).json()["providers"][0]["connected"]
    with pytest.raises(providers.ProviderConfigurationError):
        providers.openai_credential(settings)
    local.unlink()
    other = tmp_path / "other.json"
    other.write_text('{"version":1}')
    other.chmod(0o600)
    local.symlink_to(other)
    with pytest.raises(providers.ProviderConfigurationError):
        providers.openai_credential(settings)
    assert other.read_text() == '{"version":1}'


def test_offline_never_reads_saved_key_or_contacts_any_provider(client, local, monkeypatch):
    connect(client)
    monkeypatch.setenv("PROOFGROVE_MODE", "offline")
    monkeypatch.setattr(providers, "_state_path", MagicMock(side_effect=AssertionError("offline must not read keys")))
    providers._list_openai_models.reset_mock()
    providers._list_ollama_models.reset_mock()
    response = client.get(PREFIX)
    assert response.status_code == 200
    assert response.json()["default"] is None
    assert all(not p["connected"] and not p["models"] for p in response.json()["providers"])
    assert providers.endpoint_credential(settings, providers.OPENAI_ENDPOINT) == ""
    assert client.post(PREFIX + "/openai", json={"api_key": KEY, "allow_paid_calls": True}).status_code == 422
    providers._list_openai_models.assert_not_called()
    providers._list_ollama_models.assert_not_called()


def test_settings_api_is_local_profile_only(client, local, monkeypatch):
    monkeypatch.setattr(settings, "pod_namespace", "tenant-other")
    assert client.get(PREFIX).status_code == 404
    assert client.post(PREFIX + "/openai", json={"api_key": KEY, "allow_paid_calls": True}).status_code == 404
    assert not local.exists()


@pytest.mark.asyncio
async def test_catalog_preserves_model_endpoint_collisions(local):
    await providers.connect_openai(settings, KEY)
    custom = TargetVersion(target_id="custom", project_id="catalog", tenant_id="tenant-local-classroom", name="custom", version="1", endpoint="https://custom.example/v1", model_version="gpt-4o-mini")
    store = AsyncMock()
    store.list_llm_targets.return_value = [custom]
    request = Request({"type": "http", "headers": [(b"x-evalai-tenant", b"local-classroom")]})
    catalog = await llms.list_llm_catalog(request, store)
    same = [item for item in catalog if item["model_id"] == "gpt-4o-mini"]
    assert {item["source"] for item in same} == {"openai", "ollama", "custom"}
    assert len({item["endpoint"] for item in same}) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("mode,endpoint,model,expected", [
    ("local", providers.OPENAI_ENDPOINT, "gpt-4o-mini", "target_credentials_missing"),
    ("local", providers.OLLAMA_ENDPOINT, "llama3.2:latest", None),
    ("local", providers.OLLAMA_ENDPOINT, "not-installed", "target_model_unavailable"),
    ("offline", providers.OPENAI_ENDPOINT, "gpt-4o-mini", "local_live_profile_required"),
    ("offline", providers.OLLAMA_ENDPOINT, "llama3.2:latest", "local_live_profile_required"),
    ("offline", "https://custom.example/v1", "custom", "local_live_profile_required"),
])
async def test_readiness_uses_provider_connection_and_model(local, monkeypatch, mode, endpoint, model, expected):
    monkeypatch.setenv("PROOFGROVE_MODE", mode)
    result = await assess_evidence_readiness(response_source="llm", evaluation_scope=EvaluationScope.FINAL_RESPONSE, agent=None, target_model=model, target_endpoint=endpoint,
        records=[{"inputs": {"question": "2+2?"}, "expectations": {"expected_output": "4"}}], active_metric_ids=["nlp.f1_score"], enable_llm_judge=False, scenario=Scenario.LLM_CORE, settings=settings)
    assert result.status == (EvidenceReadiness.BLOCKED if expected else EvidenceReadiness.READY)
    assert [item.code for item in result.details] == ([expected] if expected else [])


@pytest.mark.asyncio
async def test_disconnect_and_offline_cannot_be_bypassed_by_direct_runner(local, monkeypatch):
    invoke = MagicMock(side_effect=AssertionError("must block invocation"))
    monkeypatch.setattr(llm_runner, "_invoke_sync", invoke)
    await providers.connect_openai(settings, KEY)
    await providers.disconnect_openai(settings)
    with pytest.raises(llm_runner.LlmInvocationError, match="not connected"):
        await llm_runner.run_llm_target(settings=settings, target_endpoint=providers.OPENAI_ENDPOINT, target_model="gpt-4o-mini", query="test")
    monkeypatch.setenv("PROOFGROVE_MODE", "offline")
    with pytest.raises(llm_runner.LlmInvocationError, match="Offline rehearsal"):
        await llm_runner.run_llm_target(settings=settings, target_endpoint="https://custom.example/v1", target_model="custom", query="test")
    invoke.assert_not_called()


@pytest.mark.asyncio
async def test_keys_only_reach_fixed_openai_while_both_providers_run(local, monkeypatch):
    await providers.connect_openai(settings, KEY)
    factories = []
    def fake_client(**kwargs):
        factories.append(kwargs)
        client = MagicMock()
        client.chat.completions.create.return_value = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="4"))], usage=None)
        client.close.side_effect = kwargs["http_client"].close
        return client
    monkeypatch.setattr(llm_runner, "OpenAI", fake_client)
    monkeypatch.setattr(llm_runner, "resolve_agent_card_request", AsyncMock(return_value=("https://custom.example/v1", {}, {})))
    for endpoint, model in ((providers.OPENAI_ENDPOINT, "gpt-5-mini"), (providers.OLLAMA_ENDPOINT, "llama3.2:latest"), ("https://custom.example/v1", "custom")):
        result = await llm_runner.run_llm_target(settings=settings, target_endpoint=endpoint, target_model=model, query="2+2?")
        assert result.response == "4"
    assert [(item["base_url"], item["api_key"]) for item in factories] == [(providers.OPENAI_ENDPOINT, KEY), (providers.OLLAMA_ENDPOINT, "not-needed"), ("https://custom.example/v1", "not-needed")]
    assert llm_runner._build_chat_request(model_id="gpt-5-mini", query="q")["max_completion_tokens"] == 1024
    assert "temperature" not in llm_runner._build_chat_request(model_id="gpt-5-mini", query="q")


def test_nonlocal_credentials_follow_existing_exact_configured_route(local, monkeypatch):
    monkeypatch.setattr(settings, "pod_namespace", "tenant-production")
    monkeypatch.setattr(settings, "openai_base_url", "https://gateway.example/v1")
    monkeypatch.setattr(settings, "openai_api_key", SecretStr(KEY))
    assert providers.endpoint_credential(settings, "https://gateway.example/v1") == KEY
    assert providers.endpoint_credential(settings, providers.OPENAI_ENDPOINT) == ""
    assert providers.endpoint_credential(settings, providers.OLLAMA_ENDPOINT) == ""


@pytest.mark.parametrize("name,expected", [("gpt-4o-mini", True), ("gpt-4.1", True), ("gpt-5-mini", True), ("o3", True), ("o4-mini", True), ("chatgpt-4o-latest", True),
    ("gpt-4o-audio-preview", False), ("gpt-4o-search-preview", False), ("gpt-3.5-turbo-instruct", False), ("gpt-5-pro", False), ("o3-deep-research", False),
    ("text-embedding-3-small", False), ("ft:gpt-5-mini:org:custom:id", False), ("o5", False), ("o1-mini", False), ("unknown-model", False)])
def test_catalog_filters_supported_chat_families(name, expected):
    assert providers._openai_text_id(name) is expected


def test_real_listing_function_only_uses_models_list(monkeypatch):
    client = MagicMock()
    client.models.list.return_value = SimpleNamespace(data=[SimpleNamespace(id="gpt-4o-mini"), SimpleNamespace(id="text-embedding-3-small")])
    sdk = MagicMock()
    sdk.return_value.__enter__.return_value = client
    monkeypatch.setattr(providers, "OpenAI", sdk)
    assert providers._list_openai_models(KEY) == ["gpt-4o-mini"]
    assert sdk.call_args.kwargs["base_url"] == providers.OPENAI_ENDPOINT
    client.models.list.assert_called_once_with()
    client.chat.completions.create.assert_not_called()
    sdk.call_args.kwargs["http_client"].close()


@pytest.mark.asyncio
async def test_ollama_reads_only_installed_completion_gguf_metadata(monkeypatch):
    requests = []
    good = {"details": {"format": "gguf"}, "model_info": {"general.architecture": "llama"}}
    metadata = {"local:latest": good, "cloud:latest": {**good, "remote_host": "example.com"}, "embedding:latest": {**good, "capabilities": ["embedding"]},
                "old-embedding:latest": {**good, "model_info": {"general.architecture": "nomic-bert"}}}
    def handle(request):
        requests.append(request)
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": name} for name in metadata]})
        assert request.url.path == "/api/show"
        return httpx.Response(200, json=metadata[json.loads(request.content)["name"]])
    real_client = httpx.AsyncClient
    monkeypatch.setattr(providers.httpx, "AsyncClient", lambda **kwargs: real_client(**kwargs, transport=httpx.MockTransport(handle)))
    assert await providers._list_ollama_models() == ["local:latest"]
    assert len(requests) == 5
    assert all(request.url.host == "127.0.0.1" and "authorization" not in request.headers for request in requests)


@pytest.mark.parametrize("mode", ["local", "live"])
@pytest.mark.parametrize("name", ["OPENAI_API_KEY", "openai_api_key"])
def test_root_env_key_enables_only_discovered_catalog(client, local, monkeypatch, mode, name, caplog):
    monkeypatch.setenv("PROOFGROVE_MODE", mode)
    monkeypatch.setattr(settings, "openai_api_key", SecretStr("lower-priority-live-environment-key"))
    env_file = local.parent.parent / ".env"
    env_file.write_text(f'{name}="{KEY}"\n')
    response = client.get(PREFIX)
    assert response.status_code == 200
    provider = response.json()["providers"][0]
    assert provider["connected"]
    assert {model["model_id"] for model in provider["models"]} == {"gpt-4o-mini", "gpt-5-mini"}
    assert all(model["endpoint"] == providers.OPENAI_ENDPOINT for model in provider["models"])
    providers._list_openai_models.assert_called_once_with(KEY)
    assert not local.exists(), "Discovery must not copy .env keys into saved UI state"
    assert KEY not in response.text and KEY not in caplog.text
    assert providers.endpoint_credential(settings, providers.OLLAMA_ENDPOINT) == ""
    assert providers.endpoint_credential(settings, "https://custom.example/v1") == ""


def test_saved_key_and_disconnect_mask_root_env_without_reading_it(client, local, monkeypatch):
    env_file = local.parent.parent / ".env"
    env_file.write_text('OPENAI_API_KEY="root-env-private-key"\n')
    connect(client)
    monkeypatch.setattr(providers, "dotenv_values", MagicMock(side_effect=AssertionError("Saved state takes precedence")))
    assert providers.openai_credential(settings) == KEY
    response = client.delete(PREFIX + "/openai")
    assert response.status_code == 200
    assert not response.json()["providers"][0]["connected"]
    assert providers.openai_credential(settings) == ""
    assert "root-env-private-key" in env_file.read_text(), "Disconnect must not rewrite the user's .env"
    providers.dotenv_values.assert_not_called()
    connect(client)
    assert providers.openai_credential(settings) == KEY


def test_root_env_read_is_literal_and_uppercase_takes_precedence(local, monkeypatch):
    monkeypatch.setenv("SHOULD_NOT_EXPAND", "must-not-interpolate")
    env_file = local.parent.parent / ".env"
    env_file.write_text('OPENAI_API_KEY="${SHOULD_NOT_EXPAND}"\nopenai_api_key="lower-priority-key"\n')
    assert providers.openai_credential(settings) == "${SHOULD_NOT_EXPAND}"


def test_offline_never_resolves_or_parses_root_env(local, monkeypatch):
    (local.parent.parent / ".env").write_text(f"OPENAI_API_KEY={KEY}\n")
    monkeypatch.setenv("PROOFGROVE_MODE", "offline")
    monkeypatch.setattr(providers, "dotenv_values", MagicMock(side_effect=AssertionError("No offline .env parsing")))
    monkeypatch.setattr(providers, "_state_path", MagicMock(side_effect=AssertionError("No offline path resolution")))
    assert providers.openai_credential(settings) == ""
    assert providers._root_env_credential(settings) == ""
    providers.dotenv_values.assert_not_called()
    providers._state_path.assert_not_called()


def test_env_parser_failure_never_echoes_secret(client, local, monkeypatch, caplog):
    monkeypatch.setattr(providers, "dotenv_values", MagicMock(side_effect=OSError("contains " + KEY)))
    response = client.get(PREFIX)
    assert response.status_code == 200
    assert not response.json()["providers"][0]["connected"]
    assert KEY not in response.text and KEY not in caplog.text
    providers._list_openai_models.assert_not_called()


EXPECTED_OPENAI_PICKER = [
    "gpt-3.5-turbo", "gpt-4o-mini", "gpt-4o", "gpt-4.1-nano",
    "gpt-4.1-mini", "gpt-4.1", "gpt-5-nano", "gpt-5-mini",
    "gpt-5", "gpt-5.4-mini", "gpt-5.4", "gpt-5.5",
]


def test_openai_picker_is_ordered_account_intersection_without_snapshots():
    discovered = [*reversed(EXPECTED_OPENAI_PICKER), "gpt-4o-mini", "gpt-4o-2024-08-06", "o3", "gpt-5.5-2026-09-01"]
    assert providers._offered_openai_models(discovered) == EXPECTED_OPENAI_PICKER
    assert len(providers._offered_openai_models(discovered)) == 12
    assert providers._offered_openai_models(["gpt-5-mini", "gpt-4o-mini", "gpt-4o-2024-08-06"]) == ["gpt-4o-mini", "gpt-5-mini"]
    assert providers._offered_openai_models(["o3", "unknown-model"]) == []


@pytest.mark.asyncio
async def test_provider_and_catalog_keep_shortlist_order_without_changing_custom_targets(local):
    providers._list_openai_models.return_value = [*reversed(EXPECTED_OPENAI_PICKER), "gpt-4o-2024-08-06", "o3"]
    snapshot = await providers.connect_openai(settings, KEY)
    assert [item["model_id"] for item in snapshot["providers"][0]["models"]] == EXPECTED_OPENAI_PICKER
    store = AsyncMock()
    store.list_llm_targets.return_value = [TargetVersion(
        target_id="custom-hidden", project_id="catalog", tenant_id="tenant-local-classroom", name="custom historical model",
        version="1", endpoint="https://custom.example/v1", model_version="gpt-4o-2024-08-06",
    )]
    request = Request({"type": "http", "headers": [(b"x-evalai-tenant", b"local-classroom")]})
    catalog = await llms.list_llm_catalog(request, store)
    assert [item["model_id"] for item in catalog if item["source"] == "openai"] == EXPECTED_OPENAI_PICKER
    custom = next(item for item in catalog if item["source"] == "custom")
    assert custom["model_id"] == "gpt-4o-2024-08-06"
    assert custom["endpoint"] == "https://custom.example/v1"


@pytest.mark.asyncio
async def test_hidden_saved_default_is_not_injected_but_historical_readiness_still_works(local):
    hidden = "gpt-4o-2024-08-06"
    providers._list_openai_models.return_value = ["gpt-4o-mini", hidden]
    await providers.connect_openai(settings, KEY)
    state = providers._read_state(settings)
    state["default"] = {"provider": "openai", "model_id": hidden}
    providers._write_state(settings, state)
    snapshot = await providers.provider_snapshot(settings)
    assert snapshot["default"] is None
    assert [model["model_id"] for model in snapshot["providers"][0]["models"]] == ["gpt-4o-mini"]
    assert providers._read_state(settings)["default"]["model_id"] == hidden
    with pytest.raises(providers.ProviderConfigurationError, match="currently available"):
        await providers.choose_default(settings, "openai", hidden)
    result = await assess_evidence_readiness(
        response_source="llm", evaluation_scope=EvaluationScope.FINAL_RESPONSE, agent=None, target_model=hidden, target_endpoint=providers.OPENAI_ENDPOINT,
        records=[{"inputs": {"question": "2+2?"}, "expectations": {"expected_output": "4"}}], active_metric_ids=["nlp.f1_score"],
        enable_llm_judge=False, scenario=Scenario.LLM_CORE, settings=settings,
    )
    assert result.status == EvidenceReadiness.READY
    providers._list_openai_models.return_value = ["gpt-4o-mini"]
    problem = await providers.target_provider_problem(settings, providers.OPENAI_ENDPOINT, hidden)
    assert problem[0] == "target_model_unavailable"


def test_full_discovery_retains_supported_hidden_models_for_reruns(monkeypatch):
    client = MagicMock()
    client.models.list.return_value = SimpleNamespace(data=[SimpleNamespace(id="gpt-4o-2024-08-06"), SimpleNamespace(id="o3"), SimpleNamespace(id="text-embedding-3-small")])
    sdk = MagicMock()
    sdk.return_value.__enter__.return_value = client
    monkeypatch.setattr(providers, "OpenAI", sdk)
    assert providers._list_openai_models(KEY) == ["gpt-4o-2024-08-06", "o3"]
    client.chat.completions.create.assert_not_called()
    sdk.call_args.kwargs["http_client"].close()
