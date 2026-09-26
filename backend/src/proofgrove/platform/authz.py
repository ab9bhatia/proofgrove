"""Tenant identity and application-permission enforcement for Proofgrove.

Identity headers are supplied by the Proofgrove edge in production. Local tests and
developer mode deliberately remain usable without the identity integration.

**Two value-spaces.** The gateway injects ``x-evalai-tenant: <slug>`` (e.g.
``evalai``). Proofgrove scopes data by the Kubernetes namespace
``tenant-<slug>`` (also ``POD_NAMESPACE``). Identity headers are always slugs.
Legacy storage aliases are accepted only for the configured deployment tenant;
without that authority, stored tenant identifiers compare exactly.
"""

import hashlib
import logging
import re
from collections.abc import Iterable
from urllib.parse import quote

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from proofgrove.settings import settings

logger = logging.getLogger(__name__)

PERMISSION_TARGET_MANAGE = "target.manage"
PERMISSION_EVALUATION_RUN = "evaluation.run"
PERMISSION_EVALUATION_READ = "evaluation.read"
PERMISSION_EVIDENCE_READ = "evidence.read"
PERMISSION_EVALUATION_QUERY = "evaluation.query"
PERMISSION_GOVERNANCE_APPROVE = "governance.approve"
PERMISSION_GOVERNANCE_REVIEW = "governance.review"
PERMISSION_AUDIT_READ = "audit.read"

_ROLE_PERMISSIONS = {
    "proofgrove-approver": PERMISSION_GOVERNANCE_APPROVE,
    "proofgrove-reviewer": PERMISSION_GOVERNANCE_REVIEW,
}
GOVERNANCE_ROLES = frozenset(_ROLE_PERMISSIONS)
DEFAULT_RELEASE_APPROVER_ROLE = "proofgrove-approver"


def _subject_fingerprint(subject: str) -> str:
    """Sha256-prefix a subject id for logging/audit fields.

    Raw subject identifiers (``user:alice@example.com``) are auth-adjacent
    input CodeQL flags as clear-text logging of sensitive data. A stable
    12-hex fingerprint keeps log correlation useful without writing the real
    identifier to the log stream.
    """
    return hashlib.sha256(subject.encode()).hexdigest()[:12]


def actor_from_request(request: Request) -> str:
    return (
        request.headers.get("x-evalai-sub")
        or request.headers.get("x-evalai-subject")
        or "system"
    )


def _trusted_identity(request: Request) -> tuple[str, str]:
    tenant = (request.headers.get("x-evalai-tenant") or "").strip()
    # Only x-evalai-sub is replaced by the gateway. Never authorize from the
    # legacy x-evalai-subject header because an external caller could spoof it.
    subject = (request.headers.get("x-evalai-sub") or "").strip()
    if not tenant or not subject:
        raise HTTPException(status_code=401, detail="authenticated tenant and subject are required")
    if not subject.startswith(("user:", "service:")):
        subject = f"user:{subject}"
    caller_tenant(request)  # Reject an identity belonging to another deployment.
    return tenant, subject


async def check_permission(request: Request, permission: str) -> bool:
    """Ask the central AuthZ service; infrastructure failures fail closed as 503."""
    if not settings.platform_auth_required:
        request.state.proofgrove_permissions = {permission}
        return True

    caller_tenant_id, subject = _trusted_identity(request)
    # The gateway (and UI BFF) supplies the Tenant CR name, never a namespace.
    # A slug may itself start with "tenant-"; stripping it would authorize a
    # different tenant.
    tenant = caller_tenant_id
    if not settings.authz_check_token:
        logger.error("Proofgrove AuthZ token is not configured")
        raise HTTPException(status_code=503, detail="authorization service is unavailable")

    url = (
        f"{settings.authz_service_url.rstrip('/')}/v1/apps/"
        f"{quote(settings.authz_app_name, safe='')}/permissions/check"
    )
    try:
        async with httpx.AsyncClient(timeout=settings.authz_timeout_seconds) as client:
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {settings.authz_check_token.get_secret_value()}",
                    "x-evalai-tenant": tenant,
                },
                json={"tenant_id": tenant, "permission": permission, "subject": subject},
            )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            # A 200 whose body is an array/scalar/null must fail closed as
            # 503 like every other malformed answer, not escape as an
            # AttributeError-turned-500 below.
            raise ValueError("authorization response is not a JSON object")
        allowed = payload.get("allowed") is True
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        # Log only the exception's class -- never the exception object, its
        # message, or exc_info. Transport/provider diagnostics can embed
        # request fragments (the bearer header, the subject) as opaque text
        # that pattern-based redaction cannot be trusted to catch.
        logger.error(
            "Proofgrove authorization check failed: %s",
            type(exc).__name__,
            extra={
                "tenant_id": tenant,
                "subject": _subject_fingerprint(subject),
                "permission": permission,
            },
        )
        raise HTTPException(status_code=503, detail="authorization service is unavailable") from None

    logger.info(
        "Proofgrove authorization decision",
        extra={
            "tenant_id": tenant,
            "caller_tenant_id": caller_tenant_id,
            "subject": _subject_fingerprint(subject),
            "permission": permission,
            "allowed": allowed,
        },
    )
    if allowed:
        granted = getattr(request.state, "proofgrove_permissions", set())
        request.state.proofgrove_permissions = {*granted, permission}
    return allowed


async def require_permission(request: Request, permission: str) -> None:
    if not await check_permission(request, permission):
        raise HTTPException(status_code=403, detail=f"{permission} permission is required")


_PROBE_PATHS = ("/health", "/healthz", "/readyz", "/livez")
_DOC_PATHS = ("/docs", "/redoc")


def _path_is_or_is_under(path: str, roots: tuple[str, ...]) -> bool:
    """True when ``path`` equals a root or continues it with ``/``.

    Plain ``str.startswith`` would also let ``/healthz-evil`` through the
    ``/health`` allowlist -- an unauthenticated bypass of the probe/docs
    exemption. Requiring an exact match or a ``/`` boundary closes that while
    still matching real sub-paths like ``/health/live``.
    """
    return any(path == root or path.startswith(f"{root}/") for root in roots)


def permission_for_request(method: str, path: str) -> str | None:
    """Map the public API surface to the least application permission required."""
    method = method.upper()
    if method == "OPTIONS" or _path_is_or_is_under(path, _PROBE_PATHS) or path == "/openapi.json":
        return None
    if _path_is_or_is_under(path, _DOC_PATHS) or path == "/platform/capabilities":
        return None

    if method in {"GET", "HEAD"}:
        if path == "/platform/audit-events":
            return PERMISSION_AUDIT_READ
        if (
            path.startswith("/tracing")
            or path.startswith("/platform/evidence-packs")
            or "/artifacts/" in path
            or path.endswith("/trace")
            or path.endswith("/report")
        ):
            return PERMISSION_EVIDENCE_READ
        if re.fullmatch(r"/platform/findings/[^/]+/(review-tasks|review-decisions|comments|activity)", path):
            return PERMISSION_GOVERNANCE_REVIEW
        return PERMISSION_EVALUATION_READ

    if (
        path in {"/agents/catalog", "/evaluation/llm-catalog", "/platform/projects"}
        or re.fullmatch(r"/platform/projects/[^/]+/target-versions", path)
    ):
        return PERMISSION_TARGET_MANAGE

    if method == "POST" and (
        re.fullmatch(r"/evaluation/runs/from-dataset/[^/]+/readiness", path)
        or path == "/evaluation/metric-set"
    ):
        return PERMISSION_EVALUATION_QUERY

    # Hiding a trace from the tenant index is curation of evidence, not an
    # evaluation launch; it takes the review permission explicitly rather
    # than the run default below.
    if path.startswith("/tracing/") and (path.endswith("/hide") or path.endswith("/unhide")):
        return PERMISSION_GOVERNANCE_REVIEW

    governance_markers = (
        "/approve",
        "/reject",
        "/reopen",
        "/publish",
        "/deprecate",
        "/retire",
        "/restore",
        "/decisions",
        "/waivers",
        "/remediations",
        "/promote-regression",
        "/baseline",
        "/promote",
    )
    if path.startswith("/platform") or any(marker in path for marker in governance_markers):
        # Match route structure, not words inside user-controlled resource IDs.
        if re.fullmatch(
            r"/platform/(review-cases|review-decisions|findings/[^/]+/(comments|remediations)|remediations/[^/]+|regressions/[^/]+/replay)",
            path,
        ):
            return PERMISSION_GOVERNANCE_REVIEW
        return PERMISSION_GOVERNANCE_APPROVE
    return PERMISSION_EVALUATION_RUN


_TENANT_SCOPE_STATE_KEY = "proofgrove_tenant_scope_checked"


# Routes that legitimately return the same content to every tenant (a shared
# rubric catalogue, service/judge config, a metric preview computed from the
# request body) and so have nothing to compare a caller against. Verified by
# reading each handler -- add a path here only after confirming it returns no
# tenant-scoped data, never as a default for "didn't get around to it".
_TENANT_AGNOSTIC_PATHS = frozenset(
    {
        "/evaluation/scenarios",
        "/evaluation/judge-config",
        "/evaluation/judge-models",
        "/evaluation/metrics",
        "/evaluation/metric-set",
        "/evaluation/sample-experiments",
        "/platform/quality-contract-templates",
        # The upload CSV template: a frozen constant with no tenant data.
        "/datasets/csv-template",
    }
)

# Routers whose every endpoint resolves tenant identity purely from the
# caller's own request (`x-evalai-tenant` / POD_NAMESPACE, via
# `_request_tenant` in agents.py / llms.py) rather than a caller-supplied
# tenant_id, so they never have one to put in the query string. Each already
# calls `enforce_tenant` itself -- this prefix list only lets them skip the
# structural check below, it does not weaken the check they already run.
_SELF_SCOPED_PATH_PREFIXES = ("/agents", "/evaluation/llm-catalog")


def mark_tenant_scope_checked(request: Request) -> None:
    """Record that this request actually compared a caller to a resource owner.

    Backed by ``scope["state"]``, which every ``Request`` built from the same
    ASGI scope shares -- so a route calling ``enforce_tenant`` or
    ``authorize_dataset_access`` anywhere during its own handling marks the
    same dict ``AuthorizationMiddleware`` reads back after the route returns.
    """
    request.state.proofgrove_tenant_scope_checked = True


class AuthorizationMiddleware:
    """Fail-closed action authorization for every non-health Proofgrove request."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "GET")
        path = scope.get("path", "")
        permission = permission_for_request(method, path)
        if permission is None:
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        requested_tenant = None
        try:
            if settings.platform_auth_required:
                await require_permission(request, permission)
            # `require_permission` answers "may this caller do this kind of thing",
            # against their own tenant. It never looks at the tenant the URL asks
            # for, so a route that took `tenant_id` on trust served whatever tenant
            # was named. Most routes call `_authorize` and compare it themselves;
            # the ones that forgot were served anyway. Comparing here means a route
            # cannot opt out of the check by omission, including a route added later.
            requested_tenant = request.query_params.get("tenant_id")
            if requested_tenant:
                enforce_tenant(request, requested_tenant)
                # A query value confirms caller identity, not resource ownership.
                request.scope["state"].pop(_TENANT_SCOPE_STATE_KEY, None)
        except HTTPException as exc:
            response = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
            await response(scope, receive, send)
            return

        if not settings.platform_auth_required or path in _TENANT_AGNOSTIC_PATHS or _path_is_or_is_under(path, _SELF_SCOPED_PATH_PREFIXES):
            await self.app(scope, receive, send)
            return

        # Structural fail-closed: the route must compare resource ownership,
        # even when a query parameter already matched the caller. The handler
        # checks the owner after loading the addressed resource -- if it
        # never does, refuse the response instead of shipping unscoped data.
        state = scope.setdefault("state", {})
        suppressed = False

        async def guarded_send(message: dict) -> None:
            nonlocal suppressed
            if suppressed:
                return
            if (
                message["type"] == "http.response.start"
                and message["status"] < 400
                and not state.get(_TENANT_SCOPE_STATE_KEY)
            ):
                suppressed = True
                logger.error(
                    "Proofgrove route returned %s with no tenant scope check",
                    message["status"],
                    extra={"path": path, "method": method},
                )
                denial = JSONResponse(
                    status_code=403,
                    content={"detail": "tenant scoping is required for this route"},
                )
                await denial(scope, receive, send)
                return
            await send(message)

        await self.app(scope, receive, guarded_send)


def namespace_for_tenant(tenant: str) -> str:
    """Resolve storage aliases only for the authoritative deployment tenant."""
    value = tenant.strip()
    namespace = (settings.pod_namespace or "").strip()
    if namespace.startswith("tenant-") and value in {namespace, namespace[len("tenant-"):]}:
        return namespace
    return value


def tenants_match(left: str, right: str) -> bool:
    return namespace_for_tenant(left) == namespace_for_tenant(right)


def tenant_id_candidates(tenant: str) -> tuple[str, ...]:
    """Include legacy spellings only within this deployment's tenant database."""
    namespace = (settings.pod_namespace or "").strip()
    value = namespace_for_tenant(tenant)
    if namespace.startswith("tenant-") and value == namespace:
        return (namespace, namespace[len("tenant-"):])
    return (value,)


def caller_tenant(request: Request) -> str:
    """Resolve a gateway slug against the trusted deployment namespace.

    With no configured namespace (offline/shared tests), identity is exact and
    no slug/namespace aliases are inferred. The BFF sends the same slug header
    as the gateway; a namespace-looking header is still a slug.
    """
    supplied = (request.headers.get("x-evalai-tenant") or "").strip()
    namespace = (settings.pod_namespace or "").strip()
    if supplied and namespace:
        if not namespace.startswith("tenant-") or supplied != namespace[len("tenant-"):]:
            raise HTTPException(status_code=403, detail="tenant header does not match Proofgrove namespace")
        return namespace
    return supplied or namespace


def require_caller_tenant(request: Request) -> str:
    """The caller's identity, refusing a request that presents none.

    This only resolves *who is asking* -- it never compares that identity to
    a resource owner, so it must NOT mark the request as tenant-scope-checked.
    ``AuthorizationMiddleware`` treats that mark as proof an owner comparison
    happened; a route that calls only this and returns data would otherwise
    ship unscoped data under a checked-looking request. Call ``enforce_tenant``
    (or ``authorize_dataset_access``) once the resource owner is known -- those
    compare and mark themselves.
    """
    caller = caller_tenant(request)
    if not caller:
        raise HTTPException(status_code=401, detail="x-evalai-tenant is required")
    return caller


def enforce_tenant(request: Request, tenant_id: str | None) -> None:
    """Refuse a request that is not acting as ``tenant_id``.

    A caller with no identity is refused rather than allowed. The previous
    form only compared when a header was present, so a header-less request
    fell through every branch and was permitted. Tenant isolation also applies
    in development, independently of whether application permissions are enabled.
    Identity resolution and the deny both live here, so all call sites get the
    same rule.
    """
    supplied = (request.headers.get("x-evalai-tenant") or "").strip()
    if settings.platform_auth_required and not supplied:
        raise HTTPException(status_code=401, detail="x-evalai-tenant is required")
    caller = caller_tenant(request)
    if not caller:
        raise HTTPException(status_code=401, detail="x-evalai-tenant is required")
    owner = (tenant_id or "").strip()
    if not owner:
        # An unowned resource belongs to no one, so it matches no caller. The
        # previous form skipped the comparison entirely, which made a row that
        # reached the table without a tenant readable by every tenant.
        raise HTTPException(
            status_code=403, detail="tenant header does not match the requested resource"
        )
    if not tenants_match(caller, owner):
        raise HTTPException(
            status_code=403, detail="tenant header does not match the requested resource"
        )
    mark_tenant_scope_checked(request)


def authorize_dataset_access(request: Request, tenant_id: str | None) -> None:
    """Authorize a request against the tenant that owns a dataset.

    Datasets are addressed by a globally unique name rather than under a tenant
    path, so any route that accepts a caller-supplied dataset name must ask this
    before reading or mutating it — including routes outside the datasets
    router, such as launching a run from a dataset.

    A cross-tenant request is answered 404, exactly as a missing dataset is.
    A distinct 403 would confirm the name exists and make the endpoint an oracle
    for other tenants' dataset names.

    The denial is local to this guard rather than delegated to the
    ``platform_auth_required`` flag: a caller that presents no tenant identity
    at all (no header, no pod namespace) is refused, and so is a dataset whose
    recorded owner is empty — non-nullable is not the guarantee this check
    needs, non-empty is. The 401 for a missing header under
    ``platform_auth_required`` is preserved unrewritten, since it reveals
    nothing about datasets.
    """
    supplied = (request.headers.get("x-evalai-tenant") or "").strip()
    if settings.platform_auth_required and not supplied:
        raise HTTPException(status_code=401, detail="x-evalai-tenant is required")
    caller = caller_tenant(request)
    owner = (tenant_id or "").strip()
    if not caller or not owner or not tenants_match(caller, owner):
        raise HTTPException(status_code=404, detail="Dataset not found")
    mark_tenant_scope_checked(request)


def resolve_requested_tenant(request: Request, tenant_id: str | None) -> str:
    """Return the namespace-form tenant for a list/query endpoint.

    Prefer an explicit ``tenant_id`` query, then the gateway
    ``x-evalai-tenant`` header (the Proofgrove UI BFF always sends this), then
    ``POD_NAMESPACE``. Callers that omit the query param therefore still
    scope correctly instead of 422ing.

    **Resolution does not release the structural gate.** Comparing the
    caller to a value derived from the caller's own request proves identity,
    not resource ownership -- the same distinction ``AuthorizationMiddleware``
    draws when it pops the mark for a bare ``?tenant_id=`` query. A route
    that only resolves and then reads unscoped data is therefore refused by
    the middleware. After actually applying the returned namespace as the
    filter of its query, a list/create route attests that with
    ``mark_tenant_scope_checked(request)`` at the query boundary; a route
    that loads a resource by identifier compares the loaded owner via
    ``enforce_tenant`` / ``authorize_dataset_access`` instead.
    """
    query = (tenant_id or "").strip() or None
    header = (request.headers.get("x-evalai-tenant") or "").strip() or None
    pod = (settings.pod_namespace or "").strip() or None
    chosen = query or header or pod
    if not chosen:
        raise HTTPException(status_code=400, detail="tenant_id is required")
    state = request.scope.setdefault("state", {})
    already_checked = bool(state.get(_TENANT_SCOPE_STATE_KEY))
    enforce_tenant(request, chosen)
    if not already_checked:
        # Undo only the mark enforce_tenant just set on our behalf; a mark an
        # earlier real ownership comparison left in place is preserved.
        state.pop(_TENANT_SCOPE_STATE_KEY, None)
    return namespace_for_tenant(chosen)


def require_role(request: Request, role: str) -> None:
    """Compatibility guard backed by the permission verified at the API boundary."""
    if not settings.platform_auth_required:
        return
    permission = _ROLE_PERMISSIONS.get(role)
    granted = getattr(request.state, "proofgrove_permissions", set())
    if not permission or permission not in granted:
        raise HTTPException(status_code=403, detail=f"{role} role is required")


def validate_governance_roles(roles: Iterable[str]) -> list[str]:
    """Accept only real platform governance roles. Unknown names fail closed."""

    cleaned: list[str] = []
    seen: set[str] = set()
    unknown: list[str] = []
    for raw in roles:
        role = str(raw).strip()
        if not role:
            continue
        if role not in GOVERNANCE_ROLES:
            unknown.append(role)
            continue
        if role not in seen:
            seen.add(role)
            cleaned.append(role)
    if unknown:
        allowed = ", ".join(sorted(GOVERNANCE_ROLES))
        raise ValueError(
            "approver roles must be real platform roles "
            f"({allowed}); unrecognised: {', '.join(sorted(set(unknown)))}"
        )
    return cleaned


async def require_configured_approver_roles(request: Request, roles: Iterable[str]) -> None:
    """Enforce the roles snapshotted on the governing Profile and Gate Policy.

    An empty list keeps the historical default: the generic platform approver.
    Unknown configured roles cannot be satisfied, so the decision is refused.
    Maker-checker separation is an open product decision and is not implied here.
    """

    required: list[str] = []
    unknown: list[str] = []
    seen: set[str] = set()
    for raw in roles:
        role = str(raw).strip()
        if not role:
            continue
        if role not in _ROLE_PERMISSIONS:
            unknown.append(role)
            continue
        if role not in seen:
            seen.add(role)
            required.append(role)
    if unknown:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "approver_role_unenforceable",
                "message": (
                    "This run requires approver role(s) that are not platform roles: "
                    + ", ".join(sorted(set(unknown)))
                ),
            },
        )
    if not required:
        required = [DEFAULT_RELEASE_APPROVER_ROLE]
    for role in required:
        await require_permission(request, _ROLE_PERMISSIONS[role])
