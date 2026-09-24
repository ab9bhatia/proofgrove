"""Tests for the main application endpoints."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from evalhub.main import _json_unhandled_handler, app


@pytest.mark.asyncio
async def test_healthz() -> None:
    """Verify the health check endpoint returns ok status."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_readyz() -> None:
    """Verify the readiness endpoint returns ready status."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/readyz")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


@pytest.mark.asyncio
async def test_unhandled_error_response_hides_the_exception_detail() -> None:
    """A crash must not echo the exception text — it can carry secrets or attacker input."""

    probe = FastAPI(exception_handlers={Exception: _json_unhandled_handler})

    @probe.get("/boom")
    async def _boom() -> None:
        raise RuntimeError("postgresql://user:s3cret@db.internal/evalhub")

    transport = ASGITransport(app=probe, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/boom")

    assert response.status_code == 500
    assert response.json() == {"detail": "Internal server error"}
    assert "s3cret" not in response.text
    assert "RuntimeError" not in response.text


@pytest.mark.asyncio
async def test_error_responses_carry_cors_headers_for_allowed_origin() -> None:
    """CORS must be the outermost middleware: a 4xx from an inner layer
    (authz/rate-limit/size-cap) still needs CORS headers or the browser hides
    the real status from the calling page."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(
            "/nonexistent-route",
            headers={"Origin": "http://localhost:3010"},
        )
    assert response.status_code == 404
    assert response.headers.get("access-control-allow-origin") == "http://localhost:3010"


@pytest.mark.asyncio
async def test_client_disconnect_mid_upload_logs_no_error(caplog) -> None:
    """A client dropping mid-body is a normal event: the size-cap middleware
    returns instead of replaying the disconnect into the app as a crash."""
    import logging


    scope = {
        "type": "http",
        "method": "POST",
        "path": "/datasets/upload",
        "headers": [(b"transfer-encoding", b"chunked")],
        "query_string": b"",
    }
    received = [
        {"type": "http.request", "body": b"partial", "more_body": True},
        {"type": "http.disconnect"},
    ]

    async def receive():
        return received.pop(0)

    sent = []

    async def send(message):
        sent.append(message)

    with caplog.at_level(logging.ERROR):
        await app(scope, receive, send)
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


def test_readiness_failure_log_names_exception_type_only(monkeypatch, caplog):
    """The probe warning must not carry driver detail, from ANY logger.

    A real DNS failure's message never contains the hostname, so this uses a
    sentinel-bearing exception instead: the assertion flips if the handler
    ever logs the exception message again (the pre-fix `%s: exc` shape).
    """
    from evalhub.api import health as health_module

    class _ExplodingSession:
        async def __aenter__(self):
            raise RuntimeError("host=nowhere.invalid password=hunter2")

        async def __aexit__(self, *_args):
            return None

    monkeypatch.setattr(health_module, "async_session", lambda: _ExplodingSession())
    with TestClient(app) as client:
        with caplog.at_level("WARNING"):
            response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json()["reason"] == "database unavailable"
    failures = [r for r in caplog.records if "Readiness check failed" in r.getMessage()]
    assert failures
    assert "RuntimeError" in failures[0].getMessage()
    # Sweep EVERY captured record (driver/pool/framework loggers included),
    # not just the readiness line: connection details must never reach the
    # unauthenticated-probe log stream through any logger.
    for record in caplog.records:
        assert "nowhere.invalid" not in str(vars(record))
        assert "hunter2" not in str(vars(record))
