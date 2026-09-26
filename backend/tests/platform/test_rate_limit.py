"""Rate limiting at the Proofgrove application boundary."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from proofgrove.platform.rate_limit import RateLimitMiddleware, ServerRateLimiter
from proofgrove.settings import Settings


class _Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def _app(*, requests_per_minute: int = 60, burst: int = 2) -> FastAPI:
    config = Settings(
        rate_limit_enabled=True,
        rate_limit_requests_per_minute=requests_per_minute,
        rate_limit_burst=burst,
        rate_limit_max_buckets=10,
        rate_limit_bucket_ttl_seconds=60,
    )
    app = FastAPI()
    app.add_middleware(RateLimitMiddleware, config=config)

    @app.get("/evaluation/runs")
    async def runs() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/health/ready")
    async def ready() -> dict[str, bool]:
        return {"ready": True}

    return app


def test_server_rate_limiter_refills_and_returns_retry_delay() -> None:
    clock = _Clock()
    limiter = ServerRateLimiter(
        requests_per_minute=60,
        burst=1,
        max_buckets=2,
        bucket_ttl_seconds=60,
        clock=clock,
    )

    assert limiter.check("tenant:a").allowed is True
    exhausted = limiter.check("tenant:a")
    assert exhausted.allowed is False
    assert exhausted.retry_after_seconds == 1

    clock.now += 1
    assert limiter.check("tenant:a").allowed is True


def test_server_rate_limiter_bounds_client_bucket_memory() -> None:
    clock = _Clock()
    limiter = ServerRateLimiter(
        requests_per_minute=60,
        burst=1,
        max_buckets=2,
        bucket_ttl_seconds=60,
        clock=clock,
    )

    assert limiter.check("tenant:a").allowed is True
    assert limiter.check("tenant:b").allowed is True
    assert limiter.check("tenant:c").allowed is True
    # tenant:a was the least-recently-used bucket and receives a fresh token
    # after eviction instead of growing the cache beyond its configured bound.
    assert limiter.check("tenant:a").allowed is True


def test_rate_limit_returns_phoenix_compatible_429_and_retry_after() -> None:
    with TestClient(_app()) as client:
        headers = {
            "x-evalai-tenant": "tenant-a",
            "x-evalai-sub": "user-1",
        }
        assert client.get("/evaluation/runs", headers=headers).status_code == 200
        assert client.get("/evaluation/runs", headers=headers).status_code == 200
        response = client.get("/evaluation/runs", headers=headers)

    assert response.status_code == 429
    assert response.json() == {"detail": "Too Many Requests"}
    assert response.headers["retry-after"] == "1"
    assert response.headers["x-ratelimit-limit"] == "60"
    assert response.headers["x-ratelimit-remaining"] == "0"


def test_rate_limit_buckets_are_tenant_and_subject_scoped() -> None:
    with TestClient(_app(burst=1)) as client:
        tenant_a = {"x-evalai-tenant": "tenant-a", "x-evalai-sub": "user-1"}
        tenant_b = {"x-evalai-tenant": "tenant-b", "x-evalai-sub": "user-1"}
        tenant_a_other_user = {
            "x-evalai-tenant": "tenant-a",
            "x-evalai-sub": "user-2",
        }

        assert client.get("/evaluation/runs", headers=tenant_a).status_code == 200
        assert client.get("/evaluation/runs", headers=tenant_a).status_code == 429
        assert client.get("/evaluation/runs", headers=tenant_b).status_code == 200
        assert (
            client.get("/evaluation/runs", headers=tenant_a_other_user).status_code
            == 200
        )


def test_health_checks_are_never_rate_limited() -> None:
    with TestClient(_app(burst=1)) as client:
        for _ in range(5):
            assert client.get("/health/ready").status_code == 200


def test_healthz_alias_is_never_rate_limited() -> None:
    app = _app(burst=1)

    @app.get("/healthz")
    async def healthz() -> dict[str, bool]:
        return {"ok": True}

    with TestClient(app) as client:
        for _ in range(5):
            assert client.get("/healthz").status_code == 200


def test_health_lookalike_path_is_still_rate_limited() -> None:
    """A path merely starting with ``/health`` must still be rate limited.

    Plain ``str.startswith`` on the probe-path prefixes would also exempt
    ``/healthz-evil`` -- an unauthenticated way to dodge the limiter.
    """
    app = _app(burst=1)

    @app.get("/healthz-evil")
    async def healthz_evil() -> dict[str, bool]:
        return {"ok": True}

    with TestClient(app) as client:
        assert client.get("/healthz-evil").status_code == 200
        assert client.get("/healthz-evil").status_code == 429
