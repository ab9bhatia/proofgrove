"""Tenant-scoped, immutable A2A catalog targets hosted outside kagent."""

from urllib.parse import urlparse

from evalhub.evaluation.target.catalog import AgentCatalogError, normalize_agent_endpoint
from evalhub.evaluation.target.discovery import AgentSummary
from evalhub.platform.contracts import TargetType, TargetVersion
from evalhub.settings import Settings

EXTERNAL_PREFIX = "external:"


def credential_headers(settings: Settings, reference: str | None, endpoint: str) -> dict[str, str]:
    """Resolve an operator-managed connection; never persist credential values."""
    if not reference:
        return {}
    connection = settings.external_agent_credentials.get(reference)
    if not connection or urlparse(endpoint).scheme != "https":
        raise AgentCatalogError("External agent credentials require a configured connection and HTTPS")
    if connection.get("origin") is None or connection["origin"].get_secret_value() != _origin(endpoint):
        raise AgentCatalogError("External agent credential connection does not match the endpoint origin")
    headers = {key: value.get_secret_value() for key, value in connection.items() if key != "origin"}
    if not headers or any(key.lower() not in {"authorization", "x-api-key"} for key in headers):
        raise AgentCatalogError("External agent credentials support only Authorization or x-api-key")
    if any(not value or "\r" in value or "\n" in value for value in headers.values()):
        raise AgentCatalogError("External agent credential header is invalid")
    return headers


def _origin(endpoint: str) -> str:
    parsed = urlparse(endpoint)
    return f"{parsed.scheme}://{parsed.netloc}"


def invocation_endpoint(target: TargetVersion, namespace: str) -> str:
    """Use the card's advertised RPC URL, constrained to its registered origin."""
    card = target.configuration.get("agent_card") or {}
    if not isinstance(card, dict):
        raise AgentCatalogError("External agent card must be an object")
    protocol = card.get("protocolVersion", "0.3.0")
    if not isinstance(protocol, str) or protocol not in {"0.2.0", "0.2.1", "0.2.6", "0.3.0"} or card.get("preferredTransport", "JSONRPC") != "JSONRPC":
        raise AgentCatalogError("External agents require A2A 0.2/0.3 JSON-RPC message/stream")
    raw_endpoint = card.get("url") or target.endpoint
    if not isinstance(raw_endpoint, str):
        raise AgentCatalogError("A2A invocation URL must be a string")
    endpoint = normalize_agent_endpoint(raw_endpoint, namespace)
    if _origin(endpoint) != _origin(target.endpoint):
        raise AgentCatalogError("A2A invocation URL must use the registered endpoint origin")
    capabilities = card.get("capabilities") or {}
    if not isinstance(capabilities, dict) or capabilities.get("streaming") is not True:
        raise AgentCatalogError("External A2A agents must support message/stream")
    return endpoint


def external_summary(target: TargetVersion) -> AgentSummary:
    return AgentSummary(
        id=f"{EXTERNAL_PREFIX}{target.target_version_id}",
        name=target.name, display_name=target.name, namespace=target.tenant_id,
        description=str((target.configuration.get("agent_card") or {}).get("description") or ""),
        ready=True, accepted=True, agent_type="BYO", revision=target.target_version_id,
    )


async def resolve_external_target(reference: str, settings: Settings) -> TargetVersion:
    # Resolve only catalog IDs, never arbitrary URLs supplied in a run request.
    # The service is tenant-local; this namespace is operator configured.
    from evalhub.db.session import async_session
    from evalhub.db.store import EvaluationStore

    if not settings.pod_namespace or not reference.startswith(EXTERNAL_PREFIX):
        raise AgentCatalogError("External target requires a tenant-scoped catalog reference")
    async with async_session() as session:
        target = await EvaluationStore(session).get_target_version(
            reference.removeprefix(EXTERNAL_PREFIX), settings.pod_namespace,
        )
    if target is None or target.target_type != TargetType.AGENT or target.configuration.get("catalog_source") != "a2a_agent_card":
        raise AgentCatalogError("External agent is not registered in this tenant")
    endpoint = invocation_endpoint(target, settings.pod_namespace)
    credential_headers(settings, target.configuration.get("credential_ref"), endpoint)
    return target
