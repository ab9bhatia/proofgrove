"""Bounded, Phoenix-style application rate limiting for Eval Hub.

Envoy Gateway is the authoritative distributed limiter for public traffic. This
middleware is the defence-in-depth boundary for the in-tenant UI BFF and other
approved ClusterIP callers that do not traverse the Eval Hub HTTPRoute.
"""

from __future__ import annotations

import math
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from threading import Lock

from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from evalhub.settings import Settings

# Kept in sync with evalhub.platform.authz._PROBE_PATHS -- both guard the
# same set of orchestrator probe routes (/health/*, /healthz, /readyz,
# /livez), just at different layers.
_PROBE_PATHS = ("/health", "/healthz", "/readyz", "/livez")


def _path_is_or_is_under(path: str, roots: tuple[str, ...]) -> bool:
    """True when ``path`` equals a root or continues it with ``/``.

    Plain ``str.startswith`` would also let ``/healthz-evil`` bypass the
    probe allowlist -- see ``evalhub.platform.authz._path_is_or_is_under``,
    which this mirrors.
    """
    return any(path == root or path.startswith(f"{root}/") for root in roots)


@dataclass
class _TokenBucket:
    tokens: float
    updated_at: float
    last_seen_at: float


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    limit: int
    remaining: int
    retry_after_seconds: int


class ServerRateLimiter:
    """A bounded cache of continuously-refilled token buckets.

    Phoenix uses the same general shape: one server limiter owns token buckets
    keyed by the requesting client and raises HTTP 429 when no token is
    available. Eval Hub additionally caps and expires the cache so attacker-
    controlled identities cannot grow process memory without bound.
    """

    def __init__(
        self,
        *,
        requests_per_minute: int,
        burst: int,
        max_buckets: int,
        bucket_ttl_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if requests_per_minute <= 0:
            raise ValueError("requests_per_minute must be positive")
        if burst <= 0:
            raise ValueError("burst must be positive")
        if max_buckets <= 0:
            raise ValueError("max_buckets must be positive")
        if bucket_ttl_seconds <= 0:
            raise ValueError("bucket_ttl_seconds must be positive")

        self._limit = requests_per_minute
        self._capacity = float(burst)
        self._refill_per_second = requests_per_minute / 60.0
        self._max_buckets = max_buckets
        self._bucket_ttl_seconds = bucket_ttl_seconds
        self._clock = clock
        self._buckets: OrderedDict[str, _TokenBucket] = OrderedDict()
        self._lock = Lock()

    def check(self, key: str) -> RateLimitDecision:
        now = self._clock()
        with self._lock:
            self._expire_idle_buckets(now)
            bucket = self._buckets.pop(key, None)
            if bucket is None:
                self._evict_oldest_if_full()
                bucket = _TokenBucket(
                    tokens=self._capacity,
                    updated_at=now,
                    last_seen_at=now,
                )
            else:
                elapsed = max(0.0, now - bucket.updated_at)
                bucket.tokens = min(
                    self._capacity,
                    bucket.tokens + elapsed * self._refill_per_second,
                )
                bucket.updated_at = now
                bucket.last_seen_at = now

            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                decision = RateLimitDecision(
                    allowed=True,
                    limit=self._limit,
                    remaining=max(0, math.floor(bucket.tokens)),
                    retry_after_seconds=0,
                )
            else:
                missing = 1.0 - bucket.tokens
                decision = RateLimitDecision(
                    allowed=False,
                    limit=self._limit,
                    remaining=0,
                    retry_after_seconds=max(
                        1,
                        math.ceil(missing / self._refill_per_second),
                    ),
                )

            self._buckets[key] = bucket
            return decision

    def _expire_idle_buckets(self, now: float) -> None:
        # Access moves a bucket to the end, so idle buckets form a prefix. This
        # keeps cleanup proportional to the number expired rather than scanning
        # the full attacker-bounded cache on every request.
        while self._buckets:
            _, oldest = next(iter(self._buckets.items()))
            if now - oldest.last_seen_at < self._bucket_ttl_seconds:
                break
            self._buckets.popitem(last=False)

    def _evict_oldest_if_full(self) -> None:
        if len(self._buckets) >= self._max_buckets:
            self._buckets.popitem(last=False)


def rate_limit_key(scope: Scope) -> str:
    """Return a tenant-aware key, falling back to Phoenix's client-IP model."""

    headers = {
        key.decode("latin-1").lower(): value.decode("latin-1")
        for key, value in scope.get("headers", [])
    }
    tenant = headers.get("x-evalai-tenant", "").strip()
    subject = (
        headers.get("x-evalai-sub", "").strip()
        or headers.get("x-evalai-subject", "").strip()
    )
    if tenant and subject:
        return f"tenant:{tenant}:subject:{subject}"
    if tenant:
        # The UI BFF derives this value from POD_NAMESPACE rather than the
        # browser request, so BFF traffic remains tenant-isolated.
        return f"tenant:{tenant}"

    client = scope.get("client")
    if client:
        return f"client:{client[0]}"
    return "client:unknown"


class RateLimitMiddleware:
    """Reject exhausted API buckets with Phoenix-compatible HTTP 429."""

    def __init__(self, app: ASGIApp, *, config: Settings) -> None:
        self.app = app
        self.config = config
        self.limiter = ServerRateLimiter(
            requests_per_minute=config.rate_limit_requests_per_minute,
            burst=config.rate_limit_burst,
            max_buckets=config.rate_limit_max_buckets,
            bucket_ttl_seconds=config.rate_limit_bucket_ttl_seconds,
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or not self.config.rate_limit_enabled
            or _path_is_or_is_under(scope.get("path", ""), _PROBE_PATHS)
        ):
            await self.app(scope, receive, send)
            return

        decision = self.limiter.check(rate_limit_key(scope))
        if not decision.allowed:
            response = JSONResponse(
                status_code=429,
                content={"detail": "Too Many Requests"},
                headers={
                    "Retry-After": str(decision.retry_after_seconds),
                    "X-RateLimit-Limit": str(decision.limit),
                    "X-RateLimit-Remaining": "0",
                },
            )
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)
