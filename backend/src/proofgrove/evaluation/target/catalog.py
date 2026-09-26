"""Connectivity validation for externally registered A2A evaluation targets."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import re
import socket
from typing import Any
from urllib.parse import urlparse, urlunparse

import httpx

from proofgrove.errors import TenantVisibleError

logger = logging.getLogger(__name__)

_MAX_AGENT_CARD_BYTES = 256 * 1024
_CARD_PATH = "/.well-known/agent.json"
_HOSTNAME_LABEL = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
_DEFAULT_PORTS = {"http": 80, "https": 443}
_CLUSTER_SUFFIX = ".svc.cluster.local"
# NAT64 translates an embedded IPv4 address, so 64:ff9b::7f00:1 reaches 127.0.0.1 on a
# host with a NAT64 gateway. Neither prefix is ever a legitimate agent target.
_NAT64_PREFIXES = (
    ipaddress.ip_network("64:ff9b::/96"),
    ipaddress.ip_network("64:ff9b:1::/48"),
)

_AZURE_WIRESERVER = ipaddress.ip_address("168.63.129.16")
_CARRIER_GRADE_NAT = ipaddress.ip_network("100.64.0.0/10")

Address = ipaddress.IPv4Address | ipaddress.IPv6Address


class AgentCatalogError(ValueError, TenantVisibleError):
    """The supplied endpoint could not be validated as an A2A agent."""


def _is_dns_hostname(hostname: str) -> bool:
    """Return True when the host is a plain DNS name rather than an IP literal.

    Resolvers accept obfuscated IPv4 literals such as ``2130706433`` and
    ``0x7f000001`` that :func:`ipaddress.ip_address` rejects, so those would
    otherwise slip past the loopback and private-range checks. A real DNS name
    never ends in an all-numeric or hex-prefixed label, which is what this
    rejects.
    """

    if not hostname or len(hostname) > 253:
        return False
    labels = hostname.split(".")
    if not all(_HOSTNAME_LABEL.match(label) for label in labels):
        return False
    last = labels[-1]
    return not last.isdigit() and not last.startswith("0x")


def is_blocked_address(address: Address, *, allow_private: bool = False) -> bool:
    """Return True when this resolved address must never be contacted.

    ``allow_private`` is set only for in-cluster Kubernetes service names, whose
    addresses are private by design; loopback, link-local (cloud metadata),
    multicast, reserved and NAT64 addresses stay blocked for those too.
    """

    if address.version == 6 and any(address in prefix for prefix in _NAT64_PREFIXES):
        return True
    # An IPv4-mapped IPv6 address is only as safe as the IPv4 address inside it.
    mapped = getattr(address, "ipv4_mapped", None)
    candidates: tuple[Address, ...] = (address, mapped) if mapped else (address,)
    for candidate in candidates:
        if candidate == _AZURE_WIRESERVER or candidate in _CARRIER_GRADE_NAT:
            return True
        if (
            candidate.is_loopback
            or candidate.is_link_local
            or candidate.is_multicast
            or candidate.is_unspecified
            or candidate.is_reserved
        ):
            return True
        if not allow_private and candidate.is_private:
            return True
    return False


async def resolve_endpoint_addresses(hostname: str, port: int) -> list[Address]:
    """Resolve every address a connection to ``hostname`` could land on.

    Kept as a module-level seam so tests can supply a resolver instead of DNS.
    """

    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise AgentCatalogError("Agent System Endpoint host could not be resolved") from exc
    resolved: list[Address] = []
    for info in infos:
        # Drop any IPv6 zone id ("fe80::1%eth0"), which ip_address does not accept.
        literal = str(info[4][0]).split("%", 1)[0]
        try:
            resolved.append(ipaddress.ip_address(literal))
        except ValueError:  # pragma: no cover - getaddrinfo returns literals
            continue
    if not resolved:
        raise AgentCatalogError("Agent System Endpoint host could not be resolved")
    return resolved


async def assert_endpoint_resolves_safely(hostname: str, port: int, *, allow_private: bool = False) -> None:
    """Resolve ``hostname`` and raise if any address it resolves to is blocked.

    A literal-form check (``normalize_agent_endpoint`` / ``is_blocked_address`` on an
    IP literal) cannot see what a DNS name actually resolves to, and DNS can answer
    differently between onboarding time and connect time. This is the shared
    resolve+block primitive every caller that connects to a user-supplied endpoint
    (or sends it a secret) should run immediately before doing so.
    """

    addresses = await resolve_endpoint_addresses(hostname, port)
    if any(is_blocked_address(address, allow_private=allow_private) for address in addresses):
        raise AgentCatalogError(f"{hostname} resolves to a private or local address")


def pinned_request_url(url: str, address: Address) -> tuple[str, str]:
    """Return the URL to connect to with ``address`` pinned, plus the Host header.

    Connecting to the validated address instead of re-resolving the name closes the
    window in which DNS could answer differently between the check and the fetch.
    """

    parsed = urlparse(url)
    literal = f"[{address}]" if address.version == 6 else str(address)
    netloc = f"{literal}:{parsed.port}" if parsed.port else literal
    return urlunparse(parsed._replace(netloc=netloc)), parsed.netloc


def normalize_agent_endpoint(endpoint: str, tenant_namespace: str) -> str:
    """Validate and normalize an agent-system base URL by its literal form.

    Public HTTP(S) endpoints and services in this Proofgrove's own tenant namespace
    are supported. Loopback, link-local, NAT64 and private IP literals, and
    cross-namespace Kubernetes service names, are rejected here. A DNS name that
    *resolves* to such an address cannot be judged from its literal form — that
    check lives in :func:`test_agent_connectivity`, which resolves the host and
    validates every returned address before connecting to it.
    """

    value = endpoint.strip().rstrip("/")
    try:
        # urlparse raises a bare ValueError on unbalanced IPv6 brackets and on netlocs that
        # change under NFKC normalization; without this it escapes as an unhandled 500.
        parsed = urlparse(value)
        hostname = (parsed.hostname or "").lower().rstrip(".")
        parsed.port  # Reading the port validates it; an invalid one raises here too.
    except ValueError as exc:
        raise AgentCatalogError("Agent System Endpoint is not a valid URL") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise AgentCatalogError("Agent System Endpoint must be an absolute http(s) URL")
    if parsed.username or parsed.password:
        raise AgentCatalogError("Agent System Endpoint must not contain embedded credentials")
    if parsed.query or parsed.fragment:
        raise AgentCatalogError("Agent System Endpoint must not contain a query string or fragment")

    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise AgentCatalogError("localhost endpoints cannot be onboarded")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and is_blocked_address(address):
        raise AgentCatalogError("private and local IP endpoints cannot be onboarded directly")
    if address is None and not _is_dns_hostname(hostname):
        raise AgentCatalogError("Agent System Endpoint host must be a DNS name or a public IP address")

    if hostname.endswith(".svc.cluster.local"):
        tenant_suffix = f".{tenant_namespace}.svc.cluster.local"
        if not tenant_namespace or not hostname.endswith(tenant_suffix):
            raise AgentCatalogError("Kubernetes agent endpoints must belong to this tenant namespace")
    return value


def agent_card_url(endpoint: str) -> str:
    """Return the A2A agent-card URL for a normalized system endpoint."""

    parsed = urlparse(endpoint)
    if parsed.path.rstrip("/").endswith((_CARD_PATH, "/.well-known/agent-card.json")):
        return endpoint
    path = f"{parsed.path.rstrip('/')}{_CARD_PATH}"
    return urlunparse(parsed._replace(path=path))


def _catalog_card(card: Any) -> dict[str, Any]:
    if not isinstance(card, dict):
        raise AgentCatalogError("A2A agent card must be a JSON object")
    name = card.get("name")
    if not isinstance(name, str) or not name.strip():
        raise AgentCatalogError("A2A agent card is missing a non-empty name")

    selected: dict[str, Any] = {"name": name.strip()}
    for key in (
        "description",
        "url",
        "version",
        "protocolVersion",
        "preferredTransport",
        "capabilities",
        "defaultInputModes",
        "defaultOutputModes",
        "skills",
    ):
        if key in card:
            selected[key] = card[key]
    try:
        json.dumps(selected, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise AgentCatalogError("A2A agent card contains invalid JSON values") from exc
    return selected


async def resolve_agent_card_request(card_url: str) -> tuple[str, dict[str, str], dict[str, Any]]:
    """Resolve the card host, reject unsafe addresses, and pin the one we will contact.

    Returns the URL to request, the headers that preserve the original host, and the
    httpx extensions (TLS is still negotiated for the DNS name, not the pinned IP).
    """

    parsed = urlparse(card_url)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    headers = {"Accept": "application/json"}
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        # Already an IP literal: normalize_agent_endpoint validated it directly.
        return card_url, headers, {}

    port = parsed.port or _DEFAULT_PORTS[parsed.scheme]
    allow_private = hostname.endswith(_CLUSTER_SUFFIX)
    addresses = await resolve_endpoint_addresses(hostname, port)
    for address in addresses:
        if is_blocked_address(address, allow_private=allow_private):
            logger.warning(
                "proofgrove: agent endpoint host %s resolves to blocked address %s", hostname, address
            )
            raise AgentCatalogError(
                "Agent System Endpoint host resolves to a private or local address"
            )
    request_url, host_header = pinned_request_url(card_url, addresses[0])
    headers["Host"] = host_header
    extensions = {"sni_hostname": hostname} if parsed.scheme == "https" else {}
    return request_url, headers, extensions


async def test_agent_connectivity(
    endpoint: str,
    *,
    tenant_namespace: str,
    timeout_seconds: float = 10.0,
    credential_headers: dict[str, str] | None = None,
) -> tuple[str, str, dict[str, Any]]:
    """Fetch and validate an A2A agent card without following redirects."""

    normalized = normalize_agent_endpoint(endpoint, tenant_namespace)
    card_url = agent_card_url(normalized)
    candidates = [card_url]
    if card_url.endswith(_CARD_PATH) and not normalized.endswith(_CARD_PATH):
        candidates.append(card_url.removesuffix("agent.json") + "agent-card.json")
    timeout = httpx.Timeout(timeout_seconds, connect=min(timeout_seconds, 5.0))
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False) as client:
            for index, card_url in enumerate(candidates):
                request_url, headers, extensions = await resolve_agent_card_request(card_url)
                headers.update(credential_headers or {})
                async with client.stream("GET", request_url, headers=headers, extensions=extensions) as response:
                    if response.status_code == 404 and index + 1 < len(candidates):
                        continue
                    if response.status_code != 200:
                        raise AgentCatalogError(f"A2A agent-card endpoint returned HTTP {response.status_code}")
                    chunks: list[bytes] = []
                    size = 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > _MAX_AGENT_CARD_BYTES:
                            raise AgentCatalogError("A2A agent card exceeds the 256 KiB limit")
                        chunks.append(chunk)
                    break
    except AgentCatalogError:
        raise
    except httpx.HTTPError as exc:
        # Refused / timed out / unresolved would each read differently, which turns this
        # endpoint into a port scanner for the caller -- but the raw URL (query values
        # included) and the exception text (which can echo back connection detail) must
        # never land in the log either. Only the exception type and the tenant asking
        # for this fetch are safe to record.
        logger.warning(
            "proofgrove: agent-card fetch failed for tenant=%s: %s",
            tenant_namespace,
            type(exc).__name__,
        )
        raise AgentCatalogError("Could not connect to the A2A agent-card endpoint") from exc

    try:
        card = json.loads(b"".join(chunks))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AgentCatalogError("A2A agent-card endpoint did not return valid JSON") from exc
    return normalized, card_url, _catalog_card(card)
