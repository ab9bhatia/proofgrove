"""Private, fixed-provider settings for the local classroom profile only."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response

from evalhub.evaluation.local_lab import local_lab_mode
from evalhub.evaluation.model_providers import (
    ProviderConfigurationError,
    choose_default,
    connect_openai,
    disconnect_openai,
    provider_snapshot,
)
from evalhub.platform.authz import enforce_tenant, tenants_match
from evalhub.settings import settings

router = APIRouter(prefix="/evaluation/model-providers", tags=["model-providers"])


def _local_request(request: Request, response: Response) -> None:
    if local_lab_mode(settings) is None:
        raise HTTPException(status_code=404, detail="Not found")
    supplied = request.headers.get("x-evalai-tenant")
    if supplied and not tenants_match(supplied, settings.pod_namespace):
        raise HTTPException(status_code=403, detail="tenant header does not match Eval Hub namespace")
    enforce_tenant(request, settings.pod_namespace)
    response.headers["Cache-Control"] = "no-store"


def _safe_failure(error: ProviderConfigurationError) -> HTTPException:
    status = 502 if error.code == "provider_connection_failed" else 503 if error.code == "provider_store_unavailable" else 422
    return HTTPException(status_code=status, detail={"code": error.code, "message": str(error)})


async def _body(request: Request) -> dict:
    # FastAPI/Pydantic validation errors include rejected input. Parsing this
    # sensitive payload explicitly avoids echoing keys, even in malformed bodies.
    try:
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError
        return data
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail={"code": "invalid_provider_request", "message": "Provide a valid provider settings object."}) from None


@router.get("")
async def list_providers(request: Request, response: Response) -> dict:
    _local_request(request, response)
    return await provider_snapshot(settings)


@router.post("/openai")
async def set_openai(request: Request, response: Response) -> dict:
    _local_request(request, response)
    data = await _body(request)
    key = data.get("api_key")
    if (set(data) != {"api_key", "allow_paid_calls"} or not isinstance(key, str)
            or not key.strip() or len(key) > 4096 or data.get("allow_paid_calls") is not True):
        raise HTTPException(status_code=422, detail={"code": "invalid_provider_request", "message": "Provide an API key and explicitly acknowledge paid calls with allow_paid_calls: true."})
    try:
        return await connect_openai(settings, key.strip())
    except ProviderConfigurationError as exc:
        raise _safe_failure(exc) from None


@router.delete("/openai")
async def remove_openai(request: Request, response: Response) -> dict:
    _local_request(request, response)
    try:
        return await disconnect_openai(settings)
    except ProviderConfigurationError as exc:
        raise _safe_failure(exc) from None


@router.put("/default")
async def set_default(request: Request, response: Response) -> dict:
    _local_request(request, response)
    data = await _body(request)
    provider, model_id = data.get("provider"), data.get("model_id")
    if (set(data) != {"provider", "model_id"} or not isinstance(provider, str) or provider not in {"openai", "ollama"}
            or not isinstance(model_id, str) or not model_id.strip() or len(model_id) > 256):
        raise HTTPException(status_code=422, detail={"code": "invalid_provider_request", "message": "Choose an available provider and model."})
    try:
        return await choose_default(settings, provider, model_id.strip())
    except ProviderConfigurationError as exc:
        raise _safe_failure(exc) from None
