"""Liveness and readiness probes.

Exposes the Proofgrove-standard ``/health/live`` and ``/health/ready`` endpoints,
which the chart's livenessProbe/readinessProbe target directly. ``/healthz``
and ``/readyz`` are the short Kubernetes-convention spellings of the same two
checks. ``/health`` returns the same liveness body as ``/healthz``, for
tooling that only checks a single unversioned health path.
"""

import asyncio
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from proofgrove.db.session import async_session

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])

# Cap the readiness DB probe so a hung connection can't stall the endpoint.
_READY_DB_TIMEOUT_S = 5.0


@router.get("/health/live")
@router.get("/healthz")
@router.get("/health")
async def live() -> dict[str, str]:
    """Liveness probe — process is up."""
    return {"status": "ok"}


@router.get("/health/ready")
@router.get("/readyz")
async def ready(request: Request) -> JSONResponse:
    """Readiness probe — the database is reachable and the lifespan workers are alive.

    Returns ``503`` when the database is unreachable so orchestrators do not
    route traffic to a pod that cannot serve requests, and when a lifespan
    worker (the compatibility run worker, the trace-index worker) has exited:
    the API would keep accepting runs that nothing in this process executes.
    """
    workers: dict[str, asyncio.Task] = getattr(request.app.state, "background_workers", {})
    for name, task in workers.items():
        if task.done():
            logger.warning("Readiness check failed: background worker %s stopped", name)
            return JSONResponse(
                status_code=503,
                content={"status": "not ready", "reason": "background worker stopped", "worker": name},
            )
    try:
        async with async_session() as session:
            await asyncio.wait_for(
                session.execute(text("SELECT 1")),
                timeout=_READY_DB_TIMEOUT_S,
            )
    except Exception as exc:  # noqa: BLE001 — any failure means "not ready"
        # Exception type only: DB driver messages embed connection details
        # (host, user, database) and arbitrary server text that pattern-based
        # redaction cannot be trusted to catch.
        logger.warning("Readiness check failed: database unavailable (%s)", type(exc).__name__)
        return JSONResponse(
            status_code=503,
            content={"status": "not ready", "reason": "database unavailable"},
        )
    return JSONResponse(status_code=200, content={"status": "ready"})
