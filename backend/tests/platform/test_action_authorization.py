"""Fail-closed application authorization and route-permission policy."""

import httpx
import pytest
from fastapi import HTTPException, Request
from pydantic import SecretStr

from evalhub.logging_config import JsonLogFormatter
from evalhub.platform import authz
from evalhub.settings import Settings, settings


def _request(*, tenant: str = "acme", subject: str = "alice@example.com") -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/evaluation/runs",
            "headers": [
                (b"x-evalai-tenant", tenant.encode()),
                (b"x-evalai-sub", subject.encode()),
            ],
        }
    )


@pytest.fixture
def auth_required():
    previous = (
        settings.platform_auth_required,
        settings.authz_check_token,
        settings.authz_service_url,
        settings.authz_app_name,
    )
    settings.platform_auth_required = True
    settings.authz_check_token = SecretStr("check-token")
    settings.authz_service_url = "http://authz.test:8080"
    settings.authz_app_name = Settings.model_fields["authz_app_name"].default
    yield
    (
        settings.platform_auth_required,
        settings.authz_check_token,
        settings.authz_service_url,
        settings.authz_app_name,
    ) = previous


class _AuthzClient:
    def __init__(self, allowed: bool, calls: list[dict]) -> None:
        self.allowed = allowed
        self.calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, url: str, **kwargs) -> httpx.Response:
        self.calls.append({"url": url, **kwargs})
        request = httpx.Request("POST", url)
        return httpx.Response(200, json={"allowed": self.allowed, "checked_at": "zed"}, request=request)


@pytest.mark.anyio
async def test_permission_check_injects_trusted_tenant_subject_and_token(auth_required, monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", lambda **_kwargs: _AuthzClient(True, calls))

    assert await authz.check_permission(_request(), authz.PERMISSION_EVALUATION_RUN) is True
    assert calls == [
        {
            "url": "http://authz.test:8080/v1/apps/eval-hub/permissions/check",
            "headers": {
                "Authorization": "Bearer check-token",
                "x-evalai-tenant": "acme",
            },
            "json": {
                "tenant_id": "acme",
                "permission": "evaluation.run",
                "subject": "user:alice@example.com",
            },
        }
    ]


@pytest.mark.anyio
async def test_permission_check_preserves_tenant_slug_prefix(auth_required, monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", lambda **_kwargs: _AuthzClient(True, calls))

    assert await authz.check_permission(_request(tenant="tenant-evalai"), authz.PERMISSION_EVALUATION_READ) is True
    assert calls[0]["headers"]["x-evalai-tenant"] == "tenant-evalai"
    assert calls[0]["json"]["tenant_id"] == "tenant-evalai"


@pytest.mark.anyio
async def test_missing_check_token_fails_closed(auth_required):
    settings.authz_check_token = SecretStr("")
    with pytest.raises(HTTPException) as exc:
        await authz.check_permission(_request(), authz.PERMISSION_EVALUATION_READ)
    assert exc.value.status_code == 503


@pytest.mark.anyio
async def test_missing_authenticated_subject_is_unauthorized(auth_required):
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/evaluation/runs",
            "headers": [(b"x-evalai-tenant", b"acme")],
        }
    )
    with pytest.raises(HTTPException) as exc:
        await authz.check_permission(request, authz.PERMISSION_EVALUATION_READ)
    assert exc.value.status_code == 401


@pytest.mark.anyio
async def test_legacy_subject_header_is_not_trusted_for_authorization(auth_required):
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/evaluation/runs",
            "headers": [
                (b"x-evalai-tenant", b"acme"),
                (b"x-evalai-subject", b"spoofed@example.com"),
            ],
        }
    )
    with pytest.raises(HTTPException) as exc:
        await authz.check_permission(request, authz.PERMISSION_EVALUATION_READ)
    assert exc.value.status_code == 401


@pytest.mark.anyio
async def test_authorization_decision_logs_hashed_subject_not_raw(auth_required, monkeypatch, caplog):
    calls: list[dict] = []
    monkeypatch.setattr(authz.httpx, "AsyncClient", lambda **_kwargs: _AuthzClient(True, calls))

    with caplog.at_level("INFO"):
        await authz.check_permission(_request(subject="alice@example.com"), authz.PERMISSION_EVALUATION_RUN)

    decisions = [r for r in caplog.records if r.getMessage() == "Eval Hub authorization decision"]
    assert decisions
    logged_subject = decisions[0].subject
    assert logged_subject == authz._subject_fingerprint("user:alice@example.com")
    assert "alice@example.com" not in logged_subject
    # Content-leak sweep across every record field (message, args, extra), not
    # just the fields the log call is known to set today.
    for record in caplog.records:
        assert "alice@example.com" not in str(vars(record))
        assert "check-token" not in str(vars(record))


@pytest.mark.anyio
async def test_authorization_check_failure_logs_fingerprint_and_no_traceback(auth_required, monkeypatch, caplog):
    # Adversarial diagnostic: a transport error whose message embeds the
    # bearer token and the raw subject as opaque text. Pattern-based
    # redaction cannot catch these, so the logging contract itself must keep
    # exception content out of the record entirely.
    diagnostic = "upstream diagnostic Bearer check-token user:alice@example.com"

    class _FailingClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            raise httpx.ConnectError(diagnostic)

    monkeypatch.setattr(authz.httpx, "AsyncClient", lambda **_kwargs: _FailingClient())

    with caplog.at_level("ERROR"):
        with pytest.raises(HTTPException) as exc:
            await authz.check_permission(_request(subject="alice@example.com"), authz.PERMISSION_EVALUATION_RUN)
    assert exc.value.status_code == 503

    failures = [r for r in caplog.records if "authorization check failed" in r.getMessage()]
    assert failures
    record = failures[0]
    # logger.error (not logger.exception) -- no implicit traceback/exception
    # object capture that could serialize the request's Authorization header.
    assert record.exc_info is None
    assert record.subject == authz._subject_fingerprint("user:alice@example.com")
    assert "ConnectError" in record.getMessage()
    # Exception type only: the exception object must not sit in record.args
    # where a formatter would render its message.
    assert not any(isinstance(arg, BaseException) for arg in record.args or ())
    # Sweep raw record fields AND the production JSON formatter output for
    # the sentinels carried by the adversarial diagnostic.
    for failure_record in caplog.records:
        rendered = JsonLogFormatter().format(failure_record)
        for surface in (str(vars(failure_record)), rendered):
            assert "check-token" not in surface
            assert "alice@example.com" not in surface


@pytest.mark.anyio
@pytest.mark.parametrize("body", ["[]", "null", '"yes"', "[{\"allowed\": true}]"])
async def test_non_object_authorization_response_fails_closed_as_503(auth_required, monkeypatch, body):
    class _MalformedClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url: str, **_kwargs) -> httpx.Response:
            request = httpx.Request("POST", url)
            return httpx.Response(200, content=body, headers={"content-type": "application/json"}, request=request)

    monkeypatch.setattr(authz.httpx, "AsyncClient", lambda **_kwargs: _MalformedClient())

    with pytest.raises(HTTPException) as exc:
        await authz.check_permission(_request(), authz.PERMISSION_EVALUATION_RUN)
    assert exc.value.status_code == 503


@pytest.mark.anyio
async def test_non_boolean_allowed_is_denied_not_error(auth_required, monkeypatch):
    class _TruthyClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url: str, **_kwargs) -> httpx.Response:
            request = httpx.Request("POST", url)
            return httpx.Response(200, json={"allowed": "true"}, request=request)

    monkeypatch.setattr(authz.httpx, "AsyncClient", lambda **_kwargs: _TruthyClient())

    assert await authz.check_permission(_request(), authz.PERMISSION_EVALUATION_RUN) is False


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/health"),
        ("GET", "/health/live"),
        ("GET", "/health/ready"),
        ("GET", "/healthz"),
        ("GET", "/readyz"),
        ("GET", "/livez"),
        ("GET", "/docs"),
        ("GET", "/docs/oauth2-redirect"),
        ("GET", "/redoc"),
        ("OPTIONS", "/evaluation/runs"),
        ("options", "/evaluation/runs"),
    ],
)
def test_probe_and_docs_paths_require_no_permission(method, path):
    assert authz.permission_for_request(method, path) is None


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/healthz-evil"),
        ("GET", "/healthzzz"),
        ("GET", "/health-check-bypass"),
        ("GET", "/readyz-evil"),
        ("GET", "/livez-evil"),
        ("GET", "/docs-evil"),
        ("GET", "/redocs"),
    ],
)
def test_probe_and_docs_prefixes_do_not_match_lookalike_paths(method, path):
    """A path merely starting with a probe/docs prefix must still be authorized.

    Plain ``str.startswith("/health")`` also matched ``/healthz-evil`` --
    an unauthenticated bypass of the permission gate for any attacker path
    sharing that prefix.
    """
    assert authz.permission_for_request(method, path) is not None


@pytest.mark.parametrize(
    ("method", "path", "permission"),
    [
        ("POST", "/agents/catalog", "target.manage"),
        ("POST", "/evaluation/runs", "evaluation.run"),
        ("POST", "/evaluation/runs/run-1/cancel", "evaluation.run"),
        ("GET", "/evaluation/runs/run-1", "evaluation.read"),
        ("GET", "/evaluation/runs/run-1/configuration", "evaluation.read"),
        ("GET", "/platform/evidence-packs/run-1", "evidence.read"),
        ("GET", "/evaluation/runs/run-1/report", "evidence.read"),
        ("POST", "/evaluation/runs/from-dataset/golden/readiness", "evaluation.query"),
        ("POST", "/evaluation/metric-set", "evaluation.query"),
        ("DELETE", "/platform/projects/readiness", "governance.approve"),
        ("PATCH", "/evaluation/experiments/readiness", "evaluation.run"),
        ("DELETE", "/evaluation/runs/from-dataset/golden/readiness", "evaluation.run"),
        (
            "POST",
            "/platform/quality-profiles/p/versions/1/approve",
            "governance.approve",
        ),
        ("POST", "/platform/assignments", "governance.approve"),
        ("POST", "/platform/gate-policies/comments-policy/versions/1/retire", "governance.approve"),
        ("POST", "/platform/projects/target-versions/archive", "governance.approve"),
        ("POST", "/platform/projects/target-versions-extra/restore", "governance.approve"),
        ("GET", "/platform/quality-profiles/comments/versions/1", "evaluation.read"),
        ("POST", "/platform/review-decisions", "governance.review"),
        ("POST", "/platform/review-cases", "governance.review"),
        ("POST", "/platform/findings/f/remediations", "governance.review"),
        ("PATCH", "/platform/remediations/r", "governance.review"),
        ("POST", "/platform/regressions/r/replay", "governance.review"),
        ("GET", "/platform/findings/f/review-tasks", "governance.review"),
        ("GET", "/platform/findings/f/review-decisions", "governance.review"),
        ("GET", "/platform/findings/f/comments", "governance.review"),
        ("GET", "/platform/findings/f/activity", "governance.review"),
        ("GET", "/platform/assignments", "evaluation.read"),
        ("POST", "/platform/findings/f/comments", "governance.review"),
        ("GET", "/platform/audit-events", "audit.read"),
        # Restoring a retired dataset is a governance action (re-publishing
        # retired content), the same class as /publish and /retire -- it must
        # not fall through to the generic evaluation.run default.
        ("POST", "/datasets/golden/restore", "governance.approve"),
        # The two /platform-prefixed restore routes were already governed
        # before this fix (any /platform path defaults to governance.approve);
        # confirmed unaffected by the new marker.
        ("POST", "/platform/projects/p/restore", "governance.approve"),
        (
            "POST",
            "/platform/assignments/a/versions/1/restore",
            "governance.approve",
        ),
    ],
)
def test_route_permission_policy(method, path, permission):
    assert authz.permission_for_request(method, path) == permission


@pytest.mark.parametrize("slug", ["foo", "tenant-foo"])
def test_identity_headers_cannot_alias_another_tenant(monkeypatch, slug):
    namespace = f"tenant-{slug}"
    monkeypatch.setattr(settings, "pod_namespace", namespace)
    request = _request(tenant=slug)
    assert authz.caller_tenant(request) == namespace
    assert authz.tenant_id_candidates(namespace) == (namespace, slug)
    authz.enforce_tenant(request, slug)
    authz.enforce_tenant(request, namespace)
    other = "tenant-foo" if slug == "foo" else "foo"
    with pytest.raises(HTTPException) as error:
        authz.caller_tenant(_request(tenant=other))
    assert error.value.status_code == 403


def test_no_deployment_authority_means_no_tenant_aliases(monkeypatch):
    monkeypatch.setattr(settings, "pod_namespace", "")
    assert not authz.tenants_match("foo", "tenant-foo")
    assert authz.tenant_id_candidates("tenant-foo") == ("tenant-foo",)
    with pytest.raises(HTTPException):
        authz.enforce_tenant(_request(tenant="tenant-foo"), "foo")
