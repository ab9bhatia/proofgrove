"""Two fixed providers for the local classroom; credentials never enter catalogs."""

from __future__ import annotations

import asyncio
import json
import os
import re
import stat
import tempfile
import threading
from pathlib import Path
from typing import Any

import httpx
from dotenv import dotenv_values
from fastapi.concurrency import run_in_threadpool
from openai import OpenAI

from proofgrove.evaluation.local_lab import local_lab_mode
from proofgrove.settings import Settings

OPENAI_ENDPOINT = "https://api.openai.com/v1"
OLLAMA_ENDPOINT = "http://127.0.0.1:11434/v1"
ENDPOINTS = {"openai": OPENAI_ENDPOINT, "ollama": OLLAMA_ENDPOINT}
# Presentation only. Existing run targets are checked against the full supported
# account catalog, so pruning the picker cannot invalidate historical reruns.
OPENAI_PICKER_MODELS = (
    "gpt-3.5-turbo", "gpt-4o-mini", "gpt-4o", "gpt-4.1-nano",
    "gpt-4.1-mini", "gpt-4.1", "gpt-5-nano", "gpt-5-mini",
    "gpt-5", "gpt-5.4-mini", "gpt-5.4", "gpt-5.5",
)
_state_lock = threading.RLock()


class ProviderConfigurationError(RuntimeError):
    """A safe, deliberately credential-free configuration failure."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def _state_path() -> Path:
    root = Path(os.environ.get("PROOFGROVE_ROOT") or Path(__file__).resolve().parents[4])
    return root / ".local" / "model-providers.json"


def _read_state(settings: Settings) -> dict[str, Any]:
    # Offline seed subprocesses inherit the root but must never read its key.
    if local_lab_mode(settings) not in {"local", "live"}:
        return {}
    path = _state_path()
    try:
        if path.parent.is_symlink():
            raise OSError("unsafe state directory")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise OSError("private state permissions required")
            data = json.load(stream)
        if not isinstance(data, dict) or data.get("version") != 1:
            raise ValueError("unsupported state")
        provider = data.get("openai")
        if provider is not None:
            if not isinstance(provider, dict) or not isinstance(provider.get("enabled"), bool):
                raise ValueError("invalid provider state")
            if provider.get("enabled") and (not isinstance(provider.get("api_key"), str) or not provider["api_key"].strip() or provider.get("allow_paid_calls") is not True):
                raise ValueError("invalid credential state")
        default = data.get("default")
        if default is not None and (not isinstance(default, dict) or not isinstance(default.get("provider"), str)
                                    or default["provider"] not in ENDPOINTS or not isinstance(default.get("model_id"), str)
                                    or not default["model_id"].strip()):
            raise ValueError("invalid default state")
        return data
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, TypeError):
        raise ProviderConfigurationError("provider_store_unavailable", "The private provider settings could not be read. Restore a valid owner-only settings file before connecting.") from None


def _write_state(settings: Settings, state: dict[str, Any]) -> None:
    if local_lab_mode(settings) not in {"local", "live"}:
        raise ProviderConfigurationError("provider_profile_required", "Start the local or live lab profile before connecting providers.")
    path = _state_path()
    temporary: str | None = None
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.parent.is_symlink() or path.is_symlink():
            raise OSError("unsafe state path")
        fd, temporary = tempfile.mkstemp(prefix=".model-providers-", dir=path.parent)
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump({**state, "version": 1}, stream)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except (OSError, ValueError, TypeError):
        raise ProviderConfigurationError("provider_store_unavailable", "The private provider settings could not be saved.") from None
    finally:
        if temporary:
            try:
                Path(temporary).unlink(missing_ok=True)
            except OSError:
                pass


def _root_env_credential(settings: Settings) -> str:
    # This is a literal server-side configuration file, never shell input.
    # Keep the guard before path resolution: offline seed processes must not
    # inspect the root .env even if a connected lab uses the same directory.
    if local_lab_mode(settings) not in {"local", "live"}:
        return ""
    try:
        values = dotenv_values(_state_path().parent.parent / ".env", interpolate=False)
        for name in ("OPENAI_API_KEY", "openai_api_key"):
            key = values.get(name)
            if isinstance(key, str) and key.strip():
                return key.strip()
        return ""
    except (OSError, ValueError):
        raise ProviderConfigurationError("provider_store_unavailable", "The root environment settings could not be read. Check the server-side .env file.") from None


def openai_credential(settings: Settings) -> str:
    if local_lab_mode(settings) not in {"local", "live"}:
        return ""
    with _state_lock:
        state = _read_state(settings)
    provider = state.get("openai")
    if isinstance(provider, dict):
        if provider.get("enabled") is not True or provider.get("allow_paid_calls") is not True:
            return ""
        key = provider.get("api_key")
        return key.strip() if isinstance(key, str) else ""
    # Saved UI credentials override .env. A saved disabled entry above masks
    # both .env and the live environment until the user reconnects in Models.
    key = _root_env_credential(settings)
    if key:
        return key
    # Preserve the explicitly acknowledged live-launcher environment profile.
    return settings.openai_api_key.get_secret_value().strip() if local_lab_mode(settings) == "live" else ""


def endpoint_credential(settings: Settings, endpoint: str) -> str:
    if local_lab_mode(settings) is not None:
        return openai_credential(settings) if endpoint == OPENAI_ENDPOINT else ""
    return settings.openai_api_key.get_secret_value() if endpoint == settings.openai_base_url.rstrip("/") else ""


def _openai_text_id(model_id: str) -> bool:
    # Models.list describes availability, not every endpoint capability. Offer
    # text chat families; still disclose that generation is not verified here.
    lower = model_id.lower()
    return bool(re.match(r"^(gpt-(?:3\.5|4|5)(?:[.-]|o|$)|chatgpt-4o(?:-|$)|o[134](?:-|$))", lower)) and not any(
        marker in lower for marker in ("embedding", "audio", "realtime", "transcribe", "tts", "image", "moderation", "live", "deep-research", "codex", "-pro", "-search", "-instruct", "o1-mini", "o1-preview")
    )


def _offered_openai_models(available: list[str]) -> list[str]:
    """The curated picker order intersected with real account discovery."""
    available_ids = set(available)
    return [model_id for model_id in OPENAI_PICKER_MODELS if model_id in available_ids]


def _list_openai_models(key: str) -> list[str]:
    """Full supported account discovery, including models hidden in the picker."""
    # Fixed destination, no redirects, inherited proxies, generation or retries.
    with OpenAI(
        api_key=key, base_url=OPENAI_ENDPOINT, timeout=10, max_retries=0,
        http_client=httpx.Client(follow_redirects=False, trust_env=False),
    ) as client:
        listing = client.models.list()
        return sorted({model.id for model in listing.data if isinstance(model.id, str) and _openai_text_id(model.id)})


def _has_remote_fields(value: Any) -> bool:
    if isinstance(value, dict):
        return any(key in {"remote_model", "remote_host"} or _has_remote_fields(item) for key, item in value.items())
    return isinstance(value, list) and any(_has_remote_fields(item) for item in value)


def _is_local_gguf(metadata: Any) -> bool:
    if not isinstance(metadata, dict) or _has_remote_fields(metadata):
        return False
    capabilities = metadata.get("capabilities")
    if isinstance(capabilities, list) and "completion" not in capabilities:
        return False
    details, model_info = metadata.get("details"), metadata.get("model_info")
    if isinstance(model_info, dict) and model_info.get("general.architecture") in {"bert", "nomic-bert", "jina-bert-v2"}:
        return False
    return bool(isinstance(details, dict) and details.get("format") == "gguf"
                and isinstance(model_info, dict) and model_info.get("general.architecture"))


async def _list_ollama_models() -> list[str]:
    async with httpx.AsyncClient(timeout=5, follow_redirects=False, trust_env=False) as client:
        response = await client.get("http://127.0.0.1:11434/api/tags")
        response.raise_for_status()
        names = sorted({entry["name"] for entry in response.json().get("models", [])
                        if isinstance(entry, dict) and isinstance(entry.get("name"), str)})
        models = []
        for name in names:
            response = await client.post("http://127.0.0.1:11434/api/show", json={"name": name})
            response.raise_for_status()
            if _is_local_gguf(response.json()):
                models.append(name)
        return models


def _models(provider: str, names: list[str]) -> list[dict[str, str]]:
    return [{"model_id": name, "name": name, "source": provider, "endpoint": ENDPOINTS[provider]} for name in names]


async def _openai_status(settings: Settings, verified: list[str] | None = None) -> dict[str, Any]:
    item: dict[str, Any] = {"id": "openai", "name": "OpenAI", "connected": False, "models": []}
    try:
        key = openai_credential(settings)
        if not key:
            return {**item, "message": "Not connected. Add your OpenAI API key to enable this provider."}
        names = verified if verified is not None else await run_in_threadpool(_list_openai_models, key)
        return {**item, "connected": True, "models": _models("openai", names), "message": "Account model catalog verified. Generation and model compatibility are checked when you run an evaluation."}
    except ProviderConfigurationError:
        return {**item, "message": "Private provider settings are unavailable. Restore their owner-only permissions before reconnecting."}
    except Exception:  # noqa: BLE001 — provider exceptions may contain credentials
        return {**item, "message": "OpenAI model catalog could not be verified. Check your connection and API key."}


async def _ollama_status() -> dict[str, Any]:
    item: dict[str, Any] = {"id": "ollama", "name": "Ollama on this Mac", "connected": False, "models": []}
    try:
        names = await _list_ollama_models()
        return {**item, "connected": True, "models": _models("ollama", names), "message": "Installed local GGUF models verified; cloud-backed model aliases are excluded."}
    except Exception:  # noqa: BLE001 — expose no service-provided payload
        return {**item, "message": "Ollama is not reachable on this Mac. Start Ollama with an installed local model, then refresh."}


async def provider_snapshot(settings: Settings, *, verified_openai: list[str] | None = None) -> dict[str, Any]:
    if local_lab_mode(settings) not in {"local", "live"}:
        return {"providers": [{"id": provider, "name": name, "connected": False, "models": [],
                               "message": "Offline rehearsal does not connect to model providers."}
                              for provider, name in (("openai", "OpenAI"), ("ollama", "Ollama on this Mac"))], "default": None}
    providers = list(await asyncio.gather(_openai_status(settings, verified_openai), _ollama_status()))
    for provider in providers:
        if provider["id"] == "openai" and provider["connected"]:
            offered = _offered_openai_models([model["model_id"] for model in provider["models"]])
            provider["models"] = _models("openai", offered)
            provider["message"] = "Showing the curated, account-available model list. Generation and model compatibility are checked when you run an evaluation."
    available = {(p["id"], m["model_id"]): {"provider": p["id"], "model_id": m["model_id"], "endpoint": m["endpoint"]}
                 for p in providers for m in p["models"]}
    try:
        with _state_lock:
            default = _read_state(settings).get("default")
    except ProviderConfigurationError:
        default = None
    if isinstance(default, dict) and isinstance(default.get("provider"), str) and isinstance(default.get("model_id"), str):
        choice = available.get((default["provider"], default["model_id"]))
    else:
        provider = "ollama" if local_lab_mode(settings) == "local" else "openai"
        name = os.environ.get("PROOFGROVE_MODEL", "").strip()
        choice = available.get((provider, name)) or available.get((provider, name + ":latest"))
        choice = choice or available.get(("ollama", "llama3.2:latest"))
        choice = choice or next((value for (p, _), value in available.items() if p == "ollama"), None)
        choice = choice or next(iter(available.values()), None)
    return {"providers": providers, "default": choice}


async def connect_openai(settings: Settings, key: str) -> dict[str, Any]:
    if local_lab_mode(settings) not in {"local", "live"}:
        raise ProviderConfigurationError("provider_profile_required", "Start the local or live lab profile before connecting OpenAI.")
    try:
        names = await run_in_threadpool(_list_openai_models, key)
    except Exception:  # noqa: BLE001 — never echo SDK exception or key fragments
        raise ProviderConfigurationError("provider_connection_failed", "OpenAI could not verify this API key and model access. Check the key and connection; no generation was requested.") from None
    with _state_lock:
        state = _read_state(settings)
        state["openai"] = {"api_key": key, "enabled": True, "allow_paid_calls": True}
        _write_state(settings, state)
    return await provider_snapshot(settings, verified_openai=names)


async def disconnect_openai(settings: Settings) -> dict[str, Any]:
    with _state_lock:
        state = _read_state(settings)
        # Also overrides an environment key, so Disconnect survives a restart.
        state["openai"] = {"enabled": False}
        if isinstance(state.get("default"), dict) and state["default"].get("provider") == "openai":
            state.pop("default")
        _write_state(settings, state)
    return await provider_snapshot(settings)


async def choose_default(settings: Settings, provider: str, model_id: str) -> dict[str, Any]:
    snapshot = await provider_snapshot(settings)
    selected = next((m for p in snapshot["providers"] if p["id"] == provider and p["connected"]
                     for m in p["models"] if m["model_id"] == model_id), None)
    if selected is None:
        raise ProviderConfigurationError("provider_model_unavailable", "Choose a currently available model from the selected provider.")
    with _state_lock:
        state = _read_state(settings)
        state["default"] = {"provider": provider, "model_id": model_id}
        _write_state(settings, state)
    snapshot["default"] = {"provider": provider, "model_id": model_id, "endpoint": selected["endpoint"]}
    return snapshot


async def target_provider_problem(settings: Settings, endpoint: str, model_id: str) -> tuple[str, str] | None:
    """Validate only fixed local providers, both at enqueue and before invoking."""
    mode = local_lab_mode(settings)
    if mode == "offline":
        return "local_live_profile_required", "Offline rehearsal does not invoke models. Start the local or live lab profile, or evaluate existing responses."
    provider = next((name for name, base in ENDPOINTS.items() if endpoint == base), None)
    if mode is None or provider is None:
        return None
    if provider == "openai":
        try:
            if not openai_credential(settings):
                return "target_credentials_missing", "OpenAI is not connected. Add an API key in Models before running this target."
        except ProviderConfigurationError:
            return "target_credentials_missing", "Private OpenAI provider settings could not be read. Reconnect the provider in Models."
        status = await _openai_status(settings)
    else:
        status = await _ollama_status()
    if not status["connected"]:
        return "target_provider_unavailable", status["message"]
    if model_id not in {item["model_id"] for item in status["models"]}:
        return "target_model_unavailable", "The selected model is not available from that provider. Refresh Models and choose an available model."
    return None
